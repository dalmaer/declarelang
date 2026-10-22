// Shared helpers for driving the venue app the way a screen reader finds things.
import { createRequire } from "node:module";
const require = createRequire("/Users/temkin/Code/eval-venue-checkout-2/work/declarelang/package.json");
const puppeteer = require("puppeteer-core");

export const APP = process.env.APP ?? "http://127.0.0.1:8231/my-apps/venue/venue.declare";
export const API = "http://127.0.0.1:8350";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function open({ phone = false } = {}) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  if (phone) await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
                                  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
  else await page.setViewport({ width: 1280, height: 800 });
  const sent = [];
  page.on("request", (r) => { if (r.url().startsWith(API) && r.method() != "OPTIONS") sent.push({ method: r.method(), url: r.url(), body: r.postData() }); });
  page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  page.on("console", (m) => { if (m.text().startsWith("reveal")) console.log(m.text()); if (m.type() == "error" && !/401|409|402|422/.test(m.text())) console.log("console:", m.text()); });
  await page.goto(APP, { waitUntil: "networkidle2" });
  return { browser, page, sent };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one element by role and accessible name (exact)
export async function byRole(page, role, name, { timeout = 8000 } = {}) {
  const sel = `aria/${name}[role="${role}"]`;
  const t0 = Date.now();
  while (true) {
    // what a screen reader can reach: nothing behind an open modal (inert)
    for (const el of await page.$$(sel)) if (await el.evaluate((e) => !e.closest("[inert]"))) return el;
    if (Date.now() - t0 > timeout) throw new Error(`no ${role} named "${name}"`);
    await sleep(100);
  }
}
export async function count(page, role, name) { return (await page.$$(`aria/${name}[role="${role}"]`)).length; }

export async function textOn(page, re, { timeout = 8000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const body = await page.evaluate(() => document.body.innerText);
    const m = body.match(re);
    if (m) return m[0];
    await sleep(150);
  }
  throw new Error("text not found: " + re);
}

export async function freeSeats(perf, n, sectionKey = null) {
  const r = await fetch(`${API}/api/performances/${perf}/seats`).then((x) => x.json());
  const out = [];
  for (const s of r.sections) {
    if (sectionKey && s.key != sectionKey) continue;
    for (const row of s.rows) for (const seat of row.seats)
      if (seat.status == "available") out.push({ id: seat.id, name: `${s.name}, row ${row.name}, seat ${seat.number}`, price: s.priceCents, fee: s.feeCents });
  }
  // from the middle of the list, so the picks are spread through the house
  return out.slice(Math.floor(out.length / 3), Math.floor(out.length / 3) + n);
}

export async function fill(page, label, text) {
  const el = await byRole(page, "textbox", label);
  await el.evaluate((e) => { const r = e.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight - 110) e.scrollIntoView({ block: "center" }); });
  await sleep(100);
  await el.click();
  await sleep(120);
  await el.evaluate((e) => e.select());
  await page.keyboard.press("Backspace");
  await el.type(text, { delay: 15 });
  return el;
}
export async function valueOf(page, label) {
  const el = await byRole(page, "textbox", label);
  return el.evaluate((e) => e.value);
}
