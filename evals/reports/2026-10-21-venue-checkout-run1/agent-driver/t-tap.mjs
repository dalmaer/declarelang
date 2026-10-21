import { helpers } from "./lib.mjs";
export default async (ctx) => {
  const { page, sleep, shot } = ctx;
  const h = helpers(ctx);
  await h.pickPerf("Friday 13 November");
  for (const b of await page.$$('::-p-aria([role="button"])')) {
    const st = await b.evaluate((e) => ({ n: e.getAttribute("aria-label") ?? "", p: e.getAttribute("aria-pressed"), d: e.getAttribute("aria-disabled") }));
    if (st.p == "false" && st.d != "true" && st.n.startsWith("Orchestra")) {
      console.log("tapping", st.n);
      await b.scrollIntoView(); await sleep(300);
      const box = await b.boundingBox(); console.log("box", box);
      await b.click(); await sleep(400);
      console.log("pressed now:", await b.evaluate((e) => e.getAttribute("aria-pressed")), await h.summary());
      break;
    }
  }
  await shot("tap.png");
};
