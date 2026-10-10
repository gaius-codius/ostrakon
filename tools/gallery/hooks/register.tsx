import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

// Throwaway gallery of everything the terminal surface can draw.
// /gallery <boxes|text|wrap|controls|rich|graphics|client|band>
const page = atom({ plugin: 'spgallery', key: 'page' } as const, 'boxes')
const last = atom({ plugin: 'spgallery', key: 'last' } as const, '(nothing pressed yet)')
const bandOn = atom({ plugin: 'spgallery', key: 'band' } as const, false)
const hintMode = atom({ plugin: 'spgallery', key: 'hint' } as const, 'off')

const PANE = 'gallery'
const PAGES = ['boxes', 'overlay', 'colours', 'text', 'wrap', 'controls', 'rich', 'code', 'graphics', 'client', 'band']
type E = Elements['terminal']

const THEME_KEYS = [
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error',
  'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder',
  'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed',
  'diffAddedWord', 'diffRemovedWord',
]
const BORDERS = ['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle', 'classic', 'arrow', 'dashed', 'quote', 'sparkles']

const rec = ($: EngineInterface, text: string) => update($, last, () => text)

// ---- raster / image helpers (pure) ----
const b64 = (bytes: Uint8Array): string => {
  const any = bytes as unknown as { toBase64?: () => string }
  if (typeof any.toBase64 === 'function') return any.toBase64()
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const DEFAULT = 0x01000000
const packCells = (cells: Array<[number, number, number]>): string => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach(([cp, fg, bg], i) => {
    words[i * 3] = cp
    words[i * 3 + 1] = fg
    words[i * 3 + 2] = bg
  })
  return b64(new Uint8Array(words.buffer))
}
const rgb = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const SERIES = [2, 3, 5, 4, 7, 9, 6, 3, 2, 1, 4, 8, 10, 12, 9, 7, 5, 6, 8, 11, 14, 12, 9, 6, 4, 3, 5, 7, 10, 13, 15, 12, 8, 5, 3, 2, 1, 2, 4, 6]
const sparkline = (): string => {
  const max = Math.max(...SERIES)
  return packCells(
    SERIES.map(v => {
      const lvl = Math.min(7, Math.floor((v / max) * 8))
      return [BLOCKS[lvl]!.codePointAt(0)!, rgb(97, 175, 239), DEFAULT] as [number, number, number]
    }),
  )
}
// two-row sparkline using background colour: top row inverse half blocks
const heatStrip = (cols: number, rows: number): string => {
  const cells: Array<[number, number, number]> = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const t = (x / (cols - 1)) * 0.7 + (y / Math.max(1, rows - 1)) * 0.3
      const r = Math.round(40 + 215 * t)
      const g = Math.round(180 - 140 * Math.abs(t - 0.5) * 2)
      const b = Math.round(220 - 200 * t)
      cells.push([0x2588, rgb(r, g, b), DEFAULT])
    }
  }
  return packCells(cells)
}
// shaded cells: char + fg + bg together (calendar-style heat grid)
const heatGrid = (cols: number, rows: number): string => {
  const cells: Array<[number, number, number]> = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = (Math.sin(x * 0.6 + y) + 1) / 2
      const lvl = Math.floor(v * 4)
      const fg = [rgb(60, 60, 60), rgb(14, 100, 60), rgb(38, 166, 91), rgb(110, 231, 140)][lvl]!
      cells.push([0x25a0, fg, DEFAULT]) // ■
    }
  }
  return packCells(cells)
}
const gradientRgba = (w: number, h: number): string => {
  const px = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      px[i] = Math.round((x / (w - 1)) * 255)
      px[i + 1] = Math.round((y / (h - 1)) * 255)
      px[i + 2] = 160
      px[i + 3] = 255
    }
  return b64(px)
}
// 8x8 RGB PNG written once by python (shipped as a constant: no encoder at runtime)
const PNG8 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAgklEQVR4nA3JoQFAUQQFUMMYxjCm+FmQZFm+WTaCYYT/Tj1ENEwtBKVySlAs2dFHxMPcwlAu5wTHsh2/kGFpEaiUS0JixU5e6LC2KFTLNaGxaqcvfNhbHOrlnvBYt/MXGEYLoChHArGww4sd3paFbvkmNnbt9sUNX8tBr/wSF3t29/2udWhBRWempAAAAABJRU5ErkJggg=='

const ROWS: Array<[string, string, string]> = [
  ['12', 'fix', 'src/state.ts'],
  ['3', 'feat', 'hooks/register.tsx'],
  ['140', 'chore', 'docs/SPEC.md'],
  ['7', 'wip', 'a.ts'],
]

// ---- pages ----
const Title = ({ el, text }: { el: E; text: string }) => <el.Text bold>{text}</el.Text>

function boxesPage(el: E) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>boxes: borderStyle (last one is not a style)</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {BORDERS.map(b => (
          <Box borderStyle={b} width={13} paddingX={1}>
            <Text>{b === 'singleDouble' ? 'sglDbl' : b === 'doubleSingle' ? 'dblSgl' : b}</Text>
          </Box>
        ))}
      </Box>
      <Text bold>border colours, background, padding, gap</Text>
      <Box flexDirection="row" gap={1}>
        <Box borderStyle="round" borderColor="success" paddingX={1}>
          <Text>success</Text>
        </Box>
        <Box borderStyle="round" borderColor="permission" borderDimColor paddingX={1}>
          <Text>dim border</Text>
        </Box>
        <Box backgroundColor="promptBorder" paddingX={1}>
          <Text color="inverseText">promptBorder bg</Text>
        </Box>
        <Box backgroundColor="#304060" paddingX={1}>
          <Text>#304060</Text>
        </Box>
      </Box>
      <Box flexDirection="row" gap={2}>
        <Box borderStyle="single" padding={1}>
          <Text>padding 1</Text>
        </Box>
        <Box borderStyle="single" paddingX={3}>
          <Text>paddingX 3</Text>
        </Box>
        <Box borderStyle="single" width={18} justifyContent="center">
          <Text>width 18 ctr</Text>
        </Box>
      </Box>
      <Text bold>nested</Text>
      <Box borderStyle="double" paddingX={1} flexDirection="column">
        <Text>outer double</Text>
        <Box borderStyle="round" paddingX={1} flexDirection="column">
          <Text>inner round</Text>
          <Box borderStyle="dashed" paddingX={1}>
            <Text dimColor>innermost dashed</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

function overlayPage(el: E) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>hover (move the pointer over a box; tmux has none)</Text>
      <Box flexDirection="row" gap={1}>
        <Box key="h1" borderStyle="single" paddingX={1} hover={{ borderColor: 'claude', backgroundColor: 'inactive' }}>
          <Text hover={{ bold: true, color: 'claude' }}>hover me</Text>
        </Box>
        <Box key="h2" paddingX={1} hover={{ backgroundColor: 'suggestion' }}>
          <Text>bg on hover</Text>
        </Box>
      </Box>
      <Text bold>absolute overlay (card painted over its parent)</Text>
      <Box position="relative" height={5} borderStyle="single">
        <Text dimColor>row under the card: the quick brown fox jumps over the lazy dog</Text>
        <Box position="absolute" top={1} left={12} borderStyle="round" borderColor="warning" backgroundColor="inactive" paddingX={1}>
          <Text color="warning">overlay card</Text>
        </Box>
      </Box>
      <Box key="rv" borderStyle="single" paddingX={1}>
        <Text>hover reveals a card</Text>
        <Box position="absolute" top={-3} left={4} display="none" hover={{ display: 'flex' }} borderStyle="round" paddingX={1}>
          <Text>revealed</Text>
        </Box>
      </Box>
    </Box>
  )
}

function textPage(el: E) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>theme colours (color, then backgroundColor)</Text>
      <Box flexDirection="row" flexWrap="wrap">
        {THEME_KEYS.map(k => (
          <Box width={21}>
            <Text color={k}>■■ {k}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        {THEME_KEYS.map(k => (
          <Box width={21}>
            <Text backgroundColor={k} color={k === 'inverseText' ? 'text' : 'inverseText'}>
              {` ${k} `}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function stylesPage(el: E) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>raw colours</Text>
      <Box flexDirection="row" gap={1}>
        <Text color="red">red</Text>
        <Text color="#ff8800">#ff8800</Text>
        <Text color="rgb(80,200,255)">rgb()</Text>
        <Text color="ansi256(201)">ansi256</Text>
        <Text color="notacolour">bogus</Text>
      </Box>
      <Text bold>styles</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text>plain</Text>
        <Text dimColor>dimColor</Text>
        <Text bold>bold</Text>
        <Text italic>italic</Text>
        <Text underline>underline</Text>
        <Text strikethrough>strike</Text>
        <Text inverse>inverse</Text>
        <Text bold italic underline color="claude">
          combined
        </Text>
      </Box>
      <Text bold>nested Text inheritance</Text>
      <Text color="success">
        outer success, <Text bold>inner bold</Text>, <Text color="error">inner error</Text>, back
      </Text>
      <Text bold>tabular: fixed-width cells, right-aligned numbers</Text>
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box width={6} justifyContent="flex-end">
            <Text dimColor>n</Text>
          </Box>
          <Box width={8} paddingLeft={2}>
            <Text dimColor>kind</Text>
          </Box>
          <Box flexGrow={1} paddingLeft={1}>
            <Text dimColor>path</Text>
          </Box>
        </Box>
        {ROWS.map(([n, k, p]) => (
          <Box flexDirection="row">
            <Box width={6} justifyContent="flex-end">
              <Text color="success">{n}</Text>
            </Box>
            <Box width={8} paddingLeft={2}>
              <Text color="warning">{k}</Text>
            </Box>
            <Box width={22} paddingLeft={1}>
              <Text wrap="truncate-end">{p}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Text bold>flexGrow spacer: label left, value right</Text>
      <Box width={40} borderStyle="round" paddingX={1}>
        <Text>notes</Text>
        <Box flexGrow={1} />
        <Text dimColor>128</Text>
      </Box>
      <Box width={40} justifyContent="space-between">
        <Text>left</Text>
        <Text>middle</Text>
        <Text>right</Text>
      </Box>
    </Box>
  )
}

function wrapPage(el: E) {
  const { Box, Text } = el
  const long = 'The quick brown fox jumps over the lazy dog, then keeps running to the end of the path'
  const modes = ['wrap', 'end', 'middle', 'truncate', 'truncate-start', 'truncate-middle', 'truncate-end'] as const
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>wrap modes in a 34-wide box</Text>
      {modes.map(m => (
        <Box flexDirection="row" gap={1}>
          <Box width={16}>
            <Text dimColor>{m}</Text>
          </Box>
          <Box width={34} borderStyle="single" borderDimColor>
            <Text wrap={m}>{long}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function controlsPage($: EngineInterface, el: E, lastText: string) {
  const { Box, Text, Button, Input, Select } = el
  const press = (what: string) => () => void rec($, `pressed ${what}`)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Button</Text>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="b-default" label="default" onPress={press('default')} />
        <Button key="b-primary" label="primary" variant="primary" onPress={press('primary')} />
        <Button key="b-secondary" label="secondary" variant="secondary" onPress={press('secondary')} />
        <Button key="b-dim" label="dim" dimColor onPress={press('dim')} />
        <Button key="b-dismiss" label="dismiss" role="dismiss" onPress={press('dismiss')} />
      </Box>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Button key="p1" plain hotkey="1" label="plain hotkey 1" onPress={press('plain 1')} />
        <Button key="p-a" plain hotkey="a" label="hotkey a" onPress={press('plain a')} />
        <Button key="p0" plain label="plain, no hotkey" onPress={press('plain nohotkey')} />
        <Button key="hk" hotkey="h" label="hotkey on boxed" onPress={press('boxed h')} />
        <Button key="glyph" plain label="★" onPress={press('glyph')} />
      </Box>
      <Text bold>Input (autoFocus on the first)</Text>
      <Input key="in-1" label="name" placeholder="type here" submitLabel="save" autoFocus onSubmit={v => void rec($, `submit "${v}"`)} onInput={v => void rec($, `typing "${v}"`)} />
      <Input key="in-2" label="with value" value="prefilled" onSubmit={v => void rec($, `submit2 "${v}"`)} />
      <Input key="in-3" placeholder="no label, default submit" onSubmit={v => void rec($, `submit3 "${v}"`)} />
      <Text bold>Select</Text>
      <Select
        key="sel"
        label="scope"
        value="project"
        options={[
          { value: 'all', label: 'All notes' },
          { value: 'project', label: 'This project' },
          { value: 'inbox', label: 'Inbox' },
        ]}
        onSelect={v => void rec($, `select ${v}`)}
      />
      <Box borderStyle="round" paddingX={1} borderDimColor>
        <Text dimColor>last event: </Text>
        <Text color="success">{lastText}</Text>
      </Box>
    </Box>
  )
}

const MD = `# Heading one
## Heading two
Some **bold**, *italic*, \`inline code\` and a [link](https://example.com).

- first item
- second item
  - nested item
1. ordered one
2. ordered two

> a blockquote line

| col | n |
|-----|--:|
| a   | 1 |
| bb  | 22 |

\`\`\`ts
const x: number = 1
\`\`\``

const DIFF = `@@ -1,3 +1,4 @@
 import a from 'a'
-const old = 1
+const fresh = 2
+const extra = 3
 export {}`

function richPage(el: E) {
  const { Box, Text, Markdown } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Markdown</Text>
      <Markdown text={MD} />
    </Box>
  )
}

function codePage(el: E) {
  const { Box, Text, Code, Link } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Code (language ts, startLine 10)</Text>
      <Code language="ts" startLine={10} source={'function add(a: number, b: number) {\n  return a + b // sum\n}'} />
      <Text bold>Code format diff</Text>
      <Code format="diff" path="x.ts" source={DIFF} />
      <Text bold>Code wrap truncate-end / diff that fails to parse</Text>
      <Code wrap="truncate-end" language="ts" source={'const veryLongLine = "this line is much wider than the pane and must be cut at the edge with an ellipsis"'} />
      <Code format="diff" source="not a diff at all" />
      <Text bold>Link</Text>
      <Box flexDirection="row" gap={2}>
        <Link href="https://example.com" label="with label" />
        <Link href="https://example.com/long/path">children text</Link>
        <Link href="https://example.org" />
      </Box>
    </Box>
  )
}

function graphicsPage(el: E) {
  const { Box, Text, Raster, Image } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Raster: sparkline, 40x1</Text>
      <Raster key="spark" columns={40} rows={1} cells={sparkline()} />
      <Text bold>Raster: heat strip 40x2</Text>
      <Raster key="heat" columns={40} rows={2} cells={heatStrip(40, 2)} />
      <Text bold>Raster: ■ grid 28x4 (fg only)</Text>
      <Raster key="grid" columns={28} rows={4} cells={heatGrid(28, 4)} />
      <Text bold>Image: rgba gradient, 24x6 cells</Text>
      <Image key="img-rgba" source={{ rgba: gradientRgba(48, 24), width: 48, height: 24 }} columns={24} rows={6} alt="[gradient image 48x24 rgba]" />
      <Text bold>Image: shipped 8x8 png, 12x4 cells</Text>
      <Image key="img-png" source={{ png: PNG8 }} columns={12} rows={4} alt="[png 8x8]" />
    </Box>
  )
}

function clientPage(el: E) {
  const { Box, Text, Client, Input } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Client: click it to focus, then type</Text>
      <Client key="probe" module="./client.tsx" width={44} height={5} />
      <Text dimColor>An Input for comparison (it swallows letters too):</Text>
      <Input key="cmp" label="input" placeholder="type" onSubmit={() => {}} />
    </Box>
  )
}

function bandPage(el: E, band: boolean, hint: string, lastText: string) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>band + prompt page</Text>
      <Text>band chips: {band ? 'ON (above the prompt)' : 'off'}</Text>
      <Text>hint mode: {hint}</Text>
      <Text>last event: <Text color="success">{lastText}</Text></Text>
      <Text dimColor>/gallery band on|off, /gallery hint off|tail|tree</Text>
      <Text>Type <Text color="warning" bold>//</Text> at the start of the prompt: the leading // is decorated by prompt.edit.</Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gallery', description: `gallery: ${PAGES.join('|')}`, argumentHint: PAGES.join('|') })
    return next(e)
  })

  on('command.run', { command: 'gallery' }, async ($, e) => {
    const parts = String(e.args ?? '').trim().split(/\s+/)
    const a = parts[0] || 'boxes'
    if (a === 'hint') {
      await update($, hintMode, () => parts[1] ?? 'off')
      return { text: `hint ${parts[1] ?? 'off'}` }
    }
    if (a === 'band') {
      await update($, bandOn, () => parts[1] !== 'off')
    }
    if (!PAGES.includes(a)) return { text: `unknown page ${a}; pages: ${PAGES.join(' ')}` }
    await update($, page, () => a)
    const r = await $.ui.open({ id: PANE, title: `gallery: ${a}`, focus: true, closeOnEscape: true, rows: 38 })
    return { text: `gallery ${a} ${JSON.stringify(r)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const p = await read($, page)
    const lastText = await read($, last)
    const band = await read($, bandOn)
    const hint = await read($, hintMode)
    const body =
      p === 'boxes' ? boxesPage(el)
      : p === 'overlay' ? overlayPage(el)
      : p === 'colours' ? textPage(el)
      : p === 'text' ? stylesPage(el)
      : p === 'code' ? codePage(el)
      : p === 'wrap' ? wrapPage(el)
      : p === 'controls' ? controlsPage($, el, lastText)
      : p === 'rich' ? richPage(el)
      : p === 'graphics' ? graphicsPage(el)
      : p === 'client' ? clientPage(el)
      : bandPage(el, band, hint, lastText)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {p} | cols {e.props.bodyColumns} | rows {e.props.scroll.bodyRows} | {e.props.placement}
        </Text>
        {body}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey || !(await read($, bandOn))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const inner = await next(e)
    const chips = ['inbox', 'todo', 'idea']
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text dimColor>chips</Text>
          {chips.map((c, i) => (
            <Button key={`chip-${c}`} plain hotkey={String(i + 1)} label={c} onPress={() => void rec($, `chip ${c}`)} />
          ))}
          <Button key="chip-x" label="x" onPress={() => void update($, bandOn, () => false)} />
        </Box>
        {inner}
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const m = await read($, hintMode)
    if (e.surface !== 'terminal' || m === 'off') return next(e)
    if (m === 'tail') return next({ ...e, props: { ...e.props, tail: ' | gallery tail' } })
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="claude">gallery hint tree</Text>
        <Text dimColor> draft={String(e.props.isDraft)} working={String(e.props.isWorking)}</Text>
      </Box>
    )
  })

  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    const deco = [...(r.decorations ?? [])]
    if (r.text.startsWith('//')) deco.push({ start: 0, end: 2, color: 'warning', bold: true })
    if (r.text.startsWith('//')) deco.push({ start: 2, end: r.text.length, italic: true, underline: true })
    return { ...r, decorations: deco }
  })
}
