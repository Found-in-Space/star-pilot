import type {
  StarCellDecision,
  StarCellEvaluator,
  StarCellPriority,
  StarCellStrategy,
  StarStrategyAnchor,
  StarStrategyChange,
  StarTreeCellGeometry,
  StarTreePointPc,
  StarTreeViewPatch,
} from '@found-in-space/star-trees';
import type { PlaneBasis, Vec3 } from './math';
import { clamp, dot3, normalize3, sub3 } from './math';

export interface PizzaStrategyOptions {
  basis: PlaneBasis;
  centerPc: Vec3;
  radiusPc: number;
  thicknessPc: number;
}

interface PizzaGeometry {
  axisX: Vec3;
  axisY: Vec3;
  centerPc: Vec3;
  halfThicknessPc: number;
  normal: Vec3;
  radiusPc: number;
  signature: string;
}

interface PizzaCellMetrics {
  centerDepthPc: number;
  centerRadialPc: number;
  depthDistancePc: number;
  intersects: boolean;
  radialDistancePc: number;
  sortDistancePc: number;
}

const GEOMETRY_EPSILON = 1e-9;

export function createPizzaStrategy(options: PizzaStrategyOptions): StarCellStrategy {
  const geometry = normalizePizzaGeometry(options);

  return {
    createAnchor(view: StarTreeViewPatch = {}): StarStrategyAnchor {
      return {
        view: {
          ...view,
          observerPc: geometry.centerPc,
          params: {
            ...(view.params ?? {}),
            pizzaSignature: geometry.signature,
          },
        },
        params: { pizza: geometry },
      };
    },

    createEvaluator(anchor: StarStrategyAnchor): StarCellEvaluator {
      const activeGeometry = resolveAnchorGeometry(anchor, geometry);
      return {
        view: anchor.view,
        distanceToCell(cell) {
          return measurePizzaCell(activeGeometry, cell).sortDistancePc;
        },
        evaluateCell(cell): StarCellDecision {
          const metrics = measurePizzaCell(activeGeometry, cell);
          const depthRoom = activeGeometry.halfThicknessPc - metrics.depthDistancePc;
          const radialRoom = activeGeometry.radiusPc - metrics.radialDistancePc;
          const score = radialRoom + depthRoom * 0.5;
          const relevance = metrics.intersects
            ? clamp(
                Math.min(
                  radialRoom / Math.max(1, activeGeometry.radiusPc),
                  depthRoom / Math.max(0.1, activeGeometry.halfThicknessPc),
                ),
                0,
                1,
              )
            : 0;

          return {
            include: metrics.intersects,
            descend: metrics.intersects,
            emit: metrics.intersects,
            distancePc: metrics.sortDistancePc,
            priority: livePriority(0, score),
            relevance,
            reasons: ['pizza-slice'],
            metadata: {
              centerDepthPc: metrics.centerDepthPc,
              centerRadialPc: metrics.centerRadialPc,
              depthDistancePc: metrics.depthDistancePc,
              radialDistancePc: metrics.radialDistancePc,
              radiusPc: activeGeometry.radiusPc,
              thicknessPc: activeGeometry.halfThicknessPc * 2,
            },
          };
        },
      };
    },

    diff(previous: StarStrategyAnchor | null, next: StarStrategyAnchor): StarStrategyChange {
      if (!previous) {
        return { kind: 'reset', reason: 'initial', reasons: ['initial'] };
      }
      return previous.view.params?.pizzaSignature === next.view.params?.pizzaSignature
        ? { kind: 'none', reasons: ['pizza-unchanged'] }
        : { kind: 'regions-changed', regions: [pizzaRegion(geometry)], reasons: ['pizza-moved'] };
    },
  };
}

function measurePizzaCell(geometry: PizzaGeometry, cell: StarTreeCellGeometry): PizzaCellMetrics {
  const delta = sub3(cellCenter(cell), geometry.centerPc);
  const planeX = dot3(delta, geometry.axisX);
  const planeY = dot3(delta, geometry.axisY);
  const centerDepthPc = dot3(delta, geometry.normal);
  const halfSize = Math.max(0, cell.halfSize);
  const projectedHalfX = projectedHalfExtent(geometry.axisX, halfSize);
  const projectedHalfY = projectedHalfExtent(geometry.axisY, halfSize);
  const projectedHalfDepth = projectedHalfExtent(geometry.normal, halfSize);
  const nearestX = Math.max(0, Math.abs(planeX) - projectedHalfX);
  const nearestY = Math.max(0, Math.abs(planeY) - projectedHalfY);
  const radialDistancePc = Math.hypot(nearestX, nearestY);
  const depthDistancePc = Math.max(0, Math.abs(centerDepthPc) - projectedHalfDepth);
  const intersects = radialDistancePc <= geometry.radiusPc + GEOMETRY_EPSILON
    && depthDistancePc <= geometry.halfThicknessPc + GEOMETRY_EPSILON;

  return {
    centerDepthPc,
    centerRadialPc: Math.hypot(planeX, planeY),
    depthDistancePc,
    intersects,
    radialDistancePc,
    sortDistancePc: Math.hypot(radialDistancePc, depthDistancePc),
  };
}

function normalizePizzaGeometry(options: PizzaStrategyOptions): PizzaGeometry {
  const centerPc = finitePoint(options.centerPc, { x: 0, y: 0, z: 0 });
  const normal = normalize3(options.basis.normal, { x: 0, y: 0, z: 1 });
  const axisX = normalize3(options.basis.axisX, { x: 1, y: 0, z: 0 });
  const axisY = normalize3(options.basis.axisY, { x: 0, y: 1, z: 0 });
  const radiusPc = Math.max(0.01, finiteNumber(options.radiusPc, 1));
  const halfThicknessPc = Math.max(0.005, finiteNumber(options.thicknessPc, 1) / 2);

  return {
    axisX,
    axisY,
    centerPc,
    halfThicknessPc,
    normal,
    radiusPc,
    signature: [
      centerPc.x,
      centerPc.y,
      centerPc.z,
      normal.x,
      normal.y,
      normal.z,
      axisX.x,
      axisX.y,
      axisX.z,
      axisY.x,
      axisY.y,
      axisY.z,
      radiusPc,
      halfThicknessPc,
    ].map((value) => value.toFixed(6)).join(':'),
  };
}

function resolveAnchorGeometry(anchor: StarStrategyAnchor, fallback: PizzaGeometry): PizzaGeometry {
  return isPizzaGeometry(anchor.params?.pizza) ? anchor.params.pizza : fallback;
}

function isPizzaGeometry(value: unknown): value is PizzaGeometry {
  return typeof value === 'object'
    && value !== null
    && 'centerPc' in value
    && 'normal' in value
    && 'axisX' in value
    && 'axisY' in value
    && 'radiusPc' in value
    && 'halfThicknessPc' in value;
}

function cellCenter(cell: StarTreeCellGeometry): Vec3 {
  return { x: cell.centerX, y: cell.centerY, z: cell.centerZ };
}

function projectedHalfExtent(axis: Vec3, halfSize: number): number {
  return halfSize * (Math.abs(axis.x) + Math.abs(axis.y) + Math.abs(axis.z));
}

function pizzaRegion(geometry: PizzaGeometry) {
  const halfExtent = geometry.radiusPc + geometry.halfThicknessPc;
  return {
    minPc: {
      x: geometry.centerPc.x - halfExtent,
      y: geometry.centerPc.y - halfExtent,
      z: geometry.centerPc.z - halfExtent,
    },
    maxPc: {
      x: geometry.centerPc.x + halfExtent,
      y: geometry.centerPc.y + halfExtent,
      z: geometry.centerPc.z + halfExtent,
    },
  };
}

function livePriority(band: number, score: number): StarCellPriority {
  return { lane: 'live', band, score: Number.isFinite(score) ? score : 0 };
}

function finitePoint(value: StarTreePointPc, fallback: Vec3): Vec3 {
  return {
    x: finiteNumber(value.x, fallback.x),
    y: finiteNumber(value.y, fallback.y),
    z: finiteNumber(value.z, fallback.z),
  };
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
