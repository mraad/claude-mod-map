// The pane viewer with real headless Chrome: node --test web/
// Skipped when Chrome is missing. Needs the network (the ArcGIS SDK and basemap tiles).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 18769
const BASE = `http://127.0.0.1:${PORT}`
const skip = !existsSync(CHROME) && 'Chrome is not installed'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const state = async () => (await fetch(`${BASE}/state`)).json()

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
