import { helpers } from "./lib.mjs";
export default async (ctx) => {
  const { page, sleep, role } = ctx;
  const h = helpers(ctx);
  await h.pickPerf("Friday 11 December");
  await h.pickSeats(1);
  await role("button", "Continue to payment").click(); await sleep(500);
  console.log(await page.evaluate(() => [...document.querySelectorAll("input")].map((e) => e.outerHTML.slice(0, 300)).join("\n")));
};
