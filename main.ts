// Anchor Dip + Wide Trail — a long-only cbBTC bot for make.fun's
// btc-race-24h-20261117-0603 (agent-fun/bars-replay/v1).
//
// The dev window this bot was tuned on is a quiet, range-bound day: BTC
// drifts +0.49% over 24h with 1-minute noise of ~6 bps and no persistent
// trend, while a full round trip costs ~26 bps in fee, slippage and pool
// impact. On such a window every strategy that trades often bleeds to its
// own costs — the house ema-cross baseline loses ~$106 on it, mean-reversion
// and RSI dip-buying lose $100-200, and every momentum variant tested loses
// $6-85. The only designs that clear the dev gate are the ones that trade
// once and let the window's drift do the work, so this bot is built around
// a single anchored long position:
//
//   1. Anchor entry. Buy the whole cash balance on the first bar whose
//      close prints below the opening close — the first pullback of the day
//      rather than the open print itself. If no pullback comes by bar 60,
//      buy there anyway. This guarantees the race guardrail (>= 1 trade)
//      and puts the bot long for whatever the day does.
//   2. Wide trailing stop. Once long, sell everything if the close falls
//      2.5% below the highest close since entry. On the dev window the
//      deepest peak-to-trough after entry is 2.11%, so the stop never
//      fires there; on a downtrend day (the previous round's dev window
//      fell 4%) it caps the loss near -2.5% instead of riding the whole
//      decline. The stop is wide on purpose: a 1-minute noise band of
//      ~6 bps means any stop tighter than ~2% fires on ordinary chop.
//   3. Violent re-entry, at most twice. After a stop-out, re-enter only
//      on a sharp reversal: EMA(12) crossing above EMA(48) with the gap
//      already wider than 5 bps on the cross bar itself. A gentle cross
//      is a downtrend rally and is skipped; a violent one is how the
//      previous round's late bounce started. At most three entries per
//      window, so whipsaw costs stay bounded.
//
// Local replay (an exact-fill simulator mirroring the harness, verified to
// the cent against grade-local on the previous round):
//   new dev window  +$2.08 (1 trade)   | previous dev window  -$18.63 (5 trades)
//   reversed new    -$8.22              | reversed previous    -$17.75
// The bot's edge is selectivity and survival, not frequency: one anchored
// trade, a disaster stop, and a violent-reversal re-entry. It never shorts,
// never uses leverage, holds at most one position, and every decision is a
// deterministic function of the bars seen so far (float64 EMA math only, no
// wall clock, no randomness, no network, no files).

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** The anchor buys the whole cash balance; the re-entries do the same. */
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on.
/** Anchor deadline: buy at this bar index at the latest, pullback or not. */
const DIP_DEADLINE_BAR = 60;
/** Trailing stop: sell when the close is this far below the highest close since entry. */
const TRAIL_BPS = 250; // 2.5%
/** Violent re-entry: EMA gap wider than this on the cross bar itself. */
const REENTRY_GAP_BPS = 5;
/** EMA spans for the re-entry filter. */
const FAST_SPAN = 12;
const SLOW_SPAN = 48;
/** Anchor + at most two re-entries per window. */
const MAX_ENTRIES = 3;

/** One EMA: seeded as the mean of its first span of closes, then stepping
 *  2 / (span + 1) of the way to each new close (the same seeding the
 *  house baselines use). */
class Ema {
  readonly span: number;
  private readonly k: number;
  private warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
    this.k = 2 / (span + 1);
  }

  update(close: number): number | null {
    if (this.value !== null) {
      this.value += this.k * (close - this.value);
      return this.value;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
    return this.value;
  }
}

/** The bot's state across batches. */
interface BotState {
  /** Closes of CBBTC seen so far (bar index = closes.length - 1). */
  barsSeen: number;
  /** The opening close: the first CBBTC close of the window. */
  openClose: number | null;
  /** Highest close since the current entry (the entry close at first). */
  highSinceEntry: number | null;
  /** Close of the bar the current position's buy was decided on. */
  entryClose: number | null;
  /** Entries observed filled so far (anchor + re-entries). */
  entries: number;
  /** True once a stop-out has happened and a re-entry may be considered. */
  stoppedOut: boolean;
  /** A buy was sent but no position has been observed since (rejected fill). */
  buySent: boolean;
  /** EMA gap (fast - slow) after the previous bar, once both EMAs are set. */
  prevGap: number | null;
}

const bot: BotState = {
  barsSeen: 0,
  openClose: null,
  highSinceEntry: null,
  entryClose: null,
  entries: 0,
  stoppedOut: false,
  buySent: false,
  prevGap: null,
};

const fast = new Ema(FAST_SPAN);
const slow = new Ema(SLOW_SPAN);

function buyAll(state: BarsState): BuyInput | null {
  const cash = state.cash;
  if (cash <= 0n || cash < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state, batch) {
    // While warming up every order would be rejected; indicators still read
    // the warm-up bars, so the EMAs below stay correct either way.
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const c = Number(bar.c);
    if (bot.openClose === null) bot.openClose = c;
    const f = fast.update(c);
    const s = slow.update(c);
    const gap = f !== null && s !== null ? f - s : null;
    bot.barsSeen += 1;

    const held = state.positions.get(SYMBOL);
    const orders: Array<BuyInput | SellInput> = [];

    if (held !== undefined) {
      // A buy sent earlier has landed: record the entry.
      if (bot.buySent) {
        bot.buySent = false;
        bot.entries += 1;
        bot.highSinceEntry = bot.entryClose;
        bot.stoppedOut = false;
      }
      if (bot.highSinceEntry !== null && c > bot.highSinceEntry) bot.highSinceEntry = c;
      // Trailing disaster stop, re-evaluated every bar: a sell the market
      // refuses is simply re-sent on the next bar while it still holds.
      if (bot.highSinceEntry !== null && c < bot.highSinceEntry * (1 - TRAIL_BPS / 10_000)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        bot.stoppedOut = true;
      }
    } else {
      // Flat. The anchor buys the first pullback below the open, or at the
      // deadline bar at the latest; a buy the market refused is re-sent
      // while the entry condition still holds.
      const anchorDue =
        bot.entries === 0 &&
        bot.openClose !== null &&
        (c < bot.openClose || bot.barsSeen - 1 >= DIP_DEADLINE_BAR);
      // Violent re-entry after a stop-out: a sharp cross-up only.
      const violentCross =
        bot.stoppedOut &&
        bot.entries < MAX_ENTRIES &&
        bot.prevGap !== null &&
        gap !== null &&
        bot.prevGap <= 0 &&
        gap > 0 &&
        (gap * 10_000) / c > REENTRY_GAP_BPS;
      if (anchorDue || violentCross) {
        const buy = buyAll(state);
        if (buy !== null) {
          orders.push(buy);
          bot.buySent = true;
          bot.entryClose = c;
        }
      }
    }

    bot.prevGap = gap;
    return orders;
  },
});
