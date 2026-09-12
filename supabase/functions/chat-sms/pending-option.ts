// DEFECT 1 fix (2026-09-06, P0 money defect): answering a pending REQUIRED
// option question (e.g. "how do you want that cooked?") sometimes created a
// SECOND cart line instead of setting the choice on the existing one,
// double-charging the customer. Root cause: the answer went through the
// normal LLM/tool loop, and the model sometimes called add_item again
// instead of modify_item. add_item's own dedup key is options-equality
// (index.ts, add_item case) — filling in a previously-empty required option
// changes a line's options from empty to filled, which by construction can
// never equal what they were before, so the "same item" match always misses
// and a new line is pushed. This is why the bug is INTERMITTENT: it depends
// on which tool the model happens to reach for on the answer turn, not on
// any input-dependent condition.
//
// This mirrors pending-disambiguation.ts's shape exactly: pure, unit-tested
// functions with no I/O. index.ts uses them to resolve the customer's next
// message against the specific cart line and option group that is still
// open BEFORE the LLM/tool loop ever runs, via modify_item directly — so
// add_item is never reachable on that turn for that item at all. No extra DB
// column is needed: cart_json's own per-line `pending_options` already IS
// the persisted "what's still open" state (recovered fresh every turn from
// cart_json + the live menu, exactly like GUARD 8 already does to build its
// missing-choices text).

export interface PendingOptionChoice {
  name: string;
  price_cents: number;
}

export interface PendingOptionQuestion {
  menu_item_id: string;
  item_name: string;
  group_name: string;
  choices: PendingOptionChoice[];
}

function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "one", "a", "an", "of", "by",
  "please", "id", "like", "want", "ill", "take", "make", "get", "can", "have",
]);

function significantStems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w))
      .map(stem),
  );
}

/**
 * Resolve a customer's answer against one option group's real choices. A
 * choice matches only when EVERY one of its own significant word-stems
 * appears in the message — "well done" matches "Well Done" (both "well" and
 * "done" present) but not the bare "Well" or "Medium Well" choices (their
 * stem sets aren't fully covered). Returns the single matching choice, or
 * null if zero or more than one choice matches — callers must fall through
 * to the normal loop or re-ask, never guess between two real choices.
 */
export function resolvePendingOptionAnswer(
  message: string,
  choices: PendingOptionChoice[],
): PendingOptionChoice | null {
  const msgStems = significantStems(message);
  if (msgStems.size === 0) return null;

  const withStems = choices
    .map(c => ({ choice: c, stems: significantStems(c.name) }))
    .filter(({ stems }) => {
      if (stems.size === 0) return false;
      for (const s of stems) if (!msgStems.has(s)) return false;
      return true;
    });

  if (withStems.length === 0) return null;
  if (withStems.length === 1) return withStems[0].choice;

  // More than one choice's stems are fully covered by the message — e.g.
  // "medium rare" covers both "Medium" and "Medium Rare". Keep only the most
  // SPECIFIC matches: drop any hit whose stem set is a strict subset of
  // another hit's, so the more precise choice wins instead of the shorter
  // one it happens to contain.
  const maximal = withStems.filter(({ stems }) =>
    !withStems.some(other =>
      other.stems.size > stems.size && [...stems].every(s => other.stems.has(s))
    )
  );
  if (maximal.length === 1) return maximal[0].choice;

  // Still ambiguous — fall back to an exact (case-folded) name match, which
  // is unambiguous by definition, never guess between two real choices.
  const exact = maximal.filter(({ choice }) => choice.name.trim().toLowerCase() === message.trim().toLowerCase());
  if (exact.length === 1) return exact[0].choice;
  return null;
}

// ── C1 rename-tolerant option-group identity (2026-09-12) ──────────────────
// docs/DEFECT-CLASSES.md, C1: "two pieces of OUR OWN data are compared by a
// human-readable string when a stable id exists. A rename ... silently
// breaks the link. It fails quietly — no error, no exception, just wrong
// behaviour." This file's own header above used to claim "cart_json's own
// per-line `pending_options` already IS the persisted 'what's still open'
// state (recovered fresh every turn from cart_json + the live menu)" — true
// only as long as the group's name never changes between the turn it was
// recorded and the turn it's read back. If a shop owner renames an option
// group in between (real operation, not hypothetical), the plain
// `g.name === groupName` match below returns nothing and the required
// question — or a priced selection sharing the same storage shape in
// index.ts's `options` record — silently vanishes. No error, no crash, just
// a customer who never gets asked, or a price that quietly goes to zero.
//
// Fix: index.ts now snapshots a name->id map (`option_group_ids`) onto each
// cart line every time it touches that item's live option_groups. When an
// exact name match fails, resolveOptionGroupByStoredKey falls back to the
// id captured in that snapshot — which survives a rename because ids never
// change — and recovers the group under its CURRENT name. Callers that
// rebuild a keyed record (index.ts's `cleaned`/`mergedOptions` construction)
// re-key onto the group's current name as they go, so the stored data
// self-heals onto the new name the very next time it's touched; nothing
// downstream that still compares by name needs to change.
//
// Pre-fix carts (no `option_group_ids` snapshot recorded yet) get no
// recovery — same behavior as before this fix, not worse — until they're
// next touched and a snapshot is taken.
export interface OptionGroupIdentity {
  id:   string;
  name: string;
}

export function resolveOptionGroupByStoredKey<G extends OptionGroupIdentity>(
  liveGroups: ReadonlyArray<G> | null | undefined,
  storedKey: string,
  groupIdSnapshot: Record<string, string> | null | undefined,
): G | undefined {
  const byName = liveGroups?.find(g => g.name === storedKey);
  if (byName) return byName;
  const snapshotId = groupIdSnapshot?.[storedKey];
  if (!snapshotId) return undefined;
  return liveGroups?.find(g => g.id === snapshotId);
}

/** Merges the CURRENT name->id map for `liveGroups` into `existing`, never removing an older (possibly since-renamed) entry — that history is exactly what lets a later rename still resolve. */
export function snapshotGroupIds(
  existing: Record<string, string> | null | undefined,
  liveGroups: ReadonlyArray<OptionGroupIdentity> | null | undefined,
): Record<string, string> | undefined {
  if (!liveGroups || liveGroups.length === 0) return existing ?? undefined;
  const fresh = Object.fromEntries(liveGroups.map(g => [g.name, g.id]));
  return { ...(existing ?? {}), ...fresh };
}

/**
 * Re-keys a stored `options` record onto the LIVE group names, recovering
 * any entry whose stored key was a group name that has since been renamed
 * (via groupIdSnapshot) instead of silently dropping it. A key that matches
 * neither a live group nor the snapshot (group genuinely removed, or a
 * prompt_for free-text slot) is left under its original key, unchanged —
 * same as this function not having run at all.
 */
export function canonicalizeStoredOptions(
  stored: Record<string, string[]> | null | undefined,
  liveGroups: ReadonlyArray<OptionGroupIdentity> | null | undefined,
  groupIdSnapshot: Record<string, string> | null | undefined,
  promptForKey?: string | null,
): Record<string, string[]> | undefined {
  if (!stored) return stored ?? undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(stored)) {
    if (promptForKey && k === promptForKey) { out[k] = v; continue; }
    const group = resolveOptionGroupByStoredKey(liveGroups, k, groupIdSnapshot);
    out[group ? group.name : k] = v;
  }
  return out;
}

/**
 * Find the first cart line still waiting on a required-option answer, and
 * the real choice list for its first unresolved group — this is presumed to
 * be the question the bot's last reply asked (GUARD 8 guarantees the reply
 * named these exact choices). Cart lines are walked in cart order so the
 * OLDEST open question resolves first if more than one item somehow has one
 * open at once.
 */
export function findPendingOptionQuestion(
  cartItems: ReadonlyArray<{ menu_item_id?: string; pending_options?: string[]; option_group_ids?: Record<string, string> }>,
  menuById: ReadonlyMap<string, { name: string; option_groups?: ReadonlyArray<{ id: string; name: string; choices: PendingOptionChoice[] }> }>,
): PendingOptionQuestion | null {
  for (const item of cartItems) {
    const pendingGroups = item.pending_options ?? [];
    if (!item.menu_item_id || pendingGroups.length === 0) continue;
    const menuItem = menuById.get(item.menu_item_id);
    if (!menuItem) continue;
    for (const groupName of pendingGroups) {
      const group = resolveOptionGroupByStoredKey(menuItem.option_groups, groupName, item.option_group_ids);
      if (group && group.choices.length > 0) {
        return { menu_item_id: item.menu_item_id, item_name: menuItem.name, group_name: group.name, choices: group.choices };
      }
    }
  }
  return null;
}

export interface ResolvedGroupSelection {
  group_name: string;
  choice: PendingOptionChoice;
}

/**
 * BUG 4 fix (2026-09-07, Jason: "a topping named in the same turn as an
 * unresolved required slot gets dropped rather than deferred"). Real repro:
 * "buffalo chicken pizza with pepperoni" adds the item with Size left
 * pending (a required group) — pepperoni (a real, non-required "Add
 * Toppings" choice) never lands in `options` because add_item/modify_item
 * each only resolve the one group a caller explicitly names. A customer who
 * names an additional real choice in the SAME message must not have it
 * silently vanish just because another group on the same item is still
 * open.
 *
 * Scans every group on the item other than `excludeGroupName` (a group a
 * caller is already resolving through a separate path, so it is not matched
 * twice here) and other than any group name in `alreadySelected`, and
 * returns any additional group/choice pairs the message unambiguously
 * names — reusing resolvePendingOptionAnswer's own stem-overlap +
 * maximal-specificity matching per group, never a second, weaker matcher.
 * Strips the item's own name first (same trap GUARD 8/GUARD 10 in index.ts
 * already guard against: "Buffalo Chicken Pizza" must not read as naming a
 * "Chicken" choice just because the word appears in the item name).
 */
export function resolveAdditionalGroupSelections(
  message: string,
  menuItem: { name: string; option_groups?: ReadonlyArray<{ name: string; choices: PendingOptionChoice[] }> },
  alreadySelected: ReadonlySet<string>,
  excludeGroupName?: string,
): ResolvedGroupSelection[] {
  const itemNameWords = menuItem.name.toLowerCase().split(/\s+/).filter(Boolean);
  let strippedMessage = message;
  for (const w of itemNameWords) {
    strippedMessage = strippedMessage.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  }

  const resolved: ResolvedGroupSelection[] = [];
  for (const group of menuItem.option_groups ?? []) {
    if (group.name === excludeGroupName) continue;
    if (alreadySelected.has(group.name)) continue;
    if (group.choices.length === 0) continue;
    const choice = resolvePendingOptionAnswer(strippedMessage, group.choices);
    if (choice) resolved.push({ group_name: group.name, choice });
  }
  return resolved;
}
