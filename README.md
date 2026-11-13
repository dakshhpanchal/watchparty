# WatchParty

A serverless, peer-to-peer screen sharing and watch party app that runs entirely in the browser. No backend, no accounts, no build step.

## Features

- **Screen sharing**: any participant can share their screen, including tab/system audio where the browser supports it. Only one person shares at a time.
- **Quality presets**: 1080p30 (default), 1080p60 or 720p30. You can change it while sharing.
- **Mic audio**: per-participant microphone with echo cancellation, noise suppression and auto gain control.
- **Live chat**: text chat with an unread badge.
- **People list**: everyone in the room, with host, mic and sharing indicators.
- **Shareable links**: the room code is added to the URL (`?room=ABC-123`), and **Copy link** puts it on your clipboard.
- **Host migration**: if the host leaves, the earliest-joined guest takes over automatically. Ongoing screen shares and mics keep playing.
- **Stream stats**: the chart button on the stage shows resolution, fps, bitrate, codec, packet loss, RTT and whether you're on a direct or TURN-relayed path.
- **Fullscreen** and a responsive layout (stacks vertically below 780px).

## Usage

Serve the folder with any static file server (or just open `index.html`). Note that screen capture requires `https://` or `localhost`.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

**Host:** enter your name, click **Create Room**, then **Copy link** and send it to friends.
**Join:** open the link (or enter the 6-character code), enter your name, click **Join Room**.
**Share:** pick a quality and click **Share Screen**. In the browser picker, tick **Share audio** to include sound.

## Architecture

[PeerJS](https://peerjs.com/) (WebRTC) handles everything. PeerJS's free public server is used only for signaling.

```
              data (roster, chat)            media (direct, no relay)
  Guest B ───────────────┐                   Sharer ──screen──▶ every viewer
  Guest C ───────────▶ Host hub              Each mic ─audio──▶ every other peer
  Guest D ───────────────┘   (id: watchparty-v2-<CODE>)
```

- Every participant has a **media peer** with a random id. Screen and mic streams go **directly** from their owner to each other participant (a mesh). Nothing is relayed or re-encoded by the host.
- The host also runs a **hub peer** registered under the room's well-known id (`watchparty-v2-` + code). Guests connect a data channel to it. The host keeps the authoritative roster (names, join order, mic/sharing state), broadcasts it, relays chat and enforces one sharer at a time.
- **Host migration:** every guest knows the roster ordered by join time.
  - When the host leaves (or its connection drops), the first guest in that order claims the hub id. The other guests reconnect to it, retrying with backoff. Later guests only try to claim the id after a stagger, in case the first one is also gone.
  - Media between the remaining guests isn't interrupted, because it never went through the hub.

### Streaming performance

- The video codec preference is H264 (hardware encode/decode on most devices), then VP9, then VP8.
- Each sender gets a bitrate cap from the quality preset, `maintain-framerate` degradation, and high priority. It also starts at about 2.5 Mbps instead of ramping up slowly from a low bitrate.
- Screen audio uses stereo Opus at 128 kbps with FEC.
- **Bandwidth:** the sharer uploads one stream per viewer. 1080p30 is capped at 6 Mbps per viewer, so 4 viewers can need about 24 Mbps of upload. If viewers lag, open the stats overlay:
  - If the sharer's line shows `LIMIT:bandwidth`, choose 720p30.
  - If it shows `LIMIT:cpu`, choose 30fps.

### TURN servers

The default config uses Google STUN plus PeerJS's free public TURN, which is shared and best-effort. If people behind strict NATs or corporate networks can't connect, add your own TURN server (coturn, Metered, Twilio, …) to `CONFIG.iceServers` at the top of `app.js`.

## Limitations

- Mesh media means the sharer's upload grows with the number of viewers. This is fine for small groups (roughly 2–8 people).
- Rooms only exist while someone is in them. No data is stored anywhere.
- There is no access control: anyone with the code can join.

## File structure

```
watchparty/
  index.html   # markup
  style.css    # styles
  app.js       # all app logic (config at the top)
  README.md
```
