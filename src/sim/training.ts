import { CONFIG } from '../config';
import { predictBall, velocityForApexDrag, solveLaunch, topspinFor } from './ball';
import { rngRange, rngNext } from './rng';
import type { DrillStats, DrillType, GameState, InputFrame, PlayerState, TrainingState } from './types';
import { RATINGS, teamSide } from './types';
import * as V from './vec';

export function emptyStats(): DrillStats {
  return { attempts: 0, hits: 0, totalScore: 0, lastScore: 0, lastText: '', bestPower: 0, avgHeight: 0, heightSamples: 0, log: [] };
}

export function createTrainingState(): TrainingState {
  return {
    drill: 'none',
    timer: 0,
    awaitingResult: false,
    resultTimer: 0,
    stats: emptyStats(),
    feedX: 1.0, // setter stands next to the net
    feedZ: 0.5,
    feedHeight: 5.2, // apex height of the set (m)
    feedTightness: 1.2, // how far off the net the set comes down
    serveKind: 2,
    spikeSpeed: 17,
    spikeSpread: 1.5,
    targetX: 6.0,
    targetZ: -2.5,
    lastContactKind: 'none',
    lastContactRating: -1,
    lastContactPower: 0,
    playerTouched: false,
    debugTrajectory: true,
    maxHeightAfterTouch: 0,
    landedOnce: false,
    feedTime: 0,
    feedStage: 0,
    passerPos: V.v3(),
  };
}

/** The human's teammate (the setter in the spike drill). */
function teammate(state: GameState): PlayerState | undefined {
  const human = state.players[state.human];
  return state.players.find((p) => p.team === human.team && p.id !== human.id);
}

/** Where the setter stands in the spike drill. */
function setterSpot(state: GameState): V.Vec3 {
  const human = state.players[state.human];
  const side = teamSide(state, human.team);
  return V.v3(side * state.training.feedX, 0, state.training.feedZ);
}

/** Where the spike-drill set should come down. */
function setTarget(state: GameState): V.Vec3 {
  const human = state.players[state.human];
  const side = teamSide(state, human.team);
  return V.v3(side * state.training.feedTightness, 2.9, V.clamp(human.pos.z, -3, 3));
}

/** The setter plays the ball from where it is now toward the hitter. */
function setterSets(state: GameState, setter: PlayerState | undefined): void {
  const t = state.training;
  const ball = state.ball;
  const target = setTarget(state);
  ball.vel = velocityForApexDrag(ball.pos, target, Math.max(0.3, t.feedHeight - target.y));
  ball.spin = V.v3();
  ball.lastToucher = setter ? setter.id : -1;
  ball.lastTouchTeam = setter ? setter.team : -1;
  t.feedStage = 2;
  if (setter) {
    setter.action = { type: 'set', t: 0, charge: 0.6, buffered: 0, timing: 0, variant: 0, contacted: true };
    state.events.push({ type: 'contact', pos: V.copy(ball.pos), player: setter.id, power: 0.4, kind: 'set', rating: 0 });
  }
}

/** Enter a drill: park the bots, place the human on their side. */
export function startDrill(state: GameState, drill: DrillType): void {
  const t = state.training;
  t.drill = drill;
  t.stats = emptyStats();
  t.awaitingResult = false;
  t.timer = 1.0;
  state.phase = 'training';
  state.message = '';
  state.score = [0, 0];
  const human = state.players[state.human];
  const side = teamSide(state, human.team);
  for (const p of state.players) {
    p.active = p.id === state.human;
    p.vel = V.v3();
    p.action = { type: 'none', t: 0, charge: 0, buffered: 0, timing: 0, variant: 0, contacted: false };
    p.grounded = true;
    p.pos.y = 0;
    p.isServer = false;
    if (!p.active) {
      p.pos.x = teamSide(state, p.team) * 12;
      p.pos.z = 9;
    }
  }
  const spots: Record<DrillType, V.Vec3> = {
    none: V.v3(side * 5, 0, 0),
    spike: V.v3(side * 4.0, 0, -1.5),
    set: V.v3(side * 2.2, 0, 0.5),
    receive: V.v3(side * 5.5, 0, 0),
    dig: V.v3(side * 5.0, 0, 0.5),
    free: V.v3(side * 4.5, 0, 0),
  };
  human.pos = V.copy(spots[drill]);
  human.yaw = side < 0 ? 0 : Math.PI;
  human.facing = human.yaw;
  t.feedStage = 0;
  if (drill === 'spike') {
    // the teammate stands at the net as the setter
    const mate = teammate(state);
    if (mate) {
      mate.active = true;
      mate.pos = setterSpot(state);
      mate.yaw = mate.facing = Math.atan2(human.pos.z - mate.pos.z, human.pos.x - mate.pos.x);
    }
  }
  const ball = state.ball;
  ball.held = -1;
  ball.pos = V.v3(side * 6, 3, 2);
  ball.vel = V.v3();
  ball.spin = V.v3();
  ball.floating = false;
  ball.lastToucher = -1;
  ball.lastTouchTeam = -1;
  state.touches = 0;
  state.touchTeam = -1;
}

export function exitTraining(state: GameState): void {
  state.training.drill = 'none';
  for (const p of state.players) p.active = true;
}

function pushLog(t: TrainingState, text: string): void {
  t.stats.log.unshift(text);
  if (t.stats.log.length > 6) t.stats.log.pop();
  t.stats.lastText = text;
}

function record(state: GameState, score: number, maxScore: number, text: string): void {
  const t = state.training;
  t.stats.attempts++;
  t.stats.totalScore += score;
  t.stats.lastScore = score;
  if (score >= maxScore * 0.66) t.stats.hits++;
  pushLog(t, text);
  state.events.push({ type: 'drill', pos: V.copy(state.ball.pos), player: state.human, power: score / maxScore, text });
  t.awaitingResult = false;
  t.resultTimer = 1.6;
}

/** Feed a ball according to the drill. */
export function feed(state: GameState): void {
  const t = state.training;
  const human = state.players[state.human];
  const side = teamSide(state, human.team);
  const ball = state.ball;
  ball.held = -1;
  ball.spin = V.v3();
  ball.floating = false;
  ball.lastToucher = -1;
  ball.lastTouchTeam = -1;
  ball.lastTouchWasBlock = false;
  ball.grounded = false;
  ball.idleTime = 0;
  ball.touchedNet = false;
  t.playerTouched = false;
  t.lastContactKind = 'none';
  t.lastContactRating = -1;
  t.maxHeightAfterTouch = 0;
  t.landedOnce = false;
  state.touches = 0;
  state.touchTeam = -1;
  state.rallyLength = 0;
  switch (t.drill) {
    case 'spike': {
      // stage 1: a passer at a random spot on our side bumps the ball up to the setter's hands;
      // stage 2 (in stepTraining): the setter sets it toward the hitter
      const setter = setterSpot(state);
      let from = V.v3();
      for (let i = 0; i < 8; i++) {
        from = V.v3(side * rngRange(state, 4.5, 7.5), CONFIG.bump.platformHeight, rngRange(state, -3.5, 3.5));
        if (V.distXZ(from, human.pos) > 1.8) break;
      }
      t.passerPos = V.v3(from.x, 0, from.z);
      const hands = V.v3(setter.x, CONFIG.set.handHeight + 0.2, setter.z);
      ball.pos = from;
      ball.vel = velocityForApexDrag(from, hands, 1.6);
      t.feedStage = 1;
      break;
    }
    case 'set': {
      const from = V.v3(side * t.feedX, 1.2, t.feedZ);
      const target = V.v3(human.pos.x, 2.4, human.pos.z);
      ball.pos = from;
      ball.vel = velocityForApexDrag(from, target, Math.max(0.5, t.feedHeight - 2.4));
      break;
    }
    case 'receive': {
      const from = V.v3(-side * 8.6, 2.1, rngRange(state, -2, 2));
      const spread = t.spikeSpread;
      const target = V.v3(human.pos.x + rngRange(state, -spread, spread) * 0.6, CONFIG.ball.radius, human.pos.z + rngRange(state, -spread, spread));
      let kind = t.serveKind;
      if (kind === 2) kind = rngNext(state) < 0.5 ? 0 : 1;
      ball.pos = from;
      if (kind === 0) {
        const res = solveLaunch(from, target, rngRange(state, 15, 18.5), 0, 0, 'low', -0.3, 1.0);
        ball.vel = res.vel;
        ball.floating = true;
        ball.knuckleTimer = 0;
      } else {
        from.y = 3.1;
        ball.pos = from;
        const res = solveLaunch(from, target, rngRange(state, 19, 23), 35, 0, 'low', -0.6, 0.6);
        ball.vel = res.vel;
        ball.spin = topspinFor(V.v3(res.vel.x, 0, res.vel.z), 35);
      }
      break;
    }
    case 'dig': {
      const from = V.v3(-side * 2.4, 3.05, rngRange(state, -2.5, 2.5));
      const spread = t.spikeSpread;
      const target = V.v3(human.pos.x + rngRange(state, -spread, spread) * 0.5, CONFIG.ball.radius, human.pos.z + rngRange(state, -spread, spread));
      ball.pos = from;
      const res = solveLaunch(from, target, t.spikeSpeed, 20, 0, 'low', -1.2, 0.4);
      ball.vel = res.vel;
      ball.spin = topspinFor(V.v3(res.vel.x, 0, res.vel.z), 20);
      break;
    }
    case 'free': {
      ball.pos = V.v3(human.pos.x, 1.5, human.pos.z);
      ball.vel = V.v3(side * 0.6, 7.5, 0);
      break;
    }
  }
  t.awaitingResult = true;
  t.feedTime = state.time;
}

function passQuality(state: GameState): { q: number; text: string } {
  // judge where the ball lands relative to the ideal setter target on the human's side
  const human = state.players[state.human];
  const side = teamSide(state, human.team);
  const ball = state.ball;
  const t = state.training;
  const setterSpot = V.v3(side * 2.2, 0, 0);
  const d = V.distXZ(ball.pos, setterSpot);
  const onSide = Math.sign(ball.pos.x) === side && Math.abs(ball.pos.x) < 8.5 && Math.abs(ball.pos.z) < 4.5;
  const h = t.maxHeightAfterTouch;
  if (!t.playerTouched) return { q: 0, text: 'Missed (0)' };
  if (!onSide) return { q: 0, text: 'Over / out (0)' };
  if (h < 2.0) return { q: 1, text: `Low pass (1) h=${h.toFixed(1)}m` };
  if (d < 1.2) return { q: 3, text: `Perfect pass (3) ${d.toFixed(1)}m off` };
  if (d < 2.6) return { q: 2, text: `Good pass (2) ${d.toFixed(1)}m off` };
  return { q: 1, text: `Playable (1) ${d.toFixed(1)}m off` };
}

export function stepTraining(state: GameState, inputs: InputFrame[], dt: number): void {
  const t = state.training;
  const human = state.players[state.human];
  const side = teamSide(state, human.team);
  const ball = state.ball;
  const input = inputs[state.human];
  const landedNow = state.events.some((e) => e.type === 'landing');

  if (input.reset && !human.prevInput.reset) {
    t.stats = emptyStats();
    t.awaitingResult = false;
    t.timer = 0.3;
    state.message = 'Reset';
    state.messageTimer = 1;
  }

  if (t.awaitingResult && t.playerTouched) t.maxHeightAfterTouch = Math.max(t.maxHeightAfterTouch, ball.pos.y);

  if (t.drill === 'free') {
    // free play: reset key re-tosses the ball, nothing is scored
    if (landedNow && ball.vel.y < 0.5) t.landedOnce = true;
    if (ball.pos.y < 0.3 && V.len(ball.vel) < 0.3 && state.time - t.feedTime > 2) {
      t.timer -= dt;
      if (t.timer <= 0) {
        feed(state);
        t.timer = 0.5;
      }
    }
    return;
  }

  if (!t.awaitingResult) {
    if (t.resultTimer > 0) t.resultTimer -= dt;
    else {
      t.timer -= dt;
      if (t.timer <= 0) {
        feed(state);
        t.timer = 1.8;
      }
    }
    return;
  }

  // waiting for the outcome of the current feed
  const elapsed = state.time - t.feedTime;
  const timeout = elapsed > 8;
  switch (t.drill) {
    case 'spike': {
      const setter = teammate(state);
      if (setter && setter.active) {
        // the setter keeps facing the hitter (idle players get no aim input)
        setter.facing = setter.yaw = Math.atan2(human.pos.z - setter.pos.z, human.pos.x - setter.pos.x);
      }
      if (t.feedStage === 1) {
        const spot = setterSpot(state);
        const handsY = CONFIG.set.handHeight + 0.2;
        const arrived = ball.vel.y < 0 && ball.pos.y <= handsY + 0.05 && V.distXZ(ball.pos, spot) < 0.9;
        if (arrived || elapsed > 3) setterSets(state, setter);
        break;
      }
      if (landedNow || timeout || (ball.touchedNet && ball.pos.y < 1.5 && Math.sign(ball.pos.x) === side)) {
        if (!t.playerTouched) {
          record(state, 0, 3, 'No contact (0)');
          break;
        }
        const inCourt = Math.abs(ball.pos.x) <= 8 + 0.06 && Math.abs(ball.pos.z) <= 4 + 0.06;
        const onOpp = Math.sign(ball.pos.x) === -side;
        const target = V.v3(-side * t.targetX, 0, t.targetZ);
        const dTarget = V.distXZ(ball.pos, target);
        const rating = t.lastContactRating >= 0 ? RATINGS[t.lastContactRating] : '-';
        const power = t.lastContactPower;
        t.stats.bestPower = Math.max(t.stats.bestPower, power);
        if (ball.touchedNet && !onOpp) record(state, 0, 3, `Net (0) ${rating}`);
        else if (!inCourt || !onOpp) record(state, 0, 3, `Out (0) ${rating} pow ${(power * 100).toFixed(0)}%`);
        else if (dTarget < 1.5) record(state, 3, 3, `On target! (3) ${rating} pow ${(power * 100).toFixed(0)}%`);
        else if (dTarget < 3) record(state, 2, 3, `Kill, near target (2) ${rating} pow ${(power * 100).toFixed(0)}%`);
        else record(state, 1, 3, `Kill (1) ${rating} pow ${(power * 100).toFixed(0)}%`);
      }
      break;
    }
    case 'set': {
      if (landedNow || timeout) {
        if (!t.playerTouched) {
          record(state, 0, 3, 'No contact (0)');
          break;
        }
        const target = V.v3(side * t.targetX, 0, t.targetZ);
        const d = V.distXZ(ball.pos, target);
        const h = t.maxHeightAfterTouch;
        t.stats.avgHeight = (t.stats.avgHeight * t.stats.heightSamples + h) / (t.stats.heightSamples + 1);
        t.stats.heightSamples++;
        const rating = t.lastContactRating >= 0 ? RATINGS[t.lastContactRating] : '-';
        if (t.lastContactRating === 7) record(state, 0, 3, 'Double contact (0)');
        else if (d < 0.7) record(state, 3, 3, `Dime (3) ${d.toFixed(2)}m, apex ${h.toFixed(1)}m ${rating}`);
        else if (d < 1.5) record(state, 2, 3, `Hittable (2) ${d.toFixed(2)}m, apex ${h.toFixed(1)}m ${rating}`);
        else if (d < 3) record(state, 1, 3, `Loose (1) ${d.toFixed(2)}m, apex ${h.toFixed(1)}m`);
        else record(state, 0, 3, `Off (0) ${d.toFixed(1)}m`);
      }
      break;
    }
    case 'receive':
    case 'dig': {
      if (landedNow || timeout) {
        const r = passQuality(state);
        const rating = t.lastContactRating >= 0 ? RATINGS[t.lastContactRating] : '';
        record(state, r.q, 3, `${r.text} ${rating}`);
      }
      break;
    }
  }
}

/** Debug: predicted path of the current ball for the renderer. */
export function debugPath(state: GameState): V.Vec3[] {
  const path: V.Vec3[] = [];
  const b = state.ball;
  if (b.held >= 0) return path;
  predictBall(b.pos, b.vel, b.spin, { path, maxTime: 4, net: true });
  return path;
}
