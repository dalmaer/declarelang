// Phone: the brief's "what done looks like", end to end.
import { open, byRole, count, textOn, freeSeats, fill, valueOf, sleep, API } from "./lib.mjs";

const perf = process.argv[2] ?? "p01";
const { browser, page, sent } = await open({ phone: true });
const tapC = async (el) => { await el.evaluate((e) => e.scrollIntoView({ block: "center" })); await sleep(200); await el.tap(); };
const shot = (n) => page.screenshot({ path: `/tmp/venue-shots/e2e-phone-${n}.png` });
try {
  // someone else, buying through the same service
  const buyElsewhere = (seatId) => fetch(`${API}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ performanceId: perf, seatIds: [seatId], email: "other@example.com",
      payment: { card: { number: "4242424242424242", expMonth: 4, expYear: 2030, cvc: "123", name: "Someone Else" },
                 billing: { line1: "1 Road", line2: null, city: "Town", postalCode: "94110", country: "US" } } }) }).then((r) => r.status);

  await (await byRole(page, "button", "Fri 13 Nov, 7:30pm")).tap();
  await sleep(1200);
  await shot("1-hall");

  const orch = await freeSeats(perf, 2, "ORCH");
  const gt = await freeSeats(perf, 2, "GT");
  for (const s of [orch[0], orch[1], gt[0]]) {
    const b = await byRole(page, "button", s.name);
    await b.tap();
    await sleep(250);
  }
  console.log("after three:", await textOn(page, /3 seats · \$[\d.,]+/));

  // one of them goes to someone else while they decide
  console.log("other buyer:", await buyElsewhere(orch[1].id));
  console.log("notice:", await textOn(page, /was just taken by someone else\./, { timeout: 8000 }));
  console.log("after loss:", await textOn(page, /2 seats · \$[\d.,]+/));
  const gone = await (await byRole(page, "button", orch[1].name)).evaluate((e) => [e.getAttribute("aria-disabled"), e.getAttribute("aria-pressed")]);
  console.log("lost seat disabled/pressed:", gone);
  await shot("2-lost");

  // and they choose another
  await (await byRole(page, "button", gt[1].name)).tap();
  await sleep(300);
  const total3 = await textOn(page, /3 seats · \$[\d.,]+/);
  console.log("chose another:", total3);

  await (await byRole(page, "button", "Checkout")).tap();
  await sleep(600);
  await fill(page, "Email", "typed-before@example.com");
  await (await byRole(page, "button", "Sign in")).tap();
  await sleep(600);
  await shot("3-signin");
  await fill(page, "Email", "ada@example.com");
  await fill(page, "Password", "wrong one");
  await page.keyboard.press("Enter");
  await sleep(300);
  console.log("wrong password:", await textOn(page, /That email and password don't match\./));
  await fill(page, "Password", "correct horse battery");
  await (await byRole(page, "button", "Sign in")).tap();
  await textOn(page, /Signed in as ada@example\.com/);
  await sleep(500);
  console.log("email kept:", await valueOf(page, "Email").catch(() => "(hidden: saved card chosen)"));
  console.log("seats kept:", await textOn(page, /Pay \$[\d.,]+/));
  const visa = await byRole(page, "radio", "Visa ending 4242, Expires 04/28");
  const mc = await byRole(page, "radio", "Mastercard ending 4444, Expired 08/26");
  console.log("visa checked:", await visa.evaluate((e) => e.getAttribute("aria-checked")),
              "mc disabled:", await mc.evaluate((e) => e.getAttribute("aria-disabled")));
  await shot("4-saved");

  await fill(page, "Security code", "000");
  const payName = (await textOn(page, /Pay \$[\d.,]+/));
  await sleep(300);
  await (await byRole(page, "button", payName)).tap();
  console.log("declined:", await textOn(page, /declined[^\n]*/i, { timeout: 8000 }));
  await sleep(400)
  console.log("focus after decline:", await page.evaluate(() => {
    const a = document.activeElement, r = a.getBoundingClientRect();
    const pay = [...document.querySelectorAll("[role=button]")].find((b) => /^Pay \$/.test(b.getAttribute("aria-label") || b.innerText));
    return [a.getAttribute("aria-label"), Math.round(r.top), Math.round(r.bottom), "bar top", Math.round(pay.getBoundingClientRect().top)];
  }))
  console.log("cvc after decline:", JSON.stringify(await valueOf(page, "Security code")));
  await shot("5-declined");

  // a new card
  await tapC(await byRole(page, "radio", "A new card, Enter its details below"));
  await sleep(300);
  console.log("email/name prefilled:", await valueOf(page, "Email"), "/", await valueOf(page, "Name on card"));
  const num = await fill(page, "Card number", "5555555555554444");
  console.log("grouped:", await valueOf(page, "Card number"));
  await fill(page, "Expiry", "0929");
  await fill(page, "Security code", "321");
  console.log("street/city/postcode:", await valueOf(page, "Street address"), "/", await valueOf(page, "City"), "/", await valueOf(page, "Postal code"));
  await fill(page, "Postal code", "WC1N 1A");
  console.log("state:", await page.evaluate(() => [__declare.explain("app.checkout", "attempted").value, JSON.stringify(__declare.explain("app.checkout", "touched").value)]));
  console.log("error while typing?:", (await page.evaluate(() => document.body.innerText)).includes("isn't a UK postcode"));
  await (await byRole(page, "textbox", "Street address")).tap();
  console.log("error on leaving:", await textOn(page, /That isn't a UK postcode[^\n]*/));
  await shot("6-postcode");
  await fill(page, "Postal code", "WC1N 1AB");
  await sleep(200);
  console.log("error cleared:", !(await page.evaluate(() => document.body.innerText)).includes("isn't a UK postcode"));
  await sleep(300);
  await (await byRole(page, "button", payName)).tap();
  console.log(await textOn(page, /Sent to [^\n]+/, { timeout: 10000 }));
  await sleep(600);
  await shot("7-tickets");
  const orders = sent.filter((r) => r.method == "POST" && r.url.endsWith("/api/orders"));
  console.log("orders sent:", orders.length);
  orders.forEach((o) => console.log("  ", o.body));
  console.log("OK");
} catch (e) {
  console.log("FAILED", e.message);
  console.log("sent:", sent.filter((r) => r.method != "GET").map((r) => r.method + " " + r.url));
  console.log("at point:", await page.evaluate(() => { const e = document.elementFromPoint(266, 807); return [e.tagName, e.getAttribute("role"), e.getAttribute("aria-label"), e.className, e.outerHTML.slice(0, 200)]; }));
  console.log("pay box:", await page.evaluate(() => { const b = [...document.querySelectorAll("[role=button]")].filter((x) => /^Pay/.test(x.getAttribute("aria-label") || x.innerText)); return b.map((x) => JSON.stringify(x.getBoundingClientRect())); }));
  await shot("fail");
} finally {
  // leave the service signed out for the next run
  await page.evaluate((api) => fetch(api + "/api/session", { method: "DELETE", credentials: "include" }), API).catch(() => {});
  await browser.close();
}
