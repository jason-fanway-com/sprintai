/**
 * truncation.ts — computeTruncation, extracted to its own module.
 *
 * Pure function, no I/O, no env reads, so it can be unit-tested with a bare
 * `deno test` and no permission flags, same reasoning as safety-gate.ts.
 */

export interface TruncationInput {
  /** Did the simulator's own success check say the goal was reached? */
  goalReached: boolean;
  /** Did the loop exit via an early break (simulator decision.done, or an
   *  empty next message) rather than by exhausting max_turns? */
  brokeEarly: boolean;
  /** Did the bot-reported conversation phase change at least once across
   *  the run? Evidence of real progress, as opposed to a flat stall that
   *  happens to burn every available turn. */
  phaseAdvanced: boolean;
  transcriptLength: number;
  goal: string;
  maxTurns: number;
}

export interface TruncationResult {
  truncated: boolean;
  truncationNote?: string;
}

/**
 * A run is a harness turn-cap cutoff — not a customer give-up or a bot
 * failure — only when the loop ran through every turn without the simulator
 * ever deciding it was done or giving up early, AND there's evidence the
 * conversation was actually progressing (the tracked phase changed at some
 * point). A conversation that hits max_turns while its phase never moves at
 * all is a genuine stall (e.g. looped_no_progress), not a harness artifact,
 * and must be left to grade normally rather than excused as truncated.
 */
export function computeTruncation(input: TruncationInput): TruncationResult {
  const truncated = !input.goalReached && !input.brokeEarly &&
    input.phaseAdvanced && input.transcriptLength > 0;
  return {
    truncated,
    truncationNote: truncated
      ? `customer goal "${input.goal}" was NOT reached within ${input.maxTurns} turns (harness turn cap)`
      : undefined,
  };
}
