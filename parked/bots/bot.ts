import { CONFIG } from '../config';
import { predictBall, velocityForApexDrag } from './ball';
import { predictContactTiming } from './actions';
import { eyePos, idealContactPoint, jumpHeightFor, platformPos, setHandsPos } from './player';
import { rngNext, rngRange, rngSigned } from './rng';
import { AttackType, emptyInput, type GameState, type InputFrame, type PlayerState, teamSide } from './types';
import * as V from './vec';
import type { Vec3 } from './vec';

/** Per-bot memory. Deterministic: own seeded RNG, no wall clock. */
export interface BotMemory {
  rng: number;
  moveTarget: Vec3;
  attackTarget: Vec3;
  attackType: AttackType;
  serveKind: number; // 0 float, 1 jump
  serveTarget: Vec3;
  planRally: number; // rallyLength the current plan was made for
  reactUntil: number;
  holdPrimary: boolean;
  holdSecondary: boolean;
  holdBlock: boolean;
  blockStart: number;
  aimNoiseYaw: number;
  aimNoisePitch: number;
  decided: boolean;
  jumped: boolean;
  approachStarted: boolean;
  loggedPlan: boolean;
  lastServeDecision: number;
}

export function createBotMemory(seed: number, id: number): BotMemory {
  return {
    rng: (seed * 7919 + id * 104729 + 17) >>> 0,
    moveTarget: V.v3(),
    attackTarget: V.v3(),
    attackType: AttackType.Straight,
    serveKind: 0,
    serveTarget: V.v3(),
    planRally: -1,
    reactUntil: 0,
    holdPrimary: false,
    holdSecondary: false,
    holdBlock: false,
    blockStart: 0,
    aimNoiseYaw: 0,
    aimNoisePitch: 0,
    decided: false,
    jumped: false,
    approachStarted: false,
    loggedPlan: false,
    lastServeDecision: -1,
  };
}

function setAim(input: InputFrame, from: Vec3, to: Vec3, mem: BotMemory): void {
  const d = V.sub(to, from);
  input.yaw = V.yawOf(d) + mem.aimNoiseYaw;
  input.pitch = V.clamp(V.pitchOf(d) + mem.aimNoisePitch, CONFIG.camera.pitchMin, CONFIG.camera.pitchMax);
}

function aimDirection(input: InputFrame, dir: Vec3, pitchBias: number, mem: BotMemory): void {
  input.yaw = V.yawOf(dir) + mem.aimNoiseYaw;
  input.pitch = V.clamp(V.pitchOf(dir) - pitchBias + mem.aimNoisePitch, CONFIG.camera.pitchMin, CONFIG.camera.pitchMax);
}

/** Move toward a point with arrive behavior. */
function moveTo(input: InputFrame, p: PlayerState, target: Vec3, sprintDist = 2.2): void {
  const d = V.v3(target.x - p.pos.x, 0, target.z - p.pos.z);
  const dist = V.len(d);
  if (dist < 0.08) return;
  const dir = V.scale(d, 1 / dist);
  const speed = V.clamp(dist / 0.6, 0.25, 1);
  input.moveX = dir.x * speed;
  input.moveZ = dir.z * speed;
  input.sprint = dist > sprintDist;
}

function newNoise(mem: BotMemory): void {
  const skill = CONFIG.bots.skill;
  const n = CONFIG.bots.aimNoise * (1 - skill);
  mem.aimNoiseYaw = rngSigned(mem) * n;
  mem.aimNoisePitch = rngSigned(mem) * n * 0.6;
}

interface Landing {
  pos: Vec3;
  time: number;
  hitNet: boolean;
}

function landingAt(state: GameState, height: number): Landing {
  const b = state.ball;
  const pr = predictBall(b.pos, b.vel, b.spin, { stopHeight: height, maxTime: 5, net: true, dt: 1 / 60 });
  if (pr.hitNet) {
    const sideOfHit = pr.pos.x < 0 ? -1 : 1;
    // ball drops near the net on the hitter's side
    return { pos: V.v3(sideOfHit * 0.5, height, pr.pos.z), time: pr.time + 0.4, hitNet: true };
  }
  return { pos: pr.pos, time: pr.reached ? pr.time : 99, hitNet: false };
}

/** Choose a point on the opponent's court away from their players. */
function pickAttackTarget(state: GameState, p: PlayerState, mem: BotMemory): Vec3 {
  const side = teamSide(state, p.team);
  const opp = state.players.filter((o) => o.team !== p.team && o.active);
  const candidates: Vec3[] = [];
  for (const dx of [2.5, 4.5, 6.5]) for (const dz of [-3, -1, 1, 3]) candidates.push(V.v3(-side * dx, 0, dz));
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    let score = rngNext(mem) * 2.0;
    for (const o of opp) {
      // the blocker (near the net) hardly matters for deep targets
      const d = V.distXZ(c, o.pos);
      score += Math.min(d, 4);
    }
    // prefer deeper when hitting from off the net
    if (Math.abs(p.pos.x) > 2.5) score += Math.abs(c.x) * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Solve the bump the bot wants: platform normal n and force f (0..1) so that
 * e*reflect(vIn,n) + f*Fmax*n ~= vDes.
 */
function solveBump(vIn: Vec3, vDes: Vec3): { n: Vec3; force: number } {
  const e = CONFIG.bump.restitution;
  const diff = V.sub(vDes, V.scale(vIn, e));
  const n = V.normalize(diff);
  const F = V.len(diff) + 2 * e * V.dot(vIn, n);
  return { n, force: V.clamp(F / CONFIG.bump.speedMax, 0, 1) };
}

function defaultSpot(state: GameState, p: PlayerState): Vec3 {
  const side = teamSide(state, p.team);
  const idx = p.id % 2;
  if (state.servingTeam === p.team) {
    if (p.isServer) return V.v3(side * 8.8, 0, -side * 1.2);
    return V.v3(side * 2.6, 0, side * 1.6);
  }
  return V.v3(side * 5.6, 0, idx === 0 ? -2 : 2);
}

export function botInput(state: GameState, idx: number, mem: BotMemory): InputFrame {
  const p = state.players[idx];
  const input = emptyInput();
  input.attackType = mem.attackType;
  if (!p.active) return input;
  const side = teamSide(state, p.team);
  const ball = state.ball;
  const mate = state.players.find((o) => o.team === p.team && o.id !== p.id && o.active);
  const netCenter = V.v3(0, 2.2, 0);
  const eye = eyePos(p);
  const bots = CONFIG.bots;

  // default: look at the ball
  setAim(input, eye, ball.pos, mem);

  if (state.phase === 'point' || state.phase === 'gameover') {
    mem.planRally = -1;
    mem.decided = false;
    mem.jumped = false;
    mem.approachStarted = false;
    mem.holdBlock = false;
    mem.holdPrimary = false;
    mem.holdSecondary = false;
    return input;
  }

  // ---------------- Serving -----------------
  if (state.phase === 'serve') {
    if (ball.held === p.id) {
      if (mem.lastServeDecision !== state.stats.rallies) {
        mem.lastServeDecision = state.stats.rallies;
        mem.serveKind = rngNext(mem) < bots.jumpServeChance * bots.skill ? 1 : 0;
        mem.serveTarget = V.v3(-side * rngRange(mem, 3.5, 7.4), CONFIG.ball.radius, rngRange(mem, -3.2, 3.2));
        newNoise(mem);
        mem.holdSecondary = false;
        mem.blockStart = state.time + CONFIG.serve.serveDelay + bots.serveDelay + rngRange(mem, 0, 0.6);
        mem.jumped = false;
      }
      setAim(input, eye, mem.serveTarget, mem);
      if (state.time < mem.blockStart) return input;
      if (mem.serveKind === 0) {
        // float serve: hold RMB for a while then release
        const hold = CONFIG.serve.chargeTime * (0.65 + 0.35 * bots.skill);
        if (state.time < mem.blockStart + hold) input.secondary = true;
        return input;
      }
      // jump serve: toss, then handled like an attack below once the ball is free
      if (!mem.jumped) {
        input.jump = true;
        mem.jumped = true;
        mem.attackTarget = mem.serveTarget;
        mem.attackType = AttackType.Straight;
        input.attackType = mem.attackType;
      }
      return input;
    }
    if (ball.held >= 0) {
      moveTo(input, p, defaultSpot(state, p));
      return input;
    }
    // tossed ball in the air: the server attacks it (falls through to rally logic as the taker)
  }

  // ---------------- Rally -----------------
  // new ball flight -> new plan after a reaction delay
  if (mem.planRally !== state.rallyLength) {
    mem.planRally = state.rallyLength;
    mem.reactUntil = state.time + bots.reactionTime * (1.3 - 0.6 * bots.skill);
    mem.decided = false;
    mem.jumped = p.grounded ? false : mem.jumped;
    mem.approachStarted = false;
    mem.loggedPlan = false;
    mem.holdPrimary = false;
    mem.holdSecondary = false;
    newNoise(mem);
  }
  const reacting = state.time < mem.reactUntil;

  const landLow = landingAt(state, CONFIG.bump.platformHeight);
  const ballDir = Math.sign(ball.vel.x);
  const ballOnOurSide = Math.sign(ball.pos.x) === side;
  const comingToUs = landLow.hitNet ? Math.sign(landLow.pos.x) === side : Math.sign(landLow.pos.x) === side || (ballOnOurSide && ballDir === side);
  const ourTouches = state.touchTeam === p.team ? state.touches : 0;
  const lastWasMe = ball.lastToucher === p.id && !ball.lastTouchWasBlock && state.touchTeam === p.team;
  const lastWasMate = mate && ball.lastToucher === mate.id && !ball.lastTouchWasBlock && state.touchTeam === p.team;
  const ballSpeed = V.len(ball.vel);

  if (comingToUs && (ourTouches < 3 || state.touchTeam !== p.team)) {
    // who takes it
    let iTake: boolean;
    if (lastWasMe) iTake = false;
    else if (lastWasMate) iTake = true;
    else if (!mate) iTake = true;
    else {
      const dMe = V.distXZ(p.pos, landLow.pos);
      const dMate = V.distXZ(mate.pos, landLow.pos);
      // a serving teammate who tossed takes their own serve
      if (state.phase === 'serve') iTake = p.isServer;
      else iTake = dMe < dMate - 0.15 || (Math.abs(dMe - dMate) <= 0.15 && p.id < mate.id);
    }

    if (iTake) {
      if (state.phase === 'serve' || ourTouches === 2 || (ourTouches === 1 && !mate)) {
        attack(state, p, mem, input, landLow, reacting);
      } else if (ourTouches === 0) {
        pass(state, p, mem, input, landLow, reacting);
      } else {
        setBall(state, p, mem, input, reacting);
      }
      return input;
    }
    // support roles
    if (ourTouches === 0) {
      // I'm the setter: get to the setter spot
      moveTo(input, p, V.v3(side * 2.2, 0, V.clamp(landLow.pos.z * 0.3, -1.5, 1.5)));
    } else if (ourTouches === 1) {
      // I'm the hitter: get deep enough for a full approach
      const z = V.clamp(p.pos.z, -2.8, 2.8);
      moveTo(input, p, V.v3(side * 6.2, 0, z), 1.0);
    } else {
      // cover the attacker
      moveTo(input, p, V.v3(side * 3.5, 0, -Math.sign(landLow.pos.z || 1) * 1.0));
    }
    return input;
  }

  // ball on / heading to the other side: defend
  defend(state, p, mem, input);
  return input;
}

/** Bump solve with the force-dependent restitution. */
function solveBumpFull(vIn: Vec3, vDes: Vec3): { n: Vec3; force: number } {
  let force = 0.5;
  let n = V.v3(0, 1, 0);
  for (let i = 0; i < 3; i++) {
    const e = CONFIG.bump.restitution * V.lerpN(CONFIG.bump.softRestitution, 1, force);
    const diff = V.sub(vDes, V.scale(vIn, e));
    n = V.normalize(diff);
    const F = V.len(diff) + 2 * e * V.dot(vIn, n);
    force = V.clamp(F / CONFIG.bump.speedMax, 0, 1);
  }
  return { n, force };
}

/** Where the ball crosses the player's platform band, and when. */
function intercept(state: GameState): Landing {
  return landingAt(state, 1.15);
}

/**
 * Receive / pass a ball with the platform toward `target` (a point at the desired height).
 * Handles both soft balls and hard-driven ones (the dig timing comes for free: press shortly before).
 */
function pass(state: GameState, p: PlayerState, mem: BotMemory, input: InputFrame, land: Landing, reacting: boolean, targetIn?: Vec3, apexAbove = 1.4): void {
  const side = teamSide(state, p.team);
  const ball = state.ball;
  const target = targetIn ?? V.v3(side * 2.2, 2.6, 0);
  // use the hands for slow, high balls
  const landHigh = landingAt(state, CONFIG.set.handHeight + 0.2);
  const useSet = landHigh.time < 90 && landHigh.time > 0 && V.distXZ(landHigh.pos, p.pos) < 1.0 && V.len(ball.vel) < 8 && !landHigh.hitNet;
  if (useSet && !targetIn) {
    setBall(state, p, mem, input, reacting, V.v3(target.x, 0, target.z), 2.6);
    return;
  }
  const hit = intercept(state);
  // stand so the platform (0.45 in front, facing the ball) is at the intercept: step back along the ball's travel
  const travel = V.normalize(V.v3(ball.vel.x, 0, ball.vel.z));
  const stand = V.addScaled(V.v3(hit.pos.x, 0, hit.pos.z), travel, CONFIG.bump.platformForward * 0.9);
  if (!reacting || V.distXZ(p.pos, stand) > 1.5) moveTo(input, p, stand, 1.6);
  const plat = platformPos(p);
  const vDes = velocityForApexDrag(plat, target, apexAbove);
  const tArrive = hit.time;
  const vIn = V.v3(ball.vel.x, ball.vel.y - CONFIG.ball.gravity * Math.min(tArrive, 2), ball.vel.z);
  const sol = solveBumpFull(vIn, vDes);
  aimDirection(input, sol.n, CONFIG.bump.pitchBias, mem);
  const holdNeeded = sol.force * CONFIG.bump.chargeTime;
  const near = V.dist(ball.pos, plat) < CONFIG.bump.reachRadius * 0.7;
  const fast = V.len(ball.vel) > CONFIG.bump.hardBallSpeed;
  const pressAt = Math.max(holdNeeded + 0.04, fast ? CONFIG.dig.idealLead + 0.06 : 0);
  if (!mem.holdPrimary && tArrive <= pressAt && tArrive < 1.5) {
    mem.holdPrimary = true;
    mem.blockStart = state.time;
  }
  if (mem.holdPrimary) {
    const held = state.time - mem.blockStart;
    const release = near || tArrive <= 0.02 || held > holdNeeded + 0.5;
    input.primary = !release;
    if (release) mem.holdPrimary = false;
  }
  // dive when the ball is out of reach but close enough
  const dist = V.distXZ(p.pos, stand);
  if (fast && dist > 1.3 && dist < 3.2 && tArrive < 0.45 && tArrive > 0.1 && p.grounded && p.stamina > 25 && p.action.type !== 'dive') {
    const d = V.normalize(V.v3(stand.x - p.pos.x, 0, stand.z - p.pos.z));
    input.moveX = d.x;
    input.moveZ = d.z;
    input.sprint = true;
    input.jump = true;
  }
}

function setBall(
  state: GameState,
  p: PlayerState,
  mem: BotMemory,
  input: InputFrame,
  reacting: boolean,
  explicitTarget?: Vec3,
  apexAbove = 1.0,
): void {
  const side = teamSide(state, p.team);
  const ball = state.ball;
  const mate = state.players.find((o) => o.team === p.team && o.id !== p.id && o.active);
  let target: Vec3;
  if (explicitTarget) target = V.v3(explicitTarget.x, 2.8, explicitTarget.z);
  else {
    const hz = mate ? V.clamp(mate.pos.z, -2.6, 2.6) : 0;
    target = V.v3(side * 1.1, 3.0, hz);
    apexAbove = 2.0; // high set: time for the approach
  }
  const landHands = landingAt(state, CONFIG.set.handHeight + 0.15);
  const landLow = landingAt(state, CONFIG.bump.platformHeight);
  const arrivesHigh = landHands.time < 90 && ball.vel.y < 0 || ball.pos.y > CONFIG.set.handHeight + 0.5;
  if (!arrivesHigh || V.len(ball.vel) > 9) {
    // too low for hands: bump it to the target instead
    pass(state, p, mem, input, landLow, reacting, target, apexAbove);
    return;
  }
  // make sure the set speed can reach the target: pull the target closer if needed
  for (let i = 0; i < 5; i++) {
    const vTest = velocityForApexDrag(setHandsPos(p), target, apexAbove);
    if (V.len(vTest) <= CONFIG.set.speedMax * 0.95) break;
    target = V.v3(p.pos.x + (target.x - p.pos.x) * 0.8, target.y, p.pos.z + (target.z - p.pos.z) * 0.8);
    if (Math.sign(target.x) === side && explicitTarget && Math.sign(explicitTarget.x) !== side) target.x = -side * 1.5;
  }
  // stand under the ball
  const stand = V.v3(landHands.pos.x, 0, landHands.pos.z);
  const f = V.normalize(V.v3(target.x - stand.x, 0, target.z - stand.z));
  stand.x -= f.x * 0.15;
  stand.z -= f.z * 0.15;
  if (!reacting) moveTo(input, p, stand, 1.6);
  const hands = setHandsPos(p);
  const c = CONFIG.set;
  let vDes = velocityForApexDrag(hands, target, apexAbove);
  // the aim pitch is limited: lower the arc until the set direction is reachable
  for (let i = 0; i < 6 && V.pitchOf(vDes) - c.pitchBias > CONFIG.camera.pitchMax - 0.02; i++) {
    apexAbove *= 0.7;
    vDes = velocityForApexDrag(hands, target, apexAbove);
  }
  const speed = V.len(vDes);
  const charge = V.clamp((speed - c.speedMin) / (c.speedMax - c.speedMin), 0, 1);
  aimDirection(input, vDes, c.pitchBias, mem);
  const holdNeeded = charge * c.chargeTime;
  const near = V.distXZ(ball.pos, hands) < c.reachRadius * 0.6 && Math.abs(ball.pos.y - hands.y) < 0.35;
  if (!mem.holdSecondary && landHands.time <= holdNeeded + 0.05 && landHands.time < 1.5) {
    mem.holdSecondary = true;
    mem.blockStart = state.time;
  }
  if (mem.holdSecondary) {
    const held = state.time - mem.blockStart;
    const release = (near && held >= holdNeeded - 0.02) || (landHands.time <= -0.1 && near) || held > holdNeeded + 0.6;
    input.secondary = !release;
    if (release) mem.holdSecondary = false;
  }
}

function attack(state: GameState, p: PlayerState, mem: BotMemory, input: InputFrame, landLow: Landing, reacting: boolean): void {
  const side = teamSide(state, p.team);
  const ball = state.ball;
  const s = CONFIG.spike;
  if (!mem.decided) {
    mem.decided = true;
    if (state.phase !== 'serve') {
      mem.attackTarget = pickAttackTarget(state, p, mem);
      const nearNet = Math.abs(landLow.pos.x) < 2.2;
      const r = rngNext(mem);
      if (nearNet && r > CONFIG.bots.attackVariety) mem.attackType = AttackType.Straight;
      else if (r < 0.15) mem.attackType = AttackType.Float;
      else mem.attackType = AttackType.Roll;
    }
  }
  input.attackType = mem.attackType;
  // planned jump (a full approach) and the contact height it gives
  const jumpH = p.grounded ? CONFIG.player.maxJump * 0.9 : p.jumpHeight;
  const contactH = CONFIG.player.standingReach + jumpH * 0.9;
  const landHit = landingAt(state, contactH);
  const canSpike = landHit.time < 90 && !landHit.hitNet && Math.abs(landHit.pos.x) < 4.5 && Math.abs(landHit.pos.x) > 0.25 && ball.pos.y > 1.6;
  const freeBall = !canSpike && !(state.phase === 'serve');
  if ((globalThis as any).BOT_DEBUG && !mem.loggedPlan) {
    mem.loggedPlan = true;
    console.log(`    [bot p${p.id} t=${state.time.toFixed(2)}] attack plan canSpike=${canSpike} landHit=(${landHit.pos.x.toFixed(2)},${landHit.pos.z.toFixed(2)}) t=${landHit.time.toFixed(2)} hitNet=${landHit.hitNet} ballY=${ball.pos.y.toFixed(2)} contactH=${contactH.toFixed(2)} type=${mem.attackType}`);
  }

  if (freeBall) {
    // can't attack it: send it over deep
    const target = V.v3(-side * 6.0, 0, mem.attackTarget.z || 0);
    setBall(state, p, mem, input, reacting, target, 1.2);
    return;
  }
  // approach: stand so the ideal contact point meets the ball
  const f = V.v3(-side, 0, 0); // face the net
  const r = V.v3(0, 0, -side); // right of facing
  const approach = V.v3(
    landHit.pos.x - f.x * s.forwardOffset - r.x * s.sideOffset,
    0,
    landHit.pos.z - f.z * s.forwardOffset - r.z * s.sideOffset,
  );
  if (Math.sign(approach.x) !== side || Math.abs(approach.x) < 0.5) approach.x = side * 0.5;
  const keep = CONFIG.player.jumpMomentumKeep;
  const tUp = Math.sqrt((2 * jumpH) / CONFIG.ball.gravity);
  if (p.grounded && !mem.jumped) {
    const tLand = landHit.time;
    const dist = V.distXZ(p.pos, approach);
    const sprintSpeed = CONFIG.player.sprintSpeed * 0.9;
    const drift = keep * sprintSpeed * tUp; // horizontal carry during the jump when sprinting
    const toApproach = V.normalize(V.v3(approach.x - p.pos.x, 0, approach.z - p.pos.z));
    const apexPos = V.v3(p.pos.x + p.vel.x * keep * tUp, 0, p.pos.z + p.vel.z * keep * tUp);
    const dApex = V.distXZ(apexPos, approach);
    setAim(input, eyePos(p), mem.attackTarget, mem);
    if (!mem.approachStarted) {
      const tNeeded = 0.45 + Math.max(0, dist - drift - 1.2) / sprintSpeed + tUp;
      if (tLand <= tNeeded + 0.05) {
        mem.approachStarted = true;
      } else {
        // early: drift to a staging point behind the approach (a real 3-4 step approach)
        const staging = V.v3(approach.x + side * Math.max(drift + 4.2, 5.2), 0, approach.z);
        const dStage = V.distXZ(p.pos, staging);
        // only go to staging if there is time to get there and still run in
        if (dStage > 0.4 && tLand > tNeeded + dStage / CONFIG.player.walkSpeed + 0.2) moveTo(input, p, staging, 9);
        return;
      }
    }
    if (dApex < 0.4 && tLand <= tUp + 0.05) {
      input.jump = true;
      input.sprint = false;
      mem.jumped = true;
      input.moveX = toApproach.x * 0.3;
      input.moveZ = toApproach.z * 0.3;
    } else if (tLand <= tUp - 0.06 && dist < 2.0) {
      // late: jump now, a low contact beats none
      input.jump = true;
      input.sprint = false;
      mem.jumped = true;
      input.moveX = toApproach.x * 0.5;
      input.moveZ = toApproach.z * 0.5;
    } else if (dApex < 0.4 || dist < 0.25) {
      // early and in place: wait
      input.moveX = toApproach.x * Math.min(1, dist * 2);
      input.moveZ = toApproach.z * Math.min(1, dist * 2);
    } else {
      input.moveX = toApproach.x;
      input.moveZ = toApproach.z;
      input.sprint = true;
    }
    return;
  }
  if (!p.grounded) {
    setAim(input, eyePos(p), mem.attackTarget, mem);
    // a low contact can't be hit flat: switch to a roll shot
    const reachAtApex = CONFIG.player.standingReach + p.jumpHeight;
    if (reachAtApex < 2.95 && mem.attackType === AttackType.Straight) mem.attackType = AttackType.Roll;
    if (reachAtApex < 2.8 && mem.attackType === AttackType.Float) mem.attackType = AttackType.Roll;
    input.attackType = mem.attackType;
    // hold LMB from takeoff; release when the ideal moment is swingLead away
    const pred = predictContactTiming(p, ball.pos, ball.vel);
    const skillErr = (1 - CONFIG.bots.skill) * 0.08 * rngSigned(mem);
    if (p.action.type === 'swing_charge') {
      const release = pred.t <= s.swingLead + skillErr || p.action.t > s.chargeTime + s.holdTime + 0.3;
      input.primary = !release;
    } else if (p.action.type === 'none' && p.vel.y > -1 && pred.dist < 1.6) {
      input.primary = true;
    } else if (p.action.type === 'none' && pred.dist >= 1.6 && pred.t > 0.15) {
      input.primary = true;
    }
    return;
  }
  // landed without hitting: try to play it as a free ball
  mem.jumped = false;
  setBall(state, p, mem, input, reacting, V.v3(-side * 5.5, 0, 0), 1.0);
}

function defend(state: GameState, p: PlayerState, mem: BotMemory, input: InputFrame): void {
  const side = teamSide(state, p.team);
  const ball = state.ball;
  const mate = state.players.find((o) => o.team === p.team && o.id !== p.id && o.active);
  const opps = state.players.filter((o) => o.team !== p.team && o.active);
  // the player nearer the net blocks
  const iBlock = !mate || Math.abs(p.pos.x) <= Math.abs(mate.pos.x) + 0.01 && !(Math.abs(p.pos.x) === Math.abs(mate.pos.x) && p.id > mate.id);
  // likely attacker: airborne opponent or the one closest to the ball's landing on their side
  let attacker: PlayerState | undefined;
  for (const o of opps) if (!o.grounded && Math.abs(o.pos.x) < 4) attacker = o;
  if (!attacker) {
    let best = Infinity;
    for (const o of opps) {
      const d = V.distXZ(o.pos, ball.pos);
      if (d < best) {
        best = d;
        attacker = o;
      }
    }
  }
  const oppTouchesNow = state.touchTeam !== p.team && state.touchTeam >= 0 ? state.touches : 0;
  if (oppTouchesNow >= 1 && !attacker?.grounded === false) {
    // the hitter is the opponent who did not make the last touch
    const other = opps.find((o) => o.id !== ball.lastToucher);
    if (other && (ball.lastTouchTeam !== p.team)) attacker = other;
  }
  let attackZ = attacker ? V.clamp(attacker.pos.z, -3.5, 3.5) : 0;
  if (oppTouchesNow >= 2 && ball.vel.y !== 0) {
    // the set is up: the hit comes from where it lands at hitting height
    const landSet = landingAt(state, 2.9);
    if (landSet.time < 90 && !landSet.hitNet) attackZ = V.clamp(landSet.pos.z, -3.5, 3.5);
  }
  if (iBlock) {
    const spot = V.v3(side * 0.6, 0, attackZ);
    moveTo(input, p, spot, 2.0);
    setAim(input, eyePos(p), V.v3(-side * 3, 1.0, attackZ), mem);
    input.pitch = -0.35; // press over
    const oppTouches = state.touchTeam !== p.team ? state.touches : 0;
    const threat = attacker && !attacker.grounded && (attacker.action.type === 'swing_charge' || attacker.action.type === 'none') && Math.abs(attacker.pos.x) < 3.5;
    const setUp = oppTouches >= 2 && ball.pos.y > 2.6 && Math.abs(ball.pos.x) < 3.5;
    if (!mem.holdBlock && p.grounded && (threat || setUp) && p.stamina > 10 && V.distXZ(p.pos, spot) < 1.0) {
      mem.holdBlock = true;
      mem.blockStart = state.time;
    }
    if (mem.holdBlock) {
      const held = state.time - mem.blockStart;
      const attackerNearApex = attacker && !attacker.grounded && attacker.vel.y < 1.8;
      const release = (attackerNearApex && held > 0.12) || held > 0.9 || (!threat && held > 0.4 && ball.pos.y < 2.4);
      input.block = !release;
      if (release) mem.holdBlock = false;
    }
    return;
  }
  // deep defender: cover the side opposite the blocker
  const z = attackZ > 0 ? -1.4 : 1.4;
  const spot = V.v3(side * 5.6, 0, V.clamp(z + attackZ * 0.3, -3, 3));
  moveTo(input, p, spot, 2.5);
  setAim(input, eyePos(p), ball.pos, mem);
}
