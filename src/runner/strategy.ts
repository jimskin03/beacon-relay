export type RunnerAction =
  | Readonly<{ kind: 'move'; direction: 'north' | 'south' | 'west' | 'east' }>
  | Readonly<{ kind: 'pass' }>;

type Position = Readonly<{ x: number; y: number }>;
type PromptBeacon = Readonly<{
  id: string;
  position: Position;
  active: boolean;
}>;

type AgentPromptInput = Readonly<{
  pilotName: string;
  playerId: string;
  round: number;
  maxRounds: number;
  position: Position;
  beacons: readonly PromptBeacon[];
  agentBrief: unknown;
}>;
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

export function buildAgentPrompt(input: AgentPromptInput): string {
  return [
    'You are playing Beacon Relay as an autonomous pilot.',
    `Pilot: ${input.pilotName} (playerId: ${input.playerId}). Round: ${input.round}/${input.maxRounds}.`,
    `Position: ${input.position.x},${input.position.y}.`,
    `Beacons: ${input.beacons.map((beacon) => `${beacon.id}:${beacon.active ? 'active' : 'inactive'}@${beacon.position.x},${beacon.position.y}`).join('; ')}`,
    `AGENT_BRIEF_JSON: ${JSON.stringify(input.agentBrief)}`,
    'Follow the brief routing policy: solve locally by default; spawn only the named specialist when its condition applies.',
    'Choose exactly one legal action. Reply with only one lowercase word: north, south, east, west, or pass.',
  ].join('\n');
}
