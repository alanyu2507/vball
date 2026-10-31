import { CONFIG, simDt } from '../config';
import { collideBallWithPlayer, holdPos, stepPlayerActions } from './actions';
import { createBall, stepBall } from './ball';
import { createPlayer, stepPlayerMovement } from './player';
import { setupServe, stepRules } from './rules';
import { stepTraining, createTrainingState } from './training';
import type { GameState, InputFrame } from './types';

export function createState(seed: number, human = 0): GameState {
  const state: GameState = {
    tick: 0,
    time: 0,
    rng: seed >>> 0,
    phase: 'serve',
    phaseTimer: 0,
    players: [createPlayer(0, 0), createPlayer(1, 0), createPlayer(2, 1), createPlayer(3, 1)],
    ball: createBall(),
    score: [0, 0],
    servingTeam: 0,
    serverIndex: [0, 0],
    touches: 0,
    touchTeam: -1,
    swapped: false,
    message: '',
    messageTimer: 0,
    rallyLength: 0,
    stats: { rallies: 0, longestRally: 0, totalContacts: 0, kills: 0, aces: 0, faults: 0 },
    training: createTrainingState(),
    events: [],
    human,
    seed,
  };
  setupServe(state, false);
  return state;
}

/** Advance the simulation by one fixed tick. inputs[i] drives players[i]. */
export function stepSim(state: GameState, inputs: InputFrame[]): void {
  state.events = [];
  const dt = simDt();
  state.tick++;
  state.time += dt;

  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const input = inputs[i];
    if (!p.active) continue;
    stepPlayerMovement(state, p, input, dt);
    stepPlayerActions(state, p, input, dt);
  }

  const ball = state.ball;
  if (ball.held >= 0) {
    const holder = state.players[ball.held];
    ball.pos = holdPos(holder);
    ball.vel = { x: 0, y: 0, z: 0 };
  } else {
    stepBall(state, dt);
    for (const p of state.players) if (p.active) collideBallWithPlayer(state, p);
  }

  stepRules(state, dt);
  if (state.training.drill !== 'none') stepTraining(state, inputs, dt);

  for (let i = 0; i < state.players.length; i++) {
    state.players[i].prevInput = { ...inputs[i] };
  }
}

export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state));
}

export { CONFIG };
