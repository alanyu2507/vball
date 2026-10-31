# vball

A 2v2 beach volleyball game prototype. The simulation is a deterministic, fixed-step engine written in TypeScript with no engine dependencies; the browser build renders it with three.js and drives one player from mouse and keyboard.

## What is here

- `src/sim/` – the game simulation: ball physics (drag, Magnus, float knuckling, net and ground contact), player movement and stamina, actions (bump, set, spike, tip, block, dig, dive, serve), rules and scoring, and training drills. Pure functions over a `GameState`; no DOM.
- `src/config.ts` – every tuning value in one place. All numbers are exposed in the in-game tuning panel.
- `src/main.ts` + `index.html` – the browser entry: three.js scene, third-person camera, input, HUD, and the tuning panel.
- `scripts/headless.ts` – runs the sim without a browser (idle players) and prints stats.
- `parked/bots/` – the bot AI, set aside while the human-player mechanics are tuned. Not compiled. See the README there to restore it.

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173/ and click the page to lock the mouse.

Other scripts:

```bash
npm run build   # type-check and build to dist/
npm run sim     # headless run: npx tsx scripts/headless.ts [seed] [maxMinutesSim]
```

## Controls

| Input | Action |
|---|---|
| Mouse | Aim (the crosshair is where hits and sets go) |
| WASD | Move (camera-relative) |
| Shift | Sprint |
| Space (standing) | Jump |
| Space (while moving) | Plant step: a hop, hold to brake, release to jump. Longer holds bleed approach and jump lower |
| LMB in the air | Spike. Full power in the green half of the hit zone, half power in the orange half, whiff when red |
| LMB on the ground | Bump / dig (hold to charge, release to play) |
| RMB | Set (in the air or on the ground); float serve when serving |
| Q | Tip |
| F | Block (hold to charge, release to jump) |
| Shift + Space while holding LMB | Dive |
| 1 / 2 / 3 | Attack type: straight, roll shot, float |
| 5 / 6 / 7 / 8 / 9 | Drills: spike, set, receive, dig, free play |
| 0 | Leave the drill and start a match |
| R | Reset drill stats |
| F1 | Tuning panel |
| Esc | Release the mouse |

The approach charge builds while you run, walking or sprinting alike, and converts to jump height; the plant step keeps it through the hop.

## Drills

Press a number key to start a drill. The spike drill has a passer bump the ball from a random spot on your side to a setter at the net, who sets it in front of you. The setter position, set height, and how tight the set lands are in the "training feed" folder of the tuning panel.

## Current state

Only the human player acts. The other three players stand idle (the bot AI is parked), so matches will not progress past the serve; use the drills to test mechanics.
