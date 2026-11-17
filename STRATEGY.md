# Strategy note — Anchor Dip + Wide Trail

## What the dev window looks like

The dev window is 1,440 one-minute bars of cbBTC in which BTC drifts from
$64,461 to $64,776 (+0.49%), ranging $63,874–$65,467. One-minute returns
have a ~6.4 bps standard deviation and 116 of the bars are flat. A full-size
round trip costs ~26 bps (4 bps fee + 2 bps slippage + ~7 bps of
constant-product impact each way at $1,000 against ~$800k of pool depth), so
a trade has to catch a move bigger than that just to break even.

## What was tested and rejected

All candidates were evaluated with a local replay simulator that mirrors the
harness fill model exactly (integer math, fills at the next bar's open, fee /
slippage / impact, max-slippage rejections, end-of-window flatten). It
reproduces this entry's official grade-local score to the cent, so candidate
scores are directly comparable to grading.

- **House ema-cross baseline (EMA 8/21):** 68 trades, -$106.21.
- **Plain EMA crossover + ATR trailing stop (several spans):** 10–28 trades,
  all -$27 to -$39.
- **Donchian breakout (60/120/240):** 14–52 trades, -$25 to -$85.
- **Momentum-burst entries (30/60/120-bar return thresholds):** 6–26 trades,
  -$6 to -$45.
- **Bollinger mean reversion (several windows/k):** 64–145 trades,
  -$98 to -$207.
- **RSI dip-buying (14/30/60, 14/25/55):** 93–121 trades, -$157 to -$191.
- **Range-quantile trading (240/480-bar windows):** 38–50 trades,
  -$56 to -$72.
- **Violent cross-up only (the previous round's winning design):** 2 trades,
  -$2.91 — the late bounce it was built for never comes on this window.

The pattern is consistent: on a quiet range-bound day, frequency is the
enemy. Every design that trades more than a couple of times loses money to
its own costs, and the window's moves are symmetric round trips — the
hour-8 spike runs +2.2% and gives it all back within the hour — so even
well-timed entries get stopped out of their gains.

## The final design

**Entry — the first pullback.** Buy the whole cash balance on the first bar
whose close prints below the opening close, or at bar 60 at the latest if no
pullback comes. Buying the pullback instead of the open print is worth about
$1 on this window, and it is a small, consistent improvement on every
window tested (reversed and block-shuffled included), not a fitted one: the
open print is the median of the minute's first 10 seconds of samples and
sitting out one bar costs nothing. One entry guarantees the race guardrail
(>= 1 trade).

**Exit — a wide trailing stop.** Sell everything if the close falls 2.5%
below the highest close since entry. The stop is wide on purpose: with
6 bps of per-minute noise, any stop tighter than ~2% fires on ordinary
chop (a 2.0% stop costs $9.58 on this window by firing once mid-day).
At 2.5% it never fires on the dev window (deepest peak-to-trough after
entry is 2.11%) and caps a downtrend day near -2.5% instead of riding it
(the previous round's dev window fell 4%; this stop would have held the
loss to ~$27 instead of ~$44).

**Re-entry — violent cross-ups only, at most twice.** After a stop-out,
re-enter only when EMA(12) crosses above EMA(48) with the gap already
wider than 5 bps on the cross bar itself. A gentle cross is a downtrend
rally and is skipped; a violent one is how the previous round's late bounce
started. At most three entries per window, so whipsaw costs stay bounded.

**Sizing.** Full cash per entry, one position, 1% max slippage per order.
With $1,000 against ~$800k of depth the impact is ~7 bps a side; the
strategy's edge is holding a drift, not sizing finesse.

## Results

| Window | Net PnL | Trades | Max drawdown |
| --- | --- | --- | --- |
| Dev (official grade-local) | +$2.08 | 1 | 2.12% |
| Previous dev window (20261115) | -$18.63 | 5 | — |
| Dev time-reversed | -$8.22 | 1 | — |
| Dev block-shuffled, 2 seeds | -$0.75 / -$19.39 | 1 / 1 | — |
| Previous dev time-reversed | -$17.75 | 5 | — |

The dev profit is the window's own drift, captured by a single anchored
trade. The design is honest about that: on a trendless day it makes about
+$2, and its risk is a quiet day with no move at all (bounded by the
fallback buy) or a sharp down day (bounded by the 2.5% stop). On a trending
race day the same rules ride the trend — full size from the first pullback,
stopped out only on a real 2.5% breakdown, and re-entering only on a sharp
reversal. Drawdown stays far inside the 25% race guardrail on every window
tested.
