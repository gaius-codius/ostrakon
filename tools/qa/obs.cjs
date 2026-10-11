// Runs one Obsidian step through CDP: node obs.cjs '<js body evaluated in the page, may await; return a value>'
const { chromium } = require('playwright-core')
;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser
    .contexts()
    .flatMap(c => c.pages())
    .find(p => p.url().startsWith('app://obsidian.md'))
  const shot = process.argv[3]
  const result = await page.evaluate(`(async () => { ${process.argv[2]} })()`)
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1))
  if (shot) await page.screenshot({ path: shot })
  await browser.close().catch(() => {})
  process.exit(0)
})().catch(e => {
  console.error(e)
  process.exit(1)
})
