// Demo CLI client.
// Two instances side-by-side play a full hand end-to-end against the server.
//
// Required env vars (or CLI flags):
//   JWT              — a JWT minted by scripts/mintTestJwt.ts (or --jwt)
//   LOUNGE_ID        — uuid of an existing lounge the user is a member of
//   SEAT             — seat index (0..maxPlayers-1)
//   BUY_IN           — buy-in amount (optional; defaults to lounge default)
//   SERVER_URL       — defaults to http://localhost:3001
//
// CLI flags override env vars: --jwt, --lounge, --seat, --buy-in, --server
// Other flags:
//   --bot            — auto-play (always check/call). For hands-free smoke tests.
//   --verbose        — print raw JSON for every event
//
// stdin keys (during your turn):
//   c         — check or call (smart: picks whichever is legal)
//   r <n>     — raise to total <n>
//   b <n>     — bet <n>
//   a         — all in
//   f         — fold
// stdin keys (any time):
//   s         — start the next hand
//   p         — print a snapshot of the table
//   ?         — show help
//   q         — quit
import 'dotenv/config';
import { io, Socket } from 'socket.io-client';
import * as readline from 'node:readline';

interface CliArgs {
  jwt: string;
  loungeId: string;
  seat: number;
  buyIn: number | null;
  serverUrl: string;
  bot: boolean;
  verbose: boolean;
}

interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  minBet: number;
  canRaise: boolean;
  minRaise: number;
  maxRaise: number;
}

interface Card {
  rank: string;
  suit: string;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const bot = argv.includes('--bot');
  const verbose = argv.includes('--verbose') || argv.includes('-v');
  const jwt = get('--jwt') ?? process.env.JWT;
  const loungeId = get('--lounge') ?? process.env.LOUNGE_ID;
  const seatStr = get('--seat') ?? process.env.SEAT;
  const buyInStr = get('--buy-in') ?? process.env.BUY_IN;
  const serverUrl = get('--server') ?? process.env.SERVER_URL ?? 'http://localhost:3001';
  if (!jwt) throw new Error('JWT required (env JWT or --jwt)');
  if (!loungeId) throw new Error('LOUNGE_ID required (env LOUNGE_ID or --lounge)');
  if (!seatStr) throw new Error('SEAT required (env SEAT or --seat)');
  return {
    jwt,
    loungeId,
    seat: Number(seatStr),
    buyIn: buyInStr ? Number(buyInStr) : null,
    serverUrl,
    bot,
    verbose,
  };
}

const SUIT_GLYPH: Record<string, string> = { h: '♥', d: '♦', c: '♣', s: '♠' };
function fmtCard(c: Card): string {
  const red = c.suit === 'h' || c.suit === 'd';
  const color = red ? RED : '';
  return `${color}${c.rank}${SUIT_GLYPH[c.suit] ?? c.suit}${RESET}`;
}
function fmtCards(cards: Card[]): string {
  return cards.map(fmtCard).join(' ');
}

function write(line: string): void {
  process.stdout.write(line + '\n');
}

function help(): void {
  write(`
${BOLD}Commands${RESET}
  ${BOLD}c${RESET}        check or call
  ${BOLD}r <n>${RESET}    raise to total <n>
  ${BOLD}b <n>${RESET}    bet <n>
  ${BOLD}a${RESET}        all in
  ${BOLD}f${RESET}        fold
  ${BOLD}s${RESET}        start the next hand
  ${BOLD}p${RESET}        print table snapshot
  ${BOLD}?${RESET}        show this help
  ${BOLD}q${RESET}        quit`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const socket: Socket = io(args.serverUrl, {
    auth: { token: args.jwt },
    transports: ['websocket'],
    reconnection: true,
  });

  let sat = false;
  let myTurn = false;
  let myUserId: string | null = null;
  let lastLegal: LegalActions | null = null;
  let lastTable: unknown = null;
  let countdownInterval: NodeJS.Timeout | null = null;

  const myUserIdFromJwt = ((): string => {
    try {
      const payload = args.jwt.split('.')[1];
      if (!payload) return '';
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      return (JSON.parse(json) as { sub?: string }).sub ?? '';
    } catch {
      return '';
    }
  })();
  myUserId = myUserIdFromJwt;

  const banner = (): void => {
    write(`${DIM}${'─'.repeat(60)}${RESET}`);
    write(`${BOLD}poker-server demo${RESET}  ${DIM}seat=${args.seat} bot=${args.bot}${RESET}`);
    write(`${DIM}server=${args.serverUrl}${RESET}`);
    if (myUserId) write(`${DIM}userId=${myUserId}${RESET}`);
    write(`${DIM}${'─'.repeat(60)}${RESET}`);
    help();
    write('');
  };

  const printTable = (): void => {
    const t = lastTable as
      | {
          phase?: string;
          handNumber?: number;
          board?: Card[];
          pots?: { amount: number }[];
          players?: {
            id: string;
            seat: number;
            stack: number;
            status: string;
            inHand: boolean;
            folded: boolean;
            currentBet: number;
          }[];
          yourHoleCards?: [Card, Card] | null;
        }
      | null;
    if (!t) {
      write(`${DIM}(no table state yet)${RESET}`);
      return;
    }
    const pot = (t.pots ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);
    write(
      `${BOLD}phase${RESET}=${t.phase} ${BOLD}hand${RESET}=#${t.handNumber} ${BOLD}pot${RESET}=${pot}`,
    );
    if (t.board && t.board.length) write(`${BOLD}board${RESET}: ${fmtCards(t.board)}`);
    if (t.yourHoleCards)
      write(`${BOLD}your cards${RESET}: ${fmtCards(t.yourHoleCards)} ${DIM}(only you can see this)${RESET}`);
    for (const p of t.players ?? []) {
      const me = p.id === myUserId ? `${GREEN}(you)${RESET}` : '';
      const flag = p.folded ? `${DIM}folded${RESET}` : p.inHand ? '' : `${DIM}away${RESET}`;
      write(
        `  seat ${p.seat}: ${DIM}${p.id.slice(0, 8)}${RESET} stack=${p.stack} bet=${p.currentBet} ${flag} ${me}`.trimEnd(),
      );
    }
  };

  const smartCheckOrCall = (): { type: 'check' } | { type: 'call' } | null => {
    if (!lastLegal) return null;
    if (lastLegal.canCheck) return { type: 'check' };
    if (lastLegal.canCall) return { type: 'call' };
    return null;
  };

  const takeAction = (line: string): void => {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed) return;
    const [head, rest] = [trimmed[0], trimmed.slice(1).trim()];
    switch (head) {
      case 'f':
        socket.emit('hand:action', { loungeId: args.loungeId, action: { type: 'fold' } });
        break;
      case 'c': {
        const a = smartCheckOrCall();
        if (!a) {
          write(`${YELLOW}cannot check/call right now${RESET}`);
          return;
        }
        socket.emit('hand:action', { loungeId: args.loungeId, action: a });
        break;
      }
      case 'r': {
        const n = Number(rest);
        if (!Number.isFinite(n) || n <= 0) {
          write(`${YELLOW}usage: r <amount>${RESET}`);
          return;
        }
        socket.emit('hand:action', {
          loungeId: args.loungeId,
          action: { type: 'raise', amount: n },
        });
        break;
      }
      case 'b': {
        const n = Number(rest);
        if (!Number.isFinite(n) || n <= 0) {
          write(`${YELLOW}usage: b <amount>${RESET}`);
          return;
        }
        socket.emit('hand:action', {
          loungeId: args.loungeId,
          action: { type: 'bet', amount: n },
        });
        break;
      }
      case 'a':
        socket.emit('hand:action', { loungeId: args.loungeId, action: { type: 'all_in' } });
        break;
      case 's':
        socket.emit('hand:start', { loungeId: args.loungeId });
        write(`${DIM}→ requested hand start${RESET}`);
        return;
      case 'p':
        printTable();
        return;
      case '?':
        help();
        return;
      case 'q':
        write(`${DIM}bye${RESET}`);
        process.exit(0);
      default:
        write(`${YELLOW}unknown command: ${head} (type ? for help)${RESET}`);
        return;
    }
    myTurn = false;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  };

  banner();

  socket.on('connect', () => {
    write(`${GREEN}● connected${RESET} ${DIM}socketId=${socket.id}${RESET}`);
    socket.emit('session:start', { loungeId: args.loungeId });
  });

  socket.on('connect_error', (err: Error) => {
    write(`${RED}● connect_error: ${err.message}${RESET}`);
  });

  socket.on('disconnect', (reason: string) => {
    write(`${YELLOW}● disconnected: ${reason}${RESET}`);
  });

  socket.on('session:state', (state: unknown) => {
    const s = state as {
      session?: { id: string; loungeId: string; handsPlayed: number };
      table?: { config?: { defaultBuyIn?: number }; players?: { id: string }[] };
    };
    lastTable = s.table;
    if (args.verbose) write(`${DIM}[session:state]${RESET} ${JSON.stringify(s)}`);
    if (!sat) {
      sat = true;
      const buyIn = args.buyIn ?? s.table?.config?.defaultBuyIn ?? 1000;
      write(`${CYAN}→ sitting down at seat ${args.seat} with buy-in ${buyIn}${RESET}`);
      socket.emit('session:sit_down', { loungeId: args.loungeId, seat: args.seat, buyIn });
    } else {
      const seated = (s.table?.players ?? []).length;
      write(`${DIM}joined session ${s.session?.id?.slice(0, 8)}; ${seated} player(s) seated${RESET}`);
    }
  });

  socket.on('session:player_joined', (p: { userId: string; seat: number; stack: number }) => {
    const tag = p.userId === myUserId ? `${GREEN}(you)${RESET}` : '';
    write(`${CYAN}+ player joined${RESET} seat=${p.seat} stack=${p.stack} ${DIM}${p.userId.slice(0, 8)}${RESET} ${tag}`);
    write(`${DIM}(type ${BOLD}s${RESET}${DIM} when ready to deal a hand)${RESET}`);
  });
  socket.on('session:player_left', (p: { userId: string; reason: string }) => {
    write(`${YELLOW}- player left${RESET} ${DIM}${p.userId.slice(0, 8)}${RESET} reason=${p.reason}`);
  });
  socket.on('session:player_status', (p: { userId: string; status: string }) => {
    write(`${DIM}● ${p.userId.slice(0, 8)} status=${p.status}${RESET}`);
  });

  socket.on('hand:event', (evt: { type: string; [k: string]: unknown }) => {
    if (args.verbose) {
      write(`${DIM}[${evt.type}]${RESET} ${JSON.stringify(evt)}`);
    }
    switch (evt.type) {
      case 'hand_started':
        write(`${MAGENTA}${BOLD}── hand #${evt.handNumber} started ──${RESET}`);
        break;
      case 'blinds_posted': {
        const sb = evt.smallBlind as { playerId: string; amount: number } | null;
        const bb = evt.bigBlind as { playerId: string; amount: number };
        if (sb) write(`  ${DIM}SB ${sb.amount} from ${sb.playerId.slice(0, 8)}${RESET}`);
        write(`  ${DIM}BB ${bb.amount} from ${bb.playerId.slice(0, 8)}${RESET}`);
        break;
      }
      case 'hole_cards_dealt': {
        const cards = evt.cards as [Card, Card] | null;
        if (cards) {
          write(`${BOLD}${GREEN}your hole cards:${RESET} ${fmtCards(cards)}`);
        }
        break;
      }
      case 'board_dealt': {
        const cards = evt.cards as Card[];
        write(`${BOLD}${evt.phase}:${RESET} ${fmtCards(cards)}`);
        break;
      }
      case 'action_taken': {
        const a = evt.action as { type: string; amount?: number };
        const who = (evt.playerId as string) === myUserId ? `${GREEN}you${RESET}` : (evt.playerId as string).slice(0, 8);
        const amt = a.amount ? ` ${a.amount}` : '';
        write(`  ${who} ${a.type}${amt}`);
        break;
      }
      case 'showdown': {
        const reveals = evt.reveals as { playerId: string; cards: [Card, Card]; handDescription: string }[];
        write(`${BOLD}${MAGENTA}showdown:${RESET}`);
        for (const r of reveals) {
          const who = r.playerId === myUserId ? `${GREEN}you${RESET}` : r.playerId.slice(0, 8);
          write(`  ${who} ${fmtCards(r.cards)} — ${r.handDescription}`);
        }
        break;
      }
      case 'pot_awarded': {
        const winners = evt.winners as { playerId: string; amount: number }[];
        for (const w of winners) {
          const who = w.playerId === myUserId ? `${GREEN}you${RESET}` : w.playerId.slice(0, 8);
          write(`  ${BOLD}${YELLOW}+${w.amount} chips → ${who}${RESET}`);
        }
        break;
      }
      case 'phase_changed':
      case 'action_required':
      case 'ante_posted':
      case 'player_eliminated':
        // already covered by other events or quiet by default
        break;
      case 'hand_complete':
        // handled by the dedicated handler below
        break;
      default:
        if (!args.verbose) write(`${DIM}[${evt.type}]${RESET}`);
    }
  });

  socket.on('hand:your_turn', (p: { deadlineMs: number; legalActions: LegalActions }) => {
    myTurn = true;
    lastLegal = p.legalActions;
    const remaining = (): number => Math.max(0, Math.ceil((p.deadlineMs - Date.now()) / 1000));
    const hints: string[] = [];
    if (p.legalActions.canCheck) hints.push(`${BOLD}c${RESET}=check`);
    else if (p.legalActions.canCall) hints.push(`${BOLD}c${RESET}=call ${p.legalActions.callAmount}`);
    if (p.legalActions.canBet) hints.push(`${BOLD}b <n>${RESET}=bet (min ${p.legalActions.minBet})`);
    if (p.legalActions.canRaise)
      hints.push(`${BOLD}r <n>${RESET}=raise (${p.legalActions.minRaise}..${p.legalActions.maxRaise})`);
    if (p.legalActions.canFold) hints.push(`${BOLD}f${RESET}=fold`);
    hints.push(`${BOLD}a${RESET}=all-in`);
    write('');
    write(`${BOLD}${YELLOW}━━━ YOUR TURN ━━━${RESET}  ${DIM}${remaining()}s${RESET}`);
    write('  ' + hints.join('  '));

    if (args.bot) {
      const la = p.legalActions;
      const action = la.canCheck
        ? { type: 'check' as const }
        : la.canCall
          ? { type: 'call' as const }
          : { type: 'fold' as const };
      socket.emit('hand:action', { loungeId: args.loungeId, action });
      myTurn = false;
      return;
    }

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      if (!myTurn) {
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = null;
        return;
      }
      const s = remaining();
      if (s <= 5) {
        process.stdout.write(`\r${YELLOW}  ⏳ ${s}s remaining...${RESET}  `);
      }
    }, 1000);
  });

  socket.on('hand:complete', (p: { summary: { handNumber: number; potTotal: number } }) => {
    myTurn = false;
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    write('');
    write(`${MAGENTA}${BOLD}── hand #${p.summary.handNumber} complete (pot ${p.summary.potTotal}) ──${RESET}`);
    write(`${DIM}(type ${BOLD}s${RESET}${DIM} to deal the next hand, ${BOLD}p${RESET}${DIM} for table, ${BOLD}q${RESET}${DIM} to quit)${RESET}`);
  });

  socket.on('error', (e: { code?: string; message?: string }) => {
    write(`${RED}● error: ${e.code ?? '?'} — ${e.message ?? ''}${RESET}`);
  });

  if (!args.bot) {
    process.stdin.resume();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.on('line', (line: string) => {
      takeAction(line);
    });
    rl.on('close', () => {
      process.exit(0);
    });
  }
}

main().catch((err) => {
  write(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
