#!/usr/bin/env node
// a11y-audit — run axe-core, the accessibility rules engine Chrome's Lighthouse
// uses, over Declare programs in real Chrome (docs/system-design/accessibility.md
// §10): each program opened as a person opens it, its annotations in place, and
// every WCAG 2 A and AA rule axe can check run against the page.
//
//   node tools/a11y-audit.mjs [--json] [--dark] [program.declare …]
//
// With no programs it audits the corpus apps; --dark runs each as the system
// asks for the dark appearance. What an automated audit can see is
// a part of accessibility — names, roles, states, contrast, structure — never
// whether a screen reader user can actually get through the program; that is
// the manual pass's.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeclareServer } from "../server/create.mjs";
import { launchChrome } from "./internal/chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const dark = argv.includes("--dark");
const DEFAULT = ["sampler/sampler", "tracker/tracker", "calendar/calendar", "weather/weather", "birds/birds",
  "desktop/desktop", "homepage/homepage", "marketmap/marketmap", "docs/docs"].map((a) => `apps/${a}.declare`);
const programs = argv.filter((a) => a.endsWith(".declare"));
const list = programs.length > 0 ? programs : DEFAULT;

const server = createDeclareServer({ mountSpecs: [{ prefix: "/", dir: ROOT }, { prefix: "/declare/", dir: ROOT, platform: true }], mode: "distro" });
const web = http.createServer(server.handler);
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${web.address().port}`;
const browser = await launchChrome({ args: ["--no-sandbox"] });
const AXE = path.join(ROOT, "node_modules/axe-core/axe.min.js");

const report = [];
for (const prog of list) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  if (dark) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/${prog}`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => window.__declare && typeof window.__declare.find === "function", { timeout: 30000 });
  // motion to rest, then the annotations installed after the frame
  await page.evaluate(() => window.__declare.clock?.settleMotion?.());
  await new Promise((r) => setTimeout(r, 600));
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async () => {
    const r0 = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
    const r = r0;
    for (const v of r.violations) for (const n of v.nodes) { const el = document.querySelector(n.target?.[0] ?? ":not(*)"); n.element = { innerText: el ? (el.innerText || el.textContent || el.getAttribute("href") || "") : "" }; }
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length,
      example: v.nodes[0]?.html?.slice(0, 160),
      examples: v.nodes.slice(0, 4).map((n) => ({ html: n.html.slice(0, 220), text: (n.element?.innerText ?? "").slice(0, 60), target: n.target })), why: v.nodes[0]?.failureSummary?.split("\n").slice(0, 3).join(" "),
      // contrast: each failing pair, with what axe measured
      pairs: v.id === "color-contrast" ? v.nodes.map((n) => { const d = n.any?.[0]?.data ?? {}; return { fg: d.fgColor, bg: d.bgColor, ratio: d.contrastRatio, size: d.fontSize, weight: d.fontWeight, expected: d.expectedContrastRatio, text: (n.target?.[0] ?? "") && n.html.replace(/<[^>]+>/g, "").slice(0, 40) }; }) : undefined }));
  });
  report.push({ program: prog, violations: result, pageErrors: errors });
  await page.close();
}
await browser.close();
web.close();

if (json) console.log(JSON.stringify(report, null, 2));
else for (const r of report) {
  const n = r.violations.reduce((k, v) => k + v.count, 0);
  console.log(`\n${r.program}: ${r.violations.length} rule(s) violated, ${n} element(s)`);
  for (const v of r.violations) console.log(`  [${v.impact}] ${v.id} ×${v.count} — ${v.help}\n      e.g. ${v.example}\n      ${v.why ?? ""}`);
  if (r.pageErrors.length) console.log(`  page errors: ${r.pageErrors.join("; ")}`);
}
process.exit(0);
