import { CONFIG } from '../config';
import type { GameState, PlayerState } from './types';
import { teamSide } from './types';
import * as V from './vec';

/**
 * Register a ball contact by a player. Handles touch counting and contact faults.
 * Returns false when the contact is a continuation of the same touch (cooldown).
 */
export function registerTouch(state: GameState, p: PlayerState, isBlock: boolean): boolean {
  const ball = state.ball;
  const dt = CONFIG.sim.TIME_SCALE / CONFIG.sim.TICK_RATE;
  const cooldownTicks = Math.round(CONFIG.rules.sameTouchCooldown / dt);
  if (ball.lastToucher === p.id && state.tick - p.lastContactTick < cooldownTicks) {
    p.lastContactTick = state.tick;
    return false;
  }
  const wasServe = state.phase === 'serve';
  if (wasServe) {
    state.phase = 'rally';
    state.phaseTimer = 0;
  }
  ball.idleTime = 0;
  ball.touchedNet = false;
  const inRally = state.phase === 'rally';
  if (isBlock) {
    if (state.touchTeam !== p.team) {
      state.touchTeam = p.team;
      state.touches = 0;
    }
    ball.lastTouchTeam = p.team;
    ball.lastToucher = p.id;
    ball.lastTouchWasBlock = true;
  } else {
    const samePlayerAgain = ball.lastToucher === p.id && !ball.lastTouchWasBlock && state.touchTeam === p.team && !wasServe;
    if (state.touchTeam === p.team) state.touches++;
    else {
      state.touchTeam = p.team;
      state.touches = 1;
    }
    ball.lastTouchTeam = p.team;
    ball.lastToucher = p.id;
    ball.lastTouchWasBlock = false;
    if (inRally && samePlayerAgain) {
      awardPoint(state, (1 - p.team) as 0 | 1, 'Double touch');
    } else if (inRally && state.touches > CONFIG.rules.touchesPerSide) {
      awardPoint(state, (1 - p.team) as 0 | 1, 'Four touches');
    }
  }
  p.lastContactTick = state.tick;
  p.touchesThisRally++;
  state.rallyLength++;
  state.stats.totalContacts++;
  return true;
}

export function teamName(t: number): string {
  return t === 0 ? 'Red' : 'Blue';
}

export function awardPoint(state: GameState, winner: 0 | 1, reason: string): void {
  if (state.phase !== 'rally' && state.phase !== 'serve') return;
  if (state.training.drill !== 'none') {
    // training: no scoring, just a message
    state.message = reason;
    state.messageTimer = 1.5;
    return;
  }
  state.score[winner]++;
  state.phase = 'point';
  state.phaseTimer = 0;
  state.message = `${teamName(winner)} point: ${reason}`;
  state.messageTimer = CONFIG.rules.pointPause;
  state.stats.rallies++;
  state.stats.longestRally = Math.max(state.stats.longestRally, state.rallyLength);
  if (reason === 'Kill') state.stats.kills++;
  if (reason === 'Ace') state.stats.aces++;
  if (reason !== 'Kill' && reason !== 'Ace') state.stats.faults++;
  if (winner !== state.servingTeam) {
    state.servingTeam = winner;
    state.serverIndex[winner] = 1 - state.serverIndex[winner];
  }
  state.events.push({ type: 'point', pos: V.copy(state.ball.pos), player: -1, power: 1, team: winner, text: state.message });
  state.events.push({ type: 'whistle', pos: V.copy(state.ball.pos), player: -1, power: 1 });
  const r = CONFIG.rules;
  const [a, b] = state.score;
  const lead = Math.abs(a - b);
  if ((a >= r.pointsToWin || b >= r.pointsToWin) && lead >= r.winBy) {
    state.phase = 'gameover';
    state.message = `${teamName(a > b ? 0 : 1)} wins ${Math.max(a, b)}-${Math.min(a, b)}`;
    state.events.push({ type: 'gameover', pos: V.v3(), player: -1, power: 1, team: a > b ? 0 : 1, text: state.message });
  }
}

/** Judge a landing during a live ball. */
export function judgeLanding(state: GameState): void {
  const ball = state.ball;
  const c = CONFIG.court;
  const tol = CONFIG.ball.radius * 0.6; // touching the line is in
  const inX = Math.abs(ball.pos.x) <= c.length / 2 + tol;
  const inZ = Math.abs(ball.pos.z) <= c.width / 2 + tol;
  const landedSide = ball.pos.x < 0 ? -1 : 1;
  const teamOnSide = (teamSide(state, 0) === landedSide ? 0 : 1) as 0 | 1;
  if (state.phase === 'serve') {
    // tossed ball that was never hit
    awardPoint(state, (1 - state.servingTeam) as 0 | 1, 'Service error');
    return;
  }
  if (inX && inZ) {
    const winner = (1 - teamOnSide) as 0 | 1;
    let reason = 'Kill';
    if (ball.lastTouchTeam === teamOnSide) reason = ball.touchedNet ? 'Into the net' : 'Dropped on own side';
    else if (state.rallyLength <= 1) reason = 'Ace';
    awardPoint(state, winner, reason);
  } else {
    const loser = ball.lastTouchTeam >= 0 ? ball.lastTouchTeam : teamOnSide;
    awardPoint(state, (1 - loser) as 0 | 1, 'Out');
  }
}

/** Place everyone for the next serve. */
export function setupServe(state: GameState, pendingSwitch: boolean): void {
  if (pendingSwitch) {
    state.swapped = !state.swapped;
    state.events.push({ type: 'switch', pos: V.v3(), player: -1, power: 1 });
    state.message = 'Switch sides';
    state.messageTimer = 1.5;
  }
  const ball = state.ball;
  const servingTeam = state.servingTeam;
  const sIdx = state.serverIndex[servingTeam];
  const half = CONFIG.court.length / 2;
  for (const p of state.players) {
    const side = teamSide(state, p.team);
    const idxInTeam = p.id % 2;
    p.isServer = false;
    p.vel = V.v3();
    p.action = { type: 'none', t: 0, charge: 0, buffered: 0, timing: 0, variant: 0, contacted: false };
    p.grounded = true;
    p.pos.y = 0;
    p.sprintTime = 0;
    p.touchesThisRally = 0;
    p.digGraceTick = -1;
    const faceYaw = side < 0 ? 0 : Math.PI;
    if (p.team === servingTeam) {
      if (idxInTeam === sIdx) {
        p.isServer = true;
        p.pos.x = side * (half + 0.8);
        p.pos.z = -side * 1.2;
        ball.held = p.id;
      } else {
        p.pos.x = side * 2.6;
        p.pos.z = side * 1.6;
      }
    } else {
      p.pos.x = side * 5.6;
      p.pos.z = idxInTeam === 0 ? -2.0 : 2.0;
    }
    p.yaw = faceYaw;
    p.facing = faceYaw;
    p.pitch = 0;
    p.lastContactTick = -1000;
    p.primaryPressedTick = -1000;
  }
  ball.vel = V.v3();
  ball.spin = V.v3();
  ball.floating = false;
  ball.lastToucher = -1;
  ball.lastTouchTeam = -1;
  ball.lastTouchWasBlock = false;
  ball.idleTime = 0;
  ball.touchedNet = false;
  ball.grounded = false;
  state.touches = 0;
  state.touchTeam = -1;
  state.rallyLength = 0;
  state.phase = 'serve';
  state.phaseTimer = 0;
}

/** Phase timers, landing judgement, watchdogs. Call after physics. */
export function stepRules(state: GameState, dt: number): void {
  state.phaseTimer += dt;
  if (state.messageTimer > 0) state.messageTimer -= dt;
  if (state.training.drill !== 'none') return;
  const ball = state.ball;
  switch (state.phase) {
    case 'serve':
    case 'rally': {
      const landed = state.events.some((e) => e.type === 'landing');
      if (landed) judgeLanding(state);
      else if (state.phase === 'rally' && ball.idleTime > CONFIG.rules.rallyWatchdog) {
        awardPoint(state, (1 - Math.max(0, ball.lastTouchTeam)) as 0 | 1, 'Dead ball');
      } else if (state.phase === 'serve' && state.phaseTimer > 20 && ball.held >= 0) {
        // server never served (bot stuck): force a reset of the serve phase
        setupServe(state, false);
      }
      break;
    }
    case 'point': {
      if (state.phaseTimer >= CONFIG.rules.pointPause) {
        const total = state.score[0] + state.score[1];
        const sw = total > 0 && total % CONFIG.rules.switchEvery === 0;
        setupServe(state, sw);
      }
      break;
    }
    case 'gameover':
      break;
  }
}
