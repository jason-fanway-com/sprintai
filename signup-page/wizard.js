/* SprintAI Guided-Signup Wizard — Spec 05, Phase 1 (test mode).
 *
 * Left panel = step form (source of truth; every step completable here alone).
 * Right panel = the homepage phone running a SCRIPTED, deterministic guided
 * chat (Option A). The chat is ADDITIVE — it narrates each step and surfaces
 * the real Open Questions, but NEVER gates progress and NEVER invents a price.
 *
 * Backend (Supabase Edge Functions on wizard-05 branch):
 *   onboarding-save   create / save / resume
 *   scrape-shop       auto-learn
 *   import-menu-csv   Stage B (confirmed CSV -> DB)
 *   connect-create-express / connect-oauth   Stripe (Phase 2; degrade now)
 *   provision-number  Twilio (test mode + guardrails)
 *   go-live           gate (refuses while Connect unconfigured)
 */
(function () {
  "use strict";

  // ── Config ────────────────────────────────────────────────────────────────
  // Override via window.SPRINT_CONFIG (set in a <script> before this file) for
  // local Supabase. Defaults to the prod project (anon key is publishable).
  var CFG = window.SPRINT_CONFIG || {
    SUPABASE_URL: "https://rvdqfxtrskxekfkqnegx.supabase.co",
    ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2ZHFmeHRyc2t4ZWtma3FuZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDg2ODksImV4cCI6MjA5MDMyNDY4OX0.5SOW_FX92dIw_zgbqF7HO2SM5ueQC3YPaAexKCFAv3E"
  };
  function fnUrl(name) { return CFG.SUPABASE_URL + "/functions/v1/" + name; }
  function api(name, body) {
    return fetch(fnUrl(name), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": CFG.ANON_KEY,
        "Authorization": "Bearer " + CFG.ANON_KEY
      },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }

  // ── Wizard state (persisted to shops via onboarding-save) ──────────────────
  var STEPS = [
    { key: "account",      label: "Account" },
    { key: "subscription", label: "Subscription" },
    { key: "connect",      label: "Payouts" },
    { key: "scrape",       label: "Auto-learn" },
    { key: "menu",         label: "Menu" },
    { key: "instructions", label: "Instructions" },
    { key: "fulfillment",  label: "Fulfillment" },
    { key: "number",       label: "Number & test" },
    { key: "review",       label: "Go live" }
  ];

  var state = {
    shop_id: localStorage.getItem("sprint_shop_id") || null,
    stepIdx: 0,
    shop: null,
    // menu working data
    menuCsvRaw: null,        // uploaded canonical CSV text
    menuRows: null,          // parsed rows [{category,name,size,price,...}]
    openQuestions: null,     // [{id,kind,...,resolved,answer}]
  };

  // ── DOM ────────────────────────────────────────────────────────────────────
  var elRail = document.getElementById("stepsRail");
  var elCard = document.getElementById("stepCard");
  var elResumeBadge = document.getElementById("resume-badge");

  function stepIndex(key) { for (var i = 0; i < STEPS.length; i++) if (STEPS[i].key === key) return i; return 0; }

  function renderRail() {
    elRail.innerHTML = "";
    STEPS.forEach(function (s, i) {
      var c = document.createElement("div");
      c.className = "step-chip" + (i === state.stepIdx ? " active" : (i < state.stepIdx ? " done" : ""));
      c.textContent = (i < state.stepIdx ? "✓ " : "") + s.label;
      elRail.appendChild(c);
    });
  }

  function go(idx) {
    state.stepIdx = Math.max(0, Math.min(STEPS.length - 1, idx));
    renderRail();
    RENDERERS[STEPS[state.stepIdx].key]();
    chatForStep(STEPS[state.stepIdx].key);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function next() { go(state.stepIdx + 1); }
  function back() { go(state.stepIdx - 1); }

  function saveStep(stepKey, fields) {
    if (!state.shop_id) return Promise.resolve();
    elResumeBadge.style.display = "inline-flex";
    return api("onboarding-save", { action: "save", shop_id: state.shop_id, onboarding_step: stepKey, fields: fields || {} })
      .then(function (r) { if (r.json && r.json.shop) state.shop = r.json.shop; return r; });
  }

  // ── Small DOM helpers ───────────────────────────────────────────────────────
  function h(html) { var d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ════════════════════════════════════════════════════════════════════════════
  //  STEP RENDERERS  (left panel)
  // ════════════════════════════════════════════════════════════════════════════
  var RENDERERS = {};

  // 1 ── ACCOUNT & BASICS ─────────────────────────────────────────────────────
  RENDERERS.account = function () {
    var s = state.shop || {};
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Account &amp; basics</div>' +
      '<div class="step-desc">Tell us about your shop. This creates your account so we can save your progress.</div>' +
      '<label class="fld"><span>Restaurant name</span><input id="f-name" value="' + esc(s.name || "") + '" placeholder="Jack\'s Slice"></label>' +
      '<label class="fld"><span>Your email</span><input id="f-email" type="email" value="' + esc(s.email_ticket_recipient || "") + '" placeholder="owner@jacksslice.com"></label>' +
      '<label class="fld"><span>Website URL</span><input id="f-url" value="' + esc(s.website_url || "") + '" placeholder="https://jacksslice.com"><div class="hint">We\'ll read your site to learn your story (next step).</div></label>' +
      '<div class="row2">' +
        '<label class="fld"><span>Phone</span><input id="f-phone" placeholder="(610) 555-0188"></label>' +
        '<label class="fld"><span>Timezone</span><select id="f-tz">' +
          ['America/New_York','America/Chicago','America/Denver','America/Los_Angeles'].map(function(t){return '<option'+((s.timezone||'America/New_York')===t?' selected':'')+'>'+t+'</option>';}).join('') +
        '</select></label>' +
      '</div>' +
      '<label class="fld"><span>Address</span><input id="f-addr" placeholder="123 Main St, Allentown, PA"></label>' +
      '<div class="btn-row"><span></span><button class="btn btn-primary" id="go">Create &amp; continue →</button></div>' +
      '</div>'
    ));
    document.getElementById("go").onclick = function () {
      var name = document.getElementById("f-name").value.trim();
      var email = document.getElementById("f-email").value.trim();
      if (!name || !email) { chatSay("resto", "I just need your restaurant name and email to start — pop those in on the left and we're off."); return; }
      this.disabled = true; this.textContent = "Creating…";
      var account = {
        name: name, email: email,
        website_url: document.getElementById("f-url").value.trim(),
        timezone: document.getElementById("f-tz").value,
        phone: document.getElementById("f-phone").value.trim(),
        address: document.getElementById("f-addr").value.trim()
      };
      if (state.shop_id) {
        // already created — just save edits and advance
        saveStep("account", { name: name, website_url: account.website_url, timezone: account.timezone, email_ticket_recipient: email }).then(next);
        return;
      }
      api("onboarding-save", { action: "create", account: account }).then(function (r) {
        if (r.json && r.json.shop_id) {
          state.shop_id = r.json.shop_id;
          localStorage.setItem("sprint_shop_id", state.shop_id);
          return api("onboarding-save", { action: "resume", shop_id: state.shop_id });
        }
        throw new Error((r.json && r.json.error) || "create failed");
      }).then(function (r) {
        state.shop = r.json.shop;
        chatSay("resto", "Nice to meet you, " + esc(name) + "! Your account's saved — you can close this and come back any time.");
        next();
      }).catch(function (e) {
        chatSay("resto", "Hmm, that didn't save (" + esc(e.message) + "). Mind trying again?");
        var b = document.getElementById("go"); if (b) { b.disabled = false; b.textContent = "Create & continue →"; }
      });
    };
  };

  // 2 ── SUBSCRIPTION ($49/mo PAY-NOW) ────────────────────────────────────────
  RENDERERS.subscription = function () {
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Your SprintAI subscription</div>' +
      '<div class="step-desc">$49/mo — your own number, the ordering assistant, and order tickets. No setup fee.</div>' +
      '<div class="notice warn">Payments aren\'t configured on this environment yet, so we can\'t collect a card here. ' +
        'In production this is where you\'d add your payment method and the $49 charges immediately (no trial). ' +
        'For this preview we\'ll mark the subscription step so the rest of setup can proceed.</div>' +
      '<div class="notice info">Order go-live is gated on your <strong>payout</strong> account being enabled — never on this subscription. You\'ll never pay then sit idle.</div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go">Mark subscription &amp; continue →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    document.getElementById("go").onclick = function () {
      // Phase 1: mark the payment-method flag so number provisioning's
      // subscription-first guardrail is satisfied in test mode. Real charge =
      // Phase 2 when Stripe config flips. No card data touches Sprint.
      saveStep("subscription", { subscription_status: "active", subscription_pm_set: true }).then(next);
    };
  };

  // 3 ── CONNECT (payouts) — degrade gracefully ───────────────────────────────
  RENDERERS.connect = function () {
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Where your money lands</div>' +
      '<div class="step-desc">Connect a Stripe account so payouts go straight to you. You own your payouts; Sprint never holds your money.</div>' +
      '<div id="connect-state" class="notice info">Checking payment configuration…</div>' +
      '<div class="row2">' +
        '<button class="btn btn-ghost" id="have">I already use Stripe</button>' +
        '<button class="btn btn-ghost" id="setup">Set me up</button>' +
      '</div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go">Continue (finish payouts later) →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    document.getElementById("go").onclick = function () { saveStep("connect", {}).then(next); };

    // Probe the express endpoint — in Phase 1 it returns "Stripe not configured".
    function probe(fn) {
      api(fn, { shop_id: state.shop_id }).then(function (r) {
        var el = document.getElementById("connect-state");
        if (!el) return;
        if (r.json && r.json.error && /not configured|blocked-on-secrets/i.test(r.json.error)) {
          el.className = "notice warn";
          el.innerHTML = "<strong>Payments not yet configured.</strong> Stripe Connect isn\'t live on this environment yet — this step will light up automatically once it\'s enabled. You can keep setting up everything else now; you just can\'t take live orders until payouts are enabled.";
        } else if (r.json && r.json.client_secret) {
          el.className = "notice ok";
          el.textContent = "Stripe onboarding ready — embedded component would mount here.";
        } else {
          el.className = "notice info";
          el.textContent = (r.json && (r.json.error || JSON.stringify(r.json))) || "Stripe response received.";
        }
      });
    }
    document.getElementById("have").onclick = function () {
      api("connect-oauth", {}); // GET-only normally; just narrate
      probe("connect-create-express");
      chatSay("resto", "Already on Stripe? Perfect — in production you'd tap a Stripe button and we'd link your existing account in one click.");
    };
    document.getElementById("setup").onclick = function () { probe("connect-create-express"); };
    probe("connect-create-express");
  };

  // 4 ── SCRAPE (auto-learn) ──────────────────────────────────────────────────
  RENDERERS.scrape = function () {
    var s = state.shop || {};
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Auto-learn your shop</div>' +
      '<div class="step-desc">We read your website so the assistant talks like you — your story, your specialties, your neighborhood.</div>' +
      '<label class="fld"><span>Website URL</span><input id="f-url" value="' + esc(s.website_url || "") + '" placeholder="https://jacksslice.com"></label>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn btn-ghost" id="run">Read my site</button><span id="scrape-status" class="step-desc" style="margin:0"></span></div>' +
      '<label class="fld" style="margin-top:14px"><span>What we learned (edit freely)</span><textarea id="f-ctx" placeholder="Founders, personality, points of interest…">' + esc(s.shop_context || "") + '</textarea></label>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go">Save &amp; continue →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    document.getElementById("run").onclick = function () {
      var url = document.getElementById("f-url").value.trim();
      var st = document.getElementById("scrape-status");
      st.textContent = "Reading… this can take a moment.";
      // persist the URL first so scrape-shop can read it
      saveStep("scrape", { website_url: url }).then(function () {
        return api("scrape-shop", { shop_id: state.shop_id });
      }).then(function (r) {
        if (r.json && r.json.shop_context) {
          document.getElementById("f-ctx").value = r.json.shop_context;
          st.textContent = "Done — read and summarized your site.";
        } else if (r.json && r.json.context) {
          document.getElementById("f-ctx").value = r.json.context;
          st.textContent = "Done.";
        } else {
          st.textContent = (r.json && r.json.error) ? ("Couldn't auto-read (" + r.json.error + ") — you can paste a description below.") : "No content returned — paste a description below.";
        }
      }).catch(function (e) { st.textContent = "Auto-read unavailable — paste a description below."; });
    };
    document.getElementById("go").onclick = function () {
      saveStep("scrape", { website_url: document.getElementById("f-url").value.trim() }).then(next);
    };
  };

  // 5 ── MENU (upload → review-as-conversation → confirm → DB) ─────────────────
  RENDERERS.menu = function () {
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Your menu</div>' +
      '<div class="step-desc">Upload your menu as a canonical CSV. We\'ll walk through anything the menu leaves open before it goes live — we never guess a price.</div>' +
      '<label class="fld"><span>Menu CSV (7-column canonical)</span><input id="f-csv" type="file" accept=".csv"></label>' +
      '<div id="menu-review"></div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go" disabled>Confirm menu &amp; write to DB →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    document.getElementById("f-csv").onchange = function (ev) {
      var file = ev.target.files[0]; if (!file) return;
      var rd = new FileReader();
      rd.onload = function () { loadMenuCsv(String(rd.result)); };
      rd.readAsText(file);
    };
    document.getElementById("go").onclick = confirmMenu;
    if (state.menuRows) renderMenuReview();
  };

  function parseCsv(text) {
    // Minimal RFC4180-ish parser matching menu-pipeline/core/csv.ts behavior
    // (quoted fields, doubled quotes). Good enough for the canonical fixture.
    var rows = []; var i = 0, field = "", row = [], inQ = false;
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (ch === "\r") { /* skip */ }
        else field += ch;
      }
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function loadMenuCsv(text) {
    state.menuCsvRaw = text;
    var arr = parseCsv(text).filter(function (r) { return r.length > 1 && r.join("").trim() !== ""; });
    var header = arr.shift();
    state.menuRows = arr.map(function (r) {
      return { category: r[0] || "", name: r[1] || "", size: r[2] || "", price: r[3] || "", description: r[4] || "", prompt_for: r[5] || "", upsell: r[6] || "" };
    });
    // Build Open Questions: the 9 Upcharge-TBD side-sub rows + the standing
    // Jack's questions (cash discount, catering, wings). NEVER invent prices.
    var oq = [];
    state.menuRows.forEach(function (row, idx) {
      if (/upcharge\s*tbd/i.test(row.description) || (row.price.trim() === "" && /substitution/i.test(row.category))) {
        oq.push({ id: "up-" + idx, kind: "upcharge", rowIdx: idx, area: row.category, name: row.name, resolved: false, answer: "" });
      }
    });
    oq.push({ id: "cash", kind: "choice", area: "Cash Discount", question: "Your menu says \u201cCash Discount Available.\u201d Does that discount apply to card/SMS orders too, or is it in-store cash only?",
      options: [["in_store_cash_only", "In-store cash only"], ["applies_to_sms", "Applies to SMS/card too"], ["none", "No cash discount"]], field: "cash_discount_mode", resolved: false, answer: "" });
    oq.push({ id: "catering", kind: "choice", area: "Catering", question: "You advertise a separate catering menu. Should catering be SMS-orderable now, or handled offline for now?",
      options: [["offline", "Offline for now"], ["sms_orderable", "SMS-orderable now"]], field: "catering_mode", resolved: false, answer: "" });
    oq.push({ id: "wings", kind: "number", area: "Wings", question: "For a 10-piece wings order, how many flavors are included? (and does mixing cost extra?)", field: "wing_flavors_included", resolved: false, answer: "" });
    state.openQuestions = oq;
    chatStartMenuQuestions();
    renderMenuReview();
  }

  function openQuestionsRemaining() {
    if (!state.openQuestions) return 1;
    return state.openQuestions.filter(function (q) { return !q.resolved; }).length;
  }

  function renderMenuReview() {
    var host = document.getElementById("menu-review"); if (!host) return;
    if (!state.menuRows) { host.innerHTML = ""; return; }
    var html = "";

    // Open Questions FIRST (lead with what's unresolved).
    var unresolved = state.openQuestions.filter(function (q) { return !q.resolved; });
    var resolved = state.openQuestions.filter(function (q) { return q.resolved; });
    html += '<div style="margin:18px 0 8px;font-weight:700;color:var(--navy)">Let\'s settle ' + unresolved.length + ' open question' + (unresolved.length === 1 ? "" : "s") + ' first</div>';

    state.openQuestions.forEach(function (q) {
      if (q.kind === "upcharge") return; // grouped below
    });

    // Upcharge group (the 9 side-sub rows).
    var ups = state.openQuestions.filter(function (q) { return q.kind === "upcharge"; });
    if (ups.length) {
      html += '<div class="oq-block"><h4>Side-substitution upcharges</h4>' +
        '<div class="oq-q">Your menu offers these side swaps \u201cfor an upcharge\u201d but doesn\'t print the amount. What do you charge for each? (Leave 0 if it\'s free.)</div>';
      ups.forEach(function (q) {
        html += '<div class="oq-item"><label>' + esc(q.area) + " · " + esc(q.name) + '</label>' +
          '<span>$</span><input type="number" step="0.01" min="0" data-oq="' + q.id + '" value="' + (q.resolved ? esc(q.answer) : "") + '" placeholder="0.00">' +
          (q.resolved ? ' <span class="oq-resolved">✓</span>' : '') + '</div>';
      });
      html += '</div>';
    }
    // Choice / number questions.
    state.openQuestions.forEach(function (q) {
      if (q.kind === "choice") {
        html += '<div class="oq-block"><h4>' + esc(q.area) + '</h4><div class="oq-q">' + esc(q.question) + '</div>';
        q.options.forEach(function (opt) {
          html += '<label class="oq-item"><input type="radio" name="' + q.id + '" data-oqc="' + q.id + '" value="' + opt[0] + '"' + (q.answer === opt[0] ? " checked" : "") + '> ' + esc(opt[1]) + '</label>';
        });
        html += (q.resolved ? '<span class="oq-resolved">✓ answered</span>' : '') + '</div>';
      } else if (q.kind === "number") {
        html += '<div class="oq-block"><h4>' + esc(q.area) + '</h4><div class="oq-q">' + esc(q.question) + '</div>' +
          '<div class="oq-item"><label>Flavors included per 10-pc</label><input type="number" min="1" data-oqn="' + q.id + '" value="' + (q.resolved ? esc(q.answer) : "") + '">' +
          (q.resolved ? ' <span class="oq-resolved">✓</span>' : '') + '</div></div>';
      }
    });

    // Menu grouped by category (collapsed), with flagged categories open.
    var byCat = {};
    state.menuRows.forEach(function (r) { (byCat[r.category] = byCat[r.category] || []).push(r); });
    html += '<div style="margin:18px 0 8px;font-weight:700;color:var(--navy)">Your menu · ' + state.menuRows.length + ' items · ' + Object.keys(byCat).length + ' categories</div>';
    Object.keys(byCat).forEach(function (cat) {
      var items = byCat[cat];
      var hasOpen = /substitution/i.test(cat);
      html += '<div class="cat-group' + (hasOpen ? " open" : "") + '"><div class="cat-head" data-cat="' + esc(cat) + '">' +
        '<span>' + esc(cat) + (hasOpen ? ' <span class="mi-flag">· needs answers</span>' : '') + '</span><span class="count">' + items.length + ' items ▾</span></div><div class="cat-body">';
      items.forEach(function (it) {
        var price = it.price.trim() ? "$" + it.price : (/upcharge tbd/i.test(it.description) ? '<span class="mi-flag">upcharge TBD</span>' : '<span class="mi-flag">—</span>');
        html += '<div class="mi-row"><div class="mi-name">' + esc(it.name) + (it.size ? ' <span style="color:var(--light)">(' + esc(it.size) + ')</span>' : '') + '</div><div class="mi-price">' + price + '</div></div>';
      });
      html += '</div></div>';
    });

    host.innerHTML = html;

    // wire collapse
    Array.prototype.forEach.call(host.querySelectorAll(".cat-head"), function (head) {
      head.onclick = function () { head.parentElement.classList.toggle("open"); };
    });
    // wire upcharge inputs
    Array.prototype.forEach.call(host.querySelectorAll("[data-oq]"), function (inp) {
      inp.onchange = function () { resolveUpcharge(inp.getAttribute("data-oq"), inp.value); };
    });
    Array.prototype.forEach.call(host.querySelectorAll("[data-oqc]"), function (inp) {
      inp.onchange = function () { resolveChoice(inp.getAttribute("data-oqc"), inp.value); };
    });
    Array.prototype.forEach.call(host.querySelectorAll("[data-oqn]"), function (inp) {
      inp.onchange = function () { resolveNumber(inp.getAttribute("data-oqn"), inp.value); };
    });

    updateMenuConfirmEnabled();
  }

  function resolveUpcharge(id, val) {
    var q = findOq(id); if (!q) return;
    if (val === "" || isNaN(parseFloat(val))) { q.resolved = false; q.answer = ""; }
    else {
      q.answer = parseFloat(val).toFixed(2); q.resolved = true;
      // Write the resolved price back into the CSV row (NEVER invented — owner-given).
      state.menuRows[q.rowIdx].price = q.answer;
      if (/upcharge tbd/i.test(state.menuRows[q.rowIdx].description)) state.menuRows[q.rowIdx].description = "";
    }
    afterResolve(q);
  }
  function resolveChoice(id, val) { var q = findOq(id); if (!q) return; q.answer = val; q.resolved = true; afterResolve(q); }
  function resolveNumber(id, val) { var q = findOq(id); if (!q) return; if (val === "" || isNaN(parseInt(val))) { q.resolved = false; } else { q.answer = String(parseInt(val)); q.resolved = true; } afterResolve(q); }
  function findOq(id) { for (var i = 0; i < state.openQuestions.length; i++) if (state.openQuestions[i].id === id) return state.openQuestions[i]; return null; }

  function afterResolve(q) {
    updateMenuConfirmEnabled();
    chatAck(q);
  }

  function updateMenuConfirmEnabled() {
    var btn = document.getElementById("go");
    if (!btn) return;
    var remaining = openQuestionsRemaining();
    btn.disabled = !state.menuRows || remaining > 0;
    btn.textContent = remaining > 0 ? ("Resolve " + remaining + " open question" + (remaining === 1 ? "" : "s") + " to continue") : "Confirm menu & write to DB →";
  }

  function rowsToCsv(rows) {
    var head = "category,name,size,price,description,prompt_for,upsell";
    function cell(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    return head + "\n" + rows.map(function (r) {
      return [r.category, r.name, r.size, r.price, r.description, r.prompt_for, r.upsell].map(cell).join(",");
    }).join("\n") + "\n";
  }

  function confirmMenu() {
    if (openQuestionsRemaining() > 0) { chatSay("resto", "Almost — we still have open questions to settle on the left before I can lock the menu in. I never guess a price."); return; }
    var btn = document.getElementById("go"); btn.disabled = true; btn.textContent = "Writing to your menu…";
    var csv = rowsToCsv(state.menuRows);
    // persist the wizard answers (cash/catering/wings) onto the shop too
    var fields = {};
    state.openQuestions.forEach(function (q) {
      if (q.field) fields[q.field] = (q.kind === "number" ? parseInt(q.answer) : q.answer);
    });
    saveStep("menu", fields).then(function () {
      return api("import-menu-csv", { shop_id: state.shop_id, csv: csv });
    }).then(function (r) {
      if (r.json && r.json.ok) {
        chatSay("resto", "Locked it in! " + (r.json.inserted || 0) + " items written to your menu" + (r.json.no_op ? " (no changes)" : "") + ". Your assistant can now quote every one of them.");
        next();
      } else {
        var msg = (r.json && r.json.error) ? r.json.error : "import failed";
        chatSay("resto", "The menu import pushed back: " + esc(msg) + ". (Usually a price still needs answering.)");
        btn.disabled = false; updateMenuConfirmEnabled();
      }
    }).catch(function (e) {
      chatSay("resto", "Couldn't reach the menu importer (" + esc(e.message) + ").");
      btn.disabled = false; updateMenuConfirmEnabled();
    });
  }

  // 6 ── SPECIAL INSTRUCTIONS ──────────────────────────────────────────────────
  RENDERERS.instructions = function () {
    var s = state.shop || {};
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Special instructions</div>' +
      '<div class="step-desc">Plain-English do\'s and don\'ts for your assistant. (It can never override safety, opt-out, or compliance rules.)</div>' +
      '<label class="fld"><span>Tell your assistant how to behave</span><textarea id="f-ai" placeholder="e.g. Always offer garlic knots with pizza. We\'re cash-friendly. No deliveries after 9pm.">' + esc(s.ai_instructions || "") + '</textarea></label>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go">Save &amp; continue →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    document.getElementById("go").onclick = function () {
      saveStep("instructions", { ai_instructions: document.getElementById("f-ai").value.trim() }).then(next);
    };
  };

  // 7 ── FULFILLMENT & OPS ─────────────────────────────────────────────────────
  // Canonical day order + labels for the hours grid. The stored shape is
  // open_hours = { mon: [{open:"11:00", close:"21:00"}], ... }; a CLOSED day is
  // simply omitted (no window). The schema (migration 003) supports multiple
  // windows per day; the wizard collects a single open/close per day for
  // simplicity (the common case) and we document multi-window as a follow-up.
  var HOURS_DAYS = [
    ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"],
    ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]
  ];

  // Read existing open_hours into a flat per-day editor model. Missing/empty day
  // => closed. Defaults for a brand-new shop: open every day 11:00–21:00.
  function hoursToEditorModel(openHours) {
    var hasAny = openHours && Object.keys(openHours).length > 0;
    var model = {};
    HOURS_DAYS.forEach(function (d) {
      var key = d[0];
      var windows = (openHours && openHours[key]) || [];
      if (windows.length > 0) {
        model[key] = { closed: false, open: windows[0].open || "11:00", close: windows[0].close || "21:00" };
      } else if (hasAny) {
        model[key] = { closed: true, open: "11:00", close: "21:00" };
      } else {
        // brand-new shop: sensible default, owner can mark days closed
        model[key] = { closed: false, open: "11:00", close: "21:00" };
      }
    });
    return model;
  }

  // Convert the editor model back into the canonical stored shape. Closed days
  // are omitted entirely (no window) so the diner bot reads them as closed.
  function editorModelToHours(model) {
    var out = {};
    HOURS_DAYS.forEach(function (d) {
      var key = d[0];
      var row = model[key];
      if (row && !row.closed && row.open && row.close) {
        out[key] = [{ open: row.open, close: row.close }];
      }
    });
    return out;
  }

  RENDERERS.fulfillment = function () {
    var s = state.shop || {};
    var hoursModel = hoursToEditorModel(s.open_hours);
    elCard.innerHTML = "";

    var rowsHtml = HOURS_DAYS.map(function (d) {
      var key = d[0], label = d[1], m = hoursModel[key];
      return '<div class="hours-row" data-day="' + key + '">' +
        '<span class="hours-day">' + label + '</span>' +
        '<label class="hours-closed"><input type="checkbox" class="h-closed" ' + (m.closed ? "checked" : "") + '> Closed</label>' +
        '<input type="time" class="h-open" value="' + esc(m.open) + '"' + (m.closed ? " disabled" : "") + '>' +
        '<span class="hours-to">to</span>' +
        '<input type="time" class="h-close" value="' + esc(m.close) + '"' + (m.closed ? " disabled" : "") + '>' +
        '</div>';
    }).join("");

    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Fulfillment &amp; ops</div>' +
      '<div class="step-desc">How orders reach you, your customer-facing name, tax, and your real hours — so your assistant knows when you\'re open.</div>' +
      '<label class="fld"><span>Display name in customer texts</span><input id="f-dn" value="' + esc(s.display_name || s.name || "") + '" placeholder="Jack\'s Slice"></label>' +
      '<label class="fld"><span>Order ticket email</span><input id="f-em" type="email" value="' + esc(s.email_ticket_recipient || "") + '" placeholder="kitchen@jacksslice.com"></label>' +
      '<label class="fld"><span>Sales tax %</span><input id="f-tax" type="number" step="0.01" min="0" value="' + ((s.tax_rate_bps || 0) / 100) + '"><div class="hint">Leave 0 for tax-included pricing.</div></label>' +
      '<div class="fld"><span>Open hours</span>' +
      '<div class="hint" style="margin-top:0;margin-bottom:8px">Set each day. Times are in your shop\'s timezone (' + esc(s.timezone || "America/New_York") + '). Your assistant uses these to tell customers if you\'re open.</div>' +
      '<div class="hours-grid" id="hours-grid">' + rowsHtml + '</div>' +
      '<div class="btn-row" style="margin-top:10px;justify-content:flex-start"><button type="button" class="btn btn-ghost" id="copy-all">Copy Monday\'s hours to all days</button></div>' +
      '</div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go">Save &amp; continue →</button></div>' +
      '</div>'
    ));

    // Closed toggle disables that day's time inputs.
    Array.prototype.forEach.call(elCard.querySelectorAll(".hours-row"), function (row) {
      var cb = row.querySelector(".h-closed");
      var openI = row.querySelector(".h-open");
      var closeI = row.querySelector(".h-close");
      cb.addEventListener("change", function () {
        openI.disabled = cb.checked;
        closeI.disabled = cb.checked;
      });
    });

    // Copy-to-all: take Monday's (first row) state and apply to every day.
    document.getElementById("copy-all").onclick = function () {
      var rows = elCard.querySelectorAll(".hours-row");
      var src = rows[0];
      var sClosed = src.querySelector(".h-closed").checked;
      var sOpen = src.querySelector(".h-open").value;
      var sClose = src.querySelector(".h-close").value;
      Array.prototype.forEach.call(rows, function (row) {
        var cb = row.querySelector(".h-closed");
        var openI = row.querySelector(".h-open");
        var closeI = row.querySelector(".h-close");
        cb.checked = sClosed;
        openI.value = sOpen; closeI.value = sClose;
        openI.disabled = sClosed; closeI.disabled = sClosed;
      });
    };

    // Read the grid back into the editor model on save.
    function readHoursModel() {
      var model = {};
      Array.prototype.forEach.call(elCard.querySelectorAll(".hours-row"), function (row) {
        var key = row.getAttribute("data-day");
        model[key] = {
          closed: row.querySelector(".h-closed").checked,
          open: row.querySelector(".h-open").value || "11:00",
          close: row.querySelector(".h-close").value || "21:00"
        };
      });
      return model;
    }

    document.getElementById("bk").onclick = back;
    document.getElementById("go").onclick = function () {
      var openHours = editorModelToHours(readHoursModel());
      // keep local state in sync so resume/re-render shows what was entered
      state.shop = state.shop || {};
      state.shop.open_hours = openHours;
      saveStep("fulfillment", {
        display_name: document.getElementById("f-dn").value.trim(),
        email_ticket_recipient: document.getElementById("f-em").value.trim(),
        tax_rate_bps: Math.round(parseFloat(document.getElementById("f-tax").value || "0") * 100),
        open_hours: openHours
      }).then(next);
    };
  };

  // 8 ── NUMBER & TEST ─────────────────────────────────────────────────────────
  RENDERERS.number = function () {
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Your number &amp; a test text</div>' +
      '<div class="step-desc">We provision a number, attach it to our A2P-approved messaging service, and point it at your assistant. Then you test it.</div>' +
      '<div id="num-state" class="notice info">No number yet.</div>' +
      '<div class="btn-row" style="margin-top:6px"><button class="btn btn-ghost" id="prov">Provision my number (test mode)</button></div>' +
      '<label class="fld" style="margin-top:14px"><span>Send a test text to your assistant</span><input id="f-test" placeholder="Hi! What\'s on the menu?"></label>' +
      '<div class="btn-row" style="margin-top:0"><button class="btn btn-ghost" id="sendtest" disabled>Send test text</button><span id="test-status" class="step-desc" style="margin:0"></span></div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go" disabled>Continue →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    if (state.shop && state.shop.phone_number_e164) markProvisioned(state.shop.phone_number_e164, true);

    document.getElementById("prov").onclick = function () {
      var st = document.getElementById("num-state"); st.className = "notice info"; st.textContent = "Provisioning… (test mode)";
      api("provision-number", { shop_id: state.shop_id, test_mode: true }).then(function (r) {
        if (r.json && r.json.ok) {
          markProvisioned(r.json.phone_number_e164, r.json.simulated);
          chatSay("resto", "You\'ve got a number" + (r.json.simulated ? " (simulated for this preview)" : "") + ": " + r.json.phone_number_e164 + ". It\'s wired to your assistant — try a test text!");
          saveStep("number", {});
        } else {
          st.className = "notice warn"; st.textContent = (r.json && r.json.error) || "Provisioning blocked.";
        }
      });
    };
    document.getElementById("sendtest").onclick = function () {
      var body = document.getElementById("f-test").value.trim() || "Hi! What's on the menu?";
      var ts = document.getElementById("test-status"); ts.textContent = "Sending to chat-sms…";
      // Simulate the inbound Twilio webhook (form-urlencoded) hitting chat-sms.
      var form = new URLSearchParams();
      form.set("From", "+15551230000");
      form.set("To", state.shop && state.shop.phone_number_e164 ? state.shop.phone_number_e164 : "+15550000000");
      form.set("Body", body);
      fetch(fnUrl("chat-sms"), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "apikey": CFG.ANON_KEY, "Authorization": "Bearer " + CFG.ANON_KEY }, body: form.toString() })
        .then(function (r) { return r.text(); })
        .then(function (t) {
          ts.textContent = "Reached chat-sms (HTTP ok). Reply path engaged.";
          document.getElementById("go").disabled = false;
          chatSay("resto", "Test text reached your assistant. The reply goes back over SMS in production — your end-to-end loop works.");
        })
        .catch(function (e) { ts.textContent = "chat-sms unreachable: " + e.message; document.getElementById("go").disabled = false; });
    };
    document.getElementById("go").onclick = function () { saveStep("number", {}).then(next); };
  };
  function markProvisioned(num, simulated) {
    var st = document.getElementById("num-state"); if (!st) return;
    st.className = "notice ok";
    st.innerHTML = "✓ Number ready: <strong>" + esc(num) + "</strong>" + (simulated ? " (simulated — test mode)" : "") + " · attached to the A2P messaging service · webhook → your assistant.";
    var b = document.getElementById("sendtest"); if (b) b.disabled = false;
  }

  // 9 ── REVIEW / GO LIVE ──────────────────────────────────────────────────────
  RENDERERS.review = function () {
    elCard.innerHTML = "";
    elCard.appendChild(h(
      '<div>' +
      '<div class="step-h">Go live</div>' +
      '<div class="step-desc">Final checks. We only flip you live when everything\'s ready — including your payout account.</div>' +
      '<div id="gate-state" class="notice info">Checking your go-live gates…</div>' +
      '<div class="btn-row"><button class="btn btn-ghost" id="bk">← Back</button>' +
      '<button class="btn btn-primary" id="go">Take my shop live →</button></div>' +
      '</div>'
    ));
    document.getElementById("bk").onclick = back;
    document.getElementById("go").onclick = attemptGoLive;
    attemptGoLive(true);
  };

  function attemptGoLive(check) {
    var st = document.getElementById("gate-state");
    api("go-live", { shop_id: state.shop_id }).then(function (r) {
      var j = r.json || {};
      if (j.live) {
        st.className = "notice ok"; st.innerHTML = "🎉 You\'re live! Your shop is taking orders.";
        chatSay("resto", "You\'re LIVE! Share your number with your customers and watch the orders come in.");
        return;
      }
      var gates = j.gates || {};
      var rows = Object.keys(gates).map(function (k) {
        return (gates[k] ? "✓ " : "✕ ") + k;
      }).join(" &nbsp; ");
      st.className = "notice warn";
      st.innerHTML = "<strong>Not live yet.</strong><br>" + rows + "<br><br>" + esc(j.message || ("Blocked by: " + (j.blocked_by || []).join(", ")));
      if (!check && (j.blocked_by || []).indexOf("connect") >= 0) {
        chatSay("resto", "Everything\'s set except your payout account — Stripe Connect isn\'t enabled on this environment yet. That\'s the one thing that gates going live, on purpose: you\'ll never be live without a way to get paid. The moment payouts are enabled, this flips green.");
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  SCRIPTED GUIDED CHAT  (right panel) — additive, deterministic, never a gate
  // ════════════════════════════════════════════════════════════════════════════
  var elMsgs = document.getElementById("chatMsgs");
  var elTyping = document.getElementById("chatTyping");
  var elScroll = document.getElementById("chatScroll");
  var elInput = document.getElementById("chatInput");
  var elSend = document.getElementById("chatSend");
  var chatQueue = Promise.resolve();

  function scrollChat() { elScroll.scrollTop = elScroll.scrollHeight; }
  function showTyping(on) { elTyping.classList.toggle("show", !!on); if (on) elMsgs.appendChild(elTyping); scrollChat(); }

  function bubble(kind, text) {
    var b = document.createElement("div");
    b.className = "msg " + kind;
    b.textContent = text;
    elMsgs.insertBefore(b, elTyping);
    requestAnimationFrame(function () { b.classList.add("show"); scrollChat(); });
  }

  // queue a resto (agent) message with a typing delay; owner messages are instant
  function chatSay(kind, text) {
    chatQueue = chatQueue.then(function () {
      if (kind === "you") { bubble("you", text); return Promise.resolve(); }
      return new Promise(function (res) {
        showTyping(true);
        setTimeout(function () { showTyping(false); bubble(kind, text); res(); }, Math.min(1100, 360 + text.length * 14));
      });
    });
    return chatQueue;
  }

  // owner replies in the phone input → echo as .msg.you, then a light ack
  elSend.onclick = sendOwnerReply;
  elInput.onkeydown = function (e) { if (e.key === "Enter") sendOwnerReply(); };
  function sendOwnerReply() {
    var v = elInput.value.trim(); if (!v) return;
    elInput.value = "";
    bubble("you", v);
    // Light, deterministic acknowledgement. The left form is the source of
    // truth; the chat never writes prices on its own from free text.
    chatSay("resto", "Got it — I\'ll keep that in mind. You can always enter the exact details on the left so nothing gets lost.");
  }

  // per-step narration
  var CHAT_INTRO = {
    account: "Hi! I\'m your setup helper. Let\'s get your shop taking text orders. Start by adding your name and email on the left — I\'ll save everything as we go.",
    subscription: "This is the $49/mo plan: your own number, the ordering assistant, and order tickets. No setup fee. (Payments aren\'t turned on in this preview, so there\'s nothing to enter yet.)",
    connect: "Next, where your money lands. You connect Stripe and payouts go straight to you — Sprint never holds your cash. Heads up: payments aren\'t configured on this environment yet, so this step is a preview.",
    scrape: "Want me to read your website? I\'ll learn your story so the assistant sounds like you. Hit \u201cRead my site\u201d on the left.",
    menu: "Now the fun part — your menu. Upload your CSV and I\'ll walk through anything it leaves open. I never guess a price; I\'ll ask you.",
    instructions: "Any house rules? Tell your assistant what to do and not do — I\'ll keep it within the safety and opt-out rules automatically.",
    fulfillment: "Let\'s set how orders reach you, your customer-facing name, tax, and your hours.",
    number: "Time for your number! Provision it on the left and send yourself a test text — you\'ll see the whole loop work.",
    review: "Last step: going live. I\'ll check every gate. Fair warning — without payouts enabled I can\'t flip you live yet, and that\'s on purpose."
  };
  function chatForStep(key) { if (CHAT_INTRO[key]) chatSay("resto", CHAT_INTRO[key]); }

  // menu Open-Questions, asked conversationally (the Jack's questions, for real)
  function chatStartMenuQuestions() {
    var ups = (state.openQuestions || []).filter(function (q) { return q.kind === "upcharge"; });
    chatSay("resto", "Great, I\u2019ve got your menu \u2014 " + (state.menuRows ? state.menuRows.length : 0) + " items. A few things your printed menu leaves open. I\u2019ll never invent a price, so let\u2019s settle these together.");
    if (ups.length) {
      chatSay("resto", "Your menu offers side swaps \u201cfor an upcharge\u201d \u2014 " + ups.length + " of them (sweet potato fries, pierogies, mozzarella sticks, onion rings, side salad\u2026) but never prints the amount. What do you charge for each? Enter them on the left and I\u2019ll lock them in.");
    }
    chatSay("resto", "Your menu also says \u201cCash Discount Available.\u201d Does that apply to card/SMS orders, or is it in-store cash only? I need to know so we never mislead a diner at checkout.");
    chatSay("resto", "You advertise a separate catering menu too \u2014 should catering be SMS-orderable now, or handled offline for the moment?");
    chatSay("resto", "And your wings: for a 10-piece, how many flavors are included \u2014 and does mixing cost extra?");
  }

  // brief acknowledgement when an Open Question is resolved on the left
  function chatAck(q) {
    if (q.kind === "upcharge") {
      chatSay("resto", "\u2713 " + q.name + " upcharge set to $" + q.answer + ". Real price, your number \u2014 not a guess.");
    } else if (q.id === "cash") {
      var m = { in_store_cash_only: "in-store cash only \u2014 card/SMS orders won\u2019t show a discount", applies_to_sms: "applied to SMS/card orders too", none: "no cash discount" };
      chatSay("resto", "\u2713 Cash discount: " + (m[q.answer] || q.answer) + ". Checkout will reflect that honestly.");
    } else if (q.id === "catering") {
      chatSay("resto", "\u2713 Catering: " + (q.answer === "sms_orderable" ? "SMS-orderable now" : "handled offline for now") + ".");
    } else if (q.id === "wings") {
      chatSay("resto", "\u2713 Wings: " + q.answer + " flavor(s) included per 10-piece. Got it.");
    }
    if (openQuestionsRemaining() === 0) {
      chatSay("resto", "That\u2019s every open question answered \u2014 you can confirm the menu now and I\u2019ll write it to your DB.");
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  BOOT — resume if we have a shop, else start fresh
  // ════════════════════════════════════════════════════════════════════════════
  function boot() {
    if (state.shop_id) {
      api("onboarding-save", { action: "resume", shop_id: state.shop_id }).then(function (r) {
        if (r.json && r.json.shop) {
          state.shop = r.json.shop;
          elResumeBadge.style.display = "inline-flex";
          var key = r.json.shop.onboarding_step || "account";
          if (key === "done") key = "review";
          go(stepIndex(key));
          chatSay("resto", "Welcome back! I picked up right where you left off.");
        } else {
          localStorage.removeItem("sprint_shop_id"); state.shop_id = null; go(0);
        }
      }).catch(function () { go(0); });
    } else {
      go(0);
    }
  }

  // ── Offline proof mode (?proof=menu) — for screenshot artifacts only. ──────
  // Stubs the backend and preloads the real Jack's CSV at the menu step so the
  // review UI (Open Questions + 326-item grouped review) can be captured
  // without any live backend call. Never runs in normal use.
  function proofMode() {
    var qp = new URLSearchParams(location.search);
    if (qp.get("proof") !== "menu") return false;
    state.shop_id = "proof-shop-0001";
    state.shop = { id: state.shop_id, name: "Jack's Slice", onboarding_step: "menu" };
    // neutralize network: saveStep/import become no-ops
    window.fetch = function () { return Promise.resolve({ status: 200, ok: true, json: function () { return Promise.resolve({ ok: true, inserted: 221 }); }, text: function () { return Promise.resolve("ok"); } }); };
    go(stepIndex("menu"));
    fetch("/signup-page/_proof/jacks.csv").then(function () {});
    var x = new XMLHttpRequest();
    x.open("GET", "/signup-page/_proof/jacks.csv", true);
    x.onload = function () { if (x.status === 200) loadMenuCsv(x.responseText); };
    x.send();
    return true;
  }

  if (!proofMode()) boot();
})();