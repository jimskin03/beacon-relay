import { describe, expect, it } from 'vitest';
import { createInitialGame, resolveRound } from '../src/server/game/engine.js';

const players = ['greg', 'aira', 'aixin', 'ainova', 'airis'];

describe('createInitialGame', () => {
  it('starts five drones at the hub with three inactive beacons', () => {
    const game = createInitialGame(players);

    expect(game.phase).toBe('playing');
    expect(game.round).toBe(1);
    expect(game.maxRounds).toBe(8);
    expect(game.board).toEqual({ width: 9, height: 9, hub: { x: 4, y: 4 } });
    expect(game.players.map((player) => player.id)).toEqual(players);
    expect(game.players.every((player) => player.position.x === 4 && player.position.y === 4)).toBe(true);
    expect(game.relays).toEqual([{ x: 4, y: 4 }]);
    expect(game.beacons).toEqual([
      { id: 'northwest', position: { x: 1, y: 1 }, active: false },
      { id: 'northeast', position: { x: 7, y: 1 }, active: false },
      { id: 'south', position: { x: 4, y: 7 }, active: false },
    ]);
  });
});

describe('resolveRound', () => {
  it('moves drones simultaneously and leaves shared relay trails', () => {
    const game = createInitialGame(players);

    const result = resolveRound(game, {
      greg: { kind: 'move', direction: 'north' },
      aira: { kind: 'move', direction: 'west' },
      aixin: { kind: 'pass' },
      ainova: { kind: 'pass' },
      airis: { kind: 'pass' },
    });

    expect(result.state.round).toBe(2);
    expect(result.state.players.find((player) => player.id === 'greg')?.position).toEqual({ x: 4, y: 3 });
    expect(result.state.players.find((player) => player.id === 'aira')?.position).toEqual({ x: 3, y: 4 });
    expect(result.state.relays).toEqual([
      { x: 4, y: 4 },
      { x: 4, y: 3 },
      { x: 3, y: 4 },
    ]);
    expect(result.events).toContain('Greg moved north to E4.');
  });

  it('wins when relay trails connect all three beacons', () => {
    let game = createInitialGame(players);
    const paths = {
      greg: ['west', 'west', 'west', 'north', 'north', 'north'],
      aira: ['east', 'east', 'east', 'north', 'north', 'north'],
      aixin: ['south', 'south', 'south', 'pass', 'pass', 'pass'],
    } as const;

    for (let step = 0; step < 6; step += 1) {
      const aixinStep = paths.aixin[step]!;
      game = resolveRound(game, {
        greg: { kind: 'move', direction: paths.greg[step]! },
        aira: { kind: 'move', direction: paths.aira[step]! },
        aixin: aixinStep === 'pass' ? { kind: 'pass' } : { kind: 'move', direction: aixinStep },
        ainova: { kind: 'pass' },
        airis: { kind: 'pass' },
      }).state;
    }

    expect(game.phase).toBe('won');
    expect(game.beacons.every((beacon) => beacon.active)).toBe(true);
  });
});
