/**
 * SprintAI Chat Widget
 * Lightweight embeddable chat widget - no frameworks, vanilla JS.
 *
 * Usage:
 *   <script src="https://rvdqfxtrskxekfkqnegx.supabase.co/storage/v1/object/public/widget/widget.js"
 *           data-tenant-id="YOUR_TENANT_ID"></script>
 *
 * The widget self-initializes when the script loads. It:
 *   - Injects its own CSS into <head>
 *   - Creates a floating chat bubble (bottom-right)
 *   - Opens a chat window on click
 *   - Sends messages to the chat-sms edge function (web channel)
 *   - Persists session_id in localStorage
 */

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────

  var API_URL = 'https://rvdqfxtrskxekfkqnegx.supabase.co/functions/v1/chat-sms';
  var STORAGE_KEY_PREFIX = 'sprintai_session_';
  var WIDGET_ID = 'sprintai-widget';

  // ── Get tenant ID from script tag ─────────────────────────────────────────

  var scriptTag = document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  var tenantId = scriptTag ? scriptTag.getAttribute('data-tenant-id') : null;

  if (!tenantId) {
    console.warn('[SprintAI] No data-tenant-id found on script tag. Widget will not load.');
    return;
  }

  // Prevent double-init
  if (document.getElementById(WIDGET_ID + '-root')) return;

  // ── Session ID ────────────────────────────────────────────────────────────

  var storageKey = STORAGE_KEY_PREFIX + tenantId;

  function getSessionId() {
    try {
      var sid = localStorage.getItem(storageKey);
      if (sid) return sid;
      sid = 'web_' + tenantId.substring(0, 8) + '_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
      localStorage.setItem(storageKey, sid);
      return sid;
    } catch (e) {
      // localStorage blocked (private mode, etc.) - generate ephemeral ID
      return 'web_' + tenantId.substring(0, 8) + '_' + Math.random().toString(36).substring(2, 10);
    }
  }

  // ── Inject CSS ────────────────────────────────────────────────────────────

  var css = [
    /* Root */
    '#sprintai-widget-root *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}',

    /* Bubble button */
    '#sprintai-bubble{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;',
    'background:linear-gradient(135deg,#4f46e5,#6d28d9);border:none;cursor:pointer;',
    'box-shadow:0 4px 20px rgba(79,70,229,0.45);display:flex;align-items:center;justify-content:center;',
    'transition:transform 0.2s,box-shadow 0.2s;z-index:2147483646;}',
    '#sprintai-bubble:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(79,70,229,0.55);}',
    '#sprintai-bubble svg{width:26px;height:26px;fill:white;transition:opacity 0.2s;}',
    '#sprintai-bubble.open svg.chat-icon{display:none;}',
    '#sprintai-bubble.open svg.close-icon{display:block!important;}',

    /* Unread badge */
    '#sprintai-badge{position:absolute;top:-3px;right:-3px;width:18px;height:18px;background:#ef4444;',
    'border-radius:50%;border:2px solid white;display:none;animation:sprintai-pop 0.3s ease;}',
    '@keyframes sprintai-pop{0%{transform:scale(0);}80%{transform:scale(1.2);}100%{transform:scale(1);}}',

    /* Chat window */
    '#sprintai-window{position:fixed;bottom:92px;right:24px;width:360px;height:520px;',
    'background:white;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.18);',
    'display:flex;flex-direction:column;overflow:hidden;z-index:2147483645;',
    'transform:scale(0.85) translateY(20px);opacity:0;pointer-events:none;',
    'transition:transform 0.22s cubic-bezier(0.34,1.56,0.64,1),opacity 0.18s ease;',
    'transform-origin:bottom right;}',
    '#sprintai-window.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}',

    /* Window header */
    '#sprintai-header{background:linear-gradient(135deg,#4f46e5,#6d28d9);padding:16px 18px;',
    'display:flex;align-items:center;gap:10px;flex-shrink:0;}',
    '#sprintai-avatar{width:36px;height:36px;background:rgba(255,255,255,0.2);border-radius:50%;',
    'display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#sprintai-avatar svg{width:20px;height:20px;fill:white;}',
    '#sprintai-header-text{}',
    '#sprintai-header-name{font-size:0.9rem;font-weight:700;color:white;line-height:1.2;}',
    '#sprintai-header-sub{font-size:0.72rem;color:rgba(255,255,255,0.72);}',
    '#sprintai-close-btn{margin-left:auto;background:none;border:none;cursor:pointer;',
    'color:rgba(255,255,255,0.8);padding:4px;line-height:1;font-size:1.1rem;',
    'display:flex;align-items:center;justify-content:center;}',
    '#sprintai-close-btn:hover{color:white;}',

    /* Messages area */
    '#sprintai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;',
    'scroll-behavior:smooth;}',
    '#sprintai-messages::-webkit-scrollbar{width:4px;}',
    '#sprintai-messages::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:2px;}',

    /* Message bubbles */
    '.sprintai-msg{max-width:82%;display:flex;flex-direction:column;gap:3px;}',
    '.sprintai-msg.user{align-self:flex-end;align-items:flex-end;}',
    '.sprintai-msg.bot{align-self:flex-start;align-items:flex-start;}',
    '.sprintai-bubble-text{padding:9px 13px;border-radius:14px;font-size:0.875rem;line-height:1.5;word-break:break-word;}',
    '.sprintai-msg.user .sprintai-bubble-text{background:linear-gradient(135deg,#4f46e5,#6d28d9);color:white;',
    'border-bottom-right-radius:4px;}',
    '.sprintai-msg.bot .sprintai-bubble-text{background:#f1f5f9;color:#1e293b;border-bottom-left-radius:4px;}',
    '.sprintai-msg-time{font-size:0.68rem;color:#94a3b8;}',

    /* Typing indicator */
    '#sprintai-typing{align-self:flex-start;display:none;gap:4px;padding:10px 14px;',
    'background:#f1f5f9;border-radius:14px;border-bottom-left-radius:4px;}',
    '#sprintai-typing.visible{display:flex;}',
    '#sprintai-typing span{width:7px;height:7px;background:#94a3b8;border-radius:50%;',
    'animation:sprintai-bounce 1.2s infinite ease-in-out;}',
    '#sprintai-typing span:nth-child(2){animation-delay:0.2s;}',
    '#sprintai-typing span:nth-child(3){animation-delay:0.4s;}',
    '@keyframes sprintai-bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-6px);}}',

    /* Input area */
    '#sprintai-input-area{padding:12px 14px;border-top:1px solid #f1f5f9;display:flex;gap:8px;flex-shrink:0;',
    'background:white;}',
    '#sprintai-input{flex:1;border:1.5px solid #e5e7eb;border-radius:22px;',
    'padding:9px 14px;font-size:0.875rem;outline:none;color:#1e293b;',
    'transition:border-color 0.15s;resize:none;max-height:80px;line-height:1.4;}',
    '#sprintai-input:focus{border-color:#4f46e5;}',
    '#sprintai-input::placeholder{color:#9ca3af;}',
    '#sprintai-send{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#6d28d9);',
    'border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;',
    'flex-shrink:0;transition:opacity 0.15s,transform 0.1s;}',
    '#sprintai-send:hover:not(:disabled){opacity:0.88;transform:scale(1.05);}',
    '#sprintai-send:disabled{opacity:0.4;cursor:default;transform:none;}',
    '#sprintai-send svg{width:16px;height:16px;fill:white;}',

    /* Powered by */
    '#sprintai-footer{text-align:center;padding:6px 0 8px;font-size:0.68rem;color:#cbd5e1;flex-shrink:0;}',
    '#sprintai-footer a{color:#a5b4fc;text-decoration:none;}',
    '#sprintai-footer a:hover{text-decoration:underline;}',

    /* Mobile responsive */
    '@media(max-width:420px){',
    '#sprintai-window{width:calc(100vw - 20px);right:10px;bottom:80px;height:70vh;min-height:380px;max-height:520px;}',
    '#sprintai-bubble{bottom:16px;right:16px;width:52px;height:52px;}',
    '}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── Build DOM ─────────────────────────────────────────────────────────────

  var root = document.createElement('div');
  root.id = WIDGET_ID + '-root';

  root.innerHTML = [
    /* Bubble */
    '<button id="sprintai-bubble" aria-label="Open chat" aria-expanded="false">',
    '  <svg class="chat-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    '  <svg class="close-icon" style="display:none" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" stroke="white" stroke-width="2.5" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>',
    '  <div id="sprintai-badge"></div>',
    '</button>',

    /* Chat window */
    '<div id="sprintai-window" role="dialog" aria-label="Chat" aria-modal="true">',

    '  <div id="sprintai-header">',
    '    <div id="sprintai-avatar">',
    '      <svg viewBox="0 0 24 24"><path d="M13 3L4 14h8l-1 7 9-11h-8l1-7z"/></svg>',
    '    </div>',
    '    <div id="sprintai-header-text">',
    '      <div id="sprintai-header-name">AI Assistant</div>',
    '      <div id="sprintai-header-sub">Typically replies in seconds</div>',
    '    </div>',
    '    <button id="sprintai-close-btn" aria-label="Close chat">',
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    '    </button>',
    '  </div>',

    '  <div id="sprintai-messages">',
    '    <div id="sprintai-typing"><span></span><span></span><span></span></div>',
    '  </div>',

    '  <div id="sprintai-input-area">',
    '    <textarea id="sprintai-input" placeholder="Type a message..." rows="1" maxlength="1000"></textarea>',
    '    <button id="sprintai-send" disabled aria-label="Send message">',
    '      <svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/></svg>',
    '    </button>',
    '  </div>',

    '  <div id="sprintai-footer">Powered by <a href="https://getsprintai.com" target="_blank" rel="noopener">SprintAI</a></div>',

    '</div>',
  ].join('');

  document.body.appendChild(root);

  // ── Element references ────────────────────────────────────────────────────

  var bubble      = document.getElementById('sprintai-bubble');
  var badge       = document.getElementById('sprintai-badge');
  var chatWindow  = document.getElementById('sprintai-window');
  var messagesEl  = document.getElementById('sprintai-messages');
  var typingEl    = document.getElementById('sprintai-typing');
  var inputEl     = document.getElementById('sprintai-input');
  var sendBtn     = document.getElementById('sprintai-send');
  var closeBtn    = document.getElementById('sprintai-close-btn');

  // ── State ─────────────────────────────────────────────────────────────────

  var isOpen        = false;
  var isWaiting     = false;
  var sessionId     = getSessionId();
  var hasGreeted    = false;

  // ── Toggle open/close ─────────────────────────────────────────────────────

  function openChat() {
    isOpen = true;
    bubble.classList.add('open');
    bubble.setAttribute('aria-expanded', 'true');
    chatWindow.classList.add('open');
    badge.style.display = 'none';

    // Show greeting on first open
    if (!hasGreeted) {
      hasGreeted = true;
      setTimeout(function () {
        addBotMessage('Hi! How can I help you today?');
      }, 350);
    }

    setTimeout(function () { inputEl.focus(); }, 250);
  }

  function closeChat() {
    isOpen = false;
    bubble.classList.remove('open');
    bubble.setAttribute('aria-expanded', 'false');
    chatWindow.classList.remove('open');
  }

  bubble.addEventListener('click', function () {
    if (isOpen) { closeChat(); } else { openChat(); }
  });

  closeBtn.addEventListener('click', closeChat);

  // Close on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) closeChat();
  });

  // ── Input handling ────────────────────────────────────────────────────────

  inputEl.addEventListener('input', function () {
    sendBtn.disabled = inputEl.value.trim() === '' || isWaiting;
    // Auto-resize textarea
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  });

  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  // ── Send message ──────────────────────────────────────────────────────────

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isWaiting) return;

    // Render user message
    addUserMessage(text);

    // Clear input
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;
    isWaiting = true;

    // Show typing indicator
    showTyping(true);

    // POST to edge function
    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        message:   text,
        channel:   'web',
        session_id: sessionId,
      }),
    })
    .then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          throw new Error('Server error ' + res.status + ': ' + body.substring(0, 120));
        });
      }
      return res.json();
    })
    .then(function (data) {
      showTyping(false);
      isWaiting = false;

      // Update session_id if server returned a new one
      if (data.session_id && data.session_id !== sessionId) {
        sessionId = data.session_id;
        try { localStorage.setItem(storageKey, sessionId); } catch (e) {}
      }

      if (data.response) {
        addBotMessage(data.response);
        // Show badge if window is closed
        if (!isOpen) {
          badge.style.display = 'block';
        }
      } else {
        addBotMessage("I'm sorry, I didn't get a response. Please try again.");
      }
    })
    .catch(function (err) {
      showTyping(false);
      isWaiting = false;
      console.error('[SprintAI] Chat error:', err);
      addBotMessage("I'm having trouble connecting right now. Please try again in a moment.");
    })
    .finally(function () {
      sendBtn.disabled = inputEl.value.trim() === '';
    });
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function addUserMessage(text) {
    var wrap = document.createElement('div');
    wrap.className = 'sprintai-msg user';
    wrap.innerHTML = '<div class="sprintai-bubble-text">' + escapeHtml(text) + '</div>';
    messagesEl.insertBefore(wrap, typingEl);
    scrollToBottom();
  }

  function addBotMessage(text) {
    var wrap = document.createElement('div');
    wrap.className = 'sprintai-msg bot';
    wrap.innerHTML = '<div class="sprintai-bubble-text">' + escapeHtml(text) + '</div>';
    messagesEl.insertBefore(wrap, typingEl);
    scrollToBottom();
  }

  function showTyping(visible) {
    typingEl.className = visible ? 'visible' : '';
    if (visible) scrollToBottom();
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

})();
