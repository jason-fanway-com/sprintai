// delivery-probe.ts — ask Uber Direct (test credentials) for quotes from Vito's to a few addresses and
// print fee / eta / error code. No engine, no database, no delivery is booked.
//
//   deno run --allow-net --allow-env scripts/engine/delivery-probe.ts [dropoff address ...]
//
// Needs UBER_DIRECT_CUSTOMER_ID / UBER_DIRECT_CLIENT_ID / UBER_DIRECT_CLIENT_SECRET in the environment
// (the test set). Credentials are never printed.
import { makeUberProvider, uberConfigFromEnv } from "../../supabase/functions/_shared/uber.ts";
import { isQuoteError, type Place } from "../../supabase/functions/_shared/delivery.ts";

const VITOS: Place = {
  name: "Vito's Pizza", address: "5620 Cetronia Rd, Allentown, PA 18106, USA", lat: null, lng: null,
  phone: Deno.env.get("PROBE_PICKUP_PHONE") ?? "+14845550100", notes: null,
};
const DEFAULT_DROPOFFS = [
  "1200 Hamilton Blvd, Allentown, PA 18102, USA", // ~4 mi, should quote
  "7535 Airport Rd, Bath, PA 18014, USA", // farther out
  "1 Liberty Pl, Philadelphia, PA 19103, USA", // ~55 mi, should be out of range
];

const cfg = uberConfigFromEnv(true);
if (!cfg) {
  console.error("missing UBER_DIRECT_CUSTOMER_ID / UBER_DIRECT_CLIENT_ID / UBER_DIRECT_CLIENT_SECRET in the environment");
  Deno.exit(2);
}
const uber = makeUberProvider(cfg);
const dropoffs = Deno.args.length > 0 ? Deno.args : DEFAULT_DROPOFFS;
for (const address of dropoffs) {
  const t0 = Date.now();
  const q = await uber.quote({
    pickup: VITOS,
    dropoff: { name: "Probe", address, lat: null, lng: null, phone: "+14845550199", notes: null },
    order_value_cents: 2500, external_id: `probe-${Date.now()}`,
  });
  const ms = Date.now() - t0;
  if (isQuoteError(q)) console.log(`${address}\n  NO QUOTE  code=${q.code}  ${q.error}  (${ms} ms)`);
  else console.log(`${address}\n  fee $${(q.fee_cents / 100).toFixed(2)}  eta ${q.eta_min ?? "?"} min  expires ${q.expires_at}  quote ${q.quote_id}  (${ms} ms)`);
}
