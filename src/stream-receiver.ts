import { spawn, type ChildProcess } from "child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import { isIP } from "node:net";
import * as path from "node:path";
import * as sp from "sodium-plus";
import { RtpPacket } from "werift-rtp";
import WebSocket from "ws";

const { SodiumPlus, CryptographyKey } = sp;

// ── Voice opcodes ────────────────────────────────────────────────────────────

const VoiceOp = {
  IDENTIFY: 0,
  SELECT_PROTOCOL: 1,
  READY: 2,
  HEARTBEAT: 3,
  SELECT_PROTOCOL_ACK: 4,
  SPEAKING: 5,
  HEARTBEAT_ACK: 6,
  RESUME: 7,
  HELLO: 8,
  RESUMED: 9,
  CLIENTS_CONNECT: 11,
  VIDEO: 12,
  CLIENT_DISCONNECT: 13,
  SESSION_UPDATE: 14,
  MEDIA_SINK_WANTS: 15,
  VOICE_BACKEND_VERSION: 16,
} as const;

// ── Codec payload type table ─────────────────────────────────────────────────

const CODECS = [
  { name: "opus", type: "audio", priority: 1000, payload_type: 120 },
  {
    name: "H264",
    type: "video",
    priority: 1000,
    payload_type: 101,
    rtx_payload_type: 102,
    encode: true,
    decode: true,
  },
  {
    name: "H265",
    type: "video",
    priority: 1000,
    payload_type: 103,
    rtx_payload_type: 104,
    encode: true,
    decode: true,
  },
  {
    name: "VP8",
    type: "video",
    priority: 1000,
    payload_type: 105,
    rtx_payload_type: 106,
    encode: true,
    decode: true,
  },
  {
    name: "VP9",
    type: "video",
    priority: 1000,
    payload_type: 107,
    rtx_payload_type: 108,
    encode: true,
    decode: true,
  },
  {
    name: "AV1",
    type: "video",
    priority: 1000,
    payload_type: 109,
    rtx_payload_type: 110,
    encode: true,
    decode: true,
  },
] as const;

const SIMULCAST_STREAMS = [{ type: "video", rid: "100", quality: 100 }];

const PT_TO_CODEC: Record<number, string> = {};
for (const c of CODECS) PT_TO_CODEC[c.payload_type] = c.name;

// ── Transport decryptor ──────────────────────────────────────────────────────

interface TransportDecryptor {
  decrypt(ciphertext: Buffer, nonce: Buffer, additionalData: Buffer): Promise<Buffer>;
}

class AES256Decryptor implements TransportDecryptor {
  private _key: Promise<CryptoKey>;
  constructor(secretKey: Buffer) {
    this._key = crypto.subtle.importKey(
      "raw",
      new Uint8Array(secretKey),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  }
  async decrypt(ciphertext: Buffer, nonce: Buffer, additionalData: Buffer): Promise<Buffer> {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(nonce),
        additionalData: new Uint8Array(additionalData),
      },
      await this._key,
      new Uint8Array(ciphertext),
    );
    return Buffer.from(plain);
  }
}

class Chacha20Decryptor implements TransportDecryptor {
  private static sodium = SodiumPlus.auto();
  private _key: sp.CryptographyKey;
  constructor(secretKey: Buffer) {
    this._key = new CryptographyKey(secretKey);
  }
  async decrypt(ciphertext: Buffer, nonce: Buffer, additionalData: Buffer): Promise<Buffer> {
    const s = await Chacha20Decryptor.sodium;
    const plain = await s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      ciphertext,
      nonce,
      this._key,
      additionalData,
    );
    return Buffer.from(plain);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseIpDiscoveryResponse(msg: Buffer): { ip: string; port: number } {
  const ip = msg.subarray(8, msg.indexOf(0, 8)).toString("utf8");
  if (!isIP(ip)) throw new Error(`Malformed IP in discovery response: ${ip}`);
  const port = msg.readUInt16BE(msg.length - 2);
  return { ip, port };
}

/**
 * Grab one random ephemeral UDP port by binding to port 0 and immediately
 * closing.  The OS guarantees uniqueness at the moment of bind.
 */
function grabEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/**
 * Allocate two UDP ports for FFmpeg RTP input that are guaranteed not to
 * collide with each other or their implicit RTCP ports (RTP+1).
 * Ports are allocated sequentially to avoid the OS handing out adjacent
 * numbers that would overlap when FFmpeg binds RTP *and* RTCP.
 */
async function allocateFreshUdpPorts(): Promise<[number, number]> {
  const videoPort = await grabEphemeralPort();
  let audioPort = await grabEphemeralPort();

  // FFmpeg binds RTCP on port+1 for each stream, so video occupies
  // [videoPort, videoPort+1] and audio occupies [audioPort, audioPort+1].
  // Re-roll audio if it would collide with the video pair.
  const collides = (a: number, v: number) => a === v || a === v + 1 || a + 1 === v;

  for (let i = 0; i < 20 && collides(audioPort, videoPort); i++) {
    audioPort = await grabEphemeralPort();
  }

  return [videoPort, audioPort];
}

/**
 * Rewrite the 2-byte HEVC NAL unit header in a serialized RTP packet so that
 * nuh_layer_id = 0 and nuh_temporal_id_plus1 = 1.  Discord sends non-standard
 * values (layer_id=8, tid=0) which FFmpeg rejects as "Multi-layer HEVC".
 *
 * NAL header layout (16 bits):
 *   F (1) | nal_unit_type (6) | nuh_layer_id (6) | nuh_temporal_id_plus1 (3)
 *
 * We keep F and nal_unit_type intact, zero layer_id (bit 0 of byte0, bits 7-3
 * of byte1), and set tid to 1 (bits 2-0 of byte1).
 */
function fixHevcNalHeaderAt(buf: Buffer, off: number): void {
  if (buf.length < off + 2) return;
  buf.writeUInt8(buf.readUInt8(off) & 0xfe, off);
  buf.writeUInt8(0x01, off + 1);
}

/**
 * Fix all HEVC NAL headers in an RTP packet.  Handles:
 *  - Single NAL unit packets (type 0-47): fix the one header
 *  - AP (type 48): fix the outer header + every aggregated NAL header
 *  - FU (type 49): fix the outer header
 */
function fixHevcNalHeader(buf: Buffer, payloadOffset: number): void {
  if (buf.length < payloadOffset + 2) return;

  const nalType = (buf.readUInt8(payloadOffset) >> 1) & 0x3f;

  fixHevcNalHeaderAt(buf, payloadOffset);

  if (nalType === 48) {
    // AP: [2-byte AP header] then repeating [2-byte size][NAL unit] ...
    let pos = payloadOffset + 2;
    while (pos + 2 < buf.length) {
      const naluSize = buf.readUInt16BE(pos);
      pos += 2;
      if (naluSize < 2 || pos + naluSize > buf.length) break;
      fixHevcNalHeaderAt(buf, pos);
      pos += naluSize;
    }
  }
}

function buildSdp(videoPort: number, audioPort: number, codec: "H264" | "H265"): string {
  const isH265 = codec === "H265";
  const videoPt = isH265 ? 103 : 101;
  const codecName = isH265 ? "H265" : "H264";

  let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=-
c=IN IP4 127.0.0.1
t=0 0
m=video ${videoPort} RTP/AVP ${videoPt}
c=IN IP4 127.0.0.1
b=AS:2000
a=rtpmap:${videoPt} ${codecName}/90000
`;
  if (!isH265) {
    sdp += `a=fmtp:${videoPt} profile-level-id=42e01f;sprop-parameter-sets=Z0IAH6tAoAt2AtwEBAaQeJEV,aM4JyA==;packetization-mode=1\n`;
  }

  sdp += `m=audio ${audioPort} RTP/AVP 120
c=IN IP4 127.0.0.1
b=AS:128
a=rtpmap:120 opus/48000/2
a=fmtp:120 minptime=10;useinbandfec=1
`;
  return sdp;
}

/**
 * Remux a potentially truncated matroska file to fix the container.
 * Renames the original to .tmp.mkv, remuxes to the original path, then deletes the temp.
 */
async function remuxFile(filePath: string): Promise<void> {
  const tmpPath = filePath.replace(/\.mkv$/, ".tmp.mkv");
  try {
    fs.renameSync(filePath, tmpPath);
  } catch (e) {
    console.error(`Remux failed (rename): ${e}`);
    return;
  }

  console.log(`Remuxing ${path.basename(filePath)}...`);

  return new Promise<void>((resolve) => {
    const proc = spawn("ffmpeg", [
      "-y",
      "-err_detect",
      "ignore_err",
      "-i",
      tmpPath,
      "-c",
      "copy",
      "-f",
      "matroska",
      filePath,
    ]);

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        console.log(`Remux complete: ${path.basename(filePath)}`);
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      } else {
        console.error(`Remux failed (code ${code})`);
        try {
          fs.renameSync(tmpPath, filePath);
        } catch {}
      }
      resolve();
    });

    proc.on("error", (err) => {
      console.error(`Remux failed (spawn): ${err.message}`);
      try {
        fs.renameSync(tmpPath, filePath);
      } catch {}
      resolve();
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface StreamReceiverHandle {
  outputPath: string;
  filename: string;
  stop(): Promise<void>;
}

export interface StreamTransportInfo {
  token: string;
  endpoint: string;
  serverId: string;
  sessionId: string;
  userId: string;
}

export async function startStreamReceiver(
  outputPath: string,
  filename: string,
  selfUserId: string,
  transport: StreamTransportInfo,
): Promise<StreamReceiverHandle> {
  let stopped = false;
  let draining = false;
  let ws: WebSocket | null = null;
  let udpSocket: dgram.Socket | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let ffmpeg: ChildProcess | null = null;
  let decryptor: TransportDecryptor | null = null;
  let seqAck = -1;

  // Localhost UDP socket for forwarding decrypted RTP to FFmpeg.
  // Created lazily after FFmpeg ports are allocated to avoid collisions.
  let localSocket: dgram.Socket | null = null;

  // SSRCs from the voice server for the remote streamer
  let remoteVideoSsrc = 0;
  let remoteAudioSsrc = 0;
  let remoteRtxSsrc = 0;
  let ourAudioSsrc = 0;

  let wireVideoCodec = "";
  let videoUdpPort = 0;
  let audioUdpPort = 0;
  let ffmpegReady = false;

  // ── FFmpeg (SDP + localhost UDP approach) ─────────────────────────────
  // Matches discord.js-selfbot-v13 Recorder.js: spawn FFmpeg eagerly,
  // write SDP to stdin, wait for stderr output to signal readiness,
  // then start forwarding packets. Packets before ready are dropped
  // (stream will naturally send new keyframes).

  async function spawnFfmpeg(codec: "H264" | "H265") {
    if (ffmpeg) return;

    [videoUdpPort, audioUdpPort] = await allocateFreshUdpPorts();

    localSocket = dgram.createSocket("udp4");

    const sdp = buildSdp(videoUdpPort, audioUdpPort, codec);

    ffmpeg = spawn("ffmpeg", [
      "-reorder_queue_size",
      "500",
      "-max_delay",
      "500000",
      "-err_detect",
      "ignore_err",
      "-fflags",
      "+genpts+discardcorrupt",
      "-f",
      "sdp",
      "-analyzeduration",
      "1M",
      "-probesize",
      "1M",
      "-protocol_whitelist",
      "file,udp,rtp,pipe,fd",
      "-i",
      "-",
      "-c",
      "copy",
      "-y",
      "-f",
      "matroska",
      "-flush_packets",
      "1",
      "-cluster_time_limit",
      "500",
      outputPath,
    ]);

    ffmpeg.stdin!.write(sdp);
    ffmpeg.stdin!.end();

    ffmpeg.stderr?.on("data", () => {
      if (!ffmpegReady) ffmpegReady = true;
    });
    ffmpeg.once("error", (err: Error) => console.error("FFmpeg error:", err.message));
    ffmpeg.on("exit", (code, signal) => {
      if (code !== 0 && code !== null && signal !== "SIGKILL") {
        console.error(`FFmpeg exited unexpectedly (code ${code}, signal ${signal}): ${filename}`);
      }
    });
  }

  // ── Forward a decrypted RTP packet to FFmpeg via localhost UDP ─────────

  let seenKeyframe = false;

  function forwardToFfmpeg(rtpPacket: Buffer, port: number) {
    if (!localSocket || !ffmpegReady || !ffmpeg || ffmpeg.exitCode !== null) return;

    if (port === videoUdpPort && !seenKeyframe) {
      if (rtpPacket.length <= 12) return;
      const nalType = (rtpPacket.readUInt8(12) >> 1) & 0x3f;
      if (nalType !== 48) return;
      seenKeyframe = true;
    }

    localSocket.send(rtpPacket, 0, rtpPacket.length, port, "127.0.0.1");
  }

  // ── Discord UDP ────────────────────────────────────────────────────────

  function createUdp(
    address: string,
    port: number,
    audioSsrc: number,
  ): Promise<{ ip: string; port: number }> {
    return new Promise((resolve, reject) => {
      udpSocket = dgram.createSocket("udp4");
      udpSocket.on("error", (err) => {
        console.error("UDP error:", err.message);
        reject(err);
      });

      udpSocket.once("message", (msg) => {
        if (msg.readUInt16BE(0) !== 2) {
          reject(new Error("Bad IP discovery response"));
          return;
        }
        try {
          resolve(parseIpDiscoveryResponse(msg));
        } catch (e) {
          reject(e);
        }

        udpSocket!.on("message", onUdpMessage);
      });

      const blank = Buffer.alloc(74);
      blank.writeUInt16BE(1, 0);
      blank.writeUInt16BE(70, 2);
      blank.writeUInt32BE(audioSsrc, 4);
      udpSocket.send(blank, 0, blank.length, port, address, (err) => {
        if (err) reject(err);
      });
    });
  }

  async function onUdpMessage(msg: Buffer) {
    if ((stopped && !draining) || !decryptor) return;
    if (msg.length < 12) return;

    const b0 = msg.readUInt8(0);
    const version = (b0 >> 6) & 0x03;
    if (version !== 2) return;

    const ssrc = msg.readUInt32BE(8);

    if (ssrc !== remoteVideoSsrc && ssrc !== remoteAudioSsrc && ssrc !== remoteRtxSsrc) return;

    const hasExtension = !!((b0 >> 4) & 0x01);
    const csrcCount = b0 & 0x0f;
    const b1 = msg.readUInt8(1);
    const payloadType = b1 & 0x7f;

    const fixedHeaderLen = 12 + csrcCount * 4;
    const extHeaderLen = hasExtension ? 4 : 0;
    const aadLen = fixedHeaderLen + extHeaderLen;

    if (msg.length < aadLen + 4) return;
    const nonceBytes = msg.subarray(msg.length - 4);
    const ciphertext = msg.subarray(aadLen, msg.length - 4);
    if (ciphertext.length === 0) return;

    const nonce = Buffer.alloc(decryptor instanceof AES256Decryptor ? 12 : 24);
    nonceBytes.copy(nonce, 0);

    const aad = msg.subarray(0, aadLen);

    let plaintext: Buffer;
    try {
      plaintext = await decryptor.decrypt(ciphertext, nonce, aad);
    } catch {
      return;
    }

    const rawRtp = Buffer.concat([aad, plaintext]);
    const parsed = RtpPacket.deSerialize(rawRtp);
    parsed.header.extension = false;
    parsed.header.extensions = [];
    const rtpPacket = parsed.serialize();

    if (ssrc === remoteVideoSsrc) {
      if (!wireVideoCodec) {
        wireVideoCodec = PT_TO_CODEC[payloadType] || "H264";
      }
      // Discord sends HEVC NAL headers with non-zero nuh_layer_id (e.g. 8) and
      // nuh_temporal_id_plus1=0. FFmpeg rejects these as "Multi-layer HEVC" and
      // never registers VPS/SPS/PPS, causing "PPS id out of range" on every frame.
      // Fix: rewrite the 2-byte HEVC NAL header at the start of the RTP payload
      // to set nuh_layer_id=0, nuh_temporal_id_plus1=1. The payload offset in the
      // serialized packet is 12 bytes (fixed RTP header, no extensions).
      if (wireVideoCodec === "H265") {
        fixHevcNalHeader(rtpPacket, 12);
      }
      forwardToFfmpeg(rtpPacket, videoUdpPort);
    } else if (ssrc === remoteRtxSsrc) {
      if (parsed.payload.length > 2) {
        parsed.header.ssrc = remoteVideoSsrc;
        parsed.header.payloadType = wireVideoCodec === "H265" ? 103 : 101;
        parsed.payload = parsed.payload.subarray(2);
        const rtxPacket = parsed.serialize();
        if (wireVideoCodec === "H265") {
          fixHevcNalHeader(rtxPacket, 12);
        }
        forwardToFfmpeg(rtxPacket, videoUdpPort);
      }
    } else if (ssrc === remoteAudioSsrc) {
      forwardToFfmpeg(rtpPacket, audioUdpPort);
    }
  }

  // ── Voice WebSocket ────────────────────────────────────────────────────

  function connect() {
    const wsUrl = `wss://${transport.endpoint}/?v=8`;
    ws = new WebSocket(wsUrl, { followRedirects: true });

    ws.on("open", () => {
      send(VoiceOp.IDENTIFY, {
        server_id: transport.serverId,
        user_id: selfUserId,
        session_id: transport.sessionId,
        token: transport.token,
        video: true,
        streams: SIMULCAST_STREAMS,
      });
    });

    ws.on("error", (err: Error) => console.error("Voice WS error:", err.message));

    ws.on("close", (code: number) => {
      if (!stopped && (code === 4015 || code < 4000)) {
        setTimeout(connect, 1000);
      }
    });

    ws.on("message", (data: WebSocket.Data, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as {
        op: number;
        d: Record<string, unknown>;
        seq?: number;
      };
      if (msg.seq) seqAck = msg.seq;
      handleVoiceOp(msg.op, msg.d);
    });
  }

  function send(op: number, d: Record<string, unknown>) {
    ws?.send(JSON.stringify({ op, d }));
  }

  async function handleVoiceOp(op: number, d: Record<string, unknown>) {
    switch (op) {
      case VoiceOp.HELLO: {
        const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
          send(VoiceOp.HEARTBEAT, { t: Date.now(), seq_ack: seqAck });
        }, interval);
        break;
      }

      case VoiceOp.READY: {
        const ready = d as {
          ssrc: number;
          ip: string;
          port: number;
          modes: string[];
          streams: Array<{ ssrc: number; rtx_ssrc: number }>;
        };
        ourAudioSsrc = ready.ssrc;

        try {
          const local = await createUdp(ready.ip, ready.port, ready.ssrc);

          const mode = ready.modes.includes("aead_aes256_gcm_rtpsize")
            ? "aead_aes256_gcm_rtpsize"
            : "aead_xchacha20_poly1305_rtpsize";

          send(VoiceOp.SELECT_PROTOCOL, {
            protocol: "udp",
            codecs: [...CODECS],
            data: { address: local.ip, port: local.port, mode },
          });
        } catch (err) {
          console.error("Voice UDP setup failed:", err);
        }
        break;
      }

      case VoiceOp.SELECT_PROTOCOL_ACK: {
        const ack = d as {
          secret_key: number[];
          audio_codec: string;
          video_codec: string;
          mode: string;
        };

        const secretKey = Buffer.from(ack.secret_key);
        if (ack.mode === "aead_aes256_gcm_rtpsize") {
          decryptor = new AES256Decryptor(secretKey);
        } else {
          decryptor = new Chacha20Decryptor(secretKey);
        }

        send(VoiceOp.VIDEO, {
          audio_ssrc: ourAudioSsrc,
          video_ssrc: 0,
          rtx_ssrc: 0,
          streams: [],
        });
        break;
      }

      case VoiceOp.SPEAKING:
        break;

      case VoiceOp.VIDEO: {
        const video = d as {
          user_id?: string;
          audio_ssrc: number;
          video_ssrc: number;
          streams?: Array<{
            ssrc: number;
            rtx_ssrc: number;
            active: boolean;
            rid: string;
            quality: number;
          }>;
        };
        if (video.video_ssrc && video.video_ssrc !== 0) {
          remoteVideoSsrc = video.video_ssrc;
          remoteAudioSsrc = video.audio_ssrc;
          if (video.streams && video.streams.length > 0) {
            remoteRtxSsrc = video.streams[0]!.rtx_ssrc || 0;
          }

          sendMediaSinkWants(video.video_ssrc, video.streams);
          spawnFfmpeg("H265");
        }
        break;
      }

      case VoiceOp.MEDIA_SINK_WANTS:
      case VoiceOp.CLIENTS_CONNECT:
      case VoiceOp.CLIENT_DISCONNECT:
      case VoiceOp.HEARTBEAT_ACK:
      case VoiceOp.RESUMED:
        break;

      default: {
        if (op >= 4000) {
          console.error(`Voice WS error opcode ${op}: ${JSON.stringify(d)}`);
        }
      }
    }
  }

  function sendMediaSinkWants(
    videoSsrc: number,
    streams?: Array<{ ssrc: number; rtx_ssrc: number; active: boolean; quality: number }>,
  ) {
    const wants: Record<string, number> = {};
    if (streams?.length) {
      for (const s of streams) {
        wants[String(s.ssrc)] = 100;
      }
    } else {
      wants[String(videoSsrc)] = 100;
    }
    wants.any = 100;

    send(VoiceOp.MEDIA_SINK_WANTS, wants);
  }

  // ── Start ──────────────────────────────────────────────────────────────

  connect();

  return {
    outputPath,
    filename,

    async stop() {
      if (stopped) return;

      // Drain phase: keep forwarding packets for 1s so FFmpeg's jitter
      // buffer (reorder_queue_size 500 / max_delay 500ms) can flush.
      draining = true;
      stopped = true;
      await new Promise((r) => setTimeout(r, 1000));
      draining = false;

      if (heartbeatInterval) clearInterval(heartbeatInterval);

      // Close the Discord UDP socket and local forwarding socket FIRST
      // so no more packets land on FFmpeg's ports after we kill it.
      try {
        udpSocket?.close();
      } catch {}
      udpSocket = null;
      try {
        localSocket?.close();
      } catch {}
      localSocket = null;

      try {
        ws?.close();
      } catch {}
      ws = null;

      if (ffmpeg && ffmpeg.exitCode === null) {
        await new Promise<void>((resolve) => {
          ffmpeg?.once("exit", () => resolve());
          try {
            ffmpeg?.kill("SIGKILL");
          } catch {}
          setTimeout(() => resolve(), 2000);
        });
      }

      await remuxFile(outputPath);
    },
  };
}
