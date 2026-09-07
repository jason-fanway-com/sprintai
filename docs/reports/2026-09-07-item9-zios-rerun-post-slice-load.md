# Item 9 — read-only compile report: Zio's Pizzeria (re-run, Slice load complete)

Generated 2026-09-07T19:56:31Z. Report-only: zero writes made to any table. This is the
real number the day's work was building toward: how many of Zio's 220 items are orderable
after loading real Slice-sourced option data (490 option_groups, 3413 option_choices,
independently confirmed against the live DB before this run — see command log), with zero
hand-built option rows and zero owner input.

**A real bug in this script was found and fixed before this run, not glossed over:**
the previous run (reported to the PO as a mid-write artifact, 21/220) was NOT actually a
mid-write snapshot — the Slice write had already finished. The real cause: `fetchAllRows`'s
single `.in("option_group_id", groupIds)` call sent all 490 group ids in one request, which
failed outright (`TypeError: fetch failed` / "stream error detected: unspecific protocol
error" — reproduced directly, confirmed the root cause, not a guess) once Zio's had enough
real option_groups for the request to hit an HTTP transport limit. The old code caught that
error, logged one line, and silently returned a truncated (in this case effectively empty)
choice list — so every item with any option group looked like it had zero choices and fell
to blocked. Fixed two ways: `fetchAllRows` now throws on error instead of swallowing it, and
a new `fetchRowsInIdBatches` helper chunks any `.in()` id list into batches of 100 — this
scales to any shop size, not just today's Zio's count, per the standing "restaurant #1 and
restaurant #10,000" rule. Re-verified NJB is unaffected and unchanged (100/170, 58.8%,
matches the just-committed report exactly) before trusting this number for Zio's.

---
## Zio's Pizzeria

**Items in:** 220 total (220 active, 0 inactive/hidden)

**Items orderable:** 163 / 220 (74.1%)

Other states: blocked 57, display_only 0, stale 0

### Items blocked, and on what

- **slot bread pending owner question: Do customers pick a bread on Hot Subs?** — 16 item(s)
  - Italian Hot Dog Sub [Hot Subs]
  - Chicken Cheesesteak Sub [Hot Subs]
  - Chicken Parmigiana Sub [Hot Subs]
  - Peppers & Egg Sub [Hot Subs]
  - Cheesesteak Sub [Hot Subs]
  - Zio's Cheesesteak Sub [Hot Subs]
  - Sausage Parmigiana Sub [Hot Subs]
  - Eggplant Parmigiana Sub [Hot Subs]
  - Sausage, Peppers & Onions Sub [Hot Subs]
  - Veal Parmigiana Sub [Hot Subs]
  - Shrimp Parmigiana Sub [Hot Subs]
  - Grilled Chicken California Sub [Hot Subs]
  - Meatball Parmigiana Sub [Hot Subs]
  - Grilled Chicken Sub [Hot Subs]
  - Steak Sub [Hot Subs]
  - California Cheesesteak Sub [Hot Subs]
- **slot bread pending owner question: Do customers pick a bread on Paninis?** — 12 item(s)
  - Veggie Panini [Paninis]
  - Grilled Chicken Pesto Panini [Paninis]
  - Italian Panini [Paninis]
  - New York Panini [Paninis]
  - Chicken Caprese Panini [Paninis]
  - Panini A La Roma Panini [Paninis]
  - Monte Cristo Panini [Paninis]
  - Zio's Panini [Paninis]
  - Chicken Parm Panini [Paninis]
  - Fresco Panini [Paninis]
  - Roast Beef Panini [Paninis]
  - Capri Panini [Paninis]
- **slot bread pending owner question: Do customers pick a bread on Wraps?** — 11 item(s)
  - Tuna Provolone Wrap [Wraps]
  - New York Wrap [Wraps]
  - Turkey Wrap [Wraps]
  - Cheese Steak Wrap [Wraps]
  - Chicken Cheese Steak Wrap [Wraps]
  - Chicken Caesar Wrap [Wraps]
  - Veggie Wrap [Wraps]
  - Buffalo Chicken Wrap [Wraps]
  - Prosciutto Wrap [Wraps]
  - Roast Beef Wrap [Wraps]
  - Grilled Chicken Wrap [Wraps]
- **slot bread pending owner question: Do customers pick a bread on Cold Subs?** — 8 item(s)
  - Roast Beef Sub [Cold Subs]
  - Turkey Sub [Cold Subs]
  - Ham & Cheese Sub [Cold Subs]
  - New York Sub [Cold Subs]
  - Tuna Sub [Cold Subs]
  - Ham, Cheese & Salami Sub [Cold Subs]
  - Prosciutto Sub [Cold Subs]
  - Italian Sub [Cold Subs]
- **slot temp pending owner question: Do customers pick a temperature on Burgers?** — 6 item(s)
  - Burger [Burgers]
  - BBQ Cheese Burger [Burgers]
  - Cheese Burger [Burgers]
  - Double Burger [Burgers]
  - Zio's Deluxe Burger [Burgers]
  - Mamma Mia Burger [Burgers]
- **slot bread pending owner question: Do customers pick a bread on Baskets & Gyros?** — 4 item(s)
  - Chicken Gyro [Baskets & Gyros]
  - Chicken Fingers & Fries [Baskets & Gyros]
  - Fried Shrimp & Fries [Baskets & Gyros]
  - Gyro [Baskets & Gyros]

### Full owner_questions list (6 rows — none exist in the DB yet, these are what item 3's infer would write)

- **[Hot Subs] bread** (archetype: sandwich, blocking: true, priority: 64, items affected: 16)
  - Q: Do customers pick a bread on Hot Subs?
  - Proposed choices: (none — owner must supply)
- **[Paninis] bread** (archetype: sandwich, blocking: true, priority: 48, items affected: 12)
  - Q: Do customers pick a bread on Paninis?
  - Proposed choices: (none — owner must supply)
- **[Wraps] bread** (archetype: sandwich, blocking: true, priority: 44, items affected: 11)
  - Q: Do customers pick a bread on Wraps?
  - Proposed choices: (none — owner must supply)
- **[Cold Subs] bread** (archetype: sandwich, blocking: true, priority: 32, items affected: 8)
  - Q: Do customers pick a bread on Cold Subs?
  - Proposed choices: (none — owner must supply)
- **[Burgers] temp** (archetype: burger, blocking: true, priority: 24, items affected: 6)
  - Q: Do customers pick a temperature on Burgers?
  - Proposed choices: Rare, Medium rare, Medium, Medium well, Well done
- **[Baskets & Gyros] bread** (archetype: sandwich, blocking: true, priority: 16, items affected: 4)
  - Q: Do customers pick a bread on Baskets & Gyros?
  - Proposed choices: (none — owner must supply)

### §8.2 invariants

FAIL — inv 1: No item in an active category is blocked (57 violation(s): 0376e784-5ebd-4f82-aaff-2afe5cf3b36d (Tuna Provolone Wrap); 0ef7ebce-7a54-430d-bc4d-5bbd25dcde98 (Veggie Panini); 11219b2d-2a0d-43ff-842d-580a3de8010d (Italian Hot Dog Sub); 186544e3-c68c-4371-903f-b49c4b9e5958 (Chicken Cheesesteak Sub); 215d053b-a76e-4887-9972-b1347dd09014 (Chicken Parmigiana Sub), ...)
PASS — inv 2: Every orderable item has display_name, ask_plan, price_cents>0, confirmed price_provenance
PASS — inv 3: No two orderable items share the same display_name
FAIL — inv 4: Every orderable item has ≥1 active lexicon term resolving uniquely to it (3 violation(s): 3b8bb511-06d3-4c24-8858-632ecb412ca9; 6206f66f-a57c-4784-8e56-51e7e9e6aae4; 6c441560-c56c-4024-8875-04c2815c3cc2)
PASS — inv 5: Every group on an orderable item satisfies slot/min/max/choice/provenance rules
PASS — inv 6: Every default_choice_id references an active choice in its own group
PASS — inv 7: No active choice has provenance 'inferred'
FAIL — inv 8: orderable/active ratio ≥ 0.9 or owner-acknowledged (actual: 74.1%, acknowledged: false) (1 violation(s): ratio 74.1% < 90%, not acknowledged)

### Ten real ask_plans

**Plain Pan Pizza** [Pizza] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Plain Pan Pizza",
  "base_price_cents": 1999,
  "steps": [
    {
      "group_id": "7ed6493a-ae58-4a0a-ba8a-a719737ce0d7",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "650e83c8-efa5-4d81-9207-60fbab491ed2",
          "display": "18''",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Chocolate Caramel Cake** [Desserts] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Chocolate Caramel Cake",
  "base_price_cents": 575,
  "steps": [
    {
      "group_id": "b14ecad2-fb13-439d-80a3-f008a6c63118",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "dbae1df8-9f31-4a3a-b452-73f09994d126",
          "display": "Dessert",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Cheese Fries** [Side Orders] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Cheese Fries",
  "base_price_cents": 799,
  "steps": [
    {
      "group_id": "2d36a0e4-b4bb-4930-aeab-c08987399bff",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "3a85fe84-fe41-4a8d-bc9c-665b0e0111e1",
          "display": "Side Orders",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Garden Salad** [Salads] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Garden Salad",
  "base_price_cents": 799,
  "steps": [
    {
      "group_id": "9b41cb70-a5d5-4976-bbd9-7bc621cec3e1",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "a3aa6f97-5df6-4ea6-91b0-92465b30f286",
          "display": "Salad",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Bruschetta** [Appetizers] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Bruschetta",
  "base_price_cents": 799,
  "steps": [
    {
      "group_id": "afa06961-c504-4c37-bcad-c6838fb3cb00",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "81af17ee-fdd8-4245-ac8e-8d3729c8f9de",
          "display": "Appetizer",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Baked Ziti** [Baked Dishes] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Baked Ziti",
  "base_price_cents": 1699,
  "steps": [
    {
      "group_id": "da653597-1dbc-4fa1-9007-42e76d5d6485",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "17416fd3-d762-4084-beda-cf4529750780",
          "display": "Pasta",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Pasta Pomodoro** [Pasta] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Pasta Pomodoro",
  "base_price_cents": 1499,
  "steps": [
    {
      "group_id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0",
      "slot_key": "choice",
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choice.ask",
      "choices": [
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:0",
          "display": "Pasta: Spaghetti",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:1",
          "display": "Linguine",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:2",
          "display": "Penne",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:3",
          "display": "Rigatoni",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:4",
          "display": "Angel Hair",
          "price_delta_cents": 0
        },
        {
          "id": "derived:1ad97d10-b919-4b8c-8816-c46484219810:0:5",
          "display": "Fettuccine",
          "price_delta_cents": 0
        }
      ]
    },
    {
      "group_id": "3cd95a91-11c5-4ec6-afdc-2ffde199bfe6",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choose_pasta.ask",
      "choices": [
        {
          "id": "0c0c355c-9c08-40a8-962f-784ec2da81a4",
          "display": "Angel Hair",
          "price_delta_cents": 0
        },
        {
          "id": "17d040bc-28a5-4200-baf6-6b5f5f18030d",
          "display": "Rigatoni",
          "price_delta_cents": 0
        },
        {
          "id": "367380fa-2191-4491-bf38-c36f3246d6dd",
          "display": "Penne",
          "price_delta_cents": 0
        },
        {
          "id": "4210f478-58f1-4435-bdcd-fdc535e4409f",
          "display": "Spaghetti",
          "price_delta_cents": 0
        },
        {
          "id": "8f0299ad-ea50-459a-a568-2b4433377044",
          "display": "Linguine",
          "price_delta_cents": 0
        },
        {
          "id": "e02b1013-d7d5-45b7-9506-291d19ccaea6",
          "display": "Fettuccine",
          "price_delta_cents": 0
        }
      ]
    },
    {
      "group_id": "b7224c4a-8c50-4fc5-bef9-d9cdfd929105",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "5fcb9022-f9cb-4946-930c-af26735ef0e8",
          "display": "Pasta",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Ricotta & Mozzarella Calzone** [Calzones & Strombolis] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Ricotta & Mozzarella Calzone",
  "base_price_cents": 1699,
  "steps": [
    {
      "group_id": "61cb1ecf-6749-416c-9fff-37377d6e1d3f",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "ask",
      "prompt_template": "choose_an_option.ask",
      "choices": [
        {
          "id": "a8a06e69-92c7-4633-b58d-184486e8449c",
          "display": "Small",
          "price_delta_cents": 0
        },
        {
          "id": "b31940fa-a5df-43fa-b376-8102ee34ab5e",
          "display": "Family",
          "price_delta_cents": 600
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Shrimp With Vodka Sauce** [Seafood] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Shrimp With Vodka Sauce",
  "base_price_cents": 2099,
  "steps": [
    {
      "group_id": "5b51d270-4ed8-46e7-a50c-e66237a2f22e",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "78682123-eb3d-4d37-8b45-b22aab6a0b43",
          "display": "Entree",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

**Pasta Fagioli** [Soup] — bot_state: orderable
```json
{
  "compiled_at": "2026-09-07T19:56:31.463Z",
  "compiler_version": 1,
  "display_name": "Pasta Fagioli",
  "base_price_cents": 599,
  "steps": [
    {
      "group_id": "46e03d2a-4a74-4072-8c04-e22033c12877",
      "slot_key": null,
      "kind": "slot",
      "ask_mode": "auto_single",
      "prompt_template": "choose_an_option.auto_single",
      "choices": [
        {
          "id": "2eb093cc-c667-4408-89c1-2b003194f71a",
          "display": "Soup",
          "price_delta_cents": 0
        }
      ]
    }
  ],
  "recap_template": "{qty} {display_name}{, with {modifiers}}",
  "ticket_template": "{name}{\n  + {choice.display} x{qty}}"
}
```

