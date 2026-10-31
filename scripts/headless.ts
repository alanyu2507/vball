/**
 * Headless sim run with idle players (no bots; bot AI is parked in parked/bots/).
 * Usage: npx tsx scripts/headless.ts [seed] [maxMinutesSim]
 */
import { createState, stepSim } from '../src/sim/sim';
import { emptyInput, type InputFrame } from '../src/sim/types';

const seed = Number(process.argv[2] ?? 12345);
const maxTicks = Math.round(Number(process.argv[3] ?? 40) * 60 * 60);
const state = createState(seed, -1);
let lastScore = '';
let contactsByKind: Record<string, number> = {};
let ratings: Record<string, number> = {};
let maxPhaseTicks = 0;
let phaseTicks = 0;
let lastPhase = state.phase;
let serveTicksMax = 0;
const spikeHeights: number[] = [];
const reasons: Record<string, number> = {};
const t0 = Date.now();
for (let i = 0; i < maxTicks; i++) {
  const inputs: InputFrame[] = state.players.map(() => emptyInput());
  stepSim(state, inputs);
  for (const e of state.events) {
    if (e.type === 'contact' && e.kind) contactsByKind[e.kind] = (contactsByKind[e.kind] ?? 0) + 1;
    if (e.type === 'contact' && e.rating !== undefined) ratings[e.rating] = (ratings[e.rating] ?? 0) + 1;
    if (e.type === 'contact' && (e.kind === 'spike' || e.kind === 'roll' || e.kind === 'float')) spikeHeights.push(e.pos.y);
    if (e.type === 'point' && e.text) {
      const r = e.text.split(': ')[1] ?? e.text;
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
  }
  if (state.phase === lastPhase) phaseTicks++;
  else {
    if (lastPhase === 'serve') serveTicksMax = Math.max(serveTicksMax, phaseTicks);
    maxPhaseTicks = Math.max(maxPhaseTicks, phaseTicks);
    phaseTicks = 0;
    lastPhase = state.phase;
  }
  const sc = `${state.score[0]}-${state.score[1]}`;
  if (sc !== lastScore) {
    lastScore = sc;
    console.log(`t=${state.time.toFixed(1)}s ${sc} rally=${state.rallyLength} ${state.message}`);
  }
  const b = state.ball;
  if (!Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.vel.x + b.vel.y + b.vel.z)) {
    console.error('NaN in ball state at tick', state.tick);
    process.exit(1);
  }
  if (state.phase === 'gameover') break;
}
const ms = Date.now() - t0;
console.log('---');
console.log(`phase=${state.phase} score=${state.score.join('-')} ticks=${state.tick} simTime=${state.time.toFixed(0)}s wall=${ms}ms`);
console.log('stats', JSON.stringify(state.stats));
console.log('contacts', JSON.stringify(contactsByKind));
console.log('ratings', JSON.stringify(ratings));
if (spikeHeights.length) console.log(`spike contact height avg ${(spikeHeights.reduce((a, b) => a + b, 0) / spikeHeights.length).toFixed(2)} min ${Math.min(...spikeHeights).toFixed(2)} max ${Math.max(...spikeHeights).toFixed(2)}`);
console.log('reasons', JSON.stringify(reasons));
console.log(`longest phase ${(maxPhaseTicks / 60).toFixed(1)}s, longest serve phase ${(serveTicksMax / 60).toFixed(1)}s`);
if (state.phase !== 'gameover') console.log('note: game did not finish (expected with idle players; bots are parked in parked/bots/)');
