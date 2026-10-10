export type SpwPlaceholder = never

declare module 'claude-code' {
  interface PluginState {
    spw: {
      full: string
      pairs: { head: string; tail: string }[]
      width: number
    }
  }
}
