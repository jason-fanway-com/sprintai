# Menu Pipeline Fixtures

These are **synthetic test fixtures** for the Stage A determinism + validation
harness. They are NOT real restaurant menus and must not be presented as such.

Each `*.model.json` is a captured `MenuModel` (the source-agnostic intermediate
that any front-end produces). The harness feeds them through the deterministic
serializer to prove: **same MenuModel → byte-identical CSV**, and to exercise the
validator's golden-rule checks (referential integrity, price format, dedupe,
Open Questions).

The fixtures intentionally vary in shape to stress the ordering/serialization
rules:

| fixture | exercises |
|---|---|
| `pizza-shop.model.json` | multi-size pizzas, half/whole toppings, slices, wings + flavors, salads + dressings + protein add-ons, entrees w/ pasta choice. The richest fixture (mirrors the standard's worked-example shape). |
| `taco-truck.model.json` | unknown categories, custom modifier block (sorted into the OTHER slot), proteins, salsas. |
| `coffee-bar.model.json` | drinks (no cross-sell nudge), cup/bowl sizing, milk choices, a blank/`null` price that must be flagged. |
| `deli.model.json` | sandwiches w/ bread choice, side substitutions w/ "upcharge TBD" (blank + flag), kids items. |
| `bbq-joint.model.json` | plates w/ side choices, by-the-pound variants, sauce options, an intentionally suspicious uniform-price flag. |

## The reference fixture (Jack's Slice) is NOT included

Per `MENU-INTAKE-STANDARD.md`, the canonical reference export is **Jack's Slice**.
The source menu (PDF/photo) for Jack's Slice was **not present** in the repo or
the workspace at build time. Golden rule #2 (never invent a price or an option)
forbids fabricating it. The Jack's Slice CSV + Open Questions are therefore a
**pending deliverable** awaiting the real source menu — see `BUILD-REPORT-04.md`.
