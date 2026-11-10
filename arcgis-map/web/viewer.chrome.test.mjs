// The pane viewer with real headless Chrome: node --test web/
// Skipped when Chrome is missing. Needs the network (the ArcGIS SDK and basemap tiles).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { startViewer } from './viewer.mjs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 18769
const BASE = `http://127.0.0.1:${PORT}`
const skip = !existsSync(CHROME) && 'Chrome is not installed'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const state = async () => (await fetch(`${BASE}/state`)).json()
const cmd = async (op, args = {}) => {
  const res = await post('/cmd', { op, args })
  return { status: res.status, ...(await res.json()) }
}
const waitConnected = async (isConnected = true) => {
  for (let i = 0; i < 300 && (await state()).isConnected !== isConnected; i++) await sleep(100)
}

let bridge
const lines = []
const waitLine = async (match, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const hit = lines.findLast(line => match.test(line))
    if (hit) return hit
    await sleep(50)
  }
  throw new Error(`no line like ${match} within ${timeout} ms`)
}

before(async () => {
  if (skip) return
  bridge = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, String(PORT)], {
    env: { ...process.env, ARCGIS_MAP_IDLE_MS: '8000' },
  })
  createInterface({ input: bridge.stdout }).on('line', line => lines.push(line))
  await waitLine(/^bridge:/)
})
after(() => bridge?.kill())

let seq = 0
const pointer = (type, x) => ({ seq: ++seq, kind: 'pointer', type, x, y: 0.5, button: 'left', at: Date.now() })

test('the pane size starts Chrome; frames land in a PNG file; a drag pans the map', { skip, timeout: 60000 }, async () => {
  await post('/input', { size: { columns: 60, rows: 25 } })
  const [, path] = (await waitLine(/^FRAME /)).split(' ')
  assert.ok(statSync(path).size > 0)
  while (!(await state()).isConnected) await sleep(100)

  await post('/cmd', { op: 'go_to', args: { center: [10, 45], zoom: 6 } })
  const start = (await state()).center[0]
  await post('/input', { events: [pointer('down', 0.5)] })
  for (let x = 0.47; x >= 0.2; x -= 0.03) {
    await sleep(16)
    await post('/input', { events: [pointer('move', x)] })
  }
  await post('/input', { events: [pointer('up', 0.2)] })
  let center = start
  for (let i = 0; i < 60 && center === start; i++) {
    await sleep(100)
    center = (await state()).center[0]
  }
  assert.ok(center > start, `dragging left moves the map east: ${start} -> ${center}`)
})

test('a Chrome that dies is reported as VIEWER down, and the next size starts a new one', { skip, timeout: 60000 }, async () => {
  const [, path] = (await waitLine(/^FRAME /)).split(' ')
  execFileSync('pkill', ['-f', dirname(path)])
  await waitLine(/^VIEWER down$/)
  assert.equal(existsSync(dirname(path)), false, 'the dead viewer left no temp folder')
  lines.length = 0
  await post('/input', { size: { columns: 60, rows: 25 } })
  const [, next] = (await waitLine(/^FRAME /)).split(' ')
  assert.notEqual(dirname(next), dirname(path))
})

test('a pane that stops posting frees Chrome (VIEWER idle)', { skip, timeout: 60000 }, async () => {
  const [, path] = (await waitLine(/^FRAME /)).split(' ')
  await waitLine(/^VIEWER idle$/, 30000)
  assert.equal(existsSync(dirname(path)), false, 'its temp folder is gone')
})

test('the tools work on the real page; a page that connects later rebuilds the same map', { skip, timeout: 90000 }, async () => {
  const open = () => startViewer({ url: `${BASE}/`, columns: 80, rows: 30, onFrame: () => {} })
  let page = await open()
  await waitConnected()
  const data = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [47.98, 29.37] }, properties: { name: 'Kuwait City', score: 3 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [50.58, 26.22] }, properties: { name: 'Manama', score: 7 } },
    ],
  }
  const added = await cmd('add_layer', { type: 'geojson', data, title: 'Results' })
  assert.equal(added.status, 200, added.error)
  const { layerId } = added.result
  assert.match(layerId, /^L\d+$/)

  const labels = [{ labelExpressionInfo: { expression: '$feature.name' }, symbol: { type: 'text', color: 'black' } }]
  const renderer = { type: 'simple', symbol: { type: 'simple-marker', color: 'blue', size: 9 } }
  assert.equal((await cmd('update_layer', { id: 'Results', renderer, labelingInfo: labels, definitionExpression: 'score > 5' })).status, 200)
  assert.equal((await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [0, 0] }, layer: 'Notes' })).status, 200)
  const wrong = await cmd('update_layer', { id: 'Notes', definitionExpression: 'x = 1' })
  assert.equal(wrong.status, 422)
  assert.match(wrong.error, /graphics layer has no definitionExpression/)
  assert.equal((await cmd('set_basemap', { basemap: 'no-such-basemap' })).status, 422)

  const shot = await cmd('screenshot')
  assert.equal(shot.status, 200, shot.error)
  assert.equal(readFileSync(shot.result.path).subarray(1, 4).toString(), 'PNG')

  await page.close()
  await waitConnected(false)
  page = await open()
  await waitConnected()
  // Only a page that replayed the log has a layer with this id.
  const again = await cmd('update_layer', { id: layerId, opacity: 0.5 })
  assert.equal(again.status, 200, again.error)
  const titles = again.state.layers.map(l => l.title)
  assert.deepEqual(titles, ['Results', 'Notes'])
  await page.close()
})
