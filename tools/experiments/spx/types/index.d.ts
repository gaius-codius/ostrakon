export type SpxPlaceholder = never

declare module 'claude-code' {
  interface PluginState {
    spx: {
      pendingFocus: string
      stash: string
      slashVariant: string
      focusLog: string[]
    }
  }
}
