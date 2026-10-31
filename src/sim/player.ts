import { CONFIG } from '../config';
import { AttackType, emptyInput, type GameState, type InputFrame, type PlayerState, teamSide } from './types';
import * as V from './vec';
import type { Vec3 } from './vec';

export function createPlayer(id: number, team: 0 | 1): PlayerState {
  return {
    id,
    team,
    pos: V.v3(team === 0 ? -4 : 4, 0, id % 2 === 0 ? -2 : 2),
    vel: V.v3(),
    yaw: team === 0 ? 0 : Math.PI,
    pitch: 0,
    facing: team === 0 ? 0 : Math.PI,
    grounded: true,
    stamina: CONFIG.player.staminaMax,
    sprintTime: 0,
    jumpHeight: 0,
    action: { type: 'none', t: 0, charge: 0, buffered: 0, timing: 0, variant: 0, contacted: false },
    attackType: AttackType.Straight,
    lastContactTick: -1000,
    primaryPressedTick: -1000,
    digGraceTick: -1,
    digGracePop: V.v3(),
    prevInput: emptyInput(),
    isServer: false,
    active: true,
    touchesThisRally: 0,
    lastRating: -1,
  };
}

/** 0..1 multiplier for power/speed/jump based on stamina. */
export function staminaFactor(p: PlayerState): number {
  const c = CONFIG.player;
  if (p.stamina >= c.lowStamina) return 1;
  return V.lerpN(c.lowStaminaFloor, 1, p.stamina / c.lowStamina);
}

/** Jump height from continuous sprint time (ease out), scaled by stamina. */
export function jumpHeightFor(p: PlayerState): number {
  const c = CONFIG.player;
  const t = V.easeOut(p.sprintTime / c.approachTime);
  return V.lerpN(c.baseJump, c.maxJump, t) * staminaFactor(p);
}

export function jumpVelocityForHeight(h: number): number {
  return Math.sqrt(2 * CONFIG.ball.gravity * Math.max(0.01, h));
}

export function forwardOf(p: PlayerState): Vec3 {
  return V.v3(Math.cos(p.facing), 0, Math.sin(p.facing));
}
export function rightOf(p: PlayerState): Vec3 {
  return V.v3(-Math.sin(p.facing), 0, Math.cos(p.facing));
}
export function aimDir(p: PlayerState): Vec3 {
  return V.dirFromYawPitch(p.yaw, p.pitch);
}
export function eyePos(p: PlayerState): Vec3 {
  return V.v3(p.pos.x, p.pos.y + CONFIG.player.eyeHeight, p.pos.z);
}
/** Hitting shoulder (right side). */
export function shoulderPos(p: PlayerState): Vec3 {
  const r = rightOf(p);
  return V.v3(p.pos.x + r.x * 0.2, p.pos.y + CONFIG.player.shoulderHeight, p.pos.z + r.z * 0.2);
}
/** Ideal spike contact point: top of reach, slightly in front of the hitting shoulder. */
export function idealContactPoint(p: PlayerState): Vec3 {
  const f = forwardOf(p);
  const r = rightOf(p);
  const s = CONFIG.spike;
  return V.v3(
    p.pos.x + f.x * s.forwardOffset + r.x * s.sideOffset,
    p.pos.y + CONFIG.player.standingReach,
    p.pos.z + f.z * s.forwardOffset + r.z * s.sideOffset,
  );
}
/** Setting hands point (above the forehead). */
export function setHandsPos(p: PlayerState): Vec3 {
  const f = forwardOf(p);
  return V.v3(p.pos.x + f.x * 0.15, p.pos.y + CONFIG.set.handHeight, p.pos.z + f.z * 0.15);
}
/** Forearm platform point in front of the body, lower when diving. */
export function platformPos(p: PlayerState): Vec3 {
  const f = forwardOf(p);
  const diving = p.action.type === 'dive';
  const fwd = CONFIG.bump.platformForward + (diving ? 0.6 : 0);
  const h = diving ? 0.5 : CONFIG.bump.platformHeight;
  return V.v3(p.pos.x + f.x * fwd, p.pos.y + h, p.pos.z + f.z * fwd);
}
/** Block hand positions (two). */
export function blockHands(p: PlayerState): [Vec3, Vec3] {
  const r = rightOf(p);
  const f = forwardOf(p);
  const b = CONFIG.block;
  const spread = p.action.type === 'block' && p.action.variant !== 0 ? b.diveHandSpread : b.handSpacing;
  const h = p.pos.y + b.handReach;
  const fx = f.x * 0.25;
  const fz = f.z * 0.25;
  return [
    V.v3(p.pos.x + fx - r.x * spread, h, p.pos.z + fz - r.z * spread),
    V.v3(p.pos.x + fx + r.x * spread, h, p.pos.z + fz + r.z * spread),
  ];
}
/** Body capsule: segment from feet+radius to head-radius. */
export function bodyCapsule(p: PlayerState): { a: Vec3; b: Vec3; r: number } {
  const r = CONFIG.player.capsuleRadius;
  const h = CONFIG.player.height;
  if (p.action.type === 'dive' || p.action.type === 'prone') {
    // horizontal capsule along facing
    const f = forwardOf(p);
    const y = p.pos.y + 0.35;
    return {
      a: V.v3(p.pos.x - f.x * 0.3, y, p.pos.z - f.z * 0.3),
      b: V.v3(p.pos.x + f.x * (h - 0.6), y, p.pos.z + f.z * (h - 0.6)),
      r: r * 0.9,
    };
  }
  return { a: V.v3(p.pos.x, p.pos.y + r, p.pos.z), b: V.v3(p.pos.x, p.pos.y + h - r, p.pos.z), r };
}

export function closestPointOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab = V.sub(b, a);
  const t = V.clamp(V.dot(V.sub(p, a), ab) / Math.max(1e-9, V.lenSq(ab)), 0, 1);
  return V.addScaled(a, ab, t);
}

export function canMove(p: PlayerState): boolean {
  const t = p.action.type;
  return t !== 'dive' && t !== 'prone' && t !== 'block_charge' && t !== 'plant';
}

/** Movement, stamina, gravity and ground. Called once per tick before actions. */
export function stepPlayerMovement(state: GameState, p: PlayerState, input: InputFrame, dt: number): void {
  const c = CONFIG.player;
  const g = CONFIG.ball.gravity;
  const side = teamSide(state, p.team);
  const sf = staminaFactor(p);

  // aim always follows input
  p.yaw = input.yaw;
  p.pitch = V.clamp(input.pitch, CONFIG.camera.pitchMin, CONFIG.camera.pitchMax);

  const moving = Math.hypot(input.moveX, input.moveZ) > 0.05;
  const move = V.clampLen(V.v3(input.moveX, 0, input.moveZ), 1);
  const wantsSprint = input.sprint && moving && p.stamina > 0 && p.grounded && canMove(p);

  if (p.grounded) {
    if (canMove(p)) {
      const maxSpeed = wantsSprint ? V.lerpN(c.walkSpeed, c.sprintSpeed, sf) : c.walkSpeed;
      const desired = V.scale(move, maxSpeed);
      const dv = V.sub(desired, V.v3(p.vel.x, 0, p.vel.z));
      const accel = moving ? c.accel : c.decel;
      const step = V.clampLen(dv, accel * dt);
      p.vel.x += step.x;
      p.vel.z += step.z;
      // charging actions slow you down a bit
      if (p.action.type === 'set_charge' || p.action.type === 'bump_charge' || p.action.type === 'serve_charge') {
        p.vel.x *= 1 - 2.5 * dt;
        p.vel.z *= 1 - 2.5 * dt;
      }
    } else if (p.action.type === 'dive' || p.action.type === 'prone') {
      const f = Math.max(0, 1 - CONFIG.dig.diveFriction * dt);
      p.vel.x *= f;
      p.vel.z *= f;
    } else if (p.action.type === 'plant') {
      // planted: the step converts run speed; most of it is given back at takeoff via sprintTime
      const f = Math.max(0, 1 - c.plantBrake * dt);
      p.vel.x *= f;
      p.vel.z *= f;
    } else {
      // block charge: stand still
      p.vel.x *= Math.max(0, 1 - 12 * dt);
      p.vel.z *= Math.max(0, 1 - 12 * dt);
    }
  } else {
    // airborne: small steering only
    const steer = V.scale(move, c.airControl * dt);
    p.vel.x += steer.x;
    p.vel.z += steer.z;
  }

  // approach charge (sprintTime): builds while running on the ground, walking or sprinting alike
  const speedNow = Math.hypot(p.vel.x, p.vel.z);
  const approaching = p.grounded && canMove(p) && moving && speedNow > c.walkSpeed * 0.5;
  if (approaching) p.sprintTime += dt;
  else if (p.grounded && p.action.type !== 'plant') {
    // (the plant action decays sprintTime at its own rate)
    p.sprintTime = Math.max(0, p.sprintTime - dt * c.sprintDecay);
  }
  // stamina: drains while sprinting, regenerates otherwise on the ground
  if (wantsSprint && speedNow > c.walkSpeed * 0.8) p.stamina = Math.max(0, p.stamina - c.sprintDrain * dt);
  else if (p.grounded && !wantsSprint) p.stamina = Math.min(c.staminaMax, p.stamina + c.staminaRegen * dt);

  // gravity
  if (!p.grounded) p.vel.y -= g * dt;

  // integrate
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.pos.z += p.vel.z * dt;

  // ground
  if (p.pos.y <= 0) {
    if (!p.grounded) {
      state.events.push({ type: 'land', pos: V.copy(p.pos), player: p.id, power: Math.min(1, -p.vel.y / 6) });
      if (p.action.type !== 'plant') p.sprintTime = 0; // the plant hop keeps the approach charge
    }
    p.pos.y = 0;
    p.vel.y = 0;
    p.grounded = true;
  }

  // keep on own side and within the sand area
  const half = CONFIG.court.length / 2 + CONFIG.court.outMargin;
  const halfW = CONFIG.court.width / 2 + CONFIG.court.outMargin;
  const minNet = c.sideLimitFromNet;
  if (side < 0) {
    if (p.pos.x > -minNet) {
      p.pos.x = -minNet;
      p.vel.x = Math.min(0, p.vel.x);
    }
    if (p.pos.x < -half) {
      p.pos.x = -half;
      p.vel.x = Math.max(0, p.vel.x);
    }
  } else {
    if (p.pos.x < minNet) {
      p.pos.x = minNet;
      p.vel.x = Math.max(0, p.vel.x);
    }
    if (p.pos.x > half) {
      p.pos.x = half;
      p.vel.x = Math.min(0, p.vel.x);
    }
  }
  if (p.pos.z > halfW) {
    p.pos.z = halfW;
    p.vel.z = Math.min(0, p.vel.z);
  }
  if (p.pos.z < -halfW) {
    p.pos.z = -halfW;
    p.vel.z = Math.max(0, p.vel.z);
  }

  // server stays behind the end line until the serve
  if (state.phase === 'serve' && p.isServer && state.ball.held === p.id) {
    const endLine = CONFIG.court.length / 2;
    if (side < 0 && p.pos.x > -endLine - 0.2) p.pos.x = -endLine - 0.2;
    if (side > 0 && p.pos.x < endLine + 0.2) p.pos.x = endLine + 0.2;
  }

  // body facing: toward aim while acting or standing, toward movement while running
  const speed = Math.hypot(p.vel.x, p.vel.z);
  let targetFacing = p.yaw;
  if (speed > 1.5 && p.action.type === 'none' && p.grounded) {
    const moveYaw = Math.atan2(p.vel.z, p.vel.x);
    // bias: face aim if moving roughly toward it, else blend
    const d = Math.abs(V.wrapAngle(moveYaw - p.yaw));
    targetFacing = d < 1.2 ? p.yaw : moveYaw;
  }
  if (p.action.type === 'dive' || p.action.type === 'prone') targetFacing = p.facing;
  // bumping and digging: square up to the ball
  const at = p.action.type;
  if ((at === 'bump_charge' || at === 'bump' || at === 'dig') && state.ball.held < 0) {
    const dx = state.ball.pos.x - p.pos.x;
    const dz = state.ball.pos.z - p.pos.z;
    if (dx * dx + dz * dz < 16 && dx * dx + dz * dz > 0.01) targetFacing = Math.atan2(dz, dx);
  }
  // in the air the body barely turns
  const turnMul = p.grounded ? 1 : 0.25;
  const diff = V.wrapAngle(targetFacing - p.facing);
  const maxTurn = c.turnRate * dt * turnMul;
  p.facing = V.wrapAngle(p.facing + V.clamp(diff, -maxTurn, maxTurn));
}

export function doJump(state: GameState, p: PlayerState, heightMul = 1): void {
  const c = CONFIG.player;
  const h = jumpHeightFor(p) * heightMul;
  p.vel.y = jumpVelocityForHeight(h);
  p.vel.x *= c.jumpMomentumKeep;
  p.vel.z *= c.jumpMomentumKeep;
  p.grounded = false;
  p.jumpHeight = h;
  p.stamina = Math.max(0, p.stamina - c.jumpCost);
  p.pos.y = 0.001;
  state.events.push({ type: 'jump', pos: V.copy(p.pos), player: p.id, power: h / c.maxJump });
}
