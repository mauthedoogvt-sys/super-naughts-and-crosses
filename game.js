// Game rules. Only the room owner's browser runs applyAction(); everyone else
// sends their actions to it and draws whatever state comes back. The two
// players sit in the 'x' and 'o' seats; anyone else in the room is watching.

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

// ---- The board ------------------------------------------------------------
// A grid of rows × cols that rules can grow and shrink. Squares are keyed
// "r,c" and can lie outside the grid. A row or column deleted from the middle
// stays behind as a gap of dead squares, splitting the board; each round one
// gap square is drawn to be a wildcard. A row or column added later is whole
// even where it crosses a gap, and one added over a gap fills it back in. Tiles a Shift pushes off the grid
// stay where they land but only count for diagonals. Wildcard squares (on the
// grid or off it) count as X and O, but a line can use only one wildcard.

const key = (r, c) => `${r},${c}`;
const unkey = (k) => k.split(',').map(Number);

function newGrid() {
  return { rows: 3, cols: 3, dead: [] }; // dead: gap squares, "r,c"
}

// Games saved when gaps were whole rows and columns.
function upgradeGrid(s) {
  const g = s && s.grid;
  if (!g || g.dead) return;
  g.dead = [];
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) if (g.gapRows.includes(r) || g.gapCols.includes(c)) g.dead.push(key(r, c));
  }
  delete g.gapRows;
  delete g.gapCols;
}

function inRect(g, r, c) {
  return r >= 0 && r < g.rows && c >= 0 && c < g.cols;
}

function isGap(g, r, c) {
  return inRect(g, r, c) && g.dead.includes(key(r, c));
}

// On the grid and not in a gap (wildcard squares included).
function onGrid(s, k) {
  const [r, c] = unkey(k);
  return inRect(s.grid, r, c) && !isGap(s.grid, r, c);
}

// A square a tile can be placed on.
function playable(s, k) {
  return onGrid(s, k) && !s.wilds.includes(k);
}

function rectKeys(s) {
  const out = [];
  for (let r = 0; r < s.grid.rows; r++) for (let c = 0; c < s.grid.cols; c++) out.push(key(r, c));
  return out;
}

const gridSquares = (s) => rectKeys(s).filter((k) => onGrid(s, k));
const emptyKeys = (s) => rectKeys(s).filter((k) => playable(s, k) && !s.board[k]);

// The squares of row (or column) i, across the grid.
function lineKeys(g, axis, i) {
  const n = axis === 'row' ? g.cols : g.rows;
  return [...Array(n).keys()].map((j) => (axis === 'row' ? key(i, j) : key(j, i)));
}

// The rows (or columns) that aren't all gap.
function liveLines(s, axis) {
  const g = s.grid, n = axis === 'row' ? g.rows : g.cols;
  return [...Array(n).keys()].filter((i) => lineKeys(g, axis, i).some((k) => !g.dead.includes(k)));
}

function lineLabel(s, axis, i) {
  return `${axis === 'row' ? 'row' : 'column'} ${liveLines(s, axis).indexOf(i) + 1}`;
}

// What square k is worth to `seat` in a line: 'tile', 'wild' or nothing.
function worth(s, k, seat, diagonal) {
  const t = s.board[k];
  if (t) return t === seat && (diagonal || onGrid(s, k)) ? 'tile' : null;
  return s.wilds.includes(k) || s.gapWild === k ? 'wild' : null;
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// Three in a row for `seat`, as a list of squares, or null.
function findLine(s, seat) {
  const starts = [...Object.keys(s.board).filter((k) => s.board[k] === seat), ...s.wilds];
  if (s.gapWild) starts.push(s.gapWild);
  for (const k of starts) {
    const [r, c] = unkey(k);
    for (const [dr, dc] of DIRS) {
      for (let off = 0; off < 3; off++) {
        const line = [0, 1, 2].map((i) => key(r + (i - off) * dr, c + (i - off) * dc));
        const got = line.map((q) => worth(s, q, seat, dr && dc));
        if (got.every(Boolean) && got.filter((g) => g === 'wild').length <= 1) return line;
      }
    }
  }
  return null;
}

// Moves everything on the board (and its gaps) by dr rows and dc columns.
function moveAll(s, dr, dc) {
  const mv = (k) => { const [r, c] = unkey(k); return key(r + dr, c + dc); };
  s.wilds = s.wilds.map(mv);
  s.curses.forEach((x) => { x.key = mv(x.key); });
  s.board = Object.fromEntries(Object.entries(s.board).map(([k, t]) => [mv(k), t]));
  s.grid.dead = s.grid.dead.map(mv);
}

// Cuts off rows and columns at the edges of the grid that are all gap, and
// anything lying in line with them.
function trimGaps(s) {
  const g = s.grid;
  const dead = (axis, i) => !liveLines(s, axis).includes(i);
  const drop = (axis, i) => {
    const off = (k) => unkey(k)[axis === 'row' ? 0 : 1] !== i;
    s.wilds = s.wilds.filter(off);
    s.curses = s.curses.filter((x) => off(x.key));
    g.dead = g.dead.filter(off);
    if (axis === 'row') g.rows--;
    else g.cols--;
  };
  for (let again = true; again;) {
    if (dead('row', 0)) { drop('row', 0); moveAll(s, -1, 0); }
    else if (dead('row', g.rows - 1)) drop('row', g.rows - 1);
    else if (dead('col', 0)) { drop('col', 0); moveAll(s, 0, -1); }
    else if (dead('col', g.cols - 1)) drop('col', g.cols - 1);
    else again = false;
  }
}

// Where a row (or column) can be placed: just outside an edge (index -1, or
// one past the end), or over one with gap squares in it, to fill them in.
function canPlace(s, axis, i) {
  const g = s.grid, n = axis === 'row' ? g.rows : g.cols;
  if (i === -1 || i === n) return true;
  return Number.isInteger(i) && i >= 0 && i < n && lineKeys(g, axis, i).some((k) => g.dead.includes(k));
}

// Places a whole row or column there; returns what happened, or null.
function placeLine(s, t) {
  if (!t || (t.axis !== 'row' && t.axis !== 'col') || !canPlace(s, t.axis, t.index)) return null;
  const g = s.grid, rows = t.axis === 'row', n = rows ? g.rows : g.cols, i = t.index;
  const what = rows ? 'row' : 'column';
  if (i === -1) {
    if (rows) { g.rows++; moveAll(s, 1, 0); } else { g.cols++; moveAll(s, 0, 1); }
    return `added a ${what} ${rows ? 'on top' : 'on the left'}`;
  }
  if (i === n) {
    if (rows) g.rows++; else g.cols++;
    return `added a ${what} ${rows ? 'on the bottom' : 'on the right'}`;
  }
  const fill = lineKeys(g, t.axis, i);
  g.dead = g.dead.filter((k) => !fill.includes(k));
  return `filled in ${lineLabel(s, t.axis, i)}`;
}

// Pushes every tile in a row or column one square along.
function shiftLine(s, e) {
  const rows = e.axis === 'row', board = {};
  for (const [k, t] of Object.entries(s.board)) {
    let [r, c] = unkey(k);
    if (rows && r === e.index) c += e.dir;
    if (!rows && c === e.index) r += e.dir;
    board[key(r, c)] = t;
  }
  s.board = board;
}

function shiftLabel(s, e) {
  const way = e.axis === 'row' ? (e.dir > 0 ? 'right' : 'left') : (e.dir > 0 ? 'down' : 'up');
  return `${lineLabel(s, e.axis, e.index)} shifts ${way}`;
}

// ---- Rules ----------------------------------------------------------------
// Whoever wins a round picks one of three rules drawn at random. Each has:
//   ok(s, seat)               whether it can be drawn right now
//   target                    what the player has to pick: 'place', 'line',
//                             'cell', 'wild', 'shift' or nothing
//   apply(s, seat, target)    puts it into play; returns the line for the
//                             rules list, or null if the target is no good
// Rules for "next round" go in s.pending and move to s.active when it starts.

const RULES = {
  addLine: {
    name: 'Add a Line', icon: '➕', target: 'place',
    desc: 'Add another row or column to the board, for the rest of the match.',
    apply(s, seat, t) {
      const text = placeLine(s, t);
      return text && text[0].toUpperCase() + text.slice(1);
    },
  },
  delLine: {
    name: 'Delete a Line', icon: '✂️', target: 'line',
    desc: 'Delete a row or column. Take one from the middle and the board splits — each round, one square of the gap is a wildcard.',
    ok: (s) => gridSquares(s).length > 9 && (liveLines(s, 'row').length > 3 || liveLines(s, 'col').length > 3),
    apply(s, seat, t) {
      if (!t || (t.axis !== 'row' && t.axis !== 'col')) return null;
      const rows = t.axis === 'row', g = s.grid, live = liveLines(s, t.axis), i = t.index;
      if (live.length <= 3 || !live.includes(i)) return null;
      const label = lineLabel(s, t.axis, i), middle = i !== live[0] && i !== live.at(-1);
      // It becomes a gap; gaps that end up at an edge are cut off entirely.
      g.dead = [...new Set([...g.dead, ...lineKeys(g, t.axis, i)])];
      trimGaps(s);
      s.wilds = s.wilds.filter((k) => !isGap(g, ...unkey(k)));
      return middle ? `Deleted ${label} — the board is split` : `Deleted ${label}`;
    },
  },
  curse: {
    name: 'Curse', icon: '💀', target: 'cell',
    desc: 'Secretly curse a square. The first tile placed there is dropped and that turn is wasted. Nobody sees where — not even you, afterwards.',
    apply(s, seat, k) {
      if (typeof k !== 'string' || !playable(s, k)) return null;
      s.curses.push({ key: k, by: seat });
      return 'Cursed a hidden square';
    },
  },
  shift: {
    name: 'Shift', icon: '↔️', target: 'shift',
    desc: 'Next round, after two turns each, a row or column of your choice slides one space. Tiles pushed off the grid still count for diagonals.',
    apply(s, seat, t) {
      if (!t || (t.axis !== 'row' && t.axis !== 'col') || (t.dir !== 1 && t.dir !== -1)) return null;
      if (!liveLines(s, t.axis).includes(t.index)) return null;
      const e = { type: 'shift', by: seat, axis: t.axis, index: t.index, dir: t.dir };
      s.pending.push(e);
      return `Next round, after two turns each, ${shiftLabel(s, e)}`;
    },
  },
  turnSwap: {
    name: 'Turn Swap', icon: '🔄',
    desc: 'Next round, each of your opponent’s turns has a growing chance to be snatched — REVERSAL! — and you play instead.',
    apply(s, seat) {
      s.pending.push({ type: 'turnSwap', by: seat, n: 0 });
      return 'Turn Swap next round';
    },
  },
  wildcard: {
    name: 'Wildcard', icon: '★', target: 'wild',
    desc: 'Add a wildcard square — on the board or just outside it. It counts as X and O, but a line can only use one wildcard.',
    apply(s, seat, k) {
      if (typeof k !== 'string' || !/^-?\d+,-?\d+$/.test(k) || s.wilds.includes(k)) return null;
      const [r, c] = unkey(k);
      if (r < -1 || r > s.grid.rows || c < -1 || c > s.grid.cols) return null;
      s.wilds.push(k);
      return onGrid(s, k) ? 'Added a wildcard square' : 'Added a wildcard square outside the grid';
    },
  },
  cheat: {
    name: 'Cheat', icon: '🕵️',
    desc: 'Get inside information in the next bonus games, until someone wins them.',
    ok: (s, seat) => !s.cheat[seat],
    apply(s, seat) {
      s.cheat[seat] = true;
      return 'Cheating in the next bonus games';
    },
  },
  roleSwap: {
    name: 'Role Swap', icon: '🔀',
    desc: 'Next round, after two turns, a turn is spent swapping who owns X and who owns O.',
    apply(s, seat) {
      s.pending.push({ type: 'roleSwap', by: seat });
      return 'Role Swap next round';
    },
  },
};

function drawOffer(s, seat) {
  return shuffle(Object.keys(RULES).filter((k) => !RULES[k].ok || RULES[k].ok(s, seat))).slice(0, 3);
}

const activeRule = (s, type) => (s.active || []).find((e) => e.type === type) || null;

// Turns taken so far this round (a wasted turn or a role swap counts).
const turnsTaken = (s) => s.turnLog.filter((e) => e.kind !== 'reversal' && e.kind !== 'shift').length;

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
//   cheat(duel, seat)     the hint a player with the Cheat rule gets (worked
//                         out from the unhidden game; data.seed picks which)
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
    cheat(d, seat) {
      const theirs = d.picks[other(seat)];
      if (theirs === null) return 'Wait for them to throw…';
      const not = this.options.filter((o) => o !== theirs)[d.data.seed % 2];
      return `They didn’t throw ${RPS_EMOJI[not]} ${not}.`;
    },
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
    // The coins are flipped up front, so a cheat can know how they'll land.
    setup() {
      return { flips: { x: randInt(2) ? 'heads' : 'tails', o: randInt(2) ? 'heads' : 'tails' } };
    },
    hide(d) {
      delete d.data.flips;
    },
    cheat(d, seat) {
      return `Their coin is going to land ${d.data.flips[other(seat)]}.`;
    },
    resolve(d) {
      const flips = d.data.flips;
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
    cheat(d, seat) {
      const hand = d.data.hands[other(seat)];
      const wrong = [0, 1, 2].filter((i) => hand[i] !== CARD_COLOURS[seat]);
      const i = wrong[d.data.seed % wrong.length];
      return `Card ${i + 1} in their hand is ${hand[i]} — not the one you need.`;
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
    cheat(d, seat) {
      return `They rolled a ${d.data.rolls[other(seat)]}.`;
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
    cheat(d, seat) {
      const theirs = d.data.fills[other(seat)];
      if (theirs === null) return 'Wait for them to finish their sentence…';
      return `One of their words is “${theirs[d.data.seed % theirs.length]}”.`;
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
  d.data = { ...(DUELS[d.type].setup ? DUELS[d.type].setup() : {}), seed: randInt(1e6) };
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
    phase: 'lobby', // lobby | play | duel | place | rule
    players: { x: null, o: null }, // { id, name } of whoever sits there
    watchers: [],                  // [{ id, name }]
    round: 1,
    scores: { x: 0, o: 0 },
    rules: [],                     // [{ by, name, type, text, round }] for the list
    grid: newGrid(),
    board: {},                     // "r,c" -> 'x' | 'o'
    wilds: [],                     // wildcard squares, "r,c"
    gapWild: null,                 // this round's wildcard square in a gap
    curses: [],                    // [{ key, by }], hidden from both players
    pending: [],                   // rules that start next round
    active: [],                    // rules in play this round
    cheat: { x: false, o: false },
    offer: null,                   // the three rules the round's winner picks from
    turnLog: [],                   // [{ seat, kind }] this round, for the turn order
    banner: { n: 0, steps: [] },   // what flashes up on screen (see announce())
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
  s.grid = newGrid();
  s.wilds = [];
  s.curses = [];
  s.pending = [];
  s.cheat = { x: false, o: false };
  s.rematch = { x: false, o: false };
  startRound(s);
}

function note(s, text) {
  s.chat.push({ sys: true, text });
}

// Queues a banner ("X TURN START", "REVERSAL"…) to flash up for everyone.
// Everything announced during one action plays in order.
function announce(s, text, cls) {
  if (!s.banner.open) s.banner = { n: s.banner.n + 1, steps: [], t: Date.now(), open: true };
  s.banner.steps.push({ text, cls });
}

function startRound(s) {
  s.board = {};
  s.winLine = null;
  s.duel = null;
  s.roundWinner = null;
  s.winHow = null;
  s.offer = null;
  s.curses = s.curses.filter((x) => playable(s, x.key));
  const gaps = rectKeys(s).filter((k) => isGap(s.grid, ...unkey(k)) && !s.wilds.includes(k));
  s.gapWild = gaps.length ? gaps[randInt(gaps.length)] : null;
  s.active = s.pending;
  s.pending = [];
  s.turnLog = [];
  s.first = randInt(2) ? 'x' : 'o'; // coin flip for who goes first
  s.phase = 'play';
  beginTurn(s, s.first);
}

// Swaps who owns X and who owns O.
function swapSeats(s) {
  const flip = (o) => { [o.x, o.o] = [o.o, o.x]; };
  flip(s.players);
  flip(s.scores);
  flip(s.rematch);
  flip(s.cheat);
  for (const e of [...s.active, ...s.pending, ...s.curses, ...s.rules]) e.by = other(e.by);
}

function beginTurn(s, seat) {
  const roles = activeRule(s, 'roleSwap');
  if (roles && !roles.done && turnsTaken(s) === 2) {
    // This turn is spent swapping roles instead of placing a tile.
    roles.done = true;
    swapSeats(s);
    s.turnLog.push({ seat, kind: 'roles' });
    announce(s, 'ROLE SWAP', 'event');
    note(s, `Role swap! ${s.players.x?.name || 'Nobody'} is X now and ${s.players.o?.name || 'nobody'} is O.`);
    return endTurn(s, seat);
  }
  const swap = activeRule(s, 'turnSwap');
  if (swap && !swap.done && seat !== swap.by) {
    swap.n++;
    if (randInt(4) < swap.n) { // 25%, then 50%, 75%, 100%
      swap.done = true;
      announce(s, `${MARKS[seat]} TURN START`, seat);
      announce(s, 'REVERSAL', 'rev');
      s.turnLog.push({ seat, kind: 'reversal' });
      seat = swap.by;
    }
  }
  announce(s, `${MARKS[seat]} TURN START`, seat);
  s.turn = seat;
}

function endTurn(s, seat) {
  const shift = activeRule(s, 'shift');
  if (shift && !shift.done && turnsTaken(s) === 4) {
    shift.done = true;
    shiftLine(s, shift);
    s.turnLog.push({ kind: 'shift' });
    announce(s, 'SHIFT', 'event');
    note(s, `Shift: ${shiftLabel(s, shift)}.`);
    const lines = { x: findLine(s, 'x'), o: findLine(s, 'o') };
    if (lines.x && lines.o) return startDuel(s); // both got a line: call it a draw
    for (const w of SEATS) {
      if (lines[w]) {
        s.winLine = lines[w];
        return endRound(s, w, 'shift');
      }
    }
  }
  if (!emptyKeys(s).length) return startDuel(s);
  beginTurn(s, other(seat));
}

// After a round the loser places a row or column, then the winner picks a rule.
function endRound(s, winner, how) {
  s.roundWinner = winner;
  s.winHow = how;
  s.scores[winner]++;
  s.phase = 'place';
}

// Applies one person's action. `seat` is 'x', 'o', or null for someone
// watching; `name` is theirs, for chat. Returns true if the state changed.
function applyAction(s, seat, a, name) {
  if (!a || typeof a !== 'object') return false;
  s.banner.open = false;
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
    case 'place': return place(s, seat, a.target, name);
    case 'rule': return addRule(s, seat, a.rule, a.target, name);
    case 'rematch': return rematch(s, seat);
  }
  return false;
}

// Testing aid: fills the board with a drawn position and goes straight to the
// bonus games.
function quickDraw(s) {
  if (s.phase !== 'play') return false;
  const keys = emptyKeys(s);
  for (let i = 0; i < 300; i++) {
    const marks = shuffle(keys.map((k, j) => (j % 2 ? 'o' : 'x')));
    keys.forEach((k, j) => { s.board[k] = marks[j]; });
    if (!findLine(s, 'x') && !findLine(s, 'o')) break;
  }
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
  if (typeof cell !== 'string' || !/^-?\d+,-?\d+$/.test(cell) || !playable(s, cell) || s.board[cell]) return false;
  const curse = s.curses.findIndex((x) => x.key === cell);
  if (curse >= 0) {
    s.curses.splice(curse, 1);
    s.turnLog.push({ seat, kind: 'cursed' });
    announce(s, 'CURSED!', 'rev');
    note(s, `${MARKS[seat]}’s tile landed on a cursed square and was dropped.`);
    endTurn(s, seat);
    return true;
  }
  s.board[cell] = seat;
  s.turnLog.push({ seat, kind: 'move' });
  const line = findLine(s, seat);
  if (line) {
    s.winLine = line;
    endRound(s, seat, 'line');
  } else {
    endTurn(s, seat);
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
  if (s.duel.result.winner) {
    s.cheat = { x: false, o: false }; // cheats last until someone wins the bonus games
    endRound(s, s.duel.result.winner, 'duel');
  } else {
    nextDuel(s.duel);
  }
  return true;
}

// The round's loser places a row or column on the board.
function place(s, seat, target, name) {
  if (s.phase !== 'place' || other(s.roundWinner) !== seat) return false;
  const text = placeLine(s, target);
  if (!text) return false;
  note(s, `${name} ${text}.`);
  s.offer = drawOffer(s, s.roundWinner);
  s.phase = 'rule';
  return true;
}

// The round's winner picks one of the rules on offer (rule null skips).
function addRule(s, seat, rule, target, name) {
  if (s.phase !== 'rule' || s.roundWinner !== seat) return false;
  if (rule != null) {
    if (!s.offer.includes(rule)) return false;
    const text = RULES[rule].apply(s, seat, target);
    if (!text) return false;
    s.rules.push({ by: seat, name, type: rule, text, round: s.round });
    note(s, `${name} chose ${RULES[rule].name}.`);
  }
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

// The copy of the state a player is allowed to see: nobody sees the curses,
// and until a bonus game is revealed, the opponent's pick and the game's
// secrets are hidden (apart from what a cheat lets through). Someone watching
// (seat null) sees everything.
function viewFor(s, seat) {
  const v = JSON.parse(JSON.stringify(s));
  if (!SEATS.includes(seat)) return v;
  v.curses = [];
  const d = v.duel;
  if (v.phase === 'duel' && d && !d.result) {
    const game = DUELS[d.type];
    // (A view of a view already has its cheat worked out.)
    if (v.cheat[seat] && game.cheat && d.cheat === undefined) d.cheat = game.cheat(d, seat);
    const opp = other(seat);
    if (d.picks[opp] !== null) d.picks[opp] = 'hidden';
    if (game.hide) game.hide(d, seat);
  }
  return v;
}
