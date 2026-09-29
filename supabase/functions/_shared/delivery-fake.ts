// _shared/delivery-fake.ts — an in-memory DeliveryProvider for tests. No network.
// Records every call so tests can assert what would have been sent to the provider.
import type {
  CancelResult, CreateRequest, CreateResult, DeliveryProvider, DeliveryProviderName, DeliveryQuote, DeliveryStatus,
  GetResult, QuoteError, QuoteRequest, WebhookEvent,
} from "./delivery.ts";

export interface FakeOptions {
  name?: DeliveryProviderName;
  fee_cents?: number;
  /** quote answers with this error instead */
  quoteError?: QuoteError;
  /** create throws */
  createFails?: boolean;
  /** webhook requests must carry this header value in x-fake-signature */
  webhookSecret?: string;
}

export interface FakeProvider extends DeliveryProvider {
  calls: Array<{ op: "quote" | "create" | "cancel" | "get"; req: unknown }>;
  deliveries: Map<string, { status: DeliveryStatus; req: CreateRequest }>;
  /** move a delivery along, as the courier would */
  advance(delivery_id: string, status: DeliveryStatus): void;
}

export function makeFakeProvider(opts: FakeOptions = {}): FakeProvider {
  const name = opts.name ?? "uber";
  const calls: FakeProvider["calls"] = [];
  const deliveries: FakeProvider["deliveries"] = new Map();
  let n = 0;
  return {
    name, calls, deliveries,
    advance(id, status) { const d = deliveries.get(id); if (d) d.status = status; },
    quote(req: QuoteRequest): Promise<DeliveryQuote | QuoteError> {
      calls.push({ op: "quote", req });
      if (opts.quoteError) return Promise.resolve(opts.quoteError);
      return Promise.resolve({ provider: name, quote_id: `fq_${++n}`, fee_cents: opts.fee_cents ?? 699, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), eta_min: 30, raw: null });
    },
    create(req: CreateRequest): Promise<CreateResult> {
      calls.push({ op: "create", req });
      if (opts.createFails) return Promise.reject(new Error("fake create failed"));
      const id = `fd_${++n}`;
      deliveries.set(id, { status: "created", req });
      return Promise.resolve({ delivery_id: id, tracking_url: `https://track.example/${id}`, status: "created", fee_cents: req.quote.fee_cents });
    },
    cancel(id: string): Promise<CancelResult> {
      calls.push({ op: "cancel", req: id });
      const d = deliveries.get(id);
      if (!d || d.status === "dropped_off") return Promise.resolve({ ok: false, fee_cents: 0 });
      const after = d.status === "picked_up";
      d.status = after ? "returned" : "canceled";
      return Promise.resolve({ ok: true, fee_cents: after ? d.req.quote.fee_cents : 0 });
    },
    get(id: string): Promise<GetResult> {
      calls.push({ op: "get", req: id });
      const d = deliveries.get(id);
      return Promise.resolve({ status: d?.status ?? "unknown", tracking_url: d ? `https://track.example/${id}` : null });
    },
    async verifyWebhook(req: Request): Promise<{ ok: boolean; event: WebhookEvent | null }> {
      if (opts.webhookSecret && req.headers.get("x-fake-signature") !== opts.webhookSecret) return { ok: false, event: null };
      try { return { ok: true, event: await req.json() as WebhookEvent }; } catch { return { ok: false, event: null }; }
    },
  };
}
