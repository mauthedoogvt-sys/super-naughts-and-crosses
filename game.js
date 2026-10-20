// Game rules. Only the room owner's browser runs applyAction(); everyone else
// sends their actions to it and draws whatever state comes back. The two
// players sit in the 'x' and 'o' seats; anyone else in the room is watching.

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const SEATS = ['x', 'o'];
const MARKS = { x: 'X', o: 'O' };

function other(seat) {
  return seat === 'x' ? 'o' : 'x';
}

function randInt(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

// ---- Bonus games ----------------------------------------------------------
// A drawn round goes to bonus games until one has a winner. Each game has:
//   setup()               secret data for this game, kept in duel.data
//   options / pick()      the picks a player may make (pick() for games that
//                         need more than one; it returns true if accepted)
//   hide(duel, seat)      strips what that player mustn't see before the
//                         reveal (people watching see everything)
//   resolve(duel)         { winner, info } once both have picked; winner is
//                         'x', 'o' or null (another tie)
//   describe(entry, n)    one line for the history list
//   countdown, revealMs   how the reveal is shown, and how long before the
//                         owner moves everyone on

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The player who got it right wins; if both or neither did, it's a draw.
// `right` is kept in the result so the draw screen can say which.
function oneRight(right, info = {}) {
  const winner = right.x === right.o ? null : right.x ? 'x' : 'o';
  return { winner, info: { ...info, right } };
}

const RPS_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const CARD_COLOURS = { x: 'red', o: 'blue' };

// Mad Libs sentences, loaded from madlibs.txt by app.js (see parseMadlibs).
// While it's empty, Mad Libs is left out of the bonus games.
let MADLIBS = [];

// madlibs.txt: a sentence with _ for each blank, then one line per blank
// listing the words for it, comma-separated. A blank line between sentences;
// lines starting with # are comments.
function parseMadlibs(text) {
  const libs = [];
  const lines = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
  for (const block of lines.join('\n').split(/\n\s*\n/)) {
    const [sentence, ...rest] = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!sentence) continue;
    const blanks = (sentence.match(/_+/g) || []).length;
    const words = rest.map((l) => l.split(',').map((w) => w.trim()).filter(Boolean));
    if (!blanks || words.length !== blanks || words.some((ws) => !ws.length)) {
      console.warn(`madlibs.txt: skipped "${sentence}" — it has ${blanks} blank(s) but ${words.length} line(s) of words.`);
      continue;
    }
    libs.push({ text: sentence, words });
  }
  return libs;
}

function madlibText(lib, words) {
  return lib.text.split(/_+/).map((part, i) => part + (i < words.length ? words[i] : '')).join('');
}

const DUELS = {
  rps: {
    name: 'Rock Paper Scissors',
    prompt: 'Rock beats scissors, scissors beat paper, paper beats rock.',
    countdown: true,
    revealMs: 3200,
    options: ['rock', 'paper', 'scissors'],
    resolve(d) {
      const p = d.picks, beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      if (p.x === p.o) return { winner: null };
      return { winner: beats[p.x] === p.o ? 'x' : 'o' };
    },
    describe(e, n) {
      return `${n.x} threw ${RPS_EMOJI[e.picks.x]}, ${n.o} threw ${RPS_EMOJI[e.picks.o]}.`;
    },
  },
  coin: {
    name: 'Coin Flip',
    prompt: 'You each flip your own coin. Call yours — get it right and your opponent wrong to win.',
    countdown: true,
    revealMs: 4000,
    options: ['heads', 'tails'],
    resolve(d) {
      const flips = { x: randInt(2) ? 'heads' : 'tails', o: randInt(2) ? 'heads' : 'tails' };
      return oneRight({ x: d.picks.x === flips.x, o: d.picks.o === flips.o }, { flips });
    },
    describe(e, n) {
      const f = e.info.flips;
      return `${n.x} called ${e.picks.x} (landed ${f.x}), ${n.o} called ${e.picks.o} (landed ${f.o}).`;
    },
  },
  cards: {
    name: 'Grab a Card',
    prompt: 'You can see your own hand but not your opponent’s. Grab a card of your colour from theirs.',
    revealMs: 2800,
    options: ['0', '1', '2'],
    setup() {
      return { hands: { x: shuffle(['red', 'red', 'blue']), o: shuffle(['blue', 'blue', 'red']) } };
    },
    // You see your own hand, and the card you grabbed once you've grabbed it.
    hide(d, seat) {
      const opp = other(seat), grab = d.picks[seat];
      d.data.hands[opp] = d.data.hands[opp].map((c, i) => (grab === String(i) ? c : null));
    },
    // Each player picks a card (by position) from the other player's hand.
    grabbed(d, seat) {
      return d.data.hands[other(seat)][+d.picks[seat]];
    },
    resolve(d) {
      return oneRight({
        x: this.grabbed(d, 'x') === CARD_COLOURS.x,
        o: this.grabbed(d, 'o') === CARD_COLOURS.o,
      });
    },
    describe(e, n) {
      return `${n.x} grabbed ${this.grabbed(e, 'x')}, ${n.o} grabbed ${this.grabbed(e, 'o')}.`;
    },
  },
  dice: {
    name: 'Higher or Lower',
    prompt: 'You can only see your own roll. Is it higher or lower than your opponent’s? (A draw makes you both wrong.)',
    revealMs: 2800,
    options: ['higher', 'lower'],
    setup() {
      return { rolls: { x: randInt(6) + 1, o: randInt(6) + 1 } };
    },
    hide(d, seat) {
      d.data.rolls[other(seat)] = null;
    },
    resolve(d) {
      const r = d.data.rolls;
      const right = (seat) => {
        const mine = r[seat], theirs = r[other(seat)];
        return d.picks[seat] === 'higher' ? mine > theirs : mine < theirs;
      };
      return oneRight({ x: right('x'), o: right('o') });
    },
    describe(e, n) {
      const r = e.data.rolls;
      return `${n.x} rolled ${r.x} and said ${e.picks.x}, ${n.o} rolled ${r.o} and said ${e.picks.o}.`;
    },
  },
  madlibs: {
    name: 'Mad Libs',
    prompt: 'Fill in the blanks. Then spot which sentence your opponent wrote — the other one is the computer’s.',
    revealMs: 4000,
    // The sentence itself goes in the game data, so only the owner needs madlibs.txt.
    setup() {
      const lib = MADLIBS[randInt(MADLIBS.length)];
      return { lib: { text: lib.text, words: lib.words }, fills: { x: null, o: null }, pairs: null };
    },
    // First pick: the player's words. Second pick: '0' or '1', the sentence
    // they think their opponent wrote.
    pick(d, seat, value) {
      const lib = d.data.lib, fills = d.data.fills;
      if (fills[seat] === null) {
        if (!Array.isArray(value) || value.length !== lib.words.length) return false;
        if (!value.every((w, i) => lib.words[i].includes(w))) return false;
        fills[seat] = value.slice();
        if (fills[other(seat)] !== null) {
          // The computer's sentence, never the same as either player's.
          let comp, tries = 0;
          do comp = lib.words.map((ws) => ws[randInt(ws.length)]);
          while (tries++ < 50 && (comp.join() === fills.x.join() || comp.join() === fills.o.join()));
          d.data.pairs = {};
          for (const s of SEATS) {
            d.data.pairs[s] = shuffle([{ words: fills[other(s)], comp: false }, { words: comp, comp: true }]);
          }
        }
        return true;
      }
      if (!d.data.pairs || d.picks[seat] !== null || (value !== '0' && value !== '1')) return false;
      d.picks[seat] = value;
      return true;
    },
    hide(d, seat) {
      const opp = other(seat), data = d.data;
      if (data.fills[opp] !== null) data.fills[opp] = 'hidden';
      if (data.pairs) {
        delete data.pairs[opp];
        data.pairs[seat].forEach((p) => delete p.comp);
      }
    },
    found(d, seat) {
      return !d.data.pairs[seat][+d.picks[seat]].comp;
    },
    resolve(d) {
      return oneRight({ x: this.found(d, 'x'), o: this.found(d, 'o') });
    },
    describe(e, n) {
      const says = (s) => `${n[s]} ${this.found(e, s) ? 'found' : 'missed'} ${n[other(s)]}’s sentence`;
      return `${says('x')}, ${says('o')}.`;
    },
  },
};

// Bonus games come in a random order, all of them before any repeats.
function nextDuel(d) {
  if (!d.queue.length) {
    d.queue = shuffle(Object.keys(DUELS).filter((k) => k !== 'madlibs' || MADLIBS.length));
    if (d.queue[0] === d.type) d.queue.push(d.queue.shift());
  }
  d.type = d.queue.shift();
  d.id = randInt(1e9);
  d.picks = { x: null, o: null };
  d.data = DUELS[d.type].setup ? DUELS[d.type].setup() : {};
  d.result = null;
}

function startDuel(s) {
  s.phase = 'duel';
  s.duel = { type: null, queue: [], history: [] };
  nextDuel(s.duel);
}

// ---- Game state -----------------------------------------------------------

function createGame(code) {
  return {
    v: 0,
    code,
    phase: 'lobby', // lobby | play | duel | rule
    players: { x: null, o: null }, // { id, name } of whoever sits there
    watchers: [],                  // [{ id, name }]
    round: 1,
    scores: { x: 0, o: 0 },
    rules: [],
    board: Array(9).fill(null),
    turn: 'x',
    first: 'x',
    winLine: null,
    duel: null,
    roundWinner: null,
    winHow: null,
    rematch: { x: false, o: false },
    chat: [],
  };
}

function newMatch(s) {
  s.round = 1;
  s.scores = { x: 0, o: 0 };
  s.rules = [];
  s.rematch = { x: false, o: false };
  startRound(s);
}

function startRound(s) {
  s.board = Array(9).fill(null);
  s.winLine = null;
  s.duel = null;
  s.roundWinner = null;
  s.winHow = null;
  s.first = randInt(2) ? 'x' : 'o'; // coin flip for who goes first
  s.turn = s.first;
  s.phase = 'play';
}

function endRound(s, winner, how) {
  s.roundWinner = winner;
  s.winHow = how;
  s.scores[winner]++;
  s.phase = 'rule';
}

// Applies one person's action. `seat` is 'x', 'o', or null for someone
// watching; `name` is theirs, for chat. Returns true if the state changed.
function applyAction(s, seat, a, name) {
  if (!a || typeof a !== 'object') return false;
  switch (a.type) {
    case 'chat': return chat(s, seat, a.text, name);
    case 'advance': return advance(s);
    case 'quickdraw': return quickDraw(s);
    case 'forcedraw': return forceDraw(s);
  }
  if (!SEATS.includes(seat)) return false;
  switch (a.type) {
    case 'move': return move(s, seat, a.cell);
    case 'pick': return pick(s, seat, a.value);
    case 'rule': return addRule(s, seat, a.text, name);
    case 'rematch': return rematch(s, seat);
  }
  return false;
}

// Testing aid: fills the board with a drawn position and goes straight to the
// bonus games.
function quickDraw(s) {
  if (s.phase !== 'play') return false;
  s.board = ['x', 'o', 'x', 'x', 'o', 'o', 'o', 'x', 'x'];
  startDuel(s);
  return true;
}

// Testing aid: calls the current bonus game a draw and moves on to the next.
function forceDraw(s) {
  if (s.phase !== 'duel' || s.duel.result) return false;
  s.duel.history.push({ type: s.duel.type, forced: true, winner: null });
  nextDuel(s.duel);
  return true;
}

function move(s, seat, cell) {
  if (s.phase !== 'play' || s.turn !== seat) return false;
  if (!Number.isInteger(cell) || cell < 0 || cell > 8 || s.board[cell]) return false;
  s.board[cell] = seat;
  const line = LINES.find((l) => l.every((i) => s.board[i] === seat));
  if (line) {
    s.winLine = line;
    endRound(s, seat, 'line');
  } else if (s.board.every(Boolean)) {
    startDuel(s);
  } else {
    s.turn = other(seat);
  }
  return true;
}

function pick(s, seat, value) {
  const d = s.duel;
  if (s.phase !== 'duel' || d.result) return false;
  const game = DUELS[d.type];
  if (game.pick) {
    if (!game.pick(d, seat, value)) return false;
  } else {
    if (d.picks[seat] !== null || !game.options.includes(value)) return false;
    d.picks[seat] = value;
  }
  if (d.picks.x === null || d.picks.o === null) return true;

  const { winner, info = null } = game.resolve(d);
  d.result = { winner, info };
  d.history.push({ type: d.type, picks: d.picks, data: d.data, info, winner });
  return true;
}

// Ends the reveal of a bonus game. Only the owner's browser sends this, by
// itself, once the reveal has had time to play out.
function advance(s) {
  if (s.phase !== 'duel' || !s.duel.result) return false;
  if (s.duel.result.winner) endRound(s, s.duel.result.winner, 'duel');
  else nextDuel(s.duel);
  return true;
}

function addRule(s, seat, text, name) {
  if (s.phase !== 'rule' || s.roundWinner !== seat) return false;
  text = String(text || '').trim().slice(0, 200);
  if (text) s.rules.push({ by: seat, name, text, round: s.round });
  s.round++;
  startRound(s);
  return true;
}

function rematch(s, seat) {
  if (s.phase === 'lobby' || s.rematch[seat]) return false;
  s.rematch[seat] = true;
  if (s.rematch[other(seat)]) newMatch(s);
  return true;
}

function chat(s, seat, text, name) {
  text = String(text || '').trim().slice(0, 200);
  if (!text) return false;
  s.chat.push({ from: seat, name, text });
  if (s.chat.length > 100) s.chat.splice(0, s.chat.length - 100);
  return true;
}

// The copy of the state a player is allowed to see: until a bonus game is
// revealed, the opponent's pick and the game's secrets are hidden. Someone
// watching (seat null) sees everything.
function viewFor(s, seat) {
  const v = JSON.parse(JSON.stringify(s));
  const d = v.duel;
  if (SEATS.includes(seat) && v.phase === 'duel' && d && !d.result) {
    const opp = other(seat);
    if (d.picks[opp] !== null) d.picks[opp] = 'hidden';
    const game = DUELS[d.type];
    if (game.hide) game.hide(d, seat);
  }
  return v;
}
