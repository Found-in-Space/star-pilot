import {
  OCTREE_DEFAULT,
  createStarOctreeProviderService,
} from '@found-in-space/star-octree-provider';
import {
  createMetaSidecarProviderService,
  deriveMetaSidecarUrlFromRenderUrl,
} from '@found-in-space/meta-sidecar-provider';
import type {
  MetaSidecarEntry,
  MetaSidecarProviderService,
} from '@found-in-space/meta-sidecar-provider';
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

const MAX_DRAWN_STARS = 4500;
const SOL_POSITION_EPSILON_PC = 1e-6;

type StreamStatus = 'idle' | 'loading' | 'current' | 'error';

export interface SliceLoadOptions {
  basis: PlaneBasis;
  center: Vec3;
  loadRadiusPc: number;
  reset?: boolean;
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
  cellKey: string;
  cellOrdinal: number;
  color: number;
  depthPc: number;
  id: string;
  isSol: boolean;
  labelFallback: string;
  pickMeta: StarPickMeta | null;
  radialPc: number;
  radiusPx: number;
  ref: StarObjectRef | null;
  screenAlpha: number;
  xPc: number;
  yPc: number;
}

export interface StarMapLabel {
  label: string;
  starId: string;
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
  resolveMapLabels(stars: StarPoint[], limit: number): Promise<StarMapLabel[]>;
}

export function createStarSliceSource(onStats: (stats: SliceStats) => void): StarSliceSource {
  const starProvider = createStarOctreeProviderService({
    id: 'star-pilot-octree',
    persistentCache: 'on',
    url: OCTREE_DEFAULT,
  });
  const cells = new Map<string, StarCellData>();
  const labelCache = new Map<string, string>();
  const mapLabelCache = new Map<string, string | null>();
  const mapCellEntriesCache = new Map<string, Promise<MetaSidecarEntry[] | null>>();
  let abortController: AbortController | null = null;
  let currentDatasetId: string | null = null;
  let disposed = false;
  let metaProvider: MetaSidecarProviderService | null = null;
  let pendingLoadCellKeys: Set<string> | null = null;
  const metaProviderPromise = starProvider.ensureBootstrap().then((bootstrap) => {
    if (!bootstrap.datasetId) {
      throw new Error('Star Pilot requires a render octree dataset id for meta sidecar lookup.');
    }

    currentDatasetId = bootstrap.datasetId;
    const provider = createMetaSidecarProviderService({
      id: 'star-pilot-meta',
      parentDatasetId: bootstrap.datasetId,
      persistentCache: 'on',
      url: deriveMetaSidecarUrlFromRenderUrl(OCTREE_DEFAULT),
    });
    metaProvider = provider;
    if (disposed) {
      provider.dispose();
    }
    return provider;
  });
  void metaProviderPromise.catch(() => {});
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
      pendingLoadCellKeys = null;
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
        pendingLoadCellKeys?.add(cell.cellKey);
      }
      updateCellStats('loading', 'streaming');
      return;
    }
    if (delta.type === 'stars/cells-remove') {
      if (!pendingLoadCellKeys) {
        for (const cellKey of delta.cellKeys) {
          cells.delete(cellKey);
        }
      }
      updateCellStats('loading', 'refreshing');
      return;
    }
    if (delta.type === 'stars/current') {
      if (pendingLoadCellKeys) {
        for (const cellKey of cells.keys()) {
          if (!pendingLoadCellKeys.has(cellKey)) {
            cells.delete(cellKey);
          }
        }
        pendingLoadCellKeys = null;
      }
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
      disposed = true;
      abortController?.abort();
      cells.clear();
      pendingLoadCellKeys = null;
      metaProvider?.dispose();
      void metaProviderPromise.then((provider) => provider.dispose(), () => {});
      void starProvider.dispose();
    },

    getStats() {
      return stats;
    },

    load(options) {
      abortController?.abort();
      abortController = new AbortController();
      streamId += 1;
      pendingLoadCellKeys = new Set();
      if (options.reset) {
        cells.clear();
        publish({
          cells: 0,
          drawnStars: 0,
          message: 'loading',
          rawStars: 0,
          status: 'loading',
        });
      } else {
        updateCellStats('loading', 'loading');
      }
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
          const isSol = isSolPosition(world);
          const plane = worldToPlaneOffset(options.center, options.basis, world);
          const radialPc = Math.hypot(plane.x, plane.y);
          if (Math.abs(plane.depth) > halfThickness || radialPc > options.viewRadiusPc) {
            continue;
          }

          const magAbs = cell.attributes.magAbs?.[index];
          const absoluteMagnitude = typeof magAbs === 'number' && Number.isFinite(magAbs)
            ? magAbs
            : options.absoluteMagnitudeLimit;
          if (!isSol && absoluteMagnitude > options.absoluteMagnitudeLimit) {
            continue;
          }

          const color = colorForTemperature(cell.attributes.teffLog8?.[index]);
          const ref = refForStar(cell, index, currentDatasetId);
          const pickMeta = cell.pickMeta?.[index] ?? null;
          const id = ref
            ? `${ref.level}:${ref.mortonCode}:${ref.ordinal}`
            : `${cell.cellKey}:${index}`;
          const depthFade = 1 - Math.abs(plane.depth) / halfThickness;
          const brightness = magnitudeBrightness(absoluteMagnitude, options.absoluteMagnitudeLimit);

          projected.push({
            absoluteMagnitude,
            cellKey: cell.cellKey,
            cellOrdinal: index,
            color,
            depthPc: plane.depth,
            id,
            isSol,
            labelFallback: fallbackLabel(ref, cell.cellKey, index),
            pickMeta,
            radialPc,
            radiusPx: clamp(0.55 + brightness * 3.1, 0.55, 3.65),
            ref,
            screenAlpha: clamp(0.13 + depthFade * 0.22 + brightness * 0.68, 0.11, 0.96),
            xPc: plane.x,
            yPc: plane.y,
          });
        }
      }

      projected.sort((a, b) => a.absoluteMagnitude - b.absoluteMagnitude);
      const solStars = projected.filter((star) => star.isSol);
      const brightest = [
        ...projected
          .filter((star) => !star.isSol)
          .slice(0, Math.max(0, MAX_DRAWN_STARS - solStars.length)),
        ...solStars,
      ];
      brightest.sort((a, b) => b.absoluteMagnitude - a.absoluteMagnitude);
      publish({ drawnStars: brightest.length });
      return brightest;
    },

    async resolveLabel(star) {
      if (star.isSol) {
        return 'Sol';
      }
      if (!star.ref) {
        return star.labelFallback;
      }
      const cached = labelCache.get(star.id);
      if (cached) {
        return cached;
      }
      const provider = await metaProviderPromise;
      const entry = await provider.getMeta(star.ref);
      const label = entry ? hoverLabelFromMeta(entry) : '';
      const resolved = label || star.labelFallback;
      labelCache.set(star.id, resolved);
      return resolved;
    },

    async resolveMapLabels(stars, limit) {
      if (limit <= 0) {
        return [];
      }

      const candidates = stars
        .filter((star) => star.ref || star.isSol)
        .sort((left, right) => left.absoluteMagnitude - right.absoluteMagnitude);
      const orderedCandidates = [
        ...candidates.filter((star) => star.isSol),
        ...candidates.filter((star) => !star.isSol),
      ];
      const byCell = new Map<string, StarPoint[]>();
      for (const star of orderedCandidates) {
        const cellStars = byCell.get(star.cellKey);
        if (cellStars) {
          cellStars.push(star);
        } else {
          byCell.set(star.cellKey, [star]);
        }
      }

      const labels: StarMapLabel[] = [];
      for (const star of orderedCandidates) {
        if (labels.length >= limit) {
          break;
        }
        if (star.isSol) {
          mapLabelCache.set(star.id, 'Sol');
          labels.push({ label: 'Sol', starId: star.id });
          continue;
        }
        const cached = mapLabelCache.get(star.id);
        if (cached !== undefined) {
          if (cached) {
            labels.push({ label: cached, starId: star.id });
          }
          continue;
        }

        try {
          await hydrateMapLabelCell(star, byCell);
        } catch {
          mapLabelCache.set(star.id, null);
          continue;
        }
        const label = mapLabelCache.get(star.id);
        if (label) {
          labels.push({ label, starId: star.id });
        }
      }

      return labels;
    },
  };

  async function hydrateMapLabelCell(
    star: StarPoint,
    starsByCell: Map<string, StarPoint[]>,
  ): Promise<void> {
    let promise = mapCellEntriesCache.get(star.cellKey);
    if (!promise) {
      if (!star.ref) {
        mapLabelCache.set(star.id, null);
        return;
      }

      promise = (async () => {
        const provider = await metaProviderPromise;
        return provider.getMetaCell({
          datasetId: star.ref?.datasetId,
          level: star.ref?.level ?? 0,
          mortonCode: star.ref?.mortonCode ?? '0',
        });
      })();
      promise.catch(() => {
        mapCellEntriesCache.delete(star.cellKey);
      });
      mapCellEntriesCache.set(star.cellKey, promise);
    }

    const entries = await promise;
    const cellStars = starsByCell.get(star.cellKey) ?? [star];

    for (const cellStar of cellStars) {
      if (cellStar.isSol) {
        mapLabelCache.set(cellStar.id, 'Sol');
        continue;
      }
      if (!cellStar.ref) {
        mapLabelCache.set(cellStar.id, null);
        continue;
      }
      const entry = entries?.[cellStar.ref.ordinal] ?? null;
      mapLabelCache.set(cellStar.id, entry ? automaticMapLabelFromMeta(entry) : null);
    }
  }
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

function isSolPosition(worldPc: Vec3): boolean {
  return Math.hypot(worldPc.x, worldPc.y, worldPc.z) <= SOL_POSITION_EPSILON_PC;
}

function automaticMapLabelFromMeta(entry: MetaSidecarEntry): string | null {
  const properName = metaString(entry.proper_name);
  if (properName) {
    return properName;
  }

  const flamsteed = metaString(entry.flamsteed);
  if (!flamsteed) {
    return null;
  }
  const constellation = metaString(entry.constellation);
  return constellation ? `${flamsteed} ${constellation}` : flamsteed;
}

function hoverLabelFromMeta(entry: MetaSidecarEntry): string | null {
  const properName = metaString(entry.proper_name);
  if (properName) return properName;

  const bayer = formatBayerDesignation(entry);
  if (bayer) return bayer;

  const flamsteed = automaticMapLabelFromMeta(entry);
  if (flamsteed) return flamsteed;

  const hd = metaString(entry.hd);
  if (hd) return `HD ${hd}`;

  const hip = metaString(entry.hip_id);
  if (hip) return `HIP ${hip}`;

  const gaia = metaString(entry.gaia_source_id);
  if (gaia) return `Gaia ${gaia}`;

  const source = metaString(entry.source);
  const sourceId = metaString(entry.source_id);
  return source && sourceId ? `${source} ${sourceId}` : null;
}

function formatBayerDesignation(entry: MetaSidecarEntry): string | null {
  const bayer = metaString(entry.bayer);
  if (!bayer) {
    return null;
  }
  const constellation = metaString(entry.constellation);
  if (!constellation || designationEndsWithConstellation(bayer, constellation)) {
    return bayer;
  }
  return `${bayer} ${constellation}`;
}

function designationEndsWithConstellation(value: string, constellation: string): boolean {
  const lowerValue = value.toLowerCase();
  const lowerConstellation = constellation.toLowerCase();
  if (!lowerValue.endsWith(lowerConstellation)) {
    return false;
  }
  if (lowerValue.length === lowerConstellation.length) {
    return true;
  }
  const separator = value[value.length - constellation.length - 1];
  return separator === ' ' || separator === '-';
}

function metaString(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function refForStar(
  cell: StarCellData,
  ordinal: number,
  datasetId: string | null,
): StarObjectRef | null {
  const ref = cell.refs?.[ordinal];
  if (ref) {
    return {
      datasetId: ref.datasetId ?? datasetId,
      level: ref.level,
      mortonCode: ref.mortonCode,
      ordinal: ref.ordinal,
    };
  }
  if (!datasetId) {
    return null;
  }
  return {
    datasetId,
    level: cell.cell.level,
    mortonCode: cell.cell.mortonCode,
    ordinal,
  };
}
