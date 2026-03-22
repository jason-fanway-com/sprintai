const https = require('https');
const http = require('http');

exports.handler = async (event) => {
  const url = event.queryStringParameters?.url;
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'url required' }) };

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const startTime = Date.now();
    const html = await fetchPage(url, 8000);
    const loadTime = Date.now() - startTime;
    const lower = html.toLowerCase();

    const result = {
      url,
      load_time_ms: loadTime,
      content_length: html.length,
      has_ssl: url.startsWith('https'),
      mobile_friendly: lower.includes('viewport') && lower.includes('width=device-width'),
      has_chat: /livechat|tawk\.to|drift|intercom|hubspot|crisp|zendesk|chatbot|chat-widget|chatwoot|tidio|olark/i.test(html),
      has_scheduling: /book.*appointment|schedule.*service|booking|calendly|housecall|jobber|service\s*titan|setmore|acuity/i.test(html),
      has_schema: /application\/ld\+json|schema\.org|itemtype/i.test(html),
      has_blog: /\/blog|\/news|\/articles|\/resources|\/tips/i.test(html),
      has_reviews_page: /testimonial|review|customer.*stories/i.test(html),
      has_click_to_call: /tel:[\+\d]/i.test(html),
      has_social: /facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com/i.test(html),
      has_google_maps: /maps\.google|google\.com\/maps|goo\.gl\/maps/i.test(html),
      has_ssl_cert: url.startsWith('https'),
      has_favicon: /rel=["'](?:shortcut )?icon/i.test(html),
      has_analytics: /google-analytics|gtag|googletagmanager|analytics\.js|ga\.js/i.test(html),
      title: (html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || '',
      meta_description: (html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i) || [])[1] || '',
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message, url }) };
  }
};

function fetchPage(url, timeout) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { 
      timeout,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SprintAI SiteCheck/1.0)' },
      rejectUnauthorized: false,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const parsed = new URL(url);
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        fetchPage(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; if (data.length > 500000) req.abort(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.abort(); reject(new Error('Timeout')); });
  });
}
