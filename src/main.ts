/**
 * Browser entry: renders the sim with three.js and drives the human player
 * (players[state.human]) from mouse + keyboard. All other players idle
 * (bot AI is parked in parked/bots/).
 */
import * as THREE from 'three';
import GUI from 'lil-gui';
import { CONFIG, resetConfig } from './config';
import { createState, stepSim } from './sim/sim';
import { predictBall } from './sim/ball';
import { debugPath, exitTraining, startDrill } from './sim/training';
import { predictContactTiming, spikeZone } from './sim/actions';
import { blockHands, eyePos, forwardOf, idealContactPoint, platformPos, rightOf, setHandsPos, shoulderPos } from './sim/player';
import { AttackType, emptyInput, RATINGS, type DrillType, type GameState, type InputFrame, type PlayerState } from './sim/types';
import * as V from './sim/vec';
import type { Vec3 } from './sim/vec';

// ---------------------------------------------------------------- state
const state: GameState = createState(Date.now() >>> 0, 0);
const human = () => state.players[state.human];

/** Start a fresh match but keep the training settings (they are bound in the tuning panel). */
function newMatch(): void {
  const training = state.training;
  Object.assign(state, createState(Date.now() >>> 0, state.human));
  training.drill = 'none';
  state.training = training;
}

// ---------------------------------------------------------------- input
const keys = new Set<string>();
let yaw = human().yaw;
let pitch = 0;
let attackType: AttackType = AttackType.Straight;
let primary = false;
let secondary = false;
let resetQueued = false;
let locked = false;

const app = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;

overlay.addEventListener('click', () => app.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === app;
  overlay.classList.toggle('hidden', locked);
  if (!locked) {
    keys.clear();
    primary = secondary = false;
  }
});
document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  const s = CONFIG.camera.sensitivity;
  yaw += e.movementX * s;
  pitch = V.clamp(pitch - e.movementY * s, CONFIG.camera.pitchMin, CONFIG.camera.pitchMax);
});
document.addEventListener('mousedown', (e) => {
  if (!locked) return;
  if (e.button === 0) primary = true;
  if (e.button === 2) secondary = true;
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) primary = false;
  if (e.button === 2) secondary = false;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

const DRILL_KEYS: Record<string, DrillType> = { Digit5: 'spike', Digit6: 'set', Digit7: 'receive', Digit8: 'dig', Digit9: 'free' };
document.addEventListener('keydown', (e) => {
  if (e.code === 'F1') {
    e.preventDefault();
    gui.show(gui._hidden);
    return;
  }
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyR') resetQueued = true;
  if (e.code === 'Digit1') attackType = AttackType.Straight;
  if (e.code === 'Digit2') attackType = AttackType.Roll;
  if (e.code === 'Digit3') attackType = AttackType.Float;
  if (DRILL_KEYS[e.code]) startDrill(state, DRILL_KEYS[e.code]);
  if (e.code === 'Digit0' && state.training.drill !== 'none') {
    exitTraining(state);
    newMatch();
  }
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

function readInput(): InputFrame {
  const input = emptyInput();
  // camera-relative WASD, projected to the ground plane
  const fx = Math.cos(yaw);
  const fz = Math.sin(yaw);
  const rx = -fz;
  const rz = fx;
  let mx = 0;
  let mz = 0;
  if (keys.has('KeyW')) (mx += fx), (mz += fz);
  if (keys.has('KeyS')) (mx -= fx), (mz -= fz);
  if (keys.has('KeyD')) (mx += rx), (mz += rz);
  if (keys.has('KeyA')) (mx -= rx), (mz -= rz);
  const len = Math.hypot(mx, mz);
  if (len > 1) (mx /= len), (mz /= len);
  input.moveX = mx;
  input.moveZ = mz;
  input.yaw = yaw;
  input.pitch = pitch;
  input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  input.jump = keys.has('Space');
  input.primary = primary;
  input.secondary = secondary;
  input.tip = keys.has('KeyQ');
  input.block = keys.has('KeyF');
  input.attackType = attackType;
  input.reset = resetQueued;
  resetQueued = false;
  return input;
}

// ---------------------------------------------------------------- scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8ec5ff);
scene.fog = new THREE.Fog(0x8ec5ff, 40, 90);

const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, window.innerWidth / window.innerHeight, 0.1, 200);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

scene.add(new THREE.HemisphereLight(0xbfdfff, 0xc2a26a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(12, 20, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -16;
sun.shadow.camera.right = sun.shadow.camera.top = 16;
scene.add(sun);

const { length: L, width: W, netHeight, netWidth } = CONFIG.court;

// sand
const sand = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0xe3c58a, roughness: 1 }));
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

// court lines
const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
function line(x: number, z: number, sx: number, sz: number): void {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), lineMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.005, z);
  scene.add(m);
}
const lw = 0.08;
line(0, W / 2, L + lw, lw);
line(0, -W / 2, L + lw, lw);
line(L / 2, 0, lw, W);
line(-L / 2, 0, lw, W);

// net
const net = new THREE.Mesh(
  new THREE.PlaneGeometry(netWidth, 1.0),
  new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
);
net.rotation.y = Math.PI / 2;
net.position.set(0, netHeight - 0.5, 0);
scene.add(net);
const tape = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, netWidth), new THREE.MeshStandardMaterial({ color: 0xffffff }));
tape.position.set(0, netHeight, 0);
scene.add(tape);
for (const z of [-netWidth / 2, netWidth / 2]) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, netHeight + 0.3), new THREE.MeshStandardMaterial({ color: 0x444444 }));
  post.position.set(0, (netHeight + 0.3) / 2, z);
  post.castShadow = true;
  scene.add(post);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.0), new THREE.MeshStandardMaterial({ color: 0xff3333 }));
  antenna.position.set(0, netHeight + 0.5, z * (W / netWidth));
  scene.add(antenna);
}

// ball
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.ball.radius, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffe08a, roughness: 0.6 }));
ballMesh.castShadow = true;
scene.add(ballMesh);
const shadowBlob = new THREE.Mesh(new THREE.CircleGeometry(CONFIG.ball.radius, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
shadowBlob.rotation.x = -Math.PI / 2;
scene.add(shadowBlob);

// ---------------------------------------------------------------- players, arms and contact markers
const teamColors = [0x3a86ff, 0xff5a5f];
const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpD = new THREE.Vector3();

/** Place a unit cylinder so it spans a to b. */
function placeLimb(m: THREE.Mesh, a: Vec3, b: Vec3): void {
  tmpA.set(a.x, a.y, a.z);
  tmpB.set(b.x, b.y, b.z);
  tmpD.subVectors(tmpB, tmpA);
  const len = Math.max(0.01, tmpD.length());
  m.position.copy(tmpA).addScaledVector(tmpD, 0.5);
  m.scale.set(1, len, 1);
  m.quaternion.setFromUnitVectors(UP, tmpD.normalize());
}

interface Arm {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  hand: THREE.Mesh;
}
interface PlayerVisual {
  body: THREE.Mesh;
  nose: THREE.Mesh;
  right: Arm;
  left: Arm;
}

const ARM_UPPER = 0.48; // shoulder to elbow (m)
const ARM_LOWER = 0.48; // elbow to hand; long enough to reach the forward contact point
const HAND_R = 0.07;

function makeArm(color: number): Arm {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 1, 8), mat);
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 1, 8), mat);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(HAND_R, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf1c27d }));
  upper.castShadow = lower.castShadow = true;
  scene.add(upper, lower, hand);
  return { upper, lower, hand };
}

/** Two-bone arm: hand reaches toward `target`, elbow bends toward `bendDir`. */
function poseArm(arm: Arm, shoulder: Vec3, target: Vec3, bendDir: Vec3): void {
  let d = V.sub(target, shoulder);
  const reach = ARM_UPPER + ARM_LOWER;
  let len = V.len(d);
  if (len > reach - 0.005) {
    d = V.scale(d, (reach - 0.005) / len);
    len = reach - 0.005;
  }
  const hand = V.add(shoulder, d);
  // elbow: law of cosines on the shoulder-hand chord
  const half = len / 2;
  const a = Math.sqrt(Math.max(0, ARM_UPPER * ARM_UPPER - half * half));
  const dir = V.normalize(d);
  // bend direction perpendicular to the chord
  let perp = V.sub(bendDir, V.scale(dir, V.dot(bendDir, dir)));
  if (V.len(perp) < 1e-3) perp = V.v3(0, 0, 1);
  perp = V.normalize(perp);
  const elbow = V.add(V.add(shoulder, V.scale(dir, half)), V.scale(perp, a));
  placeLimb(arm.upper, shoulder, elbow);
  placeLimb(arm.lower, elbow, hand);
  arm.hand.position.set(hand.x, hand.y, hand.z);
}

const playerVisuals: PlayerVisual[] = state.players.map((p) => {
  const h = CONFIG.player.height;
  const r = CONFIG.player.capsuleRadius;
  const color = p.id === state.human ? 0xffffff : teamColors[p.team];
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, h - 2 * r, 4, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
  body.castShadow = true;
  scene.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 8), new THREE.MeshStandardMaterial({ color: teamColors[p.team] }));
  scene.add(nose);
  return { body, nose, right: makeArm(color), left: makeArm(color) };
});

// spike contact zone: the ideal contact point and the reach sphere around it
const reachSphere = new THREE.Mesh(
  new THREE.SphereGeometry(CONFIG.spike.reachRadius, 18, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd166, wireframe: true, transparent: true, opacity: 0.35 }),
);
const idealMarker = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
// equator of the zone: green above, orange below
const equator = new THREE.Mesh(
  new THREE.RingGeometry(CONFIG.spike.reachRadius - 0.015, CONFIG.spike.reachRadius + 0.015, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }),
);
equator.rotation.x = -Math.PI / 2;
scene.add(reachSphere, idealMarker, equator);
const ZONE_COLORS = { red: 0xff3b3b, green: 0x3dff6a, orange: 0xff9f1c } as const;

// where the ball will land
const landingRing = new THREE.Mesh(
  new THREE.RingGeometry(0.22, 0.3, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
);
landingRing.rotation.x = -Math.PI / 2;
landingRing.visible = false;
scene.add(landingRing);
// where the ball will be at its closest approach to the ideal point (predicted)
const predictMarker = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.ball.radius, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 }));
scene.add(predictMarker);
// spike drill: the passer who bumps the ball to the setter
const coach = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.22, 1.2, 4, 10),
  new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9, transparent: true, opacity: 0.8 }),
);
coach.position.y = 0.82;
coach.visible = false;
scene.add(coach);

// predicted ball path (drills, when training.debugTrajectory is on)
const PATH_MAX = 4 * 60 + 8; // predictBall: maxTime 4s at 60 steps/s, plus the start point
const pathGeom = new THREE.BufferGeometry();
const pathBuf = new Float32Array(PATH_MAX * 3);
pathGeom.setAttribute('position', new THREE.BufferAttribute(pathBuf, 3));
pathGeom.setDrawRange(0, 0);
const pathLine = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
pathLine.frustumCulled = false;
scene.add(pathLine);

let contactFlash = 0; // seconds the sphere stays green after a hit (red after a whiff)
let contactFlashColor = 0x00ff00;

/** Hand targets per action. Returns [rightHandTarget, leftHandTarget]. */
function handTargets(p: PlayerState): [Vec3, Vec3] {
  const f = forwardOf(p);
  const r = rightOf(p);
  const sh = shoulderPos(p);
  const shL = V.v3(p.pos.x - r.x * 0.2, p.pos.y + CONFIG.player.shoulderHeight, p.pos.z - r.z * 0.2);
  const a = p.action;
  const s = CONFIG.spike;
  const rest = (shoulder: Vec3, side: number): Vec3 => V.v3(shoulder.x + r.x * 0.12 * side, shoulder.y - 0.7, shoulder.z + r.z * 0.12 * side);
  const windup = V.v3(sh.x - f.x * 0.35 + r.x * 0.2, sh.y + 0.45, sh.z - f.z * 0.35 + r.z * 0.2);
  const balance = V.v3(shL.x + f.x * 0.45, shL.y + 0.55, shL.z + f.z * 0.45);
  switch (a.type) {
    case 'swing_charge':
      return [windup, balance];
    case 'swing': {
      const ideal = idealContactPoint(p);
      const through = V.v3(sh.x + f.x * 0.55, sh.y - 0.1, sh.z + f.z * 0.55);
      if (a.t < s.swingLead) return [V.lerp(windup, ideal, a.t / s.swingLead), balance];
      const k = Math.min(1, (a.t - s.swingLead) / Math.max(0.01, s.swingDuration - s.swingLead));
      return [V.lerp(ideal, through, k), V.lerp(balance, rest(shL, -1), k)];
    }
    case 'tip_charge':
    case 'tip':
      return [idealContactPoint(p), balance];
    case 'bump_charge':
    case 'bump':
    case 'dig':
    case 'dive':
    case 'prone': {
      const plat = platformPos(p);
      return [V.v3(plat.x + r.x * 0.05, plat.y, plat.z + r.z * 0.05), V.v3(plat.x - r.x * 0.05, plat.y, plat.z - r.z * 0.05)];
    }
    case 'set_charge':
    case 'set': {
      const hands = setHandsPos(p);
      return [V.v3(hands.x + r.x * 0.15, hands.y, hands.z + r.z * 0.15), V.v3(hands.x - r.x * 0.15, hands.y, hands.z - r.z * 0.15)];
    }
    case 'block_charge':
      return [V.v3(sh.x + f.x * 0.2, sh.y + 0.5, sh.z + f.z * 0.2), V.v3(shL.x + f.x * 0.2, shL.y + 0.5, shL.z + f.z * 0.2)];
    case 'block': {
      const [l, rr] = blockHands(p);
      return [rr, l];
    }
    case 'serve_charge':
    case 'toss':
      return [a.variant === 1 || a.type === 'toss' ? V.v3(sh.x + f.x * 0.2, sh.y + 0.7, sh.z + f.z * 0.2) : windup, V.v3(shL.x + f.x * 0.4, shL.y + 0.1, shL.z + f.z * 0.4)];
    default: {
      // in the air with no action: arms up a bit, ready
      if (!p.grounded) return [V.v3(sh.x + r.x * 0.15, sh.y + 0.3, sh.z + r.z * 0.15), V.v3(shL.x - r.x * 0.15, shL.y + 0.3, shL.z - r.z * 0.15)];
      return [rest(sh, 1), rest(shL, -1)];
    }
  }
}

// ---------------------------------------------------------------- HUD
const el = {
  score: document.getElementById('score')!,
  scoreSub: document.querySelector('#score small')!,
  message: document.getElementById('message')!,
  rating: document.getElementById('rating')!,
  status: document.getElementById('status')!,
  bar: document.querySelector('#bar div') as HTMLElement,
};
let ratingTimer = 0;

function updateHud(): void {
  const p = human();
  const t = state.training;
  if (t.drill !== 'none') {
    el.score.firstChild!.textContent = `${t.drill.toUpperCase()} DRILL`;
    const avg = t.stats.attempts ? (t.stats.totalScore / t.stats.attempts).toFixed(2) : '-';
    el.scoreSub.textContent = `${t.stats.hits}/${t.stats.attempts} good  avg ${avg}`;
  } else {
    el.score.firstChild!.textContent = `${state.score[0]} - ${state.score[1]}`;
    el.scoreSub.textContent = `${state.phase}  touches ${state.touches}  rally ${state.rallyLength}`;
  }
  el.message.textContent = state.messageTimer > 0 || state.phase === 'gameover' ? state.message : t.drill !== 'none' ? t.stats.lastText : '';
  el.rating.style.opacity = ratingTimer > 0 ? '1' : '0';
  const act = p.action;
  const attackName = ['straight', 'roll', 'float'][attackType];
  let swingLine = '';
  if (!p.grounded && act.type === 'none') {
    const z = spikeZone(p, state.ball.pos);
    const pred = predictContactTiming(p, state.ball.pos, state.ball.vel);
    const label = z.zone === 'green' ? 'GREEN full power' : z.zone === 'orange' ? `ORANGE ${(CONFIG.spike.halfPower * 100).toFixed(0)}% power` : 'RED whiff';
    swingLine = `\nhit zone ${label}  ball ${z.dist.toFixed(2)}m from ideal  closest in ${pred.t.toFixed(2)}s`;
  } else if (act.type === 'swing') {
    swingLine = `\nswing ${act.charge >= 1 ? 'full' : act.charge > 0 ? `${(act.charge * 100).toFixed(0)}%` : 'whiff'}`;
  }
  el.status.textContent =
    `stamina ${p.stamina.toFixed(0)}  ${p.grounded ? 'ground' : `air ${p.pos.y.toFixed(2)}`}\n` +
    `action ${act.type}${act.charge ? ` ${(act.charge * 100).toFixed(0)}%` : ''}\n` +
    `attack ${attackName}  approach ${p.sprintTime.toFixed(1)}s` +
    swingLine +
    `\ntick ${state.tick}  seed ${state.seed}`;
  const charging = act.type.endsWith('_charge');
  el.bar.style.width = `${(charging ? act.charge : 0) * 100}%`;
}

// ---------------------------------------------------------------- tuning panel (F1)
const gui = new GUI({ title: 'Tuning (F1)' });
for (const group of Object.keys(CONFIG) as (keyof typeof CONFIG)[]) {
  const folder = gui.addFolder(group);
  folder.close();
  const obj = CONFIG[group] as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'number' || typeof v === 'boolean') folder.add(obj, key);
  }
}
{
  const folder = gui.addFolder('training feed');
  const t = state.training;
  folder.add(t, 'feedX', 0.5, 8, 0.1).name('setter X (from net)');
  folder.add(t, 'feedZ', -4, 4, 0.1).name('setter Z');
  folder.add(t, 'feedHeight', 3, 8, 0.1).name('set apex height');
  folder.add(t, 'feedTightness', 0.5, 4, 0.1).name('set lands X off net');
  folder.add(t, 'serveKind', { float: 0, topspin: 1, random: 2 });
  folder.add(t, 'spikeSpeed', 8, 28, 0.5);
  folder.add(t, 'spikeSpread', 0, 4, 0.1);
  folder.add(t, 'debugTrajectory');
}
const vis = { reachSphere: true, arms: true };
gui.add(vis, 'reachSphere').name('show spike reach');
gui.add(vis, 'arms').name('show arms');
gui.add({ reset: () => (resetConfig(), gui.controllersRecursive().forEach((c) => c.updateDisplay())) }, 'reset').name('reset to defaults');
gui.add({ newGame: () => newMatch() }, 'newGame').name('new match');
gui.hide();

// ---------------------------------------------------------------- loop
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
let acc = 0;
let last = performance.now();

function render(dtReal: number): void {
  const b = state.ball;
  ballMesh.position.set(b.pos.x, b.pos.y, b.pos.z);
  shadowBlob.position.set(b.pos.x, 0.01, b.pos.z);
  const s = V.clamp(1 - b.pos.y / 8, 0.3, 1);
  shadowBlob.scale.setScalar(s);

  const h = CONFIG.player.height;
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const vp = playerVisuals[i];
    const show = p.active;
    vp.body.visible = vp.nose.visible = show;
    for (const arm of [vp.right, vp.left]) arm.upper.visible = arm.lower.visible = arm.hand.visible = show && vis.arms;
    if (!show) continue;
    const prone = p.action.type === 'prone' || p.action.type === 'dive';
    const crouch = p.action.type === 'bump_charge' || p.action.type === 'dig' || p.action.type === 'plant' ? 0.85 : prone ? 0.35 : 1;
    const bodyH = h * crouch;
    vp.body.position.set(p.pos.x, p.pos.y + bodyH / 2, p.pos.z);
    vp.body.rotation.y = -p.facing;
    vp.body.scale.y += (crouch - vp.body.scale.y) * Math.min(1, dtReal * 12);
    const f = forwardOf(p);
    vp.nose.position.set(p.pos.x + f.x * (CONFIG.player.capsuleRadius + 0.1), p.pos.y + CONFIG.player.eyeHeight * crouch, p.pos.z + f.z * (CONFIG.player.capsuleRadius + 0.1));
    vp.nose.rotation.set(0, -p.facing, -Math.PI / 2);
    if (vis.arms) {
      const r = rightOf(p);
      const sh = shoulderPos(p);
      const shL = V.v3(p.pos.x - r.x * 0.2, p.pos.y + CONFIG.player.shoulderHeight, p.pos.z - r.z * 0.2);
      const [tr, tl] = handTargets(p);
      // elbows bend out to the side and back
      poseArm(vp.right, sh, tr, V.v3(r.x * 0.7 - f.x * 0.5, 0, r.z * 0.7 - f.z * 0.5));
      poseArm(vp.left, shL, tl, V.v3(-r.x * 0.7 - f.x * 0.5, 0, -r.z * 0.7 - f.z * 0.5));
    }
  }

  // drill helpers: passer marker and predicted path
  const t = state.training;
  coach.visible = t.drill === 'spike' && t.feedStage >= 1;
  if (coach.visible) coach.position.set(t.passerPos.x, 0.82, t.passerPos.z);
  pathLine.visible = t.drill !== 'none' && t.debugTrajectory && b.held < 0;
  if (pathLine.visible) {
    const pts = debugPath(state);
    const n = Math.min(pts.length, PATH_MAX);
    for (let i = 0; i < n; i++) {
      pathBuf[i * 3] = pts[i].x;
      pathBuf[i * 3 + 1] = pts[i].y;
      pathBuf[i * 3 + 2] = pts[i].z;
    }
    pathGeom.setDrawRange(0, n);
    (pathGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    pathGeom.computeBoundingSphere();
  }

  // spike contact zone for the human: visible in the air and while swinging
  const p = human();
  const showZone = vis.reachSphere && (!p.grounded || p.action.type === 'swing');
  reachSphere.visible = idealMarker.visible = equator.visible = showZone;
  predictMarker.visible = showZone && b.held < 0;
  if (showZone) {
    const ideal = idealContactPoint(p);
    reachSphere.position.set(ideal.x, ideal.y, ideal.z);
    idealMarker.position.set(ideal.x, ideal.y, ideal.z);
    equator.position.set(ideal.x, ideal.y, ideal.z);
    const mat = reachSphere.material as THREE.MeshBasicMaterial;
    if (contactFlash > 0) mat.color.setHex(contactFlashColor);
    else mat.color.setHex(ZONE_COLORS[spikeZone(p, b.pos).zone]);
    mat.opacity = contactFlash > 0 ? 0.8 : 0.45;
    (idealMarker.material as THREE.MeshBasicMaterial).color.copy(mat.color);
    const pred = predictContactTiming(p, b.pos, b.vel);
    const g = CONFIG.ball.gravity;
    predictMarker.position.set(b.pos.x + b.vel.x * pred.t, b.pos.y + b.vel.y * pred.t - 0.5 * g * pred.t * pred.t, b.pos.z + b.vel.z * pred.t);
  }

  // landing ring: where the ball comes down
  const inFlight = b.held < 0 && (b.pos.y > CONFIG.ball.radius + 0.05 || Math.abs(b.vel.y) > 0.5);
  landingRing.visible = false;
  if (inFlight) {
    const land = predictBall(b.pos, b.vel, b.spin, { stopHeight: CONFIG.ball.radius, net: true, maxTime: 6 });
    if (land.reached) {
      landingRing.visible = true;
      landingRing.position.set(land.pos.x, 0.012, land.pos.z);
    }
  }

  // third-person camera behind the human along the aim direction
  const eye = eyePos(p);
  const dir = V.dirFromYawPitch(yaw, pitch);
  const c = CONFIG.camera;
  const want = new THREE.Vector3(eye.x - dir.x * c.distance, Math.max(0.3, eye.y - dir.y * c.distance + c.height * 0.5), eye.z - dir.z * c.distance);
  const k = 1 - Math.exp(-c.smoothing * dtReal);
  if (camPos.lengthSq() === 0) camPos.copy(want);
  camPos.lerp(want, k);
  camTarget.set(eye.x + dir.x * 3, eye.y + dir.y * 3, eye.z + dir.z * 3);
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
  camera.fov = c.fov;
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
}

function frame(now: number): void {
  try {
    tickAndRender(now);
  } catch (err) {
    // keep the loop alive and show the error instead of freezing silently
    console.error(err);
    el.message.textContent = `ERROR: ${(err as Error).message ?? err}`;
  }
  requestAnimationFrame(frame);
}

function tickAndRender(now: number): void {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dtReal;
  const tickDt = 1 / CONFIG.sim.TICK_RATE;
  let ticks = 0;
  while (acc >= tickDt && ticks < 8) {
    const inputs = state.players.map((p) => (p.id === state.human ? readInput() : emptyInput()));
    stepSim(state, inputs);
    for (const e of state.events) {
      if (e.player !== state.human) continue;
      if (e.type === 'rating' || (e.type === 'contact' && e.rating !== undefined)) {
        el.rating.textContent = `${RATINGS[e.rating ?? 0]}${e.kind ? ` ${e.kind}` : ''}`;
        ratingTimer = 1.2;
      }
      if (e.type === 'contact' && (e.kind === 'spike' || e.kind === 'roll' || e.kind === 'float' || e.kind === 'tip')) {
        contactFlash = 0.5;
        contactFlashColor = e.power >= 0.75 ? ZONE_COLORS.green : ZONE_COLORS.orange;
      }
      if (e.type === 'rating' && e.rating === 6) {
        contactFlash = 0.5;
        contactFlashColor = ZONE_COLORS.red;
      }
    }
    acc -= tickDt;
    ticks++;
  }
  if (ticks === 8) acc = 0;
  ratingTimer = Math.max(0, ratingTimer - dtReal);
  contactFlash = Math.max(0, contactFlash - dtReal);
  updateHud();
  render(dtReal);
}
requestAnimationFrame(frame);
