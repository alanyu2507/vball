import { CONFIG, simDt } from '../config';
import { predictBall, solveLaunch, topspinFor } from './ball';
import {
  aimDir,
  blockHands,
  bodyCapsule,
  closestPointOnSegment,
  doJump,
  eyePos,
  forwardOf,
  idealContactPoint,
  jumpVelocityForHeight,
  platformPos,
  rightOf,
  setHandsPos,
  staminaFactor,
} from './player';
import { rngNext, rngSigned } from './rng';
import { awardPoint, registerTouch } from './rules';
import { AttackType, type ContactKind, type GameState, type InputFrame, type PlayerState, RATINGS, teamSide } from './types';
import * as V from './vec';
import type { Vec3 } from './vec';

export const R = {
  Perfect: 0,
  Good: 1,
  Early: 2,
  Late: 3,
  Shank: 4,
  Body: 5,
  Whiff: 6,
  Double: 7,
  Tool: 8,
} as const;

function startAction(p: PlayerState, type: PlayerState['action']['type'], variant = 0): void {
  p.action.type = type;
  p.action.t = 0;
  p.action.charge = 0;
  p.action.buffered = 0;
  p.action.timing = 0;
  p.action.variant = variant;
  p.action.contacted = false;
}

function endAction(p: PlayerState): void {
  startAction(p, 'none');
}

/** Rotate a velocity by a random angle within a cone (radians). */
function perturb(state: GameState, v: Vec3, cone: number): Vec3 {
  if (cone <= 0) return v;
  const d = V.normalize(v);
  const axisA = V.anyPerp(d);
  const axisB = V.cross(d, axisA);
  const theta = rngNext(state) * Math.PI * 2;
  const axis = V.normalize(V.add(V.scale(axisA, Math.cos(theta)), V.scale(axisB, Math.sin(theta))));
  const ang = cone * Math.sqrt(rngNext(state)); // bias toward the edge slightly less than uniform-area
  return rotateKeepLen(v, axis, ang);
}

function rotateKeepLen(v: Vec3, axis: Vec3, ang: number): Vec3 {
  return V.rotateAround(v, axis, ang);
}

/** The ball is on this player's side of the net (with tolerance across the plane). */
export function onOwnSide(state: GameState, p: PlayerState, tol: number): boolean {
  const side = teamSide(state, p.team);
  return state.ball.pos.x * side > -tol;
}

/** Target point on the far court plane from the crosshair ray. */
export function aimTarget(p: PlayerState): Vec3 {
  const eye = eyePos(p);
  const d = aimDir(p);
  const planeY = CONFIG.ball.radius;
  if (d.y < -0.02) {
    const t = (planeY - eye.y) / d.y;
    const hit = V.addScaled(eye, d, Math.min(t, 40));
    return hit;
  }
  // aiming flat or up: far point along the ray, at the ground
  const far = V.addScaled(eye, d, 25);
  far.y = planeY;
  return far;
}

/**
 * Closed-form (drag-free) closest approach between the ball and the player's ideal
 * contact point, for t in [-0.3, 0.7]. Negative t means the ideal moment already passed.
 */
export function predictContactTiming(p: PlayerState, ballPos: Vec3, ballVel: Vec3): { t: number; dist: number } {
  const g = CONFIG.ball.gravity;
  const ideal0 = idealContactPoint(p);
  const airborne = !p.grounded;
  let best = Infinity;
  let bestT = 0;
  const dt = 1 / 120;
  for (let t = -0.3; t <= 0.7; t += dt) {
    const bx = ballPos.x + ballVel.x * t;
    const by = ballPos.y + ballVel.y * t - 0.5 * g * t * t;
    const bz = ballPos.z + ballVel.z * t;
    const px = ideal0.x + p.vel.x * t;
    const pz = ideal0.z + p.vel.z * t;
    let py = ideal0.y;
    if (airborne) {
      py = ideal0.y + p.vel.y * t - 0.5 * g * t * t;
      // the player cannot go below the ground
      const feetY = p.pos.y + p.vel.y * t - 0.5 * g * t * t;
      if (feetY < 0) py = ideal0.y - p.pos.y;
    }
    const d = Math.hypot(bx - px, by - py, bz - pz);
    if (d < best) {
      best = d;
      bestT = t;
    }
  }
  return { t: bestT, dist: best };
}

function emitContact(
  state: GameState,
  p: PlayerState,
  kind: ContactKind,
  power: number,
  rating: number,
  pos: Vec3,
  perfect = false,
): void {
  p.lastRating = rating;
  state.ball.speedAtContact = V.len(state.ball.vel);
  state.events.push({ type: 'contact', pos: V.copy(pos), player: p.id, power, kind, rating, perfect });
  if (state.training.drill !== 'none') {
    state.training.lastContactKind = kind;
    state.training.lastContactRating = rating;
    state.training.lastContactPower = power;
    state.training.playerTouched = true;
  }
}

// ---------------------------------------------------------------------------
// Spike
// ---------------------------------------------------------------------------

export interface SpikeParams {
  charge: number;
  timing: number; // seconds, + = late
  distF: number; // 0..1 distance from the ideal point / reach
  type: AttackType;
}

/** Resolve a spike contact. The ball is at `contact`. */
export function performSpike(state: GameState, p: PlayerState, params: SpikeParams, contact: Vec3): void {
  const s = CONFIG.spike;
  const ball = state.ball;
  const abs = Math.abs(params.timing);
  let rating: number;
  let powerMul = 1;
  let cone = 0;
  let pitchLift = 0;
  let shank = false;
  if (abs <= s.perfectWindow) {
    rating = R.Perfect;
  } else if (abs <= s.goodWindow) {
    rating = R.Good;
    const k = (abs - s.perfectWindow) / (s.goodWindow - s.perfectWindow);
    powerMul = 1 - 0.15 * k;
    cone = 0.05 * k;
  } else if (params.timing < 0) {
    rating = R.Early;
    const k = V.clamp((abs - s.goodWindow) / (s.earlyWindow - s.goodWindow), 0, 1);
    powerMul = 1 - s.earlyPowerLoss * (0.35 + 0.65 * k);
    pitchLift = s.earlyPitchLift * (0.3 + 0.7 * k);
    cone = 0.08;
  } else {
    const k = V.clamp((abs - s.goodWindow) / (s.lateWindow - s.goodWindow), 0, 1);
    if (k > 0.72) {
      rating = R.Shank;
      shank = true;
      powerMul = s.shankSpeedMul;
      cone = 0.75;
    } else {
      rating = R.Late;
      cone = s.lateErrorCone * (0.3 + 0.7 * k);
      powerMul = 1 - 0.3 * k;
    }
  }
  powerMul *= 1 - s.distancePowerLoss * params.distF;
  cone += s.distanceErrorCone * params.distF;
  const quality = V.clamp(params.charge * powerMul * staminaFactor(p), 0, 1);

  const target = aimTarget(p);
  let speed: number;
  let topspin = 0;
  let mode: 'low' | 'high' = 'low';
  let kind: ContactKind = 'spike';
  let floating = false;
  if (params.type === AttackType.Roll) {
    speed = V.lerpN(s.speedMin * 0.7, s.rollSpeedMax, quality);
    topspin = s.rollSpin * (0.4 + 0.6 * quality);
    mode = 'high';
    kind = 'roll';
  } else if (params.type === AttackType.Float) {
    speed = V.lerpN(s.speedMin, s.floatSpeedMax, quality);
    topspin = 0;
    kind = 'float';
    floating = true;
  } else {
    speed = V.lerpN(s.speedMin, s.speedMax, quality);
    topspin = s.straightSpin * quality;
  }
  // swerve: aim yaw offset relative to the body adds sidespin (not for floats)
  let sidespin = 0;
  if (!floating) {
    const yawDiff = V.wrapAngle(p.yaw - p.facing);
    const mag = Math.max(0, Math.abs(yawDiff) - s.swerveDeadzone);
    sidespin = -Math.sign(yawDiff) * mag * s.swerveSidespinPerRadian * (0.5 + 0.5 * quality);
  }
  const res = solveLaunch(contact, target, speed, topspin, sidespin, mode);
  let vel = res.vel;
  if (pitchLift > 0) {
    const d = V.normalize(vel);
    const axis = V.normalize(V.cross(d, V.v3(0, 1, 0)));
    vel = V.rotateAround(vel, V.scale(axis, -1), pitchLift);
  }
  vel = perturb(state, vel, cone);
  if (shank) {
    // off the side of the hand: yaw it hard one way
    const side = rngSigned(state) > 0 ? 1 : -1;
    vel = V.rotateAround(vel, V.v3(0, 1, 0), side * (0.5 + rngNext(state) * 0.5));
    vel.y += 2 + rngNext(state) * 3;
  }
  const horiz = V.v3(vel.x, 0, vel.z);
  ball.pos = V.copy(contact);
  ball.vel = vel;
  ball.spin = V.add(topspinFor(horiz, topspin), V.v3(0, sidespin, 0));
  ball.floating = floating;
  ball.knuckleTimer = 0;
  registerTouch(state, p, false);
  emitContact(state, p, kind, quality, rating, contact, rating === R.Perfect && params.charge > 0.85);
}

/**
 * Hit zone test for the instant swing: where is the ball relative to the sphere
 * of reachRadius around the ideal contact point?
 *   red    - outside the sphere: a press whiffs
 *   green  - inside, top half (at or above the ideal point): full power
 *   orange - inside, bottom half: half power
 */
export type SpikeZone = 'red' | 'green' | 'orange';
export function spikeZone(p: PlayerState, ballPos: Vec3): { zone: SpikeZone; dist: number } {
  const ideal = idealContactPoint(p);
  const dist = V.dist(ballPos, ideal);
  if (dist > CONFIG.spike.reachRadius) return { zone: 'red', dist };
  return { zone: ballPos.y >= ideal.y ? 'green' : 'orange', dist };
}

/** Instant swing (LMB press in the air): hit now based on the zone, no charge, no timing window. */
function instantSwing(state: GameState, p: PlayerState): void {
  const s = CONFIG.spike;
  const ball = state.ball;
  const { zone } = spikeZone(p, ball.pos);
  startAction(p, 'swing');
  p.action.contacted = true; // the swing animation plays; no second contact attempt in updateSwing
  if (zone === 'red' || ball.held >= 0 || !onOwnSide(state, p, 0.3)) {
    p.lastRating = R.Whiff;
    state.events.push({ type: 'rating', pos: idealContactPoint(p), player: p.id, power: 0, rating: R.Whiff });
    return;
  }
  const charge = zone === 'green' ? 1 : s.halfPower;
  p.action.charge = charge;
  performSpike(state, p, { charge, timing: 0, distF: 0, type: p.attackType }, V.copy(ball.pos));
}

/** Begin the swing: evaluate timing now. (Charged-swing path, kept for reference; the instant swing is live.) */
function beginSwing(state: GameState, p: PlayerState): void {
  const ball = state.ball;
  const pred = predictContactTiming(p, ball.pos, ball.vel);
  const timing = CONFIG.spike.swingLead - pred.t; // + late, - early
  p.action.timing = timing;
  p.action.type = 'swing';
  p.action.t = 0;
  p.action.contacted = false;
}

function updateSwing(state: GameState, p: PlayerState): void {
  const s = CONFIG.spike;
  const a = p.action;
  if (!a.contacted && a.t >= s.swingLead) {
    const ball = state.ball;
    const ideal = idealContactPoint(p);
    const d = V.dist(ball.pos, ideal);
    // tolerate the ball arriving over a short window after the hand (the arm is still there)
    if (d <= s.reachRadius && ball.held < 0 && onOwnSide(state, p, 0.3)) {
      a.contacted = true;
      performSpike(state, p, { charge: a.charge, timing: a.timing, distF: d / s.reachRadius, type: p.attackType }, V.copy(ball.pos));
    } else if (a.t >= s.swingLead + 0.07) {
      a.contacted = true;
      p.lastRating = R.Whiff;
      state.events.push({ type: 'rating', pos: V.copy(ideal), player: p.id, power: 0, rating: R.Whiff });
    }
  }
  if (a.t >= s.swingDuration) endAction(p);
}

/** Charge curve: rise, hold, decay. */
export function swingChargeAt(t: number): number {
  const s = CONFIG.spike;
  if (t < s.chargeTime) return V.easeOut(t / s.chargeTime) * 0.85 + 0.15 * (t / s.chargeTime);
  if (t < s.chargeTime + s.holdTime) return 1;
  return V.clamp(1 - (t - s.chargeTime - s.holdTime) / s.decayTime, 0.1, 1);
}

// ---------------------------------------------------------------------------
// Tip
// ---------------------------------------------------------------------------

/** Launch velocity a tip would produce right now (also used for the arc preview). */
export function tipLaunch(p: PlayerState, from: Vec3, strength: number): Vec3 {
  const t = CONFIG.tip;
  const target = aimTarget(p);
  const speed = V.lerpN(t.speedMin, t.speedMax, strength);
  const res = solveLaunch(from, target, speed, 4, 0, 'high', -0.3, 1.3);
  return res.vel;
}

function performTip(state: GameState, p: PlayerState, strength: number): boolean {
  const ball = state.ball;
  const ideal = idealContactPoint(p);
  const d = V.dist(ball.pos, ideal);
  if (d > CONFIG.tip.reachRadius || ball.held >= 0) return false;
  const vel = tipLaunch(p, ball.pos, strength);
  const err = 0.04 + 0.2 * (d / CONFIG.tip.reachRadius);
  ball.vel = perturb(state, vel, err);
  ball.spin = topspinFor(V.v3(vel.x, 0, vel.z), 4);
  ball.floating = false;
  registerTouch(state, p, false);
  emitContact(state, p, 'tip', 0.3 + 0.3 * strength, d < 0.3 ? R.Perfect : R.Good, ball.pos);
  return true;
}

// ---------------------------------------------------------------------------
// Set
// ---------------------------------------------------------------------------

function performSet(state: GameState, p: PlayerState, charge: number): boolean {
  const c = CONFIG.set;
  const ball = state.ball;
  if (ball.held >= 0) return false;
  const hands = setHandsPos(p);
  const minY = p.pos.y + CONFIG.player.shoulderHeight + c.minBallHeightAboveShoulder;
  if (ball.pos.y < minY) return false;
  if (!onOwnSide(state, p, 0.05)) return false;
  const dxz = V.distXZ(ball.pos, hands);
  const dy = ball.pos.y - hands.y;
  if (dxz > c.reachRadius || dy > 0.7 || dy < -0.5) return false;
  const offCenter = dxz + Math.max(0, Math.abs(dy - 0.1) - 0.15) * 0.5;
  registerTouch(state, p, false);
  if (c.callDoubles && offCenter > c.doubleThreshold) {
    // sloppy contact: still moves the ball but the fault is called
    ball.vel = V.add(V.scale(ball.vel, 0.3), V.v3(0, 3, 0));
    emitContact(state, p, 'set', 0.2, R.Double, ball.pos);
    awardPoint(state, (1 - p.team) as 0 | 1, 'Double contact');
    return true;
  }
  const speed0 = V.lerpN(c.speedMin, c.speedMax, charge);
  const speed = speed0 * (1 + c.speedErrorPerMeter * offCenter * rngSigned(state));
  const dir = V.dirFromYawPitch(p.yaw, V.clamp(p.pitch + c.pitchBias, 0.05, 1.45));
  let vel = V.scale(dir, speed);
  vel = perturb(state, vel, c.errorPerMeter * offCenter);
  vel = V.addScaled(vel, p.vel, 0.3);
  ball.pos = V.v3(hands.x, Math.max(hands.y + 0.05, ball.pos.y), hands.z);
  ball.vel = vel;
  const spinMag = c.spinPerMeter * offCenter;
  ball.spin = V.scale(V.normalize(V.v3(rngSigned(state), rngSigned(state), rngSigned(state))), spinMag);
  ball.floating = false;
  const rating = offCenter < 0.14 ? R.Perfect : offCenter < 0.32 ? R.Good : R.Shank;
  emitContact(state, p, 'set', 0.25 + 0.25 * charge, rating, ball.pos, rating === R.Perfect);
  return true;
}

// ---------------------------------------------------------------------------
// Bump
// ---------------------------------------------------------------------------

function performBump(state: GameState, p: PlayerState, force: number): boolean {
  const c = CONFIG.bump;
  const ball = state.ball;
  if (ball.held >= 0) return false;
  const diving = p.action.type === 'dive';
  const plat = platformPos(p);
  const reach = c.reachRadius + (diving ? c.diveReachBonus : 0);
  const d = V.dist(ball.pos, plat);
  if (d > reach) return false;
  if (ball.pos.y > p.pos.y + CONFIG.player.shoulderHeight + 0.35) return false;
  if (!onOwnSide(state, p, 0.05)) return false;
  const speedIn = V.len(ball.vel);
  // platform normal from aim, clamped so the arms can't make a downward platform
  let n = V.dirFromYawPitch(p.yaw, V.clamp(p.pitch + c.pitchBias, c.minPitch, c.maxPitch));
  const pSpeed = Math.hypot(p.vel.x, p.vel.z);
  const err = c.errorBase + c.errorPerSpeed * pSpeed + c.errorPerOffset * d + (diving ? 0.12 : 0);
  n = V.normalize(perturb(state, n, err));
  let vr: Vec3;
  const e = c.restitution * V.lerpN(c.softRestitution, 1, force);
  if (V.dot(ball.vel, n) < 0) vr = V.scale(V.reflect(ball.vel, n), e);
  else vr = V.scale(ball.vel, e * 0.4);
  const applied = V.scale(n, c.speedMax * force * staminaFactor(p));
  const carry = V.scale(V.v3(p.vel.x, Math.max(0, p.vel.y), p.vel.z), c.bodyCarry);
  ball.vel = V.add(V.add(vr, applied), carry);
  ball.pos = V.lerp(ball.pos, plat, 0.5);
  ball.spin = V.scale(ball.spin, 0.2);
  ball.floating = false;
  registerTouch(state, p, false);
  const rating = err < 0.07 ? R.Perfect : err < 0.17 ? R.Good : R.Shank;
  emitContact(state, p, 'bump', Math.min(1, (speedIn + c.speedMax * force) / 22), rating, ball.pos, rating === R.Perfect && speedIn > 6);
  return true;
}

// ---------------------------------------------------------------------------
// Dive, block
// ---------------------------------------------------------------------------

function startDive(state: GameState, p: PlayerState, input: InputFrame): void {
  const c = CONFIG.dig;
  const move = V.normalize(V.v3(input.moveX, 0, input.moveZ));
  startAction(p, 'dive');
  p.facing = Math.atan2(move.z, move.x);
  p.vel.x = move.x * c.diveSpeed;
  p.vel.z = move.z * c.diveSpeed;
  p.vel.y = c.diveUp;
  p.grounded = false;
  p.stamina = Math.max(0, p.stamina - c.diveCost);
  state.events.push({ type: 'dive', pos: V.copy(p.pos), player: p.id, power: 1 });
}

/**
 * Penultimate step (Space while moving): a small hop that keeps the approach charge. Space held = planted;
 * the charge (sprintTime) drains while held, so a long plant gives a lower jump.
 * The jump fires when Space is released (or after plantMaxHold).
 */
function startPlant(state: GameState, p: PlayerState): void {
  const c = CONFIG.player;
  startAction(p, 'plant');
  p.vel.y = c.plantHop;
  p.grounded = false;
  p.pos.y = 0.001;
  state.events.push({ type: 'jump', pos: V.copy(p.pos), player: p.id, power: 0.1 });
}

function releaseBlock(state: GameState, p: PlayerState, input: InputFrame): void {
  const b = CONFIG.block;
  const charge = p.action.charge;
  let h = V.lerpN(b.minJump, b.maxJump, charge) * staminaFactor(p);
  // A/D relative to the facing direction
  const move = V.v3(input.moveX, 0, input.moveZ);
  const lateral = V.dot(move, rightOf(p));
  let variant = 0;
  if (Math.abs(lateral) > 0.5) {
    variant = lateral > 0 ? 1 : -1;
    h *= b.diveHeightMul;
    const r = rightOf(p);
    p.vel.x = r.x * b.diveLateral * variant;
    p.vel.z = r.z * b.diveLateral * variant;
  } else {
    p.vel.x *= 0.3;
    p.vel.z *= 0.3;
  }
  p.vel.y = jumpVelocityForHeight(h);
  p.grounded = false;
  p.jumpHeight = h;
  p.stamina = Math.max(0, p.stamina - b.cost);
  startAction(p, 'block', variant);
  state.events.push({ type: 'jump', pos: V.copy(p.pos), player: p.id, power: h / b.maxJump });
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

export function holdPos(p: PlayerState): Vec3 {
  const f = forwardOf(p);
  const r = rightOf(p);
  const underhand = p.action.type === 'serve_charge' && p.action.variant === 0;
  const h = underhand ? 0.95 : 1.25;
  return V.v3(p.pos.x + f.x * 0.4 + r.x * 0.12, p.pos.y + h, p.pos.z + f.z * 0.4 + r.z * 0.12);
}

function performServe(state: GameState, p: PlayerState, variant: number, charge: number): void {
  const c = CONFIG.serve;
  const ball = state.ball;
  const target = aimTarget(p);
  const f = forwardOf(p);
  ball.held = -1;
  if (variant === 0) {
    const from = V.v3(p.pos.x + f.x * 0.5, p.pos.y + 1.0, p.pos.z + f.z * 0.5);
    const speed = V.lerpN(c.underhandSpeedMin, c.underhandSpeedMax, charge);
    const res = solveLaunch(from, target, speed, 3, 0, 'high', 0.15, 1.2);
    ball.pos = from;
    ball.vel = perturb(state, res.vel, 0.03);
    ball.spin = topspinFor(V.v3(res.vel.x, 0, res.vel.z), 3);
    ball.floating = false;
  } else {
    const from = V.v3(p.pos.x + f.x * 0.35, p.pos.y + c.floatContactHeight, p.pos.z + f.z * 0.35);
    const speed = V.lerpN(c.floatSpeedMin, c.floatSpeedMax, charge);
    const res = solveLaunch(from, target, speed, 0, 0, 'low', -0.3, 1.0);
    ball.pos = from;
    ball.vel = perturb(state, res.vel, 0.025);
    ball.spin = V.v3();
    ball.floating = true;
    ball.knuckleTimer = 0;
  }
  registerTouch(state, p, false);
  emitContact(state, p, 'serve', 0.3 + 0.5 * charge, charge > 0.9 ? R.Perfect : R.Good, ball.pos);
  state.events.push({ type: 'serve', pos: V.copy(ball.pos), player: p.id, power: charge });
}

function performToss(state: GameState, p: PlayerState): void {
  const c = CONFIG.serve;
  const ball = state.ball;
  const f = forwardOf(p);
  ball.held = -1;
  ball.pos = holdPos(p);
  ball.vel = V.v3(f.x * c.tossForward + p.vel.x, c.tossUp, f.z * c.tossForward + p.vel.z);
  ball.spin = V.v3();
  ball.floating = false;
  ball.idleTime = 0;
  startAction(p, 'toss');
  state.events.push({ type: 'contact', pos: V.copy(ball.pos), player: p.id, power: 0.1, kind: 'toss', rating: R.Good });
}

// ---------------------------------------------------------------------------
// Main per-player action update
// ---------------------------------------------------------------------------

export function stepPlayerActions(state: GameState, p: PlayerState, input: InputFrame, dt: number): void {
  const prev = p.prevInput;
  const pressed = (k: 'primary' | 'secondary' | 'tip' | 'block' | 'jump' | 'sprint'): boolean => input[k] && !prev[k];
  const released = (k: 'primary' | 'secondary' | 'tip' | 'block' | 'jump'): boolean => !input[k] && prev[k];
  const ball = state.ball;
  const a = p.action;
  a.t += dt;
  p.attackType = input.attackType;
  const moving = Math.hypot(input.moveX, input.moveZ) > 0.3;

  if (pressed('primary')) {
    p.primaryPressedTick = state.tick;
    // dig grace: a press just after a body contact still partly controls the ball
    const graceTicks = Math.round(CONFIG.dig.graceAfter / dt);
    if (p.digGraceTick >= 0 && state.tick - p.digGraceTick <= graceTicks && ball.lastToucher === p.id) {
      const k = 1 - (state.tick - p.digGraceTick) / Math.max(1, graceTicks);
      const blend = CONFIG.dig.graceQualityCap * k;
      ball.vel = V.lerp(ball.vel, p.digGracePop, blend);
      p.digGraceTick = -1;
      emitContact(state, p, 'dig', 0.4, R.Late, ball.pos);
    }
  }

  // Serving: the server holds the ball
  if (state.phase === 'serve' && ball.held === p.id) {
    const canServe = state.phaseTimer >= CONFIG.serve.serveDelay;
    if (a.type === 'none') {
      if (canServe && pressed('primary')) startAction(p, 'serve_charge', 0);
      else if (canServe && pressed('secondary')) startAction(p, 'serve_charge', 1);
      else if (canServe && pressed('jump')) performToss(state, p);
    } else if (a.type === 'serve_charge') {
      a.charge = Math.min(1, a.t / CONFIG.serve.chargeTime);
      const key = a.variant === 0 ? 'primary' : 'secondary';
      if (released(key)) {
        performServe(state, p, a.variant, a.charge);
        endAction(p);
      }
    }
    return;
  }

  switch (a.type) {
    case 'none': {
      if (!p.grounded) {
        if (pressed('primary')) instantSwing(state, p);
        else if (pressed('tip')) startAction(p, 'tip_charge');
        else if (pressed('secondary')) startAction(p, 'set_charge', 1);
      } else {
        // jumping while moving (walking or sprinting) goes through the penultimate step; standing still jumps at once
        if (pressed('jump') && moving && p.stamina > 5) startPlant(state, p);
        else if (pressed('jump')) doJump(state, p);
        else if (pressed('block')) startAction(p, 'block_charge');
        else if (pressed('primary')) startAction(p, 'bump_charge');
        else if (pressed('secondary')) startAction(p, 'set_charge');
      }
      break;
    }
    case 'toss': {
      if (a.t > 0.05) endAction(p);
      break;
    }
    case 'swing_charge': {
      a.charge = swingChargeAt(a.t);
      if (p.grounded) {
        endAction(p);
      } else if (released('primary')) {
        beginSwing(state, p);
      }
      break;
    }
    case 'swing': {
      updateSwing(state, p);
      break;
    }
    case 'tip_charge': {
      a.charge = Math.min(1, a.t / CONFIG.tip.chargeTime);
      if (p.grounded) endAction(p);
      else if (released('tip')) {
        if (!performTip(state, p, a.charge)) {
          p.lastRating = R.Whiff;
          state.events.push({ type: 'rating', pos: idealContactPoint(p), player: p.id, power: 0, rating: R.Whiff });
        }
        startAction(p, 'tip');
      }
      break;
    }
    case 'tip': {
      if (a.t > 0.3) endAction(p);
      break;
    }
    case 'set_charge': {
      a.charge = Math.min(1, a.t / CONFIG.set.chargeTime);
      if (released('secondary')) {
        const ch = a.charge;
        if (performSet(state, p, ch)) {
          startAction(p, 'set');
          a.contacted = true;
          a.charge = ch;
        } else {
          startAction(p, 'set');
          a.charge = ch;
          a.buffered = CONFIG.set.bufferTime;
        }
      }
      break;
    }
    case 'set': {
      if (!a.contacted && a.buffered > 0) {
        a.buffered -= dt;
        if (performSet(state, p, a.charge)) a.contacted = true;
        else if (a.buffered <= 0) {
          p.lastRating = R.Whiff;
          state.events.push({ type: 'rating', pos: setHandsPos(p), player: p.id, power: 0, rating: R.Whiff });
        }
      }
      if (a.t > 0.35) endAction(p);
      break;
    }
    case 'bump_charge': {
      a.charge = Math.min(1, a.t / CONFIG.bump.chargeTime);
      if (pressed('jump') && input.sprint && moving && p.stamina > 5) {
        startDive(state, p, input);
        break;
      }
      if (released('primary')) {
        const ch = a.charge;
        if (performBump(state, p, ch)) {
          startAction(p, 'bump');
          a.contacted = true;
          a.charge = ch;
        } else {
          startAction(p, 'bump');
          a.charge = ch;
          a.buffered = CONFIG.bump.bufferTime;
        }
      }
      break;
    }
    case 'bump': {
      if (!a.contacted && a.buffered > 0) {
        a.buffered -= dt;
        if (performBump(state, p, a.charge)) a.contacted = true;
        else if (a.buffered <= 0) {
          p.lastRating = R.Whiff;
          state.events.push({ type: 'rating', pos: platformPos(p), player: p.id, power: 0, rating: R.Whiff });
        }
      }
      if (a.t > 0.35) endAction(p);
      break;
    }
    case 'plant': {
      const c = CONFIG.player;
      if (released('jump') || a.t >= c.plantMaxHold) a.buffered = 1;
      // the approach charge drains only while Space is held (not while the hop lands after release)
      if (a.buffered === 0) p.sprintTime = Math.max(0, p.sprintTime - c.plantDecay * dt);
      // charge shown on the HUD: how much of the approach is left
      a.charge = Math.min(1, p.sprintTime / c.approachTime);
      if (a.buffered > 0 && p.grounded) {
        endAction(p);
        doJump(state, p);
      }
      break;
    }
    case 'dive': {
      // a press during the dive is a reaching bump
      if (pressed('primary') && !a.contacted) {
        if (performBump(state, p, 0.45)) a.contacted = true;
      }
      if (a.t >= CONFIG.dig.diveDuration && p.grounded) {
        startAction(p, 'prone');
      }
      break;
    }
    case 'prone': {
      if (a.t >= CONFIG.dig.diveRecovery) endAction(p);
      break;
    }
    case 'block_charge': {
      a.charge = Math.min(1, a.t / CONFIG.block.chargeTime);
      if (released('block')) releaseBlock(state, p, input);
      break;
    }
    case 'block': {
      if (p.grounded && a.t > 0.15) endAction(p);
      break;
    }
    case 'serve_charge': {
      // lost the ball somehow (phase changed): cancel
      endAction(p);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Ball vs body / hands (passive deflection, timed dig, block)
// ---------------------------------------------------------------------------

export function collideBallWithPlayer(state: GameState, p: PlayerState): void {
  const ball = state.ball;
  if (ball.held >= 0) return;
  const dt = simDt();
  const cooldownTicks = Math.round(CONFIG.rules.sameTouchCooldown / dt);
  if (ball.lastToucher === p.id && state.tick - p.lastContactTick < cooldownTicks) return;
  const r = CONFIG.ball.radius;

  // block hands first (above the net band)
  if (p.action.type === 'block' && p.action.t < CONFIG.block.activeTime && ball.pos.y > CONFIG.court.netHeight - 0.35) {
    if (collideHands(state, p)) return;
  }

  const cap = bodyCapsule(p);
  const q = closestPointOnSegment(cap.a, cap.b, ball.pos);
  const d = V.dist(ball.pos, q);
  if (d >= cap.r + r) return;
  let n = V.normalize(V.sub(ball.pos, q));
  if (V.len(n) < 1e-6) n = V.v3(0, 1, 0);
  // separate
  ball.pos = V.addScaled(q, n, cap.r + r + 0.005);
  const relVel = V.sub(ball.vel, p.vel);
  if (V.dot(relVel, n) > 0) return; // moving away already
  const speedIn = V.len(ball.vel);
  const b = CONFIG.ball;
  const vRaw = V.add(V.scale(V.reflect(relVel, n), b.bodyRestitution), V.scale(p.vel, 0.8));
  if (vRaw.y < 0.5 && speedIn > 3) vRaw.y = 0.5 + speedIn * 0.05; // body contacts tend to pop a little

  const canDig = p.action.type !== 'block' && p.action.type !== 'swing' && p.action.type !== 'swing_charge';
  const c = CONFIG.dig;
  const side = teamSide(state, p.team);
  const center = V.v3(side * 4.5, 0, 0);
  const toCenter = V.normalize(V.v3(center.x - ball.pos.x, 0, center.z - ball.pos.z));
  const rgt = rightOf(p);
  const lateral = V.dot(V.sub(ball.pos, p.pos), rgt);
  const pop = V.add(V.add(V.scale(toCenter, c.popToward), V.v3(0, c.popUp, 0)), V.scale(rgt, c.popSide * Math.sign(lateral || 1)));

  if (speedIn > CONFIG.bump.hardBallSpeed && canDig) {
    const sincePress = (state.tick - p.primaryPressedTick) * dt;
    const windowEnd = c.window + c.idealLead;
    if (sincePress >= 0 && sincePress <= windowEnd && p.primaryPressedTick > p.lastContactTick) {
      const q01 = V.clamp(1 - Math.abs(sincePress - c.idealLead) / c.window, 0, 1);
      const blend = Math.pow(q01, c.dampingPower);
      ball.vel = V.lerp(vRaw, pop, blend);
      ball.spin = V.scale(ball.spin, 0.3);
      ball.floating = false;
      registerTouch(state, p, false);
      const rating =
        Math.abs(sincePress - c.idealLead) <= c.perfectWindow ? R.Perfect : q01 > 0.45 ? R.Good : sincePress < c.idealLead ? R.Late : R.Early;
      emitContact(state, p, 'dig', Math.min(1, speedIn / 22), rating, ball.pos, rating === R.Perfect);
      p.primaryPressedTick = -1000;
      if (p.action.type === 'bump_charge' || p.action.type === 'bump') {
        startAction(p, 'dig');
        p.action.contacted = true;
      }
      return;
    }
    // raw body deflection with a short grace for a late press
    ball.vel = vRaw;
    ball.spin = V.scale(ball.spin, 0.5);
    ball.floating = false;
    registerTouch(state, p, false);
    p.digGraceTick = state.tick;
    p.digGracePop = pop;
    emitContact(state, p, 'body', Math.min(1, speedIn / 22), R.Body, ball.pos);
    return;
  }
  // slow ball off the body
  ball.vel = vRaw;
  ball.spin = V.scale(ball.spin, 0.5);
  registerTouch(state, p, false);
  emitContact(state, p, 'body', Math.min(1, speedIn / 22), R.Body, ball.pos);
  if (p.action.type === 'dig') return;
}

function collideHands(state: GameState, p: PlayerState): boolean {
  const ball = state.ball;
  const b = CONFIG.block;
  const r = CONFIG.ball.radius;
  const hands = blockHands(p);
  const center = V.lerp(hands[0], hands[1], 0.5);
  const spread = V.dist(hands[0], hands[1]) / 2;
  for (const h of hands) {
    const d = V.dist(ball.pos, h);
    if (d >= b.handRadius + r) continue;
    const f = forwardOf(p);
    // plane normal: forward tilted down by aim pitch (pressing over the net)
    const press = V.clamp(-p.pitch / b.netPressPitch, -0.4, 1);
    const nPlane = V.normalize(V.add(f, V.v3(0, -press * 0.9, 0)));
    const nSphere = V.normalize(V.sub(ball.pos, h));
    let n = V.normalize(V.lerp(nPlane, nSphere, 0.3));
    const relVel = V.sub(ball.vel, p.vel);
    if (V.dot(relVel, nSphere) > 0) {
      ball.pos = V.addScaled(h, nSphere, b.handRadius + r + 0.005);
      return true;
    }
    const lateral = V.dot(V.sub(ball.pos, center), rightOf(p));
    const centrality = 1 - V.clamp(Math.abs(lateral) / (spread + b.handRadius), 0, 1);
    const speedIn = V.len(ball.vel);
    let vOut: Vec3;
    let rating: number;
    if (centrality > b.stuffCentrality) {
      vOut = V.scale(V.reflect(relVel, n), b.restitution);
      const down = V.normalize(V.add(V.v3(0, -1, 0), V.scale(f, 0.45)));
      const dir = V.normalize(V.lerp(V.normalize(vOut), down, b.stuffDownBlend * centrality));
      vOut = V.scale(dir, Math.max(5, V.len(vOut)));
      rating = centrality > 0.85 ? R.Perfect : R.Good;
    } else {
      const outward = V.scale(rightOf(p), Math.sign(lateral || 1));
      n = V.normalize(V.add(V.add(n, V.scale(outward, b.toolOutward)), V.v3(0, b.toolOutward * 0.6, 0)));
      vOut = V.scale(V.reflect(relVel, n), b.toolRestitution);
      rating = R.Tool;
    }
    vOut = V.addScaled(vOut, p.vel, 0.5);
    ball.pos = V.addScaled(h, nSphere, b.handRadius + r + 0.005);
    ball.vel = vOut;
    ball.spin = V.scale(ball.spin, 0.3);
    ball.floating = false;
    registerTouch(state, p, true);
    emitContact(state, p, 'block', Math.min(1, speedIn / 22) * (rating === R.Tool ? 0.5 : 1), rating, ball.pos, rating === R.Perfect && speedIn > 12);
    return true;
  }
  return false;
}

export { RATINGS };
