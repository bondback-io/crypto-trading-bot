# Solana Smart Money Copy Trading Bot

A TypeScript/Node.js bot that monitors known "smart money" wallets on Solana, detects convergence signals on Pump.fun launches and migrations, and executes small copy trades via the Jupiter aggregator.

**Paper trading is enabled by default.** Switch to live mode only when you have configured a wallet and understand the risks.

## Features

- **Smart wallet monitoring** — polls configured wallets for new token buys in real time
- **Convergence signals** — triggers when 2+ tracked wallets buy the same token within a time window
- **Pump.fun detection** — flags buys involving Pump.fun and post-migration PumpSwap activity
- **Paper trading** — realistic simulation with slippage, fees, position tracking, and auto TP/SL
- **Live trading** — Jupiter aggregator swaps with priority fees, multi-RPC failover, optional Jito
- **Dashboard** — web UI at `/dashboard` for balance, positions, RPC health, logs, and wallet management

## Project Structure

```
src/
  config.ts            — trade, filters, strategy, RPC/Jito settings
  walletStore.ts       — load/save data/wallets.json
  connection.ts        — multi-RPC, health monitor, priority fees
  jito.ts              — optional Jito bundle sender
  paperTrader.ts       — paper trading engine (simulate buy/sell, TP/SL)
  trade.ts             — Jupiter swaps (priority fees + Jito/RPC)
  monitor.ts           — wallet polling, signal detection, filters
  migrationListener.ts — Pump.fun migration WebSocket listener
  gmgn.ts              — GMGN API client
  backtest.ts          — paper backtest runner
  marketData.ts        — DexScreener / live price helpers
  server.ts            — Express API routes
  dashboard.ts         — dashboard HTML
  index.ts             — main entry point
data/
  wallets.json         — persisted smart wallet list (auto-created)
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Primary Solana RPC (Helius/QuickNode recommended) |
| `RPC_FALLBACKS` | Comma-separated fallback RPCs for auto-failover |
| `PRIVATE_KEY` | Base58 private key — **only needed for live trading** |
| `PORT` | Dashboard port (default `3000`) |
| `TRADING_MODE` | Optional override: `paper` or `live` |
| `GMGN_API_KEY` | Optional GMGN API key for wallet activity / top lists |
| `JITO_ENABLED` | `true` to send live swaps via Jito bundles first |
| `JITO_BLOCK_ENGINE` | Jito block engine URL (default mainnet) |
| `JITO_TIP_LAMPORTS` | Tip per bundle (default `10000`) |
| `JITO_UUID` | Optional Jito auth UUID |

### 3. Configure smart wallets

Edit `src/config.ts` or use the dashboard to add wallets:

```typescript
smartWallets: [
  { name: 'Cented', address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', enabled: true },
  // ...
]
```

### 4. Run

**Development (hot reload):**

```bash
npm run dev
```

**Production (local or Render start command):**

```bash
npm run build
npm start
```

For cloud hosting, see **Deploy on Render.com** below.

Open **http://localhost:3000/dashboard**

## Configuration

Settings are organized into three sections in `src/config.ts`:

### Trade (`config.trade`)
| Setting | Default | Description |
|---------|---------|-------------|
| `tradeAmountSol` | `0.15` | SOL per copy trade |
| `minProfitPercent` | `50` | Min take-profit % |
| `maxProfitPercent` | `100` | Max take-profit % |
| `stopLossPercent` | `-35` | Stop-loss % |

### Filters (`config.filters`)
| Setting | Default | Description |
|---------|---------|-------------|
| `convergenceRequired` | `2` | Wallets needed for signal |
| `maxConcurrentPositions` | `5` | Max open positions |
| `dailyLossLimitSol` | `2` | Halt trading after daily loss |
| `minWinRate` | `0` | Min win-rate % (0 = off) |
| `minActivityDays` | `7` | Max days since last trade |
| `minTradesLast30d` | `5` | Min txs in last 30 days |
| `enableActivityFilter` | `true` | Auto-disable inactive wallets |

### Strategy (`config.strategy`)
| Setting | Default | Description |
|---------|---------|-------------|
| `enableConvergence` | `true` | Require multi-wallet convergence |
| `enableMigrationOnly` | `false` | Only trade post-migration tokens |

All settings are editable via the dashboard sliders/toggles or the API.

## Smart Wallet Persistence

Wallets are stored in `data/wallets.json` and loaded on startup. Add/remove via dashboard or API — changes persist automatically.

## Deploy on Render.com

### Commands (set in Render Web Service)

| Setting | Value |
|---------|--------|
| **Build Command** | `npm install --include=dev && npm run build` |
| **Start Command** | `npm start` |
| **Health Check Path** | `/health` |

`package.json` scripts:

```json
"build": "tsc",
"start": "node dist/index.js"
```

### Step-by-step

1. Push this repo to GitHub.
2. In [Render](https://dashboard.render.com): **New → Web Service** → connect the repo.
3. Runtime: **Node**. Use the build/start commands above.
4. Add a **persistent disk** (Starter+) mounted at `/opt/render/project/src/data` so `data/wallets.json` and `data/bot-settings.json` survive deploys (see `render.yaml`).
5. Set environment variables (Environment tab) — see table below.
6. Deploy. Open `https://<your-service>.onrender.com/dashboard`.

Or use **New → Blueprint** with the included `render.yaml`.

### Environment variables (Render)

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | **Yes** | Helius / QuickNode RPC URL |
| `NODE_ENV` | Yes | `production` |
| `HOST` | Yes | `0.0.0.0` |
| `PORT` | Auto | Injected by Render — do not set manually |
| `TRADING_MODE` | Recommended | `paper` (start here) or `live` |
| `RPC_FALLBACKS` | Optional | Comma-separated backup RPCs |
| `GMGN_API_KEY` | Optional | Better wallet discovery / activity |
| `BIRDEYE_API_KEY` | Optional | Token / smart-money signals |
| `TRADING_WALLET_1` / `PRIVATE_KEY` | Live only | Base58 secret — never commit |
| `CORS_ORIGIN` | Optional | Only if calling the API from another domain |

Local template: copy `.env.example` → `.env`. On Render, set the same keys in the dashboard (no `.env` file on the server).

Env vars are loaded via `dotenv` locally; on Render they come from `process.env`.

### Health check

```bash
curl https://<your-service>.onrender.com/health
# { "status": "ok", "uptime": 123 }
```

Detailed readiness (optional): `GET /health/ready`

### Production checklist

- [ ] Build: `npm install --include=dev && npm run build` · Start: `npm start`
- [ ] `NODE_ENV=production`, `HOST=0.0.0.0`, paid `RPC_URL`
- [ ] Disk mounted for `data/`
- [ ] `/health` returns `{ "status": "ok", "uptime": … }`
- [ ] Start in **paper** mode first
- [ ] Never commit `.env` or private keys

### PM2 (optional — VPS only)

```bash
npm run pm2:start
npm run pm2:logs
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ status: "ok", uptime }` — Render health check |
| GET | `/health/ready` | Detailed readiness (RPC + monitor) |
| GET | `/api/status` | Bot status, balance, monitor state, stats, RPC/Jito |
| GET | `/api/rpc` | Multi-RPC health, latency, success rates, Jito status |
| GET/POST | `/backtest` | Replay launches (default last 24h) through paper engine |
| POST | `/api/paper/live-data` | Toggle live DexScreener prices for paper TP/SL |
| POST | `/api/monitor/toggle` | Pause/resume monitoring |
| GET | `/wallets` | Smart wallets with last activity |
| POST | `/wallets/add` | Add wallet `{ name, address }` |
| POST | `/wallets/remove` | Remove wallet `{ address }` |
| GET | `/gmgn/top-wallets` | Top smart wallets (`?period=7d\|30d&limit=20`) |
| POST | `/gmgn/top-wallets/add` | Add candidate `{ name, address }` |
| GET | `/api/gmgn/status` | API key / cache / rate-limit status |
| POST | `/api/wallets/refresh-activity` | On-chain last-trade check + auto-disable |
| POST | `/api/wallets/prune-inactive` | Remove inactive, persist active only |
| GET | `/api/migrations` | Recent Pump.fun migration candidates |
| GET | `/api/config` | Full config snapshot |
| POST | `/api/config/trade` | Update trade settings |
| POST | `/api/config/filters` | Update filter settings |
| POST | `/api/config/strategy` | Update strategy toggles |
| POST | `/api/config/mode` | Switch paper/live |
| GET | `/api/positions` | Open and closed positions |
| GET | `/api/logs` | Trade logs |
| GET | `/api/activity` | Recent smart wallet buys |

## How Signals Work

1. Bot polls each enabled smart wallet for recent transactions.
2. Parses token balance increases to detect buys.
3. Tracks buys per mint within the convergence window.
4. When **2+ distinct wallets** buy the same token → signal fires.
5. Optional filters: migration required, volume threshold.
6. On signal: executes a small SOL buy via Jupiter (or paper simulation).
7. Auto-sells at random TP (50–100%) or stop-loss (-35%).

## RPC & Jito

Live sends use multi-RPC failover, dynamic priority fees, and optional Jito:

1. Set `RPC_URL` to a paid endpoint; add `RPC_FALLBACKS` for backups.
2. Health probes run on an interval; unhealthy endpoints are skipped until they recover.
3. Priority fees are estimated from recent prioritization fees (clamped by config).
4. Set `JITO_ENABLED=true` to try a Jito bundle (swap + tip) before RPC `sendRawTransaction`.
5. Dashboard **RPC Status** and `GET /api/rpc` show active endpoint, latency, and success rates.

## Live Trading Checklist

Before switching to live mode:

1. Set a reliable `RPC_URL` (+ optional `RPC_FALLBACKS`).
2. Add your `PRIVATE_KEY` to `.env` (base58-encoded secret key).
3. Fund the wallet with SOL for trades + fees (+ Jito tip if enabled).
4. Start with small `tradeAmountSol` values.
5. Confirm via dashboard — live mode shows a red badge and confirmation prompt.

## Disclaimer

This software is for educational purposes. Cryptocurrency trading involves substantial risk. Smart wallet addresses may be outdated or incorrect — verify before use. Never trade with funds you cannot afford to lose.

## License

MIT
