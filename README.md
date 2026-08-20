# Beacon Relay

A server-authoritative cooperative 2D game for Greg and four isolated Hermes Agent profiles. Five pilots move simultaneously across a 9×9 signal lattice, leaving shared relay trails. Connect all three beacons within eight rounds to win.

## What is implemented

- Exactly five players per room
- Password-protected rooms using Node's `scrypt` KDF and timing-safe verification
- One-time, host-issued agent invite links; bots never need the room password
- Opaque 192-bit player session tokens sent in the WebSocket authentication message, not its URL
- Authoritative deterministic game engine and server-side victory checks
- Idempotent action submission through per-player `requestId` values
- Strict Zod message validation, 16 KiB HTTP/WebSocket limits, and WebSocket Origin checks
- Full-state snapshots after joins, actions, round resolution, and reconnects
- Accessible DOM grid, labelled controls, keyboard navigation, visible focus, and live status/event regions
- Responsive dark tactical UI without canvas-only state
- Unit/API/WebSocket tests and Playwright tests using five isolated browser contexts

## Local development

Requirements: Node.js 22+ and npm.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

Open <http://127.0.0.1:3000>.

For source watching:

```bash
npm run dev
```

Open <http://127.0.0.1:5173> in development. Vite serves the client and proxies HTTP/WebSocket traffic to the watched Fastify server on port 3000; production serves the compiled client from `dist/client`.

## Playing with Hermes profiles

1. Greg creates a room with his display name and a room password.
2. Greg clicks **Copy agent invite** once for each bot. Every link is a distinct one-time capability URL; the token is stored in the URL fragment so it is not sent in HTTP request logs.
3. Open one invite in each isolated browser session for:
   - A.Ira (`default`)
   - A.IXiin (`aixin`)
   - A.INova (`ainova`)
   - A.IRis (`airis`)
4. Each bot enters only its public pilot name and clicks **Join with secure invite**. No bot types or receives the room password.
5. Once five pilots are present, each chooses one labelled direction or **Pass**. The round resolves after all five actions arrive.

Computer Use should target semantic button labels (`Move north`, `Move east`, `Pass this round`) rather than coordinates. Essential board state is exposed through labelled `gridcell` elements and text status.

## Docker

```bash
docker build -t beacon-relay .
docker run --rm -p 3000:3000 \
  -e APP_ORIGIN=http://127.0.0.1:3000 \
  beacon-relay
```

## Online deployment

`render.yaml` and the `Dockerfile` are ready for a single-instance Render deployment. Set `APP_ORIGIN` to the final public HTTPS origin, for example:

```text
https://beacon-relay.onrender.com
```

The browser will use WSS automatically on HTTPS. Keep the MVP at one instance because room state is intentionally in memory. A deploy or host restart ends active rooms cleanly; durable room snapshots and horizontal scaling are later milestones.

The container is provider-neutral and also works on Fly.io, Railway, Cloud Run, or any host supporting long-lived WebSockets.

## Verification

```bash
npm test          # deterministic engine, room auth/invites, API, WebSocket
npm run test:e2e  # lobby, reconnect, one-time invite, five-client full victory
npm run typecheck
npm run build
npm audit
```

## Security notes

- Do not place room passwords, player tokens, or invite fragments in logs.
- `APP_ORIGIN` is the only production origin accepted for WebSocket upgrades.
- Agent invites are single-use and stop being accepted after redemption.
- Room codes are random 96-bit identifiers and are not listed publicly.
- This MVP stores active rooms in process memory; it does not claim restart persistence.
