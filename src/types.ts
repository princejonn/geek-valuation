/**
 * @fileoverview Type definitions for the BoardGameGeek price scraper.
 *
 * This module defines all shared interfaces used throughout the application.
 * These types represent the data structures for scraped prices, calculated
 * statistics, and configuration options.
 *
 * ## Currency Strategy
 *
 * All internal calculations and stored values use USD as the base currency.
 * This provides a stable intermediate format. When generating reports,
 * values are converted to the user's preferred currency (default: SEK).
 */

/**
 * Represents a single historical sale price from BoardGameGeek's marketplace.
 *
 * Each price record captures what a game sold for, in what condition,
 * and when the sale occurred. Prices are stored in their original currency
 * and later converted to USD for analysis.
 */
export interface Price {
  /** ISO 4217 currency code (e.g., "USD", "EUR", "GBP") */
  currency: string;

  /** Sale price in the original currency */
  value: number;

  /**
   * Condition of the game at time of sale.
   * BGG uses: "New", "Like New", "Very Good", "Good", "Acceptable"
   */
  condition: string;

  /** Date of sale as displayed on BGG (e.g., "Nov 19, 2025") */
  saleDate: string;
}

/**
 * Statistical analysis of prices for a specific condition.
 *
 * All monetary values are stored in USD as the base currency.
 *
 * Statistics are calculated using a multi-factor weighting system that
 * considers time (recent sales weighted higher), price (outliers weighted
 * lower), and currency (European currencies preferred for EU users).
 */
export interface ConditionStats {
  /** The condition these statistics apply to */
  condition: string;

  /** Total number of sales in this condition */
  count: number;

  // --- Raw statistics (all data points, unweighted) ---

  /** Median price in USD (middle value when sorted) */
  median: number;

  /** Lowest sale price in USD */
  lowest: number;

  /** Highest sale price in USD */
  highest: number;

  /** Arithmetic mean price in USD (unweighted) */
  mean: number;

  /** 25th percentile price in USD (Q1) - used for IQR in price weighting */
  percentile25: number;

  /** 75th percentile price in USD (Q3) - used for IQR in price weighting */
  percentile75: number;

  /** Date of the oldest sale in the dataset */
  oldestSale: string;

  /** Date of the most recent sale in the dataset */
  newestSale: string;

  // --- Multi-factor weighted statistics ---

  /**
   * Multi-factor weighted mean price in USD.
   *
   * Combines three weighting factors multiplicatively:
   * 1. **Time**: Exponential decay with 1-year half-life (recent sales weighted higher)
   * 2. **Price**: Gaussian decay from median (outliers weighted lower, not removed)
   * 3. **Currency**: European currencies weighted higher when EU data exists
   *
   * This is the primary value used for valuation.
   */
  weightedMean: number;

  /**
   * Number of sales from the last 12 months.
   * Higher counts indicate more confidence in the weighted estimate.
   */
  recentSalesCount: number;
}

/**
 * The original purchase price of a game from the user's collection.
 *
 * This is extracted from the BGG collection CSV export and used to
 * compare against current market values to understand collection worth.
 */
export interface PurchasePrice {
  /** Original purchase amount in the original currency */
  value: number;

  /** ISO 4217 currency code of the purchase */
  currency: string;

  /** Purchase price converted to USD for storage and comparison */
  valueInUSD: number;
}

/**
 * Complete scraped and analyzed data for a single game.
 *
 * This is the primary data structure stored in prices.json, containing
 * all raw price data and calculated statistics for each game in the
 * user's collection. All monetary values in calc[] and purchasePrice
 * are stored in USD.
 */
export interface GameResult {
  /** Game name as it appears in the BGG collection */
  name: string;

  /** BGG object ID (unique identifier used in URLs) */
  objectid: string;

  /** Original purchase price (stored in USD), if recorded in the collection */
  purchasePrice: PurchasePrice | null;

  /** All historical sale prices scraped from BGG marketplace */
  prices: Price[];

  /** Calculated statistics grouped by condition (values in USD) */
  calc: ConditionStats[];
}

/**
 * Row from a BGG collection CSV export.
 *
 * BGG's CSV export contains many fields; we only use a subset.
 * The interface allows any string keys to accommodate the full export
 * while explicitly typing the fields we depend on.
 */
export interface CsvRow {
  /** Game name from the collection */
  objectname: string;

  /** BGG object ID */
  objectid: string;

  /** Price paid for the game (optional, user-entered) */
  pricepaid?: string;

  /** Currency of the price paid (optional) */
  pp_currency?: string;

  /** Allow additional CSV columns */
  [key: string]: string | undefined;
}

/**
 * Exchange rates for converting currencies.
 *
 * Rates are fetched from the Frankfurter API (which uses ECB data)
 * and cached locally. The rates represent how many units of each
 * currency one unit of the base currency is worth.
 *
 * Example for base "USD": { "SEK": 10.5 } means $1 = 10.50 SEK
 */
export interface ExchangeRates {
  /** Base currency for these rates (e.g., "USD", "SEK") */
  base: string;

  /** Date the rates were fetched (YYYY-MM-DD format) */
  date: string;

  /** Attribution for the rate source */
  source?: string;

  /**
   * Currency conversion rates from the base currency.
   * Key is ISO 4217 code, value is units of that currency per 1 base unit.
   */
  rates: { [currency: string]: number };
}

/**
 * Multi-base exchange rates cache.
 *
 * Stores exchange rates for multiple base currencies, allowing
 * conversion between any pair of currencies.
 */
export interface ExchangeRatesCache {
  [baseCurrency: string]: ExchangeRates;
}
