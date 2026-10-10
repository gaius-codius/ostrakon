// Surface module for the gallery's Client element: records the keys it receives.
type S = { keys: string[]; focusNote: string }

const buf: string[] = []

export default function KeyProbe(_props: unknown, surface: any) {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onKey((ev: { key: string; ctrl?: true; shift?: true; meta?: true }) => {
      const tag = `${ev.ctrl ? 'C-' : ''}${ev.meta ? 'M-' : ''}${ev.shift ? 'S-' : ''}${ev.key}`
      buf.push(tag)
      if (buf.length > 12) buf.shift()
      surface.setState({ keys: [...buf], focusNote: 'got key' } as S)
    })
    surface.setState({ keys: [], focusNote: 'no key yet' } as S)
  }
  const st: S = surface.state ?? { keys: [], focusNote: '' }
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    paddingX: 1,
    children: [
      Text({ bold: true, children: 'Client (raw keys)' }),
      Text({ dimColor: true, children: `region ${surface.columns}x${surface.rows}; ${st.focusNote}` }),
      Text({ color: 'success', children: `keys: ${st.keys.join(' ') || '(click me, then type)'}` }),
    ],
  })
}
