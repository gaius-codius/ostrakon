export type SpmockPlaceholder = never

declare module 'claude-code' {
  interface PluginState {
    spmock: {
      direction: string
      view: string
      band: string
    }
  }
}
