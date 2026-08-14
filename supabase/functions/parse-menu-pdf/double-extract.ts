/**
 * double-extract.ts — §B Double-Extract-and-Diff (Menu Intake Standard)
 *
 * Runs row-by-row diff on two independent extractions with fuzzy name matching.
 * Disagreements → Open Questions, never silently shipped.
 */

interface CanonicalRow {
  category: string;
  name: string;
  size: string;
  price: string;
  description: string;
  prompt_for: string;
  upsell: string;
}

interface Disagreement {
  type:    "price_mismatch" | "size_mismatch" | "missing_in_one" | "missing_in_two";
  item_ref: string;
  price1?: string;
  price2?: string;
  size1?:  string;
  size2?:  string;
}

interface DiffReport {
  matched:        number;
  disagreements:  Disagreement[];
  onlyIn1:        string[];
  onlyIn2:        string[];
}

export function doubleExtractDiff(
  extract1: CanonicalRow[],
  extract2: CanonicalRow[],
): DiffReport {
  const disagreements: Disagreement[] = [];
  const onlyIn1: string[] = [];
  const onlyIn2: string[] = [];
  let matched = 0;

  // Match rows by fuzzy name
  const matched2 = new Set<number>();

  for (const r1 of extract1) {
    let bestIdx = -1;
    let bestScore = 0;

    for (let j = 0; j < extract2.length; j++) {
      if (matched2.has(j)) continue;
      const score = nameSimilarity(r1.name, extract2[j].name);
      if (score > bestScore && score > 0.6) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      matched2.add(bestIdx);
      const r2 = extract2[bestIdx];
      matched++;

      // Compare prices
      const p1 = parseFloat(r1.price);
      const p2 = parseFloat(r2.price);
      if (!isNaN(p1) && !isNaN(p2) && Math.abs(p1 - p2) > 0.005) {
        disagreements.push({
          type:     "price_mismatch",
          item_ref: `${r1.category}|${r1.name}|${r1.size}`,
          price1:   r1.price,
          price2:   r2.price,
        });
      } else if ((isNaN(p1) && !isNaN(p2)) || (!isNaN(p1) && isNaN(p2))) {
        // One has a price, the other doesn't
        disagreements.push({
          type:     "price_mismatch",
          item_ref: `${r1.category}|${r1.name}|${r1.size}`,
          price1:   r1.price || "(missing)",
          price2:   r2.price || "(missing)",
        });
      }

      // Compare sizes
      if (normalizeSize(r1.size) !== normalizeSize(r2.size)) {
        disagreements.push({
          type:     "size_mismatch",
          item_ref: `${r1.category}|${r1.name}|${r1.size}`,
          size1:    r1.size,
          size2:    r2.size,
        });
      }
    } else {
      onlyIn1.push(`${r1.category}|${r1.name}|${r1.size}`);
    }
  }

  // Find items only in extraction 2
  for (let j = 0; j < extract2.length; j++) {
    if (!matched2.has(j)) {
      onlyIn2.push(`${extract2[j].category}|${extract2[j].name}|${extract2[j].size}`);
    }
  }

  // Items in only one extraction are disagreements
  for (const ref of onlyIn1) {
    disagreements.push({
      type:     "missing_in_two",
      item_ref: ref,
    });
  }
  for (const ref of onlyIn2) {
    disagreements.push({
      type:     "missing_in_one",
      item_ref: ref,
    });
  }

  return { matched, disagreements, onlyIn1, onlyIn2 };
}

// ---- Similarity helpers ----------------------------------------------------

function nameSimilarity(a: string, b: string): number {
  const an = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const bn = b.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (an === bn) return 1.0;

  // Contains check
  if (an.length > 3 && bn.length > 3) {
    if (an.includes(bn)) return 0.85;
    if (bn.includes(an)) return 0.85;
  }

  // Prefix match (first 5 chars)
  if (an.length >= 5 && bn.length >= 5 && an.slice(0, 5) === bn.slice(0, 5)) {
    return 0.75;
  }

  // Word overlap
  const aw = new Set(an.split(/\s+/));
  const bw = new Set(bn.split(/\s+/));
  let overlap = 0;
  for (const w of aw) { if (bw.has(w)) overlap++; }
  const total = Math.max(aw.size, bw.size);
  if (total > 0) return overlap / total;

  return 0;
}

function normalizeSize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}