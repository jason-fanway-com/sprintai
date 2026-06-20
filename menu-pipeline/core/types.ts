/**
 * Menu Intake Pipeline — Canonical Types
 *
 * Implements the data model behind MENU-INTAKE-STANDARD.md.
 *
 * Runtime-agnostic: NO Deno or Node APIs in this file. Pure TypeScript so it
 * can be imported by the Deno edge function AND tested under Node.
 *
 * The pipeline has two stages:
 *   Stage A: any menu source -> MenuModel -> canonical flat 7-column CSV + Open Questions
 *   Stage B: confirmed CSV -> DB rows (menu_items / option_groups / option_choices)
 *
 * The MenuModel is the intermediate, source-agnostic representation. Front-ends
 * (PDF/image via Claude vision, HTML/text via extractor) all produce a MenuModel.
 * The serializer turns a MenuModel into a byte-deterministic CSV.
 */

// ---- Canonical CSV ----------------------------------------------------------

/** The seven canonical columns, in exact order, exact lowercase names. */
export const CSV_COLUMNS = [
  "category",
  "name",
  "size",
  "price",
  "description",
  "prompt_for",
  "upsell",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** One row of the canonical flat file (item row OR modifier-block option row). */
export interface CanonicalRow {
  category: string;
  name: string;
  size: string;
  /** Plain 2-decimal string ("12.95"), or "" when genuinely unknown (and flagged). */
  price: string;
  description: string;
  prompt_for: string;
  upsell: string;
}

// ---- MenuModel (source-agnostic intermediate) -------------------------------

/** A single sellable variant (one row per size). */
export interface MenuItemVariant {
  /** Menu section name, captured verbatim from the menu (e.g. "Pizza"). */
  category: string;
  name: string;
  /** Size/variant label, or "" if the item has no size. */
  size: string;
  /**
   * Absolute price in dollars as a number, or null if genuinely unknown.
   * null prices MUST be paired with an Open Question flag.
   */
  price: number | null;
  description: string;
  /**
   * Required free choices the AI must collect. Each entry is a short phrase
   * with options inline, e.g. "which pasta (spaghetti, penne, angel hair, or linguine)".
   */
  promptFor: string[];
  /**
   * Optional add-ons (with +$ hints) the item supports.
   * The category cross-sell nudge is appended automatically by the serializer
   * from the defaults table, so do NOT include it here.
   */
  upsell: string[];
}

/** One option inside a modifier block. */
export interface ModifierOption {
  name: string;
  /** Price delta in dollars, or null if "upcharge TBD" (blank + flagged). */
  priceDelta: number | null;
}

/** A labeled modifier block (answer set): toppings, sauces, dressings, add-ons... */
export interface ModifierBlock {
  /** Block label — must be one of the fixed block-order labels (see ordering.ts). */
  label: string;
  options: ModifierOption[];
}

/** One open question / flag raised during extraction. */
export interface OpenQuestion {
  /** The item/area the question is about. */
  area: string;
  /** What the issue is. */
  issue: string;
  /** The specific question to resolve it. */
  question: string;
}

/** The complete source-agnostic menu representation. */
export interface MenuModel {
  /** Restaurant / menu name (for the file header / DB menu name). */
  menuName: string;
  /**
   * Menu's own section order — categories listed in the order they appear.
   * Used for deterministic item-region ordering.
   */
  categoryOrder: string[];
  items: MenuItemVariant[];
  modifierBlocks: ModifierBlock[];
  openQuestions: OpenQuestion[];
}

// ---- Stage A output ---------------------------------------------------------

export interface StageAOutput {
  /** Byte-deterministic canonical CSV (UTF-8). */
  csv: string;
  /** The Open Questions companion text (always produced, "none" if empty). */
  openQuestions: string;
  /** The validated, canonicalized rows (for downstream/XLSX use). */
  rows: CanonicalRow[];
  /** Validation result. */
  validation: ValidationResult;
}

// ---- Validation -------------------------------------------------------------

export interface ValidationError {
  code: string;
  message: string;
  /** Optional row index or block label for context. */
  context?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}
