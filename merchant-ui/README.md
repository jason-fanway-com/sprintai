# SprintAI Merchant UI — Sold-Out Toggle Interface

## What Is This
A standalone, mobile-first web page that restaurant shop owners access to mark menu items as sold out or back in stock. NOT behind the admin login -- this is customer-facing for the shop owner.

## Access
- URL: /m/{shop-slug} (e.g., sprintai.com/m/not-just-bagels)
- Auth: magic link sent to shop owner email, 12-hour session cookie
- No password, no signup flow -- just email, click link, you are in

## UI (Mobile-First, Single Screen)
- Header: Shop name, "N items sold out today" badge
- Body: scrollable list of ALL menu items grouped by category
- Each row: item name, price, green/red toggle (available vs sold out)
- Toggle tap: immediate backend write (optimistic UI, under 500ms perceived)
- Top actions: "Reset All" button (marks everything available)
- Footer: "Pause Online Ordering" big red button

## Behavior
- Sold-out toggles write to availability_overrides table (business_date = today)
- Auto-reset at shop configured opening time each day
- Pause button sets shops.is_paused = true, all inbound orders get "not taking orders right now" message
- Works offline: queues toggle writes, syncs when connection returns

## Tech
- Static HTML/CSS/JS -- no build step, no React, no framework
- Hosted on same Netlify deploy as admin dashboard OR as separate /m/ route
- Calls Supabase REST API directly with the magic link JWT
- Responsive: looks great on iPhone SE through iPad

## Design
- Clean, large touch targets (min 44px)
- Category headers sticky on scroll
- Sold-out items show red left border + strikethrough price
- Available items show green left border
- Big friendly toggle switches, not tiny checkboxes
