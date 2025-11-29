/**
 * @fileoverview CSV parsing utilities for BoardGameGeek collection exports.
 *
 * BGG exports collections as CSV files with quoted fields that may contain
 * commas. This module provides a custom parser that correctly handles these
 * edge cases, which standard CSV parsers sometimes mishandle.
 *
 * The parser is intentionally simple and focused on BGG's specific format
 * rather than being a general-purpose CSV library.
 */

import * as fs from "fs";
import { CsvRow } from "./types";

/**
 * Parses a BGG collection CSV file into an array of row objects.
 *
 * BGG's CSV format uses:
 * - Comma as delimiter
 * - Double quotes around fields containing commas or quotes
 * - Double-double-quotes ("") to escape quotes within quoted fields
 *
 * @example
 * ```typescript
 * const games = parseCsv('./collection.csv');
 * console.log(games[0].objectname); // "Catan"
 * console.log(games[0].objectid);   // "13"
 * ```
 *
 * @param filePath - Absolute path to the CSV file
 * @returns Array of parsed rows, each containing at minimum objectname and objectid
 */
export function parseCsv(filePath: string): CsvRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  /**
   * Parses a single CSV line into an array of field values.
   *
   * Handles quoted fields correctly by tracking whether we're inside quotes.
   * This is necessary because game names often contain commas
   * (e.g., "Ticket to Ride: Europe, 1912").
   *
   * Also handles escaped quotes ("") which represent a literal quote
   * character inside a quoted field (e.g., "He said ""Hello""" becomes
   * He said "Hello").
   *
   * @param line - A single line from the CSV file
   * @returns Array of field values with quotes removed and whitespace trimmed
   */
  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        // Check for escaped quote ("") - two consecutive quotes
        if (inQuotes && line[i + 1] === '"') {
          // This is an escaped quote - add a literal quote and skip the next char
          current += '"';
          i++; // Skip the second quote
        } else {
          // Toggle quote state - handles both opening and closing quotes
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        // Only treat comma as delimiter when not inside quotes
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    // Don't forget the last field (no trailing comma)
    fields.push(current.trim());
    return fields;
  };

  // First line is headers - these become the keys for our row objects
  const headers = parseRow(lines[0]);
  const rows: CsvRow[] = [];

  // Parse each data row (skip header at index 0)
  for (let i = 1; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    const row: CsvRow = { objectname: "", objectid: "" };

    // Map each value to its corresponding header
    for (let j = 0; j < headers.length && j < values.length; j++) {
      row[headers[j]] = values[j];
    }

    // Only include rows that have a valid objectid (skip malformed rows)
    if (row.objectid) {
      rows.push(row);
    }
  }

  return rows;
}
