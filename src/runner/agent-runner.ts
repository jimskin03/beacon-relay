import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import {
  buildAgentPrompt,
  chooseFallbackAction,
  parseHermesDecision,
  type RunnerAction,
} from './strategy.js';

const execFileAsync = promisify(execFile);

type Session = Readonly<{
  roomCode: string;
  playerId: string;
  token: string;
}>;

type Snapshot = Readonly<{
  phase: 'lobby' | 'playing' | 'finished';
  players: readonly Readonly<{ id: string; name: string }>[];
  game: null | Readonly<{
    phase: 'playing' | 'won' | 'lost';
    round: number;
    maxRounds: number;
    players: readonly Readonly<{ id: string; position: Readonly<{ x: number; y: number }> }>[];
    beacons: readonly Readonly<{
      id: string;
      position: Readonly<{ x: number; y: number }>;
      active: boolean;
    }>[];
  }>;
  submittedPlayerIds: readonly string[];
  roundDeadlineAt: number | null;
  agentBrief: unknown;
}>;

type Config = Readonly<{
  profile: string;
  pilotName: string;
  inviteUrl: string;
  decisionMode: 'hermes' | 'fallback';
}>;

const config = parseConfig(process.argv.slice(2));
const invite = new URL(config.inviteUrl);
const roomCode = invite.searchParams.get('room');
const inviteToken = new URLSearchParams(invite.hash.slice(1)).get('invite');
if (!roomCode || !inviteToken) throw new Error('Invite URL must include room and invite token');
const origin = invite.origin;
const sessionPath = join(homedir(), '.hermes', 'beacon-relay', roomCode, `${config.profile}.json`);
const session = await loadOrJoinSession(sessionPath, roomCode, inviteToken);
let socket: WebSocket | null = null;
let decidingRound: number | null = null;
let finished = false;
let reconnectTimer: NodeJS.Timeout | null = null;

connect();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function connect(): void {
  const websocketUrl = `${origin.replace(/^http/, 'ws')}/ws`;
  socket = new WebSocket(websocketUrl, { headers: { Origin: origin } });
  socket.on('open', () => {
    socket?.send(JSON.stringify({ type: 'authenticate', token: session.token }));
    console.log(`[${config.profile}] connected as ${config.pilotName}`);
  });
  socket.on('message', (data) => {
    void handleMessage(data.toString());
  });
  socket.on('error', (error) => {
    console.error(`[${config.profile}] websocket error: ${error.message}`);
  });
  socket.on('close', () => {
    if (finished) return;
    console.log(`[${config.profile}] disconnected; reconnecting`);
    reconnectTimer = setTimeout(connect, 2_000);
  });
}

async function handleMessage(raw: string): Promise<void> {
  let message: any;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message.type === 'error') {
    console.error(`[${config.profile}] server rejected action: ${message.message ?? message.code}`);
    decidingRound = null;
    return;
  }
  if (message.type !== 'snapshot' && message.type !== 'action_accepted') return;
  const snapshot = message.snapshot as Snapshot;
  if (snapshot.phase === 'finished' || snapshot.game?.phase === 'won' || snapshot.game?.phase === 'lost') {
    finished = true;
    console.log(`[${config.profile}] game finished: ${snapshot.game?.phase ?? 'finished'}`);
    socket?.close(1000, 'game finished');
    return;
  }
  if (!snapshot.game || snapshot.phase !== 'playing') return;
  const round = snapshot.game.round;
  if (snapshot.submittedPlayerIds.includes(session.playerId)) {
    decidingRound = round;
    return;
  }
  if (decidingRound === round) return;
  decidingRound = round;

  const ownPlayer = snapshot.game.players.find((player) => player.id === session.playerId);
  if (!ownPlayer) throw new Error('Authenticated player is missing from game state');
  const fallback = chooseFallbackAction(config.profile, ownPlayer.position, snapshot as any);
  const action = await decideAction(snapshot, ownPlayer.position, fallback);
  if (finished || snapshot.game.round !== round || socket?.readyState !== WebSocket.OPEN) {
    decidingRound = null;
    return;
  }
  socket.send(
    JSON.stringify({
      type: 'submit_action',
      requestId: `${config.profile}-${round}-${randomUUID()}`,
      round,
      action,
    }),
  );
  console.log(`[${config.profile}] round ${round} -> ${action.kind === 'pass' ? 'pass' : action.direction}`);
}

async function decideAction(
  snapshot: Snapshot,
  position: Readonly<{ x: number; y: number }>,
  fallback: RunnerAction,
): Promise<RunnerAction> {
  if (config.decisionMode === 'fallback') return fallback;
  if (!snapshot.game) return fallback;
  const prompt = buildAgentPrompt({
    pilotName: config.pilotName,
    playerId: session.playerId,
    round: snapshot.game.round,
    maxRounds: snapshot.game.maxRounds,
    position,
    beacons: snapshot.game.beacons,
    agentBrief: snapshot.agentBrief,
  });
  try {
    const { stdout } = await execFileAsync(
      'hermes',
      ['-p', config.profile, 'chat', '-q', prompt],
      { timeout: 20_000, maxBuffer: 256 * 1024 },
    );
    return parseHermesDecision(stdout) ?? fallback;
  } catch (error) {
    console.error(`[${config.profile}] Hermes decision timed out; using deterministic fallback`);
    return fallback;
  }
}

async function loadOrJoinSession(
  path: string,
  code: string,
  token: string,
): Promise<Session> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Session;
  } catch {
    const response = await fetch(`${origin}/api/rooms/${encodeURIComponent(code)}/invite-join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerName: config.pilotName, inviteToken: token }),
    });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(body.error ?? 'Unable to redeem invite');
    const joined: Session = {
      roomCode: body.roomCode,
      playerId: body.playerId,
      token: body.token,
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(joined), { encoding: 'utf8', mode: 0o600 });
    return joined;
  }
}

function parseConfig(args: readonly string[]): Config {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Arguments must be --key value pairs');
    values.set(key.slice(2), value);
  }
  const profile = values.get('profile');
  const pilotName = values.get('name');
  const inviteUrl = values.get('invite');
  const decisionMode = values.get('decision') ?? 'hermes';
  if (!profile || !pilotName || !inviteUrl) {
    throw new Error('Usage: agent-runner --profile PROFILE --name NAME --invite URL [--decision hermes|fallback]');
  }
  if (decisionMode !== 'hermes' && decisionMode !== 'fallback') {
    throw new Error('Decision mode must be hermes or fallback');
  }
  return { profile, pilotName, inviteUrl, decisionMode };
}

function shutdown(): void {
  finished = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close(1000, 'runner stopped');
}
