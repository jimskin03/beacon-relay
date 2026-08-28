import { createAudioController } from './audio.js';

type Position = { x: number; y: number };
type Player = { id: string; name: string };
type GamePlayer = { id: string; position: Position };
type Beacon = { id: string; position: Position; active: boolean };
type Game = {
  phase: 'playing' | 'won' | 'lost';
  round: number;
  maxRounds: number;
  board: { width: number; height: number; hub: Position };
  players: GamePlayer[];
  relays: Position[];
  beacons: Beacon[];
};
type Snapshot = {
  roomCode: string;
  hostId: string;
  minPlayers: number;
  maxPlayers: number;
  phase: 'lobby' | 'playing' | 'finished';
  players: Player[];
  game: Game | null;
  submittedPlayerIds: string[];
  connectedPlayerIds: string[];
  lastTimedOutPlayerIds: string[];
  roundDeadlineAt: number | null;
  events: string[];
};
type SessionCredentials = { roomCode: string; playerId: string; token: string };
type SessionResponse = SessionCredentials & { snapshot: Snapshot };

const PLAYER_COLORS = [
  '#ffc76b', '#72e7ff', '#ff79c9', '#79f2b1', '#b59cff',
  '#ff9b73', '#8ec5ff', '#d7f171', '#f3a6ff', '#77e6c4',
];
const AUTHORIZATION_SCHEME = 'Bearer';
const landing = element<HTMLElement>('landing');
const roomView = element<HTMLElement>('room');
const statusBanner = element<HTMLElement>('game-status');
const formError = element<HTMLElement>('form-error');
const board = element<HTMLElement>('board');
const playersList = element<HTMLElement>('players');
const eventList = element<HTMLElement>('events');
const actionPanel = element<HTMLElement>('action-panel');
const createForm = element<HTMLFormElement>('create-form');
const joinForm = element<HTMLFormElement>('join-form');
const copyInviteButton = element<HTMLButtonElement>('copy-invite');
const startGameButton = element<HTMLButtonElement>('start-game');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const audio = createAudioController(
  element<HTMLButtonElement>('sound-toggle'),
  element<HTMLInputElement>('sound-volume'),
);

let session: SessionCredentials | null = null;
let snapshot: Snapshot | null = null;
let socket: WebSocket | null = null;
let intentionalDisconnect = false;

const roomFromUrl = new URLSearchParams(location.search).get('room');
const inviteFromUrl = new URLSearchParams(location.hash.slice(1)).get('invite');
if (roomFromUrl) element<HTMLInputElement>('room-code-input').value = roomFromUrl;
if (inviteFromUrl) {
  const passwordInput = element<HTMLInputElement>('join-password');
  passwordInput.required = false;
  passwordInput.closest('label')!.hidden = true;
  joinForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.textContent = 'Join with secure invite';
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await withForm(createForm, async () => {
    const response = await api<SessionResponse>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        hostName: element<HTMLInputElement>('host-name').value,
        password: element<HTMLInputElement>('host-password').value,
      }),
    });
    enterRoom(response);
  });
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await withForm(joinForm, async () => {
    const roomCode = element<HTMLInputElement>('room-code-input').value.trim();
    const endpoint = inviteFromUrl ? 'invite-join' : 'join';
    const body = inviteFromUrl
      ? {
          playerName: element<HTMLInputElement>('player-name').value,
          inviteToken: inviteFromUrl,
        }
      : {
          playerName: element<HTMLInputElement>('player-name').value,
          password: element<HTMLInputElement>('join-password').value,
        };
    const response = await api<SessionResponse>(`/api/rooms/${encodeURIComponent(roomCode)}/${endpoint}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    enterRoom(response);
  });
});

copyInviteButton.addEventListener('click', async () => {
  if (!session) return;
  try {
    const created = await api<{ inviteToken: string }>(
      `/api/rooms/${encodeURIComponent(session.roomCode)}/invites`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${session.token}` },
      },
    );
    const invite = `${location.origin}/?room=${encodeURIComponent(session.roomCode)}#invite=${encodeURIComponent(created.inviteToken)}`;
    await navigator.clipboard.writeText(invite);
    announce('One-time agent invite copied. It can be used once without sharing the room password.');
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Unable to create an agent invite.');
  }
});

startGameButton.addEventListener('click', async () => {
  if (!session || !snapshot || session.playerId !== snapshot.hostId) return;
  startGameButton.disabled = true;
  try {
    snapshot = await api<Snapshot>(`/api/rooms/${encodeURIComponent(session.roomCode)}/start`, {
      method: 'POST',
      headers: authHeaders(session.token),
    });
    render();
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Unable to start the mission.');
    render();
  }
});

disconnectButton.addEventListener('click', () => {
  intentionalDisconnect = true;
  socket?.close(1000, 'Client disconnected');
  socket = null;
  session = null;
  snapshot = null;
  roomView.hidden = true;
  landing.hidden = false;
  formError.textContent = 'Client disconnected. Reload this page to reconnect to the preserved room.';
  formError.hidden = false;
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  button.addEventListener('click', () => submitAction(button.dataset.action!));
}

restoreStoredSession();
setInterval(updateCountdown, 250);

function enterRoom(nextSession: SessionResponse): void {
  session = {
    roomCode: nextSession.roomCode,
    playerId: nextSession.playerId,
    token: nextSession.token,
  };
  snapshot = nextSession.snapshot;
  sessionStorage.setItem('beacon-relay-session', JSON.stringify({
    roomCode: nextSession.roomCode,
    playerId: nextSession.playerId,
    token: nextSession.token,
  }));
  landing.hidden = true;
  roomView.hidden = false;
  render();
  connect();
}

function restoreStoredSession(): void {
  const raw = sessionStorage.getItem('beacon-relay-session');
  if (!raw) return;
  try {
    const stored = JSON.parse(raw) as Partial<SessionCredentials>;
    if (
      typeof stored.roomCode !== 'string' ||
      typeof stored.playerId !== 'string' ||
      typeof stored.token !== 'string'
    ) {
      return;
    }
    session = {
      roomCode: stored.roomCode,
      playerId: stored.playerId,
      token: stored.token,
    };
    landing.hidden = true;
    roomView.hidden = false;
    announce('Restoring your relay session…');
    connect();
  } catch {
    sessionStorage.removeItem('beacon-relay-session');
  }
}

function connect(): void {
  if (!session) return;
  socket?.close();
  intentionalDisconnect = false;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  announce('Connecting to relay server…');
  socket.addEventListener('open', () => {
    socket?.send(JSON.stringify({ type: 'authenticate', token: session!.token }));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === 'snapshot' || message.type === 'action_accepted') {
      snapshot = message.snapshot;
      render();
      if (message.type === 'action_accepted' && message.duplicate) announce('Duplicate action ignored safely.');
    } else if (message.type === 'error') {
      announce(message.message ?? 'The server rejected that action.');
    }
  });
  socket.addEventListener('close', () => {
    if (!intentionalDisconnect) announce('Signal lost. Refresh to reconnect to this room.');
  });
}

function submitAction(actionName: string): void {
  if (!session || !snapshot?.game || socket?.readyState !== WebSocket.OPEN) return;
  const action = actionName === 'pass'
    ? { kind: 'pass' }
    : { kind: 'move', direction: actionName };
  socket.send(JSON.stringify({
    type: 'submit_action',
    requestId: crypto.randomUUID(),
    round: snapshot.game.round,
    action,
  }));
  announce(`${actionName === 'pass' ? 'Pass' : `Move ${actionName}`} submitted. Waiting for the fleet.`);
}

function render(): void {
  if (!session || !snapshot) return;
  element<HTMLElement>('room-code-label').textContent = `Room code: ${snapshot.roomCode}`;
  element<HTMLElement>('pilot-count').textContent = `${snapshot.players.length}/${snapshot.maxPlayers}`;
  const isHost = snapshot.hostId === session.playerId;
  copyInviteButton.hidden = !isHost || snapshot.phase !== 'lobby' || snapshot.players.length >= snapshot.maxPlayers;
  startGameButton.hidden = !isHost || snapshot.phase !== 'lobby';
  startGameButton.disabled = snapshot.players.length < snapshot.minPlayers;
  renderPlayers();
  renderEvents();

  const activeBeacons = snapshot.game?.beacons.filter((beacon) => beacon.active).length ?? 0;
  audio.sync({
    phase: snapshot.phase,
    round: snapshot.game?.round ?? null,
    activeBeacons,
    outcome: snapshot.game?.phase ?? null,
  });

  if (snapshot.phase === 'lobby') {
    const needed = Math.max(0, snapshot.minPlayers - snapshot.players.length);
    const seated = snapshot.players.length;
    const online = snapshot.players.filter((player) => snapshot!.connectedPlayerIds.includes(player.id)).length;
    const offline = seated - online;
    const readiness = needed > 0
      ? `${needed} more ${needed === 1 ? 'seat is' : 'seats are'} required to start.`
      : offline > 0
        ? `Starting now: ${online} of ${seated} seated pilots online. Offline pilots will auto-pass each round until they reconnect.`
        : 'All seated pilots online. Host can start the mission.';
    announce(`Lobby: ${seated} seated · ${online} online. ${readiness}`);
    actionPanel.hidden = true;
    element<HTMLElement>('board-title').textContent = 'Mission staging';
    element<HTMLElement>('round-label').textContent = 'AWAITING FLEET';
    board.classList.add('lobby-board');
    board.setAttribute('role', 'region');
    board.setAttribute('aria-label', 'Mission readiness');
    board.innerHTML = `<div class="lobby-readiness">
      <div class="readiness-orbit" aria-hidden="true"><span></span><span></span><span></span></div>
      <div><p class="eyebrow">MISSION READINESS</p><strong>${seated} SEATED · ${online} ONLINE</strong><p>${readiness}</p></div>
    </div>`;
    return;
  }

  const game = snapshot.game!;
  updateCountdown();
  actionPanel.hidden = game.phase !== 'playing' || snapshot.submittedPlayerIds.includes(session.playerId);
  const active = activeBeacons;
  if (game.phase === 'won') announce('Mission complete. All three beacons are connected.');
  else if (game.phase === 'lost') announce('Mission failed. The relay window has closed.');
  else if (snapshot.submittedPlayerIds.includes(session.playerId)) announce(`Round ${game.round}: action locked. Waiting for ${snapshot.players.length - snapshot.submittedPlayerIds.length} pilots.`);
  else announce(`Round ${game.round} of ${game.maxRounds}. ${active} of 3 beacons active. Choose one action.`);
  renderBoard(game);
}

function renderPlayers(): void {
  if (!snapshot) return;
  playersList.replaceChildren(...snapshot.players.map((player, index) => {
    const item = document.createElement('li');
    item.className = 'player';
    const submitted = snapshot!.submittedPlayerIds.includes(player.id);
    const connected = snapshot!.connectedPlayerIds.includes(player.id);
    const timedOut = snapshot!.lastTimedOutPlayerIds.includes(player.id);
    const pilotStatus = !connected
      ? 'DISCONNECTED'
      : timedOut
        ? 'TIMED OUT'
        : submitted
          ? 'SUBMITTED'
          : snapshot!.phase === 'playing'
            ? 'CHOOSING'
            : 'ONLINE';
    const role = player.id === snapshot!.hostId ? ' · HOST' : '';
    item.setAttribute('aria-label', `${player.name}, ${pilotStatus.toLowerCase()}${role.toLowerCase()}`);
    item.innerHTML = `<span class="player-dot" style="color:${PLAYER_COLORS[index]};background:${PLAYER_COLORS[index]}"></span><strong>${escapeHtml(player.name)}${role}</strong><small>${pilotStatus}</small>`;
    return item;
  }));
}

function renderEvents(): void {
  if (!snapshot) return;
  const events = snapshot.events.length ? snapshot.events : ['Room link established. Awaiting mission events.'];
  eventList.replaceChildren(...events.slice(-8).map((event) => {
    const item = document.createElement('li');
    item.textContent = event;
    return item;
  }));
}

function renderBoard(game: Game): void {
  element<HTMLElement>('board-title').textContent = 'Signal lattice';
  board.classList.remove('lobby-board');
  board.setAttribute('role', 'grid');
  board.setAttribute('aria-label', 'Beacon Relay board');
  const relayKeys = new Set(game.relays.map(key));
  const beaconByCell = new Map(game.beacons.map((beacon) => [key(beacon.position), beacon]));
  const playersByCell = new Map<string, GamePlayer[]>();
  for (const player of game.players) {
    const cellPlayers = playersByCell.get(key(player.position)) ?? [];
    cellPlayers.push(player);
    playersByCell.set(key(player.position), cellPlayers);
  }
  const playerIndex = new Map(snapshot!.players.map((player, index) => [player.id, index]));
  const cells: HTMLElement[] = [];
  for (let y = 0; y < game.board.height; y += 1) {
    for (let x = 0; x < game.board.width; x += 1) {
      const position = { x, y };
      const cellKey = key(position);
      const beacon = beaconByCell.get(cellKey);
      const cell = document.createElement('div');
      const names = (playersByCell.get(cellKey) ?? []).map((player) => snapshot!.players.find((entry) => entry.id === player.id)?.name ?? 'pilot');
      cell.className = ['cell', relayKeys.has(cellKey) ? 'relay' : '', x === 4 && y === 4 ? 'hub' : '', beacon ? 'beacon' : '', beacon?.active ? 'active' : ''].filter(Boolean).join(' ');
      const features = [relayKeys.has(cellKey) ? 'relay' : 'empty', beacon ? `${beacon.id} beacon ${beacon.active ? 'active' : 'inactive'}` : '', names.length ? `pilots ${names.join(', ')}` : ''].filter(Boolean).join(', ');
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${cellLabel(position)}, ${features}`);
      cell.textContent = cellLabel(position);
      if (names.length) {
        const drones = document.createElement('span');
        drones.className = 'drones';
        for (const player of playersByCell.get(cellKey) ?? []) {
          const index = playerIndex.get(player.id) ?? 0;
          const drone = document.createElement('span');
          drone.className = 'drone';
          drone.style.background = PLAYER_COLORS[index] ?? '#ffffff';
          drone.textContent = snapshot!.players[index]?.name.slice(0, 1).toUpperCase() ?? '?';
          drones.append(drone);
        }
        cell.append(drones);
      }
      cells.push(cell);
    }
  }
  board.replaceChildren(...cells);
}

async function withForm(form: HTMLFormElement, operation: () => Promise<void>): Promise<void> {
  formError.hidden = true;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  button.disabled = true;
  try { await operation(); }
  catch (error) {
    formError.textContent = error instanceof Error ? error.message : 'Unable to contact the relay server.';
    formError.hidden = false;
  } finally { button.disabled = false; }
}

async function api<T>(url: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `${AUTHORIZATION_SCHEME} ${token}` };
}

function announce(message: string): void { statusBanner.textContent = message; }
function updateCountdown(): void {
  if (!snapshot?.game) return;
  const seconds = snapshot.roundDeadlineAt === null
    ? 0
    : Math.max(0, Math.ceil((snapshot.roundDeadlineAt - Date.now()) / 1_000));
  element<HTMLElement>('round-label').textContent = `ROUND ${snapshot.game.round}/${snapshot.game.maxRounds} · ${seconds}s`;
}
function key(position: Position): string { return `${position.x},${position.y}`; }
function cellLabel(position: Position): string { return `${String.fromCharCode(65 + position.x)}${position.y + 1}`; }
function escapeHtml(value: string): string { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function element<T extends HTMLElement>(id: string): T { const found = document.getElementById(id); if (!found) throw new Error(`Missing #${id}`); return found as T; }
