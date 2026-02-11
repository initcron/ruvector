/**
 * India Market Data Connectors
 *
 * Extends the data connector system with India-specific sources:
 * - Yahoo Finance India (free, NSE/BSE symbols)
 * - Kite Connect (paid tier, real-time via Zerodha)
 *
 * Features:
 * - Automatic NSE/BSE symbol normalization
 * - LRU caching and rate limiting
 * - Kite Connect WebSocket tick subscription
 * - Fallback orchestration between free and paid sources
 */

// ---------------------------------------------------------------------------
// Shared utilities (self-contained so we don't depend on export shape of
// data-connectors.js — the base classes aren't reliably importable)
// ---------------------------------------------------------------------------

class LRUCache {
  constructor(maxSize = 1000, ttl = 60000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    // Move to end (most recent)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }
}

class RateLimiter {
  constructor(requestsPerMinute) {
    this.requestsPerMinute = requestsPerMinute;
    this.requests = [];
  }

  async acquire() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < 60000);

    if (this.requests.length >= this.requestsPerMinute) {
      const waitTime = 60000 - (now - this.requests[0]);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.acquire();
    }

    this.requests.push(now);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const indiaConnectorConfig = {
  rateLimits: {
    yahooIndia: 100,
    kite: 200
  },
  cache: {
    enabled: true,
    ttl: 60000,
    maxSize: 1000
  },
  retry: {
    maxRetries: 3,
    backoffMs: 1000
  }
};

// ---------------------------------------------------------------------------
// YahooFinanceIndiaConnector
// ---------------------------------------------------------------------------

const EXCHANGE_SUFFIX = {
  NSE: '.NS',
  BSE: '.BO'
};

class YahooFinanceIndiaConnector {
  constructor(config = {}) {
    this.exchange = config.exchange || 'NSE';
    this.suffix = EXCHANGE_SUFFIX[this.exchange] || EXCHANGE_SUFFIX.NSE;

    const merged = { ...indiaConnectorConfig, ...config };
    this.cacheEnabled = merged.cache?.enabled ?? true;
    this.cache = new LRUCache(
      merged.cache?.maxSize ?? 1000,
      merged.cache?.ttl ?? 60000
    );
    this.rateLimiter = new RateLimiter(
      merged.rateLimits?.yahooIndia ?? 100
    );
    this.retryConfig = merged.retry || indiaConnectorConfig.retry;
    this.baseUrl = 'https://query1.finance.yahoo.com/v8/finance';
    this.searchUrl = 'https://query1.finance.yahoo.com/v1/finance/search';
  }

  // ---- Symbol handling ----------------------------------------------------

  /**
   * Appends the exchange suffix (.NS or .BO) if not already present.
   */
  _normalizeSymbol(symbol) {
    if (symbol.endsWith('.NS') || symbol.endsWith('.BO')) {
      return symbol;
    }
    return `${symbol}${this.suffix}`;
  }

  // ---- Internal fetch with cache / rate-limit / retry ---------------------

  async _fetchWithRetry(url, source = 'yahooIndia') {
    const cacheKey = `${source}:${url}`;

    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    await this.rateLimiter.acquire();

    let lastError;
    for (let i = 0; i < this.retryConfig.maxRetries; i++) {
      try {
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (this.cacheEnabled) {
          this.cache.set(cacheKey, data);
        }

        return data;
      } catch (error) {
        lastError = error;
        await new Promise(r => setTimeout(r, this.retryConfig.backoffMs * (i + 1)));
      }
    }

    throw lastError;
  }

  // ---- Public API ---------------------------------------------------------

  /**
   * Fetch a real-time quote for an Indian stock.
   * @param {string} symbol - e.g. "RELIANCE", "TCS", or "RELIANCE.NS"
   */
  async getQuote(symbol) {
    const normalized = this._normalizeSymbol(symbol);
    const url = `${this.baseUrl}/chart/${normalized}?interval=1d&range=1d`;
    const data = await this._fetchWithRetry(url);

    if (!data.chart?.result?.[0]) {
      throw new Error(`No data for symbol: ${normalized}`);
    }

    const result = data.chart.result[0];
    const quote = result.indicators.quote[0];
    const meta = result.meta;

    return {
      symbol: meta.symbol,
      price: meta.regularMarketPrice,
      previousClose: meta.previousClose,
      change: meta.regularMarketPrice - meta.previousClose,
      changePercent:
        ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100,
      volume: quote.volume?.[quote.volume.length - 1] || 0,
      currency: meta.currency || 'INR',
      exchange: meta.exchangeName || this.exchange,
      timestamp: Date.now(),
      source: 'yahooIndia'
    };
  }

  /**
   * Fetch historical OHLCV candles.
   * @param {string} symbol
   * @param {string} period - e.g. "1mo", "3mo", "1y", "5y", "max"
   * @param {string} interval - e.g. "1d", "1wk", "1mo"
   */
  async getHistorical(symbol, period = '1y', interval = '1d') {
    const normalized = this._normalizeSymbol(symbol);
    const url = `${this.baseUrl}/chart/${normalized}?interval=${interval}&range=${period}`;
    const data = await this._fetchWithRetry(url);

    if (!data.chart?.result?.[0]) {
      throw new Error(`No data for symbol: ${normalized}`);
    }

    const result = data.chart.result[0];
    const timestamps = result.timestamp || [];
    const quote = result.indicators.quote[0];

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quote.open[i] !== null) {
        candles.push({
          timestamp: timestamps[i] * 1000,
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          close: quote.close[i],
          volume: quote.volume[i],
          source: 'yahooIndia'
        });
      }
    }

    return candles;
  }

  /**
   * Search for Indian securities by name or symbol.
   * Results are filtered to the configured exchange (NSE or BSE).
   */
  async search(query) {
    const url = `${this.searchUrl}?q=${encodeURIComponent(query)}`;
    const data = await this._fetchWithRetry(url);

    const exchangeFilter = this.exchange === 'NSE' ? 'NSI' : 'BSE';

    return (data.quotes || [])
      .filter(q => q.exchange === exchangeFilter)
      .map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname,
        type: q.quoteType,
        exchange: q.exchange
      }));
  }
}

// ---------------------------------------------------------------------------
// KiteDataConnector
// ---------------------------------------------------------------------------

class KiteDataConnector {
  constructor(config = {}) {
    this.apiKey = config.apiKey;
    this.accessToken = config.accessToken;
    this._kc = null;
    this._ticker = null;
    this._kiteModule = null;

    const merged = { ...indiaConnectorConfig, ...config };
    this.cacheEnabled = merged.cache?.enabled ?? true;
    this.cache = new LRUCache(
      merged.cache?.maxSize ?? 1000,
      merged.cache?.ttl ?? 60000
    );
    this.rateLimiter = new RateLimiter(
      merged.rateLimits?.kite ?? 200
    );
  }

  // ---- Lazy SDK initialization --------------------------------------------

  async _ensureSDK() {
    if (this._kc) return;

    if (!this.apiKey || !this.accessToken) {
      throw new Error(
        'KiteDataConnector requires apiKey and accessToken. ' +
        'Obtain these from https://kite.trade'
      );
    }

    try {
      this._kiteModule = await import('kiteconnect');
      const KiteConnect = this._kiteModule.KiteConnect || this._kiteModule.default?.KiteConnect;

      if (!KiteConnect) {
        throw new Error('Unable to resolve KiteConnect constructor from kiteconnect package');
      }

      this._kc = new KiteConnect({ api_key: this.apiKey });
      this._kc.setAccessToken(this.accessToken);
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'kiteconnect npm package is not installed. ' +
          'Install it with: npm install kiteconnect'
        );
      }
      throw err;
    }
  }

  // ---- Public API ---------------------------------------------------------

  /**
   * Fetch a real-time quote via Kite Connect.
   * @param {string} symbol - e.g. "RELIANCE", "INFY"
   */
  async getQuote(symbol) {
    await this._ensureSDK();
    await this.rateLimiter.acquire();

    const instrument = `NSE:${symbol}`;
    const cacheKey = `kite:quote:${instrument}`;

    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const response = await this._kc.getQuote([instrument]);
    const raw = response[instrument];

    if (!raw) {
      throw new Error(`No Kite data for symbol: ${instrument}`);
    }

    const quote = {
      symbol: symbol,
      price: raw.last_price,
      previousClose: raw.ohlc?.close || raw.last_price,
      change: raw.net_change || (raw.last_price - (raw.ohlc?.close || 0)),
      changePercent:
        raw.ohlc?.close
          ? ((raw.last_price - raw.ohlc.close) / raw.ohlc.close) * 100
          : 0,
      open: raw.ohlc?.open,
      high: raw.ohlc?.high,
      low: raw.ohlc?.low,
      volume: raw.volume || 0,
      currency: 'INR',
      exchange: 'NSE',
      timestamp: Date.now(),
      source: 'kite'
    };

    if (this.cacheEnabled) {
      this.cache.set(cacheKey, quote);
    }

    return quote;
  }

  /**
   * Fetch historical OHLCV data via Kite Connect.
   * @param {string} symbol - e.g. "RELIANCE"
   * @param {string|Date} fromDate - Start date (ISO string or Date)
   * @param {string|Date} toDate - End date (ISO string or Date)
   * @param {string} interval - "minute", "3minute", "5minute", "15minute",
   *                            "30minute", "60minute", "day", "week", "month"
   */
  async getHistorical(symbol, fromDate, toDate, interval = 'day') {
    await this._ensureSDK();
    await this.rateLimiter.acquire();

    const cacheKey = `kite:hist:${symbol}:${fromDate}:${toDate}:${interval}`;
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    // Kite historical API requires an instrument_token. We look it up via
    // the instruments list. For simplicity we use the NSE exchange token
    // derived from the quote if available, otherwise search instruments.
    const instrumentToken = await this._resolveInstrumentToken(symbol);

    const from = fromDate instanceof Date ? fromDate.toISOString().split('T')[0] : String(fromDate);
    const to = toDate instanceof Date ? toDate.toISOString().split('T')[0] : String(toDate);

    const raw = await this._kc.getHistoricalData(
      instrumentToken,
      interval,
      from,
      to
    );

    const candles = (raw || []).map(d => ({
      timestamp: new Date(d.date).getTime(),
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
      source: 'kite'
    }));

    if (this.cacheEnabled) {
      this.cache.set(cacheKey, candles);
    }

    return candles;
  }

  /**
   * Subscribe to real-time tick data via KiteTicker WebSocket.
   * @param {string[]} symbols - Array of symbols (e.g. ["RELIANCE", "INFY"])
   * @param {Function} callback - Called with each tick object
   * @returns {{ close: Function }} handle to close the WebSocket
   */
  async subscribeToTicks(symbols, callback) {
    await this._ensureSDK();

    const KiteTicker = this._kiteModule.KiteTicker || this._kiteModule.default?.KiteTicker;

    if (!KiteTicker) {
      throw new Error(
        'KiteTicker not available in kiteconnect package. ' +
        'Ensure you have a compatible version installed.'
      );
    }

    const ticker = new KiteTicker({
      api_key: this.apiKey,
      access_token: this.accessToken
    });

    // Resolve instrument tokens for all symbols
    const tokens = await Promise.all(
      symbols.map(s => this._resolveInstrumentToken(s))
    );

    ticker.connect();

    ticker.on('connect', () => {
      ticker.subscribe(tokens);
      ticker.setMode(ticker.modeFull || 'full', tokens);
    });

    ticker.on('ticks', (ticks) => {
      for (const tick of ticks) {
        callback({
          symbol: tick.tradable ? tick.tradingsymbol : String(tick.instrument_token),
          price: tick.last_price,
          open: tick.ohlc?.open,
          high: tick.ohlc?.high,
          low: tick.ohlc?.low,
          close: tick.ohlc?.close,
          volume: tick.volume || 0,
          timestamp: Date.now(),
          source: 'kite'
        });
      }
    });

    ticker.on('error', (err) => {
      console.warn('KiteTicker error:', err.message || err);
    });

    this._ticker = ticker;

    return {
      close: () => {
        try {
          ticker.disconnect();
        } catch (e) {
          console.warn('Error disconnecting KiteTicker:', e.message);
        }
        this._ticker = null;
      }
    };
  }

  // ---- Internal helpers ---------------------------------------------------

  /**
   * Resolve a trading symbol to its Kite instrument_token.
   * Caches instrument lookups to avoid repeated API calls.
   */
  async _resolveInstrumentToken(symbol) {
    const cacheKey = `kite:token:${symbol}`;
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    try {
      const instruments = await this._kc.getInstruments('NSE');
      const match = instruments.find(
        i => i.tradingsymbol === symbol && i.exchange === 'NSE'
      );

      if (!match) {
        throw new Error(`Instrument token not found for NSE:${symbol}`);
      }

      if (this.cacheEnabled) {
        this.cache.set(cacheKey, match.instrument_token);
      }

      return match.instrument_token;
    } catch (err) {
      throw new Error(
        `Failed to resolve instrument token for ${symbol}: ${err.message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// IndiaDataManager
// ---------------------------------------------------------------------------

class IndiaDataManager {
  /**
   * @param {object} config
   * @param {string} [config.exchange='NSE'] - Default exchange for Yahoo lookups
   * @param {string} [config.kiteTier] - Set to 'connect' to enable KiteDataConnector
   * @param {string} [config.kiteApiKey] - Kite Connect API key
   * @param {string} [config.kiteAccessToken] - Kite Connect access token
   */
  constructor(config = {}) {
    this.connectors = {};

    // Yahoo Finance India is always available (free)
    this.connectors.yahooIndia = new YahooFinanceIndiaConnector({
      exchange: config.exchange || 'NSE',
      ...config
    });

    // Kite Connect is optional (paid tier)
    if (config.kiteTier === 'connect') {
      try {
        this.connectors.kite = new KiteDataConnector({
          apiKey: config.kiteApiKey,
          accessToken: config.kiteAccessToken,
          ...config
        });
      } catch (err) {
        console.warn('Failed to initialize KiteDataConnector:', err.message);
      }
    }

    this.preferredSource = this.connectors.kite ? 'kite' : 'yahooIndia';
  }

  /**
   * Access an underlying connector by name.
   */
  getConnector(name) {
    return this.connectors[name] || null;
  }

  /**
   * Fetch a quote, trying the preferred source first then falling back.
   * @param {string} symbol
   * @param {string} [source] - Force a specific source
   */
  async getQuote(symbol, source = null) {
    const sources = source
      ? [source]
      : [this.preferredSource, ...Object.keys(this.connectors)];

    // Deduplicate while preserving order
    const unique = [...new Set(sources)];

    for (const src of unique) {
      const connector = this.connectors[src];
      if (!connector) continue;

      try {
        return await connector.getQuote(symbol);
      } catch (err) {
        console.warn(`Quote failed for ${symbol} from ${src}:`, err.message);
      }
    }

    throw new Error(`Failed to get quote for ${symbol} from all sources`);
  }

  /**
   * Fetch historical OHLCV data, routing to the best available source.
   * @param {string} symbol
   * @param {object} options
   * @param {string} [options.source] - Force a specific source
   * @param {string} [options.period='1y'] - Range (Yahoo style)
   * @param {string} [options.interval='1d'] - Candle interval
   * @param {string|Date} [options.fromDate] - Start date (Kite style)
   * @param {string|Date} [options.toDate] - End date (Kite style)
   */
  async getHistorical(symbol, options = {}) {
    const {
      source = this.preferredSource,
      period = '1y',
      interval = '1d',
      fromDate,
      toDate
    } = options;

    const connector = this.connectors[source];
    if (!connector) {
      throw new Error(`Unknown source: ${source}`);
    }

    try {
      if (source === 'kite') {
        // Kite requires explicit date range
        const to = toDate || new Date();
        const from = fromDate || _periodToDate(period);
        const kiteInterval = _mapIntervalToKite(interval);
        return await connector.getHistorical(symbol, from, to, kiteInterval);
      }

      // Yahoo-style period/interval
      return await connector.getHistorical(symbol, period, interval);
    } catch (err) {
      // Fallback to the other source
      console.warn(`Historical fetch failed for ${symbol} from ${source}:`, err.message);

      const fallback = source === 'kite' ? 'yahooIndia' : 'kite';
      const fallbackConnector = this.connectors[fallback];

      if (!fallbackConnector) throw err;

      console.warn(`Falling back to ${fallback} for ${symbol}`);

      if (fallback === 'kite') {
        const to = toDate || new Date();
        const from = fromDate || _periodToDate(period);
        return await fallbackConnector.getHistorical(symbol, from, to, _mapIntervalToKite(interval));
      }

      return await fallbackConnector.getHistorical(symbol, period, interval);
    }
  }

  /**
   * Fetch quotes for multiple symbols in parallel.
   * Each failed symbol returns an object with an `error` property instead of throwing.
   * @param {string[]} symbols
   */
  async getQuotes(symbols) {
    const promises = symbols.map(s =>
      this.getQuote(s).catch(e => ({ symbol: s, error: e.message }))
    );
    return Promise.all(promises);
  }

  /**
   * Clear caches on all connectors.
   */
  clearCache() {
    for (const connector of Object.values(this.connectors)) {
      connector.cache?.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Yahoo-style period string into a past Date.
 */
function _periodToDate(period) {
  const now = new Date();
  const match = period.match(/^(\d+)(d|mo|y)$/);

  if (!match) {
    // Default to 1 year ago
    now.setFullYear(now.getFullYear() - 1);
    return now;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'd':
      now.setDate(now.getDate() - value);
      break;
    case 'mo':
      now.setMonth(now.getMonth() - value);
      break;
    case 'y':
      now.setFullYear(now.getFullYear() - value);
      break;
  }

  return now;
}

/**
 * Map common interval strings to Kite-compatible intervals.
 */
function _mapIntervalToKite(interval) {
  const mapping = {
    '1m': 'minute',
    '3m': '3minute',
    '5m': '5minute',
    '15m': '15minute',
    '30m': '30minute',
    '60m': '60minute',
    '1h': '60minute',
    '1d': 'day',
    '1wk': 'week',
    '1mo': 'month',
    // Pass through Kite-native values as-is
    'minute': 'minute',
    '3minute': '3minute',
    '5minute': '5minute',
    '15minute': '15minute',
    '30minute': '30minute',
    '60minute': '60minute',
    'day': 'day',
    'week': 'week',
    'month': 'month'
  };

  return mapping[interval] || 'day';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  YahooFinanceIndiaConnector,
  KiteDataConnector,
  IndiaDataManager,
  LRUCache,
  RateLimiter,
  indiaConnectorConfig
};
