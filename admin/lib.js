// SprintAI CRM — Shared utilities
const SUPABASE_URL = 'https://fdxvflryvctvstxdbdtm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkeHZmbHJ5dmN0dnN0eGRiZHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTEyNDcyMSwiZXhwIjoyMDg2NzAwNzIxfQ.wHeUtOUz28kL1pLafERmuByxqYTtK0H9jDE3t0GDclI';

// Use window.db to avoid shadowing the Supabase CDN global (window.supabase)
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
// Also expose as window.db for cross-script access
window.db = db;

const CRM_PASSWORD = 'sprint2026!';

function checkAuth() {
  if (localStorage.getItem('crm_auth') !== 'true') {
    window.location.href = '/admin/index.html';
    return false;
  }
  return true;
}

function logout() {
  localStorage.removeItem('crm_auth');
  window.location.href = '/admin/index.html';
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function timeAgo(d) {
  if (!d) return '—';
  const now = new Date();
  const dt = new Date(d);
  const diff = Math.floor((now - dt) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return formatDate(d);
}

const STATUS_COLORS = {
  prospect: 'bg-gray-100 text-gray-700',
  new: 'bg-gray-100 text-gray-700',
  contacted: 'bg-blue-100 text-blue-700',
  qualified: 'bg-yellow-100 text-yellow-700',
  replied: 'bg-yellow-100 text-yellow-700',
  customer: 'bg-green-100 text-green-700',
  closed_won: 'bg-green-100 text-green-700',
  churned: 'bg-red-100 text-red-700',
  dead: 'bg-red-100 text-red-700',
  bounced: 'bg-red-100 text-red-700',
  closed_lost: 'bg-red-100 text-red-700',
  unsubscribed: 'bg-red-100 text-red-700',
  lead: 'bg-gray-100 text-gray-700',
  demo_scheduled: 'bg-purple-100 text-purple-700',
  proposal_sent: 'bg-indigo-100 text-indigo-700',
  negotiation: 'bg-orange-100 text-orange-700',
};

function statusBadge(status) {
  if (!status) return '';
  const colors = STATUS_COLORS[status] || 'bg-gray-100 text-gray-700';
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors}">${label}</span>`;
}

// Toast notifications
function showToast(message, type = 'success') {
  const colors = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    info: 'bg-blue-500',
  };
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 ${colors[type] || colors.info} text-white px-6 py-3 rounded-lg shadow-lg z-50 transition-opacity duration-300`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// Modal helpers
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Pagination helper
function renderPagination(containerId, currentPage, totalPages, onPageChange) {
  const c = document.getElementById(containerId);
  if (!c || totalPages <= 1) { if (c) c.innerHTML = ''; return; }
  let html = '<div class="flex items-center gap-2">';
  html += `<button onclick="${onPageChange}(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''} class="px-3 py-1 rounded border text-sm ${currentPage <= 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}">Prev</button>`;
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let i = start; i <= end; i++) {
    html += `<button onclick="${onPageChange}(${i})" class="px-3 py-1 rounded border text-sm ${i === currentPage ? 'bg-indigo-600 text-white' : 'hover:bg-gray-100'}">${i}</button>`;
  }
  html += `<button onclick="${onPageChange}(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''} class="px-3 py-1 rounded border text-sm ${currentPage >= totalPages ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}">Next</button>`;
  html += '</div>';
  c.innerHTML = html;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Export to CSV
function exportToCSV(data, filename) {
  if (!data || data.length === 0) { showToast('No data to export', 'error'); return; }
  const headers = Object.keys(data[0]);
  const rows = data.map(row => headers.map(h => {
    let val = String(row[h] || '');
    if (val.includes(',') || val.includes('"') || val.includes('\n')) val = '"' + val.replace(/"/g, '""') + '"';
    return val;
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'export.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast(`Exported ${data.length} rows`);
}

// Format currency
function formatMoney(val) {
  const n = parseFloat(val || 0);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
