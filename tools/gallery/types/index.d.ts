export type GalleryPage = string

declare module 'claude-code' {
  interface PluginState {
    spgallery: {
      page: string
      last: string
      band: boolean
      hint: string
    }
  }
}
