/**
 * Market Calendar
 *
 * Handles trading hours, holidays, and timezone logic for any market.
 * Uses native Intl.DateTimeFormat for timezone conversions -- no external deps.
 *
 * Accepts a market config object (from config/markets/india.js or us.js)
 * and provides methods to check market open/close status, find next open,
 * count trading days, and calculate time-to-close / time-to-square-off.
 */

/**
 * Parse an "HH:MM" time string into { hours, minutes }.
 */
function parseTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Build a Set of holiday strings for O(1) lookup.
 * Holidays are stored as "YYYY-MM-DD" in the config.
 */
function buildHolidaySet(holidays) {
  return new Set(holidays || []);
}

/**
 * Get the components of a Date in a specific IANA timezone.
 * Returns { year, month, day, hours, minutes, seconds, dayOfWeek }.
 *
 * Uses Intl.DateTimeFormat to extract each part in the target timezone
 * without pulling in any third-party library.
 */
function getTimezoneComponents(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  });

  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    parts[type] = value;
  }

  // Map weekday abbreviation to 0=Sun ... 6=Sat to match Date.getDay()
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: Number(parts.year),
    month: Number(parts.month),   // 1-12
    day: Number(parts.day),
    // Intl with hour12:false can return "24" for midnight; normalize to 0
    hours: Number(parts.hour) % 24,
    minutes: Number(parts.minute),
    seconds: Number(parts.second),
    dayOfWeek: dayMap[parts.weekday] ?? 0
  };
}

/**
 * Convert timezone-local components to total minutes since midnight.
 */
function toMinutesSinceMidnight(components) {
  return components.hours * 60 + components.minutes;
}

/**
 * Convert an "HH:MM" time string to total minutes since midnight.
 */
function timeToMinutes(timeStr) {
  const { hours, minutes } = parseTime(timeStr);
  return hours * 60 + minutes;
}

/**
 * Format a date string as "YYYY-MM-DD" from timezone components.
 */
function formatDateKey(components) {
  const y = String(components.year);
  const m = String(components.month).padStart(2, '0');
  const d = String(components.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class MarketCalendar {
  /**
   * @param {object} marketConfig - Full market config (e.g. indiaMarketConfig)
   */
  constructor(marketConfig) {
    const cal = marketConfig.calendar;

    this.timezone = cal.timezone;
    this.tradingDaysPerYear = cal.tradingDaysPerYear;

    // Regular trading hours (HH:MM strings)
    this.regularStart = cal.marketHours.regular.start;
    this.regularEnd = cal.marketHours.regular.end;

    // Pre-computed minute values for fast comparison
    this._startMinutes = timeToMinutes(this.regularStart);
    this._endMinutes = timeToMinutes(this.regularEnd);

    // Optional MIS square-off time (India only)
    this.squareOffTime = cal.squareOffTime || null;
    this._squareOffMinutes = this.squareOffTime
      ? timeToMinutes(this.squareOffTime)
      : null;

    // Holiday set for O(1) lookup
    this._holidays = buildHolidaySet(cal.holidays);

    // Reusable time formatter for getMarketTimeString
    this._timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  // ---------------------------------------------------------------------------
  // Core queries
  // ---------------------------------------------------------------------------

  /**
   * Check if the market is open at the given date/time.
   * Open means: weekday + not a holiday + within regular trading hours.
   *
   * @param {Date} [date=new Date()] - The instant to check
   * @returns {boolean}
   */
  isMarketOpen(date = new Date()) {
    const c = getTimezoneComponents(date, this.timezone);

    // Weekend check (0 = Sunday, 6 = Saturday)
    if (c.dayOfWeek === 0 || c.dayOfWeek === 6) return false;

    // Holiday check
    if (this._holidays.has(formatDateKey(c))) return false;

    // Regular hours check (inclusive of start, exclusive of end)
    const nowMinutes = toMinutesSinceMidnight(c);
    return nowMinutes >= this._startMinutes && nowMinutes < this._endMinutes;
  }

  /**
   * Check if a given date falls on a trading day (weekday + not a holiday).
   * This does NOT consider time of day -- only the calendar date.
   *
   * @param {Date} [date=new Date()] - The date to check
   * @returns {boolean}
   */
  isTradingDay(date = new Date()) {
    const c = getTimezoneComponents(date, this.timezone);

    if (c.dayOfWeek === 0 || c.dayOfWeek === 6) return false;
    if (this._holidays.has(formatDateKey(c))) return false;

    return true;
  }

  /**
   * Find the next Date when the market opens, starting from `fromDate`.
   * If the market is currently open, this returns the NEXT open (i.e. tomorrow
   * or the next trading day after that).
   *
   * @param {Date} [fromDate=new Date()] - Starting point
   * @returns {Date} The exact instant the market next opens
   */
  getNextMarketOpen(fromDate = new Date()) {
    const c = getTimezoneComponents(fromDate, this.timezone);
    const nowMinutes = toMinutesSinceMidnight(c);

    // If today is a trading day and we haven't reached market open yet,
    // the next open is today at start time.
    const isToday = this.isTradingDay(fromDate) && nowMinutes < this._startMinutes;

    if (isToday) {
      return this._buildDateInTimezone(c.year, c.month, c.day, this.regularStart);
    }

    // Otherwise walk forward day-by-day until we find a trading day.
    // Start from the next calendar day in the market timezone.
    let candidate = this._nextCalendarDay(c);
    const maxDays = 15; // safety limit (markets never closed > ~10 consecutive days)

    for (let i = 0; i < maxDays; i++) {
      const cc = getTimezoneComponents(candidate, this.timezone);
      // Build a date at midnight of this candidate day
      if (cc.dayOfWeek !== 0 && cc.dayOfWeek !== 6 && !this._holidays.has(formatDateKey(cc))) {
        // Found a trading day -- return its open time
        return this._buildDateInTimezone(cc.year, cc.month, cc.day, this.regularStart);
      }
      candidate = this._nextCalendarDay(cc);
    }

    // Fallback: should never reach here for any real market
    return null;
  }

  /**
   * Milliseconds until regular market close. Returns null if market is closed.
   *
   * @param {Date} [date=new Date()] - The instant to measure from
   * @returns {number|null} ms until close, or null if market is not open
   */
  timeToClose(date = new Date()) {
    if (!this.isMarketOpen(date)) return null;

    const c = getTimezoneComponents(date, this.timezone);
    const closeDate = this._buildDateInTimezone(c.year, c.month, c.day, this.regularEnd);

    return closeDate.getTime() - date.getTime();
  }

  /**
   * Milliseconds until MIS square-off time. Returns null if:
   * - No squareOffTime is configured (e.g. US markets)
   * - Market is not currently open
   * - Square-off time has already passed for today
   *
   * @param {Date} [date=new Date()] - The instant to measure from
   * @returns {number|null}
   */
  timeToSquareOff(date = new Date()) {
    if (!this.squareOffTime) return null;
    if (!this.isMarketOpen(date)) return null;

    const c = getTimezoneComponents(date, this.timezone);
    const nowMinutes = toMinutesSinceMidnight(c);

    // If we've already passed square-off time, return null
    if (nowMinutes >= this._squareOffMinutes) return null;

    const sqDate = this._buildDateInTimezone(c.year, c.month, c.day, this.squareOffTime);
    return sqDate.getTime() - date.getTime();
  }

  /**
   * Count the number of trading days between two dates (exclusive of endDate).
   * Both dates are interpreted in the market's timezone.
   *
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {number}
   */
  getTradingDaysBetween(startDate, endDate) {
    if (endDate <= startDate) return 0;

    let count = 0;
    // Walk day-by-day from startDate to endDate (exclusive)
    let current = new Date(startDate.getTime());

    // Cap iteration at a reasonable maximum (5 years of calendar days)
    const maxIter = 365 * 5;

    for (let i = 0; i < maxIter; i++) {
      const c = getTimezoneComponents(current, this.timezone);

      // Stop once we reach or pass endDate's calendar day
      if (current.getTime() >= endDate.getTime()) break;

      if (c.dayOfWeek !== 0 && c.dayOfWeek !== 6 && !this._holidays.has(formatDateKey(c))) {
        count++;
      }

      // Advance by 24 hours
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
    }

    return count;
  }

  /**
   * Format a date as a time string in the market's timezone.
   * Example output: "09:15:00" or "15:30:42".
   *
   * @param {Date} [date=new Date()]
   * @returns {string}
   */
  getMarketTimeString(date = new Date()) {
    return this._timeFormatter.format(date);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a Date object for a specific calendar date and "HH:MM" time
   * in this market's timezone.
   *
   * Strategy: create a UTC date at approximately the right time, then
   * adjust by comparing what Intl reports vs. what we want.
   */
  _buildDateInTimezone(year, month, day, timeStr) {
    const { hours, minutes } = parseTime(timeStr);

    // Start with a rough UTC estimate (treat the local time as UTC)
    const rough = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));

    // See what time Intl reports for this rough date in our timezone
    const reported = getTimezoneComponents(rough, this.timezone);
    const reportedMinutes = reported.hours * 60 + reported.minutes;
    const wantedMinutes = hours * 60 + minutes;

    // The difference tells us the UTC offset at this moment
    const diffMs = (reportedMinutes - wantedMinutes) * 60 * 1000;

    // Also correct any date shift (e.g. near midnight crossings)
    let dayDiffMs = 0;
    if (reported.day !== day) {
      // If the reported day is ahead, subtract a day; if behind, add a day
      dayDiffMs = (reported.day > day ? -1 : 1) * 24 * 60 * 60 * 1000;
    }

    return new Date(rough.getTime() - diffMs + dayDiffMs);
  }

  /**
   * Return a Date representing noon of the next calendar day in the market timezone.
   * Using noon avoids DST edge cases at midnight boundaries.
   */
  _nextCalendarDay(components) {
    // Build a date at noon of the current day, then add 24 hours
    const noon = this._buildDateInTimezone(
      components.year, components.month, components.day, '12:00'
    );
    return new Date(noon.getTime() + 24 * 60 * 60 * 1000);
  }
}
