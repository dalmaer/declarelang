export default async ({ page }) => { console.log(await page.evaluate(() => Object.keys(window.__declare).join(" "))); };
