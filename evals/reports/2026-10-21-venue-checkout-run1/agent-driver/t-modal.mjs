import { helpers } from "./lib.mjs";
export default async (ctx) => {
  const { page, sleep, shot, role } = ctx;
  await (await page.$$('::-p-aria([name="Sign in"][role="button"])'))[0].click(); await sleep(1200);
  await shot("p-signin.png");
  console.log(await page.evaluate(() => { const r = document.querySelector("[data-declare-app]"); const out = []; for (const el of document.querySelectorAll("[aria-hidden],[inert],[aria-modal]")) out.push(el.tagName + " " + [...el.attributes].filter(a => /aria|inert|role/.test(a.name)).map(a => a.name + "=" + a.value).join(" ")); return out.slice(0, 15).join("\n"); }));
  const tb = await page.$$('::-p-aria([role="textbox"])'); console.log("textboxes in a11y tree:", tb.length);
};
