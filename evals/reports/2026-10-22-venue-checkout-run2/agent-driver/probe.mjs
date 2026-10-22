import { open, byRole, sleep, freeSeats } from "./lib.mjs";
const { browser, page } = await open({ phone: true });
await (await byRole(page, "button", "Sat 14 Nov, 7:30pm")).tap();
await sleep(1200);
const s = await freeSeats("p02", 1, "BALC");
await (await byRole(page, "button", s[0].name)).tap();
await (await byRole(page, "button", "Checkout")).tap();
await sleep(800);
console.log(await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll("*")) if (e.scrollHeight > e.clientHeight + 5 && getComputedStyle(e).overflowY != "visible")
    out.push([e.tagName, e.className.toString().slice(0, 40), e.clientHeight, e.scrollHeight, getComputedStyle(e).overflowY]);
  return { out, docH: document.documentElement.scrollHeight, bodyH: document.body.scrollHeight };
}));
const el = await byRole(page, "textbox", "City");
await el.focus();
await sleep(500);
console.log("after focusing City:", await page.evaluate(() => [scrollY, document.activeElement.getAttribute("aria-label")]));
await page.screenshot({ path: "/tmp/venue-shots/probe.png" });
await browser.close();
