// tools/check-design.ts against the real repo, and against copies of it with one thing changed.
import { describe, expect, test } from 'bun:test'

import * as LOOK from '../plugin/src/ui/look'
import { FILES, type Look, type Read, checkDesign, readRepo } from './check-design'

const real = (path: string) => {
  const text = readRepo(path)
  if (text === undefined) throw new Error(`no ${path}`)
  return text
}
// The repo with some files replaced.
const withFiles =
  (files: Record<string, string>): Read =>
  path =>
    files[path] ?? readRepo(path)
const replaced = (text: string, from: string, to: string) => {
  expect(text).toContain(from)
  return text.replace(from, to)
}
// look.ts with one palette colour's dark value changed.
const lookWith = (name: string, dark: string): Look => ({
  ...(LOOK as unknown as Look),
  COLOUR: { ...LOOK.COLOUR, palette: LOOK.COLOUR.palette.map(colour => (colour.name === name ? { ...colour, dark } : colour)) },
})
// A new changelog entry above the newest, and `Version:` set to it.
const logged = (doc: string, version: string, lines: string[]) => {
  const newest = /^### \S+ — /m.exec(doc)
  if (!newest) throw new Error('no changelog entry')
  const entry = [`### ${version} — 2026-10-12`, ...lines, ''].join('\n')
  return `${doc.slice(0, newest.index).replace(/^Version: .*$/m, `Version: ${version}`) + entry}\n${doc.slice(newest.index)}`
}

const doc = real(FILES.doc)
const css = real(FILES.css)

// Teal's dark value one step bluer, everywhere it's held: drift-free, but a new design.
const tealChanged = () => {
  const look = lookWith('teal', '#4cc2b5')
  const files = {
    [FILES.css]: replaced(css, '--teal: #4cc2b4;', '--teal: #4cc2b5;'),
    [FILES.doc]: replaced(doc, '| teal | `#4cc2b4` |', '| teal | `#4cc2b5` |'),
  }
  const { fingerprint } = checkDesign({ look, read: withFiles(files) })
  return { look, files, fingerprint }
}

describe('check-design', () => {
  test('the repo passes', () => {
    const result = checkDesign()
    expect(result.problems).toEqual([])
    expect(result.fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })

  test('the phone palette drifting from the pane fails', () => {
    const read = withFiles({ [FILES.css]: replaced(css, '--teal: #00756d;', '--teal: #00756e;') })
    expect(checkDesign({ read }).problems).toContain('style.css --teal (light) is #00756e, look.ts has #00756d')
    const app = replaced(real(FILES.app), "'teal', 'sky'", "'sky', 'teal'")
    expect(checkDesign({ read: withFiles({ [FILES.app]: app }) }).problems.join('\n')).toContain('app.js PALETTE is [sky, teal')
  })

  test('the doc drifting from the code fails', () => {
    const problems = checkDesign({ read: withFiles({ [FILES.doc]: replaced(doc, '| `app.js ARCHIVE_PX` | 80 |', '| `app.js ARCHIVE_PX` | 90 |') }) }).problems
    expect(problems).toContain('DESIGN.md constant app.js ARCHIVE_PX is 90, the code has 80')
    const glyphs = checkDesign({ look: { ...(LOOK as unknown as Look), GLYPH: { ...LOOK.GLYPH, star: '★' } } }).problems
    expect(glyphs).toContain('DESIGN.md symbols miss look.ts GLYPH.star (★)')
    const copy = checkDesign({ read: withFiles({ [FILES.html]: replaced(real(FILES.html), 'Nothing open', 'All clear') }) }).problems
    expect(copy).toContain("DESIGN.md copy “Nothing open” isn't in server/public/index.html")
  })

  test('a colour under 4.5:1 fails', () => {
    const look = lookWith('teal', '#2a6b63')
    const read = withFiles({
      [FILES.css]: replaced(css, '--teal: #4cc2b4;', '--teal: #2a6b63;'),
      [FILES.doc]: replaced(doc, '| teal | `#4cc2b4` | `#00756d` | 8.5:1 |', '| teal | `#2a6b63` | `#00756d` | 3.0:1 |'),
    })
    expect(checkDesign({ look, read }).problems.join('\n')).toContain('palette teal (dark) is 2.96:1 on --bg #141416, under 4.5:1')
  })

  test('the reserved hotkey colour fails', () => {
    const look = { ...(LOOK as unknown as Look), COLOUR: { ...LOOK.COLOUR, ansiPalette: ['suggestion', 'merged', 'planMode', 'warning'] } }
    expect(checkDesign({ look }).problems.join('\n')).toContain('look.ts COLOUR uses `suggestion`')
  })

  test('a value changed without a new entry fails, and passes once logged', () => {
    const { look, files, fingerprint } = tealChanged()
    const unlogged = checkDesign({ look, read: withFiles(files) }).problems
    expect(unlogged).toEqual([
      `Design values changed: the fingerprint is ${fingerprint}, the newest changelog entry (1.0.0) says ${checkDesign().fingerprint}. ` +
        `Bump \`Version:\`, add a changelog entry with \`- Change:\` and \`- Why:\` lines, and set its \`Fingerprint:\` to ${fingerprint}.`,
    ])
    const entry = ['- Change: Teal is a step bluer in the dark theme.', '- Why: It sat too close to lime.', `Fingerprint: ${fingerprint}`]
    expect(checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: logged(files[FILES.doc], '1.0.1', entry) }) }).problems).toEqual([])
  })

  test('an entry without a reason fails', () => {
    const { look, files, fingerprint } = tealChanged()
    const read = withFiles({ ...files, [FILES.doc]: logged(files[FILES.doc], '1.0.1', ['- Change: Teal is a step bluer.', `Fingerprint: ${fingerprint}`]) })
    expect(checkDesign({ look, read }).problems).toEqual([
      `changelog 1.0.1 (line ${files[FILES.doc].split('\n').findIndex(line => line.startsWith('### 1.0.0')) + 1}): no \`- Why:\` line giving the reason`,
    ])
    const empty = withFiles({
      ...files,
      [FILES.doc]: logged(files[FILES.doc], '1.0.1', ['- Change: Teal is a step bluer.', '- Why:', `Fingerprint: ${fingerprint}`]),
    })
    expect(checkDesign({ look, read: empty }).problems.join('\n')).toContain('no `- Why:` line giving the reason')
  })

  test('versions must match and go down the list', () => {
    const header = checkDesign({ read: withFiles({ [FILES.doc]: replaced(doc, 'Version: 1.0.0', 'Version: 1.0.1') }) }).problems
    expect(header).toContain('Version: says 1.0.1, but the newest changelog entry is 1.0.0')
    const { look, files, fingerprint } = tealChanged()
    const entry = ['- Change: Teal is a step bluer.', '- Why: It sat too close to lime.', `Fingerprint: ${fingerprint}`]
    for (const version of ['1.0.0', '0.9.0']) {
      const problems = checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: logged(files[FILES.doc], version, entry) }) }).problems
      expect(problems.join('\n')).toContain(`${version} isn't above 1.0.0`)
    }
    const bad = checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: logged(files[FILES.doc], '1.1', entry) }) }).problems
    expect(bad.join('\n')).toContain("1.1 isn't a version")
  })

  test('against a base, a changed design needs a version above the base, and keeps its entries', () => {
    const { look, files, fingerprint } = tealChanged()
    // The 1.0.0 entry's fingerprint edited in place instead of a new entry.
    const inPlace = files[FILES.doc].replace(/^Fingerprint: \w+$/m, `Fingerprint: ${fingerprint}`)
    expect(checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: inPlace }) }).problems).toEqual([])
    expect(checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: inPlace }), baseDoc: doc }).problems.join('\n')).toContain(
      "Design values differ from the base's (1.0.0), so they need a new version above 1.0.0",
    )
    const entry = ['- Change: Teal is a step bluer.', '- Why: It sat too close to lime.', `Fingerprint: ${fingerprint}`]
    const logged110 = logged(files[FILES.doc], '1.1.0', entry)
    expect(checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: logged110 }), baseDoc: doc }).problems).toEqual([])
    const dropped = logged110.slice(0, logged110.indexOf('### 0.1.0'))
    expect(checkDesign({ look, read: withFiles({ ...files, [FILES.doc]: dropped }), baseDoc: doc }).problems).toContain(
      'changelog 0.1.0 is in the base but gone here: entries are never removed',
    )
  })
})
