# Public menu page — `/m/<shop-slug>`

Status: SPEC, awaiting Jason's sign-off on URL shape and tone. Not built.
Origin: Test Kitchen transcript 2026-09-06 13:34. Jason asked for the menu
twice, got a 90-word category dump and then "Sorry, I don't have a link to
share." Note verbatim: *"We should be able to send a link to their menu."*

## Why this earns its place

1. It is the single best thing Erin can text a prospect — their own menu, live,
   on their phone, one tap. No login, no app, no explanation needed.
2. It is a human-readable view of exactly what the bot knows. Had it existed on
   the morning of 2026-09-06, "no toppings on 62 pizzas" would have been visible
   in five seconds instead of costing a day. It becomes the fastest menu-import
   check we have — better than any SQL view, because a person can just look.
3. It is the landing spot for the demo-kit QR codes.

## URL

`getsprintai.com/m/<shop-slug>` — e.g. `getsprintai.com/m/vitos-pizza`.

- `/m/` not `/menu/`: this gets typed into a text message and read aloud. Short
  matters. It also cannot collide with the marketing site's `/menu` if we ever
  want one.
- Slug, not UUID. `getsprintai.com/m/vitos-pizza` is legible in an SMS; a UUID
  reads as spam.
- Stable and guessable, because it is public and read-only by design.
- One page per shop. It follows the shop, not the menu version.

## Data — live, single source, never a copy

Rendered at request time from the SAME rows `chat-sms` reads: `menus` (current,
`effective_until` null or future) → `menu_items` (`active = true`) →
`option_groups` → `option_choices`. No build step, no generated file, no cache
of the menu body. It cannot disagree with what the bot will sell, because
disagreement would require a second copy and there isn't one.

Implementation: one Supabase edge function `public-menu`, service-role read,
returns rendered HTML. Netlify proxy rewrite `/m/*` → the function, matching the
existing `/o/*` → `pay-redirect` pattern already in `netlify.toml`.

## What it shows

Per category, in the shop's own `display_order`:

- Item name, price, description.
- **Options, visible, not hidden behind a tap.** For each option group: the
  group name, whether it is required, how many may be chosen, and every choice
  with its upcharge. `Toppings — optional: Pepperoni +$4.50, Sausage +$4.50 …`
  A group with more than ~8 choices collapses to a "+N more" line that expands
  with no JS round-trip (`<details>`), so a phone with a cold cache still gets
  the whole page in one request.
- **An item with no options must LOOK like it has none.** No silent omission —
  that is precisely how 62 topping-less pizzas hid for a day. If a category has
  zero items with options, the page says so at the category level.
- 86'd / inactive items are not shown; the page is what a customer can order now.

Header: shop name, address, phone, hours, and "Text us to order: <number>" when
the shop has one. Footer: "Menu shown live from <Shop>'s Sprint account · Prices
set by the restaurant."

## Tone

Plain and warm, the shop's voice not ours. It is the restaurant's menu, not a
SprintAI product page — Sprint appears once, in small type, in the footer. No
marketing copy, no "powered by" banner, no upsell. A family restaurant owner
should be able to send this to a customer and feel it represents them.

## Non-goals

No auth. No ordering, no cart, no buttons that do anything. No JS framework —
server-rendered HTML and inline CSS, because it must open fast on a phone with a
cold cache on a bad connection. No images in v1.

## Teaching the bot to send it

Today, "send me the full menu" produces a 90-word wall of category names. In SMS
that is worse than useless — it does not fit, it cannot be skimmed, and it still
does not answer the question.

New rule in `chat-sms`: when the customer asks for the menu, asks for a link, or
asks anything that would require listing more than **six** items, the reply is
ONE short line plus the link.

> Here's the whole menu — getsprintai.com/m/vitos-pizza. Tell me what you want
> and I'll add it.

Deterministic, not left to the model: a guard detects a reply that enumerates
more than six menu item names and replaces the enumeration with the link line.
That guard must APPEND-OR-REPLACE cleanly rather than by string surgery — see
the reply-rewrite debris family (`ed789c2`).

Answering a narrow question ("what wing flavors do you have?") still answers
directly. The link replaces the DUMP, not the conversation.

## Acceptance

1. `/m/vitos-pizza` returns 200 with no auth, from a logged-out phone browser.
2. Every active item on the shop's current menu appears, with its price.
3. A pizza shows its 32 topping choices with correct upcharges; a salad shows
   its required Dressing group; an item with no options is visibly optionless.
4. Change an option in the owner editor → reload → the page reflects it, with no
   deploy and no build.
5. Page weight under 150KB and first paint under 2s on a throttled 4G profile.
6. Asking the bot "send me the full menu" returns one line plus the link.
7. A retired or paused shop returns 404, not a stale menu.
