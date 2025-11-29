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
 * ## Valuation Strategy
 *
 * We prioritize "New" condition because:
 * - Sealed/unpunched games command premium prices
 * - Provides the highest defensible valuation (e.g., for insurance)
 * - Falls back to "Like New" if no "New" sales exist
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
 * 3. **Currency weighting**: European currencies preferred
 *    - SEK, EUR, DKK, NOK, GBP, CHF, etc.: weight 1.0
 *    - USD, CAD, AUD, etc.: weight 0.3 (when EU data exists)
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
 * - `source`: How the estimate was determined:
 *   - `market:new`: From New condition weighted mean
 *   - `market:like-new`: From Like New weighted mean
 *   - `market:other`: From other conditions weighted mean
 *   - `fallback`: No market data, using 60% of purchase price
 *
 * ## Collection Summary
 *
 * After generating the CSV, logs total purchase price, estimated value,
 * and the difference (gain/loss) with percentage change.
 */

import * as fs from "fs";
import { convertFromBase, loadExchangeRates } from "./currency";
import { ExchangeRates, GameResult } from "./types";

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
}

/**
 * Generates a valuation CSV from scraped price data.
 *
 * The estimated value uses the multi-factor `weightedMean` which incorporates
 * time, price, and currency weighting. Condition priority: New > Like New > Other.
 *
 * Values in prices.json are stored in USD and converted to the target currency
 * (default: SEK) at valuation time.
 *
 * @param options - Input and output file paths, target currency
 */
export async function generateValuationCsv(
  options: ValuationOptions,
): Promise<void> {
  const pricesPath = options.input;
  const outputCsvPath = options.output;
  const targetCurrency = options.targetCurrency || "SEK";

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

  console.log(
    `Generating valuation CSV from ${games.length} games (currency: ${targetCurrency})...`,
  );

  // Build CSV content with dynamic column headers based on target currency
  const csvLines: string[] = [];
  csvLines.push(
    `name,purchasePrice${targetCurrency},estimatedValue${targetCurrency},source`,
  );

  let gamesWithPrices = 0;
  let gamesWithFallback = 0;
  let totalPurchasePrice = 0;
  let totalEstimatedValue = 0;

  for (const game of games) {
    // Convert purchase price from USD to target currency
    const purchasePriceUSD = game.purchasePrice?.valueInUSD || 0;
    const purchasePrice = convertFromBase(
      purchasePriceUSD,
      targetCurrency,
      rates,
    );

    let estimatedValueUSD: number;
    let source: string;

    if (game.prices.length > 0 && game.calc.length > 0) {
      // We have market data - use weightedMean for valuation (stored in USD)

      // Prioritize "New" condition (sealed games command premium prices)
      // Fall back to "Like New" if no "New" sales exist
      const newCondition = game.calc.find((s) => s.condition === "New");
      const likeNew = game.calc.find((s) => s.condition === "Like New");
      const preferredCondition = newCondition || likeNew;

      if (preferredCondition) {
        const conditionLabel = newCondition ? "new" : "like-new";
        estimatedValueUSD = preferredCondition.weightedMean ?? 0;
        source = `market:${conditionLabel}`;
      } else {
        // No "New" or "Like New" data - find best weightedMean across all conditions
        let bestValue = 0;

        for (const stat of game.calc) {
          const weighted = stat.weightedMean ?? 0;
          if (weighted > bestValue) {
            bestValue = weighted;
          }
        }

        estimatedValueUSD = bestValue;
        source = "market:other";
      }
      gamesWithPrices++;
    } else {
      // No market data available
      // Fall back to 60% of purchase price as a conservative estimate
      // This accounts for typical depreciation of board games
      estimatedValueUSD = Math.round(purchasePriceUSD * 0.6);
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
      `${escapedName},${purchasePrice},${estimatedValue},${source}`,
    );
  }

  // Write output
  fs.writeFileSync(outputCsvPath, csvLines.join("\n"));

  // Report summary
  console.log(`\nValuation CSV generated: ${outputCsvPath}`);
  console.log(`  Games with market data: ${gamesWithPrices}`);
  console.log(`  Games with fallback:    ${gamesWithFallback}`);
  console.log(`  Total games:            ${games.length}`);

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
