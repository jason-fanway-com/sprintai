import { useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import { getAuthHeaders } from "../../../lib/supabase";

const SHOP_FINANCIALS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shop-financials`;

interface ExportButtonProps {
  shopId: string;
  dateRange: { from: string; to: string };
}

export function ExportButton({ shopId, dateRange }: ExportButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  async function handleExport(format: "quickbooks" | "simple") {
    setExporting(format);
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({
        from: dateRange.from,
        to: dateRange.to,
        format,
      });
      const res = await fetch(
        `${SHOP_FINANCIALS_URL}/${shopId}/export?${params}`,
        { headers }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? "Export failed");
      }

      // Extract filename from Content-Disposition or fallback
      const disposition = res.headers.get("Content-Disposition");
      let filename = "financials.csv";
      if (disposition) {
        const match = disposition.match(/filename="(.+)"/);
        if (match) filename = match[1];
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setExporting(null);
      setIsOpen(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
      >
        <Download className="w-4 h-4" />
        Export CSV
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && (
        <>
          {/* Backdrop to close */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1 min-w-[220px]">
            <button
              onClick={() => handleExport("quickbooks")}
              disabled={exporting !== null}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting === "quickbooks" ? (
                <span className="inline-flex items-center gap-2">
                  <span className="animate-spin h-3 w-3 border-2 border-brand-600 border-t-transparent rounded-full" />
                  Exporting…
                </span>
              ) : (
                <>
                  <span className="font-medium">QuickBooks (4-column)</span>
                  <span className="block text-xs text-gray-400">
                    Date, Description, Credit, Debit
                  </span>
                </>
              )}
            </button>
            <button
              onClick={() => handleExport("simple")}
              disabled={exporting !== null}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting === "simple" ? (
                <span className="inline-flex items-center gap-2">
                  <span className="animate-spin h-3 w-3 border-2 border-brand-600 border-t-transparent rounded-full" />
                  Exporting…
                </span>
              ) : (
                <>
                  <span className="font-medium">Simple (3-column)</span>
                  <span className="block text-xs text-gray-400">
                    Date, Description, Amount
                  </span>
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}