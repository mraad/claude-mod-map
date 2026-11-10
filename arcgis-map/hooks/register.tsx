import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MapFrame, MapStatus } from '../types'

// shortcut: fixed port, one map per machine; make it a userConfig option if two sessions need maps.
const PORT = 8765
const BASE = `http://127.0.0.1:${PORT}`
const PANE = 'arcgis-map'
// The pane body: two header rows, then the map region.
const HEADER_ROWS = 2
// Proves to the bridge that a control request comes from this mod; new per load, like the bridge.
const TOKEN = crypto.randomUUID()

// Change the tag when MapStatus changes: it declines what an earlier version stored.
const status = atom({ plugin: 'arcgis-map', key: 'status' } as const, { isConnected: false, layers: [] } as MapStatus, {
  shape: 'status-2',
})
const frame = atom({ plugin: 'arcgis-map', key: 'frame' } as const, { path: '', generation: 0 } as MapFrame, { shape: 'frame-2' })
// What the bridge already got from the pane's viewer-client: its instance id, last event seq and size.
let seen = { id: '', seq: 0, size: '' }
// Why the bridge is not running (it exited, e.g. another session holds the port); '' while it runs.
let bridgeDown = ''

const GEOMETRY = {
  type: 'object',
  description: 'GeoJSON geometry in WGS84 lon/lat: Point, MultiPoint, LineString, MultiLineString, Polygon or MultiPolygon.',
  properties: { type: { type: 'string' }, coordinates: { type: 'array' } },
  required: ['type', 'coordinates'],
}

const LAYER_PROPERTIES = {
  title: { type: 'string' },
  renderer: { type: 'object', description: 'ArcGIS autocast renderer JSON (simple, unique-value, class-breaks, heatmap...).' },
  definitionExpression: { type: 'string', description: 'SQL where clause (feature, GeoJSON, CSV, Parquet layers).' },
  labelingInfo: { type: 'array', items: { type: 'object' }, description: 'ArcGIS autocast LabelClass JSON list; turns labels on.' },
  opacity: { type: 'number' },
} as const

const TOOLS = [
  {
    name: 'add_graphic',
    description:
      'Add one graphic to a graphics layer on the live ArcGIS map (the layer is created if missing). Use for points, lines and polygons you compute or geocode yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        geometry: GEOMETRY,
        layer: { type: 'string', description: 'Graphics layer title. Default "Graphics".' },
        symbol: {
          type: 'object',
          description:
            'ArcGIS autocast symbol JSON, e.g. {"type":"simple-marker","color":"blue","size":12}. Default: red marker/line/fill.',
        },
        attributes: { type: 'object', description: 'Attributes shown in the popup.' },
        popupTitle: { type: 'string' },
      },
      required: ['geometry'],
    },
  },
  {
    name: 'add_layer',
    description:
      'Add a map layer to the live map, then zoom to it: a service URL, a GeoJSON, CSV or GeoParquet file (URL or local path), inline GeoJSON (data), or an ArcGIS Online portal item id. Use data for analysis results: one call for all features. Features get a popup of their attributes. Answers the new layer id or the load error.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['feature', 'geojson', 'csv', 'parquet', 'tile', 'vector-tile', 'imagery', 'map-image', 'portal-item'] },
        url: { type: 'string', description: 'Service or file URL (all types except portal-item).' },
        urls: { type: 'array', items: { type: 'string' }, description: 'More GeoParquet file URLs (parquet only).' },
        path: { type: 'string', description: 'Absolute local path of a .geojson, .csv or .parquet file; served to the map in place of url.' },
        data: { type: 'object', description: 'Inline GeoJSON FeatureCollection in WGS84 (geojson only), in place of url or path.' },
        itemId: { type: 'string', description: 'Portal item id (portal-item only).' },
        ...LAYER_PROPERTIES,
        zoomTo: { type: 'boolean', description: 'Default true.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'update_layer',
    description: 'Change a layer on the live map by id or title: symbology (renderer), filter, labels, opacity, visibility or title. No reload of its data.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, ...LAYER_PROPERTIES, visible: { type: 'boolean' } },
      required: ['id'],
    },
  },
  {
    name: 'remove_layer',
    description: 'Remove a layer from the live map by id or title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'clear_graphics',
    description: 'Remove all graphics from one graphics layer (by title or id), or from all of them when layer is omitted.',
    inputSchema: { type: 'object', properties: { layer: { type: 'string' } } },
  },
  {
    name: 'go_to',
    description: 'Move the live map: to center [lon, lat] and/or zoom level, or to a layer by id or title.',
    inputSchema: {
      type: 'object',
      properties: {
        center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        zoom: { type: 'number' },
        layerId: { type: 'string' },
      },
    },
  },
  {
    name: 'set_basemap',
    description:
      'Change the basemap of the live map; layers stay on top. No key needed: "osm", "dark-gray" (dark mode), "light-gray", "imagery", "topo", "streets". Esri styles (e.g. "arcgis/topographic") need the page opened with ?apiKey= and are refused without one.',
    inputSchema: { type: 'object', properties: { basemap: { type: 'string' } }, required: ['basemap'] },
  },
  {
    name: 'screenshot',
    description: 'Save a PNG of the live map as it shows now and answer its path. Read the file to check the map, or hand it to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Picture width in pixels. Default: the answering map page\'s size.' },
        height: { type: 'number', description: 'Picture height in pixels.' },
      },
    },
  },
  {
    name: 'map_state',
    description: 'Read the live map: layers (id, title, type, graphic count), center and zoom.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

type Reply = { ok: boolean; error?: string; result?: unknown; state?: MapStatus }

async function setStatus($: EngineInterface, next: MapStatus) {
  await update($, status, () => next)
  $.ui.status(next.isConnected ? `map: ${next.layers.length} layers` : 'map: no tab')
}

async function call($: EngineInterface, path: string, body?: unknown): Promise<Reply> {
  try {
    const res = await $.http.fetch(`${BASE}${path}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arcgis-map-token': TOKEN },
      body: JSON.stringify(body),
    })
    return JSON.parse(res.text) as Reply
  } catch (err) {
    return { ok: false, error: `bridge unreachable at ${BASE}: ${String(err)}` }
  }
}

// Sends one tool call to the map pages; map_state is answered by the bridge alone.
async function run($: EngineInterface, op: string, args: Record<string, unknown>): Promise<Reply> {
  if (bridgeDown) return { ok: false, error: `the map bridge is not running: ${bridgeDown}` }
  if (op === 'map_state') {
    const reply = await call($, '/state')
    return 'error' in reply ? reply : { ok: true, state: reply as unknown as MapStatus }
  }
  return call($, '/cmd', { op, args })
}

// The bridge could not start (another session holds the port): say so in the status line and in tool errors.
async function stopped($: EngineInterface, why: string) {
  bridgeDown = why
  await update($, status, () => ({ isConnected: false, layers: [] }))
  $.ui.status('map: off')
  $.ui.log(`arcgis-map: the map bridge stopped: ${why}`)
}

// The first frame (or a new file) redraws the pane with the Image; later ones only swap its picture.
async function showFrame($: EngineInterface, line: string) {
  const [, path = '', gen = '0'] = line.split(' ')
  const generation = Number(gen)
  if ((await read($, frame)).path !== path) return update($, frame, () => ({ path, generation }))
  await $.ui.blit({ requestId: PANE, key: 'map', source: { file: path, format: 'png', generation } })
}

// The bridge's Chrome died (restart it with the pane's last size), gave up, or stopped for a closed pane.
async function viewerChanged($: EngineInterface, line: string) {
  const [, what = '', ...why] = line.split(' ')
  await update($, frame, () => ({ path: '', generation: 0, ...(what === 'failed' ? { error: why.join(' ') } : {}) }))
  if (what === 'down' && seen.size) await call($, '/input', { size: JSON.parse(seen.size) })
}

// The map as a Chrome app window (no tabs or toolbar) on the right half of the screen Ghostty is on.
// shortcut: right half of the focused screen, not Ghostty's real window; read its bounds (needs Accessibility) if they differ.
// AppKit through JXA, no permission needed: the focused screen's usable area, flipped to top-left coordinates.
const SCREEN = `ObjC.import("AppKit"); const s = $.NSScreen.mainScreen.visibleFrame; const p = $.NSScreen.screens.objectAtIndex(0).frame;
[s.origin.x, p.size.height - (s.origin.y + s.size.height), s.size.width, s.size.height].join(",")`

async function openBrowser($: EngineInterface): Promise<string | undefined> {
  let [x, y, width, height] = [0, 0, 1280, 900]
  const screen = await $.process.run(['osascript', '-l', 'JavaScript', '-e', SCREEN]).catch(() => undefined)
  const box = screen?.stdout.split(',').map(Number) ?? []
  if (box.length === 4 && box.every(Number.isFinite)) {
    const [left = 0, top = 0, w = 0, h = 0] = box
    ;[x, y, width, height] = [left + Math.round(w / 2), top, Math.round(w / 2), h]
  }
  // Its own profile, in the mod's folder (per user, not a shared /tmp path): a running Chrome ignores
  // the size and place of a new window in the person's own profile.
  const opened = await $.process.run(['open', '-na', 'Google Chrome', '--args', `--app=${BASE}/`, `--user-data-dir=${$.plugin.root}/.browser-profile`,
    `--window-position=${x},${y}`, `--window-size=${width},${height}`]).catch(err => ({ exitCode: 1, stderr: String(err) }))
  return opened.exitCode === 0 ? undefined : `Chrome did not open: ${opened.stderr.trim() || `exit ${opened.exitCode}`}. Open ${BASE}/ in any browser.`
}

type ViewerPost = { id?: string; events?: { seq: number; at?: number }[]; size?: { columns: number; rows: number } }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A new bridge has no picture yet; the old one's file went with it.
    await update($, frame, () => ({ path: '', generation: 0 }))
    // The bridge lives as long as this module; a reload kills and restarts it.
    // It prints one `STATE {...}` line per map change: the pane and status line follow those.
    // The map is saved per session, so a mod reload or `--resume` shows it again.
    const session = await $.session.id().catch(() => '')
    bridgeDown = ''
    void (async () => {
      const bridge = $.process.spawn({ argv: ['node', `${$.plugin.root}/web/server.mjs`, String(PORT)], env: { ARCGIS_MAP_TOKEN: TOKEN, ARCGIS_MAP_SESSION: session } })
      let buffer = ''
      for await (const { stream, text } of bridge) {
        if (stream !== 'stdout') {
          $.ui.log(text.trim(), { to: 'debug' })
          continue
        }
        buffer += text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          try {
            if (line.startsWith('STATE ')) await setStatus($, JSON.parse(line.slice(6)) as MapStatus)
            else if (line.startsWith('FRAME ')) await showFrame($, line)
            else if (line.startsWith('VIEWER ')) await viewerChanged($, line)
            else if (line.startsWith('BRIDGE down ')) await stopped($, line.slice(12))
            else if (line.trim()) $.ui.log(line, { to: 'debug' })
          } catch (err) {
            $.ui.log(`arcgis-map: bad bridge line skipped: ${String(err)}`, { to: 'debug' })
          }
        }
      }
    })().catch(err => $.ui.log(`arcgis-map bridge failed: ${String(err)}`))

    await Promise.all([
      ...TOOLS.map(tool => $.tool.register({ ...tool, isDeferred: false })),
      $.command.register({ name: 'map', description: 'Show the ArcGIS map: in the side pane, or in a browser window', argumentHint: '[pane|browser]' }),
    ])
    return started
  })

  // One hook for the mod's own tools; a RegExp because the engine's tool-name type lists only tools seen at load.
  on('tool.call', { tool: /^mcp__arcgis-map__/ }, async ($, e) => {
    const tool = TOOLS.find(t => e.tool === `mcp__arcgis-map__${t.name}`)
    if (!tool) return { deny: `arcgis-map: no tool ${e.tool}` }
    const input = e as Record<string, unknown>
    const args = Object.fromEntries(Object.keys(tool.inputSchema.properties).filter(k => input[k] !== undefined).map(k => [k, input[k]]))
    const reply = await run($, tool.name, args)
    if (!reply.ok) return { deny: `arcgis-map: ${reply.error ?? 'failed'}` }
    return { result: JSON.stringify({ result: reply.result, map: reply.state }) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'arcgis-map: the tool hook failed.' }))

  // Both views show the same map and take the same tools; they can be open at once.
  on('command.run', { command: 'map' }, async ($, e) => {
    const mode = e.args.trim().toLowerCase() || 'pane'
    if (mode === 'browser') return { text: (await openBrowser($)) ?? `Map opened in a browser window at ${BASE}/` }
    if (mode !== 'pane') return { text: 'Usage: /map [pane|browser]' }
    await $.ui.open({ id: PANE, title: 'ArcGIS map' })
    return { text: `Map in the pane; /map browser opens it in a browser window too` }
  })

  // The pane's viewer-client posts its recent mouse and key events and its size: pass on only what is new.
  // Every post also tells the bridge the pane is still open.
  on('ui.message', { element: 'map' }, async ($, e) => {
    const post = e.data as ViewerPost
    // An instance not seen before (or a reload that forgot it): its old events are history, not input.
    const since = post.id === seen.id ? 0 : Date.now() - 1000
    if (post.id !== seen.id) seen = { id: post.id ?? '', seq: 0, size: '' }
    const events = (post.events ?? []).filter(event => event.seq > seen.seq && (event.at ?? 0) > since)
    const size = post.size && post.size.columns > 0 ? JSON.stringify(post.size) : seen.size
    const body: Record<string, unknown> = {}
    if (size !== seen.size) body.size = post.size
    if (events.length) body.events = events
    seen = { id: seen.id, seq: Math.max(seen.seq, ...(post.events ?? []).map(event => event.seq)), size }
    await call($, '/input', body)
    return {}
  })

  // The wheel over the map zooms it at the pointer; the pane itself has nothing to scroll.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const size = seen.size ? (JSON.parse(seen.size) as { columns: number; rows: number }) : undefined
    if (e.by && e.pointer && size) {
      const x = (e.pointer.column + 0.5) / size.columns
      const y = (e.pointer.row - HEADER_ROWS + 0.5) / size.rows
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) await call($, '/input', { events: [{ kind: 'wheel', by: e.by, x, y }] })
    }
    return {}
  }).catch(() => ({}))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await read($, status)
    const layers = s.layers.map(l => (l.count != null ? `${l.title} (${l.count})` : l.title)).join(' · ')
    const { Box, Text } = $.ui.resolve(e)
    const header = (
      <>
        <Text wrap="truncate">
          <Text color={s.isConnected ? 'green' : 'red'}>●</Text> {s.layers.length} layers{s.zoom != null ? ` · zoom ${s.zoom}` : ''}
          <Text dimColor> · {BASE}/</Text>
        </Text>
        <Text dimColor wrap="truncate">
          {layers || 'no layers'}
        </Text>
      </>
    )
    // Only the terminal draws pictures (Image) and takes the pointer over them (Client).
    if (e.surface !== 'terminal') {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>The map picture shows in the terminal; open {BASE}/ here.</Text>
        </Box>
      )
    }
    const { Client, Image } = $.ui.resolve(e)
    const picture = await read($, frame)
    const columns = Math.max(10, e.props.bodyColumns)
    const rows = Math.max(4, e.props.scroll.bodyRows - HEADER_ROWS)

    return (
      <Box flexDirection="column">
        {header}
        {/* The Client catches mouse and keys; the Image is painted over it, and the pointer passes through. */}
        <Box width={columns} height={rows}>
          <Client key="map" module="./viewer-client.ts" width={columns} height={rows} />
          <Box position="absolute" top={0} left={0}>
            {picture.path ? (
              <Image key="map" source={{ file: picture.path, format: 'png', generation: picture.generation }} columns={columns} rows={rows} alt="ArcGIS map" />
            ) : picture.error ? (
              <Text color="red">The map could not start: {picture.error}</Text>
            ) : (
              <Text dimColor>starting the map…</Text>
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}
