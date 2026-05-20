export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlaneBasis {
  axisX: Vec3;
  axisY: Vec3;
  normal: Vec3;
}

export interface PlaneOffset {
  x: number;
  y: number;
  depth: number;
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function distance3(a: Vec3, b: Vec3): number {
  return length3(sub3(a, b));
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length2(value: Vec2): number {
  return Math.hypot(value.x, value.y);
}

export function length3(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function limit2(value: Vec2, maxLength: number): Vec2 {
  const currentLength = length2(value);
  if (currentLength <= maxLength || currentLength === 0) {
    return value;
  }
  const scale = maxLength / currentLength;
  return { x: value.x * scale, y: value.y * scale };
}

export function normalize3(value: Vec3, fallback: Vec3): Vec3 {
  const magnitude = length3(value);
  if (!Number.isFinite(magnitude) || magnitude < 1e-9) {
    return fallback;
  }
  return {
    x: value.x / magnitude,
    y: value.y / magnitude,
    z: value.z / magnitude,
  };
}

export function planeBasisFromNormal(normal: Vec3): PlaneBasis {
  const n = normalize3(normal, { x: 0, y: 0, z: 1 });
  const reference = Math.abs(n.z) < 0.88
    ? { x: 0, y: 0, z: 1 }
    : { x: 0, y: 1, z: 0 };
  const axisX = normalize3(cross3(reference, n), { x: 1, y: 0, z: 0 });
  const axisY = normalize3(cross3(n, axisX), { x: 0, y: 1, z: 0 });
  return { axisX, axisY, normal: n };
}

export function planeToWorld(origin: Vec3, basis: PlaneBasis, point: Vec2): Vec3 {
  return add3(
    add3(origin, scale3(basis.axisX, point.x)),
    scale3(basis.axisY, point.y),
  );
}

export function scale3(value: Vec3, scale: number): Vec3 {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function worldToPlaneOffset(origin: Vec3, basis: PlaneBasis, point: Vec3): PlaneOffset {
  const delta = sub3(point, origin);
  return {
    x: dot3(delta, basis.axisX),
    y: dot3(delta, basis.axisY),
    depth: dot3(delta, basis.normal),
  };
}
