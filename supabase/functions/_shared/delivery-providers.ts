// _shared/delivery-providers.ts — name → provider. The only file that knows every adapter.
// test=true picks the provider's sandbox credentials (carts with test_mode=true).
import type { DeliveryProvider, DeliveryProviderName } from "./delivery.ts";
import { makeUberProvider, uberConfigFromEnv, uberWebhookVerifiers } from "./uber.ts";
import { doordashConfigFromEnv, makeDoorDashProvider } from "./doordash.ts";

type Factory = (test: boolean) => DeliveryProvider | null;

const REGISTRY: Partial<Record<DeliveryProviderName, Factory>> = {
  uber: (test) => { const c = uberConfigFromEnv(test); return c ? makeUberProvider(c) : null; },
  doordash: (test) => { const c = doordashConfigFromEnv(test); return c ? makeDoorDashProvider(c) : null; },
};

/** null when the provider is unknown or its credentials are not configured */
export function providerFor(name: string | null | undefined, test: boolean): DeliveryProvider | null {
  const f = name ? REGISTRY[name as DeliveryProviderName] : undefined;
  return f ? f(test) : null;
}

/**
 * Every configured credential set for a provider, live first. A webhook cannot tell test from live
 * before its signature is checked (DoorDash signs each with its own secret), so the webhook tries each.
 */
export function providersForWebhook(name: string): DeliveryProvider[] {
  if (name === "uber") return uberWebhookVerifiers(); // Uber: one signing key per environment, no client credentials needed
  return [providerFor(name, false), providerFor(name, true)].filter((p): p is DeliveryProvider => p !== null);
}

/** "own" and anything unrecognized mean the shop delivers itself */
export function isCourierProvider(name: string | null | undefined): name is DeliveryProviderName {
  return name === "uber" || name === "doordash";
}
