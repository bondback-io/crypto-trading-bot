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
| `BIRDEYE_API_KEY` | Optional Birdeye key for token / smart-money signals |
| `SOLANA_TRACKER_API_KEY` | Optional Solana Tracker key for Axiom / Photon leaderboards |
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

## Deploy on Fly.io (persistent 24/7)

This is the **recommended** way to run the bot in the cloud. Fly keeps one machine running with **no idle sleep**, so:

- wallet polling continues day and night
- Solana migration **WebSockets** stay connected
- settings and smart wallets survive deploys on a **persistent volume**

You need: a free [Fly.io](https://fly.io) account, this repo on your machine, and a **paid Solana RPC** URL (Helius / QuickNode / etc.).

---

### Step 1 — Install the Fly CLI

**macOS / Linux:**

```bash
curl -L https://fly.io/install.sh | sh
```

Then add `fly` to your PATH if the installer prints a reminder (often `export FLYCTL_INSTALL=...` in `~/.bashrc` / `~/.zshrc`).

**Windows (PowerShell):**

```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Confirm it works:

```bash
fly version
```

Sign in (opens a browser):

```bash
fly auth login
```

---

### Step 2 — Launch the app (`fly launch`)

From the **project root** (where `fly.toml` and `Dockerfile` live):

```bash
fly launch
```

Or without deploying yet:

```bash
fly launch --no-deploy
```

**Follow the prompts like this (beginner defaults):**

| Prompt | What to choose |
|--------|----------------|
| Create app / app name | Accept or pick a unique name (e.g. `solana-copy-bot`) |
| Existing `fly.toml`? | **Yes — use existing** (do **not** overwrite; we need `auto_stop_machines = "off"`) |
| Region | Pick one close to you (file default: `sjc`) |
| Postgres / Redis / Upstash? | **No** |
| Deploy now? | **No** if you still need a volume + secrets (recommended) |

You can also run: `npm run fly:launch`

---

### Step 3 — Create the persistent volume

Wallets and dashboard settings are saved under `/data`. Create a 1 GB volume in the **same region** as `primary_region` in `fly.toml`:

```bash
fly volumes create bot_data --region sjc --size 1
```

(Change `sjc` if you chose another region.)

Check:

```bash
fly volumes list
```

---

### Step 4 — Set secrets (env vars)

Non-secret defaults are already in `fly.toml` (`NODE_ENV`, `HOST`, `PORT`, `DATA_DIR=/data`, `TRADING_MODE=paper`).

**Set secrets** (never put these in git or `fly.toml`):

```bash
# Required — use a paid RPC (public mainnet-beta will 429 and break trading)
fly secrets set RPC_URL="https://your-helius-or-quicknode-url"

# Strongly recommended
fly secrets set RPC_FALLBACKS="https://backup-rpc-1,https://backup-rpc-2"

# Optional — better discovery / filters
fly secrets set GMGN_API_KEY="your-gmgn-key"
fly secrets set BIRDEYE_API_KEY="your-birdeye-key"
fly secrets set SOLANA_TRACKER_API_KEY="your-solana-tracker-key"

# Paper mode (default) — no wallet key needed
# fly secrets set TRADING_MODE="paper"

# Live trading only — pick ONE of these for the main key (base58 secret):
# fly secrets set TRADING_MODE="live"
# fly secrets set TRADING_WALLET_1="YOUR_BASE58_PRIVATE_KEY"
#   or aliases:
# fly secrets set PRIVATE_KEY="YOUR_BASE58_PRIVATE_KEY"
# fly secrets set WALLET_PRIVATE_KEY="YOUR_BASE58_PRIVATE_KEY"

# Optional second / burner wallet
# fly secrets set TRADING_WALLET_2="YOUR_BASE58_PRIVATE_KEY"
```

You can set several at once:

```bash
fly secrets set \
  RPC_URL="https://..." \
  RPC_FALLBACKS="https://...,https://..." \
  TRADING_MODE="paper"
```

#### Important environment variables

| Variable | Required? | Description |
|----------|-----------|-------------|
| `RPC_URL` | **Yes** | Primary Solana HTTP RPC (paid endpoint) |
| `RPC_FALLBACKS` | Recommended | Comma-separated backup RPCs |
| `TRADING_MODE` | Recommended | `paper` (default) or `live` |
| `TRADING_WALLET_1` | Live only | Preferred live wallet private key (base58) |
| `PRIVATE_KEY` | Live only | Alias for main wallet key |
| `WALLET_PRIVATE_KEY` | Live only | Alias for main wallet key |
| `TRADING_WALLET_2` | Optional | Burner / second live wallet |
| `GMGN_API_KEY` | Optional | Wallet discovery / activity |
| `BIRDEYE_API_KEY` | Optional | Token / smart-money signals |
| `SOLANA_TRACKER_API_KEY` | Optional | Axiom / Photon leaderboards |
| `DATA_DIR` | Set in `fly.toml` | `/data` (volume mount) |
| `HOST` / `PORT` | Set in `fly.toml` | `0.0.0.0` / `8080` |
| `NODE_ENV` | Set in `fly.toml` | `production` |
| `CORS_ORIGIN` | Rarely | Only if a separate frontend calls the API |
| `JITO_ENABLED` / `JITO_UUID` | Optional | Live MEV / Jito |

List secrets (names only, not values):

```bash
fly secrets list
```

---

### Step 5 — Deploy

```bash
fly deploy
```

Or: `npm run fly:deploy`

Fly builds the `Dockerfile`, starts the machine, mounts `/data`, and runs `node dist/index.js`.

Keep **exactly one** machine:

```bash
fly scale count 1
```

---

### Step 6 — Verify it works

```bash
fly status
fly logs
```

Health check:

```bash
curl https://solana-copy-bot.fly.dev/health
# expect: {"status":"ok","uptime":123}
```

(Replace `solana-copy-bot` with your app name.)

Open the dashboard:

```text
https://<your-app-name>.fly.dev/dashboard
```

Also check:

```bash
curl https://<your-app-name>.fly.dev/api/status
# watchedWallets should be > 0 after wallets are imported/enabled
curl https://<your-app-name>.fly.dev/api/persistence
# settingsExists / walletsExists become true after you save settings once
```

---

### Why this config works for WebSockets + the monitor

| Setting in `fly.toml` | Purpose |
|------------------------|---------|
| `auto_stop_machines = "off"` | Machine **never sleeps** — no idle kill |
| `min_machines_running = 1` | Always keep one instance |
| Single small VM | Avoid two bots trading the same book |
| Volume `bot_data` → `/data` | Persist `wallets.json` + `bot-settings.json` |
| `GET /health` check | Fly knows the process is alive |
| `kill_timeout = 30s` | Clean SIGTERM on deploy |
| HTTP service on 8080 | Dashboard + API; Fly upgrades WebSockets for HTTP clients |

Outbound Solana WebSockets (migration listener) are opened **from** your bot to the RPC. They work as long as the machine stays up — which is why idle must stay **off**.

---

### Troubleshooting

**Bot stops trading / “idle” / watches go to 0**

- Confirm `auto_stop_machines = "off"` in `fly.toml` and redeploy.
- `fly status` — machine should be `started`, not `stopped` / `suspended`.
- `fly scale count 1` — never run 0 or 2+ machines for this bot.
- Public RPC rate limits (429) — set a paid `RPC_URL` secret and redeploy.

**Env vars / secrets not applied**

- Secrets are only available **after** the next deploy or machine restart: `fly secrets set ...` then `fly deploy` (or `fly apps restart <app>`).
- Names are case-sensitive: `RPC_URL` not `rpc_url`.
- Do not put private keys in `[env]` inside `fly.toml` — use `fly secrets set` only.
- Check names: `fly secrets list`.

**Build failures**

- Need Node 20+ in Docker (our `Dockerfile` uses `node:20-bookworm-slim`).
- Local check: `npm run build` then `npm start`.
- See full build log: `fly logs` during `fly deploy`, or `fly deploy --verbose`.
- If TypeScript errors appear, fix them locally with `npm run typecheck` before deploying.

**Volume / settings reset after deploy**

- Volume must exist: `fly volumes list` → name `bot_data`.
- Region of the volume must match the machine region.
- `DATA_DIR` must be `/data` (already in `fly.toml`).
- First boot after attaching a volume: re-import wallets and save config once.

**Health check failing / app won’t start**

- App must listen on `0.0.0.0:8080` (already set via `HOST` + `PORT`).
- `/health` must return HTTP 200 — test with `curl .../health`.
- Increase grace period if boot is slow (already `45s` in `fly.toml`).
- SSH in: `fly ssh console` then `ls /data` and `wget -qO- http://127.0.0.1:8080/health`.

**WebSockets / migrations not connecting**

- Machine must stay running (`auto_stop_machines = "off"`).
- Prefer an RPC that supports WebSockets (Helius/QuickNode).
- Check logs for `[migration]` and RPC 429 errors: `fly logs`.

**Live mode won’t trade**

- `TRADING_MODE=live` **and** one of `TRADING_WALLET_1` / `PRIVATE_KEY` / `WALLET_PRIVATE_KEY`.
- Key must be base58 secret (not the public address).
- Start in **paper** until `/health` and dashboard look healthy.

**Useful commands**

```bash
fly logs                 # live logs
fly status               # machine state
fly apps restart APP     # bounce after secret changes
fly ssh console          # shell inside the VM
fly scale show           # confirm count = 1
npm run fly:logs         # same as fly logs
npm run fly:status
```

---

### Production checklist (Fly)

- [ ] `curl -L https://fly.io/install.sh | sh` (or Windows install script)
- [ ] `fly auth login`
- [ ] `fly launch` — keep existing `fly.toml`
- [ ] `fly volumes create bot_data --region <region> --size 1`
- [ ] `fly secrets set RPC_URL=...` (+ optional keys)
- [ ] `fly deploy`
- [ ] `fly scale count 1`
- [ ] `curl https://<app>.fly.dev/health` → `{"status":"ok",...}`
- [ ] Dashboard loads; start in **paper** mode
- [ ] Never commit `.env` or private keys

---

## Deploy on Render.com

### Why settings & wallets reset (Free tier)

**Yes — this is a Free-tier limitation, but not an API limit.** Render Free has **no persistent disk**. The container filesystem is wiped:

- on every new deploy / commit
- when the free instance spins down after idle

The bot *does* hard-save to `data/bot-settings.json` and `data/wallets.json`. Without a disk, those files never survive a restart.

**Fix:** upgrade to **Starter** (or higher) and attach a **1GB disk** mounted at:

```text
/opt/render/project/src/data
```

Then re-import wallets and save settings once. They will survive future deploys. `render.yaml` already declares this disk for Blueprint deploys.

Optional env override: `DATA_DIR=/opt/render/project/src/data`

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
4. **Plan:** Starter+ (not Free) so you can add a disk.
5. Add a **persistent disk** mounted at `/opt/render/project/src/data` so `data/wallets.json` and `data/bot-settings.json` survive deploys (see `render.yaml`).
6. Set environment variables (Environment tab) — see table below.
7. Deploy. Open `https://<your-service>.onrender.com/dashboard`. Confirm the amber persistence banner is gone after you save settings once.

Or use **New → Blueprint** with the included `render.yaml` (includes the disk).

### Environment variables (Render)

| Variable | Required | Description |
|----------|----------|-------------|
| `RPC_URL` | **Yes** | Helius / QuickNode RPC URL |
| `NODE_ENV` | Yes | `production` |
| `HOST` | Yes | `0.0.0.0` |
| `PORT` | Auto | Injected by Render — do not set manually |
| `TRADING_MODE` | Recommended | `paper` (start here) or `live` |
| `DATA_DIR` | Optional | Override data path (default `./data`; on Render with disk use `/opt/render/project/src/data`) |
| `RPC_FALLBACKS` | Optional | Comma-separated backup RPCs |
| `GMGN_API_KEY` | Optional | Better wallet discovery / activity |
| `BIRDEYE_API_KEY` | Optional | Token / smart-money signals |
| `SOLANA_TRACKER_API_KEY` | Optional | Axiom / Photon platform leaderboards (free tier at solanatracker.io) |
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
Persistence status: `GET /api/persistence`

### Production checklist

- [ ] Build: `npm install --include=dev && npm run build` · Start: `npm start`
- [ ] `NODE_ENV=production`, `HOST=0.0.0.0`, paid `RPC_URL`
- [ ] **Not Free** — Starter+ with disk at `/opt/render/project/src/data`
- [ ] `/health` returns `{ "status": "ok", "uptime": … }`
- [ ] `/api/persistence` shows `settingsExists` / `walletsExists` true after first save
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
