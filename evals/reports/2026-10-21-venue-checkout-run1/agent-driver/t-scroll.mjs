export default async ({ page, role, sleep, shot, text }) => {
  await role("button", "Friday 11 December at 7:30pm").click().catch(()=>{});
  const perf = await page.$$('::-p-aria([role="button"])');
  // pick the performance whose name starts with Friday 11 December
  for (const b of perf) { const n = await b.evaluate((e) => e.getAttribute("aria-label") ?? ""); if (n.startsWith("Friday 11 December")) { await b.click(); break; } }
  await sleep(1500);
  const free = await page.$$('::-p-aria([role="button"])');
  let picked = 0;
  for (const b of free) {
    const st = await b.evaluate((e) => ({ n: e.getAttribute("aria-label") ?? "", p: e.getAttribute("aria-pressed"), d: e.getAttribute("aria-disabled") }));
    if (st.p == "false" && st.d != "true" && st.n.startsWith("Orchestra")) { await b.click(); picked++; if (picked == 2) break; }
  }
  await sleep(300);
  console.log(await page.evaluate(() => document.body.innerText.match(/\d+ seats? · \$[\d.,]+/)?.[0]));
  await role("button", "Continue to payment").click();
  await sleep(500);
  await page.locator('::-p-aria([name="City"][role="textbox"])').click();
  await page.keyboard.type("Springfield");
  await sleep(200);
  await shot("city.png");
};
