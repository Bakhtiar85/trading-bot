# Backtester: compare the grid with structure-break strategies on historical data

## Background

The live grid bot ran on BTC/USDT from 2026-11-13 to 2026-11-21 with $40 (range 62,000–76,000, 6 levels, 15% stop-loss). The code worked correctly: no errors, every alert sent, stop-loss executed in full. The **strategy** lost money:

- BTC fell ~19% (69,000 → 55,900) in 8 days.
- All 3 grid buys filled (67,600 / 64,800 / 62,000) and no sell ever filled.
- Price left the range at −6% equity. The bot paused while still holding the BTC, and the stop-loss closed everything at **−15.4% ($40 → $33.86)**.

A trader reviewing the setup called the grid too basic and suggested a trend-following rule: **buy on a bullish structure break, sell on a bearish one**, evaluated every minute.

Before any more real money is used, we need evidence, not opinions. This issue adds a backtester that replays historical prices and reports how each strategy would have performed, fees included.

## Goal

A command-line tool that downloads historical BTC/USDT candles from Binance and simulates several strategies over the same period. It prints comparable results so a strategy can be chosen (or rejected) on data.

```
npm run backtest -- --symbol BTCUSDT --from 2026-05-01 --to 2026-11-21 --capital 40
```

## Scope

### 1. Historical data
- Download candles from Binance's public `GET /api/v3/klines` endpoint (no API key, no account access).
- Intervals: 1m, 15m and 1h.
- Cache downloads locally (git-ignored) so repeat runs don't re-download.
- Validate data: no gaps or duplicate candles. Report any gaps found.

### 2. Strategies to simulate

| ID | Strategy | Notes |
|---|---|---|
| `grid` | The current live grid logic | Reuse `src/grid` and the existing risk rules (breakout pause, stop-loss) so the backtest matches live behaviour |
| `grid-exit` | Grid, but **sell everything on a downward breakout** instead of pausing | Proposed fix from the November post-mortem |
| `bos-1m` | Structure break on 1-minute candles | The trader's suggestion |
| `bos-15m` | Same rule on 15-minute candles | Fewer false signals expected |
| `bos-1h` | Same rule on 1-hour candles | Fewer false signals expected |
| `hold` | Buy at the start, hold to the end | Baseline |

**Structure-break rule (long-only, spot):**
- A **swing high** is a candle whose high is above the highs of the `N` candles on each side; a **swing low** is the same for lows. Default `N = 2`, configurable.
- A swing is only known `N` candles *after* it happens. The simulation must respect that delay (no look-ahead).
- **Bullish break:** a candle closes above the most recent confirmed swing high → buy with all capital at the **next candle's open**.
- **Bearish break:** a candle closes below the most recent confirmed swing low → sell everything at the **next candle's open**.
- Spot only, no shorting: "sell" means going back to USDT.
- The same 15% stop-loss applies to every strategy.

### 3. Execution model
- **Fees:** 0.1% per fill by default, with an option for 0.075% (BNB discount).
- **Market orders** (structure-break entries and exits, stop-loss): fill at the next candle's open plus configurable slippage (default 0.02%).
- **Limit orders** (grid): fill when the candle's low (buy) or high (sell) touches the price, at the limit price.
- **Binance rules:** $5 minimum order size and the 0.00001 BTC lot step, using the same rounding as the live bot.

### 4. Report
For each strategy:
- final equity and total return (%)
- **max drawdown** (largest peak-to-trough fall)
- number of trades, win rate, average win and average loss
- total fees paid
- time in the market (% of time holding BTC)
- comparison against `hold`

Output a table in the terminal plus a CSV/JSON file with every simulated trade, so results can be checked by hand.

## Out of scope
- Any change to the live bot or the VPS.
- Futures, margin or leverage.
- Optimising parameters until something looks good. That overfits to the past; see "Risks".
- Paper trading on live prices. This will be a follow-up issue if a strategy is worth pursuing.

## Acceptance criteria
- [ ] `npm run backtest` runs end to end, including data download, on a fresh clone.
- [ ] All six strategies run over the same period and capital and appear in one comparison table.
- [ ] Replaying **2026-11-13 → 2026-11-21** with the live settings reproduces the real result: 3 buys filled, no sells, pause at 62,000, stop-loss near −15%. This confirms the simulator matches reality.
- [ ] A unit test proves the structure-break signal never uses future candles.
- [ ] Fees, slippage, minimum order size and lot rounding are applied and included in the report.
- [ ] The README explains how to run it and how to read the results.

## Risks and caveats
- **Past results don't guarantee future results.** A strategy that worked over the last 6 months can fail over the next 6.
- **Overfitting:** tuning settings until the backtest looks great usually fails live. Pick settings first, then test. Then check them on a *different* period.
- **1-minute data is large:** about 260,000 candles for 6 months. Downloading takes a few minutes; it's fine once cached.
- **Fills are approximations.** Real fills can be worse, especially for market orders in fast moves.

## Open questions
- Which period to test? Proposal: the last 6 months, plus a separate earlier 6 months to check the results hold.
- Swing size `N`: keep 2 as the default, or follow the trader's definition if he uses a specific one?
- Should the structure-break strategies use a fixed stop-loss (15%) or exit only on the bearish break?
