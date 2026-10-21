export const helpers = ({ page, sleep, role }) => ({
  async pickPerf(prefix) {
    for (const b of await page.$$('::-p-aria([role="button"])')) {
      const n = await b.evaluate((e) => e.getAttribute("aria-label") ?? "");
      if (n.startsWith(prefix)) { await b.click(); await sleep(1500); return n; }
    }
    throw new Error("no performance " + prefix);
  },
  async pickSeats(n, section = "Orchestra") {
    const got = [];
    for (const b of await page.$$('::-p-aria([role="button"])')) {
      const st = await b.evaluate((e) => ({ n: e.getAttribute("aria-label") ?? "", p: e.getAttribute("aria-pressed"), d: e.getAttribute("aria-disabled") }));
      if (st.p == "false" && st.d != "true" && st.n.startsWith(section)) { await b.scrollIntoView(); await b.click(); got.push(st.n); if (got.length == n) break; }
    }
    await sleep(200);
    return got;
  },
  async fill(name, value) {
    const f = page.locator(`::-p-aria([name="${name}"][role="textbox"])`);
    await f.click();
    const el = await page.$(`::-p-aria([name="${name}"][role="textbox"])`);
    await el.evaluate((e) => e.select());
    await page.keyboard.press("Backspace");
    await page.keyboard.type(value);
  },
  async value(name) {
    const h = await page.$(`::-p-aria([name="${name}"][role="textbox"])`);
    return h ? h.evaluate((e) => e.value) : null;
  },
  summary: () => page.evaluate(() => document.body.innerText.match(/\d+ seats? · \$[\d.,]+/)?.[0] ?? null),
});
