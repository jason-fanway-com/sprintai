// SprintAI CRM — Sidebar Navigation
(function() {
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  const links = [
    { href: '/admin/index.html', icon: '📊', label: 'Dashboard', page: 'index.html' },
    { href: '/admin/companies.html', icon: '🏢', label: 'Companies', page: 'companies.html' },
    { href: '/admin/contacts.html', icon: '👤', label: 'Contacts', page: 'contacts.html' },
    { href: '/admin/pipeline.html', icon: '💰', label: 'Pipeline', page: 'pipeline.html' },
    { href: '/admin/import.html', icon: '📥', label: 'Import', page: 'import.html' },
  ];

  const nav = document.createElement('div');
  nav.id = 'crm-sidebar';
  nav.innerHTML = `
    <div class="fixed inset-y-0 left-0 w-64 bg-gray-900 text-white flex flex-col z-40 transform transition-transform duration-200 lg:translate-x-0" id="sidebar-panel">
      <div class="flex items-center gap-2 px-6 py-5 border-b border-gray-700">
        <span class="text-2xl">❄️</span>
        <span class="text-lg font-bold">SprintAI CRM</span>
      </div>
      <nav class="flex-1 px-3 py-4 space-y-1">
        ${links.map(l => `
          <a href="${l.href}" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium ${l.page === currentPage ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'}">
            <span>${l.icon}</span> ${l.label}
          </a>
        `).join('')}
      </nav>
      <div class="px-3 py-4 border-t border-gray-700 space-y-1">
        <a href="/" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800 hover:text-white">
          <span>←</span> Back to Site
        </a>
        <button onclick="logout()" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800 hover:text-white w-full text-left">
          <span>🚪</span> Logout
        </button>
      </div>
    </div>
    <!-- Mobile hamburger -->
    <button id="sidebar-toggle" class="lg:hidden fixed top-4 left-4 z-50 bg-gray-900 text-white p-2 rounded-lg shadow-lg">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
    <!-- Mobile overlay -->
    <div id="sidebar-overlay" class="hidden fixed inset-0 bg-black bg-opacity-50 z-30 lg:hidden"></div>
  `;
  document.body.prepend(nav);

  const panel = document.getElementById('sidebar-panel');
  const toggle = document.getElementById('sidebar-toggle');
  const overlay = document.getElementById('sidebar-overlay');

  // Start hidden on mobile
  if (window.innerWidth < 1024) {
    panel.classList.add('-translate-x-full');
  }

  toggle.addEventListener('click', () => {
    panel.classList.toggle('-translate-x-full');
    overlay.classList.toggle('hidden');
  });
  overlay.addEventListener('click', () => {
    panel.classList.add('-translate-x-full');
    overlay.classList.add('hidden');
  });
})();
