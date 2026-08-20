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

const PLAYER_COLORS = ['#ffc76b', '#72e7ff', '#ff79c9', '#79f2b1', '#b59cff'];
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

let session: SessionCredentials | null = null;
let snapshot: Snapshot | null = null;
let socket: WebSocket | null = null;

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
  socket.addEventListener('close', () => announce('Disconnected from relay server. Refresh to reconnect.'));
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
  element<HTMLElement>('pilot-count').textContent = `${snapshot.players.length}/5`;
  copyInviteButton.hidden = snapshot.players[0]?.id !== session.playerId || snapshot.players.length >= 5;
  renderPlayers();
  renderEvents();

  if (snapshot.phase === 'lobby') {
    announce(`Lobby: ${snapshot.players.length} of 5 pilots connected.`);
    actionPanel.hidden = true;
    element<HTMLElement>('round-label').textContent = 'AWAITING FLEET';
    board.innerHTML = '<div class="cell hub" role="gridcell" aria-label="Central hub awaiting pilots">HUB</div>';
    return;
  }

  const game = snapshot.game!;
  updateCountdown();
  actionPanel.hidden = game.phase !== 'playing' || snapshot.submittedPlayerIds.includes(session.playerId);
  const active = game.beacons.filter((beacon) => beacon.active).length;
  if (game.phase === 'won') announce('Mission complete. All three beacons are connected.');
  else if (game.phase === 'lost') announce('Mission failed. The relay window has closed.');
  else if (snapshot.submittedPlayerIds.includes(session.playerId)) announce(`Round ${game.round}: action locked. Waiting for ${5 - snapshot.submittedPlayerIds.length} pilots.`);
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
    item.innerHTML = `<span class="player-dot" style="color:${PLAYER_COLORS[index]};background:${PLAYER_COLORS[index]}"></span><strong>${escapeHtml(player.name)}</strong><small>${pilotStatus}</small>`;
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
