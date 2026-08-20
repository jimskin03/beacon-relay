export type RunnerAction =
  | Readonly<{ kind: 'move'; direction: 'north' | 'south' | 'west' | 'east' }>
  | Readonly<{ kind: 'pass' }>;

type Position = Readonly<{ x: number; y: number }>;
type StrategyState = Readonly<{
  game: Readonly<{
    beacons: readonly Readonly<{
      id: string;
      position: Position;
      active: boolean;
    }>[];
  }>;
}>;

const PROFILE_TARGETS: Readonly<Record<string, string>> = {
  default: 'northwest',
  aira: 'northwest',
  aixin: 'northeast',
  ainova: 'south',
};

export function chooseFallbackAction(
  profile: string,
  position: Position,
  state: StrategyState,
): RunnerAction {
  const targetId = PROFILE_TARGETS[profile.toLowerCase()];
  if (!targetId) return { kind: 'pass' };
  const beacon = state.game.beacons.find((entry) => entry.id === targetId);
  if (!beacon || beacon.active) return { kind: 'pass' };

  if (targetId === 'northwest') {
    if (position.x > beacon.position.x) return { kind: 'move', direction: 'west' };
    if (position.y > beacon.position.y) return { kind: 'move', direction: 'north' };
  }
  if (targetId === 'northeast') {
    if (position.x < beacon.position.x) return { kind: 'move', direction: 'east' };
    if (position.y > beacon.position.y) return { kind: 'move', direction: 'north' };
  }
  if (targetId === 'south' && position.y < beacon.position.y) {
    return { kind: 'move', direction: 'south' };
  }
  return { kind: 'pass' };
}

export function parseHermesDecision(output: string): RunnerAction | null {
  const decision = output.trim().toLowerCase();
  if (decision === 'pass') return { kind: 'pass' };
  if (decision === 'north' || decision === 'south' || decision === 'west' || decision === 'east') {
    return { kind: 'move', direction: decision };
  }
  return null;
}
