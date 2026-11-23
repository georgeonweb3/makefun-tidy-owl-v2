// Organic-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most fresh pump.fun curves are bundled launches that dump on the first buyers.
// A launch is worth a small, fast bet only when several *distinct* non-creator wallets
// have already bought it within its first few slots: that is organic interest, and it is
// the one early signal that survived tuning on the dev window. Buying every launch
// loses money after fees (pilot sniper default: -0.49 SOL on the dev window); requiring
// 5+ distinct buyers flips it positive, and capping the crowd at 20 keeps farmed
// launches out. Requiring 10+ buyers is better still on the official dev grade
// (+0.136 SOL, 44 coins, 1.5% drawdown) and is the least dependent of the winning
// settings on its three best coins; 12+ leaves only 23 coins (too close to the
// 20-coin guardrail) and 15+ leaves 10 (below it).
//
// Exits: take profit +25% / stop loss -20% (vs cost incl. tx fees paid), or a 6-slot
// max hold, whichever comes first, and the creator selling after entry ends the trade
// immediately. One entry per coin, no adds, no partials: every add-on, partial
// take-profit and trailing variant tested on the dev window made the result worse.
//
// Deterministic by construction: no clock, no randomness, no I/O; every decision is
// a pure function of the batches the harness feeds in, iterated in insertion order.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Distinct (non-creator) buyers seen before entry, at least / at most. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Take profit / stop loss vs cost incl. tx fees paid, in bps. */
  tpBps: number;
  slBps: number;
  /** Exit after this many slots held, whatever the price. */
  maxHold: number;
  /** Exit as soon as the creator sells after our entry. */
  exitOnDevSell: boolean;
  /** Never buy a coin whose creator has already sold. */
  skipDevSold: boolean;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 300_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minBuyers: 10,
  maxBuyers: 20,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  buySlippageBps: 10_000,
  tpBps: 2500,
  slBps: 2000,
  maxHold: 6,
  exitOnDevSell: true,
  skipDevSold: true,
};

/** What selling `tokens` against (vq, vt) would pay after the 1.25% curve fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * 125n + BPS - 1n) / BPS;
}

interface Coin {
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // --- Absorb the batch's events into the per-coin books. ---
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            devBuy: 0n,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            bigSellBps: 0n,
            devSold: false,
            lastTradeSlot: e.slot,
            done: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else {
          // CompleteEvent: the curve is done; never touch it again.
          const c = coins.get(e.mint);
          if (c !== undefined) c.done = true;
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // --- Track my own fills: a filled buy opens a held position. ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) {
        let pending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') pending = true;
        if (!pending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let pendingBuy = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') pendingBuy = true;
          if (!pendingBuy) held.delete(mint);
        }
      }
      // --- Exits first: TP, SL, max hold, or creator sold after entry. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Entries: fresh curves with real organic buyers, one shot each. ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const [mint, c] of coins) {
        if (orders.length >= cap) break;
        if (c.done) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.minRealSol) || rq > BigInt(p.maxRealSol)) continue;
        if (c.devBuy < BigInt(p.minDevBuy) || c.devBuy > BigInt(p.maxDevBuy)) continue;
        // The edge: at least 10 distinct organic buyers already, at most 20.
        if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const amount = BigInt(p.stakeLamports) < maxBuy ? BigInt(p.stakeLamports) : maxBuy;
        if (amount < BigInt(p.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }
      return orders;
    },
  };
}
