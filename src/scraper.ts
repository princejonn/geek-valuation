/**
 * @fileoverview Web scraping logic for BoardGameGeek price history.
 *
 * This module uses Puppeteer (headless Chrome) to scrape historical sale
 * prices from BoardGameGeek's marketplace. BGG's price history pages are
 * rendered client-side with Angular, requiring a real browser to execute
 * JavaScript and render the data.
 *
 * ## Why Puppeteer?
 *
 * BGG's marketplace pages are Single Page Applications (SPAs) that:
 * - Load data via AJAX after initial page load
 * - Render content using Angular.js templates
 * - Don't expose a public API for price history
 *
 * Simple HTTP requests would only get empty HTML shells. Puppeteer runs
 * a real Chrome browser that executes JavaScript and waits for content.
 *
 * ## Scraping Strategy
 *
 * 1. Navigate to `boardgamegeek.com/market/pricehistory/thing/{objectid}`
 * 2. Wait for the price table to render (networkidle2 + selector wait)
 * 3. Extract price, condition, and sale date from each row
 * 4. Parse prices into normalized currency/value pairs
 *
 * ## Rate Limiting
 *
 * To be respectful to BGG's servers, we:
 * - Add a random 250-1000ms delay between requests
 * - Use caching to avoid re-scraping known games
 * - Save progress every 10 games to prevent data loss
 *
 * ## Caching
 *
 * Games that already have price data in prices.json are skipped.
 * This allows resuming interrupted scrapes and incremental updates.
 * Stats are recalculated for cached games to pick up rate changes.
 */

import * as fs from "fs";
import * as path from "path";
import Puppeteer, { Browser, Page } from "puppeteer";
import { checkMissingRates, convertToBase, parsePrice } from "./currency";
import { calculateStats, DEFAULT_REGION, Region } from "./stats";
import {
  CsvRow,
  ExchangeRates,
  GameResult,
  Price,
  PurchasePrice,
} from "./types";

/**
 * Tracks games where we couldn't find an exchange rate for the purchase currency.
 * These are converted using 1:1 ratio and reported at the end of the scrape.
 */
const unknownCurrencyConversions: {
  name: string;
  objectid: string;
  currency: string;
  originalValue: number;
  assumedValueUSD: number;
}[] = [];

/**
 * Loads previously scraped results for caching purposes.
 *
 * Games that already have prices and calculated stats are considered
 * "cached" and won't be re-scraped. This enables:
 * - Resuming interrupted scrapes
 * - Incremental updates (only scrape new games)
 * - Faster development iteration
 *
 * Note: Games with empty prices (no market history) are NOT cached,
 * as we may want to re-check them later.
 *
 * @param filePath - Path to the prices.json file
 * @returns Map of objectid → GameResult for cached games
 */
export function loadExistingResults(filePath: string): Map<string, GameResult> {
  const existing = new Map<string, GameResult>();

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const results: GameResult[] = JSON.parse(content);

      for (const result of results) {
        // Only cache games that have actual price data
        // Games with no prices should be re-checked
        if (result.prices.length > 0 && result.calc.length > 0) {
          existing.set(result.objectid, result);
        }
      }

      console.log(`Loaded ${existing.size} cached games from existing results`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Could not load existing results: ${message}`);
    }
  }

  return existing;
}

/**
 * Extracts and converts the purchase price from a collection CSV row.
 *
 * BGG collection exports include optional "pricepaid" and "pp_currency"
 * fields that users can fill in. This function extracts these and
 * converts to USD for storage.
 *
 * If the currency has no exchange rate, we warn loudly, use 1:1 ratio,
 * and track the conversion for reporting at the end of the scrape.
 *
 * @param row - CSV row containing pricepaid and pp_currency fields
 * @param rates - Exchange rates for conversion to USD
 * @returns PurchasePrice object, or null if no price recorded
 */
export function getPurchasePrice(
  row: CsvRow,
  rates: ExchangeRates,
): PurchasePrice | null {
  const pricePaid = row.pricepaid;
  const currency = row.pp_currency;

  // Both fields must be present
  if (!pricePaid || !currency) return null;

  const value = parseFloat(pricePaid);
  if (isNaN(value) || value <= 0) return null;

  // Convert to USD using the centralized conversion function
  const valueInUSD = convertToBase(value, currency, rates);

  // Check if the currency was unknown (convertToBase warns but uses 1:1)
  if (!rates.rates[currency] && currency !== rates.base) {
    // Track for summary at end of scrape
    unknownCurrencyConversions.push({
      name: row.objectname,
      objectid: row.objectid,
      currency,
      originalValue: value,
      assumedValueUSD: valueInUSD,
    });
  }

  return {
    value,
    currency,
    valueInUSD,
  };
}

/**
 * Returns all unknown currency conversions encountered during scraping.
 * Used for reporting at the end of the scrape.
 */
export function getUnknownCurrencyConversions() {
  return unknownCurrencyConversions;
}

/**
 * Clears the unknown currency conversions tracker.
 * Call at the start of a new scrape session.
 */
export function clearUnknownCurrencyConversions() {
  unknownCurrencyConversions.length = 0;
}

/**
 * Scrapes the price history page for a single game.
 *
 * BGG's price history page shows all completed sales in a table with:
 * - Column 1: Seller info (ignored)
 * - Column 2: Sale price (e.g., "$25.00")
 * - Column 3: Condition (e.g., "Like New")
 * - Column 4: Sale date (e.g., "Nov 19, 2025")
 *
 * The page uses Angular and loads data dynamically, so we must:
 * 1. Wait for network activity to settle (networkidle2)
 * 2. Wait for the table rows to appear
 * 3. Extract text content from the rendered DOM
 *
 * @param page - Puppeteer page instance
 * @param objectid - BGG object ID for the game
 * @returns Array of parsed prices, empty if no history exists
 */
async function scrapePriceHistory(
  page: Page,
  objectid: string,
): Promise<Price[]> {
  const url = `https://boardgamegeek.com/market/pricehistory/thing/${objectid}`;
  const prices: Price[] = [];
  const startTime = Date.now();

  try {
    console.log(`    → Fetching ${url}`);

    // Navigate and wait for JavaScript to execute
    const response = await page.goto(url, {
      waitUntil: "networkidle2", // Wait until network is quiet
      timeout: 30000,
    });

    if (!response) {
      console.error(`    ✗ No response received`);
      return prices;
    }

    const status = response.status();
    if (status !== 200) {
      console.error(`    ✗ HTTP ${status} - ${response.statusText()}`);
      return prices;
    }

    // Wait for the price table to render (Angular needs time)
    const hasTable = await page
      .waitForSelector("table tbody tr", { timeout: 10000 })
      .catch(() => null);

    if (!hasTable) {
      // No table means no price history (normal for rare games)
      console.log(`    ○ No price history (${Date.now() - startTime}ms)`);
      return prices;
    }

    // Extract data from the rendered DOM
    // This runs in the browser context, not Node.js
    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll("table tbody tr");
      const results: { price: string; condition: string; saleDate: string }[] =
        [];

      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 4) {
          // Price is in column 2 (index 1)
          const priceText = cells[1]?.textContent?.trim() || "";

          // Condition is in column 3, inside a nested div
          const conditionDiv = cells[2]?.querySelector(".list-item-condition");
          const conditionText = conditionDiv?.textContent?.trim() || "";

          // Sale date is in column 4 (index 3)
          const saleDateText = cells[3]?.textContent?.trim() || "";

          if (priceText) {
            results.push({
              price: priceText,
              condition: conditionText,
              saleDate: saleDateText,
            });
          }
        }
      });

      return results;
    });

    // Parse the extracted text into structured Price objects
    for (const item of data) {
      const parsed = parsePrice(item.price);
      if (parsed) {
        prices.push({
          currency: parsed.currency,
          value: parsed.value,
          condition: item.condition,
          saleDate: item.saleDate,
        });
      }
    }

    console.log(
      `    ✓ Found ${prices.length} prices (${Date.now() - startTime}ms)`,
    );
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const err = error as Error;
    console.error(`    ✗ Error after ${elapsed}ms: ${err.message}`);
    if (err.stack) {
      console.error(`      Stack: ${err.stack.split("\n")[1]?.trim()}`);
    }
  }

  return prices;
}

/** Maximum number of retry attempts for failed scrapes */
const MAX_RETRIES = 2;

/** Delay between retries in milliseconds */
const RETRY_DELAY_MS = 2000;

/**
 * Scrapes a single game, handling page lifecycle and errors.
 *
 * Creates a new browser page for isolation, sets realistic viewport
 * and user agent to avoid bot detection, and ensures cleanup even
 * on errors. Includes retry logic for transient network failures.
 *
 * @param browser - Puppeteer browser instance
 * @param row - CSV row with game info
 * @param progress - Progress string for logging (e.g., "42/392")
 * @param rates - Exchange rates for purchase price conversion
 * @returns GameResult with prices, or null on failure
 */
export async function scrapeGame(
  browser: Browser,
  row: CsvRow,
  progress: string,
  rates: ExchangeRates,
): Promise<GameResult | null> {
  console.log(
    `[${progress}] Processing: ${row.objectname} (ID: ${row.objectid})`,
  );

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const page = await browser.newPage();

    try {
      // Set realistic viewport and user agent to avoid bot detection
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      );

      const prices = await scrapePriceHistory(page, row.objectid);

      return {
        name: row.objectname,
        objectid: row.objectid,
        purchasePrice: getPurchasePrice(row, rates),
        prices,
        calc: [], // Stats calculated after scraping
        conditiontext: row.conditiontext || undefined,
        numplays: row.numplays ? parseInt(row.numplays, 10) : undefined,
      };
    } catch (error) {
      lastError = error as Error;

      if (attempt < MAX_RETRIES) {
        console.warn(
          `    ⟳ Retry ${attempt + 1}/${MAX_RETRIES} after error: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    } finally {
      // Always close the page to free resources
      await page.close();
    }
  }

  // All retries exhausted
  console.error(
    `[${progress}] ✗ FAILED: ${row.objectname} (ID: ${row.objectid})`,
  );
  console.error(`    Error: ${lastError?.message}`);
  if (lastError?.stack) {
    console.error(
      `    Stack: ${lastError.stack
        .split("\n")
        .slice(1, 3)
        .map((s) => s.trim())
        .join(" -> ")}`,
    );
  }
  return null;
}

/**
 * Options for the scrape command.
 */
export interface ScrapeOptions {
  /** Path to the collection CSV file */
  collection: string;

  /** Path to the exchange rates JSON file */
  rates: string;

  /** Path to output the prices JSON file */
  output: string;

  /** Force re-scrape all games, ignoring cache */
  force?: boolean;

  /** Region for currency weighting (default: europe) */
  region?: Region;
}

/**
 * Main scraping orchestration function.
 *
 * This is the primary entry point for scraping. It:
 * 1. Loads the collection CSV and exchange rates
 * 2. Loads cached results to avoid re-scraping
 * 3. Launches a headless browser
 * 4. Iterates through all games, scraping uncached ones
 * 5. Calculates statistics for each game
 * 6. Saves results periodically and at the end
 * 7. Reports summary statistics
 *
 * ## Rate Limiting
 *
 * A random delay of 250-1000ms is added between requests to be
 * respectful to BGG's servers. This prevents hammering and reduces
 * the chance of being rate-limited or blocked.
 *
 * ## Progress Saving
 *
 * Results are saved every 10 games to prevent data loss if the
 * process is interrupted. The cache system allows resuming from
 * where we left off.
 *
 * @param options - Paths for input/output files
 * @param parseCsv - CSV parsing function (injected for testability)
 * @param loadExchangeRates - Rate loading function (injected for testability)
 * @returns Array of all GameResults (both scraped and cached)
 */
export async function scrape(
  options: ScrapeOptions,
  parseCsv: (path: string) => CsvRow[],
  loadExchangeRates: (
    path: string,
    baseCurrency?: string,
  ) => Promise<ExchangeRates>,
): Promise<GameResult[]> {
  // Clear any previous unknown currency tracking
  clearUnknownCurrencyConversions();

  const csvPath = options.collection;
  const ratesPath = options.rates;
  const region = options.region || DEFAULT_REGION;

  // Load input data
  console.log(`Reading CSV from: ${csvPath}`);
  const rows = parseCsv(csvPath);
  console.log(`Found ${rows.length} games in collection`);

  console.log(`Loading USD exchange rates from: ${ratesPath}`);
  const exchangeRates = await loadExchangeRates(ratesPath, "USD");
  console.log(
    `Loaded ${Object.keys(exchangeRates.rates).length} currency rates (base: ${exchangeRates.base}, as of ${exchangeRates.date})`,
  );

  console.log(`Currency weighting region: ${region}`);
  console.log(`\nProcessing ${rows.length} games...\n`);

  // Ensure output directory exists
  const dataDir = path.dirname(options.output);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const outputPath = options.output;

  // Load cached results unless force flag is set
  const existingResults = options.force
    ? new Map<string, GameResult>()
    : loadExistingResults(outputPath);

  if (options.force) {
    console.log("Force mode enabled - ignoring cache, re-scraping all games");
  }

  // Launch headless browser
  const browser = await Puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox", // Required for some environments
      "--disable-web-security", // Allow cross-origin requests
    ],
  });

  try {
    const results: GameResult[] = [];
    let skippedCount = 0;
    let errorCount = 0;
    let scrapedCount = 0;
    let totalPrices = 0;
    const startTime = Date.now();
    const errors: { name: string; objectid: string; error: string }[] = [];

    // Count how many games need scraping for ETA calculation
    const gamesToScrape = rows.filter(
      (row) => !existingResults.has(row.objectid),
    ).length;
    let scrapeStartTime = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const progress = `${i + 1}/${rows.length}`;

      // Check cache first
      const cached = existingResults.get(row.objectid);
      if (cached) {
        console.log(
          `[${progress}] ⊘ Cached: ${row.objectname} (${row.objectid})`,
        );

        // Update cached item with fresh data from CSV and recalculate stats
        // (in case exchange rates changed or CSV was updated)
        cached.purchasePrice = getPurchasePrice(row, exchangeRates);
        cached.conditiontext = row.conditiontext || undefined;
        cached.numplays = row.numplays ? parseInt(row.numplays, 10) : undefined;
        cached.calc = calculateStats(cached.prices, exchangeRates, region);

        results.push(cached);
        skippedCount++;
        totalPrices += cached.prices.length;
        continue;
      }

      // Track when actual scraping starts (for ETA calculation)
      if (scrapeStartTime === 0) {
        scrapeStartTime = Date.now();
      }

      // Scrape this game
      const result = await scrapeGame(browser, row, progress, exchangeRates);
      if (result) {
        // Track any currencies we don't have rates for
        checkMissingRates(result.prices, exchangeRates);

        // Calculate statistics now that we have prices
        result.calc = calculateStats(result.prices, exchangeRates, region);

        results.push(result);
        scrapedCount++;
        totalPrices += result.prices.length;

        // Calculate and display ETA
        if (scrapedCount > 0 && gamesToScrape > scrapedCount) {
          const elapsedMs = Date.now() - scrapeStartTime;
          const avgTimePerGame = elapsedMs / scrapedCount;
          const remainingGames = gamesToScrape - scrapedCount;
          const etaMs = remainingGames * avgTimePerGame;
          const etaMins = Math.ceil(etaMs / 60000);
          console.log(
            `    ⏱ ETA: ~${etaMins} min remaining (${remainingGames} games left)`,
          );
        }

        // Save progress every 10 games to prevent data loss
        if (scrapedCount % 10 === 0) {
          fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
          console.log(`    💾 Progress saved (${results.length} games)`);
        }
      } else {
        errorCount++;
        errors.push({
          name: row.objectname,
          objectid: row.objectid,
          error: "Scrape failed",
        });
      }

      // Rate limiting: random delay between 250-1000ms
      // This is polite to BGG's servers and reduces chance of blocking
      const delay = 250 + Math.floor(Math.random() * 750);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Final save
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

    // Print summary
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`SCRAPING COMPLETE`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Total games:     ${rows.length}`);
    console.log(`  Scraped:         ${scrapedCount}`);
    console.log(`  Cached (skip):   ${skippedCount}`);
    console.log(`  Errors:          ${errorCount}`);
    console.log(`  Total prices:    ${totalPrices}`);
    console.log(
      `  Time elapsed:    ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`,
    );
    console.log(`  Output file:     ${outputPath}`);

    if (errors.length > 0) {
      console.log(`\n✗ Failed games:`);
      errors.forEach((e) =>
        console.log(`    - ${e.name} (ID: ${e.objectid}): ${e.error}`),
      );
    }

    // Report unknown currency conversions
    const unknownConversions = getUnknownCurrencyConversions();
    if (unknownConversions.length > 0) {
      console.log(`\n⚠ UNKNOWN CURRENCY CONVERSIONS (used 1:1 ratio):`);
      console.log(`  The following games had purchase prices in currencies`);
      console.log(
        `  without exchange rates. They were converted using 1:1 ratio.`,
      );
      console.log(`  Please verify these valuations are correct:\n`);
      unknownConversions.forEach((c) =>
        console.log(
          `    - ${c.name} (ID: ${c.objectid}): ${c.originalValue} ${c.currency} → ${c.assumedValueUSD} USD`,
        ),
      );
    }

    console.log(`\n${"=".repeat(60)}\n`);

    return results;
  } finally {
    // Always close the browser to free resources
    await browser.close();
  }
}
