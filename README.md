# geek-valuation

A command-line tool for scraping historical sale prices from BoardGameGeek's marketplace and generating valuation reports for your board game collection.

## What It Does

1. **Scrapes price history** from BGG's marketplace for each game in your collection
2. **Calculates statistics** with multi-factor weighted pricing (time, price, currency)
3. **Generates a valuation CSV** comparing what you paid vs current market value
4. **Summarizes collection value** with total purchase price, estimated value, and gain/loss

## Prerequisites

- **Node.js** 20 or later
- **npm** (comes with Node.js)
- A **BoardGameGeek collection export** (CSV format)

## Installation

```bash
npm install -g geek-valuation
```

## Quick Start

1. Export your BGG collection as CSV from BoardGameGeek
2. Navigate to the directory containing your `collection.csv`
3. Run the full pipeline:

```bash
geek-valuation all
```

4. Find your valuation report in `valuation.csv`

## Commands

### `scrape` - Scrape Price History

Fetches historical sale prices from BGG for all games in your collection.

```bash
# Use defaults (collection.csv → .data/prices.json)
geek-valuation scrape

# Custom collection path
geek-valuation scrape --collection ./my-games.csv

# Force re-scrape all games (ignore cache)
geek-valuation scrape --force

# Set region for currency weighting (default: europe)
geek-valuation scrape --region americas
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-c, --collection <path>` | `<cwd>/collection.csv` | Path to your BGG collection CSV |
| `-f, --force` | `false` | Force re-scrape all games, ignoring cache |
| `-r, --region <region>` | `europe` | Region for currency weighting (see below) |

**What it does:**

- Launches a headless Chrome browser via Puppeteer
- Visits each game's price history page on BGG
- Extracts sale prices, conditions, and dates
- Converts all prices to USD for internal storage
- Calculates statistics with multi-factor weighting
- Saves progress every 10 games (safe to interrupt)
- Skips games already in the output file (incremental updates)
- Shows ETA for remaining games during scraping
- Retries failed requests up to 2 times

### `valuation` - Generate Valuation Report

Creates a CSV comparing purchase prices to estimated market values.

```bash
# Use defaults (.data/prices.json → valuation.csv, currency: SEK)
geek-valuation valuation

# Custom output path
geek-valuation valuation --output ./my-valuation.csv

# Custom currency (e.g., EUR, USD, GBP)
geek-valuation valuation --currency EUR

# Set default condition for games without explicit condition
geek-valuation valuation --condition like-new
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <path>` | `<cwd>/valuation.csv` | Path to output valuation CSV |
| `-C, --currency <code>` | `SEK` | Target currency for valuation (ISO 4217 code) |
| `-c, --condition <cond>` | (inferred) | Default condition for valuation (see [Condition System](#condition-system)) |

**Output columns:**
| Column | Description |
|--------|-------------|
| `name` | Game name |
| `purchasePrice{CUR}` | What you paid (converted to target currency) |
| `estimatedValue{CUR}` | Current market value estimate |
| `condition` | The condition used for valuation (see [Condition System](#condition-system)) |
| `source` | How the estimate was determined |

**Source values:**

- `market:new` - From "New" condition weighted mean (exact match)
- `market:like-new` - From "Like New" weighted mean (exact match)
- `market:very-good` - From "Very Good" weighted mean (exact match)
- `market:good` - From "Good" weighted mean (exact match)
- `market:acceptable` - From "Acceptable" weighted mean (exact match)
- `market:<condition>(fallback)` - Used different condition than requested (e.g., no "New" data, fell back to "Like New")
- `fallback` - No market data; estimated as 60% of purchase price

**Collection Summary:**

After generating the CSV, a summary is logged to the console (in your chosen currency):

```
Collection Value Summary:
  Total purchase price:   125,000 SEK
  Total estimated value:  142,500 SEK
  Difference:             +17,500 SEK (14.0%)
```

This shows the combined value of your entire collection and whether it has appreciated or depreciated since purchase.

### `all` - Full Pipeline

Runs scrape + valuation in sequence.

```bash
# Use defaults
geek-valuation all

# Custom paths
geek-valuation all \
  --collection ./my-games.csv \
  --output ./my-valuation.csv

# Force re-scrape everything
geek-valuation all --force

# Custom region and currency
geek-valuation all --region americas --currency USD

# Set default condition for valuation
geek-valuation all --condition very-good
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-c, --collection <path>` | `<cwd>/collection.csv` | Path to BGG collection CSV |
| `-o, --output <path>` | `<cwd>/valuation.csv` | Path to output valuation CSV |
| `-f, --force` | `false` | Force re-scrape all games, ignoring cache |
| `-r, --region <region>` | `europe` | Region for currency weighting (see below) |
| `-C, --currency <code>` | `SEK` | Target currency for valuation (ISO 4217 code) |
| `--condition <condition>` | (inferred) | Default condition for valuation (see [Condition System](#condition-system)) |

## File Locations

| File             | Location                      | Description                          |
| ---------------- | ----------------------------- | ------------------------------------ |
| Collection CSV   | `./collection.csv`            | Your BGG collection export (input)   |
| Exchange rates   | `./.data/exchange-rates.json` | Cached currency rates (auto-fetched) |
| Price data       | `./.data/prices.json`         | Scraped prices + statistics          |
| Valuation report | `./valuation.csv`             | Final output                         |

The `.data/` directory is created automatically and contains cached data that can be safely deleted.

## Data Flow

```
collection.csv (BGG export)
      │
      ▼
┌─────────────┐     ┌──────────────────────┐
│   scrape    │────▶│ exchange-rates.json  │ (auto-fetched from ECB)
│   command   │     └──────────────────────┘
│             │
│             │────▶ prices.json (scraped data + statistics)
└─────────────┘
      │
      ▼
┌─────────────┐
│  valuation  │────▶ valuation.csv (final report)
│   command   │
└─────────────┘
```

## How Valuation Works

### Multi-Factor Weighted Pricing

The tool uses a sophisticated weighting system that combines three factors multiplicatively. This approach provides more accurate valuations than simple averages or hard outlier removal.

#### 1. Time Weighting

Market prices change over time. Recent sales are more relevant.

- **Exponential decay with 1-year half-life**
  - Today's sale: weight 1.0
  - 6 months ago: weight ~0.71
  - 1 year ago: weight 0.5
  - 2 years ago: weight 0.25
  - 3 years ago: weight 0.125

#### 2. Price Weighting (Soft Outliers)

Instead of completely removing outliers (which loses information), extreme prices get reduced weight:

- **Gaussian decay from median**
  - At median: weight 1.0
  - 1 IQR from median: weight ~0.61
  - 2 IQR from median: weight ~0.14
  - 3 IQR from median: weight ~0.01
  - Minimum weight: 0.01 (outliers still contribute slightly)

#### 3. Currency Weighting (Region-Based)

Currencies from your preferred region are weighted higher. This accounts for local market conditions and shipping costs.

**Supported regions:**
| Region | Currencies |
|--------|------------|
| `europe` (default) | SEK, EUR, DKK, NOK, GBP, CHF, PLN, CZK, HUF, RON, BGN, HRK, ISK, RUB, UAH, TRY |
| `americas` | USD, CAD, MXN, BRL, ARS, CLP, COP, PEN |
| `asia` | JPY, CNY, KRW, SGD, HKD, TWD, THB, MYR, PHP, IDR, VND |
| `india` | INR |
| `oceania` | AUD, NZD |

**Weighting rules:**

- **When ≥2 sales from your region exist:**
  - Regional currencies: weight 1.0
  - Non-regional currencies: weight 0.3
- **When insufficient regional data:** all currencies weighted equally

#### Combined Weight Formula

```
combinedWeight = timeWeight × priceWeight × currencyWeight
weightedMean = Σ(value × combinedWeight) / Σ(combinedWeight)
```

This ensures valuations reflect your regional market conditions while still incorporating global data where relevant.

### Condition System

The tool supports **per-game condition** for more accurate valuations. Each game's condition is determined in priority order:

#### 1. `conditiontext` from CSV (Highest Priority)

If your BGG collection CSV has a `conditiontext` column with a value matching a standard BGG condition (case-insensitive), that condition is used for valuation.

**Valid values:** `New`, `Like New`, `Very Good`, `Good`, `Acceptable`

You can add this column to your exported CSV using a spreadsheet editor (Numbers, Excel, etc.).

#### 2. `--condition` CLI Flag

If no `conditiontext` is set for a game, the `--condition` flag provides a global default.

**Valid values (kebab-case):** `new`, `like-new`, `very-good`, `good`, `acceptable`

```bash
geek-valuation valuation --condition like-new
geek-valuation all --condition very-good
```

#### 3. Inferred from Play Count

If neither `conditiontext` nor `--condition` is set, condition is inferred from `numplays`:

| Plays | Inferred Condition |
| ----- | ------------------ |
| 0-1   | New                |
| 2-10  | Like New           |
| 11-15 | Very Good          |
| 16-25 | Good               |
| 26+   | Acceptable         |

These thresholds can be customized in `src/constants.ts` (see [Customizing Condition Thresholds](#customizing-condition-thresholds)).

#### 4. Ultimate Fallback

If none of the above apply, defaults to **Like New**.

#### Market Data Condition Fallback

Once the game's condition is determined, the tool looks for market data matching that condition. If no exact match exists, it falls back through the condition priority order:

1. New (highest value)
2. Like New
3. Very Good
4. Good
5. Acceptable (lowest value)

The `source` column in the output CSV indicates whether an exact match was found or a fallback was used (e.g., `market:like-new(fallback)`).

#### Customizing Condition Thresholds

Edit `src/constants.ts` to customize the condition inference thresholds:

```typescript
export const CONDITION_PLAY_THRESHOLDS = {
  NEW_MAX_PLAYS: 1, // 0-1 plays = New
  LIKE_NEW_MAX_PLAYS: 10, // 2-10 plays = Like New
  VERY_GOOD_MAX_PLAYS: 15, // 11-15 plays = Very Good
  GOOD_MAX_PLAYS: 25, // 16-25 plays = Good
  // 26+ plays = Acceptable
};

// Default condition when nothing else applies
export const DEFAULT_CONDITION = Condition.LIKE_NEW;
```

### No Market Data

For rare games, new releases, or expansions without sales history:

- Estimates value as **60% of purchase price**
- This is conservative but better than showing zero
- The 60% figure is a rough industry average for board game depreciation

### Handling Anomalies

Raw marketplace data contains anomalies:

- Bulk sales at deep discounts
- Mislabeled conditions
- Rare variants or signed copies

The tool uses **soft weighting** instead of removing outliers:

- Prices near the median get full weight
- Prices further away get progressively lower weight
- Even extreme outliers contribute slightly (weight ≥0.01)

This preserves all information while reducing the influence of anomalies.

## Exchange Rates

- Rates are fetched automatically from the [Frankfurter API](https://frankfurter.app) (ECB data)
- Cached locally and refreshed **daily** (stale if date is not today)
- Prices are stored internally in **USD** for consistency
- At valuation time, prices are converted to your target currency (default: SEK)
- The cache supports multiple base currencies for efficient conversion
- If the API is unavailable, stale cached rates are used as fallback
- Unknown currencies in purchase prices are converted using 1:1 ratio with a warning

## Scraping Behavior

### Rate Limiting

To be respectful to BGG's servers:

- Random 250-1000ms delay between requests
- Progress saved every 10 games
- Caching prevents re-scraping known games

### Retry Logic

Failed requests are automatically retried:

- Up to 2 retry attempts per game
- 2-second delay between retries
- Helps handle transient network issues

### ETA Display

During scraping, the tool shows:

- Current progress (e.g., `[42/392]`)
- Estimated time remaining
- Number of games left to scrape

A full scrape of ~400 games takes approximately 15-20 minutes.

## Troubleshooting

### "No price history" for many games

This is normal. Many games (especially expansions, promos, and obscure titles) have never been sold on BGG's marketplace.

### Scrape interrupted

Just run the command again. Games already in `prices.json` with data are skipped automatically. Use `--force` to re-scrape everything.

### Exchange rate fetch failed

The tool will use cached rates if available. If no cache exists and the API is down, wait and try again later.

### "Unknown currency" warnings

If your collection has purchase prices in currencies not supported by the ECB (exotic currencies), the tool will:

1. Warn loudly during scraping
2. Assume the currency is USD for conversion
3. Report all such conversions at the end of the scrape

Review these warnings and verify the valuations are correct.

### "Unknown currency format" warnings

Some price formats on BGG aren't recognized. The tool logs these for debugging. Common formats are supported; exotic ones may be skipped.

### Browser/Puppeteer issues

Make sure you have Chrome installed. If running in a containerized environment, you may need additional dependencies:

```bash
# Debian/Ubuntu
apt-get install -y chromium-browser

# Or use Puppeteer's bundled Chromium
npx puppeteer browsers install chrome
```

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/princejonn/geek-valuation.git
cd geek-valuation

# Install dependencies
npm install
```

### Available Scripts

```bash
# Run the CLI (development)
npm start -- all

# Build for distribution
npm run build

# Type-check in watch mode
npm run typecheck

# Run tests
npm test

# Lint code
npm run lint

# Format code
npm run format

# Run all checks (typecheck, format, lint, test)
npm run verify

# Update dependencies interactively
npm run update
```

### Project Structure

```
geek-valuation/
├── src/
│   ├── main.ts        # CLI entry point (Commander)
│   ├── constants.ts   # Configurable thresholds and enums
│   ├── csv.ts         # CSV parsing
│   ├── currency.ts    # Price parsing & exchange rates
│   ├── scraper.ts     # Puppeteer web scraping
│   ├── stats.ts       # Statistical calculations
│   ├── valuation.ts   # Valuation report generation
│   └── types.ts       # TypeScript interfaces
├── .data/             # Auto-created cache directory
│   ├── exchange-rates.json
│   └── prices.json
├── collection.csv     # Your BGG export (you provide this)
├── valuation.csv      # Generated report
├── jest.config.js     # Jest test configuration
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT

## Contributing

Issues and pull requests welcome at [github.com/princejonn/geek-valuation](https://github.com/princejonn/geek-valuation).
