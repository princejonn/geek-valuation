/**
 * @fileoverview Configurable constants for the valuation system.
 *
 * All magic numbers and configurable thresholds are centralized here
 * to make it easy to tweak the valuation behavior.
 */

// =============================================================================
// CONDITION SYSTEM
// =============================================================================

/**
 * Standard BGG marketplace conditions.
 * These match the conditions used in BGG's marketplace exactly.
 */
export enum Condition {
  NEW = "New",
  LIKE_NEW = "Like New",
  VERY_GOOD = "Very Good",
  GOOD = "Good",
  ACCEPTABLE = "Acceptable",
}

/**
 * Kebab-case versions of conditions for CLI arguments.
 * Maps CLI input to the Condition enum.
 */
export const CONDITION_CLI_MAP: Record<string, Condition> = {
  new: Condition.NEW,
  "like-new": Condition.LIKE_NEW,
  "very-good": Condition.VERY_GOOD,
  good: Condition.GOOD,
  acceptable: Condition.ACCEPTABLE,
};

/**
 * Valid CLI condition values for validation and help text.
 */
export const VALID_CONDITIONS = Object.keys(CONDITION_CLI_MAP);

/**
 * Condition priority order for fallback when preferred condition has no data.
 * New is most desirable, then Like New, etc.
 */
export const CONDITION_PRIORITY: Condition[] = [
  Condition.NEW,
  Condition.LIKE_NEW,
  Condition.VERY_GOOD,
  Condition.GOOD,
  Condition.ACCEPTABLE,
];

// =============================================================================
// CONDITION INFERENCE FROM PLAY COUNT
// =============================================================================

/**
 * Thresholds for inferring game condition from number of plays.
 *
 * Logic:
 * - 0 plays: Likely still sealed/unplayed → New
 * - 1-4 plays: Played but minimal wear → Like New
 * - 5-14 plays: Regular play, some wear → Very Good
 * - 15-29 plays: Well-played → Good
 * - 30+ plays: Heavily played → Acceptable
 *
 * Adjust these thresholds based on your own assessment of wear.
 */
export const CONDITION_PLAY_THRESHOLDS = {
  /** Maximum plays to be considered "New" (0 = unplayed) */
  NEW_MAX_PLAYS: 1,

  /** Maximum plays to be considered "Like New" */
  LIKE_NEW_MAX_PLAYS: 10,

  /** Maximum plays to be considered "Very Good" */
  VERY_GOOD_MAX_PLAYS: 15,

  /** Maximum plays to be considered "Good" */
  GOOD_MAX_PLAYS: 25,

  // Anything above GOOD_MAX_PLAYS is "Acceptable"
};

/**
 * Infers a condition from the number of plays.
 *
 * @param numPlays - Number of times the game has been played
 * @returns Inferred condition based on play count thresholds
 */
export function inferConditionFromPlays(numPlays: number): Condition {
  if (numPlays <= CONDITION_PLAY_THRESHOLDS.NEW_MAX_PLAYS) {
    return Condition.NEW;
  }
  if (numPlays <= CONDITION_PLAY_THRESHOLDS.LIKE_NEW_MAX_PLAYS) {
    return Condition.LIKE_NEW;
  }
  if (numPlays <= CONDITION_PLAY_THRESHOLDS.VERY_GOOD_MAX_PLAYS) {
    return Condition.VERY_GOOD;
  }
  if (numPlays <= CONDITION_PLAY_THRESHOLDS.GOOD_MAX_PLAYS) {
    return Condition.GOOD;
  }
  return Condition.ACCEPTABLE;
}

/**
 * Parses conditiontext from CSV to a standard Condition.
 * Case-insensitive match against standard BGG conditions.
 *
 * @param conditionText - Free-form condition text from CSV
 * @returns Matched Condition or null if no match
 */
export function parseConditionText(
  conditionText: string | undefined,
): Condition | null {
  if (!conditionText || conditionText.trim() === "") {
    return null;
  }

  const normalized = conditionText.trim().toLowerCase();

  // Check against each condition (case-insensitive)
  for (const condition of Object.values(Condition)) {
    if (condition.toLowerCase() === normalized) {
      return condition;
    }
  }

  return null;
}

// =============================================================================
// VALUATION DEFAULTS
// =============================================================================

/**
 * Default condition to use when no condition can be determined.
 * Used as ultimate fallback if conditiontext, --condition flag,
 * and numplays inference all fail.
 */
export const DEFAULT_CONDITION = Condition.LIKE_NEW;

/**
 * Fallback multiplier for games without market data.
 * Applied to purchase price to estimate current value.
 *
 * 0.6 = 60% of purchase price (assumes typical depreciation)
 */
export const NO_MARKET_DATA_FALLBACK_MULTIPLIER = 0.6;

// =============================================================================
// TIME WEIGHTING
// =============================================================================

/**
 * Half-life for time-based weighting in days.
 * After this many days, a sale's weight is halved.
 *
 * 365 days = 1 year half-life
 */
export const TIME_WEIGHT_HALF_LIFE_DAYS = 365;

// =============================================================================
// CURRENCY WEIGHTING
// =============================================================================

/**
 * Weight applied to currencies outside the user's preferred region.
 * Lower values reduce the influence of non-regional sales.
 *
 * 0.3 = non-regional sales contribute 30% of their normal weight
 */
export const NON_REGIONAL_CURRENCY_WEIGHT = 0.3;

/**
 * Minimum number of sales from the preferred region required
 * to apply regional currency weighting.
 *
 * If fewer than this many regional sales exist, all currencies
 * are weighted equally.
 */
export const REGIONAL_SALES_THRESHOLD = 2;

// =============================================================================
// PRICE WEIGHTING (OUTLIER HANDLING)
// =============================================================================

/**
 * Sigma value for Gaussian price weighting.
 * Controls how quickly weight decays as prices deviate from median.
 *
 * Higher values = more tolerance for outliers
 * Lower values = stricter weighting toward median
 */
export const PRICE_WEIGHT_SIGMA = 1.0;

/**
 * Minimum weight for any price, even extreme outliers.
 * Ensures all data points contribute at least slightly.
 *
 * 0.01 = outliers contribute at least 1% of their normal weight
 */
export const MINIMUM_PRICE_WEIGHT = 0.01;
