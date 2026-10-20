// Networking (PeerJS) and the page. Whoever starts a room owns it: their
// browser registers the peer ID PEER_PREFIX + code on PeerJS's free public
// server, keeps the real game and runs every action. Everyone else connects to
// it and asks to come in; the owner sees their name and lets them in to play
// (while a seat is free) or to watch, or turns them away. The owner can play
// or just watch. People watching see everything, secrets included.
// Everyone saves after every change so they can reload and reconnect: to
// sessionStorage, so a reloaded tab gets back its own game even when others are
// in other tabs of the same browser, and to localStorage (one slot per role) so
// the game can be resumed after closing the tab.

const PEER_PREFIX = 'supernac-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SAVE_KEY = 'snc-room', NAME_KEY = 'snc-name';
const HEARTBEAT_MS = 3000, TIMEOUT_MS = 15000, RETRY_MS = 3000;

function makeStore(area) {
  return {
    get(k) { try { return JSON.parse(window[area].getItem(k)); } catch { return null; } },
    set(k, v) { try { window[area].setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { window[area].removeItem(k); } catch {} },
  };
}
const store = makeStore('localStorage'), tabStore = makeStore('sessionStorage');

const me = { name: store.get(NAME_KEY) || '' };

let session = null;    // { code, role: 'owner' | 'client', id, fresh }; id is ours in this room
let state = null;      // owner: the real game; client: the owner's latest copy for us
let peer = null;
let conn = null;       // client: the link to the owner
let links = new Map(); // owner: id of someone let in -> their connection
let pending = [];      // owner: [{ conn, id, name }] asking to be let in
let connected = false, asking = false, lastHeard = 0, retryTimer = null;
let status = { text: '', kind: 'warn' };
let ended = null;      // message shown once the game can't continue

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cleanName = (s, fallback) => String(s || '').trim().slice(0, 20) || fallback;

function newCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[randInt(CODE_CHARS.length)];
  return c;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
}

function save() {
  const data = { code: session.code, role: session.role, id: session.id, state };
  tabStore.set(SAVE_KEY, data);
  store.set(`${SAVE_KEY}-${session.role}`, data);
}

// A tab with a game open marks it as live every heartbeat, so other tabs of
// the same browser (say, opening the invite link to join as someone else)
// don't take it over.
const liveKey = (role) => `${SAVE_KEY}-live-${role}`;
function markLive() {
  if (session && !ended) store.set(liveKey(session.role), { code: session.code, t: Date.now() });
}
function openElsewhere(saved) {
  const live = store.get(liveKey(saved.role));
  return live?.code === saved.code && Date.now() - live.t < HEARTBEAT_MS * 3;
}

// This tab's own game if it has one, otherwise the most likely game to resume
// (the owner's copy is the real one), unless another tab has it open.
function loadSave() {
  return tabStore.get(SAVE_KEY) || [store.get(`${SAVE_KEY}-owner`), store.get(`${SAVE_KEY}-client`)]
    .find((s) => s && !openElsewhere(s)) || null;
}

function deleteSave(saved) {
  tabStore.del(SAVE_KEY);
  for (const k of [`${SAVE_KEY}-${saved.role}`, liveKey(saved.role)]) {
    if (store.get(k)?.code === saved.code) store.del(k);
  }
}

// Mad Libs sentences. Only the owner uses them, but they're small.
fetch('madlibs.txt', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((text) => { MADLIBS = parseMadlibs(text); })
  .catch((err) => console.warn("Couldn't load madlibs.txt, so Mad Libs is left out:", err));

// ---- Who's who ------------------------------------------------------------

function seatOf(id) {
  return SEATS.find((s) => state.players[s]?.id === id) || null;
}
const mySeat = () => (state ? seatOf(session.id) : null);

function memberName(id) {
  const seat = seatOf(id);
  return seat ? state.players[seat].name : state.watchers.find((w) => w.id === id)?.name;
}

function onlineIds() {
  if (session.role !== 'owner') return state.online || [];
  return [session.id, ...[...links].filter(([, c]) => c.open).map(([id]) => id)];
}

function sysChat(text) {
  state.chat.push({ sys: true, text });
}

// ---- Starting and leaving -------------------------------------------------

function readName(fallback) {
  me.name = cleanName($('name').value, fallback);
  store.set(NAME_KEY, me.name);
}

function hostNewGame(watch) {
  readName('Host');
  const code = newCode(), id = newId();
  session = { code, role: 'owner', id, fresh: true };
  state = createGame(code);
  if (watch) state.watchers.push({ id, name: me.name });
  else state.players.x = { id, name: me.name };
  start();
}

function joinGame(code) {
  readName('Player');
  session = { code, role: 'client', id: newId() };
  state = null;
  start();
}

function resumeGame(saved) {
  session = { code: saved.code, role: saved.role, id: saved.id };
  state = saved.state;
  start();
}

function start() {
  ended = null;
  asking = false;
  pending = [];
  links = new Map();
  save();
  markLive();
  location.hash = session.code;
  $('home').hidden = true;
  $('game').hidden = false;
  lastChatKey = lastPanel = null;
  openPeer();
  if (session.role === 'owner') scheduleAdvance();
  render();
}

function leaveGame() {
  const owner = session.role === 'owner';
  const ask = owner ? 'Close this room? Everyone in it will be sent back to the start.'
    : "Leave this game? You won't be able to come back to it.";
  if (!ended && !confirm(ask)) return;
  if (owner) {
    for (const c of links.values()) if (c.open) c.send({ t: 'bye' });
  } else {
    send({ t: 'bye' });
  }
  // Give the goodbye a moment to go out before tearing everything down.
  setTimeout(() => {
    shutdown();
    session = state = null;
    history.replaceState(null, '', location.pathname);
    showHome();
  }, 300);
}

function shutdown() {
  clearTimeout(retryTimer);
  clearTimeout(advanceTimer);
  advanceFor = null;
  deleteSave(session);
  connected = false;
  conn = null;
  links = new Map();
  pending = [];
  if (peer) peer.destroy();
  peer = null;
}

function endGame(message) {
  shutdown();
  ended = message;
  render();
}

// ---- Connection -----------------------------------------------------------

function setStatus(text, kind) {
  status = { text, kind };
  render();
}

function retry(fn) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(fn, RETRY_MS);
}

// Some hosts (e.g. free Neocities sites) send a Content-Security-Policy that
// only lets the page connect to its own domain, which rules out the PeerJS
// server. Retrying can't fix that, so say so plainly.
const BLOCKED_MSG = "This website isn't allowed to connect to the game server " +
  '(its Content-Security-Policy blocks outside connections), so online play ' +
  "can't work here. The game needs to be hosted somewhere that allows them.";
let blockedBySite = false;
document.addEventListener('securitypolicyviolation', (e) => {
  if (e.effectiveDirective !== 'connect-src' || !/peerjs/.test(e.blockedURI)) return;
  blockedBySite = true;
  // The violation report can arrive after openPeer() already gave up, so
  // replace whatever message it showed.
  if (session && ended !== BLOCKED_MSG) endGame(BLOCKED_MSG);
});

function openPeer() {
  clearTimeout(retryTimer);
  if (peer) peer.destroy();
  connected = false;
  conn = null;
  const owner = session.role === 'owner';
  if (typeof Peer === 'undefined') {
    // Keep the save so a reload can pick the game back up.
    ended = "The networking library didn't load, so online play can't start. Reload the page to try again.";
    return render();
  }
  // Clients pick their own ID too, so they never have to ask the server for
  // one (that request is what fails with 'server-error' when it's flaky).
  const id = PEER_PREFIX + session.code + (owner ? '' : '-' + newCode() + newCode());
  let p;
  try {
    p = new Peer(id, { debug: 1 });
  } catch (err) {
    // The browser refused to open the connection to the PeerJS server outright.
    console.error(err);
    ended = blockedBySite ? BLOCKED_MSG : `Couldn't start online play (${err.name}). Reload the page to try again.`;
    return render();
  }
  peer = p;
  setStatus(owner ? 'Opening room…' : 'Connecting…', 'warn');

  p.on('open', () => {
    if (p !== peer) return;
    if (!owner) {
      if (!connected) connectToHost(); // otherwise just a PeerJS server reconnect
      return;
    }
    session.fresh = false;
    setStatus('Room open', 'ok');
  });
  p.on('connection', (c) => {
    if (p === peer && owner) wire(c);
  });
  // Lost the PeerJS server (not the other players). Existing connections keep working.
  p.on('disconnected', () => {
    setTimeout(() => {
      if (p === peer && !p.destroyed && p.disconnected) p.reconnect();
    }, 1000);
  });
  p.on('error', (err) => {
    if (p === peer) onPeerError(err);
  });
}

function onPeerError(err) {
  console.warn('PeerJS error:', err.type, err.message);
  switch (err.type) {
    case 'unavailable-id':
      if (session.fresh) {
        // Someone else is already using this code. Pick another.
        session.code = state.code = newCode();
        location.hash = session.code;
        save();
        openPeer();
      } else {
        // Usually our own previous connection that the server hasn't dropped yet.
        setStatus('Room code still in use (is it open in another tab?). Retrying…', 'bad');
        retry(openPeer);
      }
      break;
    case 'peer-unavailable':
      setStatus(`Can't find game ${session.code} — the host may be offline. Retrying…`, 'bad');
      retry(connectToHost);
      break;
    case 'disconnected':
      break; // handled by the 'disconnected' event
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      setStatus("Can't reach the PeerJS server (0.peerjs.com). Retrying…", 'bad');
      retry(openPeer);
      break;
    case 'browser-incompatible':
      endGame("This browser doesn't support WebRTC, which the game needs. Try Chrome, Edge, Firefox or Safari, and check WebRTC isn't turned off in privacy settings.");
      break;
    default:
      setStatus(`Connection problem (${err.type}). Retrying…`, 'bad');
      retry(openPeer);
  }
}

function connectToHost() {
  clearTimeout(retryTimer);
  if (!peer || peer.destroyed) return openPeer();
  if (peer.disconnected) return peer.reconnect(); // 'open' fires again and calls us back
  setStatus('Connecting to host…', 'warn');
  const c = peer.connect(PEER_PREFIX + session.code, { reliable: true });
  wire(c);
  retryTimer = setTimeout(() => {
    if (conn !== c) {
      c.close();
      setStatus("Can't reach the host. Retrying…", 'bad');
      connectToHost();
    }
  }, TIMEOUT_MS);
}

function wire(c) {
  c.on('open', () => {
    if (session.role !== 'client') return; // the owner waits for 'hello'
    clearTimeout(retryTimer);
    conn = c;
    lastHeard = Date.now();
    c.send({ t: 'hello', id: session.id, name: me.name });
  });
  c.on('data', (d) => onData(c, d));
  c.on('close', () => closed(c));
  c.on('error', () => closed(c));
}

function closed(c) {
  if (session?.role === 'owner') return dropLink(c);
  if (c === conn) lost();
}

function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

function onData(c, d) {
  if (!d || typeof d !== 'object') return;

  if (session.role === 'owner') {
    if (d.t === 'hello') return onHello(c, d);
    const id = c.memberId;
    if (!id || links.get(id) !== c) return;
    c.heard = Date.now();
    // Only the owner's own timer moves the game on after a reveal.
    if (d.t === 'act' && d.a?.type !== 'advance') ownerApply(id, d.a);
    if (d.t === 'bye') onBye(id);
    return;
  }

  if (c !== conn) return;
  lastHeard = Date.now();
  if (d.t === 'state') {
    state = d.state;
    connected = true;
    asking = false;
    save();
    setStatus('Connected', 'ok');
  }
  if (d.t === 'wait') {
    asking = true;
    setStatus('Waiting to be let in…', 'warn');
  }
  if (d.t === 'rejected') endGame("The host didn't let you in.");
  if (d.t === 'bye') endGame('The host closed the room.');
}

// ---- Owner: letting people in ---------------------------------------------

function onHello(c, d) {
  const id = String(d.id || '').slice(0, 64);
  if (!id) return;
  if (memberName(id) !== undefined) return admit(c, id); // coming back
  for (const p of pending) if (p.id === id && p.conn !== c) p.conn.close();
  pending = pending.filter((p) => p.id !== id);
  const name = cleanName(d.name, 'Player');
  pending.push({ conn: c, id, name });
  c.send({ t: 'wait' });
  toast(`${name} wants to join`);
  render();
}

function admit(c, id) {
  const old = links.get(id);
  links.set(id, c);
  c.memberId = id;
  c.heard = Date.now();
  if (old && old !== c) old.close();
  commit();
}

function letIn(id, asPlayer) {
  const p = pending.find((q) => q.id === id);
  if (!p) return;
  pending = pending.filter((q) => q !== p);
  const seat = asPlayer && SEATS.find((s) => !state.players[s]);
  if (seat) {
    state.players[seat] = { id, name: p.name };
    sysChat(`${p.name} joined as ${MARKS[seat]}`);
    if (state.phase === 'lobby' && state.players.x && state.players.o) newMatch(state);
  } else {
    state.watchers.push({ id, name: p.name });
    sysChat(`${p.name} is watching`);
  }
  admit(p.conn, id);
}

function turnAway(id) {
  const p = pending.find((q) => q.id === id);
  if (!p) return;
  pending = pending.filter((q) => q !== p);
  if (p.conn.open) p.conn.send({ t: 'rejected' });
  setTimeout(() => p.conn.close(), 500);
  render();
}

// Someone left for good: free their seat for someone else to take over.
function onBye(id) {
  const seat = seatOf(id), name = memberName(id);
  if (seat) state.players[seat] = null;
  else state.watchers = state.watchers.filter((w) => w.id !== id);
  const c = links.get(id);
  links.delete(id);
  if (c) setTimeout(() => c.close(), 300);
  sysChat(`${name} left`);
  commit();
}

function dropLink(c) {
  if (pending.some((p) => p.conn === c)) {
    pending = pending.filter((p) => p.conn !== c);
    return render();
  }
  if (c.memberId && links.get(c.memberId) === c) {
    links.delete(c.memberId);
    broadcast(); // so everyone sees they're offline
    render();
  }
}

// ---- Heartbeat: notice dead connections even when the browser doesn't tell us.

setInterval(() => {
  if (!session) return;
  markLive();
  const now = Date.now();
  if (session.role === 'owner') {
    // People still asking to come in only need to know we're here.
    for (const p of pending) if (p.conn.open) p.conn.send({ t: 'ping' });
    for (const c of [...links.values()]) {
      if (!c.open) continue;
      c.send({ t: 'ping' });
      if (now - c.heard > TIMEOUT_MS) {
        c.close();
        dropLink(c);
      }
    }
    return;
  }
  if (!conn || !conn.open) return;
  conn.send({ t: 'ping' });
  if (now - lastHeard > TIMEOUT_MS) lost();
}, HEARTBEAT_MS);

function lost() {
  const c = conn;
  conn = null;
  connected = false;
  if (c) c.close();
  setStatus('Lost connection. Reconnecting…', 'bad');
  retry(connectToHost);
}

function reconnect() {
  if (ended || !session) return;
  if (session.role === 'client') return openPeer();
  if (!peer || peer.destroyed || peer.disconnected) return openPeer();
  setStatus('Room open', 'ok');
}

window.addEventListener('online', () => { if (!connected) reconnect(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !connected && session?.role === 'client') reconnect();
});

// ---- Actions --------------------------------------------------------------

// Sends everyone let in their own view of the game.
function broadcast() {
  const online = onlineIds();
  for (const [id, c] of links) {
    if (!c.open) continue;
    const v = viewFor(state, seatOf(id));
    v.online = online;
    c.send({ t: 'state', state: v });
  }
}

function commit() {
  state.v++;
  save();
  broadcast();
  scheduleAdvance();
  render();
}

// Once a bonus game is revealed, the owner moves everyone on after the
// reveal has had time to play.
let advanceTimer = null, advanceFor = null;
function scheduleAdvance() {
  const d = state.phase === 'duel' && state.duel.result ? state.duel : null;
  const id = d ? d.id : null;
  if (id === advanceFor) return;
  clearTimeout(advanceTimer);
  advanceFor = id;
  if (d) {
    advanceTimer = setTimeout(() => {
      advanceFor = null;
      if (applyAction(state, null, { type: 'advance' })) commit();
    }, DUELS[d.type].revealMs);
  }
}

function ownerApply(id, a) {
  if (applyAction(state, seatOf(id), a, memberName(id))) commit();
}

function act(a) {
  if (session.role === 'owner') return ownerApply(session.id, a);
  if (!connected) return toast('Not connected. Try Reconnect.');
  send({ t: 'act', a });
}

// ---- Rendering ------------------------------------------------------------

let lastPanel = null, lastChatKey = null;

function nameOf(seat) {
  return esc(state.players[seat]?.name || `Player ${MARKS[seat]}`);
}
const you = (seat) => (seat === mySeat() ? 'You' : nameOf(seat));

function render() {
  if (!session) return;
  const owner = session.role === 'owner';

  const pill = $('status');
  if (ended) {
    pill.textContent = 'Game over';
    pill.className = 'pill bad';
  } else {
    pill.textContent = status.text;
    pill.className = 'pill ' + status.kind;
  }
  $('code-btn').textContent = session.code;
  $('reconnect-btn').hidden = !!ended || (owner ? status.kind !== 'bad' : connected || asking);
  $('requests').innerHTML = owner && !ended ? requestsHtml() : '';

  if (!state) {
    setPanel(ended ? endedHtml() : asking
      ? `<div class="lobby"><p class="big-msg">Asking to join game <b>${esc(session.code)}</b>…</p>
          <p class="hint">The host can see your name, <b>${esc(me.name)}</b>, and will let you in.</p></div>`
      : `<p class="big-msg">Joining game <b>${esc(session.code)}</b>…</p>`);
    $('scores').innerHTML = $('watchers').innerHTML = '';
    return;
  }

  const mine = mySeat(), online = onlineIds();
  $('scores').innerHTML = SEATS.map((s) => {
    const p = state.players[s];
    const active = state.phase === 'play' && state.turn === s;
    const note = !p ? ' <small>(empty seat)</small>' : s === mine ? ' <small>(you)</small>'
      : online.includes(p.id) ? '' : ' <small>(offline)</small>';
    return `<div class="player ${s} ${active ? 'active' : ''}">
      <span class="mark">${MARKS[s]}</span>
      <span class="pname">${nameOf(s)}${note}</span>
      <span class="score">${state.scores[s]}</span>
    </div>`;
  }).join(`<div class="round">Round ${state.round}</div>`);
  $('watchers').innerHTML = state.watchers.length
    ? `👀 Watching: ${state.watchers.map((w) => esc(w.name) + (w.id === session.id ? ' (you)' : '')).join(', ')}`
    : '';

  setPanel(ended ? endedHtml() : panelHtml());

  $('rules').innerHTML = state.rules.length
    ? state.rules.map((r) => `<li>${esc(r.text)} <small>— ${esc(r.name)}, round ${r.round}</small></li>`).join('')
    : '<li class="empty">No extra rules yet. Win a round to add one.</li>';

  const chatKey = state.chat.length + ':' + (state.chat.at(-1)?.text || '');
  if (chatKey !== lastChatKey) {
    lastChatKey = chatKey;
    const log = $('chat-log');
    log.innerHTML = state.chat.map((m) => m.sys
      ? `<p class="msg sys">${esc(m.text)}</p>`
      : `<p class="msg ${m.from || 'watcher'}"><b>${esc(m.name)}:</b> ${esc(m.text)}</p>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  const rb = $('rematch-btn');
  rb.hidden = state.phase === 'lobby' || !!ended || !mine;
  if (mine) {
    const opp = other(mine);
    rb.disabled = state.rematch[mine];
    rb.textContent = state.rematch[mine] ? 'Rematch requested…'
      : state.rematch[opp] ? `${state.players[opp]?.name || 'Opponent'} wants a rematch — accept`
      : 'Rematch';
    rb.classList.toggle('primary', !state.rematch[mine] && state.rematch[opp]);
  }
}

// The owner's list of people asking to come in.
function requestsHtml() {
  if (!state) return '';
  const free = SEATS.filter((s) => !state.players[s]);
  const asks = pending.map((p) => `<div class="request">
      <span class="rname"><b>${esc(p.name)}</b> wants to join</span>
      ${free.length ? `<button class="primary" data-letin="${esc(p.id)}" data-play>Let in to play</button>` : ''}
      <button data-letin="${esc(p.id)}">Let in to watch</button>
      <button class="ghost" data-turnaway="${esc(p.id)}">Reject</button>
    </div>`).join('');
  const empty = state.phase !== 'lobby' && free.length && !pending.length
    ? `<p class="hint seat-note">The ${free.map((s) => MARKS[s]).join(' and ')} seat is empty. Share the code and let someone in to take it over.</p>`
    : '';
  return asks + empty;
}

// Only touch the panel when it actually changes, so a half-typed rule survives
// incoming chat messages.
function setPanel(html) {
  if (html === lastPanel) return;
  lastPanel = html;
  $('panel').innerHTML = html;
}

function boardHtml(clickable, small) {
  return `<div class="board ${small ? 'small' : ''}">${state.board.map((cell, i) => {
    const win = state.winLine && state.winLine.includes(i) ? 'win' : '';
    const mark = cell ? `<span class="${cell}">${MARKS[cell]}</span>` : '';
    const can = clickable && !cell;
    return `<button class="cell ${win}" data-cell="${i}" ${can ? '' : 'disabled'}>${mark}</button>`;
  }).join('')}</div>`;
}

// Earlier bonus games this round. The one being revealed right now is left
// out so the list doesn't spoil it.
function duelHistoryHtml(skipCurrent) {
  if (!state.duel) return '';
  const past = state.duel.history.slice(0, skipCurrent && state.duel.result ? -1 : undefined);
  if (!past.length) return '';
  const n = { x: nameOf('x'), o: nameOf('o') };
  return `<ol class="duel-history">${past.map((e) => {
    const g = DUELS[e.type];
    if (!g) return '';
    if (e.forced) return `<li><span class="dname">${g.name}</span> Skipped with the test button. <b>Draw!</b></li>`;
    const result = e.winner ? `<b>${nameOf(e.winner)} wins!</b>` : '<b>Draw!</b>';
    return `<li><span class="dname">${g.name}</span> ${g.describe(e, n)} ${result}</li>`;
  }).join('')}</ol>`;
}

// ---- Bonus games on the board ----
// The board is replaced by an arena: the opponent's side on top, a status
// strip in the middle and your side at the bottom (someone watching sees O on
// top and X at the bottom, with everything showing). When a game is revealed,
// CSS animations play the countdown and reveal (see .early / .late in
// style.css), so nothing here needs a timer.

let mlDraft = { id: null, words: [] }; // your Mad Libs words before you submit them

function duelHtml() {
  const mine = mySeat(), spec = !mine;
  const me = mine || 'x', opp = other(me);
  const d = viewFor(state, mine).duel, g = DUELS[d.type];
  const first = d.history.length === (d.result ? 1 : 0);
  const sides = ARENAS[d.type](d, me, opp, spec);
  const test = d.result ? ''
    : '<button class="ghost test-btn" data-forcedraw title="Testing: call this bonus game a draw">Draw this bonus game (test)</button>';
  return `<h2>${first ? "It's a draw!" : 'Still a draw!'} Bonus game: ${g.name}</h2>
    <p class="hint">${g.prompt}</p>
    <div class="arena arena-${d.type}" style="--d: ${g.countdown ? 1.5 : 0}s">
      <div class="side ${opp}"><span class="who">${nameOf(opp)}</span>${sides.opp}</div>
      <div class="centre">${centreHtml(d, me, opp, g, spec)}</div>
      <div class="side ${me}"><span class="who">${spec ? nameOf(me) : 'You'}</span>${sides.me}</div>
    </div>
    ${test}
    ${duelHistoryHtml(true)}`;
}

function centreHtml(d, me, opp, g, spec) {
  if (!d.result) {
    const writing = d.type === 'madlibs' && !d.data.pairs;
    const progress = (s) => {
      const done = writing ? d.data.fills[s] !== null : d.picks[s] !== null;
      return done
        ? `<span class="ready">✔ ${nameOf(s)} has ${writing ? 'finished their sentence' : 'chosen'}</span>`
        : `<span class="waiting">${nameOf(s)} is ${writing ? 'writing' : 'choosing'}<span class="dots"></span></span>`;
    };
    return spec ? progress(opp) + progress(me) : progress(opp);
  }
  const w = d.result.winner;
  const text = w && w === mySeat() ? '<b class="you-win">You win! 🎉</b>'
    : w ? `<b class="they-win">${nameOf(w)} wins</b>`
    : `<b class="draw-text">🤝 Draw!</b><span class="draw-why">${drawWhy(d)}</span>
       <span class="hint">Nobody wins this one — another bonus game is coming…</span>`;
  const count = g.countdown
    ? '<div class="count early"><span>3</span><span>2</span><span>1</span></div>'
    : '';
  return `<div class="stack">${count}<div class="${d.type === 'coin' ? 'later' : 'late'} ${w ? '' : 'draw-box'}">${text}</div></div>`;
}

function drawWhy(d) {
  const both = mySeat() ? 'You both' : 'They both';
  if (d.type === 'rps') return `${both} threw ${RPS_EMOJI[d.picks.x]}`;
  return `${both} were ${d.result.info.right.x ? 'right' : 'wrong'}`;
}

// Shows `before` until the reveal, then swaps in `after`.
const reveal = (before, after) =>
  `<div class="stack"><div class="early">${before}</div><div class="late">${after}</div></div>`;

const yesNo = (ok) => (ok ? '<span class="right">✔ right</span>' : '<span class="wrong">✘ wrong</span>');

// Each returns the html for both sides of the arena: `me` is the bottom seat
// (yours, or X for someone watching) and `opp` the top. `spec` means the
// viewer is watching: no buttons, and nothing hidden.
const ARENAS = {
  rps(d, me, opp, spec) {
    const big = (p) => `<span class="big">${RPS_EMOJI[p]}</span><span class="hint">${p}</span>`;
    const hidden = '<span class="big">❔</span>';
    const shown = (s) => (d.picks[s] === null ? hidden : big(d.picks[s]));
    if (spec) return { me: shown(me), opp: shown(opp) };
    const mine = d.picks[me] === null
      ? `<div class="choices">${DUELS.rps.options.map((o) =>
          `<button class="emoji-btn" data-pick="${o}" title="${o}">${RPS_EMOJI[o]}</button>`).join('')}</div>`
      : big(d.picks[me]);
    return { me: mine, opp: d.result ? reveal(hidden, big(d.picks[opp])) : hidden };
  },

  coin(d, me, opp, spec) {
    const blank = '<div class="coin"><span class="face">?</span></div>';
    const coin = (s) => `<div class="coin flip-${d.result.info.flips[s]}">
      <span class="face heads">H</span><span class="face tails">T</span></div>`;
    const called = (s) => {
      const call = d.picks[s], flip = d.result && d.result.info.flips[s];
      const after = d.result ? `<span class="later"> — landed ${flip}, ${yesNo(call === flip)}</span>` : '';
      return `<span class="hint">${you(s)} called <b>${call}</b>${after}</span>`;
    };
    const shown = (s) => (d.picks[s] === null ? blank
      : `${d.result ? reveal(blank, coin(s)) : blank}${called(s)}`);
    if (spec) return { me: shown(me), opp: shown(opp) };
    const mine = d.picks[me] === null
      ? `${blank}<div class="choices">
          <button class="primary" data-pick="heads">Heads</button>
          <button class="primary" data-pick="tails">Tails</button></div>`
      : shown(me);
    const theirs = d.result ? `${reveal(blank, coin(opp))}<span class="late">${called(opp)}</span>` : blank;
    return { me: mine, opp: theirs };
  },

  cards(d, me, opp, spec) {
    const hands = d.data.hands; // cards you can't see yet are null
    // owner's hand, which grabber picks from
    const row = (owner, grabber) => `<div class="cardrow">${[0, 1, 2].map((i) => {
      const grabbed = d.picks[grabber] === String(i);
      const tag = grabbed ? `<span class="grab-tag">${grabber === mySeat() ? 'you' : nameOf(grabber)}</span>` : '';
      const canGrab = !spec && owner === opp && d.picks[me] === null;
      return `<button class="pcard ${hands[owner][i] || 'back'} ${grabbed ? 'grabbed' : ''}"
        ${canGrab ? `data-pick="${i}"` : 'disabled'}>${tag}</button>`;
    }).join('')}</div>`;
    // What's going on with the grab from owner's hand.
    const caption = (owner) => {
      const g = other(owner), pick = d.picks[g];
      const got = pick !== null && pick !== 'hidden' ? hands[owner][+pick] : null;
      if (got) return `<span class="hint">${you(g)} grabbed ${got} ${yesNo(got === CARD_COLOURS[g])}</span>`;
      const target = `the <b class="${g}">${CARD_COLOURS[g]}</b> card`;
      if (g === mySeat()) return `<span class="hint">Grab ${target} from ${nameOf(owner)}’s hand</span>`;
      if (owner === mySeat()) return `<span class="hint">Your hand — ${nameOf(g)} is after ${target}</span>`;
      return `<span class="hint">${nameOf(g)} is after ${target}</span>`;
    };
    return { opp: row(opp, me) + caption(opp), me: row(me, opp) + caption(me) };
  },

  dice(d, me, opp, spec) {
    const rolls = d.data.rolls;
    // Only roll the dice when they first appear, not on every redraw.
    const fresh = d.picks.x === null && d.picks.o === null;
    const die = (n, rolling) => `<span class="die ${rolling ? 'rolling' : ''}">${DICE_FACES[n - 1]}</span>`;
    const right = (s) => (d.picks[s] === 'higher' ? rolls[s] > rolls[other(s)] : rolls[s] < rolls[other(s)]);
    const said = (s) => (d.picks[s] === null ? ''
      : ` and said <b>${d.picks[s]}</b> ${d.result ? yesNo(right(s)) : ''}`);
    const shown = (s, rolling) => `${die(rolls[s], rolling)}<span class="hint">${you(s)} rolled ${rolls[s]}${said(s)}</span>`;
    if (spec) return { me: shown(me, fresh), opp: shown(opp, fresh) };
    let mine = `${die(rolls[me], fresh)}<span class="hint">You rolled ${rolls[me]}</span>`;
    mine += d.picks[me] === null
      ? `<div class="choices">
          <button class="primary" data-pick="higher">⬆ Higher</button>
          <button class="primary" data-pick="lower">⬇ Lower</button></div>`
      : `<span class="hint">You said <b>${d.picks[me]}</b> ${d.result ? yesNo(right(me)) : ''}</span>`;
    return { me: mine, opp: d.result ? shown(opp, true) : '<span class="die hidden-die">?</span>' };
  },

  madlibs(d, me, opp, spec) {
    const lib = d.data.lib, fills = d.data.fills, pairs = d.data.pairs, ml = DUELS.madlibs;
    const text = (words) => esc(madlibText(lib, words.map((w) => w || '_____')));
    const whose = (s) => (s === mySeat() ? 'your' : `${nameOf(s)}’s`);
    const verdict = (s) => `<span class="hint">${you(s)} ${ml.found(d, s) ? 'found' : 'missed'}
      ${whose(other(s))} sentence ${yesNo(ml.found(d, s))}</span>`;
    // The two sentences seat s chooses between; tagged once it's known which is which.
    const choice = (s, clickable) => pairs[s].map((p, i) => {
      if (clickable) return `<button class="sentence-btn" data-pick="${i}">${text(p.words)}</button>`;
      const tag = p.comp !== undefined ? `<span class="tag">${p.comp ? '🤖 Computer' : `✍ ${you(other(s))}`}</span>` : '';
      return `<div class="sentence-btn ${d.picks[s] === String(i) ? 'chosen' : ''}">${tag}${text(p.words)}</div>`;
    }).join('');

    if (spec) {
      const shown = (s) => {
        if (fills[s] === null) return '<span class="big">✍️</span>';
        if (!pairs) return `<p class="sentence">${text(fills[s])}</p>`;
        return `<b>Which one did ${nameOf(other(s))} write?</b>${choice(s, false)}${d.result ? verdict(s) : ''}`;
      };
      return { me: shown(me), opp: shown(opp) };
    }

    let mine;
    if (fills[me] === null) {
      if (mlDraft.id !== d.id) mlDraft = { id: d.id, words: lib.words.map(() => null) };
      const rows = lib.words.map((ws, i) => `<div class="choices words">${ws.map((w) =>
        `<button class="${mlDraft.words[i] === w ? 'chosen' : ''}" data-word="${i}" data-w="${esc(w)}">${esc(w)}</button>`
      ).join('')}</div>`).join('');
      mine = `<p class="sentence">${text(mlDraft.words)}</p>${rows}
        <button class="primary" data-mlsubmit ${mlDraft.words.every(Boolean) ? '' : 'disabled'}>Submit sentence</button>`;
    } else if (!pairs) {
      mine = `<p class="sentence">${text(fills[me])}</p><span class="hint">Sent. Waiting for ${nameOf(opp)}…</span>`;
    } else {
      mine = `<b>Which one did ${nameOf(opp)} write?</b>${choice(me, d.picks[me] === null)}`;
      if (d.result) mine += verdict(me);
    }
    return { me: mine, opp: d.result ? verdict(opp) : '<span class="big">✍️</span>' };
  },
};

function panelHtml() {
  const mine = mySeat();
  const owner = session.role === 'owner';

  if (state.phase === 'lobby') {
    const seated = SEATS.filter((s) => state.players[s]).length;
    if (!owner) {
      return `<div class="lobby"><p class="big-msg">You're in!</p>
        <p>Waiting for ${2 - seated} more player${seated === 1 ? '' : 's'}…</p></div>`;
    }
    return `<div class="lobby">
      <p>Send this code to the ${mine ? 'other player' : 'players'}:</p>
      <p class="code-big">${esc(session.code)}</p>
      <button data-copy>Copy invite link</button>
      <p class="hint">They open this site and type the code in. You'll see their name and
        can let them in or turn them away. The game starts once both seats are filled (${seated}/2).</p>
    </div>`;
  }

  if (state.phase === 'play') {
    const myTurn = state.turn === mine;
    const fresh = state.board.every((c) => !c);
    const flip = fresh
      ? `<p class="flip">🪙 Coin flip: <b>${you(state.first)}</b> ${state.first === mine ? 'go' : 'goes'} first.</p>`
      : '';
    const turn = myTurn ? `Your turn — you're <b>${MARKS[mine]}</b>.`
      : !state.players[state.turn] ? `Waiting for someone to take the ${MARKS[state.turn]} seat…`
      : `Waiting for ${nameOf(state.turn)} (${MARKS[state.turn]})…`;
    return `${flip}<p class="turn ${myTurn ? 'mine' : ''}">${turn}</p>${boardHtml(myTurn, false)}
      <button class="ghost test-btn" data-quickdraw title="Testing: skip to a drawn board">Quick draw (test)</button>`;
  }

  if (state.phase === 'duel') return duelHtml();

  if (state.phase === 'rule') {
    const w = state.roundWinner;
    const head = w === mine ? `You win round ${state.round}!` : `${nameOf(w)} wins round ${state.round}.`;
    const how = state.winHow === 'line' ? 'Three in a row.' : 'Decided by bonus game.';
    const form = w === mine
      ? `<form id="rule-form">
          <label for="rule-text">Add a rule for the rest of the match:</label>
          <textarea id="rule-text" maxlength="200" rows="3" placeholder="e.g. The centre square is off limits"></textarea>
          <div class="row">
            <button class="primary">Add rule &amp; next round</button>
            <button type="button" data-skip>Skip</button>
          </div>
          <p class="hint">Rules are on the honour system for now — the game doesn't enforce them yet.</p>
        </form>`
      : `<p>Waiting for ${nameOf(w)} to add a rule…</p>`;
    return `<h2>${head}</h2><p>${how}</p>${boardHtml(false, true)}${duelHistoryHtml(false)}${form}`;
  }
  return '';
}

function endedHtml() {
  return `<div class="lobby"><p class="big-msg">${esc(ended)}</p><button class="primary" data-home>Back to start</button></div>`;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

// When the game is shown inside the Neocities page's frame, invite people to
// that page rather than to the frame's own address.
const FRAMED_HOME = 'https://mythonics.neocities.org/Games/SuperOX/';

function copyInvite() {
  const base = window.top !== window.self ? FRAMED_HOME : location.origin + location.pathname;
  const link = `${base}#${session.code}`;
  if (!navigator.clipboard) return toast(`Code: ${session.code}`);
  navigator.clipboard.writeText(link).then(
    () => toast('Invite link copied'),
    () => toast(`Code: ${session.code}`),
  );
}

// ---- Home screen and events -----------------------------------------------

function showHome() {
  $('game').hidden = true;
  $('home').hidden = false;
  $('name').value = me.name;
  const saved = loadSave();
  $('resume').hidden = !saved;
  if (saved) $('resume-code').textContent = saved.code;
  const hashCode = location.hash.slice(1).toUpperCase();
  if (hashCode && (!saved || saved.code !== hashCode)) $('join-code').value = hashCode;
}

$('host-play-btn').onclick = () => hostNewGame(false);
$('host-watch-btn').onclick = () => hostNewGame(true);
$('join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Codes are 4 characters long.');
  joinGame(code);
};
$('resume-btn').onclick = () => resumeGame(loadSave());
$('discard-btn').onclick = () => {
  if (!confirm('Forget this game?')) return;
  deleteSave(loadSave());
  showHome();
};
$('code-btn').onclick = copyInvite;
$('reconnect-btn').onclick = reconnect;
$('leave-btn').onclick = leaveGame;
$('rematch-btn').onclick = () => {
  const opp = other(mySeat());
  if (!state.rematch[opp] && !confirm('Ask for a rematch? Scores and rules reset if your opponent agrees.')) return;
  act({ type: 'rematch' });
};
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $('chat-input');
  if (!input.value.trim() || !state) return;
  act({ type: 'chat', text: input.value });
  input.value = '';
};

$('requests').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.letin !== undefined) letIn(b.dataset.letin, b.dataset.play !== undefined);
  else if (b.dataset.turnaway !== undefined) turnAway(b.dataset.turnaway);
});

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cell !== undefined) act({ type: 'move', cell: +b.dataset.cell });
  else if (b.dataset.pick !== undefined) act({ type: 'pick', value: b.dataset.pick });
  else if (b.dataset.word !== undefined) {
    mlDraft.words[+b.dataset.word] = b.dataset.w;
    render();
  } else if (b.dataset.mlsubmit !== undefined) act({ type: 'pick', value: mlDraft.words.slice() });
  else if (b.dataset.skip !== undefined) act({ type: 'rule', text: '' });
  else if (b.dataset.quickdraw !== undefined) act({ type: 'quickdraw' });
  else if (b.dataset.forcedraw !== undefined) act({ type: 'forcedraw' });
  else if (b.dataset.copy !== undefined) copyInvite();
  else if (b.dataset.home !== undefined) leaveGame();
});
$('panel').addEventListener('submit', (e) => {
  if (e.target.id !== 'rule-form') return;
  e.preventDefault();
  act({ type: 'rule', text: $('rule-text').value });
});

// Pick up where we left off if this page was reloaded mid-game.
const saved = loadSave();
const hashCode = location.hash.slice(1).toUpperCase();
if (saved && saved.code === hashCode) resumeGame(saved);
else showHome();
