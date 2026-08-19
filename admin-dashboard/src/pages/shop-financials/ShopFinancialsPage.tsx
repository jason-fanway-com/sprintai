import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { KPICards } from "./components/KPICards";
import { RevenueChart } from "./components/RevenueChart";
import { TransactionLedger } from "./components/TransactionLedger";
import { ExportButton } from "./components/ExportButton";

function getDefaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().split("T")[0];
  // Last 30 days
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
    .toISOString()
    .split("T")[0];
  return { from, to };
}

type RangePreset = "today" | "week" | "month" | "custom";

interface ShopFinancialsPageProps {
  /** When provided, scope to this shop instead of the URL param (owner embed). */
  shopId?: string;
  /** Hide the "Back to Shop" link + drop the outer padding wrapper (embedded use). */
  embedded?: boolean;
}

export default function ShopFinancialsPage({ shopId, embedded }: ShopFinancialsPageProps = {}) {
  const params = useParams<{ id: string }>();
  const id = shopId ?? params.id;
  const [preset, setPreset] = useState<RangePreset>("month");
  const [customRange, setCustomRange] = useState(getDefaultRange());

  const dateRange = useMemo(() => {
    if (preset === "custom") return customRange;
    const now = new Date();
    const to = now.toISOString().split("T")[0];
    let from: string;
    switch (preset) {
      case "today":
        from = to;
        break;
      case "week":
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
          .toISOString()
          .split("T")[0];
        break;
      case "month":
      default:
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
          .toISOString()
          .split("T")[0];
        break;
    }
    return { from, to };
  }, [preset, customRange]);

  // Fetch shop name
  const { data: shop } = useQuery<{ name: string }>({
    queryKey: ["shop-financials-name", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shops")
        .select("name")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  if (!id) {
    return <div className="p-8 text-gray-500">No shop specified.</div>;
  }

  const presets: Array<{ id: RangePreset; label: string }> = [
    { id: "today", label: "Today" },
    { id: "week", label: "This Week" },
    { id: "month", label: "Last 30 Days" },
    { id: "custom", label: "Custom" },
  ];

  return (
    <div className={embedded ? "" : "p-4 sm:p-8 max-w-6xl mx-auto"}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          {!embedded && (
            <Link
              to={`/shops/${id}`}
              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-1"
            >
              <ArrowLeft className="w-3 h-3" />
              Back to Shop
            </Link>
          )}
          <h1 className="text-xl font-bold text-gray-900">
            {embedded ? "Financial Reporting" : `Financials${shop ? `: ${shop.name}` : ""}`}
          </h1>
        </div>
        <ExportButton shopId={id} dateRange={dateRange} />
      </div>

      {/* Date Range Presets */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              preset === p.id
                ? "bg-brand-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {p.label}
          </button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customRange.from}
              onChange={(e) =>
                setCustomRange((r) => ({ ...r, from: e.target.value }))
              }
              className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
            <span className="text-gray-400 text-sm">to</span>
            <input
              type="date"
              value={customRange.to}
              onChange={(e) =>
                setCustomRange((r) => ({ ...r, to: e.target.value }))
              }
              className="border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        )}
      </div>

      {/* KPI Cards */}
      <KPICards shopId={id} dateRange={dateRange} />

      {/* Revenue Chart */}
      <RevenueChart shopId={id} dateRange={dateRange} />

      {/* Transaction Ledger */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Transactions
        </h2>
        <TransactionLedger shopId={id} dateRange={dateRange} />
      </div>
    </div>
  );
}