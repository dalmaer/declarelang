// Desk, keyboard alone: pick a night, two seats, a new card, pay.
import { open, textOn, sleep } from "./lib.mjs";

const { browser, page, sent } = await open();
const focused = () => page.evaluate(() => {
  const a = document.activeElement;
  return a ? (a.getAttribute("aria-label") || a.innerText || a.tagName).slice(0, 60) + " [" + (a.getAttribute("role") || a.tagName) + "]" : "none";
});
const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await sleep(60); } };
const tabTo = async (re, max = 60) => {
  for (let i = 0; i < max; i++) { await key("Tab"); const f = await focused(); if (re.test(f)) return f; }
  throw new Error("never reached " + re + "; at " + (await focused()));
};
try {
  console.log("1:", await tabTo(/^Sat 28 Nov/));
  await key("Enter");
  await sleep(1500);
  console.log("2:", await tabTo(/seat \d+/));
  // walk to a free seat: arrows skip what is taken
  await key("ArrowRight", 3);
  const a = await focused();
  await key(" ");
  await key("ArrowRight");
  const b = await focused();
  await key(" ");
  console.log("chose:", a, "|", b);
  console.log("summary:", await textOn(page, /2 seats · \$[\d.,]+/));
  console.log("focus still on:", await focused());
  console.log("3:", await tabTo(/^Checkout/));
  await key("Enter");
  await sleep(800);
  console.log("focus after Checkout:", await focused());
  const typeIn = async (re, text) => { console.log("  ", await tabTo(re)); await page.keyboard.type(text, { delay: 10 }); };
  await typeIn(/^Email \[/, "kb@example.com");
  await typeIn(/^Name on card/, "Key Board");
  await typeIn(/^Card number/, "378282246310005");
  await typeIn(/^Expiry/, "0331");
  await typeIn(/^Security code/, "1234");
  console.log("  country:", await tabTo(/United States|Canada|United Kingdom/));
  await key("ArrowRight"); await key(" "); // Canada
  console.log("  country now:", await focused());
  await typeIn(/^Street address/, "1 Bay St");
  await typeIn(/^City/, "Toronto");
  await typeIn(/^Postal code/, "m5v2t6");
  console.log("4:", await tabTo(/^Pay \$/));
  await key("Enter");
  // the service refuses this postcode for the card: the field is marked and focused
  const msg = await textOn(page, /postal code[^\n]*match[^\n]*|doesn't match[^\n]*/i, { timeout: 8000 });
  console.log("422:", msg, "| focus:", await focused());
  await page.keyboard.type("M5H 2N2", { delay: 10 });
  await key("Enter");
  console.log(await textOn(page, /Sent to kb@example\.com/, { timeout: 10000 }));
  await sleep(500);
  console.log("focus on tickets:", await focused());
  console.log("orders:", sent.filter((r) => r.url.endsWith("/api/orders")).map((r) => JSON.parse(r.body).payment.billing.postalCode));
  await page.screenshot({ path: "/tmp/venue-shots/e2e-kb-tickets.png" });
  console.log("OK");
} catch (e) {
  console.log("FAILED", e.message);
  await page.screenshot({ path: "/tmp/venue-shots/e2e-kb-fail.png" });
} finally { await browser.close(); }
