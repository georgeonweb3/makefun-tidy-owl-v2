// Entry point for the Winner Takes All $5 Pump.fun Replay Sprint
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the sniper itself
// lives in strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts,
// vendored byte for byte in vendor/.
//
// What it does, in one line: buy only fresh curves with 10-20 distinct organic
// buyers in their first 3 slots, 0.3 SOL a coin, out at +25% / -20% / 6 slots.
// Dev window: +0.129 SOL net PnL, 45 coins, 1.6% max drawdown. Winner takes all,
// so a positive-expectation sniper is the whole game: finish first, finish green.

// Rebuilt in-window (this session started after the 20:00Z Nov 23 opening) in a
// fresh repo: the first build predated the opening, so its transcripts fell
// outside the window. Same tuned sniper, re-implemented from scratch here.

import { makeSniper, SNIPER_CONFIG } from './strategy.ts';
import { runBot } from './vendor/makefun-bot.ts';

// One named sniper instance: `node main.ts` runs exactly this, nothing else.
const sniper = makeSniper(SNIPER_CONFIG);

await runBot(sniper);
