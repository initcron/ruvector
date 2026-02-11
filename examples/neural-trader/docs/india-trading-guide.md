# India Trading Guide - Neural Trader

## Quick Start

### Prerequisites
- Node.js 18+
- Zerodha demat account (for live trading)
- No API keys needed for paper trading (uses free Yahoo Finance data)

### First Run - Paper Trading

```bash
# Paper trade RELIANCE with Rs 10 lakh capital
node cli.js paper --market=india --symbol=RELIANCE --capital=1000000

# Or use npm script
npm run india:paper
```

This will:
1. Fetch real RELIANCE.NS price data from Yahoo Finance
2. Run all 4 ML engines (LSTM, Sentiment, DRL, Kelly)
3. Generate signals and size positions in INR
4. Display live P&L with Indian formatting

### Backtest

```bash
# Backtest TCS over 250 trading days with Rs 5 lakh
node cli.js backtest --market=india --symbol=TCS --days=250 --capital=500000

# Analyze HDFC Bank
node cli.js analyze --market=india --symbol=HDFCBANK
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KITE_API_KEY` | Live only | Kite Connect API key from developer.kite.trade |
| `KITE_API_SECRET` | Live only | Kite Connect API secret |
| `KITE_ACCESS_TOKEN` | Live only | Session token (refreshed daily at ~6 AM IST) |
| `KITE_TIER` | No | `free` (default, Yahoo data) or `connect` (Kite data) |

For paper trading, no environment variables are needed.

---

## Kite Connect Setup (Live Trading)

### 1. Create Kite Connect App

1. Go to [developer.kite.trade](https://kite.trade/connect/login) and log in
2. Create a new app (Personal API is free for order placement)
3. Note your **API Key** and **API Secret**

### 2. Generate Access Token

Kite tokens expire daily at ~6 AM IST. To generate:

```bash
# Set your credentials
export KITE_API_KEY="your_api_key"
export KITE_API_SECRET="your_api_secret"
```

Visit the login URL to authorize:
```
https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_API_KEY
```

After login, you'll be redirected with a `request_token` in the URL. Exchange it:

```javascript
import { KiteConnect } from 'kiteconnect';
const kc = new KiteConnect({ api_key: 'YOUR_API_KEY' });
const session = await kc.generateSession('REQUEST_TOKEN', 'YOUR_API_SECRET');
console.log('Access token:', session.access_token);
```

```bash
export KITE_ACCESS_TOKEN="generated_access_token"
```

### 3. Install Kite SDK

```bash
npm install kiteconnect
```

---

## CLI Commands

All commands support `--market=india` to switch from US to Indian markets.

### Paper Trading

```bash
# Basic paper trading (synthetic + real data mix)
node cli.js paper --market=india --symbol=RELIANCE --capital=1000000

# Intraday (MIS) with auto-square-off at 15:15 IST
node cli.js paper --market=india --symbol=INFY --capital=500000 --product=MIS

# Delivery (CNC) - hold overnight
node cli.js paper --market=india --symbol=TCS --capital=1000000 --product=CNC

# Custom update interval (10 seconds)
node cli.js paper --market=india --symbol=HDFCBANK --interval=10000
```

During paper trading, you'll see:
```
[14:32:15] Price: Rs 2,847.50 | Equity: Rs 10,04,230.00 | P&L: +Rs 4,230.00 (0.42%)
  Signal: LONG 17 shares @ Rs 2,847.50 (cost: Rs 312.84)
```

### Backtesting

```bash
# Backtest with India defaults (250 trading days, 6.5% risk-free rate)
node cli.js backtest --market=india --symbol=RELIANCE --days=250 --capital=1000000

# Save results to file
node cli.js backtest --market=india --symbol=TCS --output=results/tcs-backtest.json
```

Backtest output includes India-specific transaction costs:
```
INDIA TRANSACTION COSTS:
  Product Type: CNC
  Total Trades: 47
  Total Costs: Rs 8,234.56
  Cost as % of Capital: 0.823%
```

### Analysis

```bash
# Full analysis with LSTM prediction + sentiment + risk metrics
node cli.js analyze --market=india --symbol=HDFCBANK --verbose

# Includes transaction cost estimates
node cli.js analyze --market=india --symbol=RELIANCE --product=MIS
```

### Benchmarks

```bash
# Performance benchmarks (market-independent)
node cli.js benchmark --iterations=100
```

---

## Trading Modes

### Free Tier (No API Keys)

- **Data**: Yahoo Finance (`.NS` suffix auto-applied)
- **Trading**: Paper mode only (simulated fills)
- **Cost**: Free
- **Latency**: ~1-2 second quotes
- **Historical data**: Up to 5 years daily OHLCV

### Paid Tier (Kite Connect)

- **Data**: Kite Connect API (real-time quotes, historical candles)
- **Trading**: Paper mode + live order placement
- **Cost**: Free for Personal API (order placement), Rs 500/month for Connect API (data)
- **Latency**: ~100ms quotes
- **Features**: WebSocket tick data, order book access

---

## Product Types (India-specific)

| Product | Description | Auto-Square-Off | Margin | Use Case |
|---------|-------------|-----------------|--------|----------|
| **MIS** | Margin Intraday Square-off | Yes, 15:15 IST | Up to 5x leverage | Day trading |
| **CNC** | Cash and Carry | No | 1x (full payment) | Delivery/investment |
| **NRML** | Normal | No (until expiry) | Exchange margin | F&O trading |

### MIS (Intraday)

- Positions auto-close at 15:15 IST (15 min before market close)
- Higher leverage but must close same day
- Lower STT (0.025% on sell only)
- Brokerage: Rs 20 flat or 0.03%, whichever is lower

```bash
node cli.js paper --market=india --symbol=RELIANCE --product=MIS --capital=200000
```

### CNC (Delivery)

- Shares credited to demat account
- Hold indefinitely
- Zero brokerage on Zerodha
- Higher STT (0.1% on buy + sell)

```bash
node cli.js paper --market=india --symbol=TCS --product=CNC --capital=1000000
```

---

## Transaction Costs (Zerodha)

For a Rs 1,00,000 trade:

### Delivery (CNC) BUY

| Component | Rate | Amount |
|-----------|------|--------|
| Brokerage | 0% | Rs 0.00 |
| STT | 0.1% | Rs 100.00 |
| Exchange Txn | 0.00345% | Rs 3.45 |
| GST (18%) | on brokerage + exchange | Rs 0.62 |
| SEBI | Rs 10/crore | Rs 0.10 |
| Stamp Duty | 0.015% | Rs 15.00 |
| **Total** | | **~Rs 119.17** |

### Intraday (MIS) SELL

| Component | Rate | Amount |
|-----------|------|--------|
| Brokerage | Rs 20 flat | Rs 20.00 |
| STT | 0.025% | Rs 25.00 |
| Exchange Txn | 0.00345% | Rs 3.45 |
| GST (18%) | on brokerage + exchange | Rs 4.22 |
| SEBI | Rs 10/crore | Rs 0.10 |
| Stamp Duty | 0% (sell) | Rs 0.00 |
| **Total** | | **~Rs 52.77** |

---

## Risk Management

### Built-in Safeguards

- **Max order value**: Rs 5,00,000 per order
- **Max daily loss**: Rs 25,000 (configurable)
- **Max position size**: 10% of portfolio per stock
- **Whole shares only**: No fractional shares on NSE/BSE
- **Circuit limits**: 5%/10%/20% price bands enforced by exchange

### Auto-Square-Off (MIS)

When using `--product=MIS`:
1. Timer set for 15:15 IST (15 min before 15:30 close)
2. All open MIS positions closed at market price
3. Summary displayed with final P&L

This mimics Zerodha's actual behavior where MIS positions are squared off around 15:15-15:20 IST.

---

## Supported Symbols

### Nifty 50 (Default Set)

| Symbol | Company | Sector |
|--------|---------|--------|
| RELIANCE | Reliance Industries | Energy/Conglomerate |
| TCS | Tata Consultancy Services | IT |
| HDFCBANK | HDFC Bank | Banking |
| INFY | Infosys | IT |
| ICICIBANK | ICICI Bank | Banking |
| KOTAKBANK | Kotak Mahindra Bank | Banking |
| SBIN | State Bank of India | PSU Banking |
| BHARTIARTL | Bharti Airtel | Telecom |
| ITC | ITC Limited | FMCG |
| LT | Larsen & Toubro | Engineering |

### Using Any NSE Symbol

Pass any valid NSE symbol with `--symbol`:

```bash
# Midcap stocks
node cli.js analyze --market=india --symbol=TATAPOWER

# Banking
node cli.js paper --market=india --symbol=AXISBANK --capital=500000

# Pharma
node cli.js backtest --market=india --symbol=SUNPHARMA --days=250
```

The system auto-appends `.NS` when fetching from Yahoo Finance.

### BSE Symbols

BSE support uses `.BO` suffix:

```bash
node cli.js analyze --market=india --symbol=RELIANCE --exchange=BSE
```

---

## Market Hours

| Session | Time (IST) | Description |
|---------|-----------|-------------|
| Pre-open | 9:00 - 9:15 | Order collection, price discovery |
| Regular | 9:15 - 15:30 | Normal trading session |
| MIS Square-off | 15:15 | Auto-close intraday positions |
| Post-close | 15:30 - 15:40 | Closing price determination |

### NSE Holidays 2025-2026

The system includes a built-in holiday calendar. Major closures:
- Republic Day (Jan 26)
- Holi (March)
- Good Friday (April)
- Independence Day (Aug 15)
- Gandhi Jayanti (Oct 2)
- Diwali (Diwali Laxmi Puja + Balipratipada)
- Christmas (Dec 25)

The `MarketCalendar` checks these automatically and adjusts behavior.

---

## Troubleshooting

### "Could not fetch live data"

Yahoo Finance may rate-limit or block requests. The system falls back to synthetic data automatically. Try again in a few minutes.

### "Token expired" (Live Trading)

Kite tokens expire daily at ~6 AM IST. Generate a new token:
1. Visit login URL with your API key
2. Complete 2FA
3. Exchange request_token for access_token
4. Update `KITE_ACCESS_TOKEN` env var

### "kiteconnect package not installed"

```bash
npm install kiteconnect
```

This is only needed for live trading. Paper mode works without it.

### "NSE is currently CLOSED"

The system detects market hours and shows next open time. Paper trading still works outside market hours using simulated data based on last available prices.

### Numbers showing in wrong format

Ensure you're using `--market=india` flag. Without it, the system defaults to US formatting ($, commas).

---

## Architecture

```
CLI (cli.js)
  |
  +-- resolveMarket(options) --> Market Config (config/markets/)
  |                                |-- us.js (252 days, USD, 5% Rf)
  |                                |-- india.js (250 days, INR, 6.5% Rf)
  |
  +-- MarketCalendar --> Trading hours, holidays, square-off timers
  |
  +-- IndiaDataManager --> Yahoo Finance (.NS) or Kite Connect
  |
  +-- KiteConnectBroker --> Paper fills or real Kite API orders
  |     |-- Paper mode: simulated fills with real prices
  |     |-- Live mode: actual order placement via Kite SDK
  |
  +-- Trading Pipeline (same for US and India)
        |-- LSTM-Transformer (price prediction)
        |-- Sentiment Alpha (news analysis)
        |-- DRL Portfolio Manager (reinforcement learning)
        |-- Kelly Criterion (position sizing)
        |-- Risk Manager (limits, drawdown, circuit breakers)
```

The ML engines are market-agnostic - they work on price data regardless of currency or exchange. Market-specific behavior (costs, hours, product types, whole shares) is handled by the configuration and broker layers.
