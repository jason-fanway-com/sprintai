// _shared/delivery.ts — the one interface every delivery provider implements
// (Uber Direct in uber.ts, DoorDash Drive in doordash.ts). Callers
// (chat-sms runner, stripe-webhook, refund-order, delivery-webhook) only ever
// see these types; provider quirks stay inside the adapter.
//
// Money is integer cents. Times are ISO-8601 strings. Statuses are normalized
// to DeliveryStatus so the admin view and order_carts.delivery_status read
// the same whichever provider carried the order.
//
// STABLE CONTRACT: the Uber and DoorDash threads build against this file.
// Change it only additively, and say so in the project chat.

export type DeliveryProviderName = "uber" | "doordash";
/** shops.delivery_provider: "own" is the shop's own driver and flat fee (today's behavior) */
export type ShopDeliveryProvider = "own" | DeliveryProviderName;

/** normalized lifecycle; each adapter maps its provider's statuses onto these */
export type DeliveryStatus =
  | "quoted"
  | "created" // booked, no courier yet
  | "courier_assigned"
  | "picked_up"
  | "dropped_off" // delivered
  | "canceled"
  | "returned"
  | "unknown";

export interface Place {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  phone: string; // E.164
  notes: string | null;
}

export interface Courier {
  name: string;
  phone: string | null;
}

export interface DeliveryQuote {
  provider: DeliveryProviderName;
  quote_id: string;
  fee_cents: number;
  expires_at: string;
  eta_min: number | null;
  raw: unknown;
}

export type QuoteErrorCode = "out_of_range" | "unavailable" | "bad_address" | "provider";
export interface QuoteError {
  error: string;
  code: QuoteErrorCode;
}

export interface QuoteRequest {
  pickup: Place;
  dropoff: Place;
  order_value_cents: number;
  /** our id for the order (the cart id); providers echo it back */
  external_id: string;
}

export interface CreateRequest {
  quote: DeliveryQuote;
  pickup: Place;
  dropoff: Place;
  items: Array<{ name: string; qty: number }>;
  /** passed to the courier in full */
  tip_cents: number;
  dropoff_notes: string | null;
  /** when the food is ready; the provider schedules pickup from it */
  pickup_ready_at: string;
  external_id: string;
  /** order value for the provider's manifest/insurance; defaults to 0 when omitted */
  order_value_cents?: number;
}

export interface CreateResult {
  delivery_id: string;
  tracking_url: string | null;
  status: DeliveryStatus;
  fee_cents: number;
  raw?: unknown;
}

export interface CancelResult {
  ok: boolean;
  /** what the provider still charges us after the cancel (0 when free) */
  fee_cents: number;
}

export interface GetResult {
  status: DeliveryStatus;
  courier?: Courier;
  tracking_url: string | null;
  raw?: unknown;
}

export interface WebhookEvent {
  delivery_id: string;
  status: DeliveryStatus;
  /** the provider's own status string, kept for the events log */
  provider_status: string;
  at: string;
  courier?: Courier;
  tracking_url?: string | null;
  /** our external_id when the provider echoes it */
  external_id?: string | null;
}

export interface DeliveryProvider {
  readonly name: DeliveryProviderName;
  quote(req: QuoteRequest): Promise<DeliveryQuote | QuoteError>;
  create(req: CreateRequest): Promise<CreateResult>;
  cancel(delivery_id: string): Promise<CancelResult>;
  get(delivery_id: string): Promise<GetResult>;
  /** checks the signature on the raw body; ok=false means reject (401). event=null with ok=true means a valid event we ignore */
  verifyWebhook(req: Request): Promise<{ ok: boolean; event: WebhookEvent | null }>;
}

/** providers take E.164 only; a web test conversation's "web:<session>" is not a phone number */
export function e164OrNull(p: string | null | undefined): string | null {
  return p && /^\+[1-9]\d{9,14}$/.test(p) ? p : null;
}

export function isQuoteError(q: DeliveryQuote | QuoteError): q is QuoteError {
  return (q as QuoteError).error !== undefined;
}

/** statuses after which nothing more happens */
export function isTerminal(s: DeliveryStatus): boolean {
  return s === "dropped_off" || s === "canceled" || s === "returned";
}

/** a later webhook must not move a delivery backwards (webhooks arrive out of order) */
const RANK: Record<DeliveryStatus, number> = {
  unknown: 0, quoted: 1, created: 2, courier_assigned: 3, picked_up: 4, dropped_off: 5, canceled: 5, returned: 5,
};
export function isForward(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (isTerminal(from)) return false;
  return RANK[to] >= RANK[from];
}
