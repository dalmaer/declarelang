// Desk: no account, two seats, a new card, one payment.
import { open, byRole, count, textOn, freeSeats, fill, valueOf, sleep } from "./lib.mjs";

const { browser, page, sent } = await open();
try {
  const perf = process.argv[2] ?? "p08";
  const p = await fetch("http://127.0.0.1:8350/api/production").then((r) => r.json());
  const meta = p.performances.find((x) => x.id == perf);
  const d = new Date(meta.startsAt + ":00Z");
  const label = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()] + " " + d.getUTCDate() + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  console.log("performance button:", label);
  const rows = await page.$$(`aria/${label}, 7:30pm[role="button"]`);
  console.log("rows matching:", rows.length);
  await (await byRole(page, "button", `${label}, ${meta.startsAt.endsWith("14:00") ? "2:00pm" : "7:30pm"}`)).click();

  const seats = await freeSeats(perf, 2);
  for (const s of seats) {
    const b = await byRole(page, "button", s.name);
    await b.click();
    await sleep(150);
  }
  const want = `${seats.length} seats · $${(seats.reduce((n, s) => n + s.price, 0) / 100).toFixed(2)}`;
  console.log("summary:", await textOn(page, new RegExp(want.replace(/[$.]/g, "\\$&"))));
  const pressed = await (await byRole(page, "button", seats[0].name)).evaluate((e) => e.getAttribute("aria-pressed"));
  console.log("seat aria-pressed:", pressed);

  await (await byRole(page, "button", "Checkout")).click();
  await sleep(500);
  await fill(page, "Email", "grace@example.com");
  await fill(page, "Name on card", "Grace Hopper");
  await fill(page, "Card number", "4242424242424242");
  console.log("card shown as:", await valueOf(page, "Card number"));
  await fill(page, "Expiry", "1228");
  console.log("expiry shown as:", await valueOf(page, "Expiry"));
  await fill(page, "Security code", "123");
  await fill(page, "Street address", "1 Infinite Loop");
  await fill(page, "City", "Cupertino");
  await fill(page, "Postal code", "95014");

  const total = seats.reduce((n, s) => n + s.price + s.fee, 0);
  const payName = `Pay $${(total / 100).toFixed(2)}`;
  console.log("pay buttons named", payName, ":", await count(page, "button", payName));
  const pay = await byRole(page, "button", payName);
  await pay.click();
  await pay.click().catch(() => {});
  await page.keyboard.press("Enter");
  await textOn(page, /Sent to grace@example\.com/, { timeout: 10000 });
  const orders = sent.filter((r) => r.method == "POST" && r.url.endsWith("/api/orders"));
  console.log("orders sent:", orders.length, orders[0]?.body);
  await page.screenshot({ path: "/tmp/venue-shots/e2e-tickets-desk.png" });
  console.log("OK");
} catch (e) {
  console.log("FAILED", e.message);
  await page.screenshot({ path: "/tmp/venue-shots/e2e-fail.png" });
} finally {
  await browser.close();
}
