import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createInitialGame,
  resolveRound,
  type GameState,
  type PlayerAction,
} from '../game/engine.js';

const scrypt = promisify(scryptCallback);
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
const DEFAULT_ROUND_DURATION_MS = 45_000;

export type RoomPlayer = Readonly<{
  id: string;
  name: string;
}>;

export type RoomSnapshot = Readonly<{
  roomCode: string;
  hostId: string;
  minPlayers: number;
  maxPlayers: number;
  phase: 'lobby' | 'playing' | 'finished';
  players: readonly RoomPlayer[];
  game: GameState | null;
  submittedPlayerIds: readonly string[];
  connectedPlayerIds: readonly string[];
  lastTimedOutPlayerIds: readonly string[];
  roundDeadlineAt: number | null;
  events: readonly string[];
  agentBrief: AgentBrief;
}>;

export type AgentBrief = Readonly<{
  schemaVersion: 1;
  audience: 'autonomous-agent';
  state: Readonly<{
    phase: 'lobby' | 'playing' | 'finished';
    board: Readonly<{ width: number; height: number; hub: string }>;
    round: number | null;
    maxRounds: number;
    roundDeadlineAt: number | null;
    you: Readonly<{ playerId: string }>;
    roster: Readonly<{
      seatedCount: number;
      onlineCount: number;
      summary: string;
    }>;
    offlineAutoPassWarning: string;
    offlineSeats: string;
  }>;
  objective: string;
  rules: readonly string[];
  routing: Readonly<{
    default: 'solve-locally';
    navigator: 'spawn-only-for-nontrivial-move-choice';
    observer: 'spawn-only-to-validate-ambiguous-state';
    coordinator: 'spawn-only-when-managing-multiple-agent-pilots';
  }>;
  actionContract: Readonly<{
    messageType: 'submit_action';
    requestId: string;
    legalActionWords: readonly ['north', 'south', 'east', 'west', 'pass'];
    reconnect: string;
    moveExample: Readonly<{ type: 'submit_action'; round: string; action: Readonly<{ kind: 'move'; direction: 'north' }> }>;
    passExample: Readonly<{ type: 'submit_action'; round: string; action: Readonly<{ kind: 'pass' }> }>;
  }>;
}>;

const AGENT_OBJECTIVE =
  'Cooperatively move pilots so that the cells holding all three beacons (northwest B2, northeast H2, south E8) are relay-connected (orthogonally adjacent chain of occupied relay cells) to the central hub E5 within 8 rounds. The mission is won the moment all three beacons are active.';

const AGENT_RULES: readonly string[] = [
  'Each round every seated pilot submits exactly one action; the round resolves as soon as all seated pilots have submitted or the round deadline expires.',
  'A "move" action shifts your pilot one cell north/south/west/east; moves off the board are ignored (you stay put). Every cell a pilot has ever occupied becomes a permanent relay cell; beacons activate when their cell joins the hub-connected relay network.',
  'If you do not submit before the deadline you automatically pass (no movement) and the round still resolves — offline pilots auto-pass each round until they reconnect.',
  'Read your own position from snapshot.game.players by matching your playerId; snapshot.submittedPlayerIds shows who has already locked an action this round.',
];

function agentBriefFor(
  room: Pick<Room, 'game' | 'players' | 'connectedPlayerIds' | 'roundDeadlineAt'>,
  playerId: string,
): AgentBrief {
  const seated = room.players.length;
  const online = room.players.filter((player) => room.connectedPlayerIds.has(player.id)).length;
  const offline = seated - online;
  const phase: AgentBrief['state']['phase'] = room.game
    ? room.game.phase === 'playing'
      ? 'playing'
      : 'finished'
    : 'lobby';
  return {
    schemaVersion: 1,
    audience: 'autonomous-agent',
    state: {
      phase,
      board: { width: 9, height: 9, hub: 'E5' },
      round: room.game?.round ?? null,
      maxRounds: room.game?.maxRounds ?? 8,
      roundDeadlineAt: room.roundDeadlineAt,
      you: { playerId },
      roster: {
        seatedCount: seated,
        onlineCount: online,
        summary: `${seated} seated · ${online} online`,
      },
      offlineAutoPassWarning:
        offline > 0
          ? `${offline} offline ${offline === 1 ? 'pilot' : 'pilots'} will auto-pass each round until they reconnect.`
          : 'All seated pilots are online.',
      offlineSeats:
        'Seats are never freed mid-game; a disconnected player\'s drone simply passes.',
    },
    objective: AGENT_OBJECTIVE,
    rules: [...AGENT_RULES],
    routing: {
      default: 'solve-locally',
      navigator: 'spawn-only-for-nontrivial-move-choice',
      observer: 'spawn-only-to-validate-ambiguous-state',
      coordinator: 'spawn-only-when-managing-multiple-agent-pilots',
    },
    actionContract: {
      messageType: 'submit_action',
      requestId: 'unique-per-attempt, e.g. crypto.randomUUID(); duplicates are ignored safely',
      legalActionWords: ['north', 'south', 'east', 'west', 'pass'],
      reconnect:
        'Players without a live connection auto-pass at each round deadline until they reconnect. Reconnect: reload with your saved token and re-authenticate over WebSocket.',
      moveExample: {
        type: 'submit_action',
        round: '<snapshot.game.round>',
        action: { kind: 'move', direction: 'north' },
      },
      passExample: {
        type: 'submit_action',
        round: '<snapshot.game.round>',
        action: { kind: 'pass' },
      },
    },
  };
}

type StoredPassword = Readonly<{
  salt: Buffer;
  digest: Buffer;
}>;

type Room = {
  code: string;
  hostId: string;
  password: StoredPassword;
  players: RoomPlayer[];
  tokens: Map<string, string>;
  invites: Set<string>;
  game: GameState | null;
  pendingActions: Map<string, PlayerAction>;
  processedRequests: Set<string>;
  connectedPlayerIds: Set<string>;
  lastTimedOutPlayerIds: string[];
  roundDeadlineAt: number | null;
  events: string[];
};

type Session = Readonly<{
  roomCode: string;
  playerId: string;
}>;

type JoinResult = Readonly<{
  roomCode: string;
  playerId: string;
  token: string;
  snapshot: RoomSnapshot;
}>;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, Session>();
  private readonly roundDurationMs: number;
  private readonly now: () => number;

  constructor(
    options: Readonly<{ roundDurationMs?: number; now?: () => number }> = {},
  ) {
    this.roundDurationMs = options.roundDurationMs ?? DEFAULT_ROUND_DURATION_MS;
    this.now = options.now ?? Date.now;
  }

  async createRoom(input: Readonly<{ hostName: string; password: string }>): Promise<JoinResult> {
    const code = randomBytes(12).toString('base64url');
    const password = await hashPassword(input.password);
    const host = createPlayer(input.hostName);
    const token = createToken();
    const room: Room = {
      code,
      hostId: host.id,
      password,
      players: [host],
      tokens: new Map([[token, host.id]]),
      invites: new Set(),
      game: null,
      pendingActions: new Map(),
      processedRequests: new Set(),
      connectedPlayerIds: new Set(),
      lastTimedOutPlayerIds: [],
      roundDeadlineAt: null,
      events: [],
    };
    this.rooms.set(code, room);
    this.sessions.set(token, { roomCode: code, playerId: host.id });
    return resultFor(room, host, token);
  }

  async joinRoom(
    input: Readonly<{ roomCode: string; playerName: string; password: string }>,
  ): Promise<JoinResult> {
    const room = this.rooms.get(input.roomCode);
    if (!room || !(await verifyPassword(input.password, room.password))) {
      throw new Error('Invalid room code or password');
    }
    if (room.game) throw new Error('Game already started');
    if (room.players.length >= MAX_PLAYERS) {
      throw new Error('Room is full');
    }

    const player = createPlayer(input.playerName);
    const token = createToken();
    room.players.push(player);
    room.tokens.set(token, player.id);
    this.sessions.set(token, { roomCode: room.code, playerId: player.id });
    return resultFor(room, player, token);
  }

  startGame(input: Readonly<{ token: string }>): RoomSnapshot {
    const { room, session } = this.requireSession(input.token);
    if (session.playerId !== room.hostId) {
      throw new Error('Only the room host can start the game');
    }
    if (room.game) throw new Error('Game already started');
    if (room.players.length < MIN_PLAYERS) {
      throw new Error(`At least ${MIN_PLAYERS} players are required`);
    }
    this.startRoom(room);
    return snapshotFor(room, session.playerId);
  }

  submitAction(
    input: Readonly<{
      token: string;
      requestId: string;
      round: number;
      action: PlayerAction;
    }>,
  ): Readonly<{ duplicate: boolean; resolved: boolean; snapshot: RoomSnapshot }> {
    const { room, session } = this.requireSession(input.token);
    if (!room.game || room.game.phase !== 'playing') {
      throw new Error('Room is not accepting actions');
    }
    if (input.round !== room.game.round) {
      throw new Error(`Stale round; current round is ${room.game.round}`);
    }
    const requestKey = `${session.playerId}:${input.requestId}`;
    if (room.processedRequests.has(requestKey)) {
      return { duplicate: true, resolved: false, snapshot: snapshotFor(room, session.playerId) };
    }

    room.processedRequests.add(requestKey);
    room.pendingActions.set(session.playerId, input.action);
    let resolved = false;
    if (room.pendingActions.size === room.players.length) {
      this.resolveRoom(room, []);
      resolved = true;
    }
    return { duplicate: false, resolved, snapshot: snapshotFor(room, session.playerId) };
  }

  snapshotForToken(token: string): RoomSnapshot {
    const { room, session } = this.requireSession(token);
    return snapshotFor(room, session.playerId);
  }

  setConnected(token: string, connected: boolean): RoomSnapshot {
    const { room, session } = this.requireSession(token);
    if (connected) room.connectedPlayerIds.add(session.playerId);
    else room.connectedPlayerIds.delete(session.playerId);
    return snapshotFor(room, session.playerId);
  }

  resolveExpiredRooms(): readonly Readonly<{ roomCode: string; snapshot: RoomSnapshot }>[] {
    const resolved: Array<Readonly<{ roomCode: string; snapshot: RoomSnapshot }>> = [];
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (
        !room.game ||
        room.game.phase !== 'playing' ||
        room.roundDeadlineAt === null ||
        room.roundDeadlineAt > now
      ) {
        continue;
      }
      const timedOutPlayerIds = room.players
        .map((player) => player.id)
        .filter((playerId) => !room.pendingActions.has(playerId));
      this.resolveRoom(room, timedOutPlayerIds);
      resolved.push({ roomCode: room.code, snapshot: snapshotFor(room) });
    }
    return resolved;
  }

  authenticateToken(token: string): Readonly<{ playerId: string; snapshot: RoomSnapshot }> {
    const { room, session } = this.requireSession(token);
    return { playerId: session.playerId, snapshot: snapshotFor(room) };
  }

  createInvite(input: Readonly<{ token: string }>): Readonly<{ inviteToken: string }> {
    const { room, session } = this.requireSession(input.token);
    if (session.playerId !== room.hostId) {
      throw new Error('Only the room host can create invites');
    }
    if (room.game) throw new Error('Game already started');
    if (room.players.length >= MAX_PLAYERS) throw new Error('Room is full');
    const inviteToken = createToken();
    room.invites.add(inviteToken);
    return { inviteToken };
  }

  redeemInvite(
    input: Readonly<{ roomCode: string; inviteToken: string; playerName: string }>,
  ): JoinResult {
    const room = this.rooms.get(input.roomCode);
    if (!room || !room.invites.delete(input.inviteToken)) {
      throw new Error('Invalid or expired invite');
    }
    if (room.game) throw new Error('Game already started');
    if (room.players.length >= MAX_PLAYERS) throw new Error('Room is full');

    const player = createPlayer(input.playerName);
    const token = createToken();
    room.players.push(player);
    room.tokens.set(token, player.id);
    this.sessions.set(token, { roomCode: room.code, playerId: player.id });
    return resultFor(room, player, token);
  }

  private startRoom(room: Room): void {
    room.game = createInitialGame(room.players.map((entry) => entry.id));
    room.roundDeadlineAt = this.now() + this.roundDurationMs;
    room.lastTimedOutPlayerIds = [];
    room.events = [`${room.players.length} relay pilots ready. Round 1 started.`];
  }

  private resolveRoom(room: Room, timedOutPlayerIds: readonly string[]): void {
    if (!room.game) return;
    for (const playerId of timedOutPlayerIds) {
      room.pendingActions.set(playerId, { kind: 'pass' });
    }
    const result = resolveRound(room.game, Object.fromEntries(room.pendingActions));
    room.game = result.state;
    room.lastTimedOutPlayerIds = [...timedOutPlayerIds];
    room.events = [...result.events];
    if (timedOutPlayerIds.length > 0) {
      room.events.push(
        `${timedOutPlayerIds.length} ${timedOutPlayerIds.length === 1 ? 'pilot' : 'pilots'} timed out and automatically passed.`,
      );
    }
    room.pendingActions.clear();
    room.roundDeadlineAt = room.game.phase === 'playing' ? this.now() + this.roundDurationMs : null;
  }

  private requireSession(token: string): Readonly<{ room: Room; session: Session }> {
    const session = this.sessions.get(token);
    const room = session ? this.rooms.get(session.roomCode) : undefined;
    if (!session || !room) throw new Error('Invalid session token');
    return { room, session };
  }
}

function createPlayer(name: string): RoomPlayer {
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 24) {
    throw new Error('Player name must contain 1 to 24 characters');
  }
  return { id: randomUUID(), name: trimmedName };
}

function createToken(): string {
  return randomBytes(24).toString('base64url');
}

function resultFor(room: Room, player: RoomPlayer, token: string): JoinResult {
  return {
    roomCode: room.code,
    playerId: player.id,
    token,
    snapshot: snapshotFor(room, player.id),
  };
}

function snapshotFor(room: Room, playerId = ''): RoomSnapshot {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    phase: room.game ? (room.game.phase === 'playing' ? 'playing' : 'finished') : 'lobby',
    players: room.players.map((entry) => ({ ...entry })),
    game: room.game,
    submittedPlayerIds: [...room.pendingActions.keys()],
    connectedPlayerIds: [...room.connectedPlayerIds],
    lastTimedOutPlayerIds: [...room.lastTimedOutPlayerIds],
    roundDeadlineAt: room.roundDeadlineAt,
    events: [...room.events],
    agentBrief: agentBriefFor(room, playerId),
  };
}

async function hashPassword(password: string): Promise<StoredPassword> {
  if (password.length < 8 || password.length > 128) {
    throw new Error('Room password must contain 8 to 128 characters');
  }
  const salt = randomBytes(16);
  const digest = (await scrypt(password, salt, 64)) as Buffer;
  return { salt, digest };
}

async function verifyPassword(password: string, stored: StoredPassword): Promise<boolean> {
  const digest = (await scrypt(password, stored.salt, stored.digest.length)) as Buffer;
  return digest.length === stored.digest.length && timingSafeEqual(digest, stored.digest);
}
