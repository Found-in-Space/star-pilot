import './style.css';
import { Application, Container, Graphics, Text } from 'pixi.js';
import type { PlaneBasis, Vec2, Vec3 } from './math';
import type { SliceStats, StarPoint } from './star-stream';
import {
  clamp,
  distance3,
  length2,
  limit2,
  planeBasisFromNormal,
  planeToWorld,
} from './math';
import { createStarSliceSource } from './star-stream';

interface GameConfig {
  absoluteMagnitudeLimit: number;
  normal: Vec3;
  start: Vec3;
  thicknessPc: number;
  viewRadiusPc: number;
}

interface ShipState {
  angularVelocity: number;
  heading: number;
  position: Vec2;
  velocity: Vec2;
}

interface PointerState {
  active: boolean;
  x: number;
  y: number;
}

interface ScreenStar {
  star: StarPoint;
  x: number;
  y: number;
}

interface AutoLabelState {
  label: string | null;
  pending: boolean;
  text: Text | null;
}

interface Projectile {
  age: number;
  life: number;
  ownerFuse: number;
  position: Vec2;
  velocity: Vec2;
}

interface Particle {
  age: number;
  color: number;
  kind: 'debris' | 'spark';
  life: number;
  position: Vec2;
  sizePx: number;
  velocity: Vec2;
}

interface Shard {
  age: number;
  angle: number;
  angularVelocity: number;
  color: number;
  lengthPx: number;
  life: number;
  position: Vec2;
  velocity: Vec2;
}

interface ExplosionState {
  respawnInSeconds: number;
  shipAlive: boolean;
}

const DEFAULT_CONFIG: GameConfig = {
  absoluteMagnitudeLimit: 12,
  normal: { x: 0, y: 0, z: 1 },
  start: { x: 0, y: 0, z: 0 },
  thicknessPc: 20,
  viewRadiusPc: 10,
};

const SHIP_ACCELERATION_PC = 20;
const TURN_ACCELERATION = 7.5;
const ANGULAR_DAMPING = 0.18;
const MAX_SPEED_PC = 58;
const SHIP_COLLISION_RADIUS_PX = 15;
const SHIP_ENGINE_POINT_PX: Vec2 = { x: -10, y: 0 };
const SHIP_GUN_POINT_PX: Vec2 = { x: 16, y: 0 };
const SHIP_POINTS_PX: Vec2[] = [
  { x: 16, y: 0 },
  { x: -10, y: 9 },
  { x: -10, y: -9 },
];
const STOP_AUTOPILOT_ALIGNMENT_RADIANS = 0.12;
const STOP_AUTOPILOT_STOP_SPEED_PC = 0.08;
const STOP_AUTOPILOT_TURN_GAIN = 3.2;
const FIRE_COOLDOWN_SECONDS = 0.14;
const PROJECTILE_LIFE_SECONDS = 4;
const PROJECTILE_OWNER_FUSE_SECONDS = 0.25;
const PROJECTILE_SIZE_PX = 3;
const PROJECTILE_SPEED_PC = 18;
const SPARKS_PER_SECOND = 110;
const SPARK_SIZE_PX = 2;
const SPARK_SPREAD_RADIANS = Math.PI * 0.4;
const SPARK_COLORS = [0xfff2bd, 0xffbb43, 0xff6330, 0xe93826];
const DEBRIS_COLORS = [0xffffff, 0xffe58f, 0xff813a, 0xff3a27];
const EXPLOSION_RESPAWN_SECONDS = 1.2;
const PARTICLE_DRAG = 0.82;
const LOAD_OVERSCAN_MULTIPLIER = 2;
const AUTO_LABEL_LIMIT = 10;
const AUTO_LABEL_SCAN_LIMIT = 240;
const LABEL_INTEREST_SCREEN_MARGIN_PX = 180;
const LABEL_SCREEN_MARGIN_PX = 10;
const LABEL_CHAR_WIDTH_PX = 6.6;
const LABEL_OFFSET_Y_PX = 2;
const QUERY_INTERVAL_MS = 300;

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) {
  throw new Error('Missing #app root.');
}

appRoot.innerHTML = `
  <main class="pilot-shell">
    <aside class="control-panel">
      <header class="panel-header">
        <img class="brand-mark" src="./robbie.svg" alt="" aria-hidden="true">
        <div class="brand-copy">
          <p class="eyebrow">Found in Space - SkyKit</p>
          <h1>Star Pilot</h1>
        </div>
      </header>

      <form id="config-form" class="config-form">
        <fieldset>
          <legend>Start position pc</legend>
          <div class="triplet">
            <label>x <input name="startX" type="number" step="0.5" value="${DEFAULT_CONFIG.start.x}"></label>
            <label>y <input name="startY" type="number" step="0.5" value="${DEFAULT_CONFIG.start.y}"></label>
            <label>z <input name="startZ" type="number" step="0.5" value="${DEFAULT_CONFIG.start.z}"></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Game normal</legend>
          <div class="triplet">
            <label>x <input name="normalX" type="number" step="0.1" value="${DEFAULT_CONFIG.normal.x}"></label>
            <label>y <input name="normalY" type="number" step="0.1" value="${DEFAULT_CONFIG.normal.y}"></label>
            <label>z <input name="normalZ" type="number" step="0.1" value="${DEFAULT_CONFIG.normal.z}"></label>
          </div>
        </fieldset>

        <div class="slider-row">
          <label>
            Slice thickness pc
            <input name="thicknessPc" type="number" min="0.01" step="any" value="${DEFAULT_CONFIG.thicknessPc}">
          </label>
          <label>
            View radius pc
            <input name="viewRadiusPc" type="number" min="1" step="any" value="${DEFAULT_CONFIG.viewRadiusPc}">
          </label>
          <label>
            Absolute mag limit
            <input name="absoluteMagnitudeLimit" type="number" step="0.1" value="${DEFAULT_CONFIG.absoluteMagnitudeLimit}">
          </label>
        </div>

        <button class="primary-button" type="submit">Apply</button>
      </form>

      <dl class="stats-grid">
        <div><dt>stream</dt><dd id="stream-stat">idle</dd></div>
        <div><dt>stars</dt><dd id="stars-stat">0</dd></div>
        <div><dt>cells</dt><dd id="cells-stat">0</dd></div>
        <div><dt>speed</dt><dd id="speed-stat">0.0 pc/s</dd></div>
      </dl>
    </aside>

    <section id="stage" class="stage" aria-label="Star Pilot canvas">
      <div class="readout">
        <span id="position-stat">0, 0, 0 pc</span>
        <span id="hover-label">-</span>
      </div>
      <div class="touch-pad" aria-label="Flight controls">
        <button type="button" data-control="left" aria-label="Rotate left">&#9664;</button>
        <button type="button" data-control="thrust" aria-label="Thrust">&#9650;</button>
        <button type="button" data-control="right" aria-label="Rotate right">&#9654;</button>
        <button type="button" data-control="fire" aria-label="Fire">&#9679;</button>
      </div>
    </section>
  </main>
`;

const stageElement = requireElement<HTMLElement>('#stage');
const form = requireElement<HTMLFormElement>('#config-form');
const streamStat = requireElement<HTMLElement>('#stream-stat');
const starsStat = requireElement<HTMLElement>('#stars-stat');
const cellsStat = requireElement<HTMLElement>('#cells-stat');
const speedStat = requireElement<HTMLElement>('#speed-stat');
const positionStat = requireElement<HTMLElement>('#position-stat');
const hoverLabel = requireElement<HTMLElement>('#hover-label');

const pixi = new Application();
await pixi.init({
  antialias: true,
  autoDensity: true,
  backgroundAlpha: 0,
  preference: 'webgl',
  resizeTo: stageElement,
});
pixi.canvas.className = 'stage-canvas';
stageElement.prepend(pixi.canvas);

const starLayer = new Graphics();
const effectsLayer = new Graphics();
const labelLayer = new Container();
const shipLayer = new Graphics();
pixi.stage.addChild(starLayer, effectsLayer, labelLayer, shipLayer);

const keys = new Set<string>();
const projectiles: Projectile[] = [];
const particles: Particle[] = [];
const shards: Shard[] = [];
const autoLabels = new Map<string, AutoLabelState>();
const pointer: PointerState = { active: false, x: 0, y: 0 };
const buttonControls = new Set<string>();
const ship: ShipState = {
  angularVelocity: 0,
  heading: Math.PI / 2,
  position: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
};
let previousShipPosition: Vec2 = { ...ship.position };

let config = readConfigFromForm();
let basis: PlaneBasis = planeBasisFromNormal(config.normal);
let shipWorld = planeToWorld(config.start, basis, ship.position);
let lastQueryCenter: Vec3 | null = null;
let nextQueryAt = 0;
let latestStats: SliceStats = {
  cells: 0,
  drawnStars: 0,
  message: 'idle',
  rawStars: 0,
  status: 'idle',
};
let hoveredStarId = '';
let autoLabelCandidateSignature = '';
let autoLabelRequestSerial = 0;
let stopAutopilotActive = false;
let shotCooldown = 0;
let sparkAccumulator = 0;
const explosion: ExplosionState = {
  respawnInSeconds: 0,
  shipAlive: true,
};

const starSource = createStarSliceSource((stats) => {
  latestStats = stats;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  applyConfig();
});

window.addEventListener('keydown', (event) => {
  if (isEditingInput(event.target)) {
    return;
  }
  if (event.code === 'KeyH') {
    event.preventDefault();
    engageStopAutopilot();
    return;
  }
  if (isFireKey(event.code)) {
    event.preventDefault();
    cancelStopAutopilot();
    if (!keys.has(event.code)) {
      requestFire();
    }
    keys.add(event.code);
    return;
  }
  if (!isManualFlightKey(event.code)) {
    return;
  }
  if (stopAutopilotActive) {
    cancelStopAutopilot();
  }
  event.preventDefault();
  keys.add(event.code);
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-control]')) {
  const control = button.dataset.control;
  if (!control) {
    continue;
  }
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    cancelStopAutopilot();
    button.setPointerCapture(event.pointerId);
    buttonControls.add(control);
    if (control === 'fire') {
      requestFire();
    }
  });
  button.addEventListener('pointerup', () => {
    buttonControls.delete(control);
  });
  button.addEventListener('pointercancel', () => {
    buttonControls.delete(control);
  });
  button.addEventListener('lostpointercapture', () => {
    buttonControls.delete(control);
  });
}

pixi.canvas.addEventListener('pointermove', (event) => {
  const bounds = pixi.canvas.getBoundingClientRect();
  pointer.active = true;
  pointer.x = event.clientX - bounds.left;
  pointer.y = event.clientY - bounds.top;
});

pixi.canvas.addEventListener('pointerleave', () => {
  pointer.active = false;
  hoveredStarId = '';
  hoverLabel.textContent = '-';
});

window.addEventListener('beforeunload', () => {
  starSource.dispose();
});

applyConfig();

pixi.ticker.add((ticker) => {
  const dt = Math.min(0.05, ticker.deltaMS / 1000);
  if (explosion.shipAlive) {
    previousShipPosition = { ...ship.position };
    updateShooting(dt);
    stepShip(dt);
  } else {
    updateRespawn(dt);
  }
  updateProjectiles(dt);
  updateParticles(dt);
  shipWorld = planeToWorld(config.start, basis, ship.position);
  maybeLoadStars(false);
  const stars = starSource.project({
    absoluteMagnitudeLimit: config.absoluteMagnitudeLimit,
    basis,
    center: shipWorld,
    thicknessPc: config.thicknessPc,
    viewRadiusPc: projectedViewportRadiusPc(),
  });
  drawScene(stars);
  updateReadouts(stars);
});

function applyConfig(): void {
  config = readConfigFromForm();
  basis = planeBasisFromNormal(config.normal);
  resetShipState();
  cancelStopAutopilot();
  explosion.shipAlive = true;
  explosion.respawnInSeconds = 0;
  clearEffects();
  shipWorld = planeToWorld(config.start, basis, ship.position);
  lastQueryCenter = null;
  nextQueryAt = 0;
  clearAutoLabels();
  maybeLoadStars(true);
}

function controlActive(control: 'left' | 'right' | 'thrust'): boolean {
  if (control === 'left') {
    return keys.has('ArrowLeft') || keys.has('KeyA') || buttonControls.has('left');
  }
  if (control === 'right') {
    return keys.has('ArrowRight') || keys.has('KeyD') || buttonControls.has('right');
  }
  if (control === 'thrust') {
    return keys.has('ArrowUp') || keys.has('KeyW') || buttonControls.has('thrust');
  }
  return false;
}

function drawScene(stars: StarPoint[]): void {
  const width = pixi.screen.width;
  const height = pixi.screen.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const scale = pixelsPerParsec();

  const visibleStars: ScreenStar[] = [];
  const labelInterestStars: ScreenStar[] = [];
  starLayer.clear();
  for (const star of stars) {
    const x = centerX + star.xPc * scale;
    const y = centerY - star.yPc * scale;
    if (isStarInLabelInterest(star, x, y, width, height)) {
      labelInterestStars.push({ star, x, y });
    }
    if (!isStarOnScreen(x, y, width, height)) {
      continue;
    }
    visibleStars.push({ star, x, y });
    starLayer
      .circle(x, y, star.radiusPx)
      .fill({ alpha: star.screenAlpha, color: star.color });
  }

  updateAutoLabels(visibleStars, labelInterestStars, width, height);
  drawEffects(centerX, centerY, width, height, scale);
  drawShip(centerX, centerY);
}

function updateAutoLabels(
  visibleStars: ScreenStar[],
  labelInterestStars: ScreenStar[],
  width: number,
  height: number,
): void {
  const visibleById = new Map(visibleStars.map((entry) => [entry.star.id, entry]));
  const interestIds = new Set(labelInterestStars.map((entry) => entry.star.id));
  if (latestStats.status !== 'loading') {
    for (const [starId, state] of autoLabels) {
      if (interestIds.has(starId)) {
        continue;
      }
      state.text?.destroy();
      autoLabels.delete(starId);
    }
  }

  const sortedCandidates = [...labelInterestStars]
    .filter((entry) => entry.star.ref || entry.star.isSol)
    .sort((left, right) => left.star.absoluteMagnitude - right.star.absoluteMagnitude);
  const candidates = [
    ...sortedCandidates.filter((entry) => entry.star.isSol),
    ...sortedCandidates.filter((entry) => !entry.star.isSol),
  ].slice(0, AUTO_LABEL_SCAN_LIMIT);
  requestAutoLabels(candidates.map((entry) => entry.star));

  for (const [starId, state] of autoLabels) {
    const screenStar = visibleById.get(starId);
    if (!screenStar || !state.label) {
      if (state.text) {
        state.text.visible = false;
      }
      continue;
    }
    const labelText = state.text ?? createAutoLabelText(state.label);
    state.text = labelText;
    if (!labelText.parent) {
      labelLayer.addChild(labelText);
    }
    positionAutoLabel(labelText, screenStar, width, height);
    labelText.visible = true;
  }
}

function requestAutoLabels(stars: StarPoint[]): void {
  const signature = stars.map((star) => star.id).join('|');
  if (!signature || signature === autoLabelCandidateSignature) {
    return;
  }
  autoLabelCandidateSignature = signature;
  const requestSerial = ++autoLabelRequestSerial;

  void starSource.resolveMapLabels(stars, AUTO_LABEL_LIMIT).then((labels) => {
    if (requestSerial < autoLabelRequestSerial - 1) {
      return;
    }
    for (const { label, starId } of labels) {
      const state = autoLabels.get(starId) ?? {
        label: null,
        pending: false,
        text: null,
      };
      if (state.label !== label) {
        state.text?.destroy();
        state.text = null;
      }
      state.label = label;
      state.pending = false;
      autoLabels.set(starId, state);
    }
  }).catch(() => {
    if (requestSerial === autoLabelRequestSerial) {
      autoLabelCandidateSignature = '';
    }
  });
}

function createAutoLabelText(label: string): Text {
  const text = new Text({
    text: label,
    style: {
      dropShadow: {
        alpha: 0.6,
        angle: Math.PI / 2,
        blur: 3,
        color: 0x02060a,
        distance: 1,
      },
      fill: 0xeef8ff,
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0,
      stroke: {
        color: 0x071019,
        width: 3,
      },
    },
  });
  text.eventMode = 'none';
  text.roundPixels = true;
  return text;
}

function positionAutoLabel(text: Text, screenStar: ScreenStar, width: number, height: number): void {
  const estimatedWidth = text.text.length * LABEL_CHAR_WIDTH_PX;
  text.anchor.set(0, 0);
  text.alpha = clamp(screenStar.star.screenAlpha + 0.22, 0.62, 0.94);
  text.position.set(
    clamp(
      screenStar.x - estimatedWidth / 2,
      LABEL_SCREEN_MARGIN_PX,
      Math.max(LABEL_SCREEN_MARGIN_PX, width - estimatedWidth - LABEL_SCREEN_MARGIN_PX),
    ),
    clamp(
      screenStar.y + LABEL_OFFSET_Y_PX + screenStar.star.radiusPx,
      LABEL_SCREEN_MARGIN_PX + 4,
      height - LABEL_SCREEN_MARGIN_PX,
    ),
  );
}

function clearAutoLabels(): void {
  for (const state of autoLabels.values()) {
    state.text?.destroy();
  }
  autoLabels.clear();
  labelLayer.removeChildren();
  autoLabelCandidateSignature = '';
  autoLabelRequestSerial += 1;
}

function isStarOnScreen(x: number, y: number, width: number, height: number): boolean {
  return isStarWithinScreenMargin(x, y, width, height, LABEL_SCREEN_MARGIN_PX);
}

function isStarInLabelInterest(
  _star: StarPoint,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return isStarWithinScreenMargin(x, y, width, height, LABEL_INTEREST_SCREEN_MARGIN_PX);
}

function isStarWithinScreenMargin(
  x: number,
  y: number,
  width: number,
  height: number,
  marginPx: number,
): boolean {
  return x >= -marginPx &&
    x <= width + marginPx &&
    y >= -marginPx &&
    y <= height + marginPx;
}

function drawEffects(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  scale: number,
): void {
  effectsLayer.clear();

  for (const particle of particles) {
    const screen = planePointToScreen(particle.position, centerX, centerY, scale);
    if (!isStarWithinScreenMargin(screen.x, screen.y, width, height, 80)) {
      continue;
    }
    const lifeRatio = 1 - particle.age / particle.life;
    const flicker = particle.kind === 'spark' && Math.random() < 0.28 ? 0.55 : 1;
    const alpha = clamp(lifeRatio * flicker, 0, particle.kind === 'spark' ? 0.88 : 0.96);
    const size = particle.sizePx * clamp(0.55 + lifeRatio * 0.65, 0.55, 1.2);
    effectsLayer
      .rect(screen.x - size / 2, screen.y - size / 2, size, size)
      .fill({ alpha, color: particle.color });
  }

  for (const projectile of projectiles) {
    const screen = planePointToScreen(projectile.position, centerX, centerY, scale);
    if (!isStarWithinScreenMargin(screen.x, screen.y, width, height, 80)) {
      continue;
    }
    const alpha = clamp(1 - projectile.age / projectile.life, 0.28, 1);
    effectsLayer
      .rect(
        screen.x - PROJECTILE_SIZE_PX / 2,
        screen.y - PROJECTILE_SIZE_PX / 2,
        PROJECTILE_SIZE_PX,
        PROJECTILE_SIZE_PX,
      )
      .fill({ alpha, color: 0xffffff });
  }

  for (const shard of shards) {
    const screen = planePointToScreen(shard.position, centerX, centerY, scale);
    if (!isStarWithinScreenMargin(screen.x, screen.y, width, height, 100)) {
      continue;
    }
    const dx = Math.cos(shard.angle) * shard.lengthPx / 2;
    const dy = Math.sin(shard.angle) * shard.lengthPx / 2;
    const alpha = clamp(1 - shard.age / shard.life, 0, 0.95);
    effectsLayer
      .moveTo(screen.x - dx, screen.y - dy)
      .lineTo(screen.x + dx, screen.y + dy)
      .stroke({ alpha, color: shard.color, width: 1 });
  }
}

function drawShip(centerX: number, centerY: number): void {
  shipLayer.clear();
  if (!explosion.shipAlive) {
    return;
  }

  const points = SHIP_POINTS_PX.map((point) => localPointToScreen(point, centerX, centerY));
  shipLayer
    .moveTo(points[0].x, points[0].y)
    .lineTo(points[1].x, points[1].y)
    .lineTo(points[2].x, points[2].y)
    .closePath()
    .stroke({ alpha: 0.96, color: 0xffffff, width: 1.5 });
}

function findHoveredStar(stars: StarPoint[]): StarPoint | null {
  if (!pointer.active) {
    return null;
  }
  const centerX = pixi.screen.width / 2;
  const centerY = pixi.screen.height / 2;
  const scale = pixelsPerParsec();
  let nearest: StarPoint | null = null;
  let nearestDistance = 12;

  for (const star of stars) {
    const x = centerX + star.xPc * scale;
    const y = centerY - star.yPc * scale;
    const distance = Math.hypot(pointer.x - x, pointer.y - y);
    if (distance < nearestDistance) {
      nearest = star;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function formatNumber(value: number, digits = 1): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function isEditingInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

function isManualFlightKey(code: string): boolean {
  return [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'KeyA',
    'KeyD',
    'KeyW',
  ].includes(code);
}

function isFireKey(code: string): boolean {
  return code === 'Space';
}

function maybeLoadStars(force: boolean): void {
  const now = performance.now();
  const movedPc = lastQueryCenter ? distance3(shipWorld, lastQueryCenter) : Number.POSITIVE_INFINITY;
  const thresholdPc = Math.max(0.75, config.viewRadiusPc * 0.22);
  if (!force && (now < nextQueryAt || movedPc < thresholdPc)) {
    return;
  }

  lastQueryCenter = shipWorld;
  nextQueryAt = now + QUERY_INTERVAL_MS;
  starSource.load({
    basis,
    center: shipWorld,
    loadRadiusPc: loadViewportRadiusPc(),
    reset: force,
    thicknessPc: config.thicknessPc,
    viewRadiusPc: projectedViewportRadiusPc(),
  });
}

function pixelsPerParsec(): number {
  const shortestSide = Math.max(320, Math.min(pixi.screen.width, pixi.screen.height));
  return shortestSide / (config.viewRadiusPc * 2.25);
}

function viewportHalfDiagonalPc(): number {
  return Math.hypot(pixi.screen.width, pixi.screen.height) / (2 * pixelsPerParsec());
}

function projectedViewportRadiusPc(): number {
  return viewportHalfDiagonalPc() + LABEL_INTEREST_SCREEN_MARGIN_PX / pixelsPerParsec();
}

function loadViewportRadiusPc(): number {
  return Math.max(config.viewRadiusPc, viewportHalfDiagonalPc()) * LOAD_OVERSCAN_MULTIPLIER;
}

function readConfigFromForm(): GameConfig {
  const data = new FormData(form);
  return {
    absoluteMagnitudeLimit: readNumber(
      data,
      'absoluteMagnitudeLimit',
      DEFAULT_CONFIG.absoluteMagnitudeLimit,
      -20,
      30,
    ),
    normal: {
      x: readNumber(data, 'normalX', DEFAULT_CONFIG.normal.x, -1000, 1000),
      y: readNumber(data, 'normalY', DEFAULT_CONFIG.normal.y, -1000, 1000),
      z: readNumber(data, 'normalZ', DEFAULT_CONFIG.normal.z, -1000, 1000),
    },
    start: {
      x: readNumber(data, 'startX', DEFAULT_CONFIG.start.x, -100000, 100000),
      y: readNumber(data, 'startY', DEFAULT_CONFIG.start.y, -100000, 100000),
      z: readNumber(data, 'startZ', DEFAULT_CONFIG.start.z, -100000, 100000),
    },
    thicknessPc: readNumber(data, 'thicknessPc', DEFAULT_CONFIG.thicknessPc, 0.01, 5000),
    viewRadiusPc: readNumber(data, 'viewRadiusPc', DEFAULT_CONFIG.viewRadiusPc, 1, 5000),
  };
}

function readNumber(data: FormData, key: string, fallback: number, min: number, max: number): number {
  const value = Number(data.get(key));
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing ${selector}.`);
  }
  return element;
}

function updateShooting(dt: number): void {
  shotCooldown = Math.max(0, shotCooldown - dt);
  if (!fireControlActive() || shotCooldown > 0) {
    return;
  }
  requestFire();
}

function requestFire(): void {
  if (!explosion.shipAlive || shotCooldown > 0) {
    return;
  }
  fireProjectile();
  shotCooldown = FIRE_COOLDOWN_SECONDS;
}

function updateProjectiles(dt: number): void {
  const collisionRadiusPc = SHIP_COLLISION_RADIUS_PX / pixelsPerParsec();
  for (let index = projectiles.length - 1; index >= 0; index--) {
    const projectile = projectiles[index];
    const previousProjectilePosition = { ...projectile.position };
    const previousAge = projectile.age;
    projectile.age += dt;
    projectile.position.x += projectile.velocity.x * dt;
    projectile.position.y += projectile.velocity.y * dt;
    if (
      explosion.shipAlive &&
      hasProjectileHitShip(projectile, previousProjectilePosition, previousAge, dt, collisionRadiusPc)
    ) {
      projectiles.splice(index, 1);
      explodeShip();
      continue;
    }

    if (projectile.age >= projectile.life) {
      projectiles.splice(index, 1);
    }
  }
}

function updateParticles(dt: number): void {
  const drag = Math.pow(PARTICLE_DRAG, dt);
  for (let index = particles.length - 1; index >= 0; index--) {
    const particle = particles[index];
    particle.age += dt;
    particle.position.x += particle.velocity.x * dt;
    particle.position.y += particle.velocity.y * dt;
    particle.velocity.x *= drag;
    particle.velocity.y *= drag;
    if (particle.age >= particle.life) {
      particles.splice(index, 1);
    }
  }

  for (let index = shards.length - 1; index >= 0; index--) {
    const shard = shards[index];
    shard.age += dt;
    shard.position.x += shard.velocity.x * dt;
    shard.position.y += shard.velocity.y * dt;
    shard.velocity.x *= drag;
    shard.velocity.y *= drag;
    shard.angle += shard.angularVelocity * dt;
    if (shard.age >= shard.life) {
      shards.splice(index, 1);
    }
  }
}

function updateRespawn(dt: number): void {
  explosion.respawnInSeconds -= dt;
  if (explosion.respawnInSeconds > 0) {
    return;
  }
  resetShipState();
  explosion.shipAlive = true;
  explosion.respawnInSeconds = 0;
  lastQueryCenter = null;
  nextQueryAt = 0;
}

function fireControlActive(): boolean {
  return keys.has('Space') || buttonControls.has('fire');
}

function fireProjectile(): void {
  const direction = directionFromHeading(ship.heading);
  const muzzle = localPointToPlane(SHIP_GUN_POINT_PX, pixelsPerParsec());
  const launchVelocity = { ...ship.velocity };
  projectiles.push({
    age: 0,
    life: PROJECTILE_LIFE_SECONDS,
    ownerFuse: PROJECTILE_OWNER_FUSE_SECONDS,
    position: muzzle,
    velocity: {
      x: launchVelocity.x + direction.x * PROJECTILE_SPEED_PC,
      y: launchVelocity.y + direction.y * PROJECTILE_SPEED_PC,
    },
  });
}

function hasProjectileHitShip(
  projectile: Projectile,
  previousProjectilePosition: Vec2,
  previousAge: number,
  dt: number,
  collisionRadiusPc: number,
): boolean {
  const activeStartAge = Math.max(projectile.ownerFuse, previousAge);
  const activeEndAge = Math.min(projectile.age, projectile.life);
  if (activeStartAge > activeEndAge || dt <= 0) {
    return false;
  }

  const startProgress = clamp((activeStartAge - previousAge) / dt, 0, 1);
  const endProgress = clamp((activeEndAge - previousAge) / dt, 0, 1);
  const relativeStart = interpolateRelativeProjectilePosition(
    previousProjectilePosition,
    projectile.position,
    previousShipPosition,
    ship.position,
    startProgress,
  );
  const relativeEnd = interpolateRelativeProjectilePosition(
    previousProjectilePosition,
    projectile.position,
    previousShipPosition,
    ship.position,
    endProgress,
  );
  return distanceSquaredToOriginSegment(relativeStart, relativeEnd) <= collisionRadiusPc * collisionRadiusPc;
}

function spawnThrustSparks(thrust: number, dt: number): void {
  sparkAccumulator += SPARKS_PER_SECOND * thrust * dt;
  const engine = localPointToPlane(SHIP_ENGINE_POINT_PX, pixelsPerParsec());
  while (sparkAccumulator >= 1) {
    sparkAccumulator -= 1;
    const angle = ship.heading + Math.PI + randomRange(-SPARK_SPREAD_RADIANS, SPARK_SPREAD_RADIANS);
    const speed = randomRange(4.5, 13);
    const color = SPARK_COLORS[Math.floor(Math.random() * SPARK_COLORS.length)] ?? SPARK_COLORS[0];
    particles.push({
      age: 0,
      color,
      kind: 'spark',
      life: randomRange(0.18, 0.52),
      position: {
        x: engine.x + randomRange(-0.08, 0.08),
        y: engine.y + randomRange(-0.08, 0.08),
      },
      sizePx: SPARK_SIZE_PX,
      velocity: {
        x: ship.velocity.x + Math.cos(angle) * speed,
        y: ship.velocity.y + Math.sin(angle) * speed,
      },
    });
  }
}

function explodeShip(): void {
  const origin = { ...ship.position };
  const inheritedVelocity = { ...ship.velocity };
  explosion.shipAlive = false;
  explosion.respawnInSeconds = EXPLOSION_RESPAWN_SECONDS;
  cancelStopAutopilot();
  clearManualFlightInputs();

  for (let index = 0; index < 58; index++) {
    const angle = randomRange(0, Math.PI * 2);
    const speed = randomRange(7, 36);
    const color = DEBRIS_COLORS[Math.floor(Math.random() * DEBRIS_COLORS.length)] ?? DEBRIS_COLORS[0];
    particles.push({
      age: 0,
      color,
      kind: 'debris',
      life: randomRange(0.55, 1.45),
      position: {
        x: origin.x + randomRange(-0.18, 0.18),
        y: origin.y + randomRange(-0.18, 0.18),
      },
      sizePx: randomRange(2, 4),
      velocity: {
        x: inheritedVelocity.x + Math.cos(angle) * speed,
        y: inheritedVelocity.y + Math.sin(angle) * speed,
      },
    });
  }

  for (let index = 0; index < 7; index++) {
    const angle = randomRange(0, Math.PI * 2);
    const speed = randomRange(5, 20);
    shards.push({
      age: 0,
      angle,
      angularVelocity: randomRange(-9, 9),
      color: index % 3 === 0 ? 0xffffff : 0xff6330,
      lengthPx: randomRange(7, 15),
      life: randomRange(0.65, 1.25),
      position: { ...origin },
      velocity: {
        x: inheritedVelocity.x + Math.cos(angle) * speed,
        y: inheritedVelocity.y + Math.sin(angle) * speed,
      },
    });
  }

  ship.velocity.x = 0;
  ship.velocity.y = 0;
  ship.angularVelocity = 0;
}

function resetShipState(): void {
  ship.position = { x: 0, y: 0 };
  ship.velocity = { x: 0, y: 0 };
  ship.angularVelocity = 0;
  ship.heading = Math.PI / 2;
  previousShipPosition = { ...ship.position };
  shotCooldown = 0;
  sparkAccumulator = 0;
}

function clearEffects(): void {
  projectiles.length = 0;
  particles.length = 0;
  shards.length = 0;
  effectsLayer.clear();
}

function localPointToPlane(localPoint: Vec2, scale: number): Vec2 {
  const direction = directionFromHeading(ship.heading);
  const side = sideFromDirection(direction);
  return {
    x: ship.position.x + (direction.x * localPoint.x + side.x * localPoint.y) / scale,
    y: ship.position.y + (direction.y * localPoint.x + side.y * localPoint.y) / scale,
  };
}

function localPointToScreen(localPoint: Vec2, centerX: number, centerY: number): Vec2 {
  const direction = directionFromHeading(ship.heading);
  const side = sideFromDirection(direction);
  const x = direction.x * localPoint.x + side.x * localPoint.y;
  const y = direction.y * localPoint.x + side.y * localPoint.y;
  return {
    x: centerX + x,
    y: centerY - y,
  };
}

function planePointToScreen(point: Vec2, centerX: number, centerY: number, scale: number): Vec2 {
  return {
    x: centerX + (point.x - ship.position.x) * scale,
    y: centerY - (point.y - ship.position.y) * scale,
  };
}

function interpolateRelativeProjectilePosition(
  projectileStart: Vec2,
  projectileEnd: Vec2,
  shipStart: Vec2,
  shipEnd: Vec2,
  progress: number,
): Vec2 {
  return {
    x: interpolate(projectileStart.x, projectileEnd.x, progress) - interpolate(shipStart.x, shipEnd.x, progress),
    y: interpolate(projectileStart.y, projectileEnd.y, progress) - interpolate(shipStart.y, shipEnd.y, progress),
  };
}

function distanceSquaredToOriginSegment(start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const segmentLengthSquared = dx * dx + dy * dy;
  if (segmentLengthSquared <= 0) {
    return start.x * start.x + start.y * start.y;
  }
  const progress = clamp(-(start.x * dx + start.y * dy) / segmentLengthSquared, 0, 1);
  const closestX = start.x + dx * progress;
  const closestY = start.y + dy * progress;
  return closestX * closestX + closestY * closestY;
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function directionFromHeading(heading: number): Vec2 {
  return {
    x: Math.cos(heading),
    y: Math.sin(heading),
  };
}

function sideFromDirection(direction: Vec2): Vec2 {
  return {
    x: -direction.y,
    y: direction.x,
  };
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function stepShip(dt: number): void {
  const thrust = stopAutopilotActive
    ? updateStopAutopilot(dt)
    : updateManualFlight(dt);

  const direction = {
    x: Math.cos(ship.heading),
    y: Math.sin(ship.heading),
  };
  if (thrust > 0) {
    ship.velocity.x += direction.x * thrust * SHIP_ACCELERATION_PC * dt;
    ship.velocity.y += direction.y * thrust * SHIP_ACCELERATION_PC * dt;
    spawnThrustSparks(thrust, dt);
  }

  const limitedVelocity = limit2(ship.velocity, MAX_SPEED_PC);
  ship.velocity.x = limitedVelocity.x;
  ship.velocity.y = limitedVelocity.y;
  ship.position.x += ship.velocity.x * dt;
  ship.position.y += ship.velocity.y * dt;
}

function updateManualFlight(dt: number): number {
  const turn = Number(controlActive('left')) - Number(controlActive('right'));
  ship.angularVelocity += turn * TURN_ACCELERATION * dt;
  ship.angularVelocity *= Math.pow(ANGULAR_DAMPING, dt);
  ship.heading += ship.angularVelocity * dt;
  return Number(controlActive('thrust'));
}

function updateStopAutopilot(dt: number): number {
  const speed = length2(ship.velocity);
  if (speed <= STOP_AUTOPILOT_STOP_SPEED_PC) {
    finishStopAutopilot();
    return 0;
  }

  const desiredHeading = Math.atan2(-ship.velocity.y, -ship.velocity.x);
  const headingError = signedAngleDelta(ship.heading, desiredHeading);
  const turn = clamp(
    headingError * STOP_AUTOPILOT_TURN_GAIN,
    -1,
    1,
  );
  ship.angularVelocity += turn * TURN_ACCELERATION * dt;
  ship.angularVelocity *= Math.pow(ANGULAR_DAMPING, dt);
  ship.heading += ship.angularVelocity * dt;

  const alignedError = Math.abs(signedAngleDelta(ship.heading, desiredHeading));
  if (alignedError > STOP_AUTOPILOT_ALIGNMENT_RADIANS) {
    return 0;
  }

  if (speed <= SHIP_ACCELERATION_PC * dt + STOP_AUTOPILOT_STOP_SPEED_PC) {
    finishStopAutopilot();
    return 0;
  }

  return 1;
}

function engageStopAutopilot(): void {
  clearManualFlightInputs();
  if (length2(ship.velocity) <= STOP_AUTOPILOT_STOP_SPEED_PC) {
    finishStopAutopilot();
    return;
  }
  stopAutopilotActive = true;
  ship.angularVelocity = 0;
}

function cancelStopAutopilot(): void {
  stopAutopilotActive = false;
}

function finishStopAutopilot(): void {
  ship.velocity.x = 0;
  ship.velocity.y = 0;
  ship.angularVelocity = 0;
  cancelStopAutopilot();
}

function clearManualFlightInputs(): void {
  for (const key of [...keys]) {
    if (isManualFlightKey(key) || isFireKey(key)) {
      keys.delete(key);
    }
  }
  buttonControls.clear();
}

function signedAngleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function updateReadouts(stars: StarPoint[]): void {
  streamStat.textContent = latestStats.status === 'error'
    ? latestStats.message
    : latestStats.status;
  starsStat.textContent = `${latestStats.drawnStars.toLocaleString()} / ${latestStats.rawStars.toLocaleString()}`;
  cellsStat.textContent = latestStats.cells.toLocaleString();
  speedStat.textContent = `${formatNumber(length2(ship.velocity))} pc/s`;
  positionStat.textContent = [
    formatNumber(shipWorld.x, 2),
    formatNumber(shipWorld.y, 2),
    formatNumber(shipWorld.z, 2),
  ].join(', ');

  const hovered = findHoveredStar(stars);
  if (!hovered) {
    hoveredStarId = '';
    hoverLabel.textContent = '-';
    return;
  }
  if (hovered.id === hoveredStarId) {
    return;
  }

  hoveredStarId = hovered.id;
  hoverLabel.textContent = hovered.labelFallback;
  void starSource.resolveLabel(hovered).then((label) => {
    if (hovered.id === hoveredStarId) {
      hoverLabel.textContent = label;
    }
  }).catch((error: unknown) => {
    if (hovered.id === hoveredStarId) {
      hoverLabel.textContent = error instanceof Error ? error.message : 'label lookup failed';
    }
  });
}
