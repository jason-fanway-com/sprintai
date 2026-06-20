/**
 * Stage A front-end interface + orchestration.
 *
 * The pipeline is: SOURCE --(front-end)--> MenuModel --(serialize, deterministic)--> CSV.
 *
 * Front-ends are non-deterministic (LLM/OCR); the serializer is deterministic.
 * So the determinism guarantee is: same MenuModel -> byte-identical CSV. To make
 * the WHOLE pipeline deterministic for a given source we (a) pin the model and
 * temperature=0 for the LLM front-ends, and (b) for tests, feed a captured
 * MenuModel fixture directly into the serializer (which is the layer the
 * standard's determinism rule actually governs).
 *
 * This file defines:
 *   - MenuSource: the tagged union of supported inputs.
 *   - MenuFrontEnd: the one interface every front-end implements.
 *   - runStageA(): orchestrates front-end -> serialize -> validate into StageAOutput.
 *
 * Pure/runtime-agnostic except the Claude front-end, which is injected (so this
 * module has no hard Deno/Node dependency).
 */

import type {
  MenuModel,
  StageAOutput,
} from "./types.ts";
import { buildCanonicalRows, buildOpenQuestions, rowsToCsv } from "./serialize.ts";
import { validateRows } from "./validate.ts";

// ---- Source + front-end contracts ------------------------------------------

export type MenuSource =
  | { kind: "pdf"; base64: string; menuName: string }
  | { kind: "image"; base64: string; mediaType: string; menuName: string }
  | { kind: "html"; html: string; menuName: string }
  | { kind: "text"; text: string; menuName: string }
  | { kind: "model"; model: MenuModel }; // pre-built model (fixtures/tests)

/** Every front-end turns a source into a source-agnostic MenuModel. */
export interface MenuFrontEnd {
  /** Returns true if this front-end handles the given source kind. */
  handles(source: MenuSource): boolean;
  /** Extract a MenuModel. May call out to an LLM/OCR (non-deterministic). */
  extract(source: MenuSource): Promise<MenuModel>;
}

// ---- The "model" front-end (deterministic passthrough) ---------------------

/** Passthrough front-end: used by fixtures and the determinism harness. */
export const modelFrontEnd: MenuFrontEnd = {
  handles: (s) => s.kind === "model",
  extract: (s) => {
    if (s.kind !== "model") throw new Error("modelFrontEnd received non-model source");
    return Promise.resolve(s.model);
  },
};

// ---- Orchestration ---------------------------------------------------------

export interface StageAConfig {
  frontEnds: MenuFrontEnd[];
  /** Hard-fail on unresolved references at Stage A. Default false (warn only;
   *  the importer is the hard gate). */
  strictReferences?: boolean;
}

/**
 * Run Stage A: source -> MenuModel -> deterministic CSV + Open Questions + validation.
 * The CSV/Open-Questions are ALWAYS produced; validation result rides alongside.
 */
export async function runStageA(
  source: MenuSource,
  config: StageAConfig,
): Promise<StageAOutput> {
  const fe = config.frontEnds.find((f) => f.handles(source));
  if (!fe) throw new Error(`No front-end registered for source kind "${source.kind}"`);

  const model = await fe.extract(source);
  return stageAFromModel(model, { strictReferences: config.strictReferences });
}

/** Deterministic tail of Stage A: MenuModel -> StageAOutput. Pure. */
export function stageAFromModel(
  model: MenuModel,
  opts: { strictReferences?: boolean } = {},
): StageAOutput {
  const rows = buildCanonicalRows(model);
  const csv = rowsToCsv(rows);
  const openQuestions = buildOpenQuestions(model);
  const validation = validateRows(rows, { strictReferences: opts.strictReferences });
  return { csv, openQuestions, rows, validation };
}
