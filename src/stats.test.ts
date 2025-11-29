import { calculateStats, DEFAULT_REGION, Region } from "./stats";
import { ExchangeRates, Price } from "./types";

describe("calculateStats", () => {
  const rates: ExchangeRates = {
    base: "USD",
    date: "2024-01-01",
    rates: {
      USD: 1,
      EUR: 0.92,
      SEK: 10.5,
      GBP: 0.79,
    },
  };

  const today = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  it("returns empty array for no prices", () => {
    const result = calculateStats([], rates);
    expect(result).toEqual([]);
  });

  it("calculates basic statistics for single condition", () => {
    const prices: Price[] = [
      { currency: "USD", value: 50, condition: "New", saleDate: today },
      { currency: "USD", value: 60, condition: "New", saleDate: today },
      { currency: "USD", value: 70, condition: "New", saleDate: today },
    ];

    const result = calculateStats(prices, rates);

    expect(result).toHaveLength(1);
    expect(result[0].condition).toBe("New");
    expect(result[0].count).toBe(3);
    expect(result[0].median).toBe(60);
    expect(result[0].lowest).toBe(50);
    expect(result[0].highest).toBe(70);
    expect(result[0].mean).toBe(60);
  });

  it("groups statistics by condition", () => {
    const prices: Price[] = [
      { currency: "USD", value: 100, condition: "New", saleDate: today },
      { currency: "USD", value: 80, condition: "Like New", saleDate: today },
      { currency: "USD", value: 60, condition: "Good", saleDate: today },
    ];

    const result = calculateStats(prices, rates);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.condition)).toEqual(["New", "Like New", "Good"]);
  });

  it("sorts conditions in standard order", () => {
    const prices: Price[] = [
      { currency: "USD", value: 60, condition: "Good", saleDate: today },
      { currency: "USD", value: 100, condition: "New", saleDate: today },
      { currency: "USD", value: 40, condition: "Acceptable", saleDate: today },
      { currency: "USD", value: 80, condition: "Like New", saleDate: today },
      { currency: "USD", value: 70, condition: "Very Good", saleDate: today },
    ];

    const result = calculateStats(prices, rates);

    expect(result.map((r) => r.condition)).toEqual([
      "New",
      "Like New",
      "Very Good",
      "Good",
      "Acceptable",
    ]);
  });

  it("converts prices to USD for calculations", () => {
    const prices: Price[] = [
      { currency: "SEK", value: 1050, condition: "New", saleDate: today }, // 100 USD
      { currency: "EUR", value: 92, condition: "New", saleDate: today }, // 100 USD
      { currency: "USD", value: 100, condition: "New", saleDate: today }, // 100 USD
    ];

    const result = calculateStats(prices, rates);

    expect(result[0].median).toBe(100);
    expect(result[0].mean).toBe(100);
  });

  it("uses default region (europe)", () => {
    expect(DEFAULT_REGION).toBe("europe");
  });

  it("accepts region parameter", () => {
    const prices: Price[] = [
      { currency: "USD", value: 100, condition: "New", saleDate: today },
    ];

    // Should not throw for any valid region
    const regions: Region[] = [
      "europe",
      "americas",
      "asia",
      "india",
      "oceania",
    ];
    for (const region of regions) {
      expect(() => calculateStats(prices, rates, region)).not.toThrow();
    }
  });
});
