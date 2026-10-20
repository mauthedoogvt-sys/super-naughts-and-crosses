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

// ---- Bonus games ----------------------------------------------------------
// A drawn round goes to bonus games until one has a winner. Each game has:
//   setup()               secret data for this game, kept in duel.data
//   options / pick()      the picks a player may make (pick() for games that
//                         need more than one; it returns true if accepted)
//   hide(duel, role)      strips what `role` mustn't see before the reveal
//   resolve(duel)         { winner, info } once both have picked; winner is
//                         'host', 'guest' or null (another tie)
//   describe(entry, n)    one line for the history list
//   countdown, revealMs   how the reveal is shown, and how long before the
//                         host moves on

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
  const winner = right.host === right.guest ? null : right.host ? 'host' : 'guest';
  return { winner, info: { ...info, right } };
}

const RPS_EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const CARD_COLOURS = { host: 'red', guest: 'blue' };

// Each "_" is a blank, filled from the matching list of words.
const MADLIBS = [
  { text: 'My _ ate a _ and then _ all the way to _.',
    words: [['grandma', 'hamster', 'dentist', 'pet robot'], ['sandwich', 'sock', 'candle', 'trumpet'],
      ['danced', 'sneezed', 'cried', 'skipped'], ['the moon', 'school', 'the shops', 'Paris']] },
  { text: 'The _ wizard turned the king into a _ because he was too _.',
    words: [['grumpy', 'sparkly', 'sleepy', 'tiny'], ['teapot', 'frog', 'pancake', 'traffic cone'],
      ['loud', 'smelly', 'handsome', 'boring']] },
  { text: 'Breaking news: a _ has been elected mayor after promising free _ for every _.',
    words: [['goose', 'toddler', 'vampire', 'talking cheese'], ['hugs', 'spaghetti', 'socks', 'trampolines'],
      ['grandad', 'cat', 'teacher', 'pigeon']] },
  { text: "I can't come to school today because my _ is _ and I have to _.",
    words: [['goldfish', 'homework', 'left shoe', 'uncle'], ['on fire', 'invisible', 'singing opera', 'stuck in a tree'],
      ['call the police', 'bake a cake', 'hide', 'learn karate']] },
  { text: "Never trust a _ that _ when you're _.",
    words: [['clown', 'sandwich', 'penguin', 'librarian'], ['whistles', 'winks', 'cries', 'dances'],
      ['asleep', 'in the bath', 'eating soup', 'on holiday']] },
  { text: 'For my birthday I want a _ _ that can _.',
    words: [['giant', 'purple', 'haunted', 'bouncy'], ['horse', 'castle', 'spoon', 'submarine'],
      ['fly', 'tell jokes', 'do my homework', 'juggle']] },
  { text: "The secret ingredient in Grandma's _ is _, which is why it tastes _.",
    words: [['soup', 'cake', 'lasagne', 'porridge'], ['glitter', 'toenails', 'love', 'ketchup'],
      ['amazing', 'suspicious', 'crunchy', 'like feet']] },
  { text: 'Scientists have discovered that _ can _ if you _ them.',
    words: [['potatoes', 'ducks', 'bin bags', 'grandparents'], ['talk', 'explode', 'glow', 'fly'],
      ['shout at', 'tickle', 'sing to', 'ignore']] },
];

function madlibText(lib, words) {
  return lib.text.split('_').map((part, i) => part + (i < words.length ? words[i] : '')).join('');
}

const DUELS = {
  rps: {
    name: 'Rock Paper Scissors',
    prompt: 'Rock beats scissors, scissors beat paper, paper beats rock.',
    countdown: true,
    revealMs: 6500,
    options: ['rock', 'paper', 'scissors'],
    resolve(d) {
      const p = d.picks, beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      if (p.host === p.guest) return { winner: null };
      return { winner: beats[p.host] === p.guest ? 'host' : 'guest' };
    },
    describe(e, n) {
      return `${n.host} threw ${RPS_EMOJI[e.picks.host]}, ${n.guest} threw ${RPS_EMOJI[e.picks.guest]}.`;
    },
  },
  coin: {
    name: 'Coin Flip',
    prompt: 'You each flip your own coin. Call yours — get it right and your opponent wrong to win.',
    countdown: true,
    revealMs: 8000,
    options: ['heads', 'tails'],
    resolve(d) {
      const flips = { host: randInt(2) ? 'heads' : 'tails', guest: randInt(2) ? 'heads' : 'tails' };
      return oneRight({ host: d.picks.host === flips.host, guest: d.picks.guest === flips.guest }, { flips });
    },
    describe(e, n) {
      const f = e.info.flips;
      return `${n.host} called ${e.picks.host} (landed ${f.host}), ${n.guest} called ${e.picks.guest} (landed ${f.guest}).`;
    },
  },
  cards: {
    name: 'Grab a Card',
    prompt: 'Nobody can see the cards. Grab one of your colour from your opponent’s hand.',
    revealMs: 6000,
    options: ['0', '1', '2'],
    setup() {
      return { hands: { host: shuffle(['red', 'red', 'blue']), guest: shuffle(['blue', 'blue', 'red']) } };
    },
    hide(d) {
      d.data.hands = null;
    },
    // Each player picks a card (by position) from the other player's hand.
    grabbed(d, role) {
      return d.data.hands[other(role)][+d.picks[role]];
    },
    resolve(d) {
      return oneRight({
        host: this.grabbed(d, 'host') === CARD_COLOURS.host,
        guest: this.grabbed(d, 'guest') === CARD_COLOURS.guest,
      });
    },
    describe(e, n) {
      return `${n.host} grabbed ${this.grabbed(e, 'host')}, ${n.guest} grabbed ${this.grabbed(e, 'guest')}.`;
    },
  },
  dice: {
    name: 'Higher or Lower',
    prompt: 'You can only see your own roll. Is it higher or lower than your opponent’s? (A draw makes you both wrong.)',
    revealMs: 6500,
    options: ['higher', 'lower'],
    setup() {
      return { rolls: { host: randInt(6) + 1, guest: randInt(6) + 1 } };
    },
    hide(d, role) {
      d.data.rolls[other(role)] = null;
    },
    resolve(d) {
      const r = d.data.rolls;
      const right = (role) => {
        const mine = r[role], theirs = r[other(role)];
        return d.picks[role] === 'higher' ? mine > theirs : mine < theirs;
      };
      return oneRight({ host: right('host'), guest: right('guest') });
    },
    describe(e, n) {
      const r = e.data.rolls;
      return `${n.host} rolled ${r.host} and said ${e.picks.host}, ${n.guest} rolled ${r.guest} and said ${e.picks.guest}.`;
    },
  },
  madlibs: {
    name: 'Mad Libs',
    prompt: 'Fill in the blanks. Then spot which sentence the computer wrote at random.',
    revealMs: 9000,
    setup() {
      return { lib: randInt(MADLIBS.length), fills: { host: null, guest: null }, pairs: null };
    },
    // First pick: the player's words. Second pick: '0' or '1', the sentence
    // they think the computer wrote.
    pick(d, role, value) {
      const lib = MADLIBS[d.data.lib], fills = d.data.fills;
      if (fills[role] === null) {
        if (!Array.isArray(value) || value.length !== lib.words.length) return false;
        if (!value.every((w, i) => lib.words[i].includes(w))) return false;
        fills[role] = value.slice();
        if (fills[other(role)] !== null) {
          // The computer's sentence, never the same as either player's.
          let comp, tries = 0;
          do comp = lib.words.map((ws) => ws[randInt(ws.length)]);
          while (tries++ < 50 && (comp.join() === fills.host.join() || comp.join() === fills.guest.join()));
          d.data.pairs = {};
          for (const r of ['host', 'guest']) {
            d.data.pairs[r] = shuffle([{ words: fills[other(r)], comp: false }, { words: comp, comp: true }]);
          }
        }
        return true;
      }
      if (!d.data.pairs || d.picks[role] !== null || (value !== '0' && value !== '1')) return false;
      d.picks[role] = value;
      return true;
    },
    hide(d, role) {
      const opp = other(role), data = d.data;
      if (data.fills[opp] !== null) data.fills[opp] = 'hidden';
      if (data.pairs) {
        delete data.pairs[opp];
        data.pairs[role].forEach((p) => delete p.comp);
      }
    },
    spotted(d, role) {
      return d.data.pairs[role][+d.picks[role]].comp;
    },
    resolve(d) {
      return oneRight({ host: this.spotted(d, 'host'), guest: this.spotted(d, 'guest') });
    },
    describe(e, n) {
      const says = (r) => `${n[r]} ${this.spotted(e, r) ? 'spotted the computer' : 'was fooled'}`;
      return `${says('host')}, ${says('guest')}.`;
    },
  },
};

// Bonus games come in a random order, all five before any repeats.
function nextDuel(d) {
  if (!d.queue.length) {
    d.queue = shuffle(Object.keys(DUELS));
    if (d.queue[0] === d.type) d.queue.push(d.queue.shift());
  }
  d.type = d.queue.shift();
  d.id = randInt(1e9);
  d.picks = { host: null, guest: null };
  d.data = DUELS[d.type].setup ? DUELS[d.type].setup() : {};
  d.result = null;
}

function startDuel(s) {
  s.phase = 'duel';
  s.duel = { type: null, queue: [], history: [] };
  nextDuel(s.duel);
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
    case 'advance': return advance(s, role);
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
    startDuel(s);
  } else {
    s.turn = other(role);
  }
  return true;
}

function pick(s, role, value) {
  const d = s.duel;
  if (s.phase !== 'duel' || d.result) return false;
  const game = DUELS[d.type];
  if (game.pick) {
    if (!game.pick(d, role, value)) return false;
  } else {
    if (d.picks[role] !== null || !game.options.includes(value)) return false;
    d.picks[role] = value;
  }
  if (d.picks.host === null || d.picks.guest === null) return true;

  const { winner, info = null } = game.resolve(d);
  d.result = { winner, info };
  d.history.push({ type: d.type, picks: d.picks, data: d.data, info, winner });
  return true;
}

// Ends the reveal of a bonus game. The host's browser sends this itself once
// the reveal has had time to play out.
function advance(s, role) {
  if (role !== 'host' || s.phase !== 'duel' || !s.duel.result) return false;
  if (s.duel.result.winner) endRound(s, s.duel.result.winner, 'duel');
  else nextDuel(s.duel);
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

// The copy of the state a player is allowed to see: until a bonus game is
// revealed, the opponent's pick and the game's secrets are hidden.
function viewFor(s, role) {
  const v = JSON.parse(JSON.stringify(s));
  const d = v.duel;
  if (v.phase === 'duel' && d && !d.result) {
    const opp = other(role);
    if (d.picks[opp] !== null) d.picks[opp] = 'hidden';
    const game = DUELS[d.type];
    if (game.hide) game.hide(d, role);
  }
  return v;
}
