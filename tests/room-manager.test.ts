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

  it('starts at five players and resolves duplicate-safe round submissions', async () => {
    const manager = new RoomManager();
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

    expect(sessions[4]!.snapshot.phase).toBe('playing');
    expect(sessions[4]!.snapshot.game?.round).toBe(1);

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

    for (const session of sessions.slice(1)) {
      manager.submitAction({
        token: session.token,
        requestId: `${session.playerId}-round-1`,
        round: 1,
        action: { kind: 'pass' },
      });
    }

    const snapshot = manager.snapshotForToken(sessions[0]!.token);
    expect(snapshot.game?.round).toBe(2);
    expect(snapshot.game?.players.find((player) => player.id === sessions[0]!.playerId)?.position).toEqual({
      x: 4,
      y: 3,
    });
    expect(snapshot.submittedPlayerIds).toEqual([]);
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
    expect(sessions[4]!.snapshot.roundDeadlineAt).toBe(31_000);

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
});
