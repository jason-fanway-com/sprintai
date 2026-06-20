/**
 * Canonical CSV parser — the inverse of serialize.rowsToCsv.
 *
 * RFC-4180-ish: handles quoted fields, escaped quotes (""), commas and newlines
 * inside quotes. Validates the header is exactly the seven canonical columns in
 * order. Pure / runtime-agnostic.
 */

import { CanonicalRow, CSV_COLUMNS } from "./types.ts";

/** Parse a canonical 7-column CSV string into rows. Throws on header mismatch. */
export function parseCanonicalCsv(csv: string): CanonicalRow[] {
  const records = parseCsvRecords(csv);
  if (records.length === 0) throw new Error("CSV is empty");

  const header = records[0];
  if (header.length !== CSV_COLUMNS.length || !CSV_COLUMNS.every((c, i) => header[i] === c)) {
    throw new Error(
      `CSV header mismatch. Expected: ${CSV_COLUMNS.join(",")}\nGot: ${header.join(",")}`,
    );
  }

  const rows: CanonicalRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.length === 1 && rec[0] === "") continue; // skip blank trailing line
    if (rec.length !== CSV_COLUMNS.length) {
      throw new Error(`CSV row ${r + 1} has ${rec.length} fields, expected ${CSV_COLUMNS.length}`);
    }
    rows.push({
      category: rec[0],
      name: rec[1],
      size: rec[2],
      price: rec[3],
      description: rec[4],
      prompt_for: rec[5],
      upsell: rec[6],
    });
  }
  return rows;
}

/** Tokenize a CSV string into an array of records (each an array of fields). */
export function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = csv.length;

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRecord();
      i++;
      continue;
    }
    if (ch === "\r") {
      // handle CRLF and bare CR
      if (csv[i + 1] === "\n") i++;
      pushRecord();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush trailing field/record if any content remains.
  if (field.length > 0 || record.length > 0) {
    pushRecord();
  }
  return records;
}
