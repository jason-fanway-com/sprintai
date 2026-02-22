const twilio = require("twilio");

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || "+16103792553";
const JASON_CELL = process.env.FORWARD_TO_NUMBER || "+16102565023";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    // Parse form-encoded body from Twilio
    const params = new URLSearchParams(event.body);
    const from = params.get("From") || "unknown";
    const body = params.get("Body") || "";

    console.log(`Inbound SMS from ${from}: ${body}`);

    // Forward to Jason
    const client = twilio(TWILIO_SID, TWILIO_AUTH);
    await client.messages.create({
      to: JASON_CELL,
      from: TWILIO_FROM,
      body: `SprintAI lead reply from ${from}: ${body}`,
    });

    console.log("Forwarded to Jason successfully");

    // Return empty TwiML (no auto-reply)
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    };
  } catch (err) {
    console.error("SMS forward error:", err);
    // Still return valid TwiML so Twilio doesn't retry
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    };
  }
};
