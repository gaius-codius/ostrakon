// Types, pauses (Obsidian saves; ostrakon re-stamps the file under the open editor), types again.
const { chromium } = require('playwright-core')
;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('app://obsidian.md'))
  await page.evaluate(async path => {
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(path), { state: { mode: 'source' } })
    await new Promise(r => setTimeout(r, 500))
    const ed = app.workspace.activeEditor.editor; ed.focus()
    const last = ed.lastLine(); ed.setCursor({ line: last, ch: ed.getLine(last).length })
  }, process.argv[2])
  for (const [i, gap] of [[1, 2600], [2, 1200], [3, 2600], [4, 400], [5, 3000]]) {
    await page.keyboard.type(` burst${i}`, { delay: 30 })
    await page.waitForTimeout(gap)
  }
  const shown = await page.evaluate(() => app.workspace.activeEditor.editor.getValue())
  console.log(shown)
  await page.screenshot({ path: process.argv[3] })
  await browser.close().catch(() => {}); process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
