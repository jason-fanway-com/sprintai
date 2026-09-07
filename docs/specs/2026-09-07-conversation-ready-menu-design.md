# OrderFare — The Conversation-Ready Menu

**Design doc. Prepared 2026-09-07 in response to "Architecture question: making an imported menu conversation-ready."**
**Status: proposed. Audience: OrderFare dev crew. Scope: importer, data model, owner onboarding, readiness gate, re-import.**

---

## 0. The answer on one page

The importer today produces a *menu*. The conversation needs an *order script*. Those are different artifacts, and the gap between them is where every bug in the evidence lives.

The design below adds one compiled artifact, one small owner loop, and one deterministic gate:

1. **The artifact is a compiled menu.** Same item → group → choice model you have, with four additions: (a) every group is a **slot** (must be answered to make the item) or a **modifier** (optional extras); (b) groups and choices carry **row-level provenance with a quoted source span**, not a confidence number; (c) a **lexicon** table maps customer words to existing catalog IDs; (d) a compiler writes a per-item **ask plan** and a per-item **bot state** (`orderable | blocked | display_only | stale`). The conversation engine reads only the compiled output.

2. **Inference emits questions, never data.** A cuisine archetype library (code, ~12 archetypes, versioned) says "burgers have a temperature slot." That never becomes a live group by itself. It becomes a one-tap owner question with a proposed answer. Only three things go live: facts quoted from the source, facts the owner confirmed, and aliases learned from real customers that point at existing IDs.

3. **Ask up front only what breaks a ticket. Learn everything else through use.** A slot is *kitchen-critical* (temp, bread, dressing, bagel type, flavor, "beef or chicken") or *price-critical* (size, count). Those are resolved before go-live, capped at about a dozen one-tap questions, asked per category not per item. Everything else is lazy: customer asks for something the catalog can't express → passed to the kitchen as a note at no price change → logged as a gap → owner gets a one-line SMS question later.

4. **Vocabulary is a table of edges, not a field on the item.** `lexicon(term → item | choice | category)`. Generated deterministically at import, augmented by collision-checked LLM proposals, extended by learned terms from confirmed conversations. An alias can only ever point at something that exists, so the lexicon cannot invent an item by construction.

5. **The readiness gate is a compile plus a generated menu walk.** Deterministic SQL checks (zero blocked items, unique display names, every slot has priced choices) plus an auto-generated acceptance suite that orders *every* orderable item through the real cart/sequencer/pricing code and asserts the ticket. No LLM in the gate. Items the source can't support go live as `display_only`: the bot knows they exist and says so honestly.

6. **Re-import never writes to the effective tables.** Each crawl is an immutable snapshot. Owner edits are captured as overrides by a trigger. Effective menu = snapshot ⊕ overrides ⊕ learned, then compile. The "groups and choices weren't protected" bug becomes structurally impossible because there is no second writer to protect against.

7. **The straw man is right about the three properties and wrong about the shape.** Per-item `aliases`, `constraints[]`, `suggestions[]`, and "resolve every item line by line" should all go. Details in §10.

Phase 0 is additive to the current schema and shippable this week. §11.

---

## 1. Principles the design is derived from

These are lifted from your own evidence and turned into rules. Every later section should be checkable against them.

**P1. The model phrases; code decides.** The sequencer decides which question is next. The resolver decides which item was meant. The cart decides what was added. The checkout gate decides whether the order can be paid. The LLM understands the customer's reply and phrases the next already-decided question. It never mutates state directly. (Your durability ranking: data > remove capability > code before model > code after model > prompt.)

**P2. Live behaviour must be traceable to a quote or a human.** Any group or choice the bot can act on has provenance `stated` (with a span that string-matches the source) or `owner_confirmed` (with the owner's answer). `inferred` rows exist only to generate questions. This is the invariant that stops the bot inventing an option.

**P3. Missing beats wrong, and honest beats missing.** If a kitchen-critical slot is unknown, the item is not orderable by text. The bot says "I can't take the Chicken Cutlet by text yet, but the shop can at 610-…". That is a worse experience than a right order and a far better one than a wrong ticket.

**P4. Owner effort is budgeted, ranked, and mostly asynchronous.** A hard cap on pre-go-live questions. Each question is one tap, scoped to a category or a shared list, with a pre-filled proposal. The remainder trickle over SMS after launch, triggered by real customer demand.

**P5. Determinism is a property of the state machine, not of the prompt.** Identical input yields identical questions in identical order with identical wording. Slot questions are rendered from templates; the LLM is reserved for understanding replies and for off-script turns.

**P6. One writer per table.** Importer writes snapshots. Owner writes overrides. Learning writes lexicon and gaps. The compiler writes the effective tables. Nothing else does.

---

## 2. The target artifact

### 2.1 Primitives

| Primitive | What it is | Exists today? |
|---|---|---|
| **Item** | A sellable thing with a base price. Carries `display_name` (what we say) distinct from `name` (what the POS/source says) and a `product_key` that groups size rows of the same product. | Partly. No display_name, no product_key. |
| **Group** on an item | A question the item may pose. `kind = slot` (required to make the item; min ≥ 1) or `kind = modifier` (optional extras). Carries `kitchen_critical`, `price_critical`, `default_choice_id`, `ask_mode`, provenance. | Yes as `option_groups`, without the flags. |
| **Choice** | An answer to a group. Carries `display_name`, `price_cents` delta, optional per-size price map, `is_default`, provenance + source span. | Yes as `option_choices`, without provenance. |
| **Modifier set** | A menu-level shared list (Toppings, Breads, Dressings) that groups bind to. Owner edits the price of Pepperoni once. Importer's job becomes "find the lists, attach the lists." | No. Phase 1. |
| **Lexicon** | `term → (item | choice | category)` edges with provenance and weight. | No. Phase 0. |
| **Ask plan** | Compiled, ordered list of steps the sequencer executes for one item. Stored as jsonb on the item; regenerated on every compile. | No. Phase 0. |
| **Bot state** | `orderable / blocked / display_only / stale` plus a reason. Computed by the compiler. | No. Phase 0. |
| **Owner question** | A ranked, scoped, one-tap question with a proposal and a binding to the row it will populate. | Partly (`flag_review`/`flag_reason` per item). Generalise. |
| **Import snapshot** | Immutable record of what one crawl extracted, with spans. | No. Phase 1 (Phase 0 can store one jsonb per run). |
| **Override** | One owner edit to one field of one entity, captured by trigger. | No. Phase 0 (replaces `owner_edited`). |

### 2.2 Slot vs modifier is the primitive the conversation actually needs

Your organic taxonomy already shows it. Every one of the 11 groups on the hand-built menu is either "pick exactly one from a list, required" (Dressing, Bread, Pasta, Sauce, Temp, Wrap Type, Wing Flavor, Steak or chicken) or "pick any extras" (Toppings, Add-ons, Extra Dressing). Two shapes. Name them, and every downstream rule becomes a lookup:

| | slot | modifier |
|---|---|---|
| min / max | min=1, max=1 (rarely 2) | min=0, max=n |
| asked proactively? | yes, one at a time, in `display_order` | never proactively, except a single `offer_once` open question for archetypes where it is expected ("Any toppings?") |
| default allowed? | yes → `ask_mode = apply_default`, stated in the confirmation, never silent | n/a |
| blocks checkout when empty? | yes | no |
| gates go-live when provenance is `inferred`? | yes if kitchen_critical or price_critical | no, becomes a lazy question |
| bare "yes" selects something? | never | never |

The `ask_mode` a slot compiles to:

- `ask` — required, no default, >1 choice. The sequencer asks.
- `apply_default` — required, default set. Applied, then spoken in the recap line ("Greek salad with Greek dressing"). Owner opts into this per group; the compiler never sets a default the owner didn't.
- `auto_single` — exactly one choice. Applied silently. It is a fact, not a question.
- `offer_once` — modifier group flagged by archetype (pizza toppings, bagel schmear). One open question after all slots are filled. A bare affirmation is not a selection; the customer must name a choice that resolves through the lexicon.
- `on_request` — modifier, never mentioned unless the customer names a choice.

### 2.3 Target DDL (Postgres)

Additive to the current tables. Columns marked **P0** ship this week; **P1** next; **P2** later. Everything is shop-scoped and under the same RLS as today.

```sql
-- ===== enums =====
create type provenance as enum ('stated','inferred','owner_confirmed','learned','defaulted');
create type group_kind as enum ('slot','modifier');
create type ask_mode   as enum ('ask','apply_default','auto_single','offer_once','on_request');
create type bot_state  as enum ('orderable','blocked','display_only','stale');

-- ===== menu_items (existing) =====
alter table menu_items
  add column display_name        text,                 -- P0. what the bot says. never null once compiled
  add column product_key         text,                 -- P0. groups size rows: 'pizza:cheese' for Cheese - Small/Med/Large
  add column archetype           text,                 -- P0. from library: pizza|burger|sandwich|salad|wings|pasta|bagel|eggs|platter|beverage|side|dessert|other
  add column bot_state           bot_state not null default 'blocked',   -- P0. compiler output
  add column bot_state_reason    text,                 -- P0. 'slot Temp inferred, unconfirmed' etc.
  add column ask_plan            jsonb,                -- P0. compiler output, see §2.4
  add column name_provenance     provenance not null default 'stated',   -- P0
  add column price_provenance    provenance not null default 'stated',   -- P0
  add column source_span         text,                 -- P0. the quoted text the name+price came from
  add column missing_from_source_since timestamptz;    -- P1. re-import saw it gone; kept live pending owner

-- ===== option_groups (existing) → the per-item binding =====
alter table option_groups
  add column kind               group_kind not null default 'slot',   -- P0. backfill: required→slot else modifier
  add column slot_key           text,                 -- P0. canonical key from archetype: 'size','temp','bread','dressing','toppings'…
  add column kitchen_critical   boolean not null default false,       -- P0
  add column price_critical     boolean not null default false,       -- P0
  add column default_choice_id  uuid references option_choices(id),   -- P0
  add column ask_mode           ask_mode,             -- P0. compiler output
  add column provenance         provenance not null default 'stated', -- P0
  add column source_span        text,                 -- P0
  add column set_id             uuid,                 -- P1. references modifier_sets
  add column portionable        boolean not null default false,       -- P2. half/half pizza
  add column depends_on_choice_id uuid;               -- P2. conditional group, one level only

-- ===== option_choices (existing) =====
alter table option_choices
  add column display_name       text,                 -- P0. 'Pepperoni' not 'Pepperoni (Whole pizza)'
  add column is_default         boolean not null default false,       -- P0
  add column provenance         provenance not null default 'stated', -- P0
  add column source_span        text,                 -- P0
  add column price_by_choice    jsonb,                -- P1. {"<size_choice_id>": 250, ...} size-dependent upcharge
  add column set_choice_id      uuid,                 -- P1. references modifier_set_choices
  add column ref_item_id        uuid references menu_items(id);       -- P2. combos: 'choice of side' → an item

-- ===== lexicon (new, P0) =====
create table lexicon (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null,
  menu_id      uuid not null,
  term         text not null,                         -- normalized: lowercase, no punctuation, singular
  target_type  text not null check (target_type in ('item','choice','category','product')),
  target_id    text not null,                         -- uuid for item/choice, category string, product_key
  provenance   provenance not null,                   -- stated (rule-generated from source text) | inferred (LLM proposal) | owner_confirmed | learned
  weight       real not null default 1.0,             -- learned terms accrue weight per confirmed use
  active       boolean not null default true,
  evidence     jsonb,                                 -- learned: conversation ids; inferred: model + prompt version
  created_at   timestamptz default now(),
  unique (menu_id, term, target_type, target_id)
);
create index on lexicon (menu_id, term) where active;

-- ===== owner_questions (new, P0) =====
create table owner_questions (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null,
  menu_id       uuid not null,
  scope_type    text not null check (scope_type in ('category','item','set','group','choice')),
  scope_id      text not null,
  slot_key      text,                                  -- 'temp', 'bread', …
  kind          text not null check (kind in ('exists','choices','price','still_sold','confirm_alias','default')),
  question_text text not null,                         -- owner's language, ≤ 160 chars for SMS
  proposal      jsonb not null,                        -- e.g. {"choices":["White","Wheat","Rye"],"source":"archetype:sandwich"}
  blocking      boolean not null,                      -- true iff kitchen_critical or price_critical
  priority      integer not null,                      -- items_affected × criticality; see §5
  items_affected int not null default 1,
  status        text not null default 'pending' check (status in ('pending','asked','answered','dismissed','expired')),
  answer        jsonb,
  asked_via     text,                                  -- 'web' | 'sms'
  asked_at      timestamptz, answered_at timestamptz,
  created_at    timestamptz default now()
);

-- ===== overrides (new, P0) — replaces owner_edited =====
create table menu_overrides (
  id           bigserial primary key,
  shop_id      uuid not null,
  menu_id      uuid not null,
  entity_type  text not null,                          -- 'item','group','choice','set','set_choice'
  entity_key   text not null,                          -- import_key or stable id; see §9
  field        text not null,                          -- 'price_cents','name','active','required', '*' for delete
  value        jsonb,
  actor        text not null,                          -- owner user id | 'question:<id>' | 'learning'
  created_at   timestamptz default now()
);
create index on menu_overrides (menu_id, entity_type, entity_key);

-- ===== import_runs / snapshots (P1; P0 stores raw jsonb on import_runs) =====
create table import_runs (
  id uuid primary key, menu_id uuid not null, shop_id uuid not null,
  started_at timestamptz, finished_at timestamptz,
  sources jsonb,            -- urls, platform adapter used, pdf hashes
  extract jsonb,            -- P0: the full extracted structure with spans
  stats jsonb,              -- items found, lists found, quote-check pass/fail counts, per-category coverage
  status text
);

-- ===== modifier_sets (P1) =====
create table modifier_sets (
  id uuid primary key, shop_id uuid not null, menu_id uuid not null,
  name text not null, kind group_kind not null, import_key text,
  provenance provenance not null, source_span text,
  unique (menu_id, name)
);
create table modifier_set_choices (
  id uuid primary key, set_id uuid references modifier_sets(id) on delete cascade,
  name text not null, display_name text, price_cents int not null default 0,
  price_by_size jsonb, display_order int, is_default boolean default false,
  provenance provenance not null, source_span text, import_key text, active boolean default true
);

-- ===== gaps (P1) — the learning loop's inbox =====
create table conversation_gaps (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null, menu_id uuid not null, conversation_id uuid,
  item_id uuid, utterance text not null,
  gap_type text not null check (gap_type in ('unresolved_term','unsupported_slot','display_only_requested','ambiguous_term')),
  resolution jsonb, created_at timestamptz default now()
);
```

### 2.4 The ask plan (compiler output, jsonb on `menu_items`)

```jsonc
{
  "compiled_at": "2026-09-07T14:02:11Z", "compiler_version": 3,
  "display_name": "Large cheese pizza",
  "base_price_cents": 1695,
  "steps": [
    { "group_id": "…", "slot_key": "toppings", "kind": "modifier", "ask_mode": "offer_once",
      "prompt_template": "toppings.offer_once",
      "choices": [ { "id": "…", "display": "Pepperoni", "price_delta_cents": 300 }, … ] }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

For a burger: one step `{slot_key:"temp", kind:"slot", ask_mode:"ask", choices:[Rare, Medium rare, Medium, Medium well, Well done]}`. The sequencer walks `steps` in order. It has nothing to decide.

### 2.5 What the model deliberately does not cover (and what to say to the customer)

| Case | v1 handling | Later |
|---|---|---|
| Half-and-half pizza | Bot: "I can only do whole-pizza toppings by text; I'll note it for the kitchen." Note passes through, priced as whole. | P2 `portionable` flag; cart selection carries `portion: whole|left|right`. |
| Combos / meals | Not extracted. If the source has "Combo #3", it imports as an item with a description, no slots, `display_only` if price-critical structure unknown. | P2 `ref_item_id` on choices. |
| Conditional groups ("if crust = gluten-free, no XL") | Not modelled. | P2 `depends_on_choice_id`, one level. |
| Quantity on a choice ("extra extra cheese") | "Extra cheese" is a distinct choice, as most menus print it. | Choice `max_qty`. |
| Time-of-day menus (breakfast until 11) | `is_available` toggled by owner or by schedule; out of scope here. | — |
| Free-text special requests | Always allowed. Ticket `notes`. Price unchanged. Bot says "I'll pass that to the kitchen" and never confirms availability or price. Logged as a gap. | — |

The last row is the safety valve that makes the strict provenance rule liveable. The bot can *always* take the customer's words to the kitchen; it just can't *price* or *promise* anything that isn't in the catalog.

---

## 3. The pipeline, crawl to live

```
crawl ──► extract ──► normalize ──► classify ──► infer ──► owner review ──► compile ──► gate ──► live ──► learn
 (1)        (2)         (3)          (4)         (5)          (6)            (7)       (8)     (9)      (10)
                                                                                 ▲                       │
                                                                                 └───── re-import (§9) ◄─┘
```

| Stage | Input → output | LLM? | Deterministic check that follows it |
|---|---|---|---|
| **1 Crawl** | Domain → source documents. Follow off-domain links to Slice / Toast / ChowNow / Owner.com / Square Online / Clover. **Platform adapters** read those sites' own structured menu (they all carry modifier groups with prices, in JSON or DOM). PDFs and images go to OCR. | No | Record every source with hash. |
| **2 Extract** | Documents → `import_runs.extract`: items (name, price, description, category, span), **shared lists** (a heading followed by a list of priced choices: "Toppings", "Dressings", "Breads"), and inline choice phrases. Every fact carries the exact text span it came from. | Yes, structured output with schema. | **Quote check:** every item name, price, list name, choice name and choice price must string-match (normalised) the source text. Anything that fails is demoted to `inferred` and cannot go live. This replaces the 0–100 confidence as the gate; confidence stays as a sort key for review. |
| **3 Normalize** | Rule-based, no LLM. Size folding into `product_key` (`Cheese - Large (16")` → product `pizza:cheese`, size `Large`). "X or Y" in a name → a stated slot (`Gyro (Beef or Chicken)` → slot Choice [Beef, Chicken], display "Gyro"). "choice of A, B or C" in a description → a stated slot. `display_name` from rules (§6.2). Duplicate display names across categories → qualified with a category noun. | No | Unit tests on the rule set. |
| **4 Classify** | Each category and each item → one archetype from the library. Keyword rules first; LLM only for categories the rules can't place; result shown to owner as a one-tap check ("Sandwiches — we'll ask about bread and size. Right?"). | Small | Archetype must be from the enum. |
| **5 Infer** | Archetype × extracted structure → for each expected slot on each category: bound to a found shared list (**stated**), or bound to a universal list (temp: **inferred, proposed**), or unknown (**inferred, question**). Emits `owner_questions` rows with proposals and priority. **Never writes a live group.** | No | Every question has a scope, a slot_key, a proposal and a blocking flag. |
| **6 Owner review** | Blocking questions first, cap 12, one tap each, per category. Then the editor for anything else. Answers write overrides via the `question:<id>` actor. | No | — |
| **7 Compile** | snapshot ⊕ overrides ⊕ learned → effective `menu_items / option_groups / option_choices`, `lexicon`, `ask_plan`, `bot_state`. Idempotent; runs after every import, every owner edit, every learned alias. | No | Compiler is pure: same inputs → same outputs. |
| **8 Gate** | §8. SQL invariants + generated menu walk through the real engine. | No | Produces a report; go-live switch is disabled until it passes. |
| **9 Live** | The engine reads `ask_plan`, `lexicon`, `bot_state` only. Storage names never enter a prompt. | Yes, reply understanding + phrasing only. | Existing guards + checkout gate. |
| **10 Learn** | Conversations → `conversation_gaps` and lexicon candidates → owner questions over SMS → overrides → recompile. | Advisory only | Acceptance rules in §6.4. |

**On stage 1:** your own measurement says the menu is off-domain on a third-party ordering platform for most of the 8/20 failures. Those platforms *have the modifier data*; that is their whole product. One adapter per platform yields sets with prices, which is precisely the thing the extractor misses from a PDF. Before investing further in PDF heuristics, find out which platforms the first ten design partners are on and build those two or three adapters. It is likely the single highest-yield importer task.

---

## 4. Derive vs ask

### 4.1 What is derivable, honestly

| Fact | Derivable? | From what | Failure mode if derived wrongly |
|---|---|---|---|
| That a slot **exists** (burgers → temp, sandwiches → bread, salads → dressing, wings → flavor) | **Yes, high precision** by archetype, per category | Archetype library | Over-derive: bot asks a question the shop doesn't offer ("what bread?" at a place with one roll). Bounded by the owner confirm tap. |
| Which items in a category are **exceptions** (Chicken sandwich has no temp; Caesar salad has a fixed dressing) | Partly, by rule (name contains a dressing name → default) | Rules | Bounded: exceptions are shown in the same owner question as an exclusion list. |
| The **choice list** for a slot | Only when universal (temp) or when the source states it (shared list / inline / "choice of") | Source spans | Inventing choices the shop doesn't sell. **Never derive a restaurant-specific list.** |
| **Prices** of choices | **Never** | Source or owner | Wrong total. Hard rule: no price without a span or an owner answer. |
| Which shared list attaches to which category | Yes, by archetype + list name matching ("Toppings" → pizza; "Dressings" → salad) | Rules | Attaching to the wrong category; shown to owner as one tap per binding. |
| Defaults | No. The owner sets defaults. Exception: a dressing named in the item name. | Owner | Silent wrong ticket. |

So: derive **existence**, propose **universal lists**, extract **restaurant lists and prices**, and ask the owner to confirm each with one tap. Never let derivation produce a live row.

### 4.2 Mechanism: the archetype library, in code

A TypeScript module, versioned, unit-tested, ~150 lines of data. Not a prompt, not a database table, not learned. It changes when engineering decides it should.

```ts
type SlotRule = {
  slot_key: string;                 // 'temp' | 'bread' | 'dressing' | 'size' | 'flavor' | 'bagel' | 'egg_style' | 'side' | 'pasta' | 'protein'
  kitchen_critical: boolean;
  price_critical: boolean;
  universal_choices?: string[];     // only for slots whose list is the same everywhere
  bind_to_list_named?: RegExp;      // try to attach an extracted shared list first
  applies_when?: (item) => boolean; // per-item exception rule
  default_from_name?: RegExp;       // 'caesar' in a salad name → default dressing Caesar
  owner_question: string;           // template, owner's language
  order: number;                    // canonical ask order within the archetype
};
type Archetype = { key: string; match: RegExp[]; slots: SlotRule[]; modifiers: ModifierRule[] };
```

The v0 library is in Appendix A. Twelve archetypes cover a pizzeria, a bagel shop, a Greek-Italian place, a diner, a burger joint, a wing shop and a deli. `other` is a valid outcome and means "no inferred slots; go live with what the source states."

### 4.3 The two rules that prevent invention

1. **Inference writes to `owner_questions`, never to `option_groups`.** A question's `proposal` holds the choices; only the owner's answer, via an override with actor `question:<id>`, creates rows with provenance `owner_confirmed`.
2. **Extraction is quote-checked.** A choice or price with no matching span is `inferred`, and `inferred` choices are never `active` in the effective tables. They appear pre-checked in the owner's proposal instead.

### 4.4 Rejected mechanisms

- *Free LLM inference of option lists.* Invents. Your Vito's data shows the extractor already dropped 83% of choices silently; letting it make up the balance is the opposite of the fix.
- *Retrieval from other onboarded restaurants as data.* Cross-tenant leakage, and with ten restaurants there is nothing to retrieve. Use the archetype library, which is the same idea hand-curated.
- *Confidence thresholds as the gate.* An LLM's 0–100 is not calibrated. A string match is. Keep confidence for sorting the review queue.

---

## 5. The owner interaction

### 5.1 Question types, one tap each (three before go-live, three after)

| kind | Example text (≤160 chars, SMS-safe) | Proposal shown | Answer writes |
|---|---|---|---|
| `exists` | "Sandwiches (24 items): do customers pick a bread? 1 Yes  2 No, one roll" | — | Yes → group created on each item in scope (minus exclusions) as `owner_confirmed`; No → slot marked not applicable, category exclusion recorded. |
| `choices` | "Which breads? Reply with numbers, add any others: 1 White 2 Wheat 3 Rye 4 Kaiser" | Pre-checked from a found list, or universal list, or empty | Choices created as `owner_confirmed`. |
| `price` | "Extra topping on a large pizza — how much? (Small $1.50, Med $2.00 already found)" | Found prices | `price_cents` / `price_by_choice`. |
| `still_sold` (post-launch) | "The site no longer lists Stuffed Shells ($14.95). Still on the menu? 1 Yes 2 No" | — | Keep / deactivate. |
| `confirm_alias` (post-launch) | "Customers say 'plain pie' for Cheese Pizza. OK to treat those the same? 1 Yes 2 No" | — | Lexicon `owner_confirmed`. |
| `default` (post-launch, optional) | "Most people don't say a temp for burgers. Should we assume medium and say so? 1 Yes 2 No" | — | `default_choice_id`. |

Scope is **category or set first, item second**. "Do customers pick a bread on sandwiches?" once, with an exclusion list, beats 24 per-item questions. Exceptions are one line: "Except: Meatball Parm, Chicken Cutlet — reply E to edit."

### 5.2 Budget and ranking

- `priority = items_affected × (kitchen_critical ? 3 : 0 + price_critical ? 3 : 0 + 1)`.
- **Blocking** questions (kitchen- or price-critical slot with `inferred` provenance) must be answered or the affected items go live as `display_only`. The owner sees this trade-off plainly: "3 questions left. Items customers can't order by text until answered: 24."
- **Hard cap of 12** blocking questions surfaced before go-live. If the ranked list is longer, the tail is asked over SMS after launch and the affected items launch `display_only`. In practice a pizzeria yields 4–6 (size confirm, toppings binding, wing flavor, salad dressing, sandwich bread, "beef or chicken" confirms); a bagel shop 3–4.
- Non-blocking questions never appear before go-live. They arrive by SMS at a rate of at most **one per day**, triggered by a `conversation_gaps` row when possible ("A customer asked for wheat on the Chicken Cutlet today…"), because a question tied to real demand gets answered.

### 5.3 Channel

The owner's phone is the admin console. The product is SMS; the owner question queue should be SMS too, with the web editor as the long-form fallback. Reply parsing is deterministic (numbers, Y/N, E). Anything else routes to the web editor link.

### 5.4 The lazy loop: how the menu improves through use

1. Customer says something the resolver can't place → gap `unresolved_term`; bot answers honestly ("I don't see that on the menu — closest I have is…" from lexicon fuzzy match, deterministic, top 3).
2. Customer asks for a slot the item doesn't have ("on wheat") → gap `unsupported_slot`; bot passes it through as a note at no price change; owner question `exists` queued for that category, non-blocking.
3. Customer orders a `display_only` item → gap `display_only_requested`; bot declines honestly; the blocking question for that item jumps to the head of the SMS queue.
4. Owner answers → override → recompile → next customer gets the structured question.

Nothing in this loop lets the bot promise something new before the owner has said yes.

---

## 6. Customer vocabulary

### 6.1 Why a table, not a field

Aliases target items, but also choices ("pep" → Pepperoni), categories ("a pizza" → Pizza), and products ("large pizza" → product `pizza:cheese` + size Large). They have their own provenance and lifecycle (learned terms accrue weight, can be retired). They need a menu-wide uniqueness check, which an array on a row cannot express. And they are the one place where an LLM proposal is cheap and the validation is trivial: *does the target exist, and does the term collide?*

### 6.2 Generation at import (deterministic first)

Rules, in order, each producing `provenance = stated`:

1. `display_name` itself, normalised.
2. Strip parentheticals and size tokens: `Cheese - Large (16")` → `cheese`, `cheese pizza` (category noun appended when the name is a bare adjective/noun that collides).
3. Category noun singular and plural → `category` target ("pizza", "pizzas", "salads").
4. Product key names: `product` target "cheese pizza" for the folded size rows, with each size row's `size_label` and its numerals as `choice`-style terms ("large", "lg", "16 inch", "16\"").
5. Every choice `display_name` → `choice` target, plus common abbreviations from a static list (pep → pepperoni, mush → mushrooms, xtra → extra).
6. "X or Y" slot choices → their names.

Then one LLM pass proposes up to 5 extra aliases per item (`provenance = inferred`), which the compiler **keeps only if** the target exists and the term does not already resolve to a different item, product or category in this menu. Collisions are dropped and logged, not asked.

**Display name rules** (also deterministic): drop the category suffix (`Chicken Caesar (Salads)` → `Chicken Caesar`), drop the "X or Y" clause once it has become a slot, drop size tokens once folded, title-case, and if two orderable items share a display name, qualify each with its category noun (`Chicken Caesar Salad` / `Chicken Caesar Wrap`). The engine is handed `display_name` only; `name` never reaches a prompt.

### 6.3 Resolution (deterministic, in code)

```
normalize(utterance) → tokens
candidates = lexicon exact-phrase hits ∪ token-subset hits (scored by coverage, weight, term length)
slot_values = for the candidate item(s), match remaining tokens against its groups' choice terms  // "large pepperoni pizza" fills size + toppings
if one candidate above margin          → resolve; pre-fill matched slots; sequencer asks only what remains
if several within margin               → existing disambiguation menu (already 8/8)
if a category or product only          → deterministic "which one?" listing ≤5 by display_order, or size question for a product
if none                                → honest miss + top-3 fuzzy (trigram) suggestions, all from the lexicon; gap logged
```

The LLM's job on a customer turn is to emit structured intent (`add {text:"large pepperoni pizza", qty:1}`, `set_slot {text:"medium rare"}`, `remove {text:"the pizza"}`, `confirm`, `ask`). The resolver, not the model, maps text to IDs. "Remove the pizza" works because the cart line carries its item's lexicon terms and the removal resolver matches against the cart, not the menu.

### 6.4 Learning from conversations (never gates, never invents)

A learned alias is proposed when a customer term resolved via disambiguation or fuzzy suggestion and the customer then **confirmed** and **paid**. It becomes `active` (provenance `learned`) after the same mapping is confirmed in **3 distinct conversations** with **0 contradictions** (a contradiction is the customer rejecting the mapping). Owner may be asked `confirm_alias` for high-traffic terms. Learned terms map to existing IDs only, by construction.

---

## 7. What the conversation engine consumes (contract)

Kept short because most of it exists. The point is to name what must read compiled data only.

- **Sequencer:** input = cart line + `ask_plan`; output = the single next step or `complete`. Renders slot questions from `prompt_template` (Appendix C) with identical wording every time. Only one open question at a time. Handles a reply that answers a *later* step by filling it and continuing.
- **Resolver:** §6.3. Reads `lexicon`, `bot_state`. Never returns an ID with `bot_state != orderable`; returns `display_only` as a distinct outcome the phrasing layer must voice honestly.
- **Cart:** lines carry `item_id, qty, selections[{group_id, choice_id, qty, portion?}], notes`. Exposes `unfilled_required_groups()`.
- **Pricing:** `base + Σ delta(choice, selected size)` from `price_cents` / `price_by_choice`. Pure function; the walk in §8 asserts it.
- **Checkout gate:** refuses when any line has `unfilled_required_groups()` non-empty or any line's item is not `orderable` at that moment.
- **LLM turn:** receives display names, the one pending question, the cart recap. Emits intent JSON. Never receives storage names, `inferred` rows, or the ability to add an item by ID it wasn't handed by the resolver.
- **Removed capability stays removed:** no unprompted suggestions. If pairing ever returns it is a separate relation, offered at exactly one moment (after `complete`, before payment), phrased as a question whose bare "yes" is a no-op.

---

## 8. The readiness gate

### 8.1 Item states (compiler output)

| state | meaning | bot behaviour |
|---|---|---|
| `orderable` | All slots have ≥1 active priced choice; all kitchen/price-critical slots are `stated` or `owner_confirmed`; has display_name; has ≥1 unique lexicon term | takes the order |
| `blocked` | A blocking owner question is pending | pre-launch only; cannot be live |
| `display_only` | Owner chose not to answer (or cap reached), or source lacks a price | "I can't take that one by text yet; call 610-…" and a gap row |
| `stale` | Missing from source > 14 days and owner hasn't confirmed | stays orderable; owner question `still_sold` pending |

### 8.2 Menu-level invariants (SQL, run by the compile function, all must hold)

1. No item in an active category is `blocked`.
2. Every `orderable` item has non-null `display_name` and `ask_plan`, `price_cents > 0`, `price_provenance in (stated, owner_confirmed)`.
3. No two `orderable` items in the same menu share `lower(display_name)`.
4. Every `orderable` item has ≥1 active lexicon term that resolves uniquely to it (or to its product).
5. Every group on an orderable item: `kind=slot ⇒ min_select ≥ 1`, `min ≤ max`, ≥1 active choice, every active choice has provenance in (stated, owner_confirmed) and a non-null price.
6. Every `default_choice_id` references an active choice in its own group.
7. No active `inferred` choice anywhere.
8. `orderable / active` ratio ≥ 0.9, **or** the owner has explicitly acknowledged the `display_only` list (recorded as an override with field `acknowledged_display_only`). Report the number either way.

### 8.3 The generated menu walk (the real gate)

For every `orderable` item, the compiler emits a test case:

```
walk(item):
  add via resolver(term = item.display_name)         → assert 1 cart line, item_id matches
  for step in ask_plan.steps:
    ask   → answer with choices[0].display via resolver  → assert selection recorded
    apply_default / auto_single → assert selection present without a question
    offer_once → answer "no thanks"                        → assert nothing added
  assert unfilled_required_groups() == []
  assert total == base + Σ deltas (+ consumer fee)
  assert ticket text contains every selection's display_name and never contains item.name if name ≠ display_name
alias_walk(item): for each active lexicon term → resolver(term) resolves to item, or to a disambiguation set containing it
```

This runs against the real sequencer, cart, pricing and ticket code with structured intents, **no LLM**, so it is fast, free and deterministic. It gives 100% item coverage per restaurant without anyone writing a case. A sampled run of 20 items through the full LLM path is *advisory* and lands in the report, per your rule.

The existing 129-case harness keeps covering conversational behaviour (multi-item, corrections, tenant isolation). The walk covers "the data supports every item," which is the class of bug this document is about.

### 8.4 The honest cases

When the source simply doesn't say: the item launches `display_only` with a reason the owner can see, the bot declines it honestly, and the first customer to ask promotes its question to the top of the SMS queue. The restaurant is live with 90% of its menu in an hour instead of 100% never.

---

## 9. Re-import and the merge model

**Rule: the importer never writes to the effective tables.** It writes an `import_runs` row. The compiler builds the effective tables from the latest snapshot plus overrides.

**Entity keys** (stable across crawls, used by `menu_overrides.entity_key`):
- item: existing `import_key`
- group: `<item import_key>#<slot_key>`
- choice: `<group key>#<normalised choice name>`
- set / set choice: `<menu>#<normalised set name>[#<normalised choice name>]`
- owner-created rows (no import_key): `owner:<uuid>`; the importer never touches them.

**Capturing owner edits:** a trigger on `menu_items / option_groups / option_choices` (and sets in P1) writes a `menu_overrides` row for each changed field when `current_setting('app.actor')` is an owner or a `question:<id>`. The compiler sets the actor to `compiler` and the trigger ignores it. Nothing else needs to remember to set `owner_edited`.

**Compile order:** snapshot → apply overrides in `created_at` order (last write wins per field) → apply learned lexicon → compute states and plans. A deleted override (`field='*'`, value null) suppresses the entity.

**Conflicts:** source value changed since the last snapshot **and** an override exists on the same field → owner value wins, and a non-blocking question `price` / `exists` is queued: "The site now says $2.75 for extra pepperoni; you set $3.00. Keep yours? 1 Yes 2 Use $2.75."

**Disappearances:** entity present in effective, absent from the new snapshot → set `missing_from_source_since`, keep it live, queue `still_sold`. After 14 days unanswered, state `stale` (still orderable, flagged in the report). Websites go out of date more often than kitchens stop selling things.

**Appearances:** new entity in the snapshot → goes through infer/compile like day one; new kitchen-critical slots create blocking questions but do **not** take the menu offline: the new item is `display_only` until answered.

**Migration from `owner_edited`:** one-time script converts every `owner_edited = true` row into overrides for all of its non-null fields with actor `migration`. Then drop the reliance on the flag.

---

## 10. Verdict on the straw man

| Straw man element | Verdict | Replace with |
|---|---|---|
| item → option_group → choice | **Keep.** It survives contact with real menus once groups are typed as slot/modifier and sets are shared. Nothing in your three restaurants needs a different primitive. | §2 |
| `aliases[]` on the item | **Wrong home.** Aliases target choices, categories and products too, and need collision checks and a learning lifecycle. | `lexicon` table, §6 |
| `display_name` on the item | **Right.** Make it compiler-owned with deterministic rules, owner-overridable. | §6.2 |
| `size_variants[]` | **Neither variant nor group in v1.** Keep the size rows the importer already produces, fold them under `product_key`, let the resolver ask the size question. Pricing by size stays per row for free. A true size slot with `price_by_choice` is P1 for restaurants whose source lists one item with several sizes. | §3 stage 3, §6.3 |
| `default_choice_id` | **Right,** with `ask_mode = apply_default` and "say so" enforced by the recap template. Never set by inference. | §2.2 |
| `constraints[]` | **A smell, as you suspected.** The three real cases are size-dependent price, half-and-half portions, and max_select. Model those three; do not build a constraint language. | `price_by_choice`, `portionable`, `max_select` |
| `suggestions[]` | **Off the item, off the critical path.** If it ever returns: separate relation, one moment, bare yes is a no-op. | §7 |
| Per-field provenance on everything | **Over-scoped.** Provenance matters on the rows where lying happens: item name/price, group existence/requiredness, choice existence/price. Store it per row on those three with a quoted span. | §2.3 |
| Provenance as the readiness gate | **Necessary input, not the gate.** The gate is the compile invariants plus the generated walk. Provenance decides *what the compiler may mark orderable*; the walk proves the engine can actually take it. | §8 |
| Confidence ≥ 75 as the gate | **Replace with the quote check.** Keep confidence to sort the review queue. | §3 stage 2 |
| "Resolve every item line by line at import" | **Wrong unit.** Structure is shared within a category. Infer per archetype/category, bind shared lists, ask per category with exclusions, and let item-level exceptions be rules or one-line edits. Lazy resolution is right for non-critical slots and vocabulary; wrong for kitchen- and price-critical slots. | §4, §5 |
| "The model receives one already-decided question and phrases it warmly" | **Go one step further.** Render slot questions from templates; identical wording every run. Use the model for understanding replies and for off-script turns. | §7, Appendix C |

---

## 11. Implementation plan

### Phase 0 — this week (additive; engine reads new columns, nothing else changes)

Serves the critical path directly: "the bot takes a normal order correctly" on Not Just Bagels and Zio's without a human loading options by hand.

1. **Schema:** P0 columns and tables from §2.3. Backfill: `kind` from `required`, `display_name = name` then rule pass, `provenance = owner_confirmed` for existing Vito's rows (human-built, no source span to quote), `bot_state` via compile.
2. **Normalizer** (`normalize.ts`): size folding → `product_key`; "X or Y" and "choice of" parsers → stated slots; display-name rules; duplicate qualification. Unit-test against the 221 Vito's rows: expect ≥ 62 pizzas folded into products, `Gyro (Beef or Chicken)` → slot, `Chicken Caesar (Salads)` → `Chicken Caesar Salad`.
3. **Archetype library v0** (`archetypes.ts`, Appendix A) + **infer** step that writes `owner_questions` only.
4. **Compiler** (edge function `compile-menu`): effective tables → `ask_plan`, `bot_state`, lexicon generation (rules only in P0; LLM proposals in P1). Idempotent. Triggered after import, after owner save, after a question is answered.
5. **Gate** (edge function `menu-readiness`): §8.2 invariants + the generated walk from §8.3 through the existing cart/sequencer/pricing code with structured intents. Output a report; wire the go-live switch to it.
6. **Owner questions in the web editor:** blocking list, capped at 12, one tap, category scope with exclusions. SMS delivery is P1; the data model is P0.
7. **Overrides trigger + migration** from `owner_edited`. This closes the "re-import reverted my $3.00" class permanently.
8. **Sequencer and resolver read compiled data.** Two jobs of different size. (a) Small: the first reply after `add_item` goes through `findPendingOptionQuestion` like every later turn; `ask_plan` replaces per-turn group queries; `display_name` replaces `name` everywhere a prompt is built. (b) Large, new construction: a standalone resolver for fresh adds per §6.3, callable without the LLM. Today the LLM is the resolver for new items; this is the single highest-risk item in Phase 0 and the menu walk in §8.3 depends on it. Resolution writes into the existing string-keyed cart `options` shape; ID-based cart storage is Phase 1.
9. **Run it on Not Just Bagels and Zio's.** Expected result: the compile produces ~4–6 blocking questions each; after Jason answers them as a stand-in owner, both menus pass the gate with ≥ 90% orderable, and the 129-case harness passes unchanged on Vito's.

**Acceptance for Phase 0:** a fresh import of Zio's, with zero hand-built option rows, reaches `gate = pass` after at most 12 owner taps, and the menu walk passes for every orderable item.

### Phase 1 — next

- `modifier_sets` + bindings; extractor emits shared lists with spans; compiler materialises per-item groups from sets. Owner edits one price, all items follow.
- Quote-check in extraction; demotion to `inferred`.
- SMS owner-question channel with deterministic reply parsing, one question per day, gap-triggered.
- `conversation_gaps` + learned lexicon with the 3-confirmations rule.
- LLM alias proposals with collision check.
- `price_by_choice` for size-dependent upcharges where the source has one item with several sizes.
- Platform adapters for whichever two ordering platforms the first ten partners use.

### Phase 2 — when a customer needs it

- Half-and-half portions, conditional groups, combos via `ref_item_id`, choice quantities.
- Pairing/suggestions as a separate relation, if a design partner asks.

---

## 12. Decisions for Jason

1. **SMS as the owner-question channel.** Recommended yes; it is the same rails and the same mental model. Needs a 10DLC-approved number per shop, which you already have on the customer side.
2. **Go-live threshold.** Recommended: zero blocked, and ≥ 90% orderable *or* an explicit owner acknowledgement of the `display_only` list. The alternative, 100% or nothing, is how you end up hand-building menus again.
3. **Platform adapters now vs later.** Recommended: find out which platforms the first ten are on this week; if two platforms cover most of them, adapters jump ahead of any further PDF work.
4. **Pairing/suggestions stay removed** until a design partner asks. Recommended yes.

---

## Appendix A — Archetype library v0

`kc` = kitchen-critical, `pc` = price-critical. "Bind" means attach an extracted shared list if one exists with that name; otherwise the listed fallback.

| archetype | match (category or name) | slots, in ask order | modifiers | notes |
|---|---|---|---|---|
| pizza | pizza, pie, calzone, stromboli | **size** (pc) — from folded rows or size list | **toppings** (bind /topping/; `offer_once`; priced; may be size-priced) | Specialty pizzas: toppings modifier `on_request` only, no offer. |
| burger | burger, patty melt | **temp** (kc; universal: rare, medium rare, medium, medium well, well done) | add-ons (bind /add|extra/; `on_request`) | `applies_when`: not chicken/veggie/turkey in name. |
| steak | steak, filet, ribeye, sirloin, strip | **temp** (kc; universal) | — | |
| sandwich | sandwich, hoagie, sub, hero, grinder, wrap, cheesesteak, panini, club | **bread** (kc; bind /bread|roll/; else owner `exists`+`choices`), **size** (pc if multiple prices), **protein** from "X or Y" | toppings/extras (`on_request`) | Wrap category: bread slot becomes "wrap type". |
| salad | salad | **dressing** (kc; bind /dressing/; `default_from_name` for caesar/greek/ranch/balsamic) | add protein (bind /add|protein/; `on_request`), extra dressing (`on_request`) | |
| wings | wings, tenders, boneless | **flavor** (kc; bind /flavor|sauce/), **count** (pc; from folded rows or "6 pc / 12 pc") | — | |
| pasta | pasta, penne, ziti, spaghetti, linguine, fettuccine, ravioli | **pasta type** (kc only if a list is found or stated in description; else no slot, no question) | add protein (`on_request`) | Don't ask owner unless the source hints; many places fix the pasta per dish. |
| bagel | bagel, bialy | **bagel type** (kc; bind /bagel/), **spread** (kc if name contains "with cream cheese/butter/schmear"; bind /cream cheese|spread|schmear/) | extras (`on_request`) | Egg sandwiches on bagels: bagel type kc, egg style not asked. |
| eggs | egg, omelet, omelette, scramble, benedict | **egg style** (kc; universal: scrambled, over easy, over medium, over hard, sunny side up, poached), **toast** (kc; bind /toast|bread/), **side** (kc if "choice of" in description) | — | Omelets: egg style `auto_single` = omelet. |
| platter | "choice of", "served with your choice", platter, dinner, entree | **side** (kc; stated from "choice of" parse) | — | Only when the description states the choice. |
| beverage | soda, coffee, tea, juice, shake, smoothie, drink | **size** (pc if multiple prices), **flavor** (kc if a list is found) | — | |
| side / dessert / kids / other | everything else | **size** (pc if multiple prices) | — | No inferred questions. |

Canonical ask order within any item: size → protein/variant → temp → bread/bagel → sauce/dressing/flavor → side → (offer_once modifiers).

## Appendix B — Worked examples

**Vito's, `Cheese - Small (12")` / `Cheese - Large (16")`, category Pizza.**
Normalize: `product_key = pizza:cheese`, `size_label` Small/Large, `display_name` "Small cheese pizza" / "Large cheese pizza". Lexicon: product "cheese pizza", "plain pizza" (rule list), "pizza" → category; choices "small", "12 inch", "large", "16 inch". Infer: archetype pizza → toppings binding found (the shared block) → `stated`, `offer_once`. Owner question: none blocking (size stated by rows; toppings quoted). Compile: `orderable`. Walk: "large cheese pizza" → product → size pre-filled Large → step toppings offer_once → "no thanks" → complete → total 16.95 + 0.99. Customer says "large pepperoni pizza": product + size Large + toppings Pepperoni pre-filled from lexicon; no question asked; recap "1 large cheese pizza with pepperoni, $19.95".

**Zio's, `Gyro (Beef or Chicken)`, $11.50.**
Normalize: slot `protein` [Beef, Chicken] `stated` (span is the name), `display_name` "Gyro". Infer: archetype sandwich → bread: no list found, no hint → owner question `exists` scoped to category Sandwiches (kc, blocking). Owner taps "2 No, one roll" → slot not applicable → compile → `orderable` with one `ask` step: "Beef or chicken?" Ticket: `Gyro (Beef or Chicken)\n  + Chicken`.

**Not Just Bagels, `Bagel with Cream Cheese`, $3.75.**
Infer: archetype bagel → bagel type: shared list "Bagels: plain, everything, sesame, …" found → `stated`; spread: list "Cream cheese: plain, scallion, veggie, lox spread (+$2)" found → `stated` with one priced choice quoted. Zero owner questions. Compile: two `ask` steps in order. Walk passes. First customer: "everything bagel with scallion cream cheese" → both slots pre-filled from the lexicon, no questions, recap and total.

**Not Just Bagels, `Chicken Cutlet`, $9.95, category Sandwiches, source silent on bread.**
Owner cap reached at 12 → item launches `display_only`. Customer asks for it → bot: "I can't take the Chicken Cutlet by text just yet — you can call the shop at 610-…" → gap row → the bread question for Sandwiches goes out by SMS that evening → owner replies "1" and "1 2 3 4" → override → recompile → orderable by morning.

## Appendix C — Slot question templates (identical wording every run)

| template key | rendered |
|---|---|
| `temp.ask` | "How would you like the {display_name} cooked? {choices}." |
| `bread.ask` | "What bread for the {display_name}? {choices}." |
| `dressing.ask` | "Which dressing on the {display_name}? {choices}." |
| `size.ask` | "What size {product_display}? {choices_with_prices}." |
| `flavor.ask` | "Which flavor for the {display_name}? {choices}." |
| `protein.ask` | "{choices_or} for the {display_name}?" |
| `bagel.ask` | "Which bagel? {choices}." |
| `toppings.offer_once` | "Any toppings on the {display_name}? Say which, or 'no' for plain." |
| `apply_default.recap` | "{display_name}, {default_choice} (say the word to change it)" |
| `display_only.decline` | "I can't take the {display_name} by text yet, but the shop can at {shop_phone}." |
| `unresolved.miss` | "I don't see that on the menu. Closest I have: {top3}. Which did you mean?" |

`{choices}` renders ≤ 6 choices as "a, b, or c"; more than 6 renders the first 5 plus "or something else". `{choices_with_prices}` renders "small $12.95, large $16.95". The LLM never rewrites these lines; it may add one warm sentence before them on the first turn only.
