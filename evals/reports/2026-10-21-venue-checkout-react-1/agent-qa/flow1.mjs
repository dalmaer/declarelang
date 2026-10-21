import { chromium, devices } from '/Users/temkin/Code/eval-venue-checkout-react-1/work/app/node_modules/playwright/index.mjs'
const browser = await chromium.launch({ channel: 'chrome' })
const logs = []
// phone
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()))
  await page.goto('http://127.0.0.1:5173/')
  await page.getByRole('link', { name: /Fri 13 Nov/ }).tap()
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'p-hall-over.png' })
  const box = await page.locator('[class*=canvas]').boundingBox()
  await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.3)
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'p-hall-zoom.png' })
  // tap a free seat visible
  const free = page.locator('[data-state=free]')
  const n = await free.count()
  for (let i = 0; i < n; i++) {
    const b = await free.nth(i).boundingBox()
    if (b && b.y > 480 && b.y < 800 && b.x > 20 && b.x < 360) { await free.nth(i).tap(); break }
  }
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'p-hall-chosen.png' })
  console.log('selected:', await page.locator('[data-state=mine]').count(), await page.locator('[class*=count]').allTextContents())
}
// desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
  await page.goto('http://127.0.0.1:5173/performances/p01')
  await page.waitForTimeout(800)
  const free = page.locator('[data-state=free][data-section=ORCH]')
  await free.nth(5).click(); await free.nth(5).click()
  await page.locator('[data-state=free][data-section=GT]').first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'd-hall.png' })
  console.log('desktop summary:', await page.locator('[class*=count]').allTextContents())
}
console.log(logs.join('\n'))
await browser.close()
