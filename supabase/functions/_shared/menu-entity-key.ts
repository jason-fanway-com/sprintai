/**
 * SprintAI — menu_overrides entity-key scheme
 * ============================================
 *
 * Stable identifiers for `menu_overrides.entity_key`, per
 * docs/specs/2026-09-07-conversation-ready-menu-design.md §9 "Entity keys".
 * Keys must survive a re-crawl: they are built from the importer's stable
 * `import_key` (or the row's own id when the row has no `import_key`, i.e.
 * an owner-created row the importer never touches), never from a row's
 * database id alone, and never from anything a crawl could reorder.
 *
 * This is the ONE place that formula lives. The Postgres trigger that
 * captures owner edits (migrations/114_menu_overrides_trigger.sql) computes
 * the same keys in SQL, because a trigger can't call into Deno — but every
 * other caller (the compiler, item 4) must import this module rather than
 * re-deriving the formula.
 *
 * §9 defines four entity types:
 *   item:       existing `import_key`
 *   group:      `<item import_key>#<slot_key>`
 *   choice:     `<group key>#<normalised choice name>`
 *   set / set_choice: `<menu>#<normalised set name>[#<normalised choice name>]`
 * plus the universal fallback for any owner-created row with no
 * `import_key`: `owner:<uuid>`.
 *
 * `slot_key` (option_groups) is a P0 column added by the schema migration
 * (§2.3) and populated by the normalizer/compiler from the archetype
 * library. Until a group has gone through that pipeline — or for a group
 * the owner created by hand, which never will — `slot_key` is null. This
 * module falls back to the normalised group name in that case, exactly the
 * fallback already used by the existing `option_groups.import_key`
 * convention ("menu_item import_key | group name", migration 010). The
 * fallback keeps the key deterministic and stable across crawls; it is not
 * itself part of the literal §9 formula, which assumes `slot_key` is
 * already populated by the time an owner can edit the row.
 */

export type EntityType = "item" | "group" | "choice" | "set" | "set_choice";

/**
 * Normalise a human-entered name into the stable token §9 calls a
 * "normalised choice/set name": lowercase, trim, collapse internal
 * whitespace, drop punctuation that a menu source or an owner's typing
 * would vary (commas, periods, quotes, parens) without changing meaning.
 * Deliberately does NOT strip spaces down to underscores — the token only
 * has to be stable and unique within its parent scope, not identifier-safe.
 *
 * Deliberately does NOT accent-fold either: the SQL mirror of this function
 * (migrations/114_menu_overrides_trigger.sql's menu_override_normalise_term)
 * can't cheaply match Unicode NFKD without adding a Postgres extension
 * dependency, and the trigger and this module MUST produce byte-identical
 * keys for the same input or an owner's override silently orphans at
 * compile time. Matching the SQL side's simpler behavior (not the other way
 * around) keeps both implementations free of that dependency.
 */
export function normaliseEntityTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** item: existing import_key, else owner:<uuid> for an owner-created item. */
export function itemEntityKey(item: { id: string; importKey: string | null }): string {
  return item.importKey ?? `owner:${item.id}`;
}

/**
 * group: `<item import_key>#<slot_key>`.
 * Falls back to the normalised group name when slot_key isn't populated yet
 * (see module doc) so the key is still deterministic and stable.
 */
export function groupEntityKey(
  itemKey: string,
  group: { slotKey: string | null; name: string },
): string {
  const slot = group.slotKey ?? normaliseEntityTerm(group.name);
  return `${itemKey}#${slot}`;
}

/** choice: `<group key>#<normalised choice name>`. */
export function choiceEntityKey(groupKey: string, choice: { name: string }): string {
  return `${groupKey}#${normaliseEntityTerm(choice.name)}`;
}

/** set: `<menu>#<normalised set name>`. `menuKey` is the menu's own id/import_key. */
export function setEntityKey(menuKey: string, set: { name: string }): string {
  return `${menuKey}#${normaliseEntityTerm(set.name)}`;
}

/** set_choice: `<set key>#<normalised choice name>`. */
export function setChoiceEntityKey(setKey: string, choice: { name: string }): string {
  return `${setKey}#${normaliseEntityTerm(choice.name)}`;
}

/**
 * Owner-created rows carry no `import_key`; the importer must never touch
 * them (§9). Use the row's own id so re-imports leave it alone by
 * construction — there is nothing in the snapshot that could collide with
 * `owner:<uuid>`.
 */
export function ownerEntityKey(id: string): string {
  return `owner:${id}`;
}
