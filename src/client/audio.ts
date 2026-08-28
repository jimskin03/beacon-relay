export type AudioScene = Readonly<{
  phase: 'lobby' | 'playing' | 'finished';
  round: number | null;
  activeBeacons: number;
  outcome: 'playing' | 'won' | 'lost' | null;
}>;

type AudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

const ENABLED_KEY = 'beacon-relay-sound-enabled';
const VOLUME_KEY = 'beacon-relay-sound-volume';

export function createAudioController(
  toggle: HTMLButtonElement,
  volume: HTMLInputElement,
): Readonly<{ sync: (scene: AudioScene) => void; stop: () => void }> {
  let enabled = localStorage.getItem(ENABLED_KEY) === 'true';
  let level = clamp(Number(localStorage.getItem(VOLUME_KEY) ?? '0.28'));
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let drone: OscillatorNode | null = null;
  let pulse: OscillatorNode | null = null;
  let lastScene: AudioScene | null = null;

  volume.value = String(level);
  updateControls();

  toggle.addEventListener('click', async () => {
    enabled = !enabled;
    localStorage.setItem(ENABLED_KEY, String(enabled));
    updateControls();
    if (enabled) await startAudio();
    else stopAudio();
  });

  volume.addEventListener('input', () => {
    level = clamp(Number(volume.value));
    localStorage.setItem(VOLUME_KEY, String(level));
    if (master && context) master.gain.setTargetAtTime(level, context.currentTime, 0.08);
  });

  const unlockPersistedAudio = async (): Promise<void> => {
    if (enabled) await startAudio();
  };
  document.addEventListener('pointerdown', unlockPersistedAudio, { once: true, capture: true });
  document.addEventListener('keydown', unlockPersistedAudio, { once: true, capture: true });

  return {
    sync(scene) {
      const previous = lastScene;
      lastScene = scene;
      if (!context || !enabled) return;
      updateAmbience(scene);
      if (!previous) return;
      if (scene.phase === 'playing' && previous.phase === 'lobby') playCue([196, 294, 392], 0.42);
      else if (scene.activeBeacons > previous.activeBeacons) playCue([440, 554, 659], 0.34);
      else if (scene.outcome === 'won' && previous.outcome !== 'won') playCue([392, 523, 659, 784], 0.58);
      else if (scene.outcome === 'lost' && previous.outcome !== 'lost') playCue([196, 164, 131], 0.52);
      else if (scene.round !== previous.round && scene.phase === 'playing') playCue([220, 277], 0.24);
    },
    stop: stopAudio,
  };

  async function startAudio(): Promise<void> {
    if (!enabled) return;
    if (!context) {
      const AudioContextClass = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!AudioContextClass) return;
      context = new AudioContextClass();
      master = context.createGain();
      master.gain.value = level;
      master.connect(context.destination);

      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 2.4;
      filter.connect(master);

      drone = context.createOscillator();
      drone.type = 'sawtooth';
      drone.frequency.value = 55;
      const droneGain = context.createGain();
      droneGain.gain.value = 0.055;
      drone.connect(droneGain).connect(filter);
      drone.start();

      pulse = context.createOscillator();
      pulse.type = 'sine';
      pulse.frequency.value = 82.4;
      const pulseGain = context.createGain();
      pulseGain.gain.value = 0.025;
      pulse.connect(pulseGain).connect(filter);
      pulse.start();
    }
    if (context.state === 'suspended') await context.resume();
    if (lastScene) updateAmbience(lastScene);
  }

  function updateAmbience(scene: AudioScene): void {
    if (!context || !drone || !pulse || !master) return;
    const urgency = scene.phase === 'playing' ? Math.min(1, (scene.round ?? 1) / 8) : 0;
    drone.frequency.setTargetAtTime(55 + urgency * 7, context.currentTime, 0.8);
    pulse.frequency.setTargetAtTime(82.4 + urgency * 27, context.currentTime, 0.5);
    master.gain.setTargetAtTime(scene.phase === 'finished' ? level * 0.55 : level, context.currentTime, 0.4);
  }

  function playCue(frequencies: readonly number[], duration: number): void {
    if (!context || !master) return;
    frequencies.forEach((frequency, index) => {
      const oscillator = context!.createOscillator();
      const gain = context!.createGain();
      const start = context!.currentTime + index * 0.09;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain).connect(master!);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    });
  }

  function stopAudio(): void {
    drone?.stop();
    pulse?.stop();
    drone = null;
    pulse = null;
    void context?.close();
    context = null;
    master = null;
  }

  function updateControls(): void {
    toggle.textContent = `Sound: ${enabled ? 'On' : 'Off'}`;
    toggle.setAttribute('aria-pressed', String(enabled));
    volume.disabled = !enabled;
  }
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.28;
}
