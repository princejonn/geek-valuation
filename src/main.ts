#!/usr/bin/env node
/**
 * @fileoverview CLI entry point for the BoardGameGeek price scraper.
 *
 * This tool scrapes historical sale prices from BoardGameGeek's marketplace
 * and generates valuation reports for your game collection.
 *
 * ## Installation
 *
 * ```bash
 * npm install
 * ```
 *
 * ## Usage
 *
 * ### Scrape prices from BGG
 *
 * ```bash
 * npx ts-node src/main.ts scrape
 * npx ts-node src/main.ts scrape --collection ./my-games.csv
 * npx ts-node src/main.ts scrape --force  # Re-scrape all, ignore cache
 * ```
 *
 * ### Generate valuation report
 *
 * ```bash
 * npx ts-node src/main.ts valuation
 * npx ts-node src/main.ts valuation --output ./my-valuation.csv
 * npx ts-node src/main.ts valuation --condition like-new  # Set default condition
 * ```
 *
 * ### Do both (scrape + valuation)
 *
 * ```bash
 * npx ts-node src/main.ts all
 * npx ts-node src/main.ts all --force  # Re-scrape all, ignore cache
 * npx ts-node src/main.ts all --condition very-good  # Set default condition
 * ```
 *
 * ## Condition System
 *
 * The valuation uses per-game conditions determined in priority order:
 *
 * 1. **conditiontext from CSV** - If it matches a standard BGG condition
 *    (case-insensitive: "New", "Like New", "Very Good", "Good", "Acceptable")
 * 2. **--condition flag** - Global fallback condition from CLI (kebab-case:
 *    new, like-new, very-good, good, acceptable)
 * 3. **numplays inference** - Inferred from play count (0 plays = New, etc.)
 * 4. **Default** - Falls back to "Like New" if nothing else works
 *
 * See `src/constants.ts` for configurable thresholds.
 *
 * ## File Locations
 *
 * All paths relative to current working directory:
 * - Collection CSV: `<cwd>/collection.csv` (customizable via --collection)
 * - Exchange rates: `<cwd>/.data/exchange-rates.json` (auto-fetched)
 * - Price data: `<cwd>/.data/prices.json` (auto-managed)
 * - Valuation report: `<cwd>/valuation.csv` (customizable via --output)
 *
 * ## Data Flow
 *
 * ```
 * collection.csv (BGG export)
 *       ↓
 * [scrape command]
 *       ↓
 * prices.json (raw + calculated stats)
 *       ↓
 * [valuation command]
 *       ↓
 * valuation.csv (summary report)
 * ```
 */

import { Command } from "commander";
import * as path from "path";
import { Condition, CONDITION_CLI_MAP, VALID_CONDITIONS } from "./constants";
import { parseCsv } from "./csv";
import { loadExchangeRates } from "./currency";
import { scrape } from "./scraper";
import { DEFAULT_REGION, Region } from "./stats";
import { generateValuationCsv } from "./valuation";

/**
 * Parses and validates a condition CLI argument.
 * @param value - The CLI value (kebab-case)
 * @returns The Condition enum value
 * @throws Error if invalid condition
 */
function parseConditionArg(value: string): Condition {
  const condition = CONDITION_CLI_MAP[value.toLowerCase()];
  if (!condition) {
    throw new Error(
      `Invalid condition: "${value}". Valid options: ${VALID_CONDITIONS.join(", ")}`,
    );
  }
  return condition;
}

/**
 * Default directory for data files (prices, exchange rates).
 * Hidden directory in cwd to keep project root clean.
 */
const DATA_DIR = path.join(process.cwd(), ".data");

/**
 * Resolves a file path relative to the current working directory.
 *
 * This allows users to specify paths like `./output.csv` or `data/prices.json`
 * and have them correctly resolved regardless of where the script is located.
 *
 * Absolute paths are returned unchanged.
 *
 * @example
 * ```typescript
 * // If cwd is /home/user/project:
 * resolvePath('./data.csv')      // → /home/user/project/data.csv
 * resolvePath('output.csv')      // → /home/user/project/output.csv
 * resolvePath('/tmp/data.csv')   // → /tmp/data.csv (unchanged)
 * ```
 *
 * @param inputPath - Relative or absolute path from user input
 * @returns Absolute path resolved from cwd
 */
function resolvePath(inputPath: string): string {
  return path.resolve(process.cwd(), inputPath);
}

// ============================================================================
// CLI Definition
// ============================================================================

const program = new Command();

program
  .name("geek-valuation")
  .description("BoardGameGeek price scraper and valuation tool")
  .version("1.0.0");

// ----------------------------------------------------------------------------
// Scrape Command
// ----------------------------------------------------------------------------

program
  .command("scrape")
  .description("Scrape price history from BoardGameGeek")
  .option(
    "-c, --collection <path>",
    "Path to collection CSV",
    path.join(process.cwd(), "collection.csv"),
  )
  .option("-f, --force", "Force re-scrape all games (ignore cache)")
  .option(
    "-r, --region <region>",
    "Region for currency weighting (europe, americas, asia, india, oceania)",
    DEFAULT_REGION,
  )
  .action(
    async (options: {
      collection: string;
      force?: boolean;
      region: string;
    }) => {
      try {
        await scrape(
          {
            collection: resolvePath(options.collection),
            rates: path.join(DATA_DIR, "exchange-rates.json"),
            output: path.join(DATA_DIR, "prices.json"),
            force: options.force || false,
            region: options.region as Region,
          },
          parseCsv,
          loadExchangeRates,
        );
        console.log("\nDone!");
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    },
  );

// ----------------------------------------------------------------------------
// Valuation Command
// ----------------------------------------------------------------------------

program
  .command("valuation")
  .description("Generate valuation CSV from scraped prices")
  .option(
    "-o, --output <path>",
    "Path to output valuation CSV",
    path.join(process.cwd(), "valuation.csv"),
  )
  .option(
    "-C, --currency <code>",
    "Target currency for valuation (ISO 4217 code)",
    "SEK",
  )
  .option(
    "-c, --condition <condition>",
    `Default condition for valuation (${VALID_CONDITIONS.join(", ")})`,
  )
  .action(
    async (options: {
      output: string;
      currency: string;
      condition?: string;
    }) => {
      try {
        await generateValuationCsv({
          input: path.join(DATA_DIR, "prices.json"),
          output: resolvePath(options.output),
          ratesPath: path.join(DATA_DIR, "exchange-rates.json"),
          targetCurrency: options.currency,
          defaultCondition: options.condition
            ? parseConditionArg(options.condition)
            : undefined,
        });
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    },
  );

// ----------------------------------------------------------------------------
// All Command (Scrape + Valuation)
// ----------------------------------------------------------------------------

program
  .command("all")
  .description("Scrape prices and generate valuation CSV")
  .option(
    "-c, --collection <path>",
    "Path to collection CSV",
    path.join(process.cwd(), "collection.csv"),
  )
  .option(
    "-o, --output <path>",
    "Path to output valuation CSV",
    path.join(process.cwd(), "valuation.csv"),
  )
  .option("-f, --force", "Force re-scrape all games (ignore cache)")
  .option(
    "-r, --region <region>",
    "Region for currency weighting (europe, americas, asia, india, oceania)",
    DEFAULT_REGION,
  )
  .option(
    "-C, --currency <code>",
    "Target currency for valuation (ISO 4217 code)",
    "SEK",
  )
  .option(
    "--condition <condition>",
    `Default condition for valuation (${VALID_CONDITIONS.join(", ")})`,
  )
  .action(
    async (options: {
      collection: string;
      output: string;
      force?: boolean;
      region: string;
      currency: string;
      condition?: string;
    }) => {
      try {
        const pricesPath = path.join(DATA_DIR, "prices.json");
        const ratesPath = path.join(DATA_DIR, "exchange-rates.json");

        await scrape(
          {
            collection: resolvePath(options.collection),
            rates: ratesPath,
            output: pricesPath,
            force: options.force || false,
            region: options.region as Region,
          },
          parseCsv,
          loadExchangeRates,
        );

        console.log("\nDone scraping!");

        await generateValuationCsv({
          input: pricesPath,
          output: resolvePath(options.output),
          ratesPath,
          targetCurrency: options.currency,
          defaultCondition: options.condition
            ? parseConditionArg(options.condition)
            : undefined,
        });
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    },
  );

// Parse command line arguments and execute
program.parse();
