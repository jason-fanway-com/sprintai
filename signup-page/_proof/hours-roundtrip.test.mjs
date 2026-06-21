/**
 * FIX 2 tests — shop hours capture + diner-bot "are we open?" logic.
 *
 * Part A: round-trips the wizard's hours editor model <-> the canonical stored
 *         shape (open_hours = { mon: [{open,close}], ... }), and verifies
 *         closed-day handling (closed day => omitted, read back as closed).
 * Part B: reproduces the diner bot's "are we open?" decision (timezone-aware
 *         day key + local minutes + window check) and asserts it at known times,
 *         including the near-midnight UTC-vs-local-day bug this fix closes.
 *
 * These mirror the exact logic in signup-page/wizard.js (editorModelToHours /
 * hoursToEditorModel) and supabase/functions/chat-sms/index.ts
 * (getBusinessDayKey / getLocalMinutes / isOpen). Kept as a standalone harness
 * so the menu portion is provable without a browser or live DB.
 *
 * Run: node signup-page/_proof/hours-roundtrip.test.mjs
 */

let fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  — got ${g}, want ${w}`}`);
  if (!ok) fail++;
};
const check = (label, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!cond) fail++;
};

const HOURS_DAYS = [["mon"],["tue"],["wed"],["thu"],["fri"],["sat"],["sun"]];

// ── wizard.js logic (mirrored) ───────────────────────────────────────────────
function hoursToEditorModel(openHours) {
  const hasAny = openHours && Object.keys(openHours).length > 0;
  const model = {};
  HOURS_DAYS.forEach((d) => {
    const key = d[0];
    const windows = (openHours && openHours[key]) || [];
    if (windows.length > 0) model[key] = { closed: false, open: windows[0].open || "11:00", close: windows[0].close || "21:00" };
    else if (hasAny)        model[key] = { closed: true,  open: "11:00", close: "21:00" };
    else                    model[key] = { closed: false, open: "11:00", close: "21:00" };
  });
  return model;
}
function editorModelToHours(model) {
  const out = {};
  HOURS_DAYS.forEach((d) => {
    const key = d[0]; const row = model[key];
    if (row && !row.closed && row.open && row.close) out[key] = [{ open: row.open, close: row.close }];
  });
  return out;
}

console.log("=== FIX 2A — hours round-trip + closed-day handling ===\n");

// 1) A realistic week: closed Monday, weekdays 11-21, weekends 11-22.
const ownerEntered = {
  mon: { closed: true,  open: "11:00", close: "21:00" },
  tue: { closed: false, open: "11:00", close: "21:00" },
  wed: { closed: false, open: "11:00", close: "21:00" },
  thu: { closed: false, open: "11:00", close: "21:00" },
  fri: { closed: false, open: "11:00", close: "21:00" },
  sat: { closed: false, open: "11:00", close: "22:00" },
  sun: { closed: false, open: "11:00", close: "22:00" },
};
const stored = editorModelToHours(ownerEntered);
eq("stored shape: Monday omitted (closed), others present", stored, {
  tue: [{ open: "11:00", close: "21:00" }],
  wed: [{ open: "11:00", close: "21:00" }],
  thu: [{ open: "11:00", close: "21:00" }],
  fri: [{ open: "11:00", close: "21:00" }],
  sat: [{ open: "11:00", close: "22:00" }],
  sun: [{ open: "11:00", close: "22:00" }],
});
check("closed day has NO window in stored shape (bot reads as closed)", !("mon" in stored));

// 2) round-trip: store -> read back into editor -> Monday reads as closed.
const rehydrated = hoursToEditorModel(stored);
check("round-trip: Monday rehydrates as closed", rehydrated.mon.closed === true);
check("round-trip: Saturday rehydrates open with 22:00 close",
  rehydrated.sat.closed === false && rehydrated.sat.close === "22:00", JSON.stringify(rehydrated.sat));
eq("round-trip is stable (store(read(store)) === store)", editorModelToHours(rehydrated), stored);

// 3) brand-new shop (no open_hours yet): every day defaults open, owner can edit.
const fresh = hoursToEditorModel({});
check("fresh shop: every day defaults to open", HOURS_DAYS.every((d) => fresh[d[0]].closed === false));

// ── chat-sms logic (mirrored) ────────────────────────────────────────────────
function getBusinessDayKey(timezone, at) {
  const dayMap = { Sun:"sun", Mon:"mon", Tue:"tue", Wed:"wed", Thu:"thu", Fri:"fri", Sat:"sat" };
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(at);
  return dayMap[wd] ?? wd.slice(0,3).toLowerCase();
}
function getLocalMinutes(timezone, at) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const h = Number(parts.find(p => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find(p => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}
function isOpen(openHours, timezone, at) {
  const key = getBusinessDayKey(timezone, at);
  const windows = openHours?.[key] ?? [];
  const nowMins = getLocalMinutes(timezone, at);
  return windows.some((w) => {
    const [oh, om] = w.open.split(":").map(Number);
    const [ch, cm] = w.close.split(":").map(Number);
    return nowMins >= oh*60+om && nowMins < ch*60+cm;
  });
}

console.log("\n=== FIX 2B — diner bot 'are we open?' (timezone-aware) ===\n");

const TZ = "America/New_York";
const hours = stored; // closed Mon, Tue-Fri 11-21, Sat/Sun 11-22

// Tue 2026-06-23 13:00 ET -> open. (ET is UTC-4 in June, so 17:00Z.)
check("Tue 1:00pm ET -> OPEN", isOpen(hours, TZ, new Date("2026-06-23T17:00:00Z")) === true);
// Tue 2026-06-23 22:30 ET -> closed (after 21:00). 02:30Z next day.
check("Tue 10:30pm ET -> CLOSED (after 9pm)", isOpen(hours, TZ, new Date("2026-06-24T02:30:00Z")) === false);
// Mon 2026-06-22 13:00 ET -> closed (Monday omitted). 17:00Z.
check("Mon 1:00pm ET -> CLOSED (closed day)", isOpen(hours, TZ, new Date("2026-06-22T17:00:00Z")) === false);
// Sat 2026-06-27 21:30 ET -> open til 22:00. 01:30Z next day.
check("Sat 9:30pm ET -> OPEN (weekend til 10pm)", isOpen(hours, TZ, new Date("2026-06-28T01:30:00Z")) === true);

// THE BUG THIS FIX CLOSES: Sunday 11:30pm ET is 03:30Z MONDAY.
// Old code used new Date().getDay() (UTC) -> would read MONDAY's hours on a
// Sunday night. Sunday is open till 22:00, Monday is closed. At 11:30pm Sun the
// shop is CLOSED either way, but the DAY KEY must resolve to Sunday, not Monday.
const sunLateUtcMon = new Date("2026-06-29T03:30:00Z"); // 11:30pm Sun 6/28 ET
check("near-midnight: 11:30pm Sun ET resolves day key to 'sun' (not UTC 'mon')",
  getBusinessDayKey(TZ, sunLateUtcMon) === "sun", getBusinessDayKey(TZ, sunLateUtcMon));
// And 9:30pm Sunday (open) must read Sunday's window and be OPEN, even though in
// some zones UTC has rolled to Monday.
const sunEveUtc = new Date("2026-06-29T01:30:00Z"); // 9:30pm Sun 6/28 ET
check("near-midnight: 9:30pm Sun ET -> OPEN via Sunday's window (UTC already Mon)",
  isOpen(hours, TZ, sunEveUtc) === true, "dayKey=" + getBusinessDayKey(TZ, sunEveUtc));

// Multi-window day support (schema allows it): lunch + dinner with a gap.
const multi = { wed: [{ open: "11:00", close: "14:00" }, { open: "17:00", close: "22:00" }] };
check("multi-window: 3:00pm Wed (the gap) -> CLOSED", isOpen(multi, TZ, new Date("2026-06-24T19:00:00Z")) === false);
check("multi-window: 12:30pm Wed (lunch) -> OPEN",   isOpen(multi, TZ, new Date("2026-06-24T16:30:00Z")) === true);
check("multi-window: 6:00pm Wed (dinner) -> OPEN",   isOpen(multi, TZ, new Date("2026-06-24T22:00:00Z")) === true);

console.log("\n=== " + (fail === 0 ? "ALL FIX-2 TESTS PASS ✅" : fail + " FIX-2 TEST(S) FAILED ❌") + " ===");
process.exit(fail === 0 ? 0 : 1);
