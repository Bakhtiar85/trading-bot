# Binance Grid Trading Bot

A TypeScript grid trading bot for Binance **spot**. It buys and sells within a fixed price range you set. Its safety rules are hard-coded, and it emails you when something notable happens.

- **Trading decisions are plain code.** No AI or LLM places, cancels, or decides anything.
- **Claude is used for one thing only:** writing a short plain-English summary for incident emails, *after* the bot has already acted. It is given no tools, and nothing it writes is ever read by trading code. If Claude is slow, fails, or isn't configured, the email goes out with a template summary instead.
- **Safe by default.** `BINANCE_USE_TESTNET=true` in `.env.example`, so a fresh clone trades fake money.

> ⚠️ **API key permissions: disable withdrawals.**
> When you create the Binance API key, enable only **"Enable Reading"** and **"Enable Spot & Margin Trading"**. **Never tick "Enable Withdrawals".** The bot never needs it, and a leaked key that can withdraw can empty your account. On mainnet the bot checks the key at startup and **refuses to run** if withdrawals are enabled. Restricting the key to your VPS's IP address is also strongly recommended.

---

## Contents

1. [How it works](#how-it-works)
2. [Safety rules](#safety-rules)
3. [Setup](#setup)
4. [Getting Binance testnet API keys](#getting-binance-testnet-api-keys)
5. [Running on testnet vs mainnet](#running-on-testnet-vs-mainnet)
6. [Running with PM2](#running-with-pm2)
7. [Logs and state](#logs-and-state)
8. [Emails you will receive](#emails-you-will-receive)
9. [After a pause or stop: resuming](#after-a-pause-or-stop-resuming)
10. [Project structure](#project-structure)
11. [Design decisions and assumptions](#design-decisions-and-assumptions)

---

## How it works

`GRID_LEVELS` price lines are spaced evenly from `GRID_LOWER_BOUND` to `GRID_UPPER_BOUND`, including both bounds. Each gap between two adjacent lines is a **slot**. `CAPITAL_ALLOCATION_USDT` is split equally across the slots (10 levels = 9 slots).

At any moment, each slot is doing one of two things:

- **Holding USDT** and waiting to **buy** at its lower line, or
- **Holding coins** and waiting to **sell** them at its upper line.

When a buy fills, that slot places a sell one line higher. When a sell fills, it places a buy one line lower. Each completed buy→sell round trip earns the grid spacing, minus fees.

**At startup**, slots whose lower line is below the current price start by waiting to buy. The slots above the price need coins to sell, so the bot market-buys exactly that amount once, up front. This is the same approach Binance's own grid bot uses.

Every `CHECK_INTERVAL_SECONDS` the bot:

1. fetches the price;
2. checks its orders for fills and flips any filled slots;
3. runs the safety rules;
4. places any missing orders (only while RUNNING);
5. sends the heartbeat email when it's due.

## Safety rules

These are implemented as plain `if`/`else` code in [src/risk/index.ts](src/risk/index.ts) and carried out by [src/bot/index.ts](src/bot/index.ts).

| # | Trigger | What the bot does |
|---|---|---|
| 1 | Price goes above `GRID_UPPER_BOUND` or below `GRID_LOWER_BOUND` | Cancels all its open grid orders, sets status **PAUSED**, emails you. It does **not** sell. |
| 2 | The bot's holdings (USDT + coins at current price) fall `STOP_LOSS_PERCENT` % or more below `CAPITAL_ALLOCATION_USDT` | Sets status **STOPPED**, cancels all grid orders, **market-sells all coins the bot holds**, emails you. |
| 3 | After PAUSED or STOPPED | The bot **never resumes by itself**, including after restarts. There is no auto-recentering. See [resuming](#after-a-pause-or-stop-resuming). |
| 4 | API key can withdraw (mainnet) | Refuses to start. |

How the ordering is guaranteed:

- The new status (PAUSED/STOPPED) is written to disk **before** any exchange action, so a crash halfway through can never leave the bot thinking it may keep trading.
- Emails and Claude are called **only after** the protective action. They have their own timeouts, and their errors are swallowed, so they can never block or undo a stop-loss.
- If the stop-loss sell itself fails (for example, the exchange is down), the bot stays STOPPED and **retries the sell on every check**. It also retries on restart. The email tells you it failed.
- **The stop-loss also applies while PAUSED.** Coins held after a breakout below the range can keep falling. Selling them is protective, not a return to trading.

## Setup

Requirements: Node.js 18+ (tested on 24), npm, and PM2 on the VPS (`npm install -g pm2`).

```bash
git clone <this repo> && cd trading-bot
npm install
cp .env.example .env        # then edit .env
npm test                     # grid calculation tests
npm run typecheck            # tsc --noEmit
npm run build                # compiles to dist/
```

Fill in `.env`. At minimum you need `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `GRID_LOWER_BOUND`, `GRID_UPPER_BOUND`, and `CAPITAL_ALLOCATION_USDT`. Every variable is explained in [.env.example](.env.example). Three extra optional variables, beyond the original spec:

- `HEARTBEAT_INTERVAL_HOURS` (default 24)
- `DATA_DIR` (default `./data`)
- `LOG_DIR` (default `./logs`)

**Choosing values.** The bot checks all of these at startup and exits with a clear error if they're wrong.

- Each slot's order must meet Binance's minimum order size. For BTCUSDT that is roughly 5 USDT, so `CAPITAL_ALLOCATION_USDT / (GRID_LEVELS - 1)` must be comfortably above 5.
- The spacing between lines should be well above 0.2%, which is the fee for a round trip at 0.1% per side. Otherwise every trade loses money; the bot logs a warning if it isn't.
- When a new session starts, you need at least `CAPITAL_ALLOCATION_USDT` free USDT in the account.

**Email (SMTP).** Any SMTP provider works. With Gmail, create an [App Password](https://myaccount.google.com/apppasswords) and use `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<your gmail>`, `SMTP_PASS=<app password>`. If you leave all SMTP variables blank, emails are only written to the log. That is fine for a first testnet run.

**Claude.** Put an Anthropic API key in `ANTHROPIC_API_KEY`. It's optional; without it, incident emails use a template summary.

## Getting Binance testnet API keys

1. Go to **https://testnet.binance.vision** and log in with GitHub.
2. Click **Generate HMAC_SHA256 Key**, give it a label, and copy the **API Key** and **Secret Key**. The secret is shown only once.
3. Put them in `.env` as `BINANCE_API_KEY` / `BINANCE_API_SECRET`, with `BINANCE_USE_TESTNET=true`.
4. The testnet account starts pre-funded with test USDT and BTC. It is periodically reset by Binance, which wipes your balances and orders. If that happens, delete `data/state.json` and restart.

Note: these are **Spot Testnet** keys (`testnet.binance.vision`). Binance's newer "Demo Trading" (`demo-api.binance.com`) uses different keys and is not what this bot connects to.

## Running on testnet vs mainnet

| | Testnet | Mainnet |
|---|---|---|
| `.env` | `BINANCE_USE_TESTNET=true` | `BINANCE_USE_TESTNET=false` |
| API host | `https://testnet.binance.vision` | `https://api.binance.com` |
| Keys from | testnet.binance.vision | binance.com → Account → API Management |
| Email subjects | `[GridBot TESTNET] …` | `[GridBot LIVE] …` |

Run on testnet first, for at least a few days. Then, to switch:

1. Create a mainnet API key with **withdrawals disabled** (IP-restricted is recommended).
2. Set `BINANCE_USE_TESTNET=false` and the new keys in `.env`.
3. `npm run build && pm2 restart grid-bot`.

Changing `BINANCE_USE_TESTNET` automatically starts a new session with fresh state. The previous state file is archived.

Run it directly (foreground) for a quick look:

```bash
npm run build && npm start      # Ctrl+C to stop cleanly
```

## Running with PM2

```bash
npm run build
pm2 start ecosystem.config.js   # starts "grid-bot"
pm2 logs grid-bot               # live logs
pm2 status
pm2 restart grid-bot            # after changing .env (rebuild first if code changed)
pm2 stop grid-bot               # graceful stop (open grid orders stay on Binance)
pm2 save && pm2 startup         # survive VPS reboots (run the command it prints)
```

The [ecosystem.config.js](ecosystem.config.js) settings:

- Auto-restart is on, with exponential back-off, so a persistent failure doesn't hammer the API or your inbox.
- At most 15 rapid restarts.
- A single instance only. Never run two copies against the same account and state.

**Stopping the bot does not cancel its orders.** They stay on Binance and keep working. Fills that happen while the bot is down are picked up when it restarts. To take everything off the exchange, cancel the orders in the Binance UI.

## Logs and state

| What | Where |
|---|---|
| Structured JSON logs, rotated daily, 20 MB max per file, kept 30 days | `logs/gridbot-YYYY-MM-DD.log` |
| PM2 stdout/stderr capture | `logs/pm2-out.log`, `logs/pm2-error.log` |
| Bot state: status, per-slot orders, bot ledger | `data/state.json` |
| Archived state from previous sessions | `data/state-<session>-<status>-<timestamp>.json` |

`state.json` is written atomically (temp file + rename) after every change. If it is ever corrupt, the bot refuses to start rather than guess, because a corrupt file could be hiding a STOPPED status. Inspect it, then move it aside to start fresh.

Set `LOG_LEVEL=debug` to log price, equity, and drawdown on every check.

## Emails you will receive

| Email | When | Claude summary? |
|---|---|---|
| **Started** | Every time the process starts | No |
| **Price left the grid range – PAUSED** | Rule 1 | Yes |
| **Price left the grid range (alert only)** | `BREAKOUT_PAUSE=false`; once per excursion outside the range | Yes |
| **Stop-loss triggered – STOPPED** | Rule 2; again if a failed stop-loss sell later succeeds | Yes |
| **CRASH – bot process exiting** | Unhandled error, sent just before the process exits | No; sent immediately to be fast |
| **Bot restarted after a crash** | First start after an unclean exit | Yes |
| **Heartbeat** | Every `HEARTBEAT_INTERVAL_HOURS` (default daily) | No |
| Crash-style warning | 5 consecutive failed checks, e.g. the exchange is unreachable. The bot keeps retrying. | No |

Claude summaries are 3–5 sentences, written for a non-expert. They only describe what already happened and always end with *"This is not financial advice; you may want a second opinion before making further decisions."* The exact numbers are always listed under the summary as well.

If you haven't received a heartbeat when one was due, assume the bot is down and check `pm2 status`.

## After a pause or stop: resuming

The bot will not trade again on its own. Restarting alone does nothing: the state file says PAUSED/STOPPED, so the bot stays halted. It keeps running only to send heartbeats and, if STOPPED with an unfinished sell, to retry that sell.

To start trading again:

1. Review what happened (the incident email and the logs).
2. **Change the grid config in `.env`**, typically `GRID_LOWER_BOUND` / `GRID_UPPER_BOUND` for a new range. A new session starts when any of these differs from the halted session: `TRADING_PAIR`, `GRID_LOWER_BOUND`, `GRID_UPPER_BOUND`, `GRID_LEVELS`, `CAPITAL_ALLOCATION_USDT`, `STOP_LOSS_PERCENT`, `BINANCE_USE_TESTNET`.
3. Restart: `pm2 restart grid-bot`.

The old state file is archived and any of its remaining open orders are cancelled. If you also changed `TRADING_PAIR`, the bot logs the old session's order-ID prefix instead, and you cancel those orders in the Binance UI.

**Coins left over from a PAUSED session are not sold, and the new session does not manage them.** They stay in your account for you to handle. The new session starts from `CAPITAL_ALLOCATION_USDT` of free USDT. If you really want to restart with identical settings, stop the bot, move `data/state.json` aside, and start it again.

## Project structure

```
src/
  config/          .env → validated, typed Config; config fingerprint
  exchange/        typed Binance wrapper: price, filters, balances, place/cancel/query orders
  grid/            pure grid math (levels, slot sizes, rounding) + grid.test.ts
  risk/            pure safety-rule evaluation + persisted state store (state.ts)
  ai/              generateIncidentSummary(context) → text only
  notifications/   Nodemailer mailer, summary-with-fallback, email formatting, Notifier
  bot/             orchestration loop, fills, safety actions, heartbeat
  types/           shared interfaces (GridConfig, RiskConfig, OrderState, IncidentContext, …)
  logger.ts        Winston: console + daily-rotating JSON file
  index.ts         entrypoint, crash + signal handlers
```

## Design decisions and assumptions

These are choices made where the spec was open:

- **`GRID_LEVELS` counts price lines, including both bounds.** 10 levels means 9 slots, and capital is split equally across the slots. Lines are spaced arithmetically (equal price gaps), not geometrically.
- **The initial coin purchase is a market buy** of exactly the coins that the slots above the current price need.
- **Drawdown is measured on the bot's own ledger, not the whole account.** The ledger tracks the USDT and coins the bot started with and traded. Equity = USDT + coins × current price, and drawdown = (capital − equity) / capital. Other funds in your account are ignored, and **the stop-loss only sells coins the bot bought**, never your other holdings.
- **Fees are estimated at 0.1% per fill.** Each sell is sized 0.1% smaller than the matching buy, because Binance usually takes the buy fee out of the coins received. If you pay fees in BNB, this leaves a small amount of unsold coin ("dust"), and the ledger slightly under-counts equity. That is the conservative direction for the stop-loss.
- **`BREAKOUT_PAUSE=false` means alert-only.** You get one email per time the price leaves the range, and the grid orders stay in place (they simply stop filling beyond the range). The stop-loss is **always** active. `true` (the default) is strongly recommended.
- **A session that starts with the price outside the range goes straight to PAUSED** without placing orders, and you get an email.
- **Orders are tracked by client order ID, reserved before sending.** Each order's ID is saved to disk before the order is sent, and every ID starts with `gb-<sessionId>-`. So after a crash, the bot can always tell whether an order reached Binance, and it can find and cancel any stray orders of its own. Orders you place manually are never touched.
- **Orders cancelled outside the bot** (for example, by you in the UI) are re-placed on the next check, with any partial fill booked to the ledger.
- **A config error** (bad `.env`) logs and exits without emailing, since the SMTP settings may be what's broken. PM2 will retry a limited number of times.
- **Claude model:** `claude-opus-5` at low effort, with server-side refusal fallbacks enabled, a 45 s hard timeout, and one retry. Any failure falls back to the template.
- **Floating-point numbers are used** for prices and quantities, with all values sent to Binance rounded to the symbol's tick and step sizes. That precision is ample for spot grid sizes.
- **Only USDT-quoted pairs are supported**, because capital, drawdown, and emails are all in USDT.

**Limitations:** no backtesting; spot only (no margin or futures); one pair per process; polling-based fill detection (a fill is noticed within one check interval).

> This software trades real money when mainnet is enabled. Grid bots lose money in strong trends, and the stop-loss sells at market price, which can be worse than the trigger price in a fast move. Test thoroughly on testnet. Nothing here is financial advice.
