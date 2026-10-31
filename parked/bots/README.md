# Parked: bot feature

Set aside on 2026-10-30 so the build can be tested without bots. Nothing in `src/` imports these files,
and `parked/` is outside the `tsconfig.json` include list, so they are not type-checked or built.

- `bot.ts` – bot AI (`createBotMemory`, `botInput`). Original location: `src/sim/bot.ts`
  (it imports from `../config`, `./ball`, `./actions`, `./player`, `./rng`, `./types`, `./vec`).
- `trace.ts` – verbose bot-vs-bot rally tracer. Original location: `scripts/trace.ts`
- `headless-bots.ts` – the original bot-vs-bot `scripts/headless.ts`.

The `CONFIG.bots` block in `src/config.ts` was left in place; it is unused while this is parked.

To restore: move `bot.ts` back to `src/sim/`, `trace.ts` back to `scripts/`,
and replace `scripts/headless.ts` with `headless-bots.ts`.
