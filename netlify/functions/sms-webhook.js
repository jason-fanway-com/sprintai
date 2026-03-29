// SprintAI SMS Pipeline — Twilio Webhook Handler (Netlify Function)
// Receives incoming SMS from Twilio, forwards to Jason, detects affirmative replies,
// looks up lead data, and sends hot lead email notification.
//
// Deploy as: netlify/functions/sms-webhook.js on getsprintai.com
//
// Twilio Webhook URL: https://getsprintai.com/.netlify/functions/sms-webhook

const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_PHONE = process.env.TWILIO_PHONE || '+16103792553';
const JASON_PHONE = '+16102565023';
const NOTIFICATION_EMAIL = 'joe.strazza@fanway.com';

// Affirmative patterns
const AFFIRMATIVE_PATTERNS = [
  /^(yes|yeah|yea|yep|yup|ya|ye|y)[\s!.?]*$/i,
  /^(sure|ok|okay|k|sounds good|sounds great)[\s!.?]*$/i,
  /^(show me|interested|tell me more|let's do it|let's go)[\s!.?]*$/i,
  /^(absolutely|definitely|for sure|of course|why not)[\s!.?]*$/i,
  /^(i'm interested|im interested|i am interested)[\s!.?]*$/i,
  /^(send it|go ahead|please|sign me up|let's see)[\s!.?]*$/i,
  /\b(interested|yes please|sounds good|sounds great|show me)\b/i,
];

// ─── Leads Lookup ──────────────────────────────────────────────────────────

let leadsLookup = {};
try {
  const lookupPath = path.join(__dirname, 'leads-lookup.json');
  if (fs.existsSync(lookupPath)) {
    leadsLookup = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
    console.log(`📞 Loaded ${Object.keys(leadsLookup).length} leads for lookup`);
  }
} catch (e) {
  console.error('⚠️ Failed to load leads-lookup.json:', e.message);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return phone;
}

function isAffirmative(text) {
  if (!text) return false;
  const cleaned = text.trim();
  return AFFIRMATIVE_PATTERNS.some(pattern => pattern.test(cleaned));
}

function lookupLead(phone) {
  const normalized = normalizePhone(phone);
  return leadsLookup[normalized] || null;
}

// Send SMS via Twilio REST API
function sendSms(to, body) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify({
      To: to,
      From: TWILIO_PHONE,
      Body: body,
    });

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

    const options = {
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length,
        'Authorization': `Basic ${auth}`,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`Twilio API error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Send email via SMTP (using nodemailer-like approach with raw HTTPS to a webhook)
// For simplicity in serverless, we'll use a simple notification approach
// The actual email sending happens in the process-yes.sh pipeline via msmtp

// ─── Handler ───────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'text/xml',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Method not allowed',
    };
  }

  // Parse Twilio POST body (application/x-www-form-urlencoded)
  let params;
  try {
    params = querystring.parse(event.body);
  } catch (e) {
    console.error('Failed to parse body:', e);
    return {
      statusCode: 400,
      headers,
      body: '<Response><Message>Error processing request</Message></Response>',
    };
  }

  const incomingBody = params.Body || '';
  const fromPhone = params.From || '';
  const toPhone = params.To || '';

  console.log(`📨 SMS from ${fromPhone}: "${incomingBody}"`);

  // Look up lead data
  const lead = lookupLead(fromPhone);
  const businessName = lead ? lead.business_name : 'Unknown Business';

  // Forward to Jason
  try {
    const forwardMsg = lead
      ? `📱 SMS from ${businessName} (${fromPhone}):\n"${incomingBody}"\n\nCity: ${lead.city}, ${lead.state}\nWebsite: ${lead.website || 'none'}\nRating: ${lead.rating || 'N/A'} ⭐ (${lead.google_reviews_count || '?'} reviews)`
      : `📱 SMS from ${fromPhone}:\n"${incomingBody}"`;

    await sendSms(JASON_PHONE, forwardMsg);
    console.log(`✅ Forwarded to Jason`);
  } catch (e) {
    console.error(`❌ Failed to forward to Jason:`, e.message);
  }

  // Check if affirmative
  if (isAffirmative(incomingBody)) {
    console.log(`🔥 AFFIRMATIVE RESPONSE detected from ${fromPhone} (${businessName})`);

    // Log to a webhook/file that the process-yes pipeline can pick up
    // In production, this would trigger the build pipeline
    // For now, we send an alert SMS to Jason and log it

    try {
      const alertMsg = lead
        ? `🔥 HOT LEAD! ${businessName} (${lead.city}, ${lead.state}) replied YES!\nPhone: ${fromPhone}\nWebsite: ${lead.website || 'none'}\n\nRun: ./process-yes.sh "${fromPhone}"`
        : `🔥 HOT LEAD! ${fromPhone} replied YES!\n\nRun: ./process-yes.sh "${fromPhone}"`;

      await sendSms(JASON_PHONE, alertMsg);
      console.log(`🔔 Hot lead alert sent to Jason`);
    } catch (e) {
      console.error(`❌ Failed to send hot lead alert:`, e.message);
    }

    // Return a warm response
    const replyMsg = lead
      ? `Thanks ${businessName.split(' ')[0]}! We're putting together a demo site for your business right now. You'll hear from Jason shortly with the link. 🚀`
      : `Thanks! We're putting together something special for you. You'll hear from us shortly! 🚀`;

    return {
      statusCode: 200,
      headers,
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replyMsg}</Message></Response>`,
    };
  }

  // Non-affirmative — still forward (already done above), send generic response
  // For STOP/unsubscribe, Twilio handles these automatically if Advanced Opt-Out is enabled
  const stopPatterns = /^(stop|unsubscribe|cancel|quit|end|remove)[\s!.?]*$/i;
  if (stopPatterns.test(incomingBody.trim())) {
    console.log(`🛑 STOP request from ${fromPhone}`);
    return {
      statusCode: 200,
      headers,
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>You've been unsubscribed. Reply START to re-subscribe. Have a great day!</Message></Response>`,
    };
  }

  // Generic reply for non-affirmative, non-stop messages
  return {
    statusCode: 200,
    headers,
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thanks for your message! Jason will get back to you shortly. - SprintAI</Message></Response>`,
  };
};
