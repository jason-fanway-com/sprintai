/**
 * cli-args.ts — flag parsing for run.ts, pulled out into its own module so it
 * can be unit-tested with plain argv arrays (no Deno.env, no Supabase, no
 * LLM calls).
 *
 * Root cause this fixes: args.indexOf("--flag") is an exact-token match. A
 * caller passing --flag=value (one token) never matches "--flag" (two
 * tokens), so the indexOf lookup silently returns -1 and the flag is treated
 * as absent — indistinguishable from the flag never having been passed at
 * all. getFlagValue below accepts both forms. validateFlags additionally
 * turns any flag it doesn't recognize (typo or otherwise) into a hard error,
 * so a malformed flag can never again look identical to "nothing requested".
 */

export const VALUE_FLAGS = ["limit", "cases", "trigger", "change-set", "initiated-by"] as const;
export const BOOLEAN_FLAGS = ["dry-run", "help"] as const;

export class UnrecognizedFlagError extends Error {
  constructor(public readonly flag: string) {
    super(`Unrecognized flag: "${flag}"`);
    this.name = "UnrecognizedFlagError";
  }
}

/** Returns the value of --name=value or --name value (either token form), or null if absent. */
export function getFlagValue(args: string[], name: string): string | null {
  const eqPrefix = `--${name}=`;
  const bare = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(eqPrefix)) return a.slice(eqPrefix.length);
    if (a === bare) return i + 1 < args.length ? args[i + 1] : null;
  }
  return null;
}

/** Returns true if the boolean flag --name is present. */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * Throws UnrecognizedFlagError for any --token that isn't in valueFlags or
 * booleanFlags. Skips the following token as a value for space-form value
 * flags so it isn't misread as a stray positional/flag.
 */
export function validateFlags(
  args: string[],
  valueFlags: readonly string[] = VALUE_FLAGS,
  booleanFlags: readonly string[] = BOOLEAN_FLAGS,
): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const eqIdx = a.indexOf("=");
    const name = eqIdx >= 0 ? a.slice(2, eqIdx) : a.slice(2);
    if (booleanFlags.includes(name)) continue;
    if (valueFlags.includes(name)) {
      if (eqIdx < 0) i++; // space-form: next token is this flag's value, not a flag itself
      continue;
    }
    throw new UnrecognizedFlagError(a);
  }
}
