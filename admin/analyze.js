// Site Analysis for SprintAI CRM
// Runs a lightweight audit of a company's website via fetch

async function analyzeSite(companyId, website) {
  if (!website) { showToast('No website URL', 'error'); return null; }
  
  // Normalize URL
  let url = website;
  if (!url.startsWith('http')) url = 'https://' + url;
  
  const analysis = {
    url: url,
    analyzed_at: new Date().toISOString(),
    scores: {},
    issues: [],
    opportunities: [],
    talking_points: [],
    overall_grade: '',
  };

  try {
    // We can't fetch external sites from browser due to CORS
    // Instead, use a Netlify function proxy or just do basic checks
    // For now, do what we CAN check from the browser:
    
    // 1. HTTPS check
    const isHttps = url.startsWith('https://');
    analysis.scores.ssl = isHttps ? 100 : 0;
    if (!isHttps) {
      analysis.issues.push('❌ No SSL/HTTPS — site is not secure. Google penalizes this in rankings.');
      analysis.opportunities.push('Install SSL certificate — most hosting providers offer free Let\'s Encrypt certs');
      analysis.talking_points.push('Your site isn\'t running on HTTPS. That means Google is actually pushing you DOWN in search results, and customers see a "Not Secure" warning in their browser. We can fix that.');
    }

    // 2. Try to fetch via our proxy function
    const proxyUrl = `/.netlify/functions/site-check?url=${encodeURIComponent(url)}`;
    let siteData = null;
    try {
      const resp = await fetch(proxyUrl);
      if (resp.ok) {
        siteData = await resp.json();
      }
    } catch(e) {
      // Proxy not available, use defaults
    }

    if (siteData) {
      // Parse proxy results
      if (siteData.has_chat !== undefined) {
        analysis.scores.chat = siteData.has_chat ? 100 : 0;
        if (!siteData.has_chat) {
          analysis.issues.push('❌ No live chat — losing leads who want quick answers');
          analysis.opportunities.push('AI chat widget that answers common questions 24/7 and captures leads');
          analysis.talking_points.push('I noticed you don\'t have a chat widget on your site. HVAC customers usually want a quick answer — "can you come today?" or "how much for a tune-up?" Without chat, those people just hit the back button and call the next guy.');
        }
      }
      if (siteData.has_scheduling !== undefined) {
        analysis.scores.scheduling = siteData.has_scheduling ? 100 : 0;
        if (!siteData.has_scheduling) {
          analysis.issues.push('❌ No online scheduling — customers can\'t book without calling');
          analysis.opportunities.push('Online booking system integrated with your calendar');
          analysis.talking_points.push('There\'s no way for a customer to book an appointment on your site without picking up the phone. A lot of homeowners, especially younger ones, prefer to just click a button and schedule online.');
        }
      }
      if (siteData.mobile_friendly !== undefined) {
        analysis.scores.mobile = siteData.mobile_friendly ? 100 : 0;
        if (!siteData.mobile_friendly) {
          analysis.issues.push('❌ Not mobile-friendly — 60%+ of HVAC searches happen on phones');
          analysis.opportunities.push('Responsive mobile-first website redesign');
          analysis.talking_points.push('Your site doesn\'t look great on a phone. Over 60% of people searching for HVAC help are doing it from their phone — when the AC breaks at 2am, they\'re not at a desktop. You\'re losing those people.');
        }
      }
      if (siteData.load_time_ms) {
        analysis.scores.speed = siteData.load_time_ms < 3000 ? 100 : siteData.load_time_ms < 5000 ? 50 : 0;
        if (siteData.load_time_ms > 3000) {
          analysis.issues.push(`⚠️ Slow load time (${(siteData.load_time_ms/1000).toFixed(1)}s) — Google recommends under 3s`);
          analysis.opportunities.push('Optimize images, enable caching, improve hosting');
          analysis.talking_points.push(`Your site takes about ${(siteData.load_time_ms/1000).toFixed(1)} seconds to load. Google wants it under 3. Every second over that, you lose about 10% of visitors — they just bounce.`);
        }
      }
      if (siteData.has_schema !== undefined) {
        analysis.scores.schema = siteData.has_schema ? 100 : 0;
        if (!siteData.has_schema) {
          analysis.issues.push('❌ No structured data (Schema.org) — missing rich search results');
          analysis.opportunities.push('Add LocalBusiness schema for enhanced Google listing');
        }
      }
      if (siteData.has_blog !== undefined) {
        analysis.scores.blog = siteData.has_blog ? 100 : 0;
        if (!siteData.has_blog) {
          analysis.issues.push('⚠️ No blog — missing organic search traffic opportunity');
          analysis.opportunities.push('Monthly blog posts targeting "HVAC near me", seasonal maintenance tips, etc.');
          analysis.talking_points.push('You don\'t have a blog. That\'s a huge missed opportunity for showing up in Google when people search things like "AC not cooling" or "furnace maintenance tips." Those searches lead to phone calls.');
        }
      }
      if (siteData.has_reviews_page !== undefined) {
        analysis.scores.reviews = siteData.has_reviews_page ? 100 : 0;
      }
      if (siteData.has_click_to_call !== undefined) {
        analysis.scores.click_to_call = siteData.has_click_to_call ? 100 : 0;
        if (!siteData.has_click_to_call) {
          analysis.issues.push('❌ No click-to-call button — mobile users can\'t tap to dial');
          analysis.opportunities.push('Add prominent click-to-call button in header and throughout site');
          analysis.talking_points.push('Your phone number isn\'t set up as a click-to-call button. On mobile, people should be able to tap your number and it dials immediately. Right now they\'d have to memorize it and switch to their phone app.');
        }
      }
    } else {
      // Fallback: generate generic HVAC analysis
      analysis.issues.push('⚠️ Full site analysis pending — run scorecard for detailed results');
      analysis.talking_points.push('We looked at your digital presence and there are some quick wins that could help you show up more in Google and convert more visitors into calls.');
      analysis.talking_points.push('Most HVAC companies we work with are missing 3-4 key things: a modern mobile site, online chat, booking, and a blog that brings in organic traffic.');
      analysis.talking_points.push('We start at $99/month with a modern website. From there we can add chat, social media, blog, and AI automations as you grow.');
    }

    // Calculate overall grade
    const scoreValues = Object.values(analysis.scores);
    if (scoreValues.length > 0) {
      const avg = scoreValues.reduce((a,b) => a+b, 0) / scoreValues.length;
      if (avg >= 80) analysis.overall_grade = 'A';
      else if (avg >= 60) analysis.overall_grade = 'B';
      else if (avg >= 40) analysis.overall_grade = 'C';
      else if (avg >= 20) analysis.overall_grade = 'D';
      else analysis.overall_grade = 'F';
    }

    // Always include the SprintAI pitch
    analysis.opportunities.push('Modern HVAC digital presence: website + chat + social + blog + Google management, starting at $99/mo');

  } catch(e) {
    analysis.issues.push('Error analyzing site: ' + e.message);
  }

  // Save to Supabase
  const { error } = await db.from('crm_companies').update({ 
    site_analysis: analysis,
    updated_at: new Date().toISOString()
  }).eq('id', companyId);
  
  if (error) {
    showToast('Failed to save analysis: ' + error.message, 'error');
  } else {
    showToast('Site analysis complete');
  }
  
  return analysis;
}

function renderSiteAnalysis(analysis) {
  if (!analysis) return '<p class="text-sm text-gray-400">No site analysis yet. Click "Analyze Site" to run.</p>';
  
  const gradeColors = { A: 'text-green-600 bg-green-50', B: 'text-blue-600 bg-blue-50', C: 'text-yellow-600 bg-yellow-50', D: 'text-orange-600 bg-orange-50', F: 'text-red-600 bg-red-50' };
  const gradeColor = gradeColors[analysis.overall_grade] || 'text-gray-600 bg-gray-50';
  
  let html = `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="text-3xl font-bold px-4 py-2 rounded-lg ${gradeColor}">${analysis.overall_grade || '?'}</span>
          <div>
            <div class="text-sm font-medium text-gray-900">Site Grade</div>
            <div class="text-xs text-gray-500">Analyzed ${analysis.analyzed_at ? new Date(analysis.analyzed_at).toLocaleDateString() : 'N/A'}</div>
          </div>
        </div>
        <a href="${analysis.url}" target="_blank" class="text-indigo-600 text-sm hover:underline">Visit Site →</a>
      </div>`;
  
  // Score bars
  if (Object.keys(analysis.scores || {}).length > 0) {
    html += '<div class="grid grid-cols-2 gap-2">';
    const scoreLabels = { ssl: '🔒 SSL/HTTPS', chat: '💬 Live Chat', scheduling: '📅 Online Booking', mobile: '📱 Mobile', speed: '⚡ Speed', schema: '📋 Schema/SEO', blog: '📝 Blog', reviews: '⭐ Reviews', click_to_call: '📞 Click-to-Call' };
    for (const [key, val] of Object.entries(analysis.scores)) {
      const color = val >= 80 ? 'bg-green-500' : val >= 40 ? 'bg-yellow-500' : 'bg-red-500';
      const label = scoreLabels[key] || key;
      html += `<div class="flex items-center gap-2">
        <span class="text-xs w-28 truncate">${label}</span>
        <div class="flex-1 bg-gray-200 rounded-full h-2"><div class="${color} h-2 rounded-full" style="width:${val}%"></div></div>
        <span class="text-xs w-6 text-right ${val >= 80 ? 'text-green-600' : val >= 40 ? 'text-yellow-600' : 'text-red-600'}">${val >= 80 ? '✓' : '✗'}</span>
      </div>`;
    }
    html += '</div>';
  }
  
  // Issues
  if (analysis.issues && analysis.issues.length > 0) {
    html += '<div><h4 class="text-sm font-semibold text-gray-700 mb-2">Issues Found</h4><ul class="space-y-1">';
    analysis.issues.forEach(i => { html += `<li class="text-sm text-gray-600">${escapeHtml(i)}</li>`; });
    html += '</ul></div>';
  }
  
  // Talking points (the money section for sales calls)
  if (analysis.talking_points && analysis.talking_points.length > 0) {
    html += `<div class="bg-indigo-50 rounded-lg p-4">
      <h4 class="text-sm font-semibold text-indigo-700 mb-2">📞 Call Talking Points</h4>
      <ul class="space-y-2">`;
    analysis.talking_points.forEach(tp => {
      html += `<li class="text-sm text-indigo-900 flex items-start gap-2">
        <span class="text-indigo-400 mt-0.5">▸</span>
        <span>${escapeHtml(tp)}</span>
        <button onclick="navigator.clipboard.writeText(this.parentElement.querySelector('span:nth-child(2)').textContent);showToast('Copied!')" class="text-indigo-500 hover:text-indigo-700 text-xs shrink-0">Copy</button>
      </li>`;
    });
    html += '</ul></div>';
  }
  
  // Opportunities
  if (analysis.opportunities && analysis.opportunities.length > 0) {
    html += '<div><h4 class="text-sm font-semibold text-gray-700 mb-2">💡 Opportunities</h4><ul class="space-y-1">';
    analysis.opportunities.forEach(o => { html += `<li class="text-sm text-gray-600 flex items-center gap-2"><span class="text-green-500">+</span> ${escapeHtml(o)}</li>`; });
    html += '</ul></div>';
  }
  
  html += '</div>';
  return html;
}
