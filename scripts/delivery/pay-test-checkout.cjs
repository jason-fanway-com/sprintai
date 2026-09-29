// pay-test-checkout.cjs — pay a Stripe TEST-mode checkout link with Stripe's public test card (4242...).
// Refuses any page that is not Stripe test mode. usage: node pay-test-checkout.cjs <pay url>
const path = require("path");
const PW = process.env.PLAYWRIGHT_MODULE || path.join(process.env.HOME, ".npm/_npx/e41f203b7505f1fb/node_modules/playwright");
const { chromium } = require(PW);
(async () => {
  const url = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const body = await page.content();
    if (!/test mode|TEST MODE|testmode|"livemode":false/i.test(body)) throw new Error("not a Stripe test-mode page; refusing to pay");
    const fill = async (sel, v) => { const el = page.locator(sel).first(); if (await el.count()) await el.fill(v); };
    await fill("#email", "e2e-test@orderfare.example");
    const cardTab = page.locator('[data-testid="card-accordion-item-button"]'); if (await cardTab.count()) await cardTab.first().click();
    await page.locator("#cardNumber").waitFor({ timeout: 30000 });
    await fill("#cardNumber", "4242 4242 4242 4242");
    await fill("#cardExpiry", "12 / 34");
    await fill("#cardCvc", "123");
    await fill("#billingName", "E2E Test");
    await fill("#billingPostalCode", "18103");
    const phoneOptOut = page.locator("#enableStripePass"); if (await phoneOptOut.count() && await phoneOptOut.isChecked()) await phoneOptOut.uncheck();
    await page.locator('[data-testid="hosted-payment-submit-button"], button[type="submit"]').first().click();
    await page.waitForURL((u) => !/checkout\.stripe\.com/.test(u.toString()), { timeout: 90000 });
    console.log("PAID ->", page.url().split("?")[0]);
  } catch (e) {
    await page.screenshot({ path: path.join(process.env.TMPDIR || "/tmp", "pay-test-checkout-fail.png"), fullPage: true }).catch(() => {});
    console.error("PAY FAILED:", e.message);
    process.exitCode = 1;
  } finally { await browser.close(); }
})();
