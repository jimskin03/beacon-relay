# Beacon Relay

A server-authoritative cooperative 2D game for 2–10 human or Hermes Agent pilots. Pilots move simultaneously across a 9×9 signal lattice, leaving shared relay trails. Connect all three beacons within eight rounds to win.

## What is implemented

- Host-started rooms supporting 2–10 players
- Password-protected rooms using Node's `scrypt` KDF and timing-safe verification
- One-time, host-issued agent invite links; bots never need the room password
- Opaque 192-bit player session tokens sent in the WebSocket authentication message, not its URL
- Authoritative deterministic game engine and server-side victory checks
- Idempotent action submission through per-player `requestId` values
- Strict Zod message validation, 16 KiB HTTP/WebSocket limits, and WebSocket Origin checks
- Full-state snapshots after joins, actions, round resolution, and reconnects
- 45-second authoritative round deadlines with automatic pass fallback
- Live pilot states: connected, choosing, submitted, timed out, and disconnected
- Persistent runners that wake the correct Hermes profile for every new round
- Accessible DOM grid, labelled controls, keyboard navigation, visible focus, and live status/event regions
- Responsive dark tactical UI without canvas-only state
- Procedural suspenseful space ambience with persisted mute and volume controls
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
5. Once at least two pilots are present, the host clicks **Start mission**. Each pilot chooses one labelled direction or **Pass**; the round resolves after everyone in the current crew acts.
6. **Disconnect** closes only that browser's live connection. The room and session remain available for reconnection after reload.

Computer Use should target semantic button labels (`Move north`, `Move east`, `Pass this round`) rather than coordinates. Essential board state is exposed through labelled `gridcell` elements and text status.

## Persistent autonomous Hermes runners

Joining creates presence; a runner provides ongoing agency. Keep one runner alive per bot. It redeems that bot's one-time invite, authenticates over WebSocket, watches authoritative round snapshots, asks the matching Hermes profile for one strict action, submits it idempotently, and repeats until game-over. If a model decision takes longer than 20 seconds or is ambiguous, a distinct deterministic profile strategy is used as fallback.

Run these in four terminals with four different invite URLs. Quote each URL because its `#invite=` fragment has shell meaning:

```bash
npm run agent:run -- --profile default --name A.Ira --invite 'AIRA_INVITE_URL'
npm run agent:run -- --profile aixin --name A.IXiin --invite 'AIXIN_INVITE_URL'
npm run agent:run -- --profile ainova --name A.INova --invite 'AINOVA_INVITE_URL'
npm run agent:run -- --profile airis --name A.IRis --invite 'AIRIS_INVITE_URL'
```

Reconnect credentials are saved with mode `0600` under:

```text
~/.hermes/beacon-relay/<room-code>/<profile>.json
```

For a deterministic smoke test without model calls, append `--decision fallback`. Do not use fallback mode for a real personality-driven match unless a provider is unavailable. The game server independently auto-passes a pilot who misses the deadline, so one crashed runner cannot freeze everyone else.

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
npm run test:e2e  # lobby, reconnect, invites, variable crews, persistent runners
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
