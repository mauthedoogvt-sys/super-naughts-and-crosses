// Game rules. Only the host's browser runs applyAction(); the guest sends its
// actions to the host and draws whatever state comes back.

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const MARKS = { host: 'X', guest: 'O' };

function other(role) {
  return role === 'host' ? 'guest' : 'host';
}

function randInt(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function higher(a, b) {
  return a === b ? null : a > b ? 'host' : 'guest';
}

// ---- Tiebreakers ----------------------------------------------------------
// resolve() gets both players' picks and returns { winner, info }, where
// winner is 'host', 'guest' or null (another tie).

const CARD_RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CARD_SUITS = ['♠', '♥', '♦', '♣'];
const drawCard = () => ({ rank: randInt(13) + 2, suit: CARD_SUITS[randInt(4)] });
const cardName = (c) => (CARD_RANKS[c.rank] || c.rank) + c.suit;

const DUELS = {
  rps: {
    name: 'Rock Paper Scissors',
    prompt: 'Pick one.',
    options: ['rock', 'paper', 'scissors'],
    labels: { rock: '✊ Rock', paper: '✋ Paper', scissors: '✌️ Scissors' },
    resolve(p) {
      const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      if (p.host === p.guest) return { winner: null };
      return { winner: beats[p.host] === p.guest ? 'host' : 'guest' };
    },
    describe(e, n) {
      return `${n.host} threw ${e.picks.host}, ${n.guest} threw ${e.picks.guest}.`;
    },
  },
  coin: {
    name: 'Coin Flip',
    prompt: 'Call it: heads or tails?',
    options: ['heads', 'tails'],
    labels: { heads: '🪙 Heads', tails: '🪙 Tails' },
    resolve(p) {
      const flip = randInt(2) ? 'heads' : 'tails';
      const h = p.host === flip, g = p.guest === flip;
      return { winner: h === g ? null : h ? 'host' : 'guest', info: { flip } };
    },
    describe(e, n) {
      return `It landed ${e.info.flip}. ${n.host} called ${e.picks.host}, ${n.guest} called ${e.picks.guest}.`;
    },
  },
  number: {
    name: 'Closest Number',
    prompt: 'Guess the secret number from 1 to 10. Closest wins.',
    options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    labels: {},
    resolve(p) {
      const target = randInt(10) + 1;
      const dh = Math.abs(+p.host - target), dg = Math.abs(+p.guest - target);
      return { winner: higher(dg, dh), info: { target } };
    },
    describe(e, n) {
      return `The number was ${e.info.target}. ${n.host} guessed ${e.picks.host}, ${n.guest} guessed ${e.picks.guest}.`;
    },
  },
  dice: {
    name: 'Dice Roll',
    prompt: 'Highest roll wins.',
    options: ['roll'],
    labels: { roll: '🎲 Roll' },
    resolve() {
      const host = randInt(6) + 1, guest = randInt(6) + 1;
      return { winner: higher(host, guest), info: { host, guest } };
    },
    describe(e, n) {
      return `${n.host} rolled ${e.info.host}, ${n.guest} rolled ${e.info.guest}.`;
    },
  },
  card: {
    name: 'High Card',
    prompt: 'Highest card wins (aces high).',
    options: ['draw'],
    labels: { draw: '🃏 Draw' },
    resolve() {
      const host = drawCard(), guest = drawCard();
      return { winner: higher(host.rank, guest.rank), info: { host, guest } };
    },
    describe(e, n) {
      return `${n.host} drew ${cardName(e.info.host)}, ${n.guest} drew ${cardName(e.info.guest)}.`;
    },
  },
};

// Rock paper scissors first, then a coin flip, then random games until someone wins.
const DUEL_ORDER = ['rps', 'coin'];

function nextDuelType(count, prev) {
  if (count < DUEL_ORDER.length) return DUEL_ORDER[count];
  const types = Object.keys(DUELS).filter((t) => t !== prev);
  return types[randInt(types.length)];
}

// ---- Game state -----------------------------------------------------------

function createGame(code, host) {
  return {
    v: 0,
    code,
    phase: 'lobby', // lobby | play | duel | rule
    players: { host, guest: null },
    round: 1,
    scores: { host: 0, guest: 0 },
    rules: [],
    board: Array(9).fill(null),
    turn: 'host',
    first: 'host',
    winLine: null,
    duel: null,
    roundWinner: null,
    winHow: null,
    rematch: { host: false, guest: false },
    chat: [],
  };
}

function newMatch(s) {
  s.round = 1;
  s.scores = { host: 0, guest: 0 };
  s.rules = [];
  s.rematch = { host: false, guest: false };
  startRound(s);
}

function startRound(s) {
  s.board = Array(9).fill(null);
  s.winLine = null;
  s.duel = null;
  s.roundWinner = null;
  s.winHow = null;
  s.first = randInt(2) ? 'host' : 'guest'; // coin flip for who goes first
  s.turn = s.first;
  s.phase = 'play';
}

function endRound(s, winner, how) {
  s.roundWinner = winner;
  s.winHow = how;
  s.scores[winner]++;
  s.phase = 'rule';
}

// Applies one player's action. Returns true if the state changed.
function applyAction(s, role, a) {
  if (!a || typeof a !== 'object') return false;
  switch (a.type) {
    case 'move': return move(s, role, a.cell);
    case 'pick': return pick(s, role, a.value);
    case 'rule': return addRule(s, role, a.text);
    case 'rematch': return rematch(s, role);
    case 'chat': return chat(s, role, a.text);
  }
  return false;
}

function move(s, role, cell) {
  if (s.phase !== 'play' || s.turn !== role) return false;
  if (!Number.isInteger(cell) || cell < 0 || cell > 8 || s.board[cell]) return false;
  s.board[cell] = role;
  const line = LINES.find((l) => l.every((i) => s.board[i] === role));
  if (line) {
    s.winLine = line;
    endRound(s, role, 'line');
  } else if (s.board.every(Boolean)) {
    s.phase = 'duel';
    s.duel = { type: nextDuelType(0), picks: { host: null, guest: null }, history: [] };
  } else {
    s.turn = other(role);
  }
  return true;
}

function pick(s, role, value) {
  const d = s.duel;
  if (s.phase !== 'duel' || d.picks[role] !== null) return false;
  const game = DUELS[d.type];
  if (!game.options.includes(value)) return false;
  d.picks[role] = value;
  if (d.picks[other(role)] === null) return true;

  const { winner, info } = game.resolve(d.picks);
  d.history.push({ type: d.type, picks: d.picks, info: info || null, winner });
  d.picks = { host: null, guest: null };
  if (winner) {
    endRound(s, winner, 'duel');
  } else {
    d.type = nextDuelType(d.history.length, d.type);
  }
  return true;
}

function addRule(s, role, text) {
  if (s.phase !== 'rule' || s.roundWinner !== role) return false;
  text = String(text || '').trim().slice(0, 200);
  if (text) s.rules.push({ by: role, text, round: s.round });
  s.round++;
  startRound(s);
  return true;
}

function rematch(s, role) {
  if (s.phase === 'lobby' || s.rematch[role]) return false;
  s.rematch[role] = true;
  if (s.rematch[other(role)]) newMatch(s);
  return true;
}

function chat(s, role, text) {
  text = String(text || '').trim().slice(0, 200);
  if (!text) return false;
  s.chat.push({ from: role, text });
  if (s.chat.length > 100) s.chat.splice(0, s.chat.length - 100);
  return true;
}

// The copy of the state a player is allowed to see: the opponent's tiebreaker
// pick is hidden until both have picked.
function viewFor(s, role) {
  const v = JSON.parse(JSON.stringify(s));
  const opp = other(role);
  if (v.duel && v.duel.picks[opp] !== null) v.duel.picks[opp] = 'hidden';
  return v;
}
