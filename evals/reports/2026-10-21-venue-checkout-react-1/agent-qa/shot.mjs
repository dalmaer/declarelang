import { chromium, devices } from '/Users/temkin/Code/eval-venue-checkout-react-1/work/app/node_modules/playwright/index.mjs'
const [,, mode = 'desktop', path = '/', out = 'shot'] = process.argv
const browser = await chromium.launch({ channel: 'chrome' })
const ctx = await browser.newContext(mode === 'phone' ? { ...devices['iPhone 13'], deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 860 } })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
await page.goto('http://127.0.0.1:5173' + path)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}.png`, fullPage: process.env.FULL === '1' })
console.log(logs.join('\n'))
await browser.close()
