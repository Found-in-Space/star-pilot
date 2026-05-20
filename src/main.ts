import './style.css';
import { Application, Graphics } from 'pixi.js';
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

const DEFAULT_CONFIG: GameConfig = {
  absoluteMagnitudeLimit: 12,
  normal: { x: 0, y: 0, z: 1 },
  start: { x: 0, y: 0, z: 0 },
  thicknessPc: 4,
  viewRadiusPc: 18,
};

const SHIP_ACCELERATION_PC = 20;
const REVERSE_ACCELERATION_PC = 8;
const TURN_ACCELERATION = 7.5;
const ANGULAR_DAMPING = 0.18;
const BRAKE_DAMPING = 0.03;
const MAX_SPEED_PC = 58;
const LOAD_OVERSCAN_MULTIPLIER = 2;
const QUERY_INTERVAL_MS = 300;

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) {
  throw new Error('Missing #app root.');
}

appRoot.innerHTML = `
  <main class="pilot-shell">
    <aside class="control-panel">
      <header class="panel-header">
        <p class="eyebrow">SkyKit alpha</p>
        <h1>Star Pilot</h1>
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
        <button type="button" data-control="brake" aria-label="Brake">&#9670;</button>
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

const gridLayer = new Graphics();
const starLayer = new Graphics();
const shipLayer = new Graphics();
pixi.stage.addChild(gridLayer, starLayer, shipLayer);

const keys = new Set<string>();
const pointer: PointerState = { active: false, x: 0, y: 0 };
const buttonControls = new Set<string>();
const ship: ShipState = {
  angularVelocity: 0,
  heading: Math.PI / 2,
  position: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
};

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

const starSource = createStarSliceSource((stats) => {
  latestStats = stats;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  applyConfig();
});

window.addEventListener('keydown', (event) => {
  if (!isFlightKey(event.code) || isEditingInput(event.target)) {
    return;
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
    button.setPointerCapture(event.pointerId);
    buttonControls.add(control);
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
  stepShip(dt);
  shipWorld = planeToWorld(config.start, basis, ship.position);
  maybeLoadStars(false);
  const stars = starSource.project({
    absoluteMagnitudeLimit: config.absoluteMagnitudeLimit,
    basis,
    center: shipWorld,
    thicknessPc: config.thicknessPc,
    viewRadiusPc: config.viewRadiusPc,
  });
  drawScene(stars);
  updateReadouts(stars);
});

function applyConfig(): void {
  config = readConfigFromForm();
  basis = planeBasisFromNormal(config.normal);
  ship.position = { x: 0, y: 0 };
  ship.velocity = { x: 0, y: 0 };
  ship.angularVelocity = 0;
  ship.heading = Math.PI / 2;
  shipWorld = planeToWorld(config.start, basis, ship.position);
  lastQueryCenter = null;
  nextQueryAt = 0;
  maybeLoadStars(true);
}

function controlActive(control: 'brake' | 'left' | 'reverse' | 'right' | 'thrust'): boolean {
  if (control === 'left') {
    return keys.has('ArrowLeft') || keys.has('KeyA') || buttonControls.has('left');
  }
  if (control === 'right') {
    return keys.has('ArrowRight') || keys.has('KeyD') || buttonControls.has('right');
  }
  if (control === 'thrust') {
    return keys.has('ArrowUp') || keys.has('KeyW') || buttonControls.has('thrust');
  }
  if (control === 'reverse') {
    return keys.has('ArrowDown') || keys.has('KeyS');
  }
  return keys.has('Space') || buttonControls.has('brake');
}

function drawScene(stars: StarPoint[]): void {
  const width = pixi.screen.width;
  const height = pixi.screen.height;
  const centerX = width / 2;
  const centerY = height / 2;
  const scale = pixelsPerParsec();

  gridLayer.clear();
  const radiusPx = config.viewRadiusPc * scale;
  gridLayer
    .circle(centerX, centerY, radiusPx)
    .stroke({ alpha: 0.2, color: 0x83d6ff, width: 1 });
  gridLayer
    .moveTo(centerX - radiusPx, centerY)
    .lineTo(centerX + radiusPx, centerY)
    .moveTo(centerX, centerY - radiusPx)
    .lineTo(centerX, centerY + radiusPx)
    .stroke({ alpha: 0.12, color: 0xf5d36b, width: 1 });

  starLayer.clear();
  for (const star of stars) {
    const x = centerX + star.xPc * scale;
    const y = centerY - star.yPc * scale;
    if (x < -8 || x > width + 8 || y < -8 || y > height + 8) {
      continue;
    }
    starLayer
      .circle(x, y, star.radiusPx)
      .fill({ alpha: star.screenAlpha, color: star.color });
  }

  drawShip(centerX, centerY);
}

function drawShip(centerX: number, centerY: number): void {
  const direction = {
    x: Math.cos(ship.heading),
    y: Math.sin(ship.heading),
  };
  const side = { x: -direction.y, y: direction.x };
  const tip = { x: direction.x * 18, y: direction.y * 18 };
  const left = {
    x: direction.x * -13 + side.x * 10,
    y: direction.y * -13 + side.y * 10,
  };
  const right = {
    x: direction.x * -13 - side.x * 10,
    y: direction.y * -13 - side.y * 10,
  };

  shipLayer.clear();
  shipLayer
    .moveTo(centerX + tip.x, centerY - tip.y)
    .lineTo(centerX + left.x, centerY - left.y)
    .lineTo(centerX + right.x, centerY - right.y)
    .closePath()
    .fill({ alpha: 0.86, color: 0xfff7d1 })
    .stroke({ alpha: 0.95, color: 0x1ce6b8, width: 2 });

  if (controlActive('thrust')) {
    const flame = {
      x: direction.x * -26,
      y: direction.y * -26,
    };
    shipLayer
      .moveTo(centerX + left.x * 0.55, centerY - left.y * 0.55)
      .lineTo(centerX + flame.x, centerY - flame.y)
      .lineTo(centerX + right.x * 0.55, centerY - right.y * 0.55)
      .closePath()
      .fill({ alpha: 0.72, color: 0xff8a3d });
  }
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

function isFlightKey(code: string): boolean {
  return [
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'KeyA',
    'KeyD',
    'KeyS',
    'KeyW',
    'Space',
  ].includes(code);
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
    loadRadiusPc: config.viewRadiusPc * LOAD_OVERSCAN_MULTIPLIER,
    thicknessPc: config.thicknessPc,
    viewRadiusPc: config.viewRadiusPc,
  });
}

function pixelsPerParsec(): number {
  const shortestSide = Math.max(320, Math.min(pixi.screen.width, pixi.screen.height));
  return shortestSide / (config.viewRadiusPc * 2.25);
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

function stepShip(dt: number): void {
  const turn = Number(controlActive('left')) - Number(controlActive('right'));
  ship.angularVelocity += turn * TURN_ACCELERATION * dt;
  ship.angularVelocity *= Math.pow(ANGULAR_DAMPING, dt);
  ship.heading += ship.angularVelocity * dt;

  const direction = {
    x: Math.cos(ship.heading),
    y: Math.sin(ship.heading),
  };
  const thrust = Number(controlActive('thrust')) - Number(controlActive('reverse')) * 0.55;
  const acceleration = thrust >= 0 ? SHIP_ACCELERATION_PC : REVERSE_ACCELERATION_PC;
  ship.velocity.x += direction.x * thrust * acceleration * dt;
  ship.velocity.y += direction.y * thrust * acceleration * dt;

  if (controlActive('brake')) {
    ship.velocity.x *= Math.pow(BRAKE_DAMPING, dt);
    ship.velocity.y *= Math.pow(BRAKE_DAMPING, dt);
  }

  const limitedVelocity = limit2(ship.velocity, MAX_SPEED_PC);
  ship.velocity.x = limitedVelocity.x;
  ship.velocity.y = limitedVelocity.y;
  ship.position.x += ship.velocity.x * dt;
  ship.position.y += ship.velocity.y * dt;
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
  });
}
