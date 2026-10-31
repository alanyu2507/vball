export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (o: Vec3, x: number, y: number, z: number): Vec3 => {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
};
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
});
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const lenXZ = (a: Vec3): number => Math.sqrt(a.x * a.x + a.z * a.z);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : v3(0, 0, 0);
};
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const reflect = (v: Vec3, n: Vec3): Vec3 => addScaled(v, n, -2 * dot(v, n));
export const clampLen = (a: Vec3, max: number): Vec3 => {
  const l = len(a);
  return l > max ? scale(a, max / l) : a;
};
/** Direction from yaw (around Y, 0 = +X) and pitch (up positive). */
export const dirFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const c = Math.cos(pitch);
  return { x: Math.cos(yaw) * c, y: Math.sin(pitch), z: Math.sin(yaw) * c };
};
export const yawOf = (d: Vec3): number => Math.atan2(d.z, d.x);
export const pitchOf = (d: Vec3): number => Math.atan2(d.y, Math.hypot(d.x, d.z));
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeOut = (t: number): number => 1 - (1 - clamp(t, 0, 1)) * (1 - clamp(t, 0, 1));
export const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
/** Rotate v around axis (unit) by angle. */
export const rotateAround = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = axis;
  const kv = cross(k, v);
  const kdv = dot(k, v);
  return {
    x: v.x * c + kv.x * s + k.x * kdv * (1 - c),
    y: v.y * c + kv.y * s + k.y * kdv * (1 - c),
    z: v.z * c + kv.z * s + k.z * kdv * (1 - c),
  };
};
/** Any unit vector perpendicular to d. */
export const anyPerp = (d: Vec3): Vec3 => {
  const up = Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  return normalize(cross(d, up));
};
