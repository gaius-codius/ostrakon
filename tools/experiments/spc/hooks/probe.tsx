// Surface module: shows and posts every key it receives, so the runner can tell who has the keys.
type S = { keys: string[] }

export default function Probe(props: { label?: string } | undefined, surface: any) {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.onKey((ev: { key: string; ctrl?: true; shift?: true; meta?: true }) => {
      const tag = `${ev.ctrl ? 'C-' : ''}${ev.meta ? 'M-' : ''}${ev.shift ? 'S-' : ''}${JSON.stringify(ev.key)}`
      const keys = [...(surface.state?.keys ?? []), tag].slice(-16)
      surface.setState({ keys })
      surface.post({ key: tag })
    })
    surface.setState({ keys: [] })
  }
  const keys: string[] = surface.state?.keys ?? []
  return Box({
    flexDirection: 'column', borderStyle: 'round', paddingX: 1,
    children: [
      Text({ bold: true, children: `client ${props?.label ?? ''}` }),
      Text({ children: `keys: ${keys.join(' ') || '(none)'}` }),
    ],
  })
}
