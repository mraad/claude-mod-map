export type MapLayer = { id: string; title: string; type: string; count?: number; visible?: false }

export type MapStatus = {
  isConnected: boolean
  layers: MapLayer[]
  center?: [number, number]
  zoom?: number
}

/** The pane's map picture: the PNG file the bridge rewrites per frame ('' until the first), or why there is none. */
export type MapFrame = { path: string; generation: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'arcgis-map': { status: Shaped<MapStatus>; frame: Shaped<MapFrame> }
  }
}
