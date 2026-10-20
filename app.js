// Networking (PeerJS) and the page. The host's browser registers the peer ID
// PEER_PREFIX + code on PeerJS's free public server; the guest connects to it.
// Both save the game after every change so either can reload and reconnect:
// to sessionStorage, so a reloaded tab gets back its own game even when the
// other player is in another tab of the same browser, and to localStorage
// (one slot per role) so the game can be resumed after closing the tab.

const PEER_PREFIX = 'supernac-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SAVE_KEY = 'snc-save', ID_KEY = 'snc-id', NAME_KEY = 'snc-name';
const HEARTBEAT_MS = 3000, TIMEOUT_MS = 15000, RETRY_MS = 3000;

function makeStore(area) {
  return {
    get(k) { try { return JSON.parse(window[area].getItem(k)); } catch { return null; } },
    set(k, v) { try { window[area].setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { window[area].removeItem(k); } catch {} },
  };
}
const store = makeStore('localStorage'), tabStore = makeStore('sessionStorage');

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
  const data = { code: session.code, role: session.role, state };
  tabStore.set(SAVE_KEY, data);
  store.set(`${SAVE_KEY}-${session.role}`, data);
}

// This tab's own game if it has one, otherwise the most likely game to resume
// (the host's copy is the real one). 'snc-save' in localStorage is where
// older versions kept it.
function loadSave() {
  return tabStore.get(SAVE_KEY) || store.get(`${SAVE_KEY}-host`) ||
    store.get(`${SAVE_KEY}-guest`) || store.get(SAVE_KEY);
}

function deleteSave(saved) {
  tabStore.del(SAVE_KEY);
  for (const k of [`${SAVE_KEY}-${saved.role}`, SAVE_KEY]) {
    if (store.get(k)?.code === saved.code) store.del(k);
  }
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
  // Saved mid-tiebreaker by an older version of the game: start the bonus games afresh.
  if (session.role === 'host' && state.phase === 'duel' && !state.duel.queue) startDuel(state);
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
  if (session.role === 'host') scheduleAdvance();
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
  clearTimeout(advanceTimer);
  advanceFor = null;
  deleteSave(session);
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
  scheduleAdvance();
  render();
}

// Once a bonus game is revealed, the host moves both players on after the
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
      hostApply('host', { type: 'advance' });
    }, DUELS[d.type].revealMs);
  }
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

// Earlier bonus games this round. The one being revealed right now is left
// out so the list doesn't spoil it.
function duelHistoryHtml(skipCurrent) {
  if (!state.duel) return '';
  const past = state.duel.history.slice(0, skipCurrent && state.duel.result ? -1 : undefined);
  if (!past.length) return '';
  const n = { host: nameOf('host'), guest: nameOf('guest') };
  return `<ol class="duel-history">${past.map((e) => {
    const g = DUELS[e.type];
    if (!g) return '';
    const result = e.winner ? `<b>${nameOf(e.winner)} wins!</b>` : '<b>Draw!</b>';
    return `<li><span class="dname">${g.name}</span> ${g.describe(e, n)} ${result}</li>`;
  }).join('')}</ol>`;
}

// ---- Bonus games on the board ----
// The board is replaced by an arena: the opponent's side on top, a status
// strip in the middle and your side at the bottom. When a game is revealed,
// CSS animations play the countdown and reveal (see .early / .late in
// style.css), so nothing here needs a timer.

let mlDraft = { id: null, words: [] }; // your Mad Libs words before you submit them

function duelHtml() {
  const mine = session.role, opp = other(mine);
  const d = viewFor(state, mine).duel, g = DUELS[d.type];
  const first = d.history.length === (d.result ? 1 : 0);
  const sides = ARENAS[d.type](d, mine, opp);
  return `<h2>${first ? "It's a draw!" : 'Still a draw!'} Bonus game: ${g.name}</h2>
    <p class="hint">${g.prompt}</p>
    <div class="arena arena-${d.type}" style="--d: ${g.countdown ? 3 : 0}s">
      <div class="side ${opp}"><span class="who">${nameOf(opp)}</span>${sides.opp}</div>
      <div class="centre">${centreHtml(d, mine, opp, g)}</div>
      <div class="side ${mine}"><span class="who">You</span>${sides.me}</div>
    </div>
    ${duelHistoryHtml(true)}`;
}

function centreHtml(d, mine, opp, g) {
  if (!d.result) {
    const writing = d.type === 'madlibs' && !d.data.pairs;
    const done = writing ? d.data.fills[opp] !== null : d.picks[opp] !== null;
    return done
      ? `<span class="ready">✔ ${nameOf(opp)} has ${writing ? 'finished their sentence' : 'chosen'}</span>`
      : `<span class="waiting">${nameOf(opp)} is ${writing ? 'writing' : 'choosing'}<span class="dots"></span></span>`;
  }
  const w = d.result.winner;
  const text = w === mine ? '<b class="you-win">You win! 🎉</b>'
    : w ? `<b class="they-win">${nameOf(w)} wins</b>`
    : `<b class="draw-text">🤝 Draw!</b><span class="draw-why">${drawWhy(d)}</span>
       <span class="hint">Nobody wins this one — another bonus game is coming…</span>`;
  const count = g.countdown
    ? '<div class="count early"><span>3</span><span>2</span><span>1</span></div>'
    : '';
  return `<div class="stack">${count}<div class="${d.type === 'coin' ? 'later' : 'late'} ${w ? '' : 'draw-box'}">${text}</div></div>`;
}

function drawWhy(d) {
  if (d.type === 'rps') return `You both threw ${RPS_EMOJI[d.picks.host]}`;
  return d.result.info.right.host ? 'You were both right' : 'You were both wrong';
}

// Shows `before` until the reveal, then swaps in `after`.
const reveal = (before, after) =>
  `<div class="stack"><div class="early">${before}</div><div class="late">${after}</div></div>`;

const yesNo = (ok) => (ok ? '<span class="right">✔ right</span>' : '<span class="wrong">✘ wrong</span>');

const ARENAS = {
  rps(d, mine, opp) {
    const big = (p) => `<span class="big">${RPS_EMOJI[p]}</span><span class="hint">${p}</span>`;
    const me = d.picks[mine] === null
      ? `<div class="choices">${DUELS.rps.options.map((o) =>
          `<button class="emoji-btn" data-pick="${o}" title="${o}">${RPS_EMOJI[o]}</button>`).join('')}</div>`
      : big(d.picks[mine]);
    const hidden = '<span class="big">❔</span>';
    return { me, opp: d.result ? reveal(hidden, big(d.picks[opp])) : hidden };
  },

  coin(d, mine, opp) {
    const blank = '<div class="coin"><span class="face">?</span></div>';
    const coin = (r) => `<div class="coin flip-${d.result.info.flips[r]}">
      <span class="face heads">H</span><span class="face tails">T</span></div>`;
    const called = (r) => {
      const call = d.picks[r], flip = d.result && d.result.info.flips[r];
      const after = d.result ? `<span class="later"> — landed ${flip}, ${yesNo(call === flip)}</span>` : '';
      return `<span class="hint">${r === mine ? 'You' : nameOf(r)} called <b>${call}</b>${after}</span>`;
    };
    const me = d.picks[mine] === null
      ? `${blank}<div class="choices">
          <button class="primary" data-pick="heads">Heads</button>
          <button class="primary" data-pick="tails">Tails</button></div>`
      : `${d.result ? reveal(blank, coin(mine)) : blank}${called(mine)}`;
    const theirs = d.result ? `${reveal(blank, coin(opp))}<span class="late">${called(opp)}</span>` : blank;
    return { me, opp: theirs };
  },

  cards(d, mine, opp) {
    const hands = d.data.hands; // null until the reveal
    // owner's hand, which grabber picks from
    const row = (owner, grabber) => `<div class="cardrow">${[0, 1, 2].map((i) => {
      const shown = d.picks[grabber] === String(i) && (hands || grabber === mine);
      const tag = shown ? `<span class="grab-tag">${grabber === mine ? 'you' : nameOf(grabber)}</span>` : '';
      const canGrab = owner === opp && d.picks[mine] === null;
      return `<button class="pcard ${hands ? hands[owner][i] : 'back'} ${shown ? 'grabbed' : ''}"
        ${canGrab ? `data-pick="${i}"` : 'disabled'}>${tag}</button>`;
    }).join('')}</div>`;
    const result = (r) => {
      const got = DUELS.cards.grabbed(d, r);
      return `<span class="hint">${r === mine ? 'You' : nameOf(r)} grabbed ${got} ${yesNo(got === CARD_COLOURS[r])}</span>`;
    };
    const goal = `<span class="hint">Grab the <b class="${mine}">${CARD_COLOURS[mine]}</b> card from ${nameOf(opp)}’s hand</span>`;
    const yours = `<span class="hint">Your hand — ${nameOf(opp)} is after the <b class="${opp}">${CARD_COLOURS[opp]}</b> one</span>`;
    return {
      opp: `${row(opp, mine)}${hands ? result(mine) : goal}`,
      me: `${row(mine, opp)}${hands ? result(opp) : yours}`,
    };
  },

  dice(d, mine, opp) {
    const rolls = d.data.rolls;
    // Only roll the dice when they first appear, not on every redraw.
    const fresh = d.picks.host === null && d.picks.guest === null;
    const die = (n, rolling) => `<span class="die ${rolling ? 'rolling' : ''}">${DICE_FACES[n - 1]}</span>`;
    const right = (r) => (d.picks[r] === 'higher' ? rolls[r] > rolls[other(r)] : rolls[r] < rolls[other(r)]);
    let me = `${die(rolls[mine], fresh)}<span class="hint">You rolled ${rolls[mine]}</span>`;
    me += d.picks[mine] === null
      ? `<div class="choices">
          <button class="primary" data-pick="higher">⬆ Higher</button>
          <button class="primary" data-pick="lower">⬇ Lower</button></div>`
      : `<span class="hint">You said <b>${d.picks[mine]}</b> ${d.result ? yesNo(right(mine)) : ''}</span>`;
    const theirs = d.result
      ? `${die(rolls[opp], true)}<span class="hint">${nameOf(opp)} rolled ${rolls[opp]} and said <b>${d.picks[opp]}</b> ${yesNo(right(opp))}</span>`
      : '<span class="die hidden-die">?</span>';
    return { me, opp: theirs };
  },

  madlibs(d, mine, opp) {
    const lib = MADLIBS[d.data.lib], fills = d.data.fills, ml = DUELS.madlibs;
    const text = (words) => esc(madlibText(lib, words.map((w) => w || '_____')));
    let me;
    if (fills[mine] === null) {
      if (mlDraft.id !== d.id) mlDraft = { id: d.id, words: lib.words.map(() => null) };
      const rows = lib.words.map((ws, i) => `<div class="choices words">${ws.map((w) =>
        `<button class="${mlDraft.words[i] === w ? 'chosen' : ''}" data-word="${i}" data-w="${esc(w)}">${esc(w)}</button>`
      ).join('')}</div>`).join('');
      me = `<p class="sentence">${text(mlDraft.words)}</p>${rows}
        <button class="primary" data-mlsubmit ${mlDraft.words.every(Boolean) ? '' : 'disabled'}>Submit sentence</button>`;
    } else if (!d.data.pairs) {
      me = `<p class="sentence">${text(fills[mine])}</p><span class="hint">Sent. Waiting for ${nameOf(opp)}…</span>`;
    } else {
      const myPick = d.picks[mine];
      me = `<b>Which one did the computer write?</b>${d.data.pairs[mine].map((p, i) => {
        if (myPick === null) return `<button class="sentence-btn" data-pick="${i}">${text(p.words)}</button>`;
        const tag = d.result ? `<span class="tag">${p.comp ? '🤖 Computer' : `✍ ${nameOf(opp)}`}</span>` : '';
        return `<div class="sentence-btn ${myPick === String(i) ? 'chosen' : ''}">${tag}${text(p.words)}</div>`;
      }).join('')}`;
      if (d.result) me += `<span class="hint">You ${ml.spotted(d, mine) ? 'spotted the computer' : 'were fooled'} ${yesNo(ml.spotted(d, mine))}</span>`;
    }
    const theirs = d.result
      ? `<span class="hint">${nameOf(opp)} had your sentence to tell apart from the computer’s, and
          ${ml.spotted(d, opp) ? 'spotted the computer' : 'was fooled'} ${yesNo(ml.spotted(d, opp))}</span>`
      : '<span class="big">✍️</span>';
    return { me, opp: theirs };
  },
};

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

$('host-btn').onclick = hostNewGame;
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
  else if (b.dataset.word !== undefined) {
    mlDraft.words[+b.dataset.word] = b.dataset.w;
    render();
  } else if (b.dataset.mlsubmit !== undefined) act({ type: 'pick', value: mlDraft.words.slice() });
  else if (b.dataset.skip !== undefined) act({ type: 'rule', text: '' });
  else if (b.dataset.quickdraw !== undefined) act({ type: 'quickdraw' });
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
