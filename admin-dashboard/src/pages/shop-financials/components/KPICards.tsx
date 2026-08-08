import { useQuery } from "@tanstack/react-query";
import { getAuthHeaders } from "../../../lib/supabase";

const SHOP_FINANCIALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shop-financials`;

interface Summary {
  order_count: number;
  gross_sales_cents: number;
  gross_sales: string;
  net_revenue_cents: number;
  net_revenue: string;
  total_tips_cents: number;
  total_tips: string;
  avg_ticket_cents: number;
  avg_ticket: string;
  total_refunded_cents: number;
  total_refunded: string;
  estimated_stripe_fees_cents: number;
  estimated_stripe_fees: string;
  fees_estimated: boolean;
  period: { from: string; to: string };
}

interface KPICardsProps {
  shopId: string;
  dateRange: { from: string; to: string };
}

const KPI_CARD_CLASSES =
  "bg-white rounded-xl border border-gray-200 p-4 sm:p-5 flex flex-col gap-1";

function KPICard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className={KPI_CARD_CLASSES}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
        {label}
      </p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {subtitle && (
        <p className="text-xs text-gray-400">{subtitle}</p>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className={`${KPI_CARD_CLASSES} animate-pulse`}>
      <div className="h-3 bg-gray-200 rounded w-20" />
      <div className="h-7 bg-gray-200 rounded w-28 mt-2" />
    </div>
  );
}

export function KPICards({ shopId, dateRange }: KPICardsProps) {
  const { data, isLoading, error } = useQuery<Summary>({
    queryKey: ["shop-financials-summary", shopId, dateRange.from, dateRange.to],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({
        from: dateRange.from,
        to: dateRange.to,
      });
      const res = await fetch(
        `${SHOP_FINANCIALS_URL}/${shopId}/summary?${params}`,
        { headers }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "Failed to fetch summary");
      }
      return res.json();
    },
    enabled: !!shopId,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-sm text-red-500 mb-6">
        Failed to load financial summary.
      </div>
    );
  }

  const hasTips = data.total_tips_cents > 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
      <KPICard label="Gross Sales" value={`$${data.gross_sales}`} />
      <KPICard
        label="Net Revenue"
        value={`$${data.net_revenue}`}
        subtitle={data.fees_estimated ? "Fees estimated" : undefined}
      />
      {hasTips && (
        <KPICard label="Tips Collected" value={`$${data.total_tips}`} />
      )}
      <KPICard
        label="Avg Ticket"
        value={`$${data.avg_ticket}`}
        subtitle={`${data.order_count} orders`}
      />
      <KPICard
        label="Stripe Fees"
        value={`-$${data.estimated_stripe_fees}`}
        subtitle={data.fees_estimated ? "Estimated" : undefined}
      />
    </div>
  );
}