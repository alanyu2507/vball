import { botInput, createBotMemory } from '../src/sim/bot';
import { createState, stepSim } from '../src/sim/sim';
import { RATINGS } from '../src/sim/types';
(globalThis as any).BOT_DEBUG = true;
const seed = Number(process.argv[2] ?? 12345);
const rallies = Number(process.argv[3] ?? 3);
const state = createState(seed, -1);
const mems = state.players.map((p) => createBotMemory(seed, p.id));
const f = (n: number) => n.toFixed(2);
let lastPrint = -1;
while (state.stats.rallies < rallies && state.tick < 60 * 600) {
  const inputs = state.players.map((p, idx) => botInput(state, idx, mems[idx]));
  stepSim(state, inputs);
  const b = state.ball;
  for (const e of state.events) {
    if (e.type === 'contact' || e.type === 'point' || e.type === 'net' || e.type === 'landing' || e.type === 'rating' || e.type === 'serve') {
      const p = e.player >= 0 ? state.players[e.player] : null;
      console.log(
        `[${state.time.toFixed(2)}] ${e.type} ${e.kind ?? ''} p${e.player} ${e.rating !== undefined ? RATINGS[e.rating] : ''} ball=(${f(b.pos.x)},${f(b.pos.y)},${f(b.pos.z)}) vel=(${f(b.vel.x)},${f(b.vel.y)},${f(b.vel.z)}) |v|=${f(Math.hypot(b.vel.x, b.vel.y, b.vel.z))} touches=${state.touches} ${e.text ?? ''}` +
          (p ? ` ppos=(${f(p.pos.x)},${f(p.pos.y)},${f(p.pos.z)}) act=${p.action.type} ch=${f(p.action.charge)} timing=${f(p.action.timing)} jumpH=${f(p.jumpHeight)} vy=${f(p.vel.y)} sprintT=${f(p.sprintTime)}` : ''),
      );
    }
  }
  if ((state.phase === 'rally' || (state.phase === 'serve' && state.ball.held < 0)) && state.tick - lastPrint >= 6) {
    lastPrint = state.tick;
    const ps = state.players.map((p) => `p${p.id}(${f(p.pos.x)},${f(p.pos.z)}${p.grounded ? "" : " AIR y=" + f(p.pos.y) + " vy=" + f(p.vel.y)} ${p.action.type}${inputs[p.id].primary ? ' LMB' : ''}${inputs[p.id].secondary ? ' RMB' : ''}${inputs[p.id].block ? ' F' : ''})`).join(' ');
    console.log(`   t=${state.time.toFixed(2)} ball=(${f(b.pos.x)},${f(b.pos.y)},${f(b.pos.z)}) ${ps}`);
  }
}
