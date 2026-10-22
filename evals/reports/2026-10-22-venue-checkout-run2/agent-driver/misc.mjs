// A seat lost at the moment of paying (409), signing out, and a session that survives reload.
import { open, byRole, textOn, freeSeats, fill, sleep, API } from "./lib.mjs";

const perf = "p12";
const { browser, page, sent } = await open();
try {
  // the room hears nothing, so only the service can say the seat went
  await page.setRequestInterception(true);
  page.on("request", (r) => r.url().includes("/api/events") ? r.abort() : r.continue());

  const p = await fetch(`${API}/api/production`).then((r) => r.json());
  const meta = p.performances.find((x) => x.id == perf);
  const d = new Date(meta.startsAt + ":00Z");
  const label = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()] + " " + d.getUTCDate() + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  await (await byRole(page, "button", label + ", 7:30pm")).click();
  const seats = await freeSeats(perf, 2, "DC");
  for (const s of seats) await (await byRole(page, "button", s.name)).click();
  await (await byRole(page, "button", "Checkout")).click();
  await sleep(500);

  // sign in, pay with the saved Visa
  await (await byRole(page, "button", "Sign in")).click();
  await fill(page, "Email", "ada@example.com");
  await fill(page, "Password", "correct horse battery");
  await page.keyboard.press("Enter");
  await textOn(page, /Signed in as ada@example\.com/);
  await fill(page, "Security code", "123");

  // someone else takes the second seat just before the press
  const st = await fetch(`${API}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ performanceId: perf, seatIds: [seats[1].id], email: "x@example.com",
      payment: { card: { number: "4242424242424242", expMonth: 4, expYear: 2030, cvc: "123", name: "X" },
                 billing: { line1: "1 Rd", line2: null, city: "T", postalCode: "94110", country: "US" } } }) }).then((r) => r.status);
  console.log("other buyer:", st);
  const pay = await textOn(page, /Pay \$[\d.,]+/);
  await (await byRole(page, "button", pay)).click();
  console.log("409 sentence:", await textOn(page, /[^\n]*just taken by someone else\./));
  console.log("back in the hall with:", await textOn(page, /1 seat · \$[\d.,]+/));
  const lost = await (await byRole(page, "button", seats[1].name)).evaluate((e) => [e.getAttribute("aria-disabled"), e.getAttribute("aria-pressed")]);
  const kept = await (await byRole(page, "button", seats[0].name)).evaluate((e) => e.getAttribute("aria-pressed"));
  console.log("lost seat disabled/pressed:", lost, "kept seat pressed:", kept);
  await page.screenshot({ path: "/tmp/venue-shots/e2e-409.png" });

  // the session lives with the service
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(800);
  const me = await page.evaluate(() => __declare.explain("app.account", "signedIn").value);
  console.log("signed in after reload:", me);
  await (await byRole(page, "button", seats[0].name)).click();   // the address survived the reload; choose again
  await (await byRole(page, "button", "Checkout")).click();
  await (await byRole(page, "button", "Sign out")).click();
  await textOn(page, /Have an account\?/);
  console.log("signed out; DELETE sent:", sent.some((r) => r.method == "DELETE"));
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(800);
  console.log("signed in after second reload:", await page.evaluate(() => __declare.explain("app.account", "signedIn").value));
  console.log("orders:", sent.filter((r) => r.url.endsWith("/api/orders")).length);
  console.log("OK");
} catch (e) {
  console.log("FAILED", e.message);
  await page.screenshot({ path: "/tmp/venue-shots/e2e-misc-fail.png" });
} finally { await browser.close(); }
