import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createInitialGame,
  resolveRound,
  type GameState,
  type PlayerAction,
} from '../game/engine.js';

const scrypt = promisify(scryptCallback);
const MAX_PLAYERS = 5;

export type RoomPlayer = Readonly<{
  id: string;
  name: string;
}>;

export type RoomSnapshot = Readonly<{
  roomCode: string;
  phase: 'lobby' | 'playing' | 'finished';
  players: readonly RoomPlayer[];
  game: GameState | null;
  submittedPlayerIds: readonly string[];
  events: readonly string[];
}>;

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
    if (room.players.length >= MAX_PLAYERS) {
      throw new Error('Room is full');
    }

    const player = createPlayer(input.playerName);
    const token = createToken();
    room.players.push(player);
    room.tokens.set(token, player.id);
    this.sessions.set(token, { roomCode: room.code, playerId: player.id });
    if (room.players.length === MAX_PLAYERS) {
      room.game = createInitialGame(room.players.map((entry) => entry.id));
      room.events = ['All five relay pilots connected. Round 1 started.'];
    }
    return resultFor(room, player, token);
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
      return { duplicate: true, resolved: false, snapshot: snapshotFor(room) };
    }

    room.processedRequests.add(requestKey);
    room.pendingActions.set(session.playerId, input.action);
    let resolved = false;
    if (room.pendingActions.size === MAX_PLAYERS) {
      const result = resolveRound(room.game, Object.fromEntries(room.pendingActions));
      room.game = result.state;
      room.events = [...result.events];
      room.pendingActions.clear();
      resolved = true;
    }
    return { duplicate: false, resolved, snapshot: snapshotFor(room) };
  }

  snapshotForToken(token: string): RoomSnapshot {
    return snapshotFor(this.requireSession(token).room);
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
    if (room.players.length >= MAX_PLAYERS) throw new Error('Room is full');

    const player = createPlayer(input.playerName);
    const token = createToken();
    room.players.push(player);
    room.tokens.set(token, player.id);
    this.sessions.set(token, { roomCode: room.code, playerId: player.id });
    if (room.players.length === MAX_PLAYERS) {
      room.game = createInitialGame(room.players.map((entry) => entry.id));
      room.events = ['All five relay pilots connected. Round 1 started.'];
    }
    return resultFor(room, player, token);
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
    snapshot: snapshotFor(room),
  };
}

function snapshotFor(room: Room): RoomSnapshot {
  return {
    roomCode: room.code,
    phase: room.game ? (room.game.phase === 'playing' ? 'playing' : 'finished') : 'lobby',
    players: room.players.map((entry) => ({ ...entry })),
    game: room.game,
    submittedPlayerIds: [...room.pendingActions.keys()],
    events: [...room.events],
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
