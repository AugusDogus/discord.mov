# discord.mov

Discord "Go Live" recorder built on `discord.js-selfbot-v13` + FFmpeg.

Inspired by: https://x.com/thdxr/status/2024504677895635423

## Important Disclaimer

- This project logs in as a user account ("selfbot"). Selfbots are against Discord's Terms of Service and can get the account banned.
- Only use this to record streams you own, or where you have explicit permission from everyone involved. Respect privacy laws and server rules.

## What It Does

- Waits for a message that mentions your account (the selfbot user) in a server.
- If the mentioning user is in a voice channel, the selfbot joins that channel.
- If the mentioning user is streaming ("Go Live"), the selfbot connects to their stream and records audio+video to a local `.mkv`.
- If the mentioning user isn't streaming yet, the selfbot waits until they start.
- Stops automatically when the user stops streaming or leaves voice, and also supports a manual "stop" command.

Recordings are written to `recordings/` next to `index.ts`.

## Requirements

- Bun (this repo targets Bun; Node.js is untested)
- FFmpeg installed and available on `PATH` (running `ffmpeg -version` should work)
- A Discord _user_ token in `.env` as `DISCORD_TOKEN`

## Setup

Install dependencies:

```bash
bun install
```

Create `.env`:

```bash
DISCORD_TOKEN=your_token_here
```

## Run

```bash
bun index.ts
```

## Usage

- In a server text channel: @mention the selfbot user.
- If you're already streaming, it will start recording immediately.
- If you're not streaming yet, start a Go Live and it will begin once Discord marks you as streaming.
- To stop manually: @mention the selfbot and include the word `stop` in the message.

## Patched Dependency (Bun / Windows Compatibility)

This repo uses `bun patch` to persist small fixes to `discord.js-selfbot-v13` (see `package.json` `patchedDependencies` and `patches/discord.js-selfbot-v13@3.7.1.patch`).

The patch currently covers:

- Voice endpoints that include a non-standard port (Discord sometimes returns `host:port`; the upstream library stripped the port).

If you ever need to regenerate the patch:

```bash
bun patch discord.js-selfbot-v13
# edit node_modules/discord.js-selfbot-v13
bun patch --commit discord.js-selfbot-v13
```

Reference: https://bun.com/docs/pm/cli/patch

## Notes

`debug` is intentionally included as a direct dependency. A transitive dependency (`werift-rtp`, pulled in by `discord.js-selfbot-v13`) imports `debug` at runtime but does not declare it in its `dependencies`, which can cause Bun to fail with an error like: `Cannot find package 'debug' from ...werift-rtp.../log.js`.
