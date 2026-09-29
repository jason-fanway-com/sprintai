// doordash-record.ts — record real DoorDash Drive SANDBOX responses into the test fixtures.
// Sandbox only (DOORDASH_* keys); simulated Dashers, no charge. Needs the three sandbox
// secrets in the environment; prints no secrets.
//
// usage: deno run --allow-env --allow-net --allow-write=supabase/functions/_shared/fixtures/doordash \
//          scripts/delivery/doordash-record.ts "<pickup address>" "<pickup phone E.164>" "<dropoff address>" "<dropoff phone E.164>"
//
// Then re-run supabase/functions/_shared/doordash.test.ts and compare the fixture diffs.

import { DOORDASH_BASE_URL, doordashConfigFromEnv, doordashJwt } from "../../supabase/functions/_shared/doordash.ts";

const [pickupAddress, pickupPhone, dropoffAddress, dropoffPhone] = Deno.args;
if (!dropoffPhone) {
  console.error("usage: doordash-record.ts <pickup address> <pickup phone> <dropoff address> <dropoff phone>");
  Deno.exit(2);
}
const cfg = doordashConfigFromEnv(true);
if (!cfg) {
  console.error("DOORDASH_DEVELOPER_ID / DOORDASH_KEY_ID / DOORDASH_SIGNING_SECRET not set");
  Deno.exit(2);
}
const OUT = new URL("../../supabase/functions/_shared/fixtures/doordash/", import.meta.url);

async function call(name: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${DOORDASH_BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await doordashJwt(cfg!, Date.now())}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  await Deno.writeTextFile(new URL(`recorded-${name}.json`, OUT), JSON.stringify(json, null, 2) + "\n");
  console.log(`${name}: HTTP ${res.status}  status=${json?.delivery_status ?? json?.code ?? "-"}  fee=${json?.fee ?? "-"}`);
  return json;
}

const id = `record-${Date.now().toString(36)}`;
const place = {
  pickup_address: pickupAddress,
  pickup_business_name: "OrderFare sandbox",
  pickup_phone_number: pickupPhone,
  dropoff_address: dropoffAddress,
  dropoff_phone_number: dropoffPhone,
  dropoff_contact_given_name: "Test",
};
await call("quote", "POST", "/drive/v2/quotes", { external_delivery_id: id, ...place, order_value: 2500 });
await call("accept", "POST", `/drive/v2/quotes/${id}/accept`, { tip: 300 });
await call("get", "GET", `/drive/v2/deliveries/${id}`);
await call("cancel", "PUT", `/drive/v2/deliveries/${id}/cancel`);
await call("error-far", "POST", "/drive/v2/quotes", {
  external_delivery_id: `${id}-far`,
  ...place,
  dropoff_address: "1600 Pennsylvania Ave NW, Washington, DC 20500",
  order_value: 2500,
});
console.log(`wrote recorded-*.json to ${OUT.pathname}`);
