/**
 * @fileoverview Statistical analysis for BoardGameGeek marketplace prices.
 *
 * This module calculates statistics for game prices grouped by condition,
 * using a multi-factor weighting system for accurate valuations.
 *
 * All monetary values are calculated and stored in USD as the base currency.
 *
 * ## Statistics Provided
 *
 * For each condition (New, Like New, Very Good, Good, Acceptable), we calculate:
 * - **Raw stats**: median, mean, lowest, highest (all data points, in USD)
 * - **Percentiles**: Q1 and Q3 (used for price weighting)
 * - **Date range**: oldest and newest sale dates
 * - **Weighted mean**: the primary valuation metric (in USD)
 *
 * ## Multi-Factor Weighting System
 *
 * The `weightedMean` combines three factors multiplicatively:
 *
 * ### 1. Time Weighting
 * Recent sales are more relevant. Uses exponential decay with 1-year half-life:
 * - Today: weight 1.0
 * - 6 months ago: weight ~0.71
 * - 1 year ago: weight 0.5
 * - 2 years ago: weight 0.25
 * - 3 years ago: weight 0.125
 *
 * ### 2. Price Weighting (Soft Outliers)
 * Outliers get reduced weight based on distance from median (Gaussian decay):
 * - At median: weight 1.0
 * - 1 IQR from median: weight ~0.61
 * - 2 IQR from median: weight ~0.14
 * - 3 IQR from median: weight ~0.01
 * - Minimum weight: 0.01 (outliers still contribute slightly)
 *
 * ### 3. Currency Weighting (Region-Based)
 * Currencies from the user's preferred region are weighted higher.
 * Supported regions: europe, americas, asia, india, oceania (default: europe)
 *
 * When ≥2 sales from the preferred region exist:
 * - Regional currencies: weight 1.0
 * - Non-regional currencies: weight 0.3
 *
 * If insufficient regional data exists, all currencies weighted equally.
 *
 * ### Combined Weight Formula
 *
 * ```
 * combinedWeight = timeWeight × priceWeight × currencyWeight
 * weightedMean = Σ(value × combinedWeight) / Σ(combinedWeight)
 * ```
 */

import { convertToBase } from "./currency";
import { ConditionStats, ExchangeRates, Price } from "./types";

/**
 * Parses a date string from BGG into a JavaScript Date object.
 *
 * BGG uses formats like "Nov 19, 2025" which JavaScript's Date
 * constructor handles natively.
 *
 * @param dateStr - Date string from BGG (e.g., "Nov 19, 2025")
 * @returns Parsed Date object
 */
function parseDate(dateStr: string): Date {
  return new Date(dateStr);
}

/**
 * Calculates the median (middle value) of a numeric array.
 *
 * The median is more robust than the mean for price data because it's
 * not affected by extreme outliers. For a dataset of sold prices,
 * the median represents the "typical" sale price.
 *
 * @example
 * ```typescript
 * calculateMedian([100, 200, 300])        // 200 (middle value)
 * calculateMedian([100, 200, 300, 400])   // 250 (average of two middle values)
 * calculateMedian([100, 200, 10000])      // 200 (outlier doesn't affect result)
 * ```
 *
 * @param values - Array of numeric values
 * @returns Median value, or 0 for empty array
 */
function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    // Even number of values: average the two middle values
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  // Odd number of values: return the middle value
  return sorted[mid];
}

/**
 * Calculates a specific percentile of a numeric array.
 *
 * Uses linear interpolation between values when the percentile falls
 * between two data points, which provides smoother results than
 * simple nearest-rank methods.
 *
 * @example
 * ```typescript
 * calculatePercentile([100, 200, 300, 400], 25)  // ~175 (Q1)
 * calculatePercentile([100, 200, 300, 400], 50)  // ~250 (median)
 * calculatePercentile([100, 200, 300, 400], 75)  // ~325 (Q3)
 * ```
 *
 * @param values - Array of numeric values
 * @param percentile - Percentile to calculate (0-100)
 * @returns The percentile value, or 0 for empty array
 */
function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);

  // Calculate the index (may be fractional)
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  // If index is exactly on a value, return it
  if (lower === upper) return sorted[lower];

  // Otherwise, interpolate between the two nearest values
  return Math.round(
    sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower),
  );
}

/**
 * Half-life for time-weighted calculations, in milliseconds.
 * Set to 1 year: sales from 1 year ago have 50% weight,
 * 2 years ago have 25% weight, etc.
 */
const TIME_WEIGHT_HALF_LIFE_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Calculates the time-based weight for a sale date using exponential decay.
 *
 * Uses the formula: weight = 0.5 ^ (age / halfLife)
 *
 * This gives:
 * - Today's sale: weight ≈ 1.0
 * - 6 months ago: weight ≈ 0.71
 * - 1 year ago: weight = 0.5
 * - 2 years ago: weight = 0.25
 * - 3 years ago: weight = 0.125
 *
 * @param saleDate - Date of the sale
 * @param now - Current date (for testing, defaults to now)
 * @returns Weight between 0 and 1
 */
function calculateTimeWeight(saleDate: Date, now: Date = new Date()): number {
  const ageMs = now.getTime() - saleDate.getTime();
  // Future dates get full weight (shouldn't happen, but be safe)
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / TIME_WEIGHT_HALF_LIFE_MS);
}

/**
 * Counts sales within the last N months.
 *
 * @param dates - Array of sale dates
 * @param months - Number of months to look back (default: 12)
 * @param now - Current date for comparison
 * @returns Number of sales within the time window
 */
function countRecentSales(
  dates: Date[],
  months: number = 12,
  now: Date = new Date(),
): number {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);

  return dates.filter((d) => d >= cutoff).length;
}

/**
 * Supported regions for currency weighting.
 * Users can specify their preferred region to weight prices from
 * geographically relevant markets higher.
 */
export type Region = "europe" | "americas" | "asia" | "india" | "oceania";

/**
 * Currency groups by region/continent.
 * When a user specifies their region, currencies from that region
 * get full weight while others get reduced weight.
 */
const REGION_CURRENCIES: Record<Region, Set<string>> = {
  europe: new Set([
    "SEK", // Swedish Krona
    "EUR", // Euro
    "DKK", // Danish Krone
    "NOK", // Norwegian Krone
    "GBP", // British Pound
    "CHF", // Swiss Franc
    "PLN", // Polish Zloty
    "CZK", // Czech Koruna
    "HUF", // Hungarian Forint
    "RON", // Romanian Leu
    "BGN", // Bulgarian Lev
    "HRK", // Croatian Kuna
    "ISK", // Icelandic Krona
    "RUB", // Russian Ruble
    "UAH", // Ukrainian Hryvnia
    "TRY", // Turkish Lira
  ]),
  americas: new Set([
    "USD", // US Dollar
    "CAD", // Canadian Dollar
    "MXN", // Mexican Peso
    "BRL", // Brazilian Real
    "ARS", // Argentine Peso
    "CLP", // Chilean Peso
    "COP", // Colombian Peso
    "PEN", // Peruvian Sol
  ]),
  asia: new Set([
    "JPY", // Japanese Yen
    "CNY", // Chinese Yuan
    "KRW", // South Korean Won
    "SGD", // Singapore Dollar
    "HKD", // Hong Kong Dollar
    "TWD", // Taiwan Dollar
    "THB", // Thai Baht
    "MYR", // Malaysian Ringgit
    "PHP", // Philippine Peso
    "IDR", // Indonesian Rupiah
    "VND", // Vietnamese Dong
  ]),
  india: new Set([
    "INR", // Indian Rupee
  ]),
  oceania: new Set([
    "AUD", // Australian Dollar
    "NZD", // New Zealand Dollar
  ]),
};

/**
 * Default region for currency weighting.
 */
export const DEFAULT_REGION: Region = "europe";

/**
 * Calculates a currency-based weight.
 *
 * Currencies from the user's preferred region are weighted higher because:
 * - More relevant to local market conditions
 * - Lower shipping costs within the region
 * - Similar market dynamics
 *
 * The weighting is adaptive: if there are sufficient sales in the
 * preferred region, other regions get reduced weight. If regional
 * sales are scarce, all currencies get equal weight.
 *
 * @param currency - ISO 4217 currency code
 * @param hasRegionalData - Whether there are sufficient sales in the preferred region
 * @param region - User's preferred region
 * @returns Weight between 0.3 and 1.0
 */
function getCurrencyWeight(
  currency: string,
  hasRegionalData: boolean,
  region: Region,
): number {
  const regionCurrencies = REGION_CURRENCIES[region];
  const isInRegion = regionCurrencies.has(currency);

  if (!hasRegionalData) {
    // No regional data available - all currencies equal
    return 1.0;
  }

  if (isInRegion) {
    // Regional currencies get full weight
    return 1.0;
  }

  // Non-regional currencies get reduced weight when regional data exists
  // 0.3 means they still contribute but don't dominate
  return 0.3;
}

/**
 * Calculates a price-based weight using soft outlier handling.
 *
 * Instead of completely removing outliers (IQR method), this gives them
 * reduced weight based on how far they are from the median. This preserves
 * some information from extreme prices while reducing their influence.
 *
 * The weighting uses a Gaussian-like decay:
 * - Prices within 1 IQR of median: full weight (1.0)
 * - Prices 1-2 IQR from median: reduced weight (~0.6)
 * - Prices 2-3 IQR from median: low weight (~0.1)
 * - Prices >3 IQR from median: minimal weight (~0.01)
 *
 * @param value - The price value in SEK
 * @param median - Median price for this condition
 * @param iqr - Interquartile range (Q3 - Q1)
 * @returns Weight between 0.01 and 1.0
 */
function getPriceWeight(value: number, median: number, iqr: number): number {
  if (iqr === 0) {
    // All prices are the same - equal weight
    return 1.0;
  }

  // Calculate distance from median in IQR units
  const distance = Math.abs(value - median) / iqr;

  // Gaussian-like decay: weight = exp(-distance^2 / 2)
  // This gives smooth falloff:
  // distance 0: weight 1.0
  // distance 1: weight 0.61
  // distance 2: weight 0.14
  // distance 3: weight 0.01
  const weight = Math.exp(-(distance * distance) / 2);

  // Ensure minimum weight of 0.01 (never completely ignore)
  return Math.max(weight, 0.01);
}

/**
 * Calculates a fully-weighted mean incorporating:
 * - Time weighting (recent sales weighted higher)
 * - Price weighting (outliers weighted lower)
 * - Currency weighting (regional currencies preferred)
 *
 * @param values - Array of USD values
 * @param dates - Array of sale dates (same order as values)
 * @param currencies - Array of original currencies (same order as values)
 * @param median - Median price for normalization
 * @param iqr - Interquartile range for outlier weighting
 * @param region - User's preferred region for currency weighting
 * @param now - Current date for time weight calculation
 * @returns Fully-weighted mean, or 0 if no values
 */
function calculateFullyWeightedMean(
  values: number[],
  dates: Date[],
  currencies: string[],
  median: number,
  iqr: number,
  region: Region = DEFAULT_REGION,
  now: Date = new Date(),
): number {
  if (values.length === 0) return 0;

  // Check if we have sufficient regional data (at least 2 sales)
  const regionCurrencies = REGION_CURRENCIES[region];
  const regionalCount = currencies.filter((c) =>
    regionCurrencies.has(c),
  ).length;
  const hasRegionalData = regionalCount >= 2;

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 0; i < values.length; i++) {
    const timeWeight = calculateTimeWeight(dates[i], now);
    const priceWeight = getPriceWeight(values[i], median, iqr);
    const currencyWeight = getCurrencyWeight(
      currencies[i],
      hasRegionalData,
      region,
    );

    // Combine weights multiplicatively
    const combinedWeight = timeWeight * priceWeight * currencyWeight;

    weightedSum += values[i] * combinedWeight;
    totalWeight += combinedWeight;
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

/**
 * Calculates statistics for a set of prices, grouped by condition.
 *
 * For each condition (New, Like New, etc.), calculates:
 * - **Raw stats**: median, mean, lowest, highest
 * - **Percentiles**: Q1 and Q3 (used for price weighting)
 * - **Date range**: oldest and newest sale dates
 * - **Weighted mean**: multi-factor weighted valuation
 * - **Recent count**: number of sales in last 12 months
 *
 * Results sorted by condition (New → Acceptable).
 *
 * @example
 * ```typescript
 * const stats = calculateStats(game.prices, exchangeRates, "europe");
 * const newStats = stats.find(s => s.condition === "New");
 * console.log(`Weighted price: ${newStats?.weightedMean} USD`);
 * ```
 */
export function calculateStats(
  prices: Price[],
  rates: ExchangeRates,
  region: Region = DEFAULT_REGION,
): ConditionStats[] {
  // Group prices by condition for separate analysis
  const byCondition = new Map<string, Price[]>();

  for (const price of prices) {
    const condition = price.condition || "Unknown";
    if (!byCondition.has(condition)) {
      byCondition.set(condition, []);
    }
    byCondition.get(condition)!.push(price);
  }

  const stats: ConditionStats[] = [];

  for (const [condition, conditionPrices] of byCondition) {
    // Convert all prices to USD (base currency) for consistent comparison
    const usdValues = conditionPrices.map((p) =>
      convertToBase(p.value, p.currency, rates),
    );

    // Parse all dates for time-weighted calculations
    const saleDates = conditionPrices.map((p) => parseDate(p.saleDate));

    // Track original currencies for currency weighting
    const currencies = conditionPrices.map((p) => p.currency);

    // Sort by date to find oldest/newest sales
    const sortedByDate = [...conditionPrices].sort((a, b) => {
      return parseDate(a.saleDate).getTime() - parseDate(b.saleDate).getTime();
    });

    // Calculate raw statistics (including all data points)
    const sum = usdValues.reduce((acc, val) => acc + val, 0);
    const mean = Math.round(sum / usdValues.length);

    // Calculate percentiles (used for IQR in price weighting)
    const p25 = calculatePercentile(usdValues, 25);
    const p75 = calculatePercentile(usdValues, 75);
    const iqr = p75 - p25;
    const median = calculateMedian(usdValues);

    // Calculate multi-factor weighted mean:
    // - Time weighting: recent sales weighted higher (1-year half-life)
    // - Price weighting: outliers weighted lower (Gaussian decay from median)
    // - Currency weighting: regional currencies preferred
    const weightedMean = calculateFullyWeightedMean(
      usdValues,
      saleDates,
      currencies,
      median,
      iqr,
      region,
    );

    // Count sales from the last 12 months
    const recentSalesCount = countRecentSales(saleDates);

    stats.push({
      condition,
      count: conditionPrices.length,

      // Raw statistics (all data, unweighted)
      median,
      lowest: Math.min(...usdValues),
      highest: Math.max(...usdValues),
      mean,

      // Percentiles (used for price weighting)
      percentile25: p25,
      percentile75: p75,

      // Date range
      oldestSale: sortedByDate[0].saleDate,
      newestSale: sortedByDate[sortedByDate.length - 1].saleDate,

      // Multi-factor weighted statistics
      weightedMean,
      recentSalesCount,
    });
  }

  // Sort conditions in a logical order for consistent output
  // New items are most valuable, Acceptable least valuable
  const conditionOrder = [
    "New",
    "Like New",
    "Very Good",
    "Good",
    "Acceptable",
    "Unknown",
  ];

  stats.sort((a, b) => {
    const aIdx = conditionOrder.indexOf(a.condition);
    const bIdx = conditionOrder.indexOf(b.condition);
    // Unknown conditions sort to the end
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  return stats;
}
