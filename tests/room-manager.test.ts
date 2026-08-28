import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/server/rooms/room-manager.js';

describe('RoomManager authentication', () => {
  it('creates a private room and rejects an incorrect password', async () => {
    const manager = new RoomManager();
    const created = await manager.createRoom({ hostName: 'Greg', password: 'correct horse' });

    expect(created.roomCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(created.token.length).toBeGreaterThanOrEqual(32);
    expect(created.snapshot.players.map((player) => player.name)).toEqual(['Greg']);

    await expect(
      manager.joinRoom({
        roomCode: created.roomCode,
        playerName: 'A.Ira',
        password: 'wrong battery',
      }),
    ).rejects.toThrow('Invalid room code or password');

    const joined = await manager.joinRoom({
      roomCode: created.roomCode,
      playerName: 'A.Ira',
      password: 'correct horse',
    });
    expect(joined.snapshot.players.map((player) => player.name)).toEqual(['Greg', 'A.Ira']);
  });

  it('lets the host start with two players and resolves after the current crew submits', async () => {
    const manager = new RoomManager();
    const sessions = [
      await manager.createRoom({ hostName: 'Greg', password: 'correct horse' }),
    ];
    sessions.push(
      await manager.joinRoom({
        roomCode: sessions[0]!.roomCode,
        playerName: 'A.Ira',
        password: 'correct horse',
      }),
    );

    expect(sessions[1]!.snapshot.phase).toBe('lobby');
    expect(manager.startGame({ token: sessions[0]!.token }).game?.round).toBe(1);

    const first = manager.submitAction({
      token: sessions[0]!.token,
      requestId: 'greg-round-1',
      round: 1,
      action: { kind: 'move', direction: 'north' },
    });
    const duplicate = manager.submitAction({
      token: sessions[0]!.token,
      requestId: 'greg-round-1',
      round: 1,
      action: { kind: 'move', direction: 'south' },
    });
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.snapshot.submittedPlayerIds).toHaveLength(1);

    const resolved = manager.submitAction({
      token: sessions[1]!.token,
      requestId: `${sessions[1]!.playerId}-round-1`,
      round: 1,
      action: { kind: 'pass' },
    });
    expect(resolved.resolved).toBe(true);

    const snapshot = manager.snapshotForToken(sessions[0]!.token);
    expect(snapshot.game?.round).toBe(2);
    expect(snapshot.game?.players.find((player) => player.id === sessions[0]!.playerId)?.position).toEqual({
      x: 4,
      y: 3,
    });
    expect(snapshot.submittedPlayerIds).toEqual([]);
  });

  it('enforces host-only starts, a two-player minimum, and a ten-player maximum', async () => {
    const manager = new RoomManager();
    const host = await manager.createRoom({ hostName: 'Greg', password: 'correct horse' });
    expect(host.snapshot).toMatchObject({
      hostId: host.playerId,
      minPlayers: 2,
      maxPlayers: 10,
    });
    expect(() => manager.startGame({ token: host.token })).toThrow('At least 2 players are required');

    let nonHostToken = '';
    for (let index = 2; index <= 10; index += 1) {
      const joined = await manager.joinRoom({
        roomCode: host.roomCode,
        playerName: `Pilot ${index}`,
        password: 'correct horse',
      });
      nonHostToken ||= joined.token;
      expect(joined.snapshot.phase).toBe('lobby');
    }

    await expect(
      manager.joinRoom({
        roomCode: host.roomCode,
        playerName: 'Pilot 11',
        password: 'correct horse',
      }),
    ).rejects.toThrow('Room is full');
    expect(() => manager.startGame({ token: nonHostToken })).toThrow('Only the room host can start the game');
    expect(manager.startGame({ token: host.token }).game?.players).toHaveLength(10);
  });

  it('issues host-authorized one-time agent invites without sharing the room password', async () => {
    const manager = new RoomManager();
    const host = await manager.createRoom({ hostName: 'Greg', password: 'correct horse' });
    const invite = manager.createInvite({ token: host.token });

    const joined = manager.redeemInvite({
      roomCode: host.roomCode,
      inviteToken: invite.inviteToken,
      playerName: 'A.Ira',
    });
    expect(joined.snapshot.players.map((player) => player.name)).toEqual(['Greg', 'A.Ira']);
    expect(() =>
      manager.redeemInvite({
        roomCode: host.roomCode,
        inviteToken: invite.inviteToken,
        playerName: 'A.IXiin',
      }),
    ).toThrow('Invalid or expired invite');
    expect(() => manager.createInvite({ token: joined.token })).toThrow('Only the room host can create invites');
  });

  it('auto-passes missing actions when the authoritative round deadline expires', async () => {
    let now = 1_000;
    const manager = new RoomManager({ roundDurationMs: 30_000, now: () => now });
    const sessions = [
      await manager.createRoom({ hostName: 'Greg', password: 'correct horse' }),
    ];
    for (const name of ['A.Ira', 'A.IXiin', 'A.INova', 'A.IRis']) {
      sessions.push(
        await manager.joinRoom({
          roomCode: sessions[0]!.roomCode,
          playerName: name,
          password: 'correct horse',
        }),
      );
    }
    const started = manager.startGame({ token: sessions[0]!.token });
    expect(started.roundDeadlineAt).toBe(31_000);

    manager.submitAction({
      token: sessions[0]!.token,
      requestId: 'greg-round-1',
      round: 1,
      action: { kind: 'move', direction: 'north' },
    });
    now = 31_001;
    const resolved = manager.resolveExpiredRooms();

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.snapshot.game?.round).toBe(2);
    expect(resolved[0]!.snapshot.lastTimedOutPlayerIds).toEqual(
      sessions.slice(1).map((session) => session.playerId),
    );
    expect(resolved[0]!.snapshot.events).toContain('4 pilots timed out and automatically passed.');
    expect(resolved[0]!.snapshot.roundDeadlineAt).toBe(61_001);
  });

  it('tracks whether each joined pilot currently has a live game connection', async () => {
    const manager = new RoomManager();
    const host = await manager.createRoom({ hostName: 'Greg', password: 'correct horse' });

    expect(manager.setConnected(host.token, true).connectedPlayerIds).toEqual([host.playerId]);
    expect(manager.setConnected(host.token, false).connectedPlayerIds).toEqual([]);
  });

  it('provides a machine-readable agent brief with state and conservative routing', async () => {
    const manager = new RoomManager();
    const host = await manager.createRoom({ hostName: 'Greg', password: 'correct horse' });
    const guest = await manager.joinRoom({
      roomCode: host.roomCode,
      playerName: 'A.Ira',
      password: 'correct horse',
    });
    manager.setConnected(host.token, true);
    const connected = manager.setConnected(guest.token, true);

    expect(connected.agentBrief).toMatchObject({
      schemaVersion: 1,
      audience: 'autonomous-agent',
      state: {
        phase: 'lobby',
        roster: { seatedCount: 2, onlineCount: 2, summary: '2 seated · 2 online' },
      },
      routing: {
        default: 'solve-locally',
        navigator: 'spawn-only-for-nontrivial-move-choice',
        observer: 'spawn-only-to-validate-ambiguous-state',
      },
      actionContract: {
        messageType: 'submit_action',
        legalActionWords: ['north', 'south', 'east', 'west', 'pass'],
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
    });
    expect(connected.agentBrief.rules.join(' ')).toContain('auto-pass');
    expect(connected.agentBrief.objective).toContain('northwest B2');
    expect(connected.agentBrief.objective).not.toContain('northwest A2');

    const disconnected = manager.setConnected(guest.token, false);
    expect(disconnected.agentBrief.state.roster).toMatchObject({
      seatedCount: 2,
      onlineCount: 1,
      summary: '2 seated · 1 online',
    });
    expect(disconnected.agentBrief.state.offlineAutoPassWarning).toContain(
      '1 offline pilot will auto-pass each round until they reconnect',
    );
    expect(JSON.stringify(disconnected.agentBrief)).not.toContain(host.token);
    expect(JSON.stringify(disconnected.agentBrief)).not.toContain(guest.token);
  });
});
