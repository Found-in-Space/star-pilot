import {
  OCTREE_DEFAULT,
  createStarOctreeProviderService,
} from '@found-in-space/star-octree-provider';
import { createMetaSidecarProviderService } from '@found-in-space/meta-sidecar-provider';
import { temperatureToRgb } from '@found-in-space/star-trees';
import type {
  StarCellData,
  StarCellDelta,
  StarObjectRef,
  StarPickMeta,
} from '@found-in-space/star-trees';
import type { PlaneBasis, Vec3 } from './math';
import { clamp, worldToPlaneOffset } from './math';
import { createPizzaStrategy } from './pizza-strategy';

const DATASET_ID = 'found-in-space-dataset';
const MAX_DRAWN_STARS = 4500;

type StreamStatus = 'idle' | 'loading' | 'current' | 'error';

export interface SliceLoadOptions {
  basis: PlaneBasis;
  center: Vec3;
  loadRadiusPc: number;
  thicknessPc: number;
  viewRadiusPc: number;
}

export interface SliceStats {
  cells: number;
  drawnStars: number;
  message: string;
  rawStars: number;
  status: StreamStatus;
}

export interface StarPoint {
  absoluteMagnitude: number;
  color: number;
  depthPc: number;
  id: string;
  labelFallback: string;
  pickMeta: StarPickMeta | null;
  radiusPx: number;
  ref: StarObjectRef | null;
  screenAlpha: number;
  xPc: number;
  yPc: number;
}

export interface StarSliceSource {
  dispose(): void;
  getStats(): SliceStats;
  load(options: SliceLoadOptions): void;
  project(options: {
    absoluteMagnitudeLimit: number;
    basis: PlaneBasis;
    center: Vec3;
    thicknessPc: number;
    viewRadiusPc: number;
  }): StarPoint[];
  resolveLabel(star: StarPoint): Promise<string>;
}

export function createStarSliceSource(onStats: (stats: SliceStats) => void): StarSliceSource {
  const starProvider = createStarOctreeProviderService({
    datasetId: DATASET_ID,
    id: 'star-pilot-octree',
    persistentCache: 'on',
    url: OCTREE_DEFAULT,
  });
  const metaProvider = createMetaSidecarProviderService({
    entries: {},
    id: 'star-pilot-meta',
    parentDatasetId: DATASET_ID,
  });
  const cells = new Map<string, StarCellData>();
  const labelCache = new Map<string, string>();
  let abortController: AbortController | null = null;
  let streamId = 0;
  let stats: SliceStats = {
    cells: 0,
    drawnStars: 0,
    message: 'idle',
    rawStars: 0,
    status: 'idle',
  };

  function publish(nextStats: Partial<SliceStats>): void {
    stats = { ...stats, ...nextStats };
    onStats(stats);
  }

  function updateCellStats(status: StreamStatus, message: string): void {
    let rawStars = 0;
    for (const cell of cells.values()) {
      rawStars += cell.count;
    }
    publish({
      cells: cells.size,
      message,
      rawStars,
      status,
    });
  }

  async function runLoad(id: number, options: SliceLoadOptions, signal: AbortSignal): Promise<void> {
    try {
      for await (const delta of starProvider.streamCells({
        attributes: ['position', 'magAbs', 'teffLog8', 'objectRef', 'pickMeta'],
        id: `star-pilot-slice-${id}`,
        memory: { ownership: 'copy' },
        signal,
        strategy: createPizzaStrategy({
          basis: options.basis,
          centerPc: options.center,
          radiusPc: options.loadRadiusPc,
          thicknessPc: options.thicknessPc,
        }),
        view: {
          observerPc: options.center,
        },
      })) {
        if (id !== streamId || signal.aborted) {
          return;
        }
        applyDelta(delta);
      }
    } catch (error) {
      if (id !== streamId || isAbortError(error)) {
        return;
      }
      publish({
        message: error instanceof Error ? error.message : 'Star stream failed',
        status: 'error',
      });
    }
  }

  function applyDelta(delta: StarCellDelta): void {
    if (delta.type === 'stars/cells-upsert') {
      for (const cell of delta.cells) {
        cells.set(cell.cellKey, cell);
      }
      updateCellStats('loading', 'streaming');
      return;
    }
    if (delta.type === 'stars/cells-remove') {
      for (const cellKey of delta.cellKeys) {
        cells.delete(cellKey);
      }
      updateCellStats('loading', 'refreshing');
      return;
    }
    if (delta.type === 'stars/current') {
      updateCellStats('current', 'current');
      return;
    }
    if (delta.type === 'stars/error') {
      publish({
        message: delta.error.message,
        status: 'error',
      });
    }
  }

  return {
    dispose() {
      abortController?.abort();
      cells.clear();
      metaProvider.dispose();
      void starProvider.dispose();
    },

    getStats() {
      return stats;
    },

    load(options) {
      abortController?.abort();
      abortController = new AbortController();
      streamId += 1;
      cells.clear();
      publish({
        cells: 0,
        drawnStars: 0,
        message: 'loading',
        rawStars: 0,
        status: 'loading',
      });
      void runLoad(streamId, options, abortController.signal);
    },

    project(options) {
      const halfThickness = Math.max(0.01, options.thicknessPc / 2);
      const projected: StarPoint[] = [];

      for (const cell of cells.values()) {
        const positions = cell.coordinates.components;
        for (let index = 0; index < cell.count; index += 1) {
          const offset = index * 3;
          const world = {
            x: positions[offset] ?? 0,
            y: positions[offset + 1] ?? 0,
            z: positions[offset + 2] ?? 0,
          };
          const plane = worldToPlaneOffset(options.center, options.basis, world);
          const radialPc = Math.hypot(plane.x, plane.y);
          if (Math.abs(plane.depth) > halfThickness || radialPc > options.viewRadiusPc) {
            continue;
          }

          const magAbs = cell.attributes.magAbs?.[index];
          const absoluteMagnitude = typeof magAbs === 'number' && Number.isFinite(magAbs)
            ? magAbs
            : options.absoluteMagnitudeLimit;
          if (absoluteMagnitude > options.absoluteMagnitudeLimit) {
            continue;
          }

          const color = colorForTemperature(cell.attributes.teffLog8?.[index]);
          const ref = refForStar(cell, index);
          const pickMeta = cell.pickMeta?.[index] ?? null;
          const id = ref
            ? `${ref.level}:${ref.mortonCode}:${ref.ordinal}`
            : `${cell.cellKey}:${index}`;
          const depthFade = 1 - Math.abs(plane.depth) / halfThickness;
          const brightness = magnitudeBrightness(absoluteMagnitude, options.absoluteMagnitudeLimit);

          projected.push({
            absoluteMagnitude,
            color,
            depthPc: plane.depth,
            id,
            labelFallback: fallbackLabel(ref, cell.cellKey, index),
            pickMeta,
            radiusPx: clamp(0.55 + brightness * 3.1, 0.55, 3.65),
            ref,
            screenAlpha: clamp(0.13 + depthFade * 0.22 + brightness * 0.68, 0.11, 0.96),
            xPc: plane.x,
            yPc: plane.y,
          });
        }
      }

      projected.sort((a, b) => a.absoluteMagnitude - b.absoluteMagnitude);
      const brightest = projected.slice(0, MAX_DRAWN_STARS);
      brightest.sort((a, b) => b.absoluteMagnitude - a.absoluteMagnitude);
      publish({ drawnStars: brightest.length });
      return brightest;
    },

    async resolveLabel(star) {
      if (!star.ref) {
        return star.labelFallback;
      }
      const cached = labelCache.get(star.id);
      if (cached) {
        return cached;
      }
      const label = await metaProvider.resolvePrimaryLabel(star.ref);
      const resolved = label || star.labelFallback;
      labelCache.set(star.id, resolved);
      return resolved;
    },
  };
}

function colorForTemperature(teffLog8: number | undefined): number {
  if (teffLog8 == null) {
    return 0xd8e2ff;
  }
  const [red, green, blue] = temperatureToRgb(teffLog8);
  return (red << 16) + (green << 8) + blue;
}

function magnitudeBrightness(absoluteMagnitude: number, limit: number): number {
  const brightest = -6;
  const span = Math.max(1, limit - brightest);
  return clamp((limit - absoluteMagnitude) / span, 0, 1);
}

function fallbackLabel(ref: StarObjectRef | null, cellKey: string, ordinal: number): string {
  if (!ref) {
    return `cell ${cellKey} / ${ordinal}`;
  }
  return `cell ${ref.level}:${ref.mortonCode} / ${ref.ordinal}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function refForStar(cell: StarCellData, ordinal: number): StarObjectRef | null {
  const ref = cell.refs?.[ordinal];
  if (ref) {
    return {
      datasetId: ref.datasetId ?? DATASET_ID,
      level: ref.level,
      mortonCode: ref.mortonCode,
      ordinal: ref.ordinal,
    };
  }
  return {
    datasetId: DATASET_ID,
    level: cell.cell.level,
    mortonCode: cell.cell.mortonCode,
    ordinal,
  };
}
