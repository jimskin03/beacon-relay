export type Position = Readonly<{ x: number; y: number }>;

export type PlayerState = Readonly<{
  id: string;
  position: Position;
}>;

export type BeaconState = Readonly<{
  id: 'northwest' | 'northeast' | 'south';
  position: Position;
  active: boolean;
}>;

export type Direction = 'north' | 'south' | 'west' | 'east';

export type PlayerAction =
  | Readonly<{ kind: 'move'; direction: Direction }>
  | Readonly<{ kind: 'pass' }>;

export type GameState = Readonly<{
  phase: 'playing' | 'won' | 'lost';
  round: number;
  maxRounds: number;
  board: Readonly<{ width: number; height: number; hub: Position }>;
  players: readonly PlayerState[];
  relays: readonly Position[];
  beacons: readonly BeaconState[];
}>;

const HUB = { x: 4, y: 4 } as const;

export function createInitialGame(playerIds: readonly string[]): GameState {
  if (playerIds.length < 2 || playerIds.length > 10) {
    throw new Error('Beacon Relay requires 2 to 10 players');
  }

  return {
    phase: 'playing',
    round: 1,
    maxRounds: 8,
    board: { width: 9, height: 9, hub: HUB },
    players: playerIds.map((id) => ({ id, position: HUB })),
    relays: [HUB],
    beacons: [
      { id: 'northwest', position: { x: 1, y: 1 }, active: false },
      { id: 'northeast', position: { x: 7, y: 1 }, active: false },
      { id: 'south', position: { x: 4, y: 7 }, active: false },
    ],
  };
}

const DIRECTION_DELTAS: Readonly<Record<Direction, Position>> = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
  east: { x: 1, y: 0 },
};

export function resolveRound(
  game: GameState,
  actions: Readonly<Record<string, PlayerAction>>,
): Readonly<{ state: GameState; events: readonly string[] }> {
  if (game.phase !== 'playing') {
    throw new Error('Only an active game can resolve a round');
  }

  const relays = [...game.relays];
  const relayKeys = new Set(relays.map(positionKey));
  const events: string[] = [];
  const nextPlayers = game.players.map((player) => {
    const action = actions[player.id] ?? { kind: 'pass' as const };
    if (action.kind === 'pass') return player;

    const delta = DIRECTION_DELTAS[action.direction];
    const target = {
      x: player.position.x + delta.x,
      y: player.position.y + delta.y,
    };
    if (
      target.x < 0 ||
      target.x >= game.board.width ||
      target.y < 0 ||
      target.y >= game.board.height
    ) {
      return player;
    }

    const key = positionKey(target);
    if (!relayKeys.has(key)) {
      relayKeys.add(key);
      relays.push(target);
    }
    events.push(`${titleCase(player.id)} moved ${action.direction} to ${cellLabel(target)}.`);
    return { ...player, position: target };
  });

  const connectedRelays = findConnectedRelays(relays, game.board.hub);
  const beacons = game.beacons.map((beacon) => {
    const active = connectedRelays.has(positionKey(beacon.position));
    if (active && !beacon.active) {
      events.push(`${titleCase(beacon.id)} beacon activated.`);
    }
    return { ...beacon, active };
  });
  const allBeaconsActive = beacons.every((beacon) => beacon.active);
  const phase: GameState['phase'] = allBeaconsActive
    ? 'won'
    : game.round >= game.maxRounds
      ? 'lost'
      : 'playing';
  if (phase === 'won') events.push('All beacons connected. Mission complete.');
  if (phase === 'lost') events.push('Relay window closed before all beacons connected.');

  return {
    state: {
      ...game,
      phase,
      round: phase === 'playing' ? game.round + 1 : game.round,
      players: nextPlayers,
      relays,
      beacons,
    },
    events,
  };
}

function findConnectedRelays(relays: readonly Position[], hub: Position): Set<string> {
  const relayKeys = new Set(relays.map(positionKey));
  const connected = new Set<string>();
  const queue: Position[] = [hub];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentKey = positionKey(current);
    if (connected.has(currentKey) || !relayKeys.has(currentKey)) continue;
    connected.add(currentKey);
    queue.push(
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    );
  }

  return connected;
}

function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

function cellLabel(position: Position): string {
  return `${String.fromCharCode(65 + position.x)}${position.y + 1}`;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
