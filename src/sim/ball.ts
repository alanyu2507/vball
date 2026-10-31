import { CONFIG } from '../config';
import { rngSigned } from './rng';
import type { BallState, GameState, SimEvent } from './types';
import * as V from './vec';
import type { Vec3 } from './vec';

export function createBall(): BallState {
  return {
    pos: V.v3(0, 1, 0),
    vel: V.v3(),
    spin: V.v3(),
    held: -1,
    knuckle: V.v3(),
    knuckleTimer: 0,
    floating: false,
    lastTouchTeam: -1,
    lastToucher: -1,
    lastTouchWasBlock: false,
    idleTime: 0,
    speedAtContact: 0,
    touchedNet: false,
    grounded: false,
  };
}

/** Area of the ball cross section. */
function area(): number {
  const r = CONFIG.ball.radius;
  return Math.PI * r * r;
}

/** Acceleration on a free ball: gravity, quadratic drag, Magnus lift. */
export function ballAccel(vel: Vec3, spin: Vec3, extra?: Vec3): Vec3 {
  const b = CONFIG.ball;
  const speed = V.len(vel);
  const a = V.v3(0, -b.gravity, 0);
  if (speed > 1e-6) {
    // drag: F = 0.5 rho Cd A v^2 opposite to velocity
    const dragMag = (0.5 * b.airDensity * b.dragCoeff * area() * speed * speed) / b.mass;
    a.x -= (vel.x / speed) * dragMag;
    a.y -= (vel.y / speed) * dragMag;
    a.z -= (vel.z / speed) * dragMag;
    // Magnus: F = k (omega x v)
    const m = V.cross(spin, vel);
    const k = b.magnusCoeff / b.mass;
    a.x += m.x * k;
    a.y += m.y * k;
    a.z += m.z * k;
  }
  if (extra) {
    a.x += extra.x;
    a.y += extra.y;
    a.z += extra.z;
  }
  return a;
}

/** Semi-implicit Euler step of a free ball with sub-stepping. Mutates pos/vel. */
export function integrateBall(pos: Vec3, vel: Vec3, spin: Vec3, dt: number, extra?: Vec3, substeps = 2): void {
  const h = dt / substeps;
  for (let i = 0; i < substeps; i++) {
    const a = ballAccel(vel, spin, extra);
    vel.x += a.x * h;
    vel.y += a.y * h;
    vel.z += a.z * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;
  }
}

/** Knuckle (float) perturbation. Only meaningful when spin is low. */
function updateKnuckle(state: GameState, ball: BallState, dt: number): Vec3 | undefined {
  const b = CONFIG.ball;
  if (!ball.floating) return undefined;
  const spinMag = V.len(ball.spin);
  if (spinMag > b.knuckleSpinThreshold) return undefined;
  ball.knuckleTimer -= dt;
  if (ball.knuckleTimer <= 0) {
    ball.knuckleTimer = b.knuckleChangeInterval;
    // New seeded lateral direction perpendicular to velocity
    const dir = V.normalize(ball.vel);
    const side = V.normalize(V.cross(dir, V.v3(0, 1, 0)));
    const up = V.normalize(V.cross(side, dir));
    const a = rngSigned(state);
    const c = rngSigned(state) * 0.6;
    ball.knuckle = V.normalize(V.addScaled(V.scale(side, a), up, c));
  }
  const speed = V.len(ball.vel);
  // grows as the ball slows from knuckleSpeedHigh toward knuckleSpeedLow, fades out below low
  const grow = V.smoothstep(b.knuckleSpeedHigh, b.knuckleSpeedLow + 3, speed);
  const fade = V.smoothstep(b.knuckleSpeedLow - 3, b.knuckleSpeedLow, speed);
  const spinFade = 1 - spinMag / b.knuckleSpinThreshold;
  return V.scale(ball.knuckle, b.knuckleStrength * grow * fade * spinFade);
}

export interface NetHit {
  tape: boolean;
}

/** Collide the ball with the net plane at x = 0. Returns true on contact. */
export function collideNet(ball: BallState, prevX: number): NetHit | null {
  const c = CONFIG.court;
  const b = CONFIG.ball;
  const r = b.radius;
  const halfW = c.netWidth / 2;
  if (Math.abs(ball.pos.z) > halfW + r) return null;
  const top = c.netHeight;
  // crossing check (center passes the plane or overlaps it) while below the tape top
  const crossed = (prevX < 0 && ball.pos.x > -r) || (prevX > 0 && ball.pos.x < r) || Math.abs(ball.pos.x) < r;
  if (!crossed) return null;
  if (ball.pos.y - r > top) return null; // clears the net
  if (ball.pos.y + r < c.netBottom) return null;
  const side = prevX < 0 ? -1 : prevX > 0 ? 1 : ball.vel.x > 0 ? -1 : 1;
  const tape = ball.pos.y > top - r * 0.9;
  if (tape) {
    // tape: bounce mostly up/back with some randomness supplied by caller via spin state; keep deterministic here
    ball.pos.x = side * r * 1.01;
    const vx = ball.vel.x;
    ball.vel.x = -vx * b.netTopRestitution * 0.5;
    ball.vel.y = Math.abs(ball.vel.y) * 0.3 + Math.abs(vx) * 0.35;
    ball.vel.z *= b.netDamping;
    ball.spin = V.scale(ball.spin, 0.4);
    return { tape: true };
  }
  ball.pos.x = side * r * 1.01;
  ball.vel.x = -ball.vel.x * b.netRestitution;
  ball.vel.y *= b.netDamping;
  ball.vel.z *= b.netDamping;
  ball.spin = V.scale(ball.spin, 0.3);
  return { tape: false };
}

/** Full ball tick: integration, net, ground. Emits events for bounces/net. */
export function stepBall(state: GameState, dt: number): void {
  const ball = state.ball;
  const b = CONFIG.ball;
  if (ball.held >= 0) return;
  const prevX = ball.pos.x;
  const extra = updateKnuckle(state, ball, dt);
  integrateBall(ball.pos, ball.vel, ball.spin, dt, extra);
  // spin decay
  const decay = Math.max(0, 1 - b.spinDecay * dt);
  ball.spin.x *= decay;
  ball.spin.y *= decay;
  ball.spin.z *= decay;
  // speed cap
  const sp = V.len(ball.vel);
  if (sp > b.maxSpeed) {
    const s = b.maxSpeed / sp;
    ball.vel.x *= s;
    ball.vel.y *= s;
    ball.vel.z *= s;
  }
  ball.idleTime += dt;

  const net = collideNet(ball, prevX);
  if (net) {
    ball.touchedNet = true;
    push(state, { type: 'net', pos: V.copy(ball.pos), player: -1, power: Math.min(1, sp / 20) });
  }

  // ground
  const r = b.radius;
  if (ball.pos.y - r <= 0 && ball.vel.y < 0) {
    ball.pos.y = r;
    const impact = -ball.vel.y;
    ball.vel.y = impact * b.groundRestitution;
    ball.vel.x *= b.groundFriction;
    ball.vel.z *= b.groundFriction;
    if (ball.vel.y < 0.4) ball.vel.y = 0;
    ball.spin = V.scale(ball.spin, 0.5);
    if (!ball.grounded) {
      push(state, { type: 'landing', pos: V.copy(ball.pos), player: -1, power: Math.min(1, impact / 15) });
    } else if (impact > 0.5) {
      push(state, { type: 'bounce', pos: V.copy(ball.pos), player: -1, power: Math.min(1, impact / 15) });
    }
    ball.grounded = true;
  } else if (ball.pos.y - r > 0.02) {
    ball.grounded = false;
  }
  // resting ball friction
  if (ball.grounded && ball.pos.y - r < 0.005) {
    const f = Math.max(0, 1 - 2.5 * dt);
    ball.vel.x *= f;
    ball.vel.z *= f;
  }
}

function push(state: GameState, e: SimEvent): void {
  state.events.push(e);
}

// ---------------------------------------------------------------------------
// Prediction & launch solving (pure, deterministic; used by actions, bots, HUD)
// ---------------------------------------------------------------------------

export interface PredictOptions {
  /** Stop when the ball descends through this height (default: ball radius). */
  stopHeight?: number;
  /** Only stop when descending (default true). */
  descendingOnly?: boolean;
  maxTime?: number;
  dt?: number;
  /** Treat net as a wall (stops prediction with hitNet=true). */
  net?: boolean;
  /** Extra height above the tape required to count as clearing (solver margin). */
  netClearance?: number;
  /** Record path points for debug drawing. */
  path?: Vec3[];
}

export interface Prediction {
  pos: Vec3;
  vel: Vec3;
  time: number;
  hitNet: boolean;
  reached: boolean;
}

/** Simulate a free ball forward until it descends through stopHeight. Ignores knuckling. */
export function predictBall(pos0: Vec3, vel0: Vec3, spin0: Vec3, opts: PredictOptions = {}): Prediction {
  const stopH = opts.stopHeight ?? CONFIG.ball.radius;
  const descOnly = opts.descendingOnly ?? true;
  const maxT = opts.maxTime ?? 6;
  const dt = opts.dt ?? 1 / 60;
  const pos = V.copy(pos0);
  const vel = V.copy(vel0);
  const spin = V.copy(spin0);
  let t = 0;
  let hitNet = false;
  const halfW = CONFIG.court.netWidth / 2;
  if (opts.path) opts.path.push(V.copy(pos));
  // already below the stop height and falling: that moment is now
  if (pos.y <= stopH && (!descOnly || vel.y < 0)) return { pos, vel, time: 0, hitNet, reached: true };
  let wasAbove = pos.y > stopH;
  while (t < maxT) {
    const prevX = pos.x;
    const prevY = pos.y;
    integrateBall(pos, vel, spin, dt, undefined, 1);
    t += dt;
    if (opts.path) opts.path.push(V.copy(pos));
    if (opts.net && Math.abs(pos.z) < halfW && ((prevX < 0 && pos.x >= 0) || (prevX > 0 && pos.x <= 0))) {
      const f = Math.abs(prevX) / Math.max(1e-6, Math.abs(pos.x - prevX));
      const yAt = prevY + (pos.y - prevY) * f;
      if (yAt - CONFIG.ball.radius < CONFIG.court.netHeight + (opts.netClearance ?? 0)) {
        hitNet = true;
        // report the contact point on the side the ball came from
        pos.x = Math.sign(prevX) * CONFIG.ball.radius;
        pos.y = yAt;
        return { pos, vel, time: t, hitNet, reached: false };
      }
    }
    if (pos.y > stopH) wasAbove = true;
    if (wasAbove && pos.y <= stopH && (!descOnly || vel.y < 0)) {
      // linear back-off to the exact crossing
      const f = prevY > stopH ? (prevY - stopH) / Math.max(1e-6, prevY - pos.y) : 1;
      const back = 1 - f;
      pos.x -= vel.x * dt * back;
      pos.z -= vel.z * dt * back;
      pos.y = stopH;
      t -= dt * back;
      return { pos, vel, time: t, hitNet, reached: true };
    }
    if (pos.y < -1) break;
  }
  return { pos, vel, time: t, hitNet, reached: false };
}

/** Time until the ball is closest to point p (within [tMin,tMax]), and the distance then. */
export function timeOfClosestApproach(
  pos0: Vec3,
  vel0: Vec3,
  spin0: Vec3,
  p: Vec3,
  tMax = 1.0,
  dt = 1 / 120,
): { t: number; dist: number; pos: Vec3 } {
  const pos = V.copy(pos0);
  const vel = V.copy(vel0);
  const spin = V.copy(spin0);
  let best = V.dist(pos, p);
  let bestT = 0;
  let bestPos = V.copy(pos);
  let t = 0;
  while (t < tMax) {
    integrateBall(pos, vel, spin, dt, undefined, 1);
    t += dt;
    const d = V.dist(pos, p);
    if (d < best) {
      best = d;
      bestT = t;
      bestPos = V.copy(pos);
    }
    if (pos.y < 0) break;
  }
  return { t: bestT, dist: best, pos: bestPos };
}

/**
 * Topspin angular velocity for a ball travelling along horizontal direction d.
 * Right hand rule: omega = up x d scaled by spin makes the top of the ball move forward.
 */
export function topspinFor(dirHoriz: Vec3, spin: number): Vec3 {
  const d = V.normalize(V.v3(dirHoriz.x, 0, dirHoriz.z));
  return V.scale(V.cross(V.v3(0, 1, 0), d), spin);
}

export interface LaunchResult {
  vel: Vec3;
  /** True if the solver found a trajectory that reaches the target; false if it fell back. */
  reachable: boolean;
  pitch: number;
}

/**
 * Find the launch pitch (keeping speed and horizontal direction toward the target)
 * such that the ball lands at the target point, including drag and the given spin
 * (spin is re-oriented to the launch direction as topspin/sidespin amounts).
 * mode 'low' picks the flattest solution, 'high' the loopiest.
 * If unreachable, returns the trajectory that gets closest (max range) for 'high',
 * or the direct line of sight for 'low' (ball falls short / in net, as physics dictates).
 */
export function solveLaunch(
  from: Vec3,
  target: Vec3,
  speed: number,
  topspin: number,
  sidespin: number,
  mode: 'low' | 'high',
  pitchMin = -1.3,
  pitchMax = 1.35,
): LaunchResult {
  const toT = V.sub(target, from);
  const horiz = V.normalize(V.v3(toT.x, 0, toT.z));
  const range = Math.hypot(toT.x, toT.z);
  const spin = V.add(topspinFor(horiz, topspin), V.v3(0, sidespin, 0));
  const crossesNet = Math.sign(from.x) !== Math.sign(target.x) && Math.abs(from.x) > 0.05;
  const landingDist = (pitch: number): number => {
    const vel = V.scale(V.dirFromYawPitch(V.yawOf(horiz), pitch), speed);
    const p = predictBall(from, vel, spin, {
      stopHeight: target.y,
      maxTime: 5,
      dt: 1 / 90,
      net: crossesNet,
      netClearance: CONFIG.court.solverNetClearance,
    });
    if (p.hitNet) return -1; // trajectories through the net never count as reaching
    if (!p.reached) return -1;
    // signed distance along horiz
    const d = V.sub(p.pos, from);
    return d.x * horiz.x + d.z * horiz.z;
  };
  // coarse sample to find the max range pitch
  const N = 28;
  let bestPitch = pitchMin;
  let bestDist = -Infinity;
  const samples: number[] = [];
  for (let i = 0; i <= N; i++) {
    const p = pitchMin + ((pitchMax - pitchMin) * i) / N;
    const d = landingDist(p);
    samples.push(d);
    if (d > bestDist) {
      bestDist = d;
      bestPitch = p;
    }
  }
  const mk = (pitch: number, reachable: boolean): LaunchResult => ({
    vel: V.scale(V.dirFromYawPitch(V.yawOf(horiz), pitch), speed),
    reachable,
    pitch,
  });
  if (bestDist < range) {
    // unreachable
    if (mode === 'high') return mk(bestPitch, false);
    const direct = V.pitchOf(toT);
    return mk(V.clamp(direct, pitchMin, pitchMax), false);
  }
  // bisection on the monotone side
  let lo: number;
  let hi: number;
  if (mode === 'low') {
    lo = pitchMin;
    hi = bestPitch;
  } else {
    lo = bestPitch;
    hi = pitchMax;
  }
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const d = landingDist(mid);
    if (mode === 'low') {
      if (d < range) lo = mid;
      else hi = mid;
    } else {
      if (d < range) hi = mid;
      else lo = mid;
    }
  }
  const pitch = (lo + hi) / 2;
  return mk(pitch, true);
}

/**
 * Ballistic (no drag) velocity that passes from `from` through `target` with the given apex
 * height above the higher of the two points. Used for sets and bot passes.
 */
export function velocityForApex(from: Vec3, target: Vec3, apexAbove: number, gravity = CONFIG.ball.gravity): Vec3 {
  const topY = Math.max(from.y, target.y) + Math.max(0.05, apexAbove);
  const vy = Math.sqrt(2 * gravity * (topY - from.y));
  const tUp = vy / gravity;
  const tDown = Math.sqrt((2 * (topY - target.y)) / gravity);
  const T = tUp + tDown;
  return V.v3((target.x - from.x) / T, vy, (target.z - from.z) / T);
}

/** Drag-compensated version: iterates a few times so the drag-affected ball lands at target. */
export function velocityForApexDrag(from: Vec3, target: Vec3, apexAbove: number): Vec3 {
  let vel = velocityForApex(from, target, apexAbove);
  for (let i = 0; i < 3; i++) {
    const p = predictBall(from, vel, V.v3(), { stopHeight: target.y, maxTime: 6, dt: 1 / 90 });
    if (!p.reached) break;
    const err = V.sub(target, p.pos);
    // scale horizontal components, keep vertical
    const t = Math.max(0.2, p.time);
    vel = V.v3(vel.x + err.x / t, vel.y, vel.z + err.z / t);
  }
  return vel;
}
