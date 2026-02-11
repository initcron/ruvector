/**
 * Live Broker Integration - Zerodha Kite Connect
 *
 * PRACTICAL: Production-ready live trading with Kite Connect (NSE/BSE)
 *
 * Features:
 * - Dual mode: paper (simulated) and live (real Kite API)
 * - Indian market transaction cost calculation (brokerage, STT, GST, stamp duty)
 * - MIS auto square-off timer (15:15 IST)
 * - Smart order routing with no fractional shares
 * - Risk checks calibrated for INR and Indian market limits
 * - Position management and P&L tracking in INR
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatINR(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KiteOrderType = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL-M' };
const KiteProductType = { MIS: 'MIS', CNC: 'CNC', NRML: 'NRML' };
const KiteExchange = { NSE: 'NSE', BSE: 'BSE', NFO: 'NFO', MCX: 'MCX' };
const OrderSide = { BUY: 'BUY', SELL: 'SELL' };

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const kiteConfig = {
  kite: {
    apiKey: process.env.KITE_API_KEY || '',
    apiSecret: process.env.KITE_API_SECRET || '',
    accessToken: process.env.KITE_ACCESS_TOKEN || '',
    paper: true,     // true = simulated fills, false = real Kite API
    tier: 'free'     // 'free' or 'connect'
  },
  risk: {
    maxOrderValue: 500000,     // Rs 5 lakh
    maxDailyLoss: 25000,       // Rs 25,000
    maxPositionPct: 0.10,      // 10% of portfolio
    requireConfirmation: false
  },
  execution: {
    defaultProduct: 'CNC',
    defaultValidity: 'DAY',
    slippageTolerance: 0.001,
    retryAttempts: 3,
    retryDelayMs: 1000
  }
};

// Transaction cost structure (Zerodha-style)
const COST_STRUCTURE = {
  brokerage: {
    intraday: { type: 'flat_or_percent', flat: 20, percent: 0.0003 },
    delivery: 0,
    fno: { type: 'flat', flat: 20 }
  },
  stt: {
    intradayBuy: 0,
    intradaySell: 0.00025,   // 0.025% on sell side
    deliveryBuy: 0.001,      // 0.1%
    deliverySell: 0.001      // 0.1%
  },
  exchangeTxnCharge: 0.0000345,  // 0.00345%
  gst: 0.18,                     // 18% on brokerage + exchange txn charges
  sebi: 0.000001,                // Rs 10 per crore
  stampDuty: {
    buy: 0.00015,                // 0.015% (buy side)
    sell: 0
  }
};

// Mock Indian stock prices for paper mode
const MOCK_PRICES = {
  RELIANCE:  2800,
  TCS:       4200,
  INFY:      1800,
  HDFCBANK:  1700,
  ICICIBANK: 1300,
  SBIN:       820,
  BHARTIARTL: 1600,
  ITC:        470,
  KOTAKBANK: 1780,
  LT:        3600
};

// ---------------------------------------------------------------------------
// KiteConnectBroker
// ---------------------------------------------------------------------------

class KiteConnectBroker {
  constructor(config = kiteConfig) {
    this.config = config;
    this.connected = false;
    this.account = null;
    this.positions = new Map();
    this.orders = new Map();
    this.dailyPnL = 0;
    this.tradeLog = [];
    this.kc = null; // KiteConnect SDK instance (live mode only)
    this._squareOffTimer = null;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  async connect() {
    const mode = this.config.kite.paper ? 'Paper' : 'Live';
    console.log(`Connecting to Kite Connect (${mode})...`);

    if (this.config.kite.paper) {
      await delay(300);
      this.connected = true;
    } else {
      // Live mode: lazy-load kiteconnect SDK
      try {
        const { KiteConnect } = await import('kiteconnect');
        this.kc = new KiteConnect({ api_key: this.config.kite.apiKey });

        if (!this.config.kite.accessToken) {
          throw new Error(
            'KITE_ACCESS_TOKEN is required for live mode. ' +
            'Generate one via kc.generateSession(requestToken, apiSecret).'
          );
        }

        this.kc.setAccessToken(this.config.kite.accessToken);

        // Validate the token by fetching profile
        const profile = await this.kc.getProfile();
        console.log(`Authenticated as: ${profile.user_name} (${profile.user_id})`);
        this.connected = true;
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
          throw new Error(
            'kiteconnect package not installed. Run: npm install kiteconnect'
          );
        }
        throw err;
      }
    }

    this.account = await this.getAccount();

    console.log(`Connected to Kite Connect (${mode})`);
    console.log(`Account: ${this.account.id}`);
    console.log(`Buying Power: ${formatINR(this.account.buyingPower)}`);
    console.log(`Portfolio Value: ${formatINR(this.account.portfolioValue)}`);

    await this.loadPositions();

    return this;
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  async getAccount() {
    if (this.config.kite.paper) {
      return {
        id: 'PAPER-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        status: 'ACTIVE',
        currency: 'INR',
        cash: 1000000,          // Rs 10 lakh
        portfolioValue: 1250000, // Rs 12.5 lakh
        buyingPower: 1000000,
        tradingBlocked: false
      };
    }

    // Live mode
    const profile = await this.kc.getProfile();
    const margins = await this.kc.getMargins('equity');

    const cash = margins.available?.cash ?? margins.net ?? 0;
    const collateral = margins.available?.collateral ?? 0;

    return {
      id: profile.user_id,
      status: 'ACTIVE',
      currency: 'INR',
      cash,
      portfolioValue: cash + collateral,
      buyingPower: cash,
      tradingBlocked: false
    };
  }

  // -------------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------------

  async loadPositions() {
    if (this.config.kite.paper) {
      const mockPositions = [
        { symbol: 'RELIANCE', qty: 50, avgEntryPrice: 2750, currentPrice: 2800, product: 'CNC', exchange: 'NSE' },
        { symbol: 'TCS',      qty: 20, avgEntryPrice: 4100, currentPrice: 4200, product: 'CNC', exchange: 'NSE' },
        { symbol: 'INFY',     qty: 100, avgEntryPrice: 1760, currentPrice: 1800, product: 'CNC', exchange: 'NSE' }
      ];

      mockPositions.forEach(pos => {
        pos.unrealizedPL = (pos.currentPrice - pos.avgEntryPrice) * pos.qty;
        this.positions.set(pos.symbol, pos);
      });
    } else {
      const resp = await this.kc.getPositions();
      const netPositions = resp.net || [];

      netPositions.forEach(pos => {
        if (pos.quantity === 0) return;
        this.positions.set(pos.tradingsymbol, {
          symbol: pos.tradingsymbol,
          qty: Math.abs(pos.quantity),
          avgEntryPrice: pos.average_price,
          currentPrice: pos.last_price || pos.close_price,
          unrealizedPL: pos.pnl,
          product: pos.product,
          exchange: pos.exchange
        });
      });
    }

    console.log(`Loaded ${this.positions.size} existing positions`);
  }

  // -------------------------------------------------------------------------
  // Pre-trade risk checks
  // -------------------------------------------------------------------------

  preTradeCheck(order) {
    const errors = [];

    if (this.account.tradingBlocked) {
      errors.push('Trading is blocked on this account');
    }

    // Validate product type
    const product = order.product || this.config.execution.defaultProduct;
    if (!['MIS', 'CNC', 'NRML'].includes(product)) {
      errors.push(`Invalid product type: ${product}. Must be MIS, CNC, or NRML.`);
    }

    // Round quantity to whole shares (no fractional trading on Indian exchanges)
    order.qty = Math.floor(order.qty);
    if (order.qty <= 0) {
      errors.push('Quantity must be at least 1 (no fractional shares on Indian exchanges)');
    }

    // Order value check
    const estimatedPrice = order.limitPrice || order.estimatedPrice || MOCK_PRICES[order.symbol] || 1000;
    const orderValue = order.qty * estimatedPrice;

    if (orderValue > this.config.risk.maxOrderValue) {
      errors.push(
        `Order value ${formatINR(orderValue)} exceeds limit ${formatINR(this.config.risk.maxOrderValue)}`
      );
    }

    // Daily loss limit
    if (this.dailyPnL < -this.config.risk.maxDailyLoss) {
      errors.push(
        `Daily loss limit reached: ${formatINR(Math.abs(this.dailyPnL))} (max ${formatINR(this.config.risk.maxDailyLoss)})`
      );
    }

    // Position concentration
    const concentration = orderValue / this.account.portfolioValue;
    if (concentration > this.config.risk.maxPositionPct) {
      errors.push(
        `Position would be ${(concentration * 100).toFixed(1)}% of portfolio ` +
        `(max ${this.config.risk.maxPositionPct * 100}%)`
      );
    }

    // Buying power
    if (order.side === OrderSide.BUY && orderValue > this.account.buyingPower) {
      errors.push(
        `Insufficient buying power: need ${formatINR(orderValue)}, have ${formatINR(this.account.buyingPower)}`
      );
    }

    return {
      approved: errors.length === 0,
      errors,
      orderValue,
      concentration
    };
  }

  // -------------------------------------------------------------------------
  // Order submission
  // -------------------------------------------------------------------------

  async submitOrder(order) {
    const sideLabel = (order.side || '').toUpperCase();
    console.log(`\nSubmitting order: ${sideLabel} ${order.qty} ${order.symbol}`);

    // Pre-trade risk check
    const riskCheck = this.preTradeCheck(order);

    if (!riskCheck.approved) {
      console.log('Order REJECTED by risk check:');
      riskCheck.errors.forEach(err => console.log(`   - ${err}`));
      return { success: false, errors: riskCheck.errors };
    }

    console.log('Risk check passed');

    const product = order.product || this.config.execution.defaultProduct;
    const orderType = order.type || KiteOrderType.MARKET;
    const validity = order.validity || this.config.execution.defaultValidity;
    const exchange = order.exchange || KiteExchange.NSE;

    if (this.config.kite.paper) {
      // ----- Paper mode -----
      const orderId = 'KITE-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const submittedOrder = {
        id: orderId,
        symbol: order.symbol,
        qty: order.qty,
        side: order.side,
        type: orderType,
        product,
        validity,
        exchange,
        status: 'OPEN',
        createdAt: new Date().toISOString(),
        filledQty: 0,
        filledAvgPrice: null,
        limitPrice: order.limitPrice || null,
        triggerPrice: order.triggerPrice || null
      };

      this.orders.set(orderId, submittedOrder);
      console.log(`Order submitted: ${orderId}`);

      // Simulate fill
      await this._simulateFill(submittedOrder, order.estimatedPrice);

      return { success: true, orderId, order: submittedOrder };
    }

    // ----- Live mode -----
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.execution.retryAttempts; attempt++) {
      try {
        const params = {
          tradingsymbol: order.symbol,
          exchange,
          transaction_type: order.side,
          order_type: orderType,
          quantity: order.qty,
          product,
          validity
        };

        if (order.limitPrice) params.price = order.limitPrice;
        if (order.triggerPrice) params.trigger_price = order.triggerPrice;

        const resp = await this.kc.placeOrder('regular', params);
        const orderId = resp.order_id;

        const submittedOrder = {
          id: orderId,
          symbol: order.symbol,
          qty: order.qty,
          side: order.side,
          type: orderType,
          product,
          status: 'OPEN',
          createdAt: new Date().toISOString(),
          filledQty: 0,
          filledAvgPrice: null
        };

        this.orders.set(orderId, submittedOrder);
        console.log(`Order submitted: ${orderId}`);

        return { success: true, orderId, order: submittedOrder };
      } catch (err) {
        lastError = err;
        console.log(`Order attempt ${attempt} failed: ${err.message}`);
        if (attempt < this.config.execution.retryAttempts) {
          await delay(this.config.execution.retryDelayMs);
        }
      }
    }

    return { success: false, errors: [lastError?.message || 'Order submission failed'] };
  }

  async _simulateFill(order, estimatedPrice) {
    await delay(100 + Math.random() * 100);

    const basePrice = order.limitPrice
      || estimatedPrice
      || MOCK_PRICES[order.symbol]
      || 1000;

    const slippage = order.type === KiteOrderType.MARKET
      ? (Math.random() - 0.5) * basePrice * this.config.execution.slippageTolerance
      : 0;

    const fillPrice = Math.round((basePrice + slippage) * 100) / 100;

    order.status = 'COMPLETE';
    order.filledQty = order.qty;
    order.filledAvgPrice = fillPrice;
    order.filledAt = new Date().toISOString();

    this._updatePosition(order);

    console.log(`Order filled: ${order.qty} @ ${formatINR(fillPrice)}`);

    this.tradeLog.push({
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: fillPrice,
      product: order.product,
      timestamp: order.filledAt
    });
  }

  _updatePosition(filledOrder) {
    const symbol = filledOrder.symbol;
    const existing = this.positions.get(symbol);

    if (filledOrder.side === OrderSide.BUY) {
      if (existing) {
        const totalQty = existing.qty + filledOrder.filledQty;
        const totalCost =
          existing.qty * existing.avgEntryPrice +
          filledOrder.filledQty * filledOrder.filledAvgPrice;
        existing.qty = totalQty;
        existing.avgEntryPrice = totalCost / totalQty;
        existing.currentPrice = filledOrder.filledAvgPrice;
        existing.unrealizedPL = (existing.currentPrice - existing.avgEntryPrice) * existing.qty;
      } else {
        this.positions.set(symbol, {
          symbol,
          qty: filledOrder.filledQty,
          avgEntryPrice: filledOrder.filledAvgPrice,
          currentPrice: filledOrder.filledAvgPrice,
          unrealizedPL: 0,
          product: filledOrder.product,
          exchange: filledOrder.exchange || KiteExchange.NSE
        });
      }
    } else {
      // Sell
      if (existing) {
        const realizedPL =
          (filledOrder.filledAvgPrice - existing.avgEntryPrice) * filledOrder.filledQty;
        this.dailyPnL += realizedPL;
        console.log(`   Realized P&L: ${realizedPL >= 0 ? '+' : ''}${formatINR(realizedPL)}`);

        existing.qty -= filledOrder.filledQty;
        if (existing.qty <= 0) {
          this.positions.delete(symbol);
        } else {
          existing.unrealizedPL = (existing.currentPrice - existing.avgEntryPrice) * existing.qty;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cancel order
  // -------------------------------------------------------------------------

  async cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }

    if (order.status === 'COMPLETE') {
      return { success: false, error: 'Cannot cancel filled order' };
    }

    if (this.config.kite.paper) {
      order.status = 'CANCELLED';
      console.log(`Order ${orderId} cancelled`);
      return { success: true };
    }

    // Live mode
    try {
      await this.kc.cancelOrder('regular', orderId);
      order.status = 'CANCELLED';
      console.log(`Order ${orderId} cancelled`);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // Close position
  // -------------------------------------------------------------------------

  async closePosition(symbol) {
    const position = this.positions.get(symbol);
    if (!position) {
      return { success: false, error: `No position in ${symbol}` };
    }

    console.log(`Closing position: ${position.qty} ${symbol}`);

    return this.submitOrder({
      symbol,
      qty: position.qty,
      side: OrderSide.SELL,
      type: KiteOrderType.MARKET,
      product: position.product || this.config.execution.defaultProduct,
      exchange: position.exchange || KiteExchange.NSE,
      estimatedPrice: position.currentPrice
    });
  }

  // -------------------------------------------------------------------------
  // Quotes
  // -------------------------------------------------------------------------

  async getQuote(symbol) {
    if (this.config.kite.paper) {
      const basePrice = MOCK_PRICES[symbol] || (500 + Math.random() * 2000);
      const spread = basePrice * 0.0002;
      const jitter = (Math.random() - 0.5) * basePrice * 0.002;

      return {
        symbol,
        exchange: KiteExchange.NSE,
        bid: Math.round((basePrice - spread / 2 + jitter) * 100) / 100,
        ask: Math.round((basePrice + spread / 2 + jitter) * 100) / 100,
        last: Math.round((basePrice + jitter) * 100) / 100,
        volume: Math.floor(500000 + Math.random() * 5000000),
        timestamp: new Date().toISOString()
      };
    }

    // Live mode
    const instrument = 'NSE:' + symbol;
    const data = await this.kc.getQuote(instrument);
    const q = data[instrument];

    return {
      symbol,
      exchange: KiteExchange.NSE,
      bid: q.depth?.buy?.[0]?.price ?? q.last_price,
      ask: q.depth?.sell?.[0]?.price ?? q.last_price,
      last: q.last_price,
      volume: q.volume,
      timestamp: new Date().toISOString()
    };
  }

  // -------------------------------------------------------------------------
  // Portfolio summary
  // -------------------------------------------------------------------------

  getPortfolioSummary() {
    let totalValue = this.account.cash;
    let totalUnrealizedPL = 0;

    const positions = [];
    this.positions.forEach((pos, symbol) => {
      const marketValue = pos.qty * pos.currentPrice;
      totalValue += marketValue;
      totalUnrealizedPL += pos.unrealizedPL;

      positions.push({
        symbol,
        qty: pos.qty,
        avgEntry: pos.avgEntryPrice,
        current: pos.currentPrice,
        marketValue,
        unrealizedPL: pos.unrealizedPL,
        pnlPct: ((pos.currentPrice / pos.avgEntryPrice) - 1) * 100,
        product: pos.product || 'CNC'
      });
    });

    return {
      cash: this.account.cash,
      totalValue,
      unrealizedPL: totalUnrealizedPL,
      realizedPL: this.dailyPnL,
      positions,
      buyingPower: this.account.buyingPower,
      currency: 'INR'
    };
  }

  // -------------------------------------------------------------------------
  // Transaction cost calculation
  // -------------------------------------------------------------------------

  calculateTransactionCosts(orderValue, side, product = 'CNC') {
    const costs = COST_STRUCTURE;
    const isIntraday = product === 'MIS';

    // Brokerage
    let brokerage;
    if (isIntraday) {
      brokerage = Math.min(costs.brokerage.intraday.flat, orderValue * costs.brokerage.intraday.percent);
    } else {
      brokerage = costs.brokerage.delivery;
    }

    // STT
    let stt;
    if (isIntraday) {
      stt = side === OrderSide.SELL ? orderValue * costs.stt.intradaySell : 0;
    } else {
      stt = side === OrderSide.BUY
        ? orderValue * costs.stt.deliveryBuy
        : orderValue * costs.stt.deliverySell;
    }

    // Exchange transaction charges
    const exchangeTxn = orderValue * costs.exchangeTxnCharge;

    // GST (18% on brokerage + exchange txn charges)
    const gst = (brokerage + exchangeTxn) * costs.gst;

    // SEBI charges
    const sebi = orderValue * costs.sebi;

    // Stamp duty (buy side only)
    const stampDuty = side === OrderSide.BUY ? orderValue * costs.stampDuty.buy : 0;

    const total = brokerage + stt + exchangeTxn + gst + sebi + stampDuty;

    return {
      brokerage: Math.round(brokerage * 100) / 100,
      stt: Math.round(stt * 100) / 100,
      exchangeTxn: Math.round(exchangeTxn * 100) / 100,
      gst: Math.round(gst * 100) / 100,
      sebi: Math.round(sebi * 100) / 100,
      stampDuty: Math.round(stampDuty * 100) / 100,
      total: Math.round(total * 100) / 100,
      totalPercent: total / orderValue
    };
  }

  // -------------------------------------------------------------------------
  // MIS square-off
  // -------------------------------------------------------------------------

  async squareOffMIS() {
    console.log('\n--- MIS Square-off ---');
    const misPositions = [];

    this.positions.forEach((pos, symbol) => {
      if (pos.product === 'MIS' && pos.qty > 0) {
        misPositions.push({ symbol, qty: pos.qty, exchange: pos.exchange });
      }
    });

    if (misPositions.length === 0) {
      console.log('No open MIS positions to square off.');
      return { closed: 0 };
    }

    console.log(`Squaring off ${misPositions.length} MIS position(s)...`);

    const results = [];
    for (const pos of misPositions) {
      const result = await this.submitOrder({
        symbol: pos.symbol,
        qty: pos.qty,
        side: OrderSide.SELL,
        type: KiteOrderType.MARKET,
        product: 'MIS',
        exchange: pos.exchange || KiteExchange.NSE,
        estimatedPrice: this.positions.get(pos.symbol)?.currentPrice
      });
      results.push(result);
    }

    console.log(`Squared off ${results.filter(r => r.success).length} MIS position(s).`);
    return { closed: results.filter(r => r.success).length, results };
  }

  startAutoSquareOffTimer() {
    if (this._squareOffTimer) {
      clearTimeout(this._squareOffTimer);
    }

    const now = new Date();
    // Get current time in IST
    const istFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });

    const istParts = istFormatter.formatToParts(now);
    const istHour = parseInt(istParts.find(p => p.type === 'hour').value, 10);
    const istMinute = parseInt(istParts.find(p => p.type === 'minute').value, 10);
    const istSecond = parseInt(istParts.find(p => p.type === 'second').value, 10);

    const currentISTSeconds = istHour * 3600 + istMinute * 60 + istSecond;
    const targetISTSeconds = 15 * 3600 + 15 * 60; // 15:15 IST

    let msUntilSquareOff = (targetISTSeconds - currentISTSeconds) * 1000;
    if (msUntilSquareOff <= 0) {
      // Already past 15:15 IST today; schedule for tomorrow
      msUntilSquareOff += 24 * 3600 * 1000;
    }

    const targetTime = new Date(now.getTime() + msUntilSquareOff);
    const targetIST = targetTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`MIS auto square-off scheduled at 15:15 IST (${targetIST})`);
    console.log(`Time until square-off: ${Math.round(msUntilSquareOff / 60000)} minutes`);

    this._squareOffTimer = setTimeout(async () => {
      console.log('\n[AUTO] 15:15 IST - Executing MIS square-off...');
      await this.squareOffMIS();
    }, msUntilSquareOff);

    return { scheduledAt: targetIST, msRemaining: msUntilSquareOff };
  }

  stopAutoSquareOffTimer() {
    if (this._squareOffTimer) {
      clearTimeout(this._squareOffTimer);
      this._squareOffTimer = null;
      console.log('MIS auto square-off timer stopped.');
    }
  }
}

// ---------------------------------------------------------------------------
// IndianSmartOrderRouter
// ---------------------------------------------------------------------------

class IndianSmartOrderRouter {
  constructor(broker) {
    this.broker = broker;
  }

  async analyzeExecution(symbol, qty, side) {
    // No fractional shares on Indian exchanges
    qty = Math.floor(qty);

    const quote = await this.broker.getQuote(symbol);
    const spread = quote.ask - quote.bid;
    const spreadPct = spread / quote.last;

    // Determine order strategy
    let strategy = 'market';
    let limitPrice = null;

    if (spreadPct > 0.001) {
      // Wide spread - use limit order
      strategy = 'limit';
      limitPrice = side === OrderSide.BUY
        ? Math.round((quote.bid + spread * 0.3) * 100) / 100
        : Math.round((quote.ask - spread * 0.3) * 100) / 100;
    }

    // Check if we should slice the order
    const avgVolumePerMin = quote.volume / 375; // ~375 minutes in Indian trading day (09:15 - 15:30)
    const orderImpact = qty / avgVolumePerMin;
    const shouldSlice = orderImpact > 0.1;

    return {
      quote,
      spread,
      spreadPct,
      strategy,
      limitPrice,
      qty,
      shouldSlice,
      slices: shouldSlice ? Math.ceil(orderImpact / 0.1) : 1,
      estimatedSlippage: strategy === 'market' ? spreadPct / 2 : 0
    };
  }

  async execute(symbol, qty, side, options = {}) {
    qty = Math.floor(qty);
    const analysis = await this.analyzeExecution(symbol, qty, side);

    console.log('\nSmart Order Router Analysis:');
    console.log(`   Symbol: ${symbol} (NSE)`);
    console.log(`   Side: ${side}`);
    console.log(`   Qty: ${analysis.qty} shares`);
    console.log(`   Last: ${formatINR(analysis.quote.last)}`);
    console.log(`   Spread: ${formatINR(analysis.spread)} (${(analysis.spreadPct * 100).toFixed(3)}%)`);
    console.log(`   Strategy: ${analysis.strategy}`);
    if (analysis.limitPrice) {
      console.log(`   Limit Price: ${formatINR(analysis.limitPrice)}`);
    }
    console.log(`   Slicing: ${analysis.shouldSlice ? `Yes (${analysis.slices} orders)` : 'No'}`);

    const product = options.product || this.broker.config.execution.defaultProduct;

    // Execute
    if (!analysis.shouldSlice) {
      return this.broker.submitOrder({
        symbol,
        qty: analysis.qty,
        side,
        type: analysis.strategy === 'limit' ? KiteOrderType.LIMIT : KiteOrderType.MARKET,
        limitPrice: analysis.limitPrice,
        estimatedPrice: analysis.quote.last,
        product,
        exchange: KiteExchange.NSE
      });
    }

    // Sliced execution
    const sliceSize = Math.ceil(analysis.qty / analysis.slices);
    const results = [];

    console.log(`\n   Executing ${analysis.slices} slices of ~${sliceSize} shares each...`);

    for (let i = 0; i < analysis.slices; i++) {
      const sliceQty = Math.min(sliceSize, analysis.qty - (i * sliceSize));

      // Get fresh quote for each slice
      const freshQuote = await this.broker.getQuote(symbol);
      const freshSpread = freshQuote.ask - freshQuote.bid;
      const sliceLimitPrice = side === OrderSide.BUY
        ? Math.round((freshQuote.bid + freshSpread * 0.3) * 100) / 100
        : Math.round((freshQuote.ask - freshSpread * 0.3) * 100) / 100;

      const result = await this.broker.submitOrder({
        symbol,
        qty: sliceQty,
        side,
        type: KiteOrderType.LIMIT,
        limitPrice: sliceLimitPrice,
        estimatedPrice: freshQuote.last,
        product,
        exchange: KiteExchange.NSE
      });

      results.push(result);

      // Wait between slices
      if (i < analysis.slices - 1) {
        await delay(500);
      }
    }

    return { success: true, slices: results };
  }
}

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('LIVE BROKER INTEGRATION - Zerodha Kite Connect (NSE/BSE)');
  console.log('='.repeat(70));
  console.log();

  // 1. Connect to broker (paper mode)
  const broker = new KiteConnectBroker(kiteConfig);
  await broker.connect();
  console.log();

  // 2. Display current positions
  console.log('Current Positions:');
  console.log('-'.repeat(80));
  const summary = broker.getPortfolioSummary();

  console.log(
    'Symbol'.padEnd(12) + ' | ' +
    'Qty'.padStart(5) + ' | ' +
    'Avg Entry'.padStart(12) + ' | ' +
    'Current'.padStart(12) + ' | ' +
    'Market Value'.padStart(14) + ' | ' +
    'P&L'.padStart(12)
  );
  console.log('-'.repeat(80));

  summary.positions.forEach(pos => {
    const plStr = pos.unrealizedPL >= 0
      ? `+${formatINR(pos.unrealizedPL)}`
      : formatINR(pos.unrealizedPL);
    console.log(
      pos.symbol.padEnd(12) + ' | ' +
      pos.qty.toString().padStart(5) + ' | ' +
      formatINR(pos.avgEntry).padStart(12) + ' | ' +
      formatINR(pos.current).padStart(12) + ' | ' +
      formatINR(pos.marketValue).padStart(14) + ' | ' +
      plStr.padStart(12)
    );
  });

  console.log('-'.repeat(80));
  console.log(
    `Cash: ${formatINR(summary.cash)} | ` +
    `Total: ${formatINR(summary.totalValue)} | ` +
    `Unrealized P&L: ${formatINR(summary.unrealizedPL)}`
  );
  console.log();

  // 3. Smart order routing
  console.log('Smart Order Router Demo:');
  console.log('-'.repeat(70));

  const router = new IndianSmartOrderRouter(broker);

  // Buy some RELIANCE
  await router.execute('RELIANCE', 10, OrderSide.BUY);
  console.log();

  // Larger order for HDFCBANK (may be sliced)
  await router.execute('HDFCBANK', 200, OrderSide.BUY);
  console.log();

  // 4. Risk-rejected order demo
  console.log('Risk Check Demo (order value too high):');
  console.log('-'.repeat(70));

  await broker.submitOrder({
    symbol: 'TCS',
    qty: 200,
    side: OrderSide.BUY,
    type: KiteOrderType.MARKET,
    estimatedPrice: 4200  // 200 * 4200 = Rs 8,40,000 > Rs 5,00,000 limit
  });
  console.log();

  // 5. Transaction cost calculation demo
  console.log('Transaction Cost Calculation:');
  console.log('-'.repeat(70));

  const scenarios = [
    { label: 'Delivery BUY  - RELIANCE 50 shares @ Rs 2,800',  value: 50 * 2800,  side: OrderSide.BUY,  product: 'CNC' },
    { label: 'Delivery SELL - RELIANCE 50 shares @ Rs 2,800',  value: 50 * 2800,  side: OrderSide.SELL, product: 'CNC' },
    { label: 'Intraday BUY  - INFY 100 shares @ Rs 1,800',     value: 100 * 1800, side: OrderSide.BUY,  product: 'MIS' },
    { label: 'Intraday SELL - INFY 100 shares @ Rs 1,800',     value: 100 * 1800, side: OrderSide.SELL, product: 'MIS' }
  ];

  scenarios.forEach(s => {
    const costs = broker.calculateTransactionCosts(s.value, s.side, s.product);
    console.log(`\n  ${s.label}`);
    console.log(`    Order Value:     ${formatINR(s.value)}`);
    console.log(`    Brokerage:       ${formatINR(costs.brokerage)}`);
    console.log(`    STT:             ${formatINR(costs.stt)}`);
    console.log(`    Exchange Txn:    ${formatINR(costs.exchangeTxn)}`);
    console.log(`    GST:             ${formatINR(costs.gst)}`);
    console.log(`    SEBI:            ${formatINR(costs.sebi)}`);
    console.log(`    Stamp Duty:      ${formatINR(costs.stampDuty)}`);
    console.log(`    -----------------------`);
    console.log(`    Total Cost:      ${formatINR(costs.total)} (${(costs.totalPercent * 100).toFixed(4)}%)`);
  });
  console.log();

  // 6. Final portfolio summary
  console.log('Final Portfolio Summary:');
  console.log('-'.repeat(70));

  const finalSummary = broker.getPortfolioSummary();
  console.log(`Positions:      ${finalSummary.positions.length}`);
  console.log(`Cash:           ${formatINR(finalSummary.cash)}`);
  console.log(`Total Value:    ${formatINR(finalSummary.totalValue)}`);
  console.log(`Unrealized P&L: ${formatINR(finalSummary.unrealizedPL)}`);
  console.log(`Realized P&L:   ${broker.dailyPnL >= 0 ? '+' : ''}${formatINR(broker.dailyPnL)}`);
  console.log(`Trades Today:   ${broker.tradeLog.length}`);
  console.log(`Buying Power:   ${formatINR(finalSummary.buyingPower)}`);
  console.log();

  console.log('='.repeat(70));
  console.log('Kite Connect broker integration demo completed');
  console.log('='.repeat(70));

  // Clean up any timers
  broker.stopAutoSquareOffTimer();
}

main().catch(console.error);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  KiteConnectBroker,
  IndianSmartOrderRouter,
  KiteOrderType,
  KiteProductType,
  KiteExchange,
  OrderSide,
  COST_STRUCTURE,
  MOCK_PRICES,
  kiteConfig,
  formatINR,
  delay
};
