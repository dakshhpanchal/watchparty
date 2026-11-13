'use strict';

(() => {
  // ===========================================================================
  // Config
  // ===========================================================================
  const CONFIG = {
    // Prefix for the room's well-known PeerJS id. The public PeerJS server is
    // shared by everyone, so keep this unique to avoid colliding with other apps.
    idPrefix: 'watchparty-v2-',

    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      // PeerJS's free public TURN server: shared and best-effort. For reliable
      // connections behind strict NATs, add your own TURN server here, e.g.:
      // { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443?transport=tcp'],
      //   username: 'user', credential: 'pass' },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
        username: 'peerjs', credential: 'peerjsp' },
    ],

    // Screen-share presets. `bitrate` is the per-viewer video cap (bps). The
    // sharer uploads one copy per viewer, so lower presets help weak uplinks.
    quality: {
      '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
      '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 9_000_000 },
      '720p30':  { width: 1280, height: 720,  fps: 30, bitrate: 3_000_000 },
    },
    screenAudioBitrate: 128_000,   // stereo Opus for movie/music audio
    micBitrate: 48_000,
    startBitrateKbps: 2500,        // skip the slow ramp-up from ~300 kbps

    joinTimeoutMs: 10_000,
    migrationTimeoutMs: 60_000,
    migrationStaggerMs: 6_000,     // delay between successive host candidates
    pendingPeerGraceMs: 20_000,    // new host waits this long for old guests
    codeAlphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', // no 0/O, 1/I/L
  };

  // ===========================================================================
  // DOM
  // ===========================================================================
  const $ = (id) => document.getElementById(id);
  const el = {
    lobby: $('lobby'), room: $('room'), toast: $('toast'),
    createForm: $('create-form'), joinForm: $('join-form'),
    createBtn: $('create-btn'), joinBtn: $('join-btn'),
    createError: $('create-error'), joinError: $('join-error'),
    hostName: $('host-name'), joinName: $('join-name'), joinCode: $('join-code'),
    headerRoomId: $('header-room-id'), copyLinkBtn: $('copy-link-btn'),
    peerCount: $('peer-count-num'), leaveBtn: $('leave-room-btn'),
    stage: $('stage'), video: $('main-video'), placeholder: $('placeholder'),
    stageLabel: $('stage-label'), unmuteBtn: $('unmute-btn'),
    statsBtn: $('stats-btn'), stats: $('stats'), fullscreenBtn: $('fullscreen-btn'),
    peersPanel: $('peers-panel'), chatMessages: $('chat-messages'),
    chatForm: $('chat-form'), chatInput: $('chat-input'), chatBadge: $('chat-badge'),
    shareBtn: $('share-btn'), qualitySelect: $('quality-select'), muteBtn: $('mute-btn'),
  };

  // ===========================================================================
  // State
  // ===========================================================================
  // Topology:
  //  - Everyone has a "media peer" (random id). Roster entries use this id and
  //    all screen/mic calls go directly between media peers (full mesh), so no
  //    stream is ever relayed or re-encoded.
  //  - The host additionally owns a "hub peer" registered as the room's
  //    well-known id. Guests open one data connection to it for roster + chat.
  //  - When the host leaves, a guest claims the hub id. Media calls between
  //    the remaining guests are unaffected.
  const state = {
    peer: null,
    hub: null,
    hubConn: null,
    conns: new Map(),        // host only: guest media id -> DataConnection
    roster: [],              // [{ id, name, joinedAt, host, mic, sharing, pending? }]
    isHost: false,
    myName: '',
    roomCode: '',
    joinedAt: 0,
    inRoom: false,
    leaving: false,
    migrating: false,
    screenStream: null,
    micStream: null,
    outCalls: new Map(),     // `${kind}|${peerId}` -> MediaConnection
    incoming: new Map(),     // `${kind}|${ownerId}` -> { call, stream }
    audioEls: new Map(),     // ownerId -> <audio>
    stageOwner: null,
    tab: 'peers',
    unread: 0,
    micBusy: false,
    syncTimer: null,
    statsTimer: null,
    prevStats: new Map(),
  };
  let pendingHub = null;     // { hubId, fail(err) } while connecting to the hub
  let toastTimer = null;

  const myId = () => state.peer?.id;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cleanName = (n, fallback = 'Guest') => String(n ?? '').trim().slice(0, 32) || fallback;
  const rosterEntry = (id) => state.roster.find((p) => p.id === id);
  const byJoin = (a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const currentQuality = () => CONFIG.quality[el.qualitySelect.value] || CONFIG.quality['1080p30'];

  // ===========================================================================
  // Small UI helpers
  // ===========================================================================
  function toast(msg, dur = 3000) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), dur);
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function setButton(btn, iconName, label) {
    btn.replaceChildren(icon(iconName), Object.assign(document.createElement('span'), { textContent: label }));
  }

  function appendChatNode(node) {
    const box = el.chatMessages;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.appendChild(node);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function addSystem(text) {
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    const t = document.createElement('div');
    t.className = 'chat-msg-text';
    t.textContent = text;
    div.appendChild(t);
    appendChatNode(div);
  }

  function addChat(author, text, ts = Date.now()) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const header = document.createElement('div');
    header.className = 'chat-msg-header';
    const a = Object.assign(document.createElement('span'), { className: 'chat-msg-author', textContent: author });
    const time = Object.assign(document.createElement('span'), {
      className: 'chat-msg-time',
      textContent: new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    header.append(a, time);
    const body = Object.assign(document.createElement('div'), { className: 'chat-msg-text', textContent: text });
    div.append(header, body);
    appendChatNode(div);
    if (state.tab !== 'chat') {
      state.unread++;
      el.chatBadge.textContent = state.unread > 99 ? '99+' : String(state.unread);
      el.chatBadge.classList.add('show');
    }
  }

  function renderPeers() {
    const me = myId();
    const cards = state.roster.map((p) => {
      const card = document.createElement('div');
      card.className = 'peer-card';
      const avatar = Object.assign(document.createElement('div'), {
        className: 'avatar',
        textContent: (p.name[0] || '?').toUpperCase(),
      });
      const name = document.createElement('div');
      name.className = 'peer-name';
      name.textContent = p.name;
      if (p.id === me) name.appendChild(Object.assign(document.createElement('small'), { textContent: ' (you)' }));
      if (p.pending) name.appendChild(Object.assign(document.createElement('small'), { textContent: ' · reconnecting' }));
      card.append(avatar, name);
      if (p.host) card.appendChild(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'Host' }));
      const flags = document.createElement('div');
      flags.className = 'peer-flags';
      if (p.sharing) {
        const s = icon('screen'); s.classList.add('on');
        flags.appendChild(Object.assign(s, { ariaLabel: 'Sharing screen' }));
      }
      const m = icon(p.mic ? 'mic' : 'mic-off');
      if (p.mic) m.classList.add('on');
      flags.appendChild(m);
      card.appendChild(flags);
      return card;
    });
    el.peersPanel.replaceChildren(...cards);
    el.peerCount.textContent = String(Math.max(1, state.roster.length));
  }

  function updateShareBtn() {
    const sharing = !!state.screenStream;
    el.shareBtn.classList.toggle('danger', sharing);
    el.shareBtn.classList.toggle('primary', !sharing);
    setButton(el.shareBtn, 'screen', sharing ? 'Stop Sharing' : 'Share Screen');
  }

  function updateMicBtn() {
    const on = !!state.micStream;
    el.muteBtn.classList.toggle('on', on);
    setButton(el.muteBtn, on ? 'mic' : 'mic-off', on ? 'Disable Mic' : 'Enable Mic');
  }

  // ===========================================================================
  // Stage (main video)
  // ===========================================================================
  function playUnmuted(media) {
    media.muted = false;
    const p = media.play();
    if (p) p.catch((err) => {
      if (err.name !== 'NotAllowedError') return;
      // Autoplay policy blocked sound: play muted and ask for a click.
      if (media === el.video) { media.muted = true; media.play().catch(() => {}); }
      el.unmuteBtn.classList.remove('hidden');
    });
  }

  function showOnStage(ownerId, stream, isLocal) {
    state.stageOwner = ownerId;
    el.placeholder.classList.add('hidden');
    el.stageLabel.classList.remove('hidden');
    el.stageLabel.textContent = isLocal
      ? 'You are sharing your screen'
      : `${rosterEntry(ownerId)?.name || 'Someone'}'s screen`;
    // Only (re)start playback when the stream actually changes; toggling
    // `muted` on a playing element can pause it under autoplay rules.
    if (el.video.srcObject === stream) return;
    el.video.srcObject = stream;
    if (isLocal) {
      el.video.muted = true; // never echo our own capture
      el.video.play().catch(() => {});
    } else {
      playUnmuted(el.video);
    }
  }

  function clearStage() {
    state.stageOwner = null;
    el.video.srcObject = null;
    el.stageLabel.classList.add('hidden');
    el.placeholder.classList.remove('hidden');
    const sharer = state.roster.find((p) => p.sharing && p.id !== myId());
    el.placeholder.textContent = sharer ? `Connecting to ${sharer.name}'s screen…` : 'No screen shared';
  }

  function refreshStage() {
    if (state.screenStream) { showOnStage(myId(), state.screenStream, true); return; }
    const streamOf = (id) => state.incoming.get(`screen|${id}`)?.stream;
    let owner = state.stageOwner;
    if (owner && !streamOf(owner)) owner = null;
    if (!owner) {
      let fallback = null;
      for (const [key, entry] of state.incoming) {
        if (!key.startsWith('screen|') || !entry.stream) continue;
        const id = key.slice(7);
        if (rosterEntry(id)?.sharing) { owner = id; break; }
        fallback = fallback || id;
      }
      owner = owner || fallback;
    }
    if (owner) showOnStage(owner, streamOf(owner), false);
    else clearStage();
  }

  // ===========================================================================
  // Media: SDP + sender tuning (performance)
  // ===========================================================================
  // Reorders video codecs (H264 first: hardware encode/decode on most devices;
  // then VP9, then VP8), enables stereo high-bitrate Opus for screen audio,
  // and sets a sensible starting bitrate so 1080p isn't blurry for 10+ seconds.
  function tuneSdp(sdp, kind) {
    try {
      const lines = sdp.split('\r\n');
      const codecOf = {};
      for (const l of lines) {
        const m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
        if (m) codecOf[m[1]] = m[2].toUpperCase();
      }
      const rank = (pt) => ({ H264: 0, VP9: 1, VP8: 2 }[codecOf[pt]] ?? 3);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('m=video ')) {
          const parts = line.split(' ');
          const pts = parts.slice(3).sort((a, b) => rank(a) - rank(b)); // stable
          lines[i] = [...parts.slice(0, 3), ...pts].join(' ');
          continue;
        }
        const f = line.match(/^a=fmtp:(\d+) (.*)$/);
        if (!f) continue;
        const codec = codecOf[f[1]];
        const params = new Map(f[2].split(';').map((kv) => {
          const [k, ...v] = kv.trim().split('=');
          return [k, v.join('=')];
        }));
        if (codec === 'OPUS') {
          params.set('useinbandfec', '1');
          if (kind === 'screen') {
            params.set('stereo', '1');
            params.set('sprop-stereo', '1');
            params.set('maxaveragebitrate', String(CONFIG.screenAudioBitrate));
          }
        } else if (kind === 'screen' && (codec === 'H264' || codec === 'VP9' || codec === 'VP8')) {
          params.set('x-google-start-bitrate', String(CONFIG.startBitrateKbps));
        } else {
          continue;
        }
        lines[i] = `a=fmtp:${f[1]} ${[...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`;
      }
      return lines.join('\r\n');
    } catch (err) {
      console.warn('SDP tuning failed, using original', err);
      return sdp;
    }
  }

  async function tuneSenders(call, kind) {
    const pc = call.peerConnection;
    if (!pc) return;
    const q = currentQuality();
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.priority = 'high';
      enc.networkPriority = 'high';
      if (sender.track.kind === 'video') {
        enc.maxBitrate = q.bitrate;
        enc.maxFramerate = q.fps;
        // Smooth playback beats sharpness for video: drop resolution, not frames.
        params.degradationPreference = 'maintain-framerate';
      } else {
        enc.maxBitrate = kind === 'screen' ? CONFIG.screenAudioBitrate : CONFIG.micBitrate;
      }
      try {
        await sender.setParameters(params);
      } catch (err) {
        // Some browsers reject degradationPreference; retry without it.
        delete params.degradationPreference;
        try { await sender.setParameters(params); } catch (e) { console.warn('setParameters failed', e); }
      }
    }
  }

  function whenConnected(call, fn) {
    const pc = call.peerConnection;
    if (!pc) return;
    if (pc.connectionState === 'connected') { fn(); return; }
    const onChange = () => {
      if (pc.connectionState === 'connected') { pc.removeEventListener('connectionstatechange', onChange); fn(); }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pc.removeEventListener('connectionstatechange', onChange);
        call.close();
      }
    };
    pc.addEventListener('connectionstatechange', onChange);
  }

  // ===========================================================================
  // Media: outgoing calls (direct mesh from the stream owner)
  // ===========================================================================
  function placeCall(kind, peerId) {
    const stream = kind === 'screen' ? state.screenStream : state.micStream;
    if (!stream || !state.peer) return;
    if (state.peer.disconnected) { scheduleSync(); return; } // signaling down; retry
    const call = state.peer.call(peerId, stream, {
      metadata: { kind },
      sdpTransform: (sdp) => tuneSdp(sdp, kind),
    });
    if (!call) return;
    const key = `${kind}|${peerId}`;
    state.outCalls.set(key, call);
    whenConnected(call, () => tuneSenders(call, kind));
    const cleanup = () => {
      if (state.outCalls.get(key) !== call) return;
      state.outCalls.delete(key);
      scheduleSync(); // re-call if the peer is still in the room
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
  }

  // Makes outgoing calls match (my streams) × (everyone else in the roster).
  function syncOutgoing() {
    if (!state.peer) return;
    const others = state.roster.filter((p) => p.id !== myId()).map((p) => p.id);
    const want = new Set();
    if (state.screenStream) others.forEach((id) => want.add(`screen|${id}`));
    if (state.micStream) others.forEach((id) => want.add(`mic|${id}`));
    for (const [key, call] of state.outCalls) {
      if (!want.has(key)) { state.outCalls.delete(key); call.close(); }
    }
    for (const key of want) {
      if (state.outCalls.has(key)) continue;
      const [kind, id] = key.split('|');
      placeCall(kind, id);
    }
  }

  function scheduleSync() {
    if (state.leaving || state.syncTimer) return;
    state.syncTimer = setTimeout(() => { state.syncTimer = null; syncOutgoing(); }, 2000);
  }

  // ===========================================================================
  // Media: incoming calls
  // ===========================================================================
  async function onIncomingCall(call) {
    const kind = call.metadata?.kind;
    const owner = call.peer;
    if (kind !== 'screen' && kind !== 'mic') { call.close(); return; }
    // Only accept media from room members. A caller may learn about us a moment
    // before our roster lists them, so wait briefly.
    for (let i = 0; i < 15 && !rosterEntry(owner); i++) await sleep(200);
    if (!rosterEntry(owner) || state.leaving) { call.close(); return; }

    const key = `${kind}|${owner}`;
    const prev = state.incoming.get(key);
    const entry = { call, stream: null };
    state.incoming.set(key, entry);
    if (prev) prev.call.close();

    call.answer(undefined, { sdpTransform: (sdp) => tuneSdp(sdp, kind) });
    call.on('stream', (stream) => {
      if (state.incoming.get(key) !== entry) return;
      entry.stream = stream;
      if (kind === 'mic') attachMic(owner, stream);
      else refreshStage();
    });
    const done = () => { if (state.incoming.get(key) === entry) dropIncoming(kind, owner); };
    call.on('close', done);
    call.on('error', done);
  }

  function dropIncoming(kind, owner) {
    const key = `${kind}|${owner}`;
    const entry = state.incoming.get(key);
    if (!entry) return;
    state.incoming.delete(key);
    entry.call.close();
    if (kind === 'mic') {
      const audio = state.audioEls.get(owner);
      if (audio) { audio.srcObject = null; audio.remove(); state.audioEls.delete(owner); }
    } else if (state.stageOwner === owner) {
      state.stageOwner = null;
      refreshStage();
    }
  }

  function attachMic(owner, stream) {
    let audio = state.audioEls.get(owner);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      document.body.appendChild(audio);
      state.audioEls.set(owner, audio);
    }
    audio.srcObject = stream;
    playUnmuted(audio);
  }

  // ===========================================================================
  // Roster (source of truth: host)
  // ===========================================================================
  function applyRoster(next, { silent = false } = {}) {
    const prev = new Map(state.roster.map((p) => [p.id, p]));
    state.roster = next.slice().sort(byJoin);
    const now = new Map(state.roster.map((p) => [p.id, p]));
    const me = myId();

    if (!silent) {
      for (const p of state.roster) if (!prev.has(p.id) && p.id !== me) addSystem(`${p.name} joined`);
      for (const p of prev.values()) if (!now.has(p.id) && p.id !== me) addSystem(`${p.name} left`);
    }

    // Drop media from people who left or turned their stream off. Only react to
    // a true→false transition so a roster that predates a new stream can't kill it.
    for (const key of [...state.incoming.keys()]) {
      const [kind, owner] = key.split('|');
      const flag = kind === 'screen' ? 'sharing' : 'mic';
      const p = now.get(owner);
      if (!p || (prev.get(owner)?.[flag] && !p[flag])) dropIncoming(kind, owner);
    }

    syncOutgoing();
    renderPeers();
    refreshStage();
  }

  // Tell the room about our mic/share state.
  function publishState() {
    const mine = { mic: !!state.micStream, sharing: !!state.screenStream };
    if (state.isHost) {
      hostUpdateState(myId(), mine);
    } else {
      // Optimistic local update; the host's roster broadcast will confirm it.
      applyRoster(state.roster.map((p) => (p.id === myId() ? { ...p, ...mine } : p)), { silent: true });
      if (state.hubConn?.open) state.hubConn.send({ type: 'state', ...mine });
    }
  }

  // ===========================================================================
  // Host: hub peer + data protocol
  // ===========================================================================
  function hostSetRoster(next) {
    applyRoster(next);
    const msg = { type: 'roster', peers: state.roster };
    for (const conn of state.conns.values()) if (conn.open) conn.send(msg);
  }

  function hostBroadcast(msg, exceptId = null) {
    for (const [id, conn] of state.conns) if (id !== exceptId && conn.open) conn.send(msg);
  }

  // Applies a peer's mic/share state, enforcing one sharer at a time.
  function hostUpdateState(id, { mic, sharing }) {
    const other = state.roster.find((p) => p.sharing && p.id !== id);
    let allowShare = !!sharing;
    if (allowShare && other) {
      allowShare = false;
      if (id === myId()) stopScreenShare(false);
      else state.conns.get(id)?.send({ type: 'share_denied', by: other.name });
    }
    hostSetRoster(state.roster.map((p) => (p.id === id ? { ...p, mic: !!mic, sharing: allowShare } : p)));
  }

  function wireHub(hub) {
    hub.on('connection', (conn) => {
      conn.on('data', (msg) => onHostData(conn, msg));
      conn.on('close', () => onHostConnClose(conn));
      conn.on('error', (err) => console.warn('guest connection error', err));
    });
    hub.on('error', (err) => {
      console.warn('hub error', err);
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        toast('Lost connection to the signaling server, retrying…');
      }
    });
    hub.on('disconnected', () => reconnectLater(hub));
  }

  function onHostData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = conn.peer; // the guest's media peer id

    if (msg.type === 'hello') {
      const old = state.conns.get(id);
      state.conns.set(id, conn);
      if (old && old !== conn) old.close();
      const existing = rosterEntry(id);
      const entry = {
        id,
        name: cleanName(msg.name),
        joinedAt: Number(msg.joinedAt) || existing?.joinedAt || Date.now(),
        host: false,
        mic: !!msg.mic,
        sharing: false,
      };
      let denied = null;
      if (msg.sharing) {
        const other = state.roster.find((p) => p.sharing && p.id !== id);
        if (other) denied = other.name; else entry.sharing = true;
      }
      const next = state.roster.filter((p) => p.id !== id).concat(entry);
      conn.send({ type: 'welcome', hostName: state.myName, peers: next.slice().sort(byJoin) });
      if (denied) conn.send({ type: 'share_denied', by: denied });
      hostSetRoster(next);
      return;
    }

    if (state.conns.get(id) !== conn) return; // must say hello first
    const from = rosterEntry(id);
    if (!from) return;

    switch (msg.type) {
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 300);
        if (!text) return;
        const out = { type: 'chat', from: id, name: from.name, text, ts: Date.now() };
        addChat(out.name, out.text, out.ts);
        hostBroadcast(out, id);
        break;
      }
      case 'state':
        hostUpdateState(id, msg);
        break;
    }
  }

  function onHostConnClose(conn) {
    const id = conn.peer;
    if (state.conns.get(id) !== conn) return;
    state.conns.delete(id);
    if (!state.leaving) hostSetRoster(state.roster.filter((p) => p.id !== id));
  }

  // ===========================================================================
  // Guest: connection to the hub
  // ===========================================================================
  // Opens a data connection to the room hub, says hello and waits for welcome.
  function connectToHub(timeoutMs) {
    return new Promise((resolve, reject) => {
      const hubId = hubIdFor(state.roomCode);
      const conn = state.peer.connect(hubId, { reliable: true, serialization: 'json' });
      let done = false;
      const finish = (err, welcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (pendingHub?.fail === finish) pendingHub = null;
        conn.off('data', onData);
        if (err) { conn.close(); reject(err); } else resolve({ conn, welcome });
      };
      const onData = (msg) => { if (msg?.type === 'welcome') finish(null, msg); };
      const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { type: 'timeout' })), timeoutMs);
      pendingHub = { hubId, fail: finish };
      conn.on('open', () => conn.send({
        type: 'hello',
        name: state.myName,
        joinedAt: state.joinedAt,
        mic: !!state.micStream,
        sharing: !!state.screenStream,
      }));
      conn.on('data', onData);
      conn.on('error', (err) => finish(err));
      conn.on('close', () => finish(Object.assign(new Error('closed'), { type: 'closed' })));
    });
  }

  function attachGuestConn(conn) {
    state.hubConn = conn;
    conn.on('data', onGuestData);
    conn.on('close', () => {
      if (state.hubConn !== conn) return;
      state.hubConn = null;
      onHostLost();
    });
    // Detect a vanished host faster than the SCTP timeout.
    const pc = conn.peerConnection;
    pc?.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') conn.close();
    });
  }

  function onGuestData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'roster':
        if (Array.isArray(msg.peers)) applyRoster(msg.peers.map(sanitizePeer));
        break;
      case 'chat':
        addChat(cleanName(msg.name, 'Someone'), String(msg.text ?? '').slice(0, 300), Number(msg.ts) || Date.now());
        break;
      case 'share_denied':
        stopScreenShare(false);
        toast(`${cleanName(msg.by, 'Someone')} is already sharing their screen.`);
        break;
      case 'host_leaving':
        onHostLost();
        break;
    }
  }

  function sanitizePeer(p) {
    return {
      id: String(p.id),
      name: cleanName(p.name),
      joinedAt: Number(p.joinedAt) || 0,
      host: !!p.host,
      mic: !!p.mic,
      sharing: !!p.sharing,
      pending: !!p.pending,
    };
  }

  function handleWelcome(welcome) {
    applyRoster((welcome.peers || []).map(sanitizePeer), { silent: true });
    return cleanName(welcome.hostName, 'the host');
  }

  // ===========================================================================
  // Host migration
  // ===========================================================================
  // Every guest computes the same successor order (roster by join time). The
  // first candidate tries to claim the hub id right away, later candidates only
  // after a stagger; everyone else keeps trying to connect to the hub id.
  async function onHostLost() {
    if (state.leaving || state.migrating || state.isHost || !state.inRoom) return;
    state.migrating = true;
    if (state.hubConn) { const c = state.hubConn; state.hubConn = null; c.close(); }

    const oldHost = state.roster.find((p) => p.host);
    const remaining = state.roster.filter((p) => !p.host);
    applyRoster(remaining, { silent: true });
    addSystem(`${oldHost?.name || 'The host'} left. Moving the room to a new host…`);
    toast('Host left, reconnecting…', 4000);

    const order = remaining.slice().sort(byJoin).map((p) => p.id);
    const myIndex = order.indexOf(myId());
    const start = Date.now();
    let attempt = 0;

    while (!state.leaving && Date.now() - start < CONFIG.migrationTimeoutMs) {
      if (myIndex >= 0 && Date.now() - start >= myIndex * CONFIG.migrationStaggerMs) {
        try {
          await becomeHost();
          state.migrating = false;
          addSystem('You are now the host.');
          toast('You are now the host');
          return;
        } catch (err) {
          // unavailable-id: someone else claimed it, or the old host's
          // registration hasn't expired yet. Either way, try connecting.
          if (err.type !== 'unavailable-id') console.warn('claim failed', err);
        }
      }
      try {
        const { conn, welcome } = await connectToHub(4000);
        attachGuestConn(conn);
        const hostName = handleWelcome(welcome);
        state.migrating = false;
        addSystem(`Reconnected. ${hostName} is now the host.`);
        return;
      } catch { /* hub not up yet */ }
      await sleep(Math.min(1000 * 2 ** attempt++, 4000));
    }

    state.migrating = false;
    if (!state.leaving) {
      addSystem("Couldn't reach a new host. The room has ended. Leave and create a new room.");
      toast('Room connection lost', 5000);
    }
  }

  async function becomeHost() {
    const hub = await createPeer(hubIdFor(state.roomCode));
    if (state.leaving) { hub.destroy(); return; }
    state.hub = hub;
    state.isHost = true;
    wireHub(hub);
    // Keep the other guests (marked pending) so media between us isn't torn
    // down while they reconnect. Drop whoever doesn't come back.
    const me = myId();
    applyRoster(state.roster.map((p) => (p.id === me
      ? { ...p, host: true, pending: false }
      : { ...p, host: false, pending: true })), { silent: true });
    setTimeout(() => {
      if (!state.isHost || state.leaving) return;
      const stale = state.roster.filter((p) => p.pending && !state.conns.has(p.id));
      if (stale.length) hostSetRoster(state.roster.filter((p) => !stale.includes(p)));
    }, CONFIG.pendingPeerGraceMs);
  }

  // ===========================================================================
  // Peers / signaling
  // ===========================================================================
  function hubIdFor(code) { return CONFIG.idPrefix + code.replace('-', ''); }

  function generateCode() {
    const a = CONFIG.codeAlphabet;
    const limit = 256 - (256 % a.length); // reject to avoid modulo bias
    let s = '';
    while (s.length < 6) {
      for (const b of crypto.getRandomValues(new Uint8Array(12))) {
        if (b < limit && s.length < 6) s += a[b % a.length];
      }
    }
    return `${s.slice(0, 3)}-${s.slice(3)}`;
  }

  function parseCode(raw) {
    const c = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : null;
  }

  function createPeer(id) {
    return new Promise((resolve, reject) => {
      const opts = { config: { iceServers: CONFIG.iceServers }, debug: 0 };
      const p = id ? new Peer(id, opts) : new Peer(opts);
      const onOpen = () => { p.off('error', onErr); resolve(p); };
      const onErr = (err) => { p.off('open', onOpen); p.destroy(); reject(err); };
      p.once('open', onOpen);
      p.once('error', onErr);
    });
  }

  function reconnectLater(p) {
    if (state.leaving) return;
    setTimeout(() => {
      if (!state.leaving && !p.destroyed && p.disconnected) p.reconnect();
    }, 1000);
  }

  function wireMediaPeer(p) {
    p.on('call', onIncomingCall);
    p.on('disconnected', () => reconnectLater(p));
    p.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        // Either the room hub doesn't exist (yet), or a media target left.
        if (pendingHub && String(err.message).includes(pendingHub.hubId)) pendingHub.fail(err);
        return;
      }
      console.warn('peer error', err);
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        toast('Lost connection to the signaling server, retrying…');
      }
    });
  }

  function teardown() {
    state.screenStream?.getTracks().forEach((t) => t.stop());
    state.micStream?.getTracks().forEach((t) => t.stop());
    state.screenStream = state.micStream = null;
    for (const c of state.outCalls.values()) c.close();
    for (const { call } of state.incoming.values()) call.close();
    state.outCalls.clear();
    state.incoming.clear();
    state.hub?.destroy();
    state.peer?.destroy();
    state.hub = state.peer = state.hubConn = null;
    state.conns.clear();
    state.roster = [];
    state.isHost = false;
  }

  // ===========================================================================
  // Lobby actions
  // ===========================================================================
  function setBusy(busy) {
    el.createBtn.disabled = busy;
    el.joinBtn.disabled = busy;
  }

  function enterRoom() {
    state.inRoom = true;
    el.lobby.classList.add('hidden');
    el.room.classList.add('active');
    document.body.classList.add('in-room');
    el.headerRoomId.textContent = state.roomCode;
    history.replaceState(null, '', `?room=${state.roomCode}`);
    updateShareBtn();
    updateMicBtn();
    clearStage();
  }

  async function createRoom(e) {
    e.preventDefault();
    el.createError.textContent = '';
    setBusy(true);
    state.myName = cleanName(el.hostName.value, 'Host');
    state.joinedAt = Date.now();
    try {
      state.peer = await createPeer();
      wireMediaPeer(state.peer);
      for (let i = 0; i < 5 && !state.hub; i++) {
        const code = generateCode();
        try {
          state.hub = await createPeer(hubIdFor(code));
          state.roomCode = code;
        } catch (err) {
          if (err.type !== 'unavailable-id') throw err;
        }
      }
      if (!state.hub) throw new Error('Could not reserve a room code, try again.');
      state.isHost = true;
      wireHub(state.hub);
      enterRoom();
      applyRoster([{ id: myId(), name: state.myName, joinedAt: state.joinedAt, host: true, mic: false, sharing: false }], { silent: true });
      addSystem('Room created. Use "Copy link" to invite people.');
    } catch (err) {
      console.error(err);
      teardown();
      el.createError.textContent = friendlyError(err);
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(e) {
    e.preventDefault();
    el.joinError.textContent = '';
    const code = parseCode(el.joinCode.value);
    if (!code) { el.joinError.textContent = 'Room codes are 6 letters or numbers, like ABC-123.'; return; }
    setBusy(true);
    state.myName = cleanName(el.joinName.value);
    state.roomCode = code;
    state.joinedAt = Date.now();
    try {
      state.peer = await createPeer();
      wireMediaPeer(state.peer);
      const { conn, welcome } = await connectToHub(CONFIG.joinTimeoutMs);
      enterRoom();
      attachGuestConn(conn);
      const hostName = handleWelcome(welcome);
      addSystem(`You joined ${hostName}'s room.`);
    } catch (err) {
      console.error(err);
      teardown();
      el.joinError.textContent = friendlyError(err);
    } finally {
      setBusy(false);
    }
  }

  function friendlyError(err) {
    switch (err?.type) {
      case 'peer-unavailable': return "Room not found. Check the code, or ask the host if they're still online.";
      case 'timeout': return 'Timed out connecting to the room. Try again.';
      case 'browser-incompatible': return 'This browser does not support WebRTC.';
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return 'Could not reach the signaling server. Check your connection.';
      default: return err?.message || 'Something went wrong.';
    }
  }

  function leaveRoom() {
    if (state.leaving) return;
    state.leaving = true;
    if (state.isHost) hostBroadcast({ type: 'host_leaving' });
    // Give the host_leaving message a moment to flush before tearing down.
    setTimeout(() => {
      teardown();
      location.href = location.pathname;
    }, 200);
  }

  // ===========================================================================
  // Room actions
  // ===========================================================================
  async function startScreenShare() {
    const other = state.roster.find((p) => p.sharing && p.id !== myId());
    if (other) { toast(`${other.name} is already sharing. Ask them to stop first.`); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast('Screen sharing is not supported in this browser.'); return; }
    const q = currentQuality();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: q.width, max: q.width },
          height: { ideal: q.height, max: q.height },
          frameRate: { ideal: q.fps, max: q.fps },
        },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
      });
    } catch (err) {
      if (err.name !== 'NotAllowedError') console.warn(err);
      toast('Screen share cancelled');
      return;
    }
    if (!state.inRoom || state.leaving) { stream.getTracks().forEach((t) => t.stop()); return; }
    stream.getVideoTracks().forEach((t) => { if ('contentHint' in t) t.contentHint = 'motion'; });
    stream.getAudioTracks().forEach((t) => { if ('contentHint' in t) t.contentHint = 'music'; });
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stopScreenShare());

    state.screenStream = stream;
    updateShareBtn();
    refreshStage();
    publishState();
    syncOutgoing();
    if (!stream.getAudioTracks().length) {
      toast('Sharing without sound. To include audio, tick "Share audio" in the picker.', 5000);
    }
  }

  function stopScreenShare(publish = true) {
    if (!state.screenStream) return;
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
    if (state.stageOwner === myId()) state.stageOwner = null;
    syncOutgoing();
    updateShareBtn();
    refreshStage();
    if (publish) publishState();
  }

  async function toggleMic() {
    if (state.micBusy) return;
    state.micBusy = true;
    try {
      if (state.micStream) {
        // Fully stop the tracks so the browser's mic indicator turns off.
        state.micStream.getTracks().forEach((t) => t.stop());
        state.micStream = null;
      } else {
        try {
          state.micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch {
          toast('Microphone access denied or unavailable');
          return;
        }
      }
      updateMicBtn();
      publishState();
      syncOutgoing();
    } finally {
      state.micBusy = false;
    }
  }

  async function onQualityChange() {
    if (!state.screenStream) return;
    const q = currentQuality();
    const track = state.screenStream.getVideoTracks()[0];
    try {
      await track?.applyConstraints({
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      });
    } catch (err) { console.warn('applyConstraints failed', err); }
    for (const [key, call] of state.outCalls) if (key.startsWith('screen|')) tuneSenders(call, 'screen');
    toast(`Quality set to ${el.qualitySelect.selectedOptions[0].textContent}`);
  }

  function sendChat(e) {
    e.preventDefault();
    const text = el.chatInput.value.trim().slice(0, 300);
    if (!text) return;
    el.chatInput.value = '';
    if (state.isHost) {
      const ts = Date.now();
      addChat(state.myName, text, ts);
      hostBroadcast({ type: 'chat', from: myId(), name: state.myName, text, ts });
    } else if (state.hubConn?.open) {
      addChat(state.myName, text);
      state.hubConn.send({ type: 'chat', text });
    } else {
      toast('Not connected, message not sent');
      el.chatInput.value = text;
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    $('peers-panel').classList.toggle('active', tab === 'peers');
    $('chat-panel').classList.toggle('active', tab === 'chat');
    if (tab === 'chat') {
      state.unread = 0;
      el.chatBadge.classList.remove('show');
      el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
      el.chatInput.focus();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else (el.stage.requestFullscreen || el.stage.webkitRequestFullscreen)?.call(el.stage);
  }

  async function copyLink() {
    const url = `${location.href.split('?')[0]}?room=${state.roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      toast(url, 8000);
    }
  }

  // ===========================================================================
  // Stats overlay
  // ===========================================================================
  function toggleStats() {
    const on = el.stats.classList.toggle('hidden') === false;
    el.statsBtn.setAttribute('aria-pressed', String(on));
    clearInterval(state.statsTimer);
    state.prevStats.clear();
    if (on) {
      updateStats();
      state.statsTimer = setInterval(updateStats, 1000);
    }
  }

  function rate(key, bytes, ts) {
    const prev = state.prevStats.get(key);
    state.prevStats.set(key, { bytes, ts });
    if (!prev || ts <= prev.ts) return null;
    return ((bytes - prev.bytes) * 8) / (ts - prev.ts); // kbps (ts in ms)
  }

  const fmt = (v, digits = 0, unit = '') => (v == null || Number.isNaN(v) ? '–' : `${v.toFixed(digits)}${unit}`);

  function pathInfo(report) {
    let rtt = null; let route = '';
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = report.get(s.selectedCandidatePairId);
        if (pair) {
          rtt = pair.currentRoundTripTime;
          const local = report.get(pair.localCandidateId);
          route = local?.candidateType === 'relay' ? 'TURN relay' : 'direct';
        }
      }
    });
    return { rtt, route };
  }

  async function updateStats() {
    const lines = [];
    try {
      if (state.screenStream) {
        lines.push(`SENDING to ${[...state.outCalls.keys()].filter((k) => k.startsWith('screen|')).length} viewer(s)`);
        for (const [key, call] of state.outCalls) {
          if (!key.startsWith('screen|') || !call.peerConnection) continue;
          const id = key.slice(7);
          const report = await call.peerConnection.getStats();
          let line = `${(rosterEntry(id)?.name || id).slice(0, 12).padEnd(12)} `;
          report.forEach((s) => {
            if (s.type === 'outbound-rtp' && s.kind === 'video') {
              const codec = report.get(s.codecId)?.mimeType?.split('/')[1] || '?';
              line += `${s.frameWidth || '?'}x${s.frameHeight || '?'} ${fmt(s.framesPerSecond)}fps `
                + `${fmt(rate(`${key}|v`, s.bytesSent, s.timestamp))}kbps ${codec}`
                + (s.qualityLimitationReason && s.qualityLimitationReason !== 'none' ? ` LIMIT:${s.qualityLimitationReason}` : '');
            }
          });
          const { rtt, route } = pathInfo(report);
          lines.push(`${line} rtt ${fmt(rtt == null ? null : rtt * 1000, 0, 'ms')} ${route}`);
        }
      } else if (state.stageOwner) {
        const entry = state.incoming.get(`screen|${state.stageOwner}`);
        const pc = entry?.call.peerConnection;
        if (pc) {
          const report = await pc.getStats();
          report.forEach((s) => {
            if (s.type !== 'inbound-rtp') return;
            const kbps = rate(`in|${s.id}`, s.bytesReceived, s.timestamp);
            const lossPct = s.packetsReceived ? (100 * (s.packetsLost || 0)) / (s.packetsReceived + (s.packetsLost || 0)) : 0;
            const codec = report.get(s.codecId)?.mimeType?.split('/')[1] || '?';
            const jb = s.jitterBufferEmittedCount ? (1000 * s.jitterBufferDelay) / s.jitterBufferEmittedCount : null;
            if (s.kind === 'video') {
              lines.push(`VIDEO ${s.frameWidth || '?'}x${s.frameHeight || '?'} @ ${fmt(s.framesPerSecond)}fps  ${codec}`);
              lines.push(`      ${fmt(kbps)} kbps  loss ${fmt(lossPct, 1, '%')}  dropped ${s.framesDropped ?? 0}  freezes ${s.freezeCount ?? 0}`);
              lines.push(`      jitter buffer ${fmt(jb, 0, 'ms')}`);
            } else {
              lines.push(`AUDIO ${codec} ${fmt(kbps)} kbps  loss ${fmt(lossPct, 1, '%')}  jb ${fmt(jb, 0, 'ms')}`);
            }
          });
          const { rtt, route } = pathInfo(report);
          lines.push(`PATH  rtt ${fmt(rtt == null ? null : rtt * 1000, 0, 'ms')}  ${route}`);
        }
      }
    } catch (err) {
      lines.push(`stats error: ${err.message}`);
    }
    el.stats.textContent = lines.length ? lines.join('\n') : 'No active stream';
  }

  // ===========================================================================
  // Wiring
  // ===========================================================================
  el.createForm.addEventListener('submit', createRoom);
  el.joinForm.addEventListener('submit', joinRoom);
  el.leaveBtn.addEventListener('click', leaveRoom);
  el.copyLinkBtn.addEventListener('click', copyLink);
  el.shareBtn.addEventListener('click', () => (state.screenStream ? stopScreenShare() : startScreenShare()));
  el.muteBtn.addEventListener('click', toggleMic);
  el.qualitySelect.addEventListener('change', onQualityChange);
  el.fullscreenBtn.addEventListener('click', toggleFullscreen);
  el.statsBtn.addEventListener('click', toggleStats);
  el.chatForm.addEventListener('submit', sendChat);
  el.unmuteBtn.addEventListener('click', () => {
    el.unmuteBtn.classList.add('hidden');
    if (state.stageOwner && state.stageOwner !== myId()) { el.video.muted = false; el.video.play().catch(() => {}); }
    for (const a of state.audioEls.values()) a.play().catch(() => {});
  });
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Best effort: let guests start migration immediately if the host closes the tab.
  window.addEventListener('pagehide', () => {
    if (state.inRoom && state.isHost && !state.leaving) {
      state.leaving = true;
      hostBroadcast({ type: 'host_leaving' });
    }
  });

  if (typeof Peer === 'undefined') {
    el.createError.textContent = el.joinError.textContent = 'Failed to load PeerJS. Check your connection or ad blocker.';
    setBusy(true);
  }
  const urlRoom = parseCode(new URLSearchParams(location.search).get('room'));
  if (urlRoom) {
    el.joinCode.value = urlRoom;
    el.joinName.focus();
  }
})();
