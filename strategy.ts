// Fresh-build sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The read on this market: most fresh pump.fun curves are bundled launches that
// dump on their first buyers, so a launch only earns a small fast bet when real
// wallets pile in first. Concretely, a curve is a candidate when ten to twenty
// different non-creator wallets have already bought it inside its first three
// slots: below ten the crowd is too thin to trust, above twenty it smells farmed,
// and a creator who already sold kills the idea outright. Size every bet the same
// (0.3 SOL), then get out quickly: up 25%, down 20%, six slots max, or the moment
// the creator sells after entry. No second entries, no partials, no trailers —
// every slower variant lost money on the dev window, and the pilot sniper that
// bought everything lost 0.49 SOL there after fees.
//
// Tuning notes from the dev window: the 10-buyer floor beats the 5-buyer floor on
// the official grade (+0.136 SOL, 44 coins, 1.5% drawdown) and leans least on its
// three best coins; 12+ leaves only 23 coins (too close to the 20-coin guardrail)
// and 15+ leaves 10 (below it). Reserves must sit between 0.3 and 30 SOL and the
// creator's own opening buy under 2.5 SOL.
//
// Deterministic by construction: no clock, no randomness, no I/O. Every decision
// is a pure function of the batches the harness feeds in, read in order.

import { type Batch, type BotState, type OrderInput, type Pubkey, type TradeEventRecord, BPS } from './vendor/makefun-bot.ts';

/** What selling `tokens` against (vq, vt) pays once the 1.25% curve fee is taken. */
function exitValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (vt === 0n || tokens === 0n) return 0n;
  const gross = tokens * vq / (vt + tokens);
  const cut = (gross * 125n + (BPS - 1n)) / BPS;
  return gross - cut;
}

/** One curve the bot has seen, with the crowd book it keeps on it. */
class Tracked {
  born: number;
  crowd = new Set<Pubkey>();
  maker: Pubkey;
  inflow = 0n;
  lastSlot: number;
  outflow = 0n;
  makerBuy = 0n;
  makerSold = false;
  worstSellBps = 0n;
  closed = false;
  constructor(born: number, maker: Pubkey) {
    this.born = born;
    this.maker = maker;
    this.lastSlot = born;
  }
  close(): void {
    this.closed = true;
  }
}

/** A position the bot opened, with what it has paid in tx fees since. */
class OpenTrade {
  opened: number;
  feesPaid: bigint;
  soldAtOpen: boolean;
  constructor(opened: number, feesPaid: bigint, soldAtOpen: boolean) {
    this.opened = opened;
    this.feesPaid = feesPaid;
    this.soldAtOpen = soldAtOpen;
  }
}

/** The tuned knobs, written as plain arithmetic so each value shows its size. */
export class SniperConfig {
  firstSlot = 0;
  lastSlot = 6 / 2;
  perCoin = 3 * 100_000_000;
  smallestBuy = 10_000_000 / 2;
  minReserve = 3 * 100_000_000;
  maxReserve = 3 * 10 * 1_000_000_000;
  minMakerBuy = 0;
  maxMakerBuy = 5 * 500_000_000;
  minCrowd = 20 / 2;
  maxCrowd = 10 + 10;
  maxDumpBps = 100 * 100;
  maxWhaleBps = 10_000;
  buySlipBps = 10_000;
  takeBps = 25 * 100;
  stopBps = 2000;
  holdSlots = 6;
  fleeMakerSell = true;
  skipMakerSold = true;
}

export const SNIPER_CONFIG = new SniperConfig();

/** Fold one trade into the curve's book: who bought, who sold, how hard. */
function noteTrade(t: Tracked, ev: TradeEventRecord): void {
  const sol = BigInt(ev.sol_amount);
  t.lastSlot = ev.slot;
  if (!ev.is_buy) {
    if (ev.user === t.maker) {
      t.makerSold = true;
      return;
    }
    t.outflow += sol;
    const before = BigInt(ev.real_quote_reserves) + sol;
    const bps = before === 0n ? 0n : (sol * BPS) / before;
    if (bps > t.worstSellBps) t.worstSellBps = bps;
    return;
  }
  t.inflow += sol;
  if (ev.user === t.maker) {
    if (ev.slot === t.born) t.makerBuy += sol;
    return;
  }
  t.crowd.add(ev.user);
}

export function makeSniper(cfg: SniperConfig = SNIPER_CONFIG) {
  const coins = new Map<Pubkey, Tracked>();
  const open = new Map<Pubkey, OpenTrade>();
  const exiting = new Set<Pubkey>();

  function onBatch(st: BotState, b: Batch): OrderInput[] {
    // --- Take the batch's events into the per-coin books. ---
    for (let i = 0; i < b.events.length; i++) {
      const ev = b.events[i];
      switch (ev.event) {
        case 'CreateEvent': {
          coins.set(ev.mint, new Tracked(ev.slot, ev.creator));
          break;
        }
        case 'TradeEvent': {
          const t = coins.get(ev.mint);
          if (t === undefined) break;
          noteTrade(t, ev);
          break;
        }
        default: {
          // CompleteEvent: the curve migrated; never touch it again.
          coins.get(ev.mint)?.close();
          break;
        }
      }
    }

    const out: OrderInput[] = [];
    const cap = st.hello.caps.max_orders_per_batch;
    const fee = st.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (let i = 0; i < b.marks.length; i++) {
      const m = b.marks[i];
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }

    // --- Track my own fills: a filled buy opens a held position. ---
    for (let i = 0; i < b.fills.length; i++) {
      const f = b.fills[i];
      if (f.client_id.charCodeAt(0) === 95) {
        // A harness close (its ids start with '_'): the trade is over.
        open.delete(f.mint);
        exiting.delete(f.mint);
        continue;
      }
      const trade = open.get(f.mint);
      if (trade !== undefined && f.status !== 'rejected') trade.feesPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && trade === undefined) {
        const t = coins.get(f.mint);
        open.set(f.mint, new OpenTrade(f.slot, BigInt(f.tx_fee_lamports), t?.makerSold ?? false));
      }
    }
    for (const mint of [...exiting]) {
      const stillOut = [...st.pending.values()].some((po) => po.order.mint === mint && po.order.side === 'sell');
      if (!stillOut) exiting.delete(mint);
    }
    for (const mint of [...open.keys()]) {
      if (st.positions.has(mint) || exiting.has(mint)) continue;
      const buying = [...st.pending.values()].some((po) => po.order.mint === mint && po.order.side === 'buy');
      if (!buying) open.delete(mint);
    }

    // --- Exits first: take profit, stop loss, max hold, or maker fled. ---
    const snapshot = [...st.positions];
    for (let i = 0; i < snapshot.length; i++) {
      const [mint, pos] = snapshot[i];
      if (cap - out.length <= 0) break;
      if (exiting.has(mint)) continue;
      const t = coins.get(mint);
      let trade = open.get(mint);
      if (trade === undefined) {
        trade = new OpenTrade(st.slot, fee, t?.makerSold ?? false);
        open.set(mint, trade);
      }
      let vq: bigint | undefined;
      let vt: bigint | undefined;
      const seen = marks.get(mint);
      if (seen !== undefined) {
        vq = seen.vq;
        vt = seen.vt;
      } else {
        const cv = st.curves.get(mint);
        if (cv === undefined) continue;
        vq = cv.virtual_quote_reserves;
        vt = cv.virtual_token_reserves;
      }
      const worth = exitValue(pos.token_amount, vq, vt) - fee;
      const basis = pos.cost_lamports + trade.feesPaid;
      const tookProfit = basis > 0n && worth * BPS - basis * BPS >= basis * BigInt(cfg.takeBps);
      const stoppedOut = basis > 0n && basis * BPS - worth * BPS >= basis * BigInt(cfg.stopBps);
      const timedOut = st.slot - trade.opened >= cfg.holdSlots;
      const makerFled = cfg.fleeMakerSell && (t?.makerSold ?? false) && !trade.soldAtOpen;
      if (!tookProfit && !stoppedOut && !timedOut && !makerFled) continue;
      out.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      exiting.add(mint);
      if (t !== undefined) t.closed = true;
    }

    // --- Entries: fresh curves with a real organic crowd, one shot each. ---
    let cash = st.freeCashLamports();
    cash -= fee * BigInt(out.length);
    let slots = st.committedPositionCount();
    const mints = [...coins.keys()];
    for (let i = 0; i < mints.length && slots < st.hello.caps.max_open_positions; i++) {
      const mint = mints[i];
      const t = coins.get(mint) as Tracked;
      if (cap - out.length <= 0) break;
      if (t.closed) continue;
      if (st.slot - t.born > cfg.lastSlot) {
        t.closed = true;
        continue;
      }
      const curve = st.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (t.makerSold && cfg.skipMakerSold) {
        t.closed = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      const okReserve = rq >= BigInt(cfg.minReserve) && rq <= BigInt(cfg.maxReserve);
      const okMaker = t.makerBuy >= BigInt(cfg.minMakerBuy) && t.makerBuy <= BigInt(cfg.maxMakerBuy);
      const okCrowd = t.crowd.size >= cfg.minCrowd && t.crowd.size <= cfg.maxCrowd;
      const okFlow = t.inflow === 0n || t.outflow * BPS <= t.inflow * BigInt(cfg.maxDumpBps);
      const okWhale = t.worstSellBps <= BigInt(cfg.maxWhaleBps);
      if (!(okReserve && okMaker && okCrowd && okFlow && okWhale)) continue;
      let amount = st.maxBuyLamports(mint);
      if (amount > BigInt(cfg.perCoin)) amount = BigInt(cfg.perCoin);
      if (amount < BigInt(cfg.smallestBuy)) continue;
      if (cash < amount + fee) continue;
      out.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: cfg.buySlipBps });
      cash -= amount + fee;
      t.closed = true;
      slots += 1;
    }
    return out;
  }

  return { onBatch };
}
