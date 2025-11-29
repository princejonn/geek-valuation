/**
 * @fileoverview Currency parsing and exchange rate management.
 *
 * This module handles two main responsibilities:
 *
 * 1. **Price Parsing**: BGG displays prices in various formats depending on
 *    seller location (e.g., "$25.00", "€30", "£20", "CA$35"). We parse these
 *    into a normalized structure with currency code and numeric value.
 *
 * 2. **Exchange Rates**: Prices are converted using rates from the Frankfurter
 *    API (ECB data). The system supports multiple base currencies:
 *    - USD is used as the internal storage format (in prices.json)
 *    - User's preferred currency (default SEK) is used for valuation reports
 *
 * Rates are cached locally and refreshed daily (stale if date is not today).
 */

import * as fs from "fs";
import * as path from "path";
import { ExchangeRates, ExchangeRatesCache, Price } from "./types";

/**
 * Maps currency symbols and prefixes to ISO 4217 currency codes.
 *
 * BGG prices appear in many formats:
 * - Symbol prefix: "$25", "€30", "£20"
 * - Country-prefixed dollar: "US$25", "CA$30", "A$35"
 * - Code prefix: "CHF 50", "DKK 100"
 * - Code suffix: "100 SEK"
 *
 * This map handles the symbol/prefix cases. Code-based formats are
 * handled separately via regex in parsePrice().
 */
const CURRENCY_MAP: { [key: string]: string } = {
  // Currency symbols
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "JP¥": "JPY", // Explicit Japanese Yen (vs Chinese Yuan)
  "₹": "INR",
  "₽": "RUB",
  "₩": "KRW",
  "₪": "ILS",
  "₺": "TRY",
  R$: "BRL", // Brazilian Real
  kr: "SEK", // Nordic krona (could be NOK/DKK, but SEK most common on BGG)

  // Dollar variants - order matters! Longer prefixes checked first.
  US$: "USD",
  CA$: "CAD",
  A$: "AUD",
  NZ$: "NZD",
  HK$: "HKD",
  S$: "SGD", // Singapore Dollar
  MX$: "MXN",
  $: "USD", // Bare $ defaults to USD (most common on BGG)
};

/**
 * Tracks price strings we couldn't parse.
 * Used for debugging and improving the parser over time.
 */
const unknownCurrencies = new Set<string>();

/**
 * Tracks currencies we encountered but don't have exchange rates for.
 * Alerts user to add rates or indicates API limitations.
 */
const missingRates = new Set<string>();

/**
 * Parses a price string from BGG into currency code and numeric value.
 *
 * Handles various formats found on BGG's marketplace:
 * - Symbol prefix: "$25.00", "€30", "£20.50"
 * - Country-prefixed: "US$25", "CA$30.00", "A$35"
 * - Code prefix: "CHF 50.00", "DKK 100"
 * - Code suffix: "100 SEK", "50.00 EUR"
 *
 * @example
 * ```typescript
 * parsePrice("$25.00")      // { currency: "USD", value: 25 }
 * parsePrice("€30")         // { currency: "EUR", value: 30 }
 * parsePrice("CA$35.50")    // { currency: "CAD", value: 35.5 }
 * parsePrice("CHF 100")     // { currency: "CHF", value: 100 }
 * parsePrice("1,500 JPY")   // { currency: "JPY", value: 1500 }
 * ```
 *
 * @param priceText - Raw price string from BGG (e.g., "$25.00")
 * @returns Parsed currency and value, or null if parsing failed
 */
export function parsePrice(
  priceText: string,
): { currency: string; value: number } | null {
  const cleanText = priceText.trim();
  if (!cleanText) return null;

  // Strategy 1: Check for known currency symbols/prefixes
  // Sort by length descending so "US$" matches before "$"
  const sortedPrefixes = Object.keys(CURRENCY_MAP).sort(
    (a, b) => b.length - a.length,
  );

  for (const prefix of sortedPrefixes) {
    if (cleanText.startsWith(prefix)) {
      const valueStr = cleanText.slice(prefix.length).trim();
      // Remove thousand separators (commas) before parsing
      const value = parseFloat(valueStr.replace(/,/g, ""));
      if (!isNaN(value)) {
        return { currency: CURRENCY_MAP[prefix], value };
      }
    }
  }

  // Strategy 2: Match "CODE 123.45" format (e.g., "CHF 95.00", "DKK 2.00")
  const prefixCodeMatch = cleanText.match(/^([A-Z]{3})\s*([\d,]+\.?\d*)$/i);
  if (prefixCodeMatch) {
    const currency = prefixCodeMatch[1].toUpperCase();
    const value = parseFloat(prefixCodeMatch[2].replace(/,/g, ""));
    if (!isNaN(value)) {
      return { currency, value };
    }
  }

  // Strategy 3: Match "123.45 CODE" format (e.g., "100 SEK", "50.00 EUR")
  const suffixMatch = cleanText.match(/^([\d,]+\.?\d*)\s*([A-Z]{3})$/i);
  if (suffixMatch) {
    const value = parseFloat(suffixMatch[1].replace(/,/g, ""));
    const currency = suffixMatch[2].toUpperCase();
    if (!isNaN(value)) {
      return { currency, value };
    }
  }

  // If we found a number but couldn't identify the currency, log it
  // This helps us discover new formats to support
  const numberMatch = cleanText.match(/([\d,]+\.?\d*)/);
  if (numberMatch) {
    unknownCurrencies.add(cleanText);
    console.warn(`  Warning: Unknown currency format: "${cleanText}"`);
  }

  return null;
}

/**
 * Returns all price strings that couldn't be parsed.
 * Useful for debugging and improving the parser.
 */
export function getUnknownCurrencies(): string[] {
  return Array.from(unknownCurrencies);
}

/**
 * Returns all currency codes we don't have exchange rates for.
 * Indicates either missing rates in our data or unsupported currencies.
 */
export function getMissingRates(): string[] {
  return Array.from(missingRates);
}

/**
 * Gets today's date in YYYY-MM-DD format.
 */
function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Fetches current exchange rates from the Frankfurter API for a specific base currency.
 *
 * The Frankfurter API provides free access to ECB exchange rates.
 * Returns rates showing how many units of each currency you get for 1 unit of base.
 *
 * @param baseCurrency - The base currency to fetch rates for (e.g., "USD", "SEK")
 * @returns Exchange rates with the specified base
 * @throws Error if the API request fails
 */
async function fetchRatesFromApi(baseCurrency: string): Promise<ExchangeRates> {
  console.log(
    `Fetching ${baseCurrency} exchange rates from Frankfurter API...`,
  );

  const response = await fetch(
    `https://api.frankfurter.app/latest?from=${baseCurrency}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch rates: ${response.status}`);
  }

  const data = (await response.json()) as {
    date: string;
    rates: Record<string, number>;
  };

  // Add the base currency with rate 1
  const rates: { [currency: string]: number } = { [baseCurrency]: 1 };

  for (const [currency, rate] of Object.entries(data.rates)) {
    // Round to 4 decimal places to avoid floating point noise
    rates[currency] = Math.round(rate * 10000) / 10000;
  }

  return {
    base: baseCurrency,
    date: data.date,
    source: "frankfurter.app (ECB data)",
    rates,
  };
}

/**
 * Loads the exchange rates cache from disk.
 *
 * @param filePath - Path to the exchange rates cache file
 * @returns The cached rates, or empty object if no cache exists
 */
function loadRatesCache(filePath: string): ExchangeRatesCache {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ExchangeRatesCache;
  } catch {
    return {};
  }
}

/**
 * Saves the exchange rates cache to disk.
 *
 * @param filePath - Path to save the cache file
 * @param cache - The rates cache to save
 */
function saveRatesCache(filePath: string, cache: ExchangeRatesCache): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
}

/**
 * Checks if cached rates for a specific base currency are stale.
 *
 * Rates are considered stale if:
 * - No cached rates exist for the base currency
 * - The cached rates are from a different day than today
 *
 * @param cache - The rates cache
 * @param baseCurrency - The base currency to check
 * @returns true if rates should be refreshed
 */
function isRatesStale(
  cache: ExchangeRatesCache,
  baseCurrency: string,
): boolean {
  const rates = cache[baseCurrency];
  if (!rates || !rates.date) {
    return true;
  }

  return rates.date !== getTodayDate();
}

/**
 * Loads exchange rates for a specific base currency, fetching fresh rates if needed.
 *
 * This function implements a caching strategy:
 * 1. If cached rates exist for today, use them
 * 2. If cached rates are stale (not today), fetch new rates from API
 * 3. If API fetch fails but stale cache exists, use stale cache with warning
 * 4. If API fetch fails and no cache exists, throw error
 *
 * The cache file stores rates for multiple base currencies, allowing
 * efficient reuse across different operations.
 *
 * @param filePath - Path to store/load cached exchange rates
 * @param baseCurrency - The base currency to load rates for (e.g., "USD", "SEK")
 * @returns Exchange rates for converting from the base currency
 * @throws Error if rates can't be loaded or fetched
 */
export async function loadExchangeRates(
  filePath: string,
  baseCurrency: string = "USD",
): Promise<ExchangeRates> {
  const cache = loadRatesCache(filePath);

  // Check if we need to fetch fresh rates
  if (isRatesStale(cache, baseCurrency)) {
    try {
      const rates = await fetchRatesFromApi(baseCurrency);

      // Update cache with new rates
      cache[baseCurrency] = rates;
      saveRatesCache(filePath, cache);
      console.log(`${baseCurrency} exchange rates saved to ${filePath}`);

      return rates;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to fetch fresh ${baseCurrency} rates: ${message}`);

      // Fall back to stale cache if available
      if (cache[baseCurrency]) {
        console.warn(
          `Using existing (stale) ${baseCurrency} exchange rates from ${cache[baseCurrency].date}`,
        );
        return cache[baseCurrency];
      }

      // No cache and can't fetch - we're stuck
      throw error;
    }
  }

  // Rates are fresh, use from cache
  console.log(
    `Using cached ${baseCurrency} exchange rates from ${cache[baseCurrency].date}`,
  );
  return cache[baseCurrency];
}

/**
 * Records any currencies in the price list that we don't have rates for.
 *
 * Called during scraping to build a list of missing rates that can be
 * reported to the user at the end of the run.
 *
 * @param prices - Array of prices to check
 * @param rates - Current exchange rates
 */
export function checkMissingRates(prices: Price[], rates: ExchangeRates): void {
  for (const price of prices) {
    if (!rates.rates[price.currency]) {
      missingRates.add(price.currency);
    }
  }
}

/**
 * Converts a price to the base currency of the provided rates.
 *
 * The rates object specifies the base currency and conversion rates.
 * If converting FROM the base currency, returns the original value.
 * If no rate exists, returns the original value with a warning.
 *
 * @example
 * ```typescript
 * // With USD base rates: { base: "USD", rates: { EUR: 0.92, SEK: 10.5, USD: 1 } }
 * convertToBase(100, "EUR", rates)  // 109 (100 / 0.92)
 * convertToBase(100, "SEK", rates)  // 10  (100 / 10.5)
 * convertToBase(100, "USD", rates)  // 100 (already in base)
 * ```
 *
 * @param value - Price amount in original currency
 * @param fromCurrency - ISO 4217 currency code of the value
 * @param rates - Exchange rates (with base currency specified)
 * @returns Price converted to base currency (rounded to whole number)
 */
export function convertToBase(
  value: number,
  fromCurrency: string,
  rates: ExchangeRates,
): number {
  // If already in base currency, no conversion needed
  if (fromCurrency === rates.base) {
    return Math.round(value);
  }

  const rate = rates.rates[fromCurrency];
  if (!rate) {
    // Warn but don't fail - use 1:1 conversion as fallback
    console.warn(
      `No exchange rate for ${fromCurrency} → ${rates.base}, using 1:1`,
    );
    return Math.round(value);
  }

  // rates[X] = how many X you get for 1 base unit
  // So to convert FROM X TO base: value / rate
  return Math.round(value / rate);
}

/**
 * Converts a price from the base currency to a target currency.
 *
 * @example
 * ```typescript
 * // With USD base rates: { base: "USD", rates: { EUR: 0.92, SEK: 10.5, USD: 1 } }
 * convertFromBase(100, "SEK", rates)  // 1050 (100 * 10.5)
 * convertFromBase(100, "EUR", rates)  // 92   (100 * 0.92)
 * convertFromBase(100, "USD", rates)  // 100  (already in base)
 * ```
 *
 * @param value - Price amount in the base currency
 * @param toCurrency - Target currency code
 * @param rates - Exchange rates (with base currency specified)
 * @returns Price converted to target currency (rounded to whole number)
 */
export function convertFromBase(
  value: number,
  toCurrency: string,
  rates: ExchangeRates,
): number {
  // If target is base currency, no conversion needed
  if (toCurrency === rates.base) {
    return Math.round(value);
  }

  const rate = rates.rates[toCurrency];
  if (!rate) {
    // Warn but don't fail - use 1:1 conversion as fallback
    console.warn(
      `No exchange rate for ${rates.base} → ${toCurrency}, using 1:1`,
    );
    return Math.round(value);
  }

  // rates[X] = how many X you get for 1 base unit
  // So to convert FROM base TO X: value * rate
  return Math.round(value * rate);
}

// Legacy alias for backwards compatibility during transition
export const convertToSEK = convertToBase;
