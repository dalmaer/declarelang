import { helpers } from "./lib.mjs";
export default async (ctx) => {
  const { page, sleep, shot, role, text } = ctx;
  const h = helpers(ctx);
  await h.pickPerf("Friday 11 December");
  const got = await h.pickSeats(2, "Balcony");
  console.log("chosen", got);
  await role("button", "Continue to payment").click(); await sleep(500);
  await h.fill("Email", "x@example.com"); await h.fill("Name on card", "X Y");
  await h.fill("Card number", "4242424242424242"); await h.fill("Expiry (MM / YY)", "0129"); await h.fill("Security code", "123");
  await h.fill("Street address", "1 A St"); await h.fill("City", "NYC"); await h.fill("Postal code", "10002");
  const ids = await page.evaluate(() => window.__declare.find("app").chosen.slice());
  // someone else buys the first seat behind the app's back
  const r = await page.evaluate(async (id) => (await fetch("http://127.0.0.1:8350/api/orders", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ performanceId: "p17", seatIds: [id], email: "o@x.com", payment: { card: { number: "4242424242424242", expMonth: 1, expYear: 2030, cvc: "123", name: "O" }, billing: { line1: "a", line2: null, city: "b", postalCode: "10002", country: "US" } } }) })).status, ids[0]);
  console.log("other purchase:", r);
  await sleep(2500);
  console.log("chosen after stream:", await page.evaluate(() => window.__declare.find("app").chosen.slice()));
  console.log("notice:", (await text()).match(/.*taken by someone else.*/)?.[0]);
  await shot("x-taken.png");
  // force the stale choice to see the service's refusal
  await page.evaluate((ids) => { window.__declare.find("app").chosen = ids; }, ids);
  await sleep(200);
  const pay = (await page.evaluate(() => [...document.querySelectorAll("[role=button],button")].map((e) => e.getAttribute("aria-label") || e.textContent).filter((n) => n.startsWith("Pay"))));
  await (await page.$(`::-p-aria(${pay[0]})`)).click(); await sleep(2600);
  console.log("chosen after 409:", await page.evaluate(() => window.__declare.find("app").chosen.slice()), "location:", await page.evaluate(() => window.__declare.find("app").location));
  console.log("msg:", (await text()).match(/.*(no longer|taken|available).*/gi));
  await shot("x-409.png");
};
