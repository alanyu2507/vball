import type { Vec3 } from './vec';

/** Everything the sim knows about a controller's intent for one tick. */
export interface InputFrame {
  /** World-space movement vector, length <= 1. */
  moveX: number;
  moveZ: number;
  /** Absolute aim angles. Yaw around Y (0 = +X), pitch up positive. */
  yaw: number;
  pitch: number;
  sprint: boolean;
  jump: boolean;
  primary: boolean; // LMB: spike / bump / dig / underhand serve
  secondary: boolean; // RMB: set / float serve
  tip: boolean; // Q
  block: boolean; // F
  attackType: AttackType;
  reset: boolean; // training reset
}

export const enum AttackType {
  Straight = 0,
  Roll = 1,
  Float = 2,
}

export function emptyInput(): InputFrame {
  return {
    moveX: 0,
    moveZ: 0,
    yaw: 0,
    pitch: 0,
    sprint: false,
    jump: false,
    primary: false,
    secondary: false,
    tip: false,
    block: false,
    attackType: AttackType.Straight,
    reset: false,
  };
}

export type ActionType =
  | 'none'
  | 'swing_charge' // airborne, holding LMB
  | 'swing' // released, arm coming through
  | 'tip_charge'
  | 'tip'
  | 'set_charge'
  | 'set'
  | 'bump_charge'
  | 'plant' // penultimate step: hop, hold Space, jump on release
  | 'bump'
  | 'dig'
  | 'dive'
  | 'prone'
  | 'block_charge'
  | 'block'
  | 'serve_charge'
  | 'toss';

export interface ActionState {
  type: ActionType;
  /** Seconds in the current action. */
  t: number;
  /** 0..1 charge for charge actions, or quality for finished ones. */
  charge: number;
  /** Set when a release has happened before the ball is in reach (buffered action). */
  buffered: number;
  /** For swings: the computed timing error (seconds, + = late). */
  timing: number;
  /** Secondary flag: dive block side, tip vs swing, serve kind. */
  variant: number;
  /** Whether the current action has already produced a ball contact. */
  contacted: boolean;
}

export interface PlayerState {
  id: number;
  team: 0 | 1;
  pos: Vec3; // feet position
  vel: Vec3;
  yaw: number; // aim yaw
  pitch: number; // aim pitch
  facing: number; // body yaw, lags aim and movement
  grounded: boolean;
  stamina: number;
  sprintTime: number; // continuous sprint seconds
  jumpHeight: number; // height of the current jump (for anim / HUD)
  action: ActionState;
  attackType: AttackType;
  lastContactTick: number;
  primaryPressedTick: number; // for dig timing
  digGraceTick: number; // tick of the last uncontrolled body contact
  digGracePop: Vec3; // the controlled-dig velocity that a late press blends toward
  prevInput: InputFrame;
  isServer: boolean;
  active: boolean; // inactive players are parked off court (training)
  touchesThisRally: number;
  /** Visual: last contact quality label index into RATINGS. */
  lastRating: number;
}

export const RATINGS = ['Perfect', 'Good', 'Early', 'Late', 'Shank', 'Body', 'Whiff', 'Double', 'Tool'] as const;

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  spin: Vec3; // angular velocity rad/s
  held: number; // -1 or holder player index (server holding before toss/serve)
  knuckle: Vec3; // current knuckle acceleration direction
  knuckleTimer: number;
  floating: boolean; // float mode on (knuckle enabled)
  lastTouchTeam: number; // -1 none
  lastToucher: number; // -1 none
  lastTouchWasBlock: boolean;
  /** Ticks since the ball last touched something (watchdog). */
  idleTime: number;
  /** For rendering: squash impulse. */
  speedAtContact: number;
  touchedNet: boolean;
  grounded: boolean;
}

export type Phase = 'serve' | 'rally' | 'point' | 'gameover' | 'training';

export type ContactKind = 'spike' | 'roll' | 'float' | 'tip' | 'set' | 'bump' | 'dig' | 'body' | 'block' | 'serve' | 'toss';

export interface SimEvent {
  type:
    | 'contact'
    | 'landing'
    | 'point'
    | 'whistle'
    | 'jump'
    | 'land'
    | 'dive'
    | 'net'
    | 'bounce'
    | 'rating'
    | 'serve'
    | 'switch'
    | 'gameover'
    | 'fault'
    | 'drill';
  pos: Vec3;
  player: number; // -1 for none
  /** 0..1 strength / quality */
  power: number;
  kind?: ContactKind;
  rating?: number; // index into RATINGS
  perfect?: boolean;
  team?: number;
  text?: string;
  value?: number;
}

export type DrillType = 'none' | 'spike' | 'set' | 'receive' | 'dig' | 'free';

export interface DrillStats {
  attempts: number;
  hits: number; // in-court kills / on-target
  totalScore: number; // sum of quality scores
  lastScore: number;
  lastText: string;
  bestPower: number;
  avgHeight: number;
  heightSamples: number;
  log: string[];
}

export interface TrainingState {
  drill: DrillType;
  timer: number; // seconds until the machine feeds the next ball
  awaitingResult: boolean;
  resultTimer: number;
  stats: DrillStats;
  // Machine params (also in CONFIG for the panel but mirrored here per drill)
  feedX: number;
  feedZ: number;
  feedHeight: number;
  feedTightness: number; // distance from the net the set lands
  serveKind: number; // 0 float 1 topspin 2 random
  spikeSpeed: number;
  spikeSpread: number;
  targetX: number;
  targetZ: number;
  lastContactKind: ContactKind | 'none';
  lastContactRating: number;
  lastContactPower: number;
  playerTouched: boolean;
  debugTrajectory: boolean;
  maxHeightAfterTouch: number;
  landedOnce: boolean;
  feedTime: number;
  /** Spike drill: 0 idle, 1 pass in flight to the setter, 2 set in flight to the hitter. */
  feedStage: number;
  /** Spike drill: where the (random) passer stood for the current feed. */
  passerPos: Vec3;
}

export interface GameState {
  tick: number;
  time: number; // sim seconds
  rng: number;
  phase: Phase;
  phaseTimer: number;
  players: PlayerState[];
  ball: BallState;
  score: [number, number];
  servingTeam: 0 | 1;
  serverIndex: [number, number]; // which player (0/1 within team) serves next for each team
  touches: number;
  touchTeam: number; // -1 none
  swapped: boolean; // sides swapped
  message: string;
  messageTimer: number;
  rallyLength: number; // contacts this rally
  stats: {
    rallies: number;
    longestRally: number;
    totalContacts: number;
    kills: number;
    aces: number;
    faults: number;
  };
  training: TrainingState;
  /** Per-tick events for the presentation layer. Cleared every tick. */
  events: SimEvent[];
  /** Index of the human player, -1 for none. */
  human: number;
  seed: number;
}

/** Side sign for a team: -1 means the team plays on negative X. */
export function teamSide(state: GameState, team: number): number {
  const base = team === 0 ? -1 : 1;
  return state.swapped ? -base : base;
}
