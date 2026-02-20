import { Client, type Message, type VoiceState } from "discord.js-selfbot-v13";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  type StreamReceiverHandle,
  type StreamTransportInfo,
  startStreamReceiver,
} from "./src/stream-receiver";

const __dirname =
  typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));

const RECORDINGS_DIR = join(__dirname, "recordings");
mkdirSync(RECORDINGS_DIR, { recursive: true });

const client = new Client();

function sendGateway(op: number, d: Record<string, unknown>) {
  (
    client as unknown as { ws: { broadcast: (data: Record<string, unknown>) => void } }
  ).ws.broadcast({ op, d });
}

interface ActiveRecording {
  recorder: StreamReceiverHandle;
  streamKey: string;
  guildId: string;
  channelId: string;
}

const activeRecordings = new Map<string, ActiveRecording>();
const pendingStreams = new Map<string, { guildId: string; channelId: string }>();

interface PendingVoiceSession {
  guildId: string;
  channelId: string;
  targetUserId: string;
  isAlreadyStreaming: boolean;
  resolve: (sessionId: string) => void;
  reject: (err: Error) => void;
}

const pendingVoiceSessions = new Map<string, PendingVoiceSession>();

interface PendingStreamAuth {
  serverId?: string;
  token?: string;
  endpoint?: string;
  sessionId: string;
  streamKey: string;
  targetUserId: string;
  guildId: string;
  channelId: string;
  resolve: (info: StreamTransportInfo) => void;
  reject: (err: Error) => void;
}

const pendingStreamAuths = new Map<string, PendingStreamAuth>();

client.on("ready", () => {
  console.log(`${client.user?.username} is ready!`);
});

client.on("messageCreate", async (message: Message) => {
  if (!message.guild || !client.user) return;
  if (!message.mentions.has(client.user.id)) return;

  const content = message.content.toLowerCase();

  if (content.includes("stop")) {
    const recording = activeRecordings.get(message.author.id);
    if (recording) {
      await stopRecording(message.author.id, `stop requested by ${message.author.tag}`);
      await message.reply("Stopped recording.");
    } else {
      await message.reply("No active recording for you.");
    }
    return;
  }

  const voiceState = message.guild.voiceStates.cache.get(message.author.id);
  if (!voiceState?.channel) {
    await message.reply("You need to be in a voice channel.");
    return;
  }

  if (activeRecordings.has(message.author.id)) {
    await message.reply("Already recording your stream.");
    return;
  }

  if (pendingStreams.has(message.author.id)) {
    await message.reply("Already waiting for you to start streaming.");
    return;
  }

  const channel = voiceState.channel;
  const channelName = "name" in channel ? channel.name : "voice";
  await message.reply(
    `Joining **${channelName}**. ${voiceState.streaming ? "Connecting to your stream..." : "Start a Go Live and I'll record it."}`,
  );

  try {
    await initiateRecording(message.guild.id, channel.id, message.author.id, voiceState.streaming);
  } catch (err) {
    console.error("Failed to start recording:", err);
    await message.reply(
      `Something went wrong: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

async function initiateRecording(
  guildId: string,
  channelId: string,
  targetUserId: string,
  isAlreadyStreaming: boolean,
) {
  const selfUserId = client.user!.id;

  // Join the voice channel by sending a raw VOICE_STATE_UPDATE.
  // Do NOT use client.voice.joinChannel — that creates a competing voice
  // WebSocket + UDP connection which steals our session credentials.
  const sessionId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingVoiceSessions.delete(guildId);
      reject(new Error("Timed out waiting for voice session"));
    }, 15000);

    pendingVoiceSessions.set(guildId, {
      guildId,
      channelId,
      targetUserId,
      isAlreadyStreaming,
      resolve: (sid) => {
        clearTimeout(timeout);
        pendingVoiceSessions.delete(guildId);
        resolve(sid);
      },
      reject: (err) => {
        clearTimeout(timeout);
        pendingVoiceSessions.delete(guildId);
        reject(err);
      },
    });

    sendGateway(4, {
      guild_id: guildId,
      channel_id: channelId,
      self_mute: true,
      self_deaf: false,
      self_video: false,
    });
  });

  if (isAlreadyStreaming) {
    await connectToStream(guildId, channelId, targetUserId, selfUserId, sessionId);
  } else {
    pendingStreams.set(targetUserId, { guildId, channelId });
  }
}

function buildStreamKey(guildId: string, channelId: string, userId: string): string {
  return `guild:${guildId}:${channelId}:${userId}`;
}

async function connectToStream(
  guildId: string,
  channelId: string,
  targetUserId: string,
  selfUserId: string,
  sessionId: string,
) {
  pendingStreams.delete(targetUserId);

  const streamKey = buildStreamKey(guildId, channelId, targetUserId);

  const transportPromise = new Promise<StreamTransportInfo>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingStreamAuths.delete(streamKey);
      reject(new Error("Timed out waiting for stream auth info"));
    }, 15000);

    pendingStreamAuths.set(streamKey, {
      streamKey,
      targetUserId,
      sessionId,
      guildId,
      channelId,
      resolve: (info) => {
        clearTimeout(timeout);
        pendingStreamAuths.delete(streamKey);
        resolve(info);
      },
      reject: (err) => {
        clearTimeout(timeout);
        pendingStreamAuths.delete(streamKey);
        reject(err);
      },
    });
  });

  sendGateway(20, { stream_key: streamKey });

  let transport: StreamTransportInfo;
  try {
    transport = await transportPromise;
  } catch (err) {
    console.error("Failed to get stream transport info:", err);
    return;
  }

  const user = await client.users.fetch(targetUserId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${user.username}_${timestamp}.mkv`;
  const outputPath = join(RECORDINGS_DIR, filename);

  const recorder = await startStreamReceiver(outputPath, filename, selfUserId, transport);

  console.log(`Recording started: ${outputPath}`);

  activeRecordings.set(targetUserId, {
    recorder,
    streamKey,
    guildId,
    channelId,
  });
}

// Intercept all relevant Gateway events
client.on("raw", (packet: { t?: string; d?: Record<string, unknown> }) => {
  if (!packet.t || !packet.d) return;

  switch (packet.t) {
    case "VOICE_STATE_UPDATE": {
      const d = packet.d;
      const userId = d.user_id as string;
      if (userId !== client.user?.id) return;

      const guildId = d.guild_id as string;
      const sessionId = d.session_id as string;
      const pending = pendingVoiceSessions.get(guildId);
      if (pending && sessionId) {
        pending.resolve(sessionId);
      }
      break;
    }

    case "STREAM_CREATE": {
      const streamKey = packet.d.stream_key as string;
      if (!streamKey) return;
      const pending = pendingStreamAuths.get(streamKey);
      if (!pending) return;

      pending.serverId = packet.d.rtc_server_id as string;
      tryResolveStreamAuth(pending);
      break;
    }

    case "STREAM_SERVER_UPDATE": {
      const streamKey = packet.d.stream_key as string;
      if (!streamKey) return;
      const pending = pendingStreamAuths.get(streamKey);
      if (!pending) return;

      pending.token = packet.d.token as string;
      pending.endpoint = packet.d.endpoint as string;
      tryResolveStreamAuth(pending);
      break;
    }

    case "STREAM_DELETE": {
      const streamKey = packet.d.stream_key as string;
      if (!streamKey) return;
      const pending = pendingStreamAuths.get(streamKey);
      if (pending) {
        pending.reject(new Error(`Stream deleted: ${packet.d.reason}`));
      }
      break;
    }
  }
});

function tryResolveStreamAuth(pending: PendingStreamAuth) {
  if (pending.serverId && pending.token && pending.endpoint && pending.sessionId) {
    pending.resolve({
      serverId: pending.serverId,
      token: pending.token,
      endpoint: pending.endpoint,
      sessionId: pending.sessionId,
      userId: pending.targetUserId,
    });
  }
}

async function stopRecording(userId: string, reason: string) {
  const recording = activeRecordings.get(userId);
  if (!recording) return;

  console.log(`Stopping recording for ${userId}: ${reason}`);
  activeRecordings.delete(userId);

  // Leave the stream
  try {
    sendGateway(19, { stream_key: recording.streamKey });
  } catch {}

  await recording.recorder.stop();

  // Leave the voice channel
  try {
    sendGateway(4, {
      guild_id: recording.guildId,
      channel_id: null,
      self_mute: true,
      self_deaf: false,
      self_video: false,
    });
  } catch {}
}

client.on("voiceStateUpdate", async (_oldState: VoiceState, newState: VoiceState) => {
  const userId = newState.id;

  const pending = pendingStreams.get(userId);
  if (pending && newState.streaming && newState.channelId === pending.channelId) {
    const selfUserId = client.user!.id;
    // We need the session_id — look it up from our own voice state
    const selfVoiceState = newState.guild?.voiceStates.cache.get(selfUserId);
    const sessionId =
      (selfVoiceState as unknown as { sessionID?: string })?.sessionID ??
      (selfVoiceState as unknown as { sessionId?: string })?.sessionId ??
      (selfVoiceState as unknown as { session_id?: string })?.session_id;

    if (!sessionId) {
      console.error("Cannot find our session_id for pending stream connection");
      pendingStreams.delete(userId);
      return;
    }

    try {
      await connectToStream(
        pending.guildId,
        pending.channelId,
        userId,
        selfUserId,
        String(sessionId),
      );
    } catch (err) {
      console.error(`Failed to connect to stream for ${userId}:`, err);
      pendingStreams.delete(userId);
    }
    return;
  }

  if (activeRecordings.has(userId)) {
    const leftChannel = !newState.channelId;
    const stoppedStreaming = !newState.streaming;

    if (leftChannel || stoppedStreaming) {
      await stopRecording(
        userId,
        leftChannel ? "user left voice channel" : "user stopped streaming",
      );
    }
  }

  if (pending && !newState.channelId) {
    pendingStreams.delete(userId);
    sendGateway(4, {
      guild_id: pending.guildId,
      channel_id: null,
      self_mute: true,
      self_deaf: false,
      self_video: false,
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
