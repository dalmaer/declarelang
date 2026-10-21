import { helpers } from "./lib.mjs";
export default async (ctx) => {
  const { page, sleep, role } = ctx;
  const h = helpers(ctx);
  await h.pickPerf("Friday 11 December");
  await h.pickSeats(1);
  await role("button", "Continue to payment").click(); await sleep(500);
  const snap = await page.accessibility.snapshot({ interestingOnly: true });
  const walk = (n, d = 0) => { if (["textbox", "button", "radio", "heading", "radiogroup"].includes(n.role)) console.log(" ".repeat(d) + n.role + ": " + JSON.stringify(n.name) + (n.description ? " — " + n.description : "")); (n.children ?? []).forEach((c) => walk(c, d + 1)); };
  walk(snap);
};
