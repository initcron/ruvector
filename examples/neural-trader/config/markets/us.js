/**
 * US Market Configuration
 * Extracts current hardcoded US defaults into explicit config
 */

export const usMarketConfig = {
  id: 'us',
  name: 'US Markets (NYSE/NASDAQ)',

  currency: {
    code: 'USD',
    symbol: '$',
    locale: 'en-US'
  },

  calendar: {
    tradingDaysPerYear: 252,
    timezone: 'America/New_York',
    marketHours: {
      preMarket: { start: '04:00', end: '09:30' },
      regular: { start: '09:30', end: '16:00' },
      afterHours: { start: '16:00', end: '20:00' }
    },
    // 2025 US market holidays (NYSE/NASDAQ)
    holidays: [
      '2025-01-01', // New Year's Day
      '2025-01-20', // MLK Jr. Day
      '2025-02-17', // Presidents' Day
      '2025-04-18', // Good Friday
      '2025-05-26', // Memorial Day
      '2025-06-19', // Juneteenth
      '2025-07-04', // Independence Day
      '2025-09-01', // Labor Day
      '2025-11-27', // Thanksgiving
      '2025-12-25', // Christmas
    ]
  },

  costs: {
    brokerage: { type: 'zero' },
    slippage: 0.001,
    commission: 0.001,
    marketImpact: 0.0005
  },

  execution: {
    fractionalShares: true,
    lotSize: 1,
    shortSelling: {
      intradayAllowed: true,
      overnightAllowed: true
    }
  },

  riskFreeRate: 0.05,

  yahooSuffix: '',
  defaultSymbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'],

  risk: {
    maxPositionValue: 50000,
    maxDailyLoss: 0.05,
    maxPositionPct: 0.10
  }
};
