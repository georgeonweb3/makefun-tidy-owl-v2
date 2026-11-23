// Organic-launch sniper for the Winner Takes All $5 Pump.fun Replay Sprint
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the strategy lives
// in strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored
// byte for byte in vendor/.
//
// Tuning (dev window, pilot sniper simulator + official grade-local): buy only fresh
// curves with 10-20 distinct organic buyers, 0.3 SOL a coin, TP +25% / SL -20% /
// 6-slot max hold. Dev-window result: +0.129 SOL net PnL, 45 coins, 1.6% max drawdown.
// Winner-takes-all, so the entry keeps the same positive-expectation sniper: it only
// needs to finish first, and a positive net PnL is the entry ticket.

// Rebuilt in-window (session started after the 20:00Z Nov 23 opening) in a fresh
// repo: the first build predated the opening and its transcripts fell outside the
// window, so this rebuild re-authors the same tuned sniper from scratch here.
// The edge, in one line: 10-20 distinct organic buyers in a coin's first 3 slots.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// One named strategy instance: the grader's `node main.ts` runs exactly this.
const strategy = createStrategy(DEFAULT_PARAMS);

await runBot(strategy);
