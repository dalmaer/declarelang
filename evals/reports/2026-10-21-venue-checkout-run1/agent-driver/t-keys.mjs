import { helpers } from "./lib.mjs";
export default async (ctx) => {
  const { page, sleep, shot, text } = ctx;
  const h = helpers(ctx);
  const focused = () => page.evaluate(() => { const e = document.activeElement; return e ? (e.getAttribute("aria-label") || e.textContent.slice(0, 40) || e.tagName) : null; });
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await sleep(60); } };
  // Tab to the 17th performance
  let f = "";
  for (let i = 0; i < 40; i++) { await key("Tab"); f = await focused(); if (f?.startsWith("Friday 11 December")) break; }
  console.log("on:", f);
  await key("Enter"); await sleep(1500);
  console.log("after pick:", await focused());
  await key("Space"); await sleep(100);
  await key("ArrowLeft"); console.log("left ->", await focused());
  await key("Space");
  await key("ArrowDown"); console.log("down ->", await focused());
  await key("ArrowUp"); console.log("up ->", await focused());
  console.log("summary:", await h.summary());
  for (let i = 0; i < 15; i++) { await key("Tab"); f = await focused(); if (f == "Continue to payment") break; }
  console.log("on:", f);
  await key("Enter"); await sleep(600);
  console.log("after continue:", await focused());
  await page.keyboard.type("kb@example.com"); await key("Tab");
  await page.keyboard.type("Kay Bee"); await key("Tab");
  await page.keyboard.type("5555555555554444"); await key("Tab");
  await page.keyboard.type("1230"); await key("Tab");
  await page.keyboard.type("999"); await key("Tab");
  console.log("now on:", await focused());
  await key("ArrowRight"); await sleep(100); // country -> Canada
  await key("Tab"); await page.keyboard.type("1 Rue Test"); await key("Tab"); await key("Tab");
  await page.keyboard.type("Toronto"); await key("Tab");
  await page.keyboard.type("M5V 2T6"); await key("Enter");
  console.log("after enter on postal:", await focused());
  for (let i = 0; i < 10; i++) { f = await focused(); if (f?.startsWith("Pay")) break; await key("Tab"); }
  console.log("on:", f);
  await key("Enter"); await sleep(2600);
  console.log("after pay:", await focused());
  console.log((await text()).match(/.*postal code.*|.*postcode.*/gi));
  await shot("k-422.png");
};
