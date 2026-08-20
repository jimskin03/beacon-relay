import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type WebSocket from 'ws';
import { buildServer } from '../src/server/app.js';
import { RoomManager } from '../src/server/rooms/room-manager.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Beacon Relay HTTP API', () => {
  it('creates and joins a password-protected room', async () => {
    const server = await buildServer();
    app = server;

    const health = await server.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const created = await server.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { hostName: 'Greg', password: 'correct horse' },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json();
    expect(room.roomCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(room.token).toBeTypeOf('string');
    expect(JSON.stringify(room)).not.toContain('correct horse');

    const rejected = await server.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomCode}/join`,
      payload: { playerName: 'A.Ira', password: 'wrong battery' },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: 'Invalid room code or password' });

    const joined = await server.inject({
      method: 'POST',
      url: `/api/rooms/${room.roomCode}/join`,
      payload: { playerName: 'A.Ira', password: 'correct horse' },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().snapshot.players).toHaveLength(2);
  });

  it('authenticates a WebSocket with an opaque token and sends a snapshot', async () => {
    const server = await buildServer();
    app = server;
    const created = await server.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { hostName: 'Greg', password: 'correct horse' },
    });
    const session = created.json();
    await server.ready();

    const socket = await server.injectWS('/ws', {
      headers: { origin: 'http://localhost:3000' },
    });
    const received = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', token: session.token }));

    expect(await received).toMatchObject({
      type: 'snapshot',
      playerId: session.playerId,
      snapshot: {
        roomCode: session.roomCode,
        phase: 'lobby',
      },
    });
    socket.terminate();
  });

  it('accepts an authenticated action once and reports duplicate retries', async () => {
    const server = await buildServer();
    app = server;
    const sessions = await createFullRoom(server);
    await server.ready();
    const socket = await server.injectWS('/ws', {
      headers: { origin: 'http://localhost:3000' },
    });
    const authenticated = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', token: sessions[0]!.token }));
    await authenticated;

    const observer = await server.injectWS('/ws', {
      headers: { origin: 'http://localhost:3000' },
    });
    const observerAuthenticated = nextMessage(observer);
    observer.send(JSON.stringify({ type: 'authenticate', token: sessions[1]!.token }));
    await observerAuthenticated;

    const accepted = nextMessage(socket);
    const observerUpdate = nextMessage(observer);
    socket.send(
      JSON.stringify({
        type: 'submit_action',
        requestId: 'greg-round-1',
        round: 1,
        action: { kind: 'move', direction: 'north' },
      }),
    );
    expect(await accepted).toMatchObject({
      type: 'action_accepted',
      requestId: 'greg-round-1',
      duplicate: false,
      snapshot: { submittedPlayerIds: [sessions[0]!.playerId] },
    });
    expect(await observerUpdate).toMatchObject({
      type: 'snapshot',
      snapshot: { submittedPlayerIds: [sessions[0]!.playerId] },
    });

    const duplicate = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'submit_action',
        requestId: 'greg-round-1',
        round: 1,
        action: { kind: 'move', direction: 'south' },
      }),
    );
    expect(await duplicate).toMatchObject({
      type: 'action_accepted',
      requestId: 'greg-round-1',
      duplicate: true,
    });
    observer.terminate();
    socket.terminate();
  });

  it('creates a one-time agent invite for the authenticated host', async () => {
    const server = await buildServer();
    app = server;
    const created = await server.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { hostName: 'Greg', password: 'correct horse' },
    });
    const host = created.json();
    const inviteResponse = await server.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/invites`,
      headers: { authorization: `Bearer ${host.token}` },
    });
    expect(inviteResponse.statusCode).toBe(201);
    const invite = inviteResponse.json();

    const joined = await server.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/invite-join`,
      payload: { playerName: 'A.Ira', inviteToken: invite.inviteToken },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().snapshot.players).toHaveLength(2);

    const replay = await server.inject({
      method: 'POST',
      url: `/api/rooms/${host.roomCode}/invite-join`,
      payload: { playerName: 'A.IXiin', inviteToken: invite.inviteToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('broadcasts an auto-pass resolution when the round deadline expires', async () => {
    const roomManager = new RoomManager({ roundDurationMs: 60 });
    const server = await buildServer({ roomManager, deadlinePollMs: 10 });
    app = server;
    const sessions = await createFullRoom(server);
    await server.ready();
    const socket = await server.injectWS('/ws', {
      headers: { origin: 'http://localhost:3000' },
    });
    const authenticated = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'authenticate', token: sessions[0]!.token }));
    await authenticated;

    const deadlineUpdate = await nextMessage(socket);
    expect(deadlineUpdate).toMatchObject({
      type: 'snapshot',
      snapshot: {
        game: { round: 2 },
        lastTimedOutPlayerIds: sessions.map((session) => session.playerId),
      },
    });
    socket.terminate();
  });
});

async function createFullRoom(server: FastifyInstance): Promise<any[]> {
  const created = await server.inject({
    method: 'POST',
    url: '/api/rooms',
    payload: { hostName: 'Greg', password: 'correct horse' },
  });
  const sessions = [created.json()];
  for (const playerName of ['A.Ira', 'A.IXiin', 'A.INova', 'A.IRis']) {
    const joined = await server.inject({
      method: 'POST',
      url: `/api/rooms/${sessions[0].roomCode}/join`,
      payload: { playerName, password: 'correct horse' },
    });
    sessions.push(joined.json());
  }
  return sessions;
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}
