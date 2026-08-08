import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  ComposedChart,
} from "recharts";
import { getAuthHeaders } from "../../../lib/supabase";

const SHOP_FINANCIALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shop-financials`;

interface DayData {
  date: string;
  gross: string;
  gross_cents: number;
  net: string;
  net_cents: number;
  order_count: number;
}

interface RevenueChartProps {
  shopId: string;
  dateRange: { from: string; to: string };
}

export function RevenueChart({ shopId, dateRange }: RevenueChartProps) {
  const { data, isLoading, error } = useQuery<{ days: DayData[] }>({
    queryKey: ["shop-financials-chart", shopId, dateRange.from, dateRange.to],
    queryFn: async () => {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({
        from: dateRange.from,
        to: dateRange.to,
      });
      const res = await fetch(
        `${SHOP_FINANCIALS_URL}/${shopId}/chart?${params}`,
        { headers }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "Failed to fetch chart data");
      }
      return res.json();
    },
    enabled: !!shopId,
  });

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-32 mb-4" />
        <div className="h-64 bg-gray-100 rounded" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <p className="text-sm text-red-500">Failed to load revenue chart.</p>
      </div>
    );
  }

  const days = data?.days ?? [];

  if (days.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <h3 className="text-sm font-medium text-gray-700 mb-2">
          Revenue Trend
        </h3>
        <div className="h-48 flex items-center justify-center text-gray-400 text-sm">
          No data for this period.
        </div>
      </div>
    );
  }

  // Format date labels
  const chartData = days.map((d) => ({
    ...d,
    label: new Date(d.date + "T12:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    grossNum: parseFloat(d.gross),
    netNum: parseFloat(d.net),
  }));

  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: Array<{ name: string; value: number; color: string }>;
    label?: string;
  }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-sm">
        <p className="font-medium text-gray-900 mb-1">{label}</p>
        {payload.map((entry, i) => (
          <p key={i} style={{ color: entry.color }}>
            {entry.name}: ${entry.value.toFixed(2)}
          </p>
        ))}
        {chartData.find((d) => d.label === label) && (
          <p className="text-gray-400 mt-0.5">
            {chartData.find((d) => d.label === label)?.order_count} orders
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
      <h3 className="text-sm font-medium text-gray-700 mb-4">Revenue Trend</h3>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `$${v}`}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            dataKey="grossNum"
            name="Gross"
            fill="#6366f1"
            radius={[3, 3, 0, 0]}
            maxBarSize={40}
          />
          <Line
            type="monotone"
            dataKey="netNum"
            name="Net"
            stroke="#10b981"
            strokeWidth={2}
            dot={{ r: 3, fill: "#10b981" }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}