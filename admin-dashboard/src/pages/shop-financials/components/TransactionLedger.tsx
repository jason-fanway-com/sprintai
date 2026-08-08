import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronUp, ChevronDown, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { getAuthHeaders } from "../../../lib/supabase";

const SHOP_FINANCIALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shop-financials`;

interface LedgerOrder {
  id: string;
  created_at: string;
  order_number: number | null;
  order_type: string;
  payment_status: string;
  subtotal: string;
  tax: string;
  total: string;
  delivery_fee: string;
  driver_tip: string;
  service_fee: string;
  refunded: string;
  estimated_stripe_fee: string;
  net: string;
  pickup_name: string | null;
  customer_phone: string | null;
  test_mode: boolean;
}

interface LedgerResponse {
  orders: LedgerOrder[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  fees_estimated: boolean;
}

interface TransactionLedgerProps {
  shopId: string;
  dateRange: { from: string; to: string };
}

type SortField = "created_at" | "order_number" | "order_type" | "total_cents" | "driver_tip_cents" | "payment_status";

function SortIcon({ field, currentField, dir }: { field: SortField; currentField: SortField; dir: string }) {
  if (field !== currentField) return <ChevronDown className="w-3 h-3 text-gray-300" />;
  return dir === "asc" ? <ChevronUp className="w-3 h-3 text-brand-600" /> : <ChevronDown className="w-3 h-3 text-brand-600" />;
}

export function TransactionLedger({ shopId, dateRange }: TransactionLedgerProps) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortField>("created_at");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [orderTypeFilter, setOrderTypeFilter] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("");

  const { data, isLoading, error } = useQuery<LedgerResponse>({
    queryKey: [
      "shop-financials-ledger",
      shopId,
      dateRange.from,
      dateRange.to,
      page,
      sort,
      dir,
      search,
      orderTypeFilter,
      paymentStatusFilter,
    ],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({
        from: dateRange.from,
        to: dateRange.to,
        page: String(page),
        page_size: "50",
        sort,
        dir,
      });
      if (search) params.set("search", search);
      if (orderTypeFilter) params.set("order_type", orderTypeFilter);
      if (paymentStatusFilter) params.set("payment_status", paymentStatusFilter);

      const res = await fetch(
        `${SHOP_FINANCIALS_URL}/${shopId}/ledger?${params}`,
        { headers }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "Failed to fetch ledger");
      }
      return res.json();
    },
    enabled: !!shopId,
  });

  function handleSort(field: SortField) {
    if (field === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setDir("desc");
    }
    setPage(1);
  }

  function handleSearch() {
    setSearch(searchInput.trim());
    setPage(1);
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  function maskPhone(phone: string | null): string {
    if (!phone) return "";
    if (phone.length >= 4) return `…${phone.slice(-4)}`;
    return phone;
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-1">
          <input
            type="text"
            placeholder="Search order # or name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-48"
          />
          <button
            onClick={handleSearch}
            className="p-1.5 text-gray-500 hover:text-brand-600"
          >
            <Search className="w-4 h-4" />
          </button>
        </div>
        <select
          value={orderTypeFilter}
          onChange={(e) => { setOrderTypeFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
        >
          <option value="">All Types</option>
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
        <select
          value={paymentStatusFilter}
          onChange={(e) => { setPaymentStatusFilter(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
        {data?.fees_estimated && (
          <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-amber-100 text-amber-800 rounded">
            Fees estimated
          </span>
        )}
        {data && (
          <span className="text-xs text-gray-400 self-center ml-auto">
            {data.total} transaction{data.total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="animate-pulse p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-6 bg-gray-100 rounded" />
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-500 mb-4">
          Failed to load transactions.
        </div>
      )}

      {/* Empty state */}
      {data && data.orders.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg font-medium">No transactions in this period.</p>
          <p className="text-sm mt-1">Try a different date range or clear your filters.</p>
        </div>
      )}

      {/* Table */}
      {data && data.orders.length > 0 && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <Th
                    label="Date"
                    field="created_at"
                    sort={sort}
                    dir={dir}
                    onSort={handleSort}
                  />
                  <Th
                    label="Order #"
                    field="order_number"
                    sort={sort}
                    dir={dir}
                    onSort={handleSort}
                  />
                  <Th
                    label="Type"
                    field="order_type"
                    sort={sort}
                    dir={dir}
                    onSort={handleSort}
                  />
                  <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">
                    Customer
                  </th>
                  <Th
                    label="Gross"
                    field="total_cents"
                    sort={sort}
                    dir={dir}
                    onSort={handleSort}
                  />
                  <Th
                    label="Tip"
                    field="driver_tip_cents"
                    sort={sort}
                    dir={dir}
                    onSort={handleSort}
                  />
                  <th className="text-right px-3 py-2 font-medium text-gray-500 text-xs">
                    Fee
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-gray-500 text-xs">
                    Net
                  </th>
                  <Th
                    label="Status"
                    field="payment_status"
                    sort={sort}
                    dir={dir}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-xs text-gray-900">
                        {formatDate(order.created_at)}
                      </div>
                      <div className="text-xs text-gray-400">
                        {formatTime(order.created_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                      {order.order_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs capitalize">
                      {order.order_type}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">
                      {order.pickup_name ?? maskPhone(order.customer_phone) ?? "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right text-xs font-medium">
                      ${order.total}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right text-xs">
                      ${order.driver_tip}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right text-xs text-gray-400">
                      -${order.estimated_stripe_fee}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right text-xs font-medium text-green-700">
                      ${order.net}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-flex px-1.5 py-0.5 text-xs rounded-full ${
                          order.payment_status === "paid"
                            ? "bg-green-100 text-green-700"
                            : order.payment_status === "failed"
                            ? "bg-red-100 text-red-700"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {order.payment_status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.total_pages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-gray-500">
                Page {data.page} of {data.total_pages}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="p-1.5 rounded border border-gray-200 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(data.total_pages, p + 1))}
                  disabled={page >= data.total_pages}
                  className="p-1.5 rounded border border-gray-200 disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Th({
  label,
  field,
  sort,
  dir,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: SortField;
  dir: string;
  onSort: (f: SortField) => void;
}) {
  const isRight = ["total_cents", "driver_tip_cents"].includes(field);
  return (
    <th
      className={`px-3 py-2 font-medium text-gray-500 text-xs cursor-pointer hover:text-gray-700 select-none ${
        isRight ? "text-right" : "text-left"
      }`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <SortIcon field={field} currentField={sort} dir={dir} />
      </span>
    </th>
  );
}