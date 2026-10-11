// node type.cjs <file path in vault> <text to type at the end of the body>
const { chromium } = require('playwright-core')
;(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = browser
    .contexts()
    .flatMap(c => c.pages())
    .find(p => p.url().startsWith('app://obsidian.md'))
  await page.evaluate(async path => {
    const f = app.vault.getAbstractFileByPath(path)
    await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'source' } })
    await new Promise(r => setTimeout(r, 500))
    const ed = app.workspace.activeEditor.editor
    ed.focus()
    const last = ed.lastLine()
    ed.setCursor({ line: last, ch: ed.getLine(last).length })
  }, process.argv[2])
  await page.keyboard.type(process.argv[3], { delay: 20 })
  await page.waitForTimeout(3000) // Obsidian saves about 2 s after the last keystroke
  await browser.close().catch(() => {})
  process.exit(0)
})().catch(e => {
  console.error(e)
  process.exit(1)
})
