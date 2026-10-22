import { open, byRole, sleep, freeSeats } from "./lib.mjs";
const { browser, page } = await open({ phone: true });
await (await byRole(page, "button", "Sat 14 Nov, 7:30pm")).tap();
await sleep(1200);
const s = await freeSeats("p02", 1, "BALC");
await (await byRole(page, "button", s[0].name)).tap();
await (await byRole(page, "button", "Checkout")).tap();
await sleep(800);
await (await byRole(page, "button", "Sign in")).tap();
await sleep(800);
console.log(await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => {
  let e = i, flags = [];
  while (e) { if (e.inert) flags.push("inert"); if (e.getAttribute && e.getAttribute("aria-hidden") == "true") flags.push("aria-hidden"); e = e.parentElement; }
  return i.getAttribute("aria-label") + " " + flags.join(",");
})));
const snap = await page.accessibility.snapshot();
const names = []; (function walk(n) { if (n.role == "textbox") names.push(n.name); (n.children || []).forEach(walk); })(snap);
console.log("a11y textboxes:", names);
await browser.close();
