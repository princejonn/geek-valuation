import { parsePrice, convertToBase, convertFromBase } from "./currency";
import { ExchangeRates } from "./types";

describe("parsePrice", () => {
  it("parses USD with $ symbol", () => {
    expect(parsePrice("$25.00")).toEqual({ currency: "USD", value: 25 });
    expect(parsePrice("$100")).toEqual({ currency: "USD", value: 100 });
  });

  it("parses EUR with € symbol", () => {
    expect(parsePrice("€30")).toEqual({ currency: "EUR", value: 30 });
    expect(parsePrice("€45.50")).toEqual({ currency: "EUR", value: 45.5 });
  });

  it("parses GBP with £ symbol", () => {
    expect(parsePrice("£20")).toEqual({ currency: "GBP", value: 20 });
  });

  it("parses country-prefixed dollars", () => {
    expect(parsePrice("US$25")).toEqual({ currency: "USD", value: 25 });
    expect(parsePrice("CA$30")).toEqual({ currency: "CAD", value: 30 });
    expect(parsePrice("A$35")).toEqual({ currency: "AUD", value: 35 });
  });

  it("parses CODE prefix format", () => {
    expect(parsePrice("CHF 50")).toEqual({ currency: "CHF", value: 50 });
    expect(parsePrice("DKK 100")).toEqual({ currency: "DKK", value: 100 });
  });

  it("parses CODE suffix format", () => {
    expect(parsePrice("100 SEK")).toEqual({ currency: "SEK", value: 100 });
    expect(parsePrice("50.00 EUR")).toEqual({ currency: "EUR", value: 50 });
  });

  it("handles thousand separators", () => {
    expect(parsePrice("$1,500")).toEqual({ currency: "USD", value: 1500 });
    expect(parsePrice("1,000 SEK")).toEqual({ currency: "SEK", value: 1000 });
  });

  it("returns null for empty strings", () => {
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("  ")).toBeNull();
  });
});

describe("convertToBase", () => {
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

  it("returns same value for base currency", () => {
    expect(convertToBase(100, "USD", rates)).toBe(100);
  });

  it("converts EUR to USD", () => {
    // 100 EUR / 0.92 = ~109 USD
    expect(convertToBase(100, "EUR", rates)).toBe(109);
  });

  it("converts SEK to USD", () => {
    // 100 SEK / 10.5 = ~10 USD
    expect(convertToBase(100, "SEK", rates)).toBe(10);
  });

  it("rounds to whole numbers", () => {
    expect(convertToBase(50, "EUR", rates)).toBe(54); // 50 / 0.92 = 54.35
  });
});

describe("convertFromBase", () => {
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

  it("returns same value for base currency", () => {
    expect(convertFromBase(100, "USD", rates)).toBe(100);
  });

  it("converts USD to SEK", () => {
    // 100 USD * 10.5 = 1050 SEK
    expect(convertFromBase(100, "SEK", rates)).toBe(1050);
  });

  it("converts USD to EUR", () => {
    // 100 USD * 0.92 = 92 EUR
    expect(convertFromBase(100, "EUR", rates)).toBe(92);
  });

  it("rounds to whole numbers", () => {
    expect(convertFromBase(33, "SEK", rates)).toBe(347); // 33 * 10.5 = 346.5
  });
});
