import Fastify, { type FastifyInstance } from 'fastify';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RoomManager, type RoomSnapshot } from './rooms/room-manager.js';

const createRoomSchema = z.object({
  hostName: z.string().trim().min(1).max(24),
  password: z.string().min(8).max(128),
});

const joinRoomSchema = z.object({
  playerName: z.string().trim().min(1).max(24),
  password: z.string().min(1).max(128),
});

const roomParamsSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
});

const inviteJoinSchema = z.object({
  playerName: z.string().trim().min(1).max(24),
  inviteToken: z.string().min(32).max(128),
});

const authenticateSchema = z.object({
  type: z.literal('authenticate'),
  token: z.string().min(32).max(128),
});

const submitActionSchema = z.object({
  type: z.literal('submit_action'),
  requestId: z.string().min(1).max(80),
  round: z.number().int().min(1).max(8),
  action: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('move'),
      direction: z.enum(['north', 'south', 'west', 'east']),
    }),
    z.object({ kind: z.literal('pass') }),
  ]),
});

export async function buildServer(
  options: Readonly<{
    allowedOrigins?: readonly string[];
    roomManager?: RoomManager;
    deadlinePollMs?: number;
  }> = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
  });
  const rooms = options.roomManager ?? new RoomManager();
  const roomSockets = new Map<string, Set<WebSocket>>();
  const broadcastSnapshot = (
    roomCode: string,
    snapshot: RoomSnapshot,
    excludedSocket?: WebSocket,
  ): void => {
    const update = JSON.stringify({ type: 'snapshot', snapshot });
    for (const peer of roomSockets.get(roomCode) ?? []) {
      if (peer !== excludedSocket && peer.readyState === peer.OPEN) peer.send(update);
    }
  };
  const deadlineTimer = setInterval(() => {
    for (const resolved of rooms.resolveExpiredRooms()) {
      broadcastSnapshot(resolved.roomCode, resolved.snapshot);
    }
  }, options.deadlinePollMs ?? 1_000);
  deadlineTimer.unref();
  app.addHook('onClose', async () => clearInterval(deadlineTimer));
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      process.env.APP_ORIGIN ?? 'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ],
  );

  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 },
  });
  await app.register(staticFiles, {
    root: fileURLToPath(new URL('../client', import.meta.url)),
    prefix: '/',
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/api/rooms', async (request, reply) => {
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid room details' });
    }

    try {
      const created = await rooms.createRoom(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/rooms/:code/join', async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    const body = joinRoomSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid join request' });
    }

    try {
      const joined = await rooms.joinRoom({
        roomCode: params.data.code,
        playerName: body.data.playerName,
        password: body.data.password,
      });
      broadcastSnapshot(joined.roomCode, joined.snapshot);
      return reply.code(200).send(joined);
    } catch (error) {
      const message = errorMessage(error);
      const statusCode = message === 'Room is full' ? 409 : 401;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.post('/api/rooms/:code/invites', async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    const token = bearerToken(request.headers.authorization);
    if (!params.success || !token) {
      return reply.code(401).send({ error: 'Host authorization required' });
    }
    try {
      const session = rooms.authenticateToken(token);
      if (session.snapshot.roomCode !== params.data.code) {
        return reply.code(403).send({ error: 'Token does not belong to this room' });
      }
      return reply.code(201).send(rooms.createInvite({ token }));
    } catch (error) {
      return reply.code(403).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/rooms/:code/invite-join', async (request, reply) => {
    const params = roomParamsSchema.safeParse(request.params);
    const body = inviteJoinSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid invite request' });
    }
    try {
      const joined = rooms.redeemInvite({
        roomCode: params.data.code,
        inviteToken: body.data.inviteToken,
        playerName: body.data.playerName,
      });
      broadcastSnapshot(joined.roomCode, joined.snapshot);
      return reply.code(200).send(joined);
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message === 'Room is full' ? 409 : 401).send({ error: message });
    }
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) {
      socket.close(1008, 'Origin not allowed');
      return;
    }

    let authenticatedToken: string | null = null;
    let authenticatedRoomCode: string | null = null;
    const authenticationTimeout = setTimeout(() => {
      if (!authenticatedToken) socket.close(1008, 'Authentication timeout');
    }, 5_000);
    authenticationTimeout.unref();

    socket.on('close', () => {
      clearTimeout(authenticationTimeout);
      if (!authenticatedRoomCode) return;
      const peers = roomSockets.get(authenticatedRoomCode);
      peers?.delete(socket);
      if (peers?.size === 0) roomSockets.delete(authenticatedRoomCode);
      if (authenticatedToken) {
        try {
          const disconnectedSnapshot = rooms.setConnected(authenticatedToken, false);
          broadcastSnapshot(authenticatedRoomCode, disconnectedSnapshot);
        } catch {
          // Session may have expired with the room.
        }
      }
    });
    socket.on('message', (data) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(data.toString());
      } catch {
        socket.close(1007, 'Invalid JSON');
        return;
      }

      if (authenticatedToken) {
        const action = submitActionSchema.safeParse(decoded);
        if (!action.success) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_MESSAGE' }));
          return;
        }
        try {
          const result = rooms.submitAction({
            token: authenticatedToken,
            requestId: action.data.requestId,
            round: action.data.round,
            action: action.data.action,
          });
          socket.send(
            JSON.stringify({
              type: 'action_accepted',
              requestId: action.data.requestId,
              duplicate: result.duplicate,
              resolved: result.resolved,
              snapshot: result.snapshot,
            }),
          );
          if (!result.duplicate && authenticatedRoomCode) {
            broadcastSnapshot(authenticatedRoomCode, result.snapshot, socket);
          }
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: 'error',
              code: 'ACTION_REJECTED',
              message: errorMessage(error),
            }),
          );
        }
        return;
      }

      const parsed = authenticateSchema.safeParse(decoded);
      if (!parsed.success) {
        socket.close(1008, 'Authentication required');
        return;
      }

      try {
        const session = rooms.authenticateToken(parsed.data.token);
        authenticatedToken = parsed.data.token;
        authenticatedRoomCode = session.snapshot.roomCode;
        let peers = roomSockets.get(authenticatedRoomCode);
        if (!peers) {
          peers = new Set();
          roomSockets.set(authenticatedRoomCode, peers);
        }
        peers.add(socket);
        const connectedSnapshot = rooms.setConnected(parsed.data.token, true);
        clearTimeout(authenticationTimeout);
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            playerId: session.playerId,
            snapshot: connectedSnapshot,
          }),
        );
        broadcastSnapshot(authenticatedRoomCode, connectedSnapshot, socket);
      } catch {
        socket.close(1008, 'Invalid session token');
      }
    });
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected server error';
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
