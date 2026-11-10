// Replays the demo against a bridge started by hand (no token): node arcgis-map/web/server.mjs 8765
// Sends the same POST /cmd bodies the mod's tools send; each screenshot prints the path of its PNG.
import { startViewer } from '../arcgis-map/web/viewer.mjs'

const BASE = 'http://127.0.0.1:8765'
const DIR = new URL('.', import.meta.url).pathname
const send = async (op, args = {}) => {
  if (op === 'map_state') return { state: await (await fetch(`${BASE}/state`)).json() }
  const res = await fetch(`${BASE}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) })
  const reply = await res.json()
  console.log(op, res.status, JSON.stringify(reply.ok ? reply.result : reply.error))
  return reply
}

// The map page in headless Chrome (the pane's viewer), 1280 x 800 px; no other dependency.
const page = await startViewer({ url: `${BASE}/`, columns: 128, rows: 40, onFrame: () => {} })
while (!(await (await fetch(`${BASE}/state`)).json()).isConnected) await new Promise(r => setTimeout(r, 200))
await new Promise(r => setTimeout(r, 2000))
await send('screenshot')

await send('add_graphic', {
  geometry: { type: 'Point', coordinates: [47.9783, 29.3759] },
  attributes: { name: 'Kuwait City' },
  popupTitle: 'Kuwait City',
  symbol: { type: 'simple-marker', color: 'blue', size: 14, outline: { color: 'white', width: 2 } },
})
await send('add_graphic', {
  layer: 'Areas',
  geometry: { type: 'Polygon', coordinates: [[[47.75, 29.33], [48.05, 29.33], [48.05, 29.5], [47.75, 29.5], [47.75, 29.33]]] },
  attributes: { name: 'Kuwait Bay box' },
})
await send('add_layer', {
  type: 'feature',
  url: 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/World_Countries_(Generalized)/FeatureServer/0',
  title: 'Kuwait outline',
  definitionExpression: "COUNTRY = 'Kuwait'",
  renderer: { type: 'simple', symbol: { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [20, 120, 60], width: 2.5 } } },
  zoomTo: false,
})
await send('add_layer', { type: 'parquet', path: `${DIR}../examples/cities.parquet`, title: 'Cities (GeoParquet)', zoomTo: false })
await send('go_to', { center: [47.95, 29.35], zoom: 9 })
await new Promise(r => setTimeout(r, 5000))
await send('screenshot')
const state = await send('map_state')
console.log('state', JSON.stringify(state.state))
await send('clear_graphics', { layer: 'Kuwait outline' })
await send('add_layer', { type: 'geojson', url: 'https://example.invalid/nope.geojson' })
await page.close()
