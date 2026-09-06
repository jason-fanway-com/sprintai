# Item L — PROVE demo kit (3 codes)

Measured 2026-09-06 by OrderFare. Method: no phone camera available, so each code was
driven through its **real generator** and decoded with an independent decoder
(OpenCV `QRCodeDetector`). A known-good QR from `api.qrserver.com` was decoded first as a
control to prove the decode pipeline works before any code was called broken.

## What "the demo kit" actually is

Two competing artifacts exist. This matters more than either bug.

| Artifact | Reachable at | QR generator | Codes decode? |
|---|---|---|---|
| `/admin/demo-kit?shop=vitos-pizza` — what Erin's email links to | login-gated SPA route | `qrcode.react` 4.2.0 (vetted) | **YES — all 3** |
| `vitos-demo.html` — public page, in the build allowlist | `getsprintai.com/vitos-demo.html` (live, unlinked) | hand-rolled encoder in the page | **NO — all 3** |

## Finding L-1 — `vitos-demo.html` ships three QR codes that cannot be scanned (LIVE)

The page contains a hand-written QR encoder (`drawQR`). Its own comments admit it is
partial: format-info bits are "simplified for visual rendering" and never written, the
mask is hardcoded to 0 with nothing recording that choice, alignment patterns are never
placed (required for every version ≥ 2), and `versionForData` sizes the symbol against a
raw data-codeword table with a flat `overhead = 2`, ignoring ECC codewords entirely.

The output looks like a QR code and is not one.

Evidence — the page's own encoder was executed with the live served script, the canvas
draw calls captured, the module grid reconstructed exactly, and decoded:

```
control (api.qrserver.com)  -> DECODED 'sms:+14842018054'
qr1  sms:+14842018054       25x25, 286 dark modules  -> FAILED to decode
qr2  vCard                  53x53, 1322 dark modules -> FAILED to decode
qr3  admin URL              -> not even attempted: renders the grey "(set number)" placeholder
```

**Sub-finding: qr3 is a placeholder box on every load.** `makeQr()` guards with
`if (data === DEMO_NUMBER || data === ADMIN_URL)` to detect unswapped tokens — but
`makeQr('qr3', ADMIN_URL)` passes exactly that value, so the guard always fires. The third
code on the page is a grey square reading "QR Code / (set number)".

## Finding L-2 — the kit email's main CTA is a login wall

`docs/demo/erin-vitos-demo-email.html` sends Erin to
`https://getsprintai.com/admin/demo-kit?shop=vitos-pizza` and tells her "All three QR codes
live here". That route is wrapped in `ShopOwnerRoute` (`admin-dashboard/src/App.tsx:148`) —
it requires an authenticated `shop_owner`/superadmin session. A salesperson without a
login sees an auth wall, not a demo kit. **Open question for Jason: does Erin have
credentials?** If yes, L-2 is a non-issue and the kit works. If no, the kit is unusable
by the person it was written for.

## Finding L-3 — the destinations themselves are sound

All three payload destinations return 200 live: `/admin/shop-owner?shop=vitos-pizza`,
`/chat/`, `/signup-page/`. The `sms:` target `+14842018054` is Vito's = Jason's iPhone via
the iMessage bridge, which is intentional per the demo-shop record. The NJB kit
(`erin-njb-demo-email.html`) generates its codes through `api.qrserver.com` and its
payloads are correct (`sms:+16103792553`, `/chat/`, `/signup-page/`).

## Not covered

The physical scan on a real phone camera, and the human walk of the ordering flow the
codes lead into. Decoding proves the symbol is valid and carries the right payload; it
does not prove the demo *lands* well. That leg stays Jason's.

## Recommended cure

Decide first whether `vitos-demo.html` should exist at all — nothing links to it, and a
second public demo page that can drift from the shop record is the same duplicate-artifact
risk that already produced a dead number (58e7646). Either:

- **Delete it** and drop it from `scripts/build-public-site.sh`, leaving `/admin/demo-kit`
  as the single kit; or
- **Keep it public and fix it**: replace the hand-rolled encoder with the same vetted
  generator, pre-rendered at build time from the shop record so the public page needs no
  login and cannot go stale.

Do not patch the hand-rolled encoder. Re-deriving a correct QR implementation by hand is
work with a known-good library sitting in the repo already.
