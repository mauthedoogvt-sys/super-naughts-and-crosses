// Networking (PeerJS) and the page. The host's browser registers the peer ID
// PEER_PREFIX + code on PeerJS's free public server; the guest connects to it.
// Both save the game to localStorage after every change so either can reload
// and reconnect.

const PEER_PREFIX = 'supernac-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SAVE_KEY = 'snc-save', ID_KEY = 'snc-id', NAME_KEY = 'snc-name';
const HEARTBEAT_MS = 3000, TIMEOUT_MS = 15000, RETRY_MS = 3000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const me = { id: store.get(ID_KEY), name: store.get(NAME_KEY) || '' };
if (!me.id) {
  me.id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  store.set(ID_KEY, me.id);
}

let session = null; // { code, role, fresh }
let state = null;   // host: the real game; guest: the host's latest copy
let peer = null, conn = null;
let connected = false, lastHeard = 0, retryTimer = null;
let status = { text: '', kind: 'warn' };
let ended = null;   // message shown once the game can't continue

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function newCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[randInt(CODE_CHARS.length)];
  return c;
}

function save() {
  store.set(SAVE_KEY, { code: session.code, role: session.role, state });
}

// ---- Starting and leaving -------------------------------------------------

function readName(fallback) {
  me.name = $('name').value.trim().slice(0, 20) || fallback;
  store.set(NAME_KEY, me.name);
}

function hostNewGame() {
  readName('Player 1');
  const code = newCode();
  session = { code, role: 'host', fresh: true };
  state = createGame(code, { id: me.id, name: me.name });
  start();
}

function joinGame(code) {
  readName('Player 2');
  session = { code, role: 'guest' };
  state = null;
  start();
}

function resumeGame(saved) {
  session = { code: saved.code, role: saved.role };
  state = saved.state;
  start();
}

function start() {
  ended = null;
  save();
  location.hash = session.code;
  $('home').hidden = true;
  $('game').hidden = false;
  lastChatKey = lastPanel = null;
  openPeer();
  render();
}

function leaveGame() {
  if (!ended && !confirm("Leave this game? You won't be able to come back to it.")) return;
  send({ t: 'bye' });
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
  store.del(SAVE_KEY);
  connected = false;
  conn = null;
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
  const host = session.role === 'host';
  if (typeof Peer === 'undefined') {
    // Keep the save so a reload can pick the game back up.
    ended = "The networking library didn't load, so online play can't start. Reload the page to try again.";
    return render();
  }
  // The guest picks its own ID too, so it never has to ask the server for one
  // (that request is what fails with 'server-error' when the server is flaky).
  const id = PEER_PREFIX + session.code + (host ? '' : '-' + newCode() + newCode());
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
  setStatus(host ? 'Opening game…' : 'Connecting…', 'warn');

  p.on('open', () => {
    if (p !== peer) return;
    if (connected) return; // just a PeerJS server reconnect; the game link is fine
    if (!host) return connectToHost();
    setStatus(state.players.guest ? 'Waiting for opponent to reconnect…' : 'Waiting for opponent…', 'warn');
  });
  p.on('connection', (c) => {
    if (p === peer && host) wire(c);
  });
  // Lost the PeerJS server (not the opponent). Existing connections keep working.
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
        setStatus('Game code still in use (is it open in another tab?). Retrying…', 'bad');
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
    if (session.role !== 'guest') return; // the host waits for 'hello'
    clearTimeout(retryTimer);
    conn = c;
    lastHeard = Date.now();
    c.send({ t: 'hello', id: me.id, name: me.name });
  });
  c.on('data', (d) => onData(c, d));
  c.on('close', () => { if (c === conn) lost(); });
  c.on('error', () => { if (c === conn) lost(); });
}

function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

function onData(c, d) {
  if (!d || typeof d !== 'object') return;
  if (c === conn) lastHeard = Date.now();

  if (session.role === 'host') {
    if (d.t === 'hello') return onHello(c, d);
    if (c !== conn) return;
    if (d.t === 'act') hostApply('guest', d.a);
    if (d.t === 'bye') endGame('Your opponent left the game.');
    return;
  }

  if (c !== conn) return;
  if (d.t === 'state') {
    state = d.state;
    connected = true;
    save();
    setStatus('Connected', 'ok');
  }
  if (d.t === 'full') endGame('That game already has two players.');
  if (d.t === 'bye') endGame('The host ended the game.');
}

function onHello(c, d) {
  const guest = state.players.guest;
  if (guest && guest.id !== d.id) {
    c.send({ t: 'full' });
    setTimeout(() => c.close(), 500);
    return;
  }
  const old = conn;
  conn = c;
  if (old && old !== c) old.close();
  connected = true;
  lastHeard = Date.now();
  session.fresh = false;
  state.players.guest = { id: d.id, name: String(d.name || '').slice(0, 20) || 'Player 2' };
  if (state.phase === 'lobby') newMatch(state);
  status = { text: 'Connected', kind: 'ok' };
  commit();
}

function lost() {
  const c = conn;
  conn = null;
  connected = false;
  if (c) c.close();
  if (session.role === 'guest') {
    setStatus('Lost connection. Reconnecting…', 'bad');
    retry(connectToHost);
  } else {
    setStatus('Opponent disconnected. Waiting for them to reconnect…', 'bad');
  }
}

function reconnect() {
  if (ended || !session) return;
  if (session.role === 'guest') return openPeer();
  if (!peer || peer.destroyed || peer.disconnected) return openPeer();
  setStatus('Your game is open. Waiting for your opponent to reconnect…', 'warn');
}

// Heartbeat: notice a dead connection even when the browser doesn't tell us.
setInterval(() => {
  if (!conn || !conn.open) return;
  conn.send({ t: 'ping' });
  if (connected && Date.now() - lastHeard > TIMEOUT_MS) lost();
}, HEARTBEAT_MS);

window.addEventListener('online', () => { if (!connected) reconnect(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !connected && session?.role === 'guest') reconnect();
});

// ---- Actions --------------------------------------------------------------

function commit() {
  state.v++;
  save();
  send({ t: 'state', state: viewFor(state, 'guest') });
  render();
}

function hostApply(role, a) {
  if (applyAction(state, role, a)) commit();
}

function act(a) {
  if (session.role === 'host') return hostApply('host', a);
  if (!connected) return toast('Not connected. Try Reconnect.');
  send({ t: 'act', a });
}

// ---- Rendering ------------------------------------------------------------

let lastPanel = null, lastChatKey = null;

function nameOf(role) {
  const p = state.players[role];
  return esc((p && p.name) || (role === 'host' ? 'Player 1' : 'Player 2'));
}

function render() {
  if (!session) return;
  const mine = session.role;

  const pill = $('status');
  if (ended) {
    pill.textContent = 'Game over';
    pill.className = 'pill bad';
  } else {
    pill.textContent = status.text;
    pill.className = 'pill ' + status.kind;
  }
  $('code-btn').textContent = session.code;
  $('reconnect-btn').hidden = !!ended || connected || (mine === 'host' && !state.players.guest);

  if (!state) {
    setPanel(ended ? endedHtml() : `<p class="big-msg">Joining game <b>${esc(session.code)}</b>…</p>`);
    $('scores').innerHTML = '';
    return;
  }

  $('scores').innerHTML = ['host', 'guest'].map((r) => {
    const active = state.phase === 'play' && state.turn === r;
    return `<div class="player ${r} ${active ? 'active' : ''}">
      <span class="mark">${MARKS[r]}</span>
      <span class="pname">${nameOf(r)}${r === mine ? ' <small>(you)</small>' : ''}</span>
      <span class="score">${state.scores[r]}</span>
    </div>`;
  }).join(`<div class="round">Round ${state.round}</div>`);

  setPanel(ended ? endedHtml() : panelHtml());

  $('rules').innerHTML = state.rules.length
    ? state.rules.map((r) => `<li>${esc(r.text)} <small>— ${nameOf(r.by)}, round ${r.round}</small></li>`).join('')
    : '<li class="empty">No extra rules yet. Win a round to add one.</li>';

  const chatKey = state.chat.length + ':' + (state.chat.at(-1)?.text || '');
  if (chatKey !== lastChatKey) {
    lastChatKey = chatKey;
    const log = $('chat-log');
    log.innerHTML = state.chat.map((m) =>
      `<p class="msg ${m.from}"><b>${nameOf(m.from)}:</b> ${esc(m.text)}</p>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  const rb = $('rematch-btn');
  rb.hidden = state.phase === 'lobby' || !!ended;
  rb.disabled = state.rematch[mine];
  rb.textContent = state.rematch[mine] ? 'Rematch requested…'
    : state.rematch[other(mine)] ? `${state.players[other(mine)]?.name || 'Opponent'} wants a rematch — accept`
    : 'Rematch';
  rb.classList.toggle('primary', !state.rematch[mine] && state.rematch[other(mine)]);
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

function duelHistoryHtml() {
  if (!state.duel || !state.duel.history.length) return '';
  const n = { host: nameOf('host'), guest: nameOf('guest') };
  return `<ol class="duel-history">${state.duel.history.map((e) => {
    const g = DUELS[e.type];
    const result = e.winner ? `<b>${nameOf(e.winner)} wins!</b>` : '<b>Tie!</b>';
    return `<li><span class="dname">${g.name}</span> ${g.describe(e, n)} ${result}</li>`;
  }).join('')}</ol>`;
}

function panelHtml() {
  const mine = session.role, opp = other(mine);
  const you = (r) => (r === mine ? 'You' : nameOf(r));

  if (state.phase === 'lobby') {
    return `<div class="lobby">
      <p>Send this code to your opponent:</p>
      <p class="code-big">${esc(session.code)}</p>
      <button data-copy>Copy invite link</button>
      <p class="hint">They open this site and type the code in. The game starts as soon as they join.</p>
    </div>`;
  }

  if (state.phase === 'play') {
    const myTurn = state.turn === mine;
    const fresh = state.board.every((c) => !c);
    const flip = fresh
      ? `<p class="flip">🪙 Coin flip: <b>${you(state.first)}</b> ${state.first === mine ? 'go' : 'goes'} first.</p>`
      : '';
    const turn = myTurn
      ? `Your turn — you're <b>${MARKS[mine]}</b>.`
      : `Waiting for ${nameOf(opp)} (${MARKS[opp]})…`;
    return `${flip}<p class="turn ${myTurn ? 'mine' : ''}">${turn}</p>${boardHtml(myTurn, false)}`;
  }

  if (state.phase === 'duel') {
    const d = state.duel, g = DUELS[d.type];
    const myPick = d.picks[mine], oppPicked = d.picks[opp] !== null;
    const choices = myPick === null
      ? `<div class="choices">${g.options.map((o) =>
          `<button class="primary" data-pick="${esc(o)}">${esc(g.labels[o] || o)}</button>`).join('')}</div>`
      : `<p>You picked <b>${esc(g.labels[myPick] || myPick)}</b>.</p>`;
    return `${boardHtml(false, true)}
      <h2>${d.history.length ? 'Still tied!' : "It's a draw!"} Tiebreaker ${d.history.length + 1}: ${g.name}</h2>
      ${duelHistoryHtml()}
      <p>${g.prompt}</p>
      ${choices}
      <p class="hint">${oppPicked ? `${nameOf(opp)} has made their choice.` : `${nameOf(opp)} is choosing…`}</p>`;
  }

  if (state.phase === 'rule') {
    const w = state.roundWinner;
    const head = w === mine ? `You win round ${state.round}!` : `${nameOf(w)} wins round ${state.round}.`;
    const how = state.winHow === 'line' ? 'Three in a row.' : 'Decided by tiebreaker.';
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
    return `<h2>${head}</h2><p>${how}</p>${boardHtml(false, true)}${duelHistoryHtml()}${form}`;
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
  const saved = store.get(SAVE_KEY);
  $('resume').hidden = !saved;
  if (saved) $('resume-code').textContent = saved.code;
  const hashCode = location.hash.slice(1).toUpperCase();
  if (hashCode && (!saved || saved.code !== hashCode)) $('join-code').value = hashCode;
}

$('host-btn').onclick = hostNewGame;
$('join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Codes are 4 characters long.');
  joinGame(code);
};
$('resume-btn').onclick = () => resumeGame(store.get(SAVE_KEY));
$('discard-btn').onclick = () => {
  if (!confirm('Forget this game?')) return;
  store.del(SAVE_KEY);
  showHome();
};
$('code-btn').onclick = copyInvite;
$('reconnect-btn').onclick = reconnect;
$('leave-btn').onclick = leaveGame;
$('rematch-btn').onclick = () => {
  const opp = other(session.role);
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

$('panel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cell !== undefined) act({ type: 'move', cell: +b.dataset.cell });
  else if (b.dataset.pick !== undefined) act({ type: 'pick', value: b.dataset.pick });
  else if (b.dataset.skip !== undefined) act({ type: 'rule', text: '' });
  else if (b.dataset.copy !== undefined) copyInvite();
  else if (b.dataset.home !== undefined) leaveGame();
});
$('panel').addEventListener('submit', (e) => {
  if (e.target.id !== 'rule-form') return;
  e.preventDefault();
  act({ type: 'rule', text: $('rule-text').value });
});

// Pick up where we left off if this page was reloaded mid-game.
const saved = store.get(SAVE_KEY);
const hashCode = location.hash.slice(1).toUpperCase();
if (saved && saved.code === hashCode) resumeGame(saved);
else showHome();
