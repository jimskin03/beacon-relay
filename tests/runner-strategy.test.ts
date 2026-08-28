import { describe, expect, it } from 'vitest';
import {
  buildAgentPrompt,
  chooseFallbackAction,
  parseHermesDecision,
} from '../src/runner/strategy.js';

const state = {
  game: {
    beacons: [
      { id: 'northwest', position: { x: 1, y: 1 }, active: false },
      { id: 'northeast', position: { x: 7, y: 1 }, active: false },
      { id: 'south', position: { x: 4, y: 7 }, active: false },
    ],
  },
};

describe('persistent runner strategy', () => {
  it('gives each Hermes profile a distinct deterministic relay assignment', () => {
    expect(chooseFallbackAction('default', { x: 4, y: 4 }, state)).toEqual({
      kind: 'move',
      direction: 'west',
    });
    expect(chooseFallbackAction('aixin', { x: 4, y: 4 }, state)).toEqual({
      kind: 'move',
      direction: 'east',
    });
    expect(chooseFallbackAction('ainova', { x: 4, y: 4 }, state)).toEqual({
      kind: 'move',
      direction: 'south',
    });
    expect(chooseFallbackAction('airis', { x: 4, y: 4 }, state)).toEqual({ kind: 'pass' });
  });

  it('accepts a strict action word from a Hermes decision and rejects prose ambiguity', () => {
    expect(parseHermesDecision('north')).toEqual({ kind: 'move', direction: 'north' });
    expect(parseHermesDecision('PASS')).toEqual({ kind: 'pass' });
    expect(parseHermesDecision('I might move north or west')).toBeNull();
  });

  it('injects the machine mission brief and own identity into each decision prompt', () => {
    const prompt = buildAgentPrompt({
      pilotName: 'A.Ira',
      playerId: 'pilot-1',
      round: 2,
      maxRounds: 8,
      position: { x: 4, y: 4 },
      beacons: state.game.beacons,
      agentBrief: {
        schemaVersion: 1,
        objective: 'Connect every beacon to the hub.',
        routing: { default: 'solve-locally', navigator: 'spawn-only' },
        actionContract: { legalActionWords: ['north', 'south', 'east', 'west', 'pass'] },
      },
    });

    expect(prompt).toContain('Pilot: A.Ira (playerId: pilot-1)');
    expect(prompt).toContain('"objective":"Connect every beacon to the hub."');
    expect(prompt).toContain('"default":"solve-locally"');
    expect(prompt).toContain('Reply with only one lowercase word');
  });
});
