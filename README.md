# WatchParty

A serverless, peer-to-peer screen sharing and watch party app that runs entirely in the browser. No backend, no accounts, no installation required.

## How It Works

WatchParty uses [PeerJS](https://peerjs.com/) (a WebRTC wrapper) for all real-time communication. One participant acts as the **host** — their browser peer ID becomes the room identifier. All other participants connect directly to the host. The host acts as a relay: when a non-host peer shares their screen or enables their mic, the host forwards those streams to everyone else in the room.

Data messages (chat, participant list, share-stop signals) are sent over PeerJS data connections. Media (screen video, audio, mic) is sent over PeerJS media calls.

## Features

- **Screen sharing** — any participant can share their screen (including system audio if the browser supports it). The host relays the stream to all other peers.
- **Mic audio** — per-participant microphone with echo cancellation, noise suppression, and auto gain control. Also relayed through the host.
- **Live chat** — text chat with unread message badge when the chat tab is not active.
- **Participant list** — sidebar showing all connected peers with their camera/video thumbnails (if a stream is active).
- **Shareable room links** — room code is appended to the URL (`?room=XXX-XXX`) so you can send a direct join link.
- **Fullscreen** — one-click fullscreen on the main video stage.
- **Responsive layout** — stacks vertically on screens narrower than 900px.

## Usage

### Hosting a room

1. Open `index.html` in a browser.
2. Enter your name under **Create Room** and click **Create Room**.
3. A room code (e.g. `ABC-123`) will appear. Share it or copy the URL from the address bar.
4. Click **Share Screen** to start sharing. Click **Mic Off** to toggle your microphone.

### Joining a room

1. Open `index.html` (or the shared link).
2. Enter your name and the room code under **Join Room**, then click **Join Room**.
3. The host's screen will appear automatically if they are already sharing.

### Leaving

Click **Leave** in the top bar. All streams and connections are cleaned up gracefully.

## Architecture

```
Host peer (ROOM-<roomId>)
  |
  |-- data connection --> Peer A
  |-- data connection --> Peer B
  |-- media call (screen) --> Peer A
  |-- media call (screen) --> Peer B   <-- relayed from Peer A's share
  |-- media call (mic) --> Peer A
  |-- media call (mic) --> Peer B      <-- relayed from Peer A's mic
```

The host peer ID is deterministically derived from the room code (`ROOM-` + code without the hyphen), so joining peers can connect without a signaling server beyond PeerJS's free public signaling.

## File Structure

```
watchparty/
  index.html    # entire app (HTML + CSS + JS, single file)
  README.md
```

## Dependencies

All loaded from CDN at runtime — no build step needed.

| Library | Version | Purpose |
|---|---|---|
| PeerJS | 1.5.4 | WebRTC peer connections |
| Inter (Google Fonts) | — | UI font |

## Browser Requirements

- A modern Chromium or Firefox-based browser.
- Screen sharing requires a secure context (`https://` or `localhost`). Opening `index.html` directly as a `file://` URL will block `getDisplayMedia`.
- Mic access requires user permission via the browser prompt.

## Limitations

- **Host dependency** — if the host leaves, all relayed streams drop. Peers who were sharing directly to the host lose their connection.
- **Scalability** — because every stream routes through the host's browser, bandwidth and CPU on the host machine become the bottleneck. Works well for small groups (2–8 people); larger rooms may degrade.
- **No persistence** — chat history and participant state are in-memory only. Refreshing or rejoining starts fresh.
- **PeerJS public signaling** — uses PeerJS's free public signaling server by default. For production use, self-host a [PeerJS server](https://github.com/peers/peerjs-server) and pass its config to the `Peer` constructor.

## Self-Hosting

Since the entire app is a single HTML file, serving it is trivial:

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .
```

Then open `http://localhost:8080` in your browser. For screen sharing to work across devices on a network, serve over HTTPS or use a tunnel like `ngrok`.