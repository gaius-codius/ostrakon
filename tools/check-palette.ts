// Fails when the phone's project palette differs from the pane's: the names in order in
// server/public/app.js, each one's light and dark value in server/public/style.css, against
// plugin/src/ui/look.ts. Run by tools/check.sh.
import { readFileSync } from 'node:fs'

import { COLOUR } from '../plugin/src/ui/look'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../server/public/app.js')
const css = read('../server/public/style.css')

const names = [...(/^const PALETTE = \[([^\]]*)\]/m.exec(app)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1])
// The light values are the first :root's; the dark ones the :root under prefers-color-scheme: dark.
const [light = '', dark = ''] = css.split('@media (prefers-color-scheme: dark)')
const valueOf = (block: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]{6});`, 'i').exec(block)?.[1]?.toLowerCase()

const problems: string[] = []
const want = COLOUR.palette.map(colour => colour.name)
if (names.join(' ') !== want.join(' ')) problems.push(`app.js PALETTE is [${names.join(', ')}], look.ts has [${want.join(', ')}]`)
for (const colour of COLOUR.palette) {
  for (const tone of ['light', 'dark'] as const) {
    const value = valueOf(tone === 'light' ? light : dark, colour.name)
    if (value !== colour[tone]) problems.push(`style.css --${colour.name} (${tone}) is ${value ?? 'missing'}, look.ts has ${colour[tone]}`)
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.log(problem)
  process.exit(1)
}
console.log('palette ok')
