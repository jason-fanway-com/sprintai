// Reply inversion, stage 2 (2026-09-13, docs/specs/2026-09-13-reply-inversion.md).
//
// Stage 1 (action-confirmation.ts) closed the single highest-value site
// (`reply = loopResult.reply`) for the MODEL's own prose. This module closes
// a different, lower-risk but still real shape the classification table
// (docs/specs/2026-09-13-reply-inversion-classification.md) flagged: several
// call sites throughout index.ts build a candidate/cart-line NAME LIST by
// hand (`.map(...).join(...)`) directly inside a template string, instead of
// through any shared renderer. None of these are model-authored — every
// value is drawn straight from cart_json/effectiveMenu — but a hand-built
// join is exactly the kind of code that can silently drift (a stale
// variable, a wrong field, a copy-pasted join that drops a price) without
// anything catching it. Same discipline as itemizer.ts and
// action-confirmation.ts: pure, no I/O, one function per shape, so there is
// exactly one place each shape can go wrong instead of N hand-built copies.
//
// Every function here is a byte-for-byte extraction of an existing inline
// template — see the reply-inversion stage 2 commit for the call sites. This
// module does not change a single customer-facing string; it gives the
// existing strings one writer each.

export interface NamedPriced {
  name: string;
  price_cents?: number;
}

/**
 * "1) the X — $9.99  2) the Y — $4.50" — a numbered pick-one list, used when
 * a customer must choose among 2+ cart-line or menu candidates. `price_cents`
 * is optional per item; omit it entirely (as every caller that doesn't have
 * a meaningful per-candidate price already does) for a plain numbered name
 * list with no dollar figure.
 */
export function renderNumberedPickList(items: NamedPriced[], labelPrefix = ""): string {
  return items
    .map((it, i) => {
      const price = it.price_cents != null ? ` — $${(it.price_cents / 100).toFixed(2)}` : "";
      return `${i + 1}) ${labelPrefix}${it.name}${price}`;
    })
    .join("  ");
}

/** `"X", "Y", "Z"` — a quoted, comma-joined name list (e.g. "here's what's actually in your cart"). */
export function renderQuotedNameList(names: string[]): string {
  return names.map(n => `"${n}"`).join(", ");
}

/** `X, Y, Z` — a plain comma-joined name list (e.g. choices just applied, or a correction clause's subject list). */
export function renderNameList(names: string[]): string {
  return names.join(", ");
}
