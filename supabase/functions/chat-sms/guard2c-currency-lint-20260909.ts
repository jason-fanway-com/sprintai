// GUARD 2c widening — currency lint backstop (2026-09-09, P0).
//
// Live incident: Zio's Pizzeria (shop 2cba7b51-211c-4437-8910-1af4dcc03498)
// quoted a customer $89.95 for a cart that actually held $95.95 (subtotal
// $94.96 + $0.99 fee) — pepperoni had been applied as a modifier to BOTH the
// Meat Lover's and the Hawaiian, $6.00 of toppings never ordered. GUARD 2c
// exists specifically to catch a quoted-total-vs-real-total mismatch and did
// NOT fire, because its old trigger (`claimsATotal`) only matched replies
// that used total-claiming language ("total", "comes to", "that'll be", ...).
// A reply like "So that's four pizzas for $89.95, sound good?" never says
// "total" and sailed through untouched.
//
// This widens the backstop: ANY dollar figure in the model's reply that
// matches neither a real cart/menu price nor the real total is flagged,
// regardless of the words around it. Extracted into its own importable
// module (same reason GUARD 9/13 were, see their headers) so a hand-copied
// mirror in a test can't drift from the real wiring in index.ts — the test
// imports these exact functions, not a re-implementation of them.

export interface Guard2cCartLine {
  type?:        "bundle";
  price_cents:  number;
  quantity?:    number;
  complete?:    boolean; // bundle lines only
}

export interface Guard2cOptionChoice {
  price_cents: number;
}

export interface Guard2cOptionGroup {
  choices: Guard2cOptionChoice[];
}

export interface Guard2cModifier {
  price_cents: number;
}

export interface Guard2cMenuItem {
  price_cents:     number;
  option_groups?:  Guard2cOptionGroup[];
  modifiers_json?: Guard2cModifier[] | null;
}

/**
 * The full set of dollar figures the model may legitimately say this turn
 * WITHOUT having used total-claiming language: every cart line's unit price
 * and line total, every menu item's list price and option/modifier upcharge,
 * the real subtotal, fee(s), and the real total. A quoted figure outside
 * this set is either a wrong number or an invented one.
 */
export function buildGroundedMoneyCents(
  cart:              Guard2cCartLine[],
  menu:              Guard2cMenuItem[],
  feeCents:          number,
  deliveryFeeCents:  number | undefined,
  driverTipCents:    number | undefined,
  totalCents:        number,
): Set<number> {
  const set = new Set<number>();
  let subtotal = 0;
  for (const i of cart) {
    if (i.type === "bundle") {
      if (!i.complete) continue;
      set.add(i.price_cents);
      subtotal += i.price_cents;
      continue;
    }
    set.add(i.price_cents);
    const lineTotal = i.price_cents * (i.quantity || 1);
    set.add(lineTotal);
    subtotal += lineTotal;
  }
  set.add(subtotal);
  set.add(feeCents);
  if (deliveryFeeCents) set.add(deliveryFeeCents);
  if (driverTipCents) set.add(driverTipCents);
  set.add(totalCents);
  for (const mi of menu) {
    set.add(mi.price_cents);
    for (const g of mi.option_groups ?? []) {
      for (const c of g.choices) set.add(c.price_cents);
    }
    for (const m of mi.modifiers_json ?? []) set.add(m.price_cents);
  }
  return set;
}

/** Returns the first quoted-cents value that matches no grounded figure (±1c), or null if all match. */
export function findStrayDollarCents(quotedCents: number[], grounded: Set<number>): number | null {
  outer: for (const c of quotedCents) {
    for (const real of grounded) {
      if (Math.abs(c - real) <= 1) continue outer;
    }
    return c;
  }
  return null;
}
