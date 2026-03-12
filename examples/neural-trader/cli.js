#!/usr/bin/env node
/**
 * Neural-Trader CLI
 *
 * Command-line interface for running trading strategies
 *
 * Usage:
 *   npx neural-trader run --strategy=hybrid --symbol=AAPL
 *   npx neural-trader backtest --data=./data.json --days=252
 *   npx neural-trader paper --capital=100000
 *
 * India Market:
 *   npx neural-trader paper --market=india --symbol=RELIANCE --capital=1000000
 *   npx neural-trader backtest --market=india --symbol=TCS --days=250
 *   npx neural-trader analyze --market=india --symbol=HDFCBANK
 */

import { createTradingPipeline } from './system/trading-pipeline.js';
import { BacktestEngine, PerformanceMetrics } from './system/backtesting.js';
import { DataManager } from './system/data-connectors.js';
import { RiskManager } from './system/risk-management.js';
import { getMarketConfig, formatCurrency, listMarkets } from './config/markets/index.js';
import { MarketCalendar } from './system/market-calendar.js';

// CLI Configuration
const CLI_VERSION = '1.1.0';

// Parse command line arguments
function parseArgs(args) {
  const parsed = {
    command: args[0] || 'help',
    options: {}
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      parsed.options[key] = value || true;
    } else if (arg.startsWith('-')) {
      parsed.options[arg.slice(1)] = args[++i] || true;
    }
  }

  return parsed;
}

// Resolve market config from CLI options
function resolveMarket(options) {
  const marketId = options.market || 'us';
  const market = getMarketConfig(marketId);
  const calendar = new MarketCalendar(market);
  const symbol = options.symbol || market.defaultSymbols[0];
  const capital = parseFloat(options.capital) || (marketId === 'india' ? 1000000 : 100000);

  return { market, calendar, symbol, capital, marketId };
}

// Format price with market-appropriate currency
function fmtPrice(value, market) {
  return formatCurrency(value, market);
}

// Generate synthetic data for demo
function generateSyntheticData(days = 252, startPrice = 100) {
  const data = [];
  let price = startPrice;

  for (let i = 0; i < days; i++) {
    const trend = Math.sin(i / 50) * 0.001;
    const noise = (Math.random() - 0.5) * 0.02;
    price *= (1 + trend + noise);

    data.push({
      date: new Date(Date.now() - (days - i) * 24 * 60 * 60 * 1000),
      open: price * (1 - Math.random() * 0.005),
      high: price * (1 + Math.random() * 0.01),
      low: price * (1 - Math.random() * 0.01),
      close: price,
      volume: 1000000 * (0.5 + Math.random())
    });
  }

  return data;
}

// Try to fetch real market data for India, fall back to synthetic
async function fetchIndiaData(symbol, days, market) {
  try {
    const { IndiaDataManager } = await import('./system/data-connectors-india.js');
    const dataManager = new IndiaDataManager({
      exchange: 'NSE',
      kiteTier: process.env.KITE_TIER || 'free',
      kiteApiKey: process.env.KITE_API_KEY || '',
      kiteAccessToken: process.env.KITE_ACCESS_TOKEN || ''
    });

    console.log(`Fetching real NSE data for ${symbol}...`);
    const historical = await dataManager.getHistorical(symbol, {
      period: days > 365 ? '5y' : days > 180 ? '1y' : '6mo',
      interval: '1d'
    });

    if (historical && historical.length >= 30) {
      const source = historical[0]?.source || 'unknown';
      console.log(`Loaded ${historical.length} candles from ${source === 'kite' ? 'Kite Connect' : 'Yahoo Finance'} (${symbol}${source !== 'kite' ? '.NS' : ''})`);
      return historical;
    }
  } catch (err) {
    console.warn(`Could not fetch live data: ${err.message}`);
  }

  // Fallback to synthetic data with India-typical prices
  console.log(`Using synthetic data for ${symbol} (${days} days)`);
  return generateSyntheticData(days, 2500); // India stocks typically ₹500-₹5000
}

// Try to fetch real quote for India
async function fetchIndiaQuote(symbol) {
  try {
    const { IndiaDataManager } = await import('./system/data-connectors-india.js');
    const dataManager = new IndiaDataManager({
      exchange: 'NSE',
      kiteTier: process.env.KITE_TIER || 'free',
      kiteApiKey: process.env.KITE_API_KEY || '',
      kiteAccessToken: process.env.KITE_ACCESS_TOKEN || ''
    });
    const quote = await dataManager.getQuote(symbol);
    return quote;
  } catch {
    return null;
  }
}

// Commands
const commands = {
  help: (options) => {
    const markets = listMarkets();
    const marketList = markets.map(m => `${m.id} (${m.currency})`).join(', ');

    console.log(`
Neural-Trader CLI v${CLI_VERSION}

USAGE:
  neural-trader <command> [options]

COMMANDS:
  run        Execute trading strategy in real-time mode
  backtest   Run historical backtest simulation
  paper      Start paper trading session
  analyze    Analyze market data and generate signals
  benchmark  Run performance benchmarks
  help       Show this help message

OPTIONS:
  --strategy=<name>    Strategy: hybrid, lstm, drl, sentiment (default: hybrid)
  --symbol=<ticker>    Stock symbol (default: AAPL for US, RELIANCE for India)
  --capital=<amount>   Initial capital (default: $100,000 US / ₹10,00,000 India)
  --days=<n>           Number of trading days (default: 252 US / 250 India)
  --market=<id>        Market: ${marketList} (default: us)
  --product=<type>     India only: MIS (intraday), CNC (delivery), NRML (F&O)
  --exchange=<code>    India only: NSE or BSE (default: NSE)
  --data=<path>        Path to historical data file
  --output=<path>      Path for output results
  --verbose            Enable verbose output
  --json               Output in JSON format

US EXAMPLES:
  neural-trader run --strategy=hybrid --symbol=AAPL
  neural-trader backtest --days=500 --capital=50000
  neural-trader paper --capital=100000 --strategy=drl
  neural-trader analyze --symbol=TSLA --verbose

INDIA EXAMPLES:
  neural-trader paper --market=india --symbol=RELIANCE --capital=1000000
  neural-trader backtest --market=india --symbol=TCS --days=250 --capital=500000
  neural-trader analyze --market=india --symbol=HDFCBANK --verbose
  neural-trader run --market=india --symbol=INFY --product=MIS

ENVIRONMENT VARIABLES (India/Kite Connect):
  KITE_API_KEY         Kite Connect API key (for live trading)
  KITE_API_SECRET      Kite Connect API secret
  KITE_ACCESS_TOKEN    Kite Connect session token (refreshed daily)
  KITE_TIER            'free' (Yahoo data) or 'connect' (Kite data)
`);
  },

  run: async (options) => {
    const { market, calendar, symbol, capital, marketId } = resolveMarket(options);

    console.log('═'.repeat(70));
    console.log(`NEURAL-TRADER: REAL-TIME MODE ${marketId === 'india' ? '(NSE)' : ''}`);
    console.log('═'.repeat(70));
    console.log();

    const strategy = options.strategy || 'hybrid';
    const product = options.product || (marketId === 'india' ? 'CNC' : null);

    console.log(`Market: ${market.name}`);
    console.log(`Strategy: ${strategy}`);
    console.log(`Symbol: ${symbol}`);
    console.log(`Capital: ${fmtPrice(capital, market)}`);
    if (product) console.log(`Product: ${product}`);

    if (marketId === 'india') {
      const status = calendar.isMarketOpen(new Date())
        ? 'OPEN' : `CLOSED (next: ${calendar.getNextMarketOpen(new Date()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })})`;
      console.log(`NSE Status: ${status}`);
    }
    console.log();

    const pipeline = createTradingPipeline();
    const riskManager = new RiskManager();
    riskManager.startDay(capital);

    // Fetch real data for India, synthetic for US demo
    let marketData;
    if (marketId === 'india') {
      marketData = await fetchIndiaData(symbol, 100, market);
    } else {
      marketData = generateSyntheticData(100);
    }
    const currentPrice = marketData[marketData.length - 1].close;

    const context = {
      marketData,
      newsData: [
        { symbol, text: 'Market showing positive momentum today', source: 'news' },
        { symbol, text: 'Analysts maintain buy rating', source: 'analyst' }
      ],
      symbols: [symbol],
      portfolio: {
        equity: capital,
        cash: capital,
        positions: {},
        assets: [symbol]
      },
      prices: { [symbol]: currentPrice },
      riskManager
    };

    console.log('Executing pipeline...');
    const result = await pipeline.execute(context);

    console.log();
    console.log('RESULTS:');
    console.log('─'.repeat(70));

    if (result.signals) {
      for (const [sym, signal] of Object.entries(result.signals)) {
        console.log(`${sym}: ${signal.direction.toUpperCase()}`);
        console.log(`  Strength: ${(signal.strength * 100).toFixed(1)}%`);
        console.log(`  Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
      }
    }

    if (result.orders && result.orders.length > 0) {
      console.log();
      console.log('ORDERS:');
      for (const order of result.orders) {
        const price = fmtPrice(order.price, market);
        // Round to whole shares for India
        const qty = marketId === 'india'
          ? Math.floor(order.quantity)
          : order.quantity;
        if (qty > 0) {
          console.log(`  ${order.side.toUpperCase()} ${qty} ${order.symbol} @ ${price}`);
        }
      }
    } else {
      console.log();
      console.log('No orders generated');
    }

    console.log();
    console.log(`Pipeline latency: ${result.metrics.totalLatency.toFixed(2)}ms`);

    if (options.json) {
      console.log();
      console.log('JSON OUTPUT:');
      console.log(JSON.stringify(result, null, 2));
    }
  },

  backtest: async (options) => {
    const { market, symbol, capital, marketId } = resolveMarket(options);
    const tradingDays = market.calendar.tradingDaysPerYear;
    const days = parseInt(options.days) || tradingDays;

    console.log('═'.repeat(70));
    console.log(`NEURAL-TRADER: BACKTEST MODE ${marketId === 'india' ? '(NSE)' : ''}`);
    console.log('═'.repeat(70));
    console.log();

    console.log(`Market: ${market.name}`);
    console.log(`Symbol: ${symbol}`);
    console.log(`Period: ${days} trading days`);
    console.log(`Initial Capital: ${fmtPrice(capital, market)}`);
    console.log(`Risk-Free Rate: ${(market.riskFreeRate * 100).toFixed(1)}%`);
    console.log(`Trading Days/Year: ${tradingDays}`);
    console.log();

    const engine = new BacktestEngine({
      simulation: { initialCapital: capital, warmupPeriod: 50 },
      execution: { slippage: 0.001, commission: 0.001, marketImpact: 0.0005, fillRate: 1.0 },
      riskFreeRate: market.riskFreeRate || 0.05,
      tradingDaysPerYear: tradingDays
    });

    // Fetch real data for India, synthetic for US demo
    let historicalData;
    if (marketId === 'india') {
      historicalData = await fetchIndiaData(symbol, days, market);
    } else {
      historicalData = generateSyntheticData(days);
    }

    console.log('Running backtest...');
    const results = await engine.run(historicalData, {
      symbols: [symbol],
      newsData: [
        { symbol, text: 'Positive market sentiment', source: 'news' }
      ]
    });

    console.log(engine.generateReport(results));

    // Show India-specific cost info
    if (marketId === 'india' && results.trades && results.trades.length > 0) {
      const { calculateIndianTransactionCosts } = await import('./config/markets/india.js');
      let totalCosts = 0;
      const product = options.product || 'CNC';

      for (const trade of results.trades) {
        const orderValue = Math.abs(trade.quantity * trade.price);
        const side = trade.quantity > 0 ? 'BUY' : 'SELL';
        const costs = calculateIndianTransactionCosts(orderValue, side, product, market.costs);
        totalCosts += costs.total;
      }

      console.log();
      console.log('INDIA TRANSACTION COSTS:');
      console.log('─'.repeat(70));
      console.log(`Product Type: ${product}`);
      console.log(`Total Trades: ${results.trades.length}`);
      console.log(`Total Costs: ${fmtPrice(totalCosts, market)}`);
      console.log(`Cost as % of Capital: ${((totalCosts / capital) * 100).toFixed(3)}%`);
    }

    if (options.output) {
      const fs = await import('fs');
      fs.writeFileSync(options.output, JSON.stringify(results, null, 2));
      console.log(`Results saved to ${options.output}`);
    }
  },

  paper: async (options) => {
    const { market, calendar, symbol, capital, marketId } = resolveMarket(options);
    const product = options.product || (marketId === 'india' ? 'CNC' : null);
    const interval = parseInt(options.interval) || 5000;

    console.log('═'.repeat(70));
    console.log(`NEURAL-TRADER: PAPER TRADING ${marketId === 'india' ? '(NSE - ' + (product || 'CNC') + ')' : ''}`);
    console.log('═'.repeat(70));
    console.log();

    console.log(`Market: ${market.name}`);
    console.log(`Symbol: ${symbol}`);
    console.log(`Capital: ${fmtPrice(capital, market)}`);
    if (product) console.log(`Product: ${product}`);
    console.log(`Update interval: ${interval}ms`);

    if (marketId === 'india') {
      const isOpen = calendar.isMarketOpen(new Date());
      if (!isOpen) {
        const nextOpen = calendar.getNextMarketOpen(new Date());
        console.log();
        console.log(`NSE is currently CLOSED.`);
        console.log(`Next open: ${nextOpen.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
        console.log(`Running with simulated price data...`);
      } else {
        const ttc = calendar.timeToClose(new Date());
        const minsLeft = Math.floor(ttc / 60000);
        console.log(`NSE: OPEN (${minsLeft} min until close)`);
        if (product === 'MIS') {
          const tts = calendar.timeToSquareOff(new Date());
          if (tts > 0) {
            console.log(`MIS auto-square-off in ${Math.floor(tts / 60000)} min`);
          }
        }
      }
    }

    console.log();
    console.log('Press Ctrl+C to stop');
    console.log();

    const pipeline = createTradingPipeline();
    const riskManager = new RiskManager();
    riskManager.startDay(capital);

    let portfolio = {
      equity: capital,
      cash: capital,
      positions: {},
      assets: [symbol]
    };

    // Seed price history - try real data for India
    let priceHistory;
    if (marketId === 'india') {
      priceHistory = await fetchIndiaData(symbol, 100, market);
    } else {
      priceHistory = generateSyntheticData(100);
    }

    let iteration = 0;
    let totalTradingCosts = 0;

    // For India paper mode, try to init broker in paper mode
    let broker = null;
    if (marketId === 'india') {
      try {
        const { KiteConnectBroker } = await import('./advanced/live-broker-kite.js');
        broker = new KiteConnectBroker({
          kite: {
            apiKey: process.env.KITE_API_KEY || '',
            apiSecret: process.env.KITE_API_SECRET || '',
            accessToken: process.env.KITE_ACCESS_TOKEN || '',
            paper: true,
            tier: process.env.KITE_TIER || 'free'
          },
          risk: {
            maxOrderValue: market.riskLimits?.maxPositionValue || 500000,
            maxDailyLoss: 25000,
            maxPositionPct: market.riskLimits?.maxPositionSizePct || 0.10,
            requireConfirmation: false
          },
          execution: {
            defaultProduct: product || 'CNC',
            defaultValidity: 'DAY',
            slippageTolerance: 0.001,
            retryAttempts: 3,
            retryDelayMs: 1000
          }
        });
        await broker.connect();
        console.log();
      } catch (err) {
        if (options.verbose) console.warn(`Broker init skipped: ${err.message}`);
      }
    }

    // MIS auto-square-off timer for India
    let squareOffTimeout = null;
    if (marketId === 'india' && product === 'MIS' && calendar.isMarketOpen(new Date())) {
      const tts = calendar.timeToSquareOff(new Date());
      if (tts > 0) {
        squareOffTimeout = setTimeout(() => {
          console.log();
          console.log('═'.repeat(70));
          console.log('[15:15 IST] MIS AUTO-SQUARE-OFF');
          console.log('═'.repeat(70));
          for (const [sym, qty] of Object.entries(portfolio.positions)) {
            if (qty !== 0) {
              const price = priceHistory[priceHistory.length - 1].close;
              console.log(`  Closing ${sym}: ${qty > 0 ? 'SELL' : 'BUY'} ${Math.abs(qty)} @ ${fmtPrice(price, market)}`);
              portfolio.cash += qty * price;
              portfolio.positions[sym] = 0;
            }
          }
          portfolio.equity = portfolio.cash;
          console.log(`  Post-square-off equity: ${fmtPrice(portfolio.equity, market)}`);
        }, tts);
      }
    }

    const tick = async () => {
      iteration++;

      // Simulate price movement
      const lastPrice = priceHistory[priceHistory.length - 1].close;

      // Try live quote for India during market hours
      let newPrice;
      if (marketId === 'india' && calendar.isMarketOpen(new Date()) && iteration % 6 === 0) {
        // Every ~30s, try a live quote
        const quote = await fetchIndiaQuote(symbol);
        newPrice = quote?.price || lastPrice * (1 + (Math.random() - 0.48) * 0.01);
      } else {
        newPrice = lastPrice * (1 + (Math.random() - 0.48) * 0.01);
      }

      priceHistory.push({
        date: new Date(),
        open: lastPrice,
        high: Math.max(lastPrice, newPrice) * 1.002,
        low: Math.min(lastPrice, newPrice) * 0.998,
        close: newPrice,
        volume: 1000000
      });

      if (priceHistory.length > 200) {
        priceHistory = priceHistory.slice(-200);
      }

      const context = {
        marketData: priceHistory,
        newsData: [],
        symbols: [symbol],
        portfolio,
        prices: { [symbol]: newPrice },
        riskManager
      };

      try {
        const result = await pipeline.execute(context);

        // Update portfolio based on positions
        portfolio.equity = portfolio.cash;
        for (const [sym, qty] of Object.entries(portfolio.positions)) {
          portfolio.equity += qty * newPrice;
        }

        const pnl = portfolio.equity - capital;
        const pnlPercent = (pnl / capital) * 100;
        const pnlSign = pnl >= 0 ? '+' : '';

        const time = marketId === 'india'
          ? new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
          : new Date().toLocaleTimeString();

        console.log(`[${time}] Price: ${fmtPrice(newPrice, market)} | Equity: ${fmtPrice(portfolio.equity, market)} | P&L: ${pnlSign}${fmtPrice(pnl, market)} (${pnlPercent.toFixed(2)}%)`);

        if (result.signals?.[symbol]) {
          const signal = result.signals[symbol];
          if (signal.direction !== 'neutral') {
            // For India, compute order with whole shares and transaction costs
            if (marketId === 'india') {
              const positionSize = capital * 0.05 * signal.strength; // 5% max per signal
              const qty = Math.floor(positionSize / newPrice);
              if (qty > 0) {
                const { calculateIndianTransactionCosts } = await import('./config/markets/india.js');
                const orderValue = qty * newPrice;
                const costs = calculateIndianTransactionCosts(
                  orderValue,
                  signal.direction === 'long' ? 'BUY' : 'SELL',
                  product || 'CNC',
                  market.costs
                );
                totalTradingCosts += costs.total;
                console.log(`  Signal: ${signal.direction.toUpperCase()} ${qty} shares @ ${fmtPrice(newPrice, market)} (cost: ${fmtPrice(costs.total, market)})`);
              }
            } else {
              console.log(`  Signal: ${signal.direction.toUpperCase()} (${(signal.strength * 100).toFixed(0)}%)`);
            }
          }
        }

        console.log();
      } catch (error) {
        console.error(`  Error: ${error.message}`);
      }
    };

    // Run paper trading loop
    const intervalId = setInterval(tick, interval);

    // Initial tick
    await tick();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(intervalId);
      if (squareOffTimeout) clearTimeout(squareOffTimeout);
      console.log();
      console.log('─'.repeat(70));
      console.log('Paper trading session ended');
      console.log(`Market: ${market.name}`);
      console.log(`Final equity: ${fmtPrice(portfolio.equity, market)}`);
      console.log(`Total P&L: ${fmtPrice(portfolio.equity - capital, market)}`);
      if (marketId === 'india' && totalTradingCosts > 0) {
        console.log(`Total transaction costs: ${fmtPrice(totalTradingCosts, market)}`);
      }
      process.exit(0);
    });
  },

  analyze: async (options) => {
    const { market, symbol, capital, marketId } = resolveMarket(options);

    console.log('═'.repeat(70));
    console.log(`NEURAL-TRADER: ANALYSIS MODE ${marketId === 'india' ? '(NSE)' : ''}`);
    console.log('═'.repeat(70));
    console.log();

    console.log(`Market: ${market.name}`);
    console.log(`Analyzing ${symbol}...`);
    console.log();

    // Import modules
    const { LexiconAnalyzer, EmbeddingAnalyzer } = await import('./production/sentiment-alpha.js');
    const { FeatureExtractor, HybridLSTMTransformer } = await import('./production/hybrid-lstm-transformer.js');

    const lexicon = new LexiconAnalyzer();
    const embedding = new EmbeddingAnalyzer();
    const featureExtractor = new FeatureExtractor();
    const lstm = new HybridLSTMTransformer();

    // Fetch real data for India, synthetic for US demo
    let marketData;
    if (marketId === 'india') {
      marketData = await fetchIndiaData(symbol, 100, market);
    } else {
      marketData = generateSyntheticData(100);
    }
    const features = featureExtractor.extract(marketData);

    console.log('TECHNICAL ANALYSIS:');
    console.log('─'.repeat(70));

    const prediction = lstm.predict(features);
    console.log(`LSTM Prediction: ${prediction.signal}`);
    console.log(`Direction: ${prediction.direction}`);
    console.log(`Confidence: ${(prediction.confidence * 100).toFixed(1)}%`);

    console.log();
    console.log('SENTIMENT ANALYSIS:');
    console.log('─'.repeat(70));

    const sampleNews = marketId === 'india'
      ? [
        `${symbol} reports strong quarterly earnings beating estimates`,
        `SEBI tightens FPI rules affecting market sentiment`,
        `Nifty 50 hits all-time high led by banking stocks`
      ]
      : [
        'Strong earnings beat analyst expectations with revenue growth',
        'Company faces regulatory headwinds',
        'Quarterly results in line with market estimates'
      ];

    for (const text of sampleNews) {
      const result = lexicon.analyze(text);
      const sentiment = result.score > 0.2 ? 'Positive' : result.score < -0.2 ? 'Negative' : 'Neutral';
      console.log(`"${text.slice(0, 55)}..."`);
      console.log(`  → ${sentiment} (score: ${result.score.toFixed(2)})`);
    }

    console.log();
    console.log('RISK METRICS:');
    console.log('─'.repeat(70));

    const tradingDays = market.calendar.tradingDaysPerYear;
    const metrics = new PerformanceMetrics(market.riskFreeRate, tradingDays);
    const equityCurve = marketData.map(d => d.close * 1000);
    const perf = metrics.calculate(equityCurve);

    console.log(`Risk-Free Rate: ${(market.riskFreeRate * 100).toFixed(1)}% (${marketId === 'india' ? 'RBI repo' : 'US Treasury'})`);
    console.log(`Trading Days/Year: ${tradingDays}`);
    console.log(`Volatility (Ann.): ${(perf.annualizedVolatility * 100).toFixed(2)}%`);
    console.log(`Max Drawdown: ${(perf.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`Sharpe Ratio: ${perf.sharpeRatio.toFixed(2)}`);

    // Show transaction cost estimate for India
    if (marketId === 'india') {
      const { calculateIndianTransactionCosts } = await import('./config/markets/india.js');
      const price = marketData[marketData.length - 1].close;
      const product = options.product || 'CNC';

      console.log();
      console.log('TRANSACTION COST ESTIMATE:');
      console.log('─'.repeat(70));

      for (const side of ['BUY', 'SELL']) {
        const orderValue = 100 * price; // 100 shares
        const costs = calculateIndianTransactionCosts(orderValue, side, product, market.costs);
        console.log(`  ${product} ${side} 100 shares @ ${fmtPrice(price, market)}`);
        console.log(`    Total Cost: ${fmtPrice(costs.total, market)} (${(costs.totalPercent * 100).toFixed(4)}%)`);
      }
    }
  },

  benchmark: async (options) => {
    console.log('═'.repeat(70));
    console.log('NEURAL-TRADER: BENCHMARK MODE');
    console.log('═'.repeat(70));
    console.log();

    const iterations = parseInt(options.iterations) || 100;

    console.log(`Running ${iterations} iterations...`);
    console.log();

    // Import all modules
    const { KellyCriterion } = await import('./production/fractional-kelly.js');
    const { LSTMCell, HybridLSTMTransformer } = await import('./production/hybrid-lstm-transformer.js');
    const { NeuralNetwork, ReplayBuffer } = await import('./production/drl-portfolio-manager.js');
    const { LexiconAnalyzer } = await import('./production/sentiment-alpha.js');
    const { PerformanceMetrics } = await import('./system/backtesting.js');

    const results = {};

    // Benchmark Kelly
    const kelly = new KellyCriterion();
    let start = performance.now();
    for (let i = 0; i < iterations; i++) {
      kelly.calculateFractionalKelly(0.55 + Math.random() * 0.1, 2.0);
    }
    results.kelly = (performance.now() - start) / iterations;

    // Benchmark LSTM Cell
    const cell = new LSTMCell(10, 64);
    const x = new Array(10).fill(0.1);
    const h = new Array(64).fill(0);
    const c = new Array(64).fill(0);
    start = performance.now();
    for (let i = 0; i < iterations; i++) {
      cell.forward(x, h, c);
    }
    results.lstmCell = (performance.now() - start) / iterations;

    // Benchmark Neural Network
    const net = new NeuralNetwork([62, 128, 10]);
    const state = new Array(62).fill(0.5);
    start = performance.now();
    for (let i = 0; i < iterations; i++) {
      net.forward(state);
    }
    results.neuralNet = (performance.now() - start) / iterations;

    // Benchmark Lexicon
    const lexicon = new LexiconAnalyzer();
    const text = 'Strong earnings growth beat analyst expectations with positive revenue outlook';
    start = performance.now();
    for (let i = 0; i < iterations; i++) {
      lexicon.analyze(text);
    }
    results.lexicon = (performance.now() - start) / iterations;

    // Benchmark Metrics
    const metrics = new PerformanceMetrics();
    const equityCurve = new Array(252).fill(100000).map((v, i) => v * (1 + (Math.random() - 0.5) * 0.02 * i / 252));
    start = performance.now();
    for (let i = 0; i < iterations; i++) {
      metrics.calculate(equityCurve);
    }
    results.metrics = (performance.now() - start) / iterations;

    console.log('BENCHMARK RESULTS:');
    console.log('─'.repeat(70));
    console.log(`Kelly Criterion:    ${results.kelly.toFixed(3)}ms (${(1000 / results.kelly).toFixed(0)}/s)`);
    console.log(`LSTM Cell:          ${results.lstmCell.toFixed(3)}ms (${(1000 / results.lstmCell).toFixed(0)}/s)`);
    console.log(`Neural Network:     ${results.neuralNet.toFixed(3)}ms (${(1000 / results.neuralNet).toFixed(0)}/s)`);
    console.log(`Lexicon Analyzer:   ${results.lexicon.toFixed(3)}ms (${(1000 / results.lexicon).toFixed(0)}/s)`);
    console.log(`Metrics Calculator: ${results.metrics.toFixed(3)}ms (${(1000 / results.metrics).toFixed(0)}/s)`);
  }
};

// Main entry point
async function main() {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  if (commands[command]) {
    try {
      await commands[command](options);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    commands.help();
    process.exit(1);
  }
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}

export { commands, parseArgs };
