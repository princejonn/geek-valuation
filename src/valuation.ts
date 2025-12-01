/**
 * @fileoverview Valuation report generation from scraped price data.
 *
 * This module generates a CSV report comparing what you paid for games
 * versus their estimated current market value. Useful for:
 * - Insurance purposes (documenting collection value)
 * - Understanding investment/depreciation of your collection
 * - Deciding which games to sell
 *
 * ## Currency Handling
 *
 * All values in prices.json are stored in USD as the base currency.
 * At valuation time, values are converted to the user's target currency
 * (default: SEK) using current exchange rates.
 *
 * ## Condition Determination
 *
 * The condition for each game is determined in priority order:
 * 1. **conditiontext from CSV** - If it matches a standard BGG condition
 * 2. **--condition flag** - Global fallback condition from CLI
 * 3. **numplays inference** - Infer from play count (0 plays = New, etc.)
 * 4. **Default** - Falls back to Like New if nothing else works
 *
 * ## Valuation Strategy
 *
 * Once condition is determined, we look for market data matching that condition.
 * If no exact match exists, we fall back through the condition priority order.
 *
 * ### Multi-Factor Weighted Valuation
 *
 * All valuations use the `weightedMean` which combines three factors:
 *
 * 1. **Time weighting**: Recent sales weighted higher
 *    - Exponential decay with 1-year half-life
 *    - Today: 1.0, 1 year ago: 0.5, 2 years ago: 0.25
 *
 * 2. **Price weighting**: Outliers weighted lower (not removed)
 *    - Gaussian decay from median based on IQR distance
 *    - At median: 1.0, 2 IQR away: ~0.14, 3 IQR away: ~0.01
 *
 * 3. **Currency weighting**: Regional currencies preferred
 *    - Configurable by region (default: Europe)
 *
 * Combined: `weight = timeWeight × priceWeight × currencyWeight`
 *
 * ## No Market Data Fallback
 *
 * For games without market data (rare games, new releases, expansions),
 * we estimate value as 60% of purchase price. This is conservative but
 * better than showing zero.
 *
 * ## Output Format
 *
 * The CSV contains:
 * - `name`: Game name
 * - `purchasePrice{CUR}`: What you paid (converted to target currency)
 * - `estimatedValue{CUR}`: Current market value estimate
 * - `condition`: The condition used for valuation
 * - `source`: How the estimate was determined
 *
 * ## Collection Summary
 *
 * After generating the CSV, logs total purchase price, estimated value,
 * and the difference (gain/loss) with percentage change.
 */

import * as fs from "fs";
import {
  Condition,
  CONDITION_PRIORITY,
  DEFAULT_CONDITION,
  inferConditionFromPlays,
  NO_MARKET_DATA_FALLBACK_MULTIPLIER,
  parseConditionText,
} from "./constants";
import { convertFromBase, loadExchangeRates } from "./currency";
import { ConditionStats, ExchangeRates, GameResult } from "./types";

/**
 * Options for the valuation command.
 */
export interface ValuationOptions {
  /** Path to the prices.json input file */
  input: string;

  /** Path to output the valuation CSV */
  output: string;

  /** Path to the exchange rates cache file */
  ratesPath: string;

  /** Target currency for the valuation report (default: SEK) */
  targetCurrency?: string;

  /**
   * Default condition to use when conditiontext is not provided.
   * If not set, condition will be inferred from numplays.
   */
  defaultCondition?: Condition;
}

/**
 * Determines the condition to use for a game's valuation.
 *
 * Priority:
 * 1. conditiontext from CSV (if it matches a standard condition)
 * 2. defaultCondition from CLI flag
 * 3. Inferred from numplays
 * 4. Ultimate fallback: DEFAULT_CONDITION
 *
 * @param game - The game to determine condition for
 * @param defaultCondition - Optional default from CLI flag
 * @returns The condition to use for valuation
 */
function determineCondition(
  game: GameResult,
  defaultCondition?: Condition,
): Condition {
  // 1. Try to parse conditiontext from CSV
  const parsedCondition = parseConditionText(game.conditiontext);
  if (parsedCondition) {
    return parsedCondition;
  }

  // 2. Use CLI default if provided
  if (defaultCondition) {
    return defaultCondition;
  }

  // 3. Infer from numplays
  if (game.numplays !== undefined) {
    return inferConditionFromPlays(game.numplays);
  }

  // 4. Ultimate fallback
  return DEFAULT_CONDITION;
}

/**
 * Finds the best matching calc entry for a condition.
 *
 * If the exact condition doesn't exist in calc, falls back through
 * the condition priority order until a match is found.
 *
 * @param calc - Array of condition statistics
 * @param targetCondition - The condition we're looking for
 * @returns The matching ConditionStats and the condition it matched, or null
 */
function findCalcForCondition(
  calc: ConditionStats[],
  targetCondition: Condition,
): { stats: ConditionStats; matchedCondition: Condition } | null {
  if (calc.length === 0) {
    return null;
  }

  // Try exact match first (compare as strings since calc.condition is string)
  const exactMatch = calc.find(
    (c) => c.condition === (targetCondition as string),
  );
  if (exactMatch) {
    return { stats: exactMatch, matchedCondition: targetCondition };
  }

  // Fall back through priority order
  for (const condition of CONDITION_PRIORITY) {
    const match = calc.find((c) => c.condition === (condition as string));
    if (match) {
      return { stats: match, matchedCondition: condition };
    }
  }

  // No match found in priority order, return first available
  return {
    stats: calc[0],
    matchedCondition: calc[0].condition as Condition,
  };
}

/**
 * Generates a valuation CSV from scraped price data.
 *
 * The estimated value uses the multi-factor `weightedMean` which incorporates
 * time, price, and currency weighting. Condition is determined per-game based
 * on conditiontext, CLI flag, or numplays inference.
 *
 * Values in prices.json are stored in USD and converted to the target currency
 * (default: SEK) at valuation time.
 *
 * @param options - Input and output file paths, target currency, default condition
 */
export async function generateValuationCsv(
  options: ValuationOptions,
): Promise<void> {
  const pricesPath = options.input;
  const outputCsvPath = options.output;
  const targetCurrency = options.targetCurrency || "SEK";
  const defaultCondition = options.defaultCondition;

  if (!fs.existsSync(pricesPath)) {
    console.error(`Error: prices.json not found at ${pricesPath}`);
    return;
  }

  // Load exchange rates for converting USD to target currency
  console.log(`Loading exchange rates for ${targetCurrency}...`);
  let rates: ExchangeRates;
  try {
    rates = await loadExchangeRates(options.ratesPath, "USD");
    console.log(`Loaded rates (base: ${rates.base}, as of ${rates.date})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load exchange rates: ${message}`);
    return;
  }

  const content = fs.readFileSync(pricesPath, "utf-8");
  const games: GameResult[] = JSON.parse(content);

  if (defaultCondition) {
    console.log(`Default condition: ${defaultCondition}`);
  } else {
    console.log(`Condition: per-game (from CSV or inferred from plays)`);
  }

  console.log(
    `Generating valuation CSV from ${games.length} games (currency: ${targetCurrency})...`,
  );

  // Build CSV content with dynamic column headers based on target currency
  const csvLines: string[] = [];
  csvLines.push(
    `name,purchasePrice${targetCurrency},estimatedValue${targetCurrency},condition,source`,
  );

  let gamesWithPrices = 0;
  let gamesWithFallback = 0;
  let totalPurchasePrice = 0;
  let totalEstimatedValue = 0;

  // Track condition usage for summary
  const conditionCounts: Record<string, number> = {};

  for (const game of games) {
    // Convert purchase price from USD to target currency
    const purchasePriceUSD = game.purchasePrice?.valueInUSD || 0;
    const purchasePrice = convertFromBase(
      purchasePriceUSD,
      targetCurrency,
      rates,
    );

    // Determine the condition for this game
    const gameCondition = determineCondition(game, defaultCondition);
    conditionCounts[gameCondition] = (conditionCounts[gameCondition] || 0) + 1;

    let estimatedValueUSD: number;
    let source: string;
    let usedCondition: string = gameCondition;

    if (game.prices.length > 0 && game.calc.length > 0) {
      // We have market data - find the best match for our condition
      const match = findCalcForCondition(game.calc, gameCondition);

      if (match) {
        estimatedValueUSD = match.stats.weightedMean ?? 0;
        usedCondition = match.matchedCondition;

        // Source indicates if we got exact match or fallback
        if (match.matchedCondition === gameCondition) {
          source = `market:${gameCondition.toLowerCase().replace(" ", "-")}`;
        } else {
          source = `market:${match.matchedCondition.toLowerCase().replace(" ", "-")}(fallback)`;
        }
      } else {
        // No calc data despite having prices (shouldn't happen)
        estimatedValueUSD = Math.round(
          purchasePriceUSD * NO_MARKET_DATA_FALLBACK_MULTIPLIER,
        );
        source = "fallback";
      }
      gamesWithPrices++;
    } else {
      // No market data available
      // Fall back to configured percentage of purchase price
      estimatedValueUSD = Math.round(
        purchasePriceUSD * NO_MARKET_DATA_FALLBACK_MULTIPLIER,
      );
      source = "fallback";
      gamesWithFallback++;
    }

    // Convert estimated value from USD to target currency
    const estimatedValue = convertFromBase(
      estimatedValueUSD,
      targetCurrency,
      rates,
    );

    // Warn about games we couldn't value (no market data AND no purchase price)
    if (estimatedValue === 0) {
      console.warn(
        `  ⚠ No estimated value for: ${game.name} (ID: ${game.objectid})`,
      );
    }

    // Accumulate totals for summary
    totalPurchasePrice += purchasePrice;
    totalEstimatedValue += estimatedValue;

    // Escape game name for CSV if it contains special characters
    // CSV standard: wrap in quotes and escape internal quotes by doubling
    let escapedName = game.name;
    if (escapedName.includes(",") || escapedName.includes('"')) {
      escapedName = `"${escapedName.replace(/"/g, '""')}"`;
    }

    csvLines.push(
      `${escapedName},${purchasePrice},${estimatedValue},${usedCondition},${source}`,
    );
  }

  // Write output
  fs.writeFileSync(outputCsvPath, csvLines.join("\n"));

  // Report summary
  console.log(`\nValuation CSV generated: ${outputCsvPath}`);
  console.log(`  Games with market data: ${gamesWithPrices}`);
  console.log(`  Games with fallback:    ${gamesWithFallback}`);
  console.log(`  Total games:            ${games.length}`);

  // Report condition distribution
  console.log(`\nCondition distribution:`);
  for (const condition of CONDITION_PRIORITY) {
    const count = conditionCounts[condition] || 0;
    if (count > 0) {
      console.log(`  ${condition}: ${count}`);
    }
  }

  // Report collection totals
  const valueDifference = totalEstimatedValue - totalPurchasePrice;
  const percentChange =
    totalPurchasePrice > 0
      ? ((valueDifference / totalPurchasePrice) * 100).toFixed(1)
      : "N/A";

  console.log(`\nCollection Value Summary:`);
  console.log(
    `  Total purchase price:   ${totalPurchasePrice.toLocaleString()} ${targetCurrency}`,
  );
  console.log(
    `  Total estimated value:  ${totalEstimatedValue.toLocaleString()} ${targetCurrency}`,
  );
  console.log(
    `  Difference:             ${valueDifference >= 0 ? "+" : ""}${valueDifference.toLocaleString()} ${targetCurrency} (${percentChange}%)`,
  );
}
