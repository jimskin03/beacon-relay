import { describe, expect, it } from 'vitest';
import { chooseFallbackAction, parseHermesDecision } from '../src/runner/strategy.js';

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
});
