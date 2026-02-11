/**
 * India Market Configuration (NSE/BSE)
 *
 * Zerodha Kite Connect integration
 * - Free tier: order placement + positions (no data)
 * - Connect tier (Rs 500/mo): real-time + historical data
 */

export const indiaMarketConfig = {
  id: 'india',
  name: 'NSE/BSE India',

  currency: {
    code: 'INR',
    symbol: '\u20B9',  // ₹
    locale: 'en-IN'
  },

  calendar: {
    tradingDaysPerYear: 250,
    timezone: 'Asia/Kolkata',
    marketHours: {
      preOpen: { start: '09:00', end: '09:15' },
      regular: { start: '09:15', end: '15:30' },
      postClose: { start: '15:30', end: '15:40' }
    },
    squareOffTime: '15:15',  // MIS auto-close
    // 2025 NSE holidays
    holidays: [
      '2025-02-26', // Maha Shivaratri
      '2025-03-14', // Holi
      '2025-03-31', // Id-Ul-Fitr
      '2025-04-10', // Shri Ram Navami
      '2025-04-14', // Dr. Ambedkar Jayanti
      '2025-04-18', // Good Friday
      '2025-05-01', // Maharashtra Day
      '2025-08-15', // Independence Day
      '2025-08-16', // Janmashtami
      '2025-10-02', // Mahatma Gandhi Jayanti
      '2025-10-20', // Diwali (Lakshmi Puja)
      '2025-10-21', // Diwali Balipratipada
      '2025-11-05', // Gurunanak Jayanti
      '2025-12-25', // Christmas
      // 2026 holidays (add as announced by NSE)
      '2026-01-26', // Republic Day
      '2026-03-04', // Maha Shivaratri
      '2026-03-17', // Holi
      '2026-04-03', // Good Friday
      '2026-04-14', // Dr. Ambedkar Jayanti
      '2026-05-01', // Maharashtra Day
      '2026-08-15', // Independence Day
      '2026-10-02', // Mahatma Gandhi Jayanti
      '2026-11-09', // Diwali (approximate)
      '2026-12-25', // Christmas
    ]
  },

  costs: {
    brokerage: {
      // Zerodha: Rs 20 or 0.03% whichever is lower (intraday), free (delivery)
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
      buy: 0.00015,                // 0.015% (buy side, varies by state)
      sell: 0
    }
  },

  execution: {
    slippage: 0.001,
    fillRate: 1.0,
    lotSize: 1,
    fractionalShares: false,
    shortSelling: {
      intradayAllowed: true,
      overnightAllowed: false  // No overnight shorts for retail
    }
  },

  products: {
    MIS: {
      name: 'Margin Intraday Square-off',
      autoSquareOff: true,
      description: 'Intraday only. Auto-squared off before market close.'
    },
    CNC: {
      name: 'Cash and Carry (Delivery)',
      autoSquareOff: false,
      description: 'Delivery trades. Shares credited to demat account.'
    },
    NRML: {
      name: 'Normal (F&O)',
      autoSquareOff: false,
      description: 'Futures & Options. Held until expiry or manual exit.'
    }
  },

  riskFreeRate: 0.065,  // RBI repo rate (~6.5%)

  yahooSuffix: '.NS',
  yahooBseSuffix: '.BO',
  defaultSymbols: ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
                   'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT'],

  risk: {
    maxPositionValue: 500000,     // Rs 5 lakh
    maxDailyLoss: 0.05,           // 5%
    maxPositionPct: 0.10,         // 10% of portfolio
    circuitLimits: {
      upper: [0.05, 0.10, 0.20], // 5%, 10%, 20% upper circuits
      lower: [-0.05, -0.10, -0.20]
    }
  }
};

/**
 * Calculate transaction costs for an Indian market order
 */
export function calculateIndianTransactionCosts(orderValue, side, product, costs) {
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
    stt = side === 'SELL' ? orderValue * costs.stt.intradaySell : 0;
  } else {
    stt = side === 'BUY'
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
  const stampDuty = side === 'BUY' ? orderValue * costs.stampDuty.buy : 0;

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
