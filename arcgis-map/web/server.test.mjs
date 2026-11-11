// Bridge tests: node --test web/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18765
const SAVED_PORT = 18766
const SERVER = new URL('./server.mjs', import.meta.url).pathname
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let bridge

const startBridge = async (port, env = {}) => {
  const child = spawn(process.execPath, [SERVER, String(port)], {
    env: { ...process.env, CHROME: '/usr/bin/false', ARCGIS_MAP_TOKEN: 'test-token', ...env },
  })
  child.lines = []
  child.stdout.on('data', chunk => child.lines.push(...String(chunk).split('\n').filter(Boolean)))
  while (!child.lines.some(line => line.startsWith('bridge:') || line.startsWith('BRIDGE down'))) await sleep(20)
  return child
}
const stopBridge = async child => {
  if (child.exitCode !== null) return
  child.kill()
  await once(child, 'exit')
}

before(async () => {
  bridge = await startBridge(PORT, { ARCGIS_MAP_TIMEOUT_MS: '1000' })
})
after(() => stopBridge(bridge))

// node:http, not fetch: fetch will not send a custom Host header.
const call = (method, path, { body, headers = {}, port = PORT } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, 'x-arcgis-map-token': 'test-token', ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
const cmd = (op, args = {}, port = PORT) => call('POST', '/cmd', { body: { op, args }, port }).then(res => ({ status: res.status, ...JSON.parse(res.text) }))

// A map page as the bridge sees it: an SSE reader that answers each command with `answer(message)`.
function page({ port = PORT, lastEventId, answer = () => ({ ok: true, result: {} }) } = {}) {
  const messages = []
  const ids = []
  const headers = { host: `127.0.0.1:${port}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }
  const req = request({ host: '127.0.0.1', port, path: '/events', headers }, res => {
    let buffer = ''
    res.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = /^data: (.*)$/m.exec(block)
        if (!data || /^event: /m.test(block)) continue // only unnamed events are commands, as in EventSource.onmessage
        const message = JSON.parse(data[1])
        messages.push(message)
        ids.push(/^id: (.*)$/m.exec(block)?.[1])
        if (message.id != null && !message.replay) {
          Promise.resolve(answer(message)).then(reply => reply && call('POST', '/ack', { body: { id: message.id, ...reply }, port }))
        }
      }
    })
  })
  req.end()
  const until = async check => {
    for (let i = 0; i < 200 && !check(); i++) await sleep(10)
  }
  return { messages, ids, until, close: () => req.destroy() }
}

// Runs first: no page is connected yet.
test('/cmd with no map page answers 503 with the map state', async () => {
  const res = await cmd('go_to', { zoom: 3 })
  assert.equal(res.status, 503)
  assert.equal(res.state.isConnected, false)
})

test('a foreign Host (DNS rebinding) or Origin (other web page) is refused', async () => {
  assert.equal((await call('GET', '/state', { headers: { host: 'evil.example:18765' } })).status, 403)
  const crossSite = await call('POST', '/cmd', {
    body: { op: 'add_layer', args: { type: 'geojson', path: '/etc/hosts' } },
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal((await call('GET', '/state', { headers: { origin: `http://127.0.0.1:${PORT}` } })).status, 200)
})

test('control endpoints need the mod token; pages need none', async () => {
  for (const path of ['/cmd', '/input']) {
    const res = await call('POST', path, { body: {}, headers: { 'x-arcgis-map-token': 'wrong' } })
    assert.equal(res.status, 403, path)
    assert.match(JSON.parse(res.text).error, /another Claude Code session/)
  }
  assert.equal((await call('GET', '/state', { headers: { 'x-arcgis-map-token': '' } })).status, 200)
})

test('a local path is refused when it is no file, and served under a random URL with HEAD and ranges', async () => {
  const tab = page()
  await tab.until(() => tab.messages.length)
  assert.equal((await cmd('add_layer', { type: 'parquet', path: '/no/such/file.parquet' })).status, 400)
  assert.equal((await call('GET', '/files/999/x')).status, 404)

  const path = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'data.parquet')
  writeFileSync(path, '0123456789')
  assert.equal((await cmd('add_layer', { type: 'parquet', path })).status, 200)
  const { url } = tab.messages.at(-1).args
  assert.match(url, /^\/files\/[0-9a-f-]{36}\/data\.parquet$/)
  assert.equal(tab.messages.at(-1).args.path, undefined, 'the page never sees the local path')

  assert.equal((await call('GET', url)).text, '0123456789')
  const head = await call('HEAD', url)
  assert.equal(head.headers['content-length'], '10')
  assert.equal(head.text, '')
  const tail = await call('GET', url, { headers: { range: 'bytes=-3' } })
  assert.equal(tail.status, 206)
  assert.equal(tail.text, '789')
  assert.equal(tail.headers['content-range'], 'bytes 7-9/10')
  assert.equal((await call('GET', url, { headers: { range: 'bytes=2-4' } })).text, '234')
  assert.equal((await call('GET', url, { headers: { range: 'bytes=20-' } })).status, 416)
  tab.close()
})

test('inline GeoJSON becomes a served file; data on another type is refused', async () => {
  const tab = page()
  await tab.until(() => tab.messages.length)
  const data = { type: 'FeatureCollection', features: [] }
  assert.equal((await cmd('add_layer', { type: 'geojson', data })).status, 200)
  const { url, data: sent } = tab.messages.at(-1).args
  assert.equal(sent, undefined)
  assert.deepEqual(JSON.parse((await call('GET', url)).text), data)
  assert.equal((await cmd('add_layer', { type: 'feature', data })).status, 400)
  tab.close()
})

test('each page connect gets the version stamped on the served page, so a page with old code reloads', async () => {
  const html = (await call('GET', '/')).text
  const version = /const PAGE_VERSION = '([0-9a-f]{12})'/.exec(html)?.[1]
  assert.ok(version, 'the page carries a 12-hex version')
  const stream = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/events', headers: { host: `127.0.0.1:${PORT}` } }, res => {
      let text = ''
      res.on('data', chunk => {
        text += chunk
        if (/event: version\ndata: .*\n\n/.test(text)) { req.destroy(); resolve(text) } // the whole event, not a chunk of it
      })
    })
    req.on('error', reject)
    req.end()
  })
  assert.match(stream, new RegExp(`event: version\ndata: ${version}\n\n`))
})

test('a new page replays the map; a reconnecting page gets only what it missed; failures and go_to are not replayed', async () => {
  const first = page({ answer: m => (m.op === 'remove_layer' ? { ok: false, error: 'no layer' } : { ok: true, result: {} }) })
  await first.until(() => first.messages.length)
  await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [1, 2] } })
  await cmd('go_to', { zoom: 4 })
  assert.equal((await cmd('remove_layer', { id: 'nope' })).status, 422)
  const lastId = first.ids.at(-1)
  first.close()

  const fresh = page()
  await fresh.until(() => fresh.messages.some(m => m.op === 'add_graphic'))
  await sleep(50)
  assert.equal(fresh.messages[0].op, 'reset')
  const replayed = fresh.messages.filter(m => m.replay && m.id != null)
  assert.ok(replayed.every(m => m.op === 'add_layer' || m.op === 'add_graphic'), replayed.map(m => m.op).join())
  const graphic = replayed.find(m => m.op === 'add_graphic')
  assert.equal(graphic.layerId, `L${graphic.id}`, 'the bridge names new layers, the same on every page')

  await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [3, 4] } })
  const back = page({ lastEventId: lastId })
  await sleep(150)
  assert.deepEqual(back.messages.map(m => m.op), ['add_graphic'], 'only the command sent after it left')
  fresh.close()
  back.close()
})

test('the first page that succeeds answers, even when another page failed first', async () => {
  const failing = page({ answer: () => ({ ok: false, error: 'broken page' }) })
  const slow = page({ answer: () => sleep(100).then(() => ({ ok: true, result: { from: 'slow' } })) })
  await failing.until(() => failing.messages.length)
  await slow.until(() => slow.messages.length)
  const res = await cmd('clear_graphics')
  assert.equal(res.status, 200)
  assert.deepEqual(res.result, { from: 'slow' })
  slow.close()
  await sleep(100) // the bridge sees the close
  const alone = await cmd('clear_graphics')
  assert.equal(alone.error, 'broken page', 'with every page failed, the error answers')
  failing.close()
})

test('a command no page answered in time stays in the log: it may still finish, so later pages replay it', async () => {
  const silent = page({ answer: () => undefined })
  await silent.until(() => silent.messages.length)
  const res = await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [5, 6] }, layer: 'Slow' })
  assert.equal(res.status, 422)
  assert.match(res.error, /did not answer in 1000 ms/)
  silent.close()
  const later = page()
  await later.until(() => later.messages.some(m => m.args?.layer === 'Slow'))
  assert.ok(later.messages.some(m => m.replay && m.args?.layer === 'Slow'))
  later.close()
})

test('a screenshot is written to a PNG file; its path answers, not the picture', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const tab = page({ answer: () => ({ ok: true, result: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: 8, height: 4 } }) })
  await tab.until(() => tab.messages.length)
  const { result } = await cmd('screenshot')
  assert.match(result.path, /\.png$/)
  assert.deepEqual(readFileSync(result.path), png)
  assert.equal(result.width, 8)
  tab.close()
})

test('/clear empties the map: open pages reset, and a page that reconnects with an old id starts over too', async () => {
  const open = page()
  await open.until(() => open.messages.length)
  await cmd('add_graphic', { geometry: { type: 'Point', coordinates: [7, 8] } })
  const lastId = open.ids.at(-1)
  open.close()
  const watching = page()
  await watching.until(() => watching.messages.some(m => m.op === 'add_graphic'))
  watching.messages.length = 0
  // The page reports its layers, as a real one does after a command.
  await call('POST', '/state', { body: { state: { layers: [{ id: 'L1', title: 'Graphics', type: 'graphics', count: 1 }], center: [7, 8], zoom: 6 } } })

  assert.equal((await call('POST', '/clear', { headers: { 'x-arcgis-map-token': '' } })).status, 403, 'the mod token is required')
  assert.equal(JSON.parse((await call('GET', '/state')).text).layers.length, 1, 'a refused clear changes nothing')
  const printed = bridge.lines.length
  const res = await call('POST', '/clear')
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.text).state, { layers: [], center: [7, 8], zoom: 6, isConnected: true }, 'layers gone, view kept')
  await sleep(50)
  const after = bridge.lines.slice(printed).filter(line => line.startsWith('STATE ')).map(line => JSON.parse(line.slice(6)))
  assert.deepEqual(after.map(s => s.layers), [[]], 'one STATE line, with no layers')
  await watching.until(() => watching.messages.length)
  assert.deepEqual(watching.messages.map(m => m.op), ['reset'])

  const back = page({ lastEventId: lastId })
  await back.until(() => back.messages.length)
  await sleep(100)
  assert.deepEqual(back.messages.filter(m => m.op !== 'go_to').map(m => m.op), ['reset'], 'nothing from before the clear')
  watching.close()
  back.close()
})

test('a session map is saved: a new bridge for the same session replays it, with the local path served again', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-home-'))
  const env = { HOME: home, ARCGIS_MAP_SESSION: 'session-1' }
  const sessions = join(home, '.claude/arcgis-map/sessions')
  const old = join(sessions, 'old-session')
  const recent = join(sessions, 'recent-session')
  mkdirSync(old, { recursive: true })
  mkdirSync(recent, { recursive: true })
  const longAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000)
  utimesSync(old, longAgo, longAgo)
  const file = join(home, 'sites.geojson')
  writeFileSync(file, '{"type":"FeatureCollection","features":[]}')
  let saved = await startBridge(SAVED_PORT, env)
  const tab = page({ port: SAVED_PORT })
  await tab.until(() => tab.messages.length)
  await cmd('add_layer', { type: 'geojson', path: file, title: 'Sites' }, SAVED_PORT)
  await call('POST', '/state', { body: { state: { layers: [], center: [10, 20], zoom: 5 } }, port: SAVED_PORT })
  tab.close()
  await stopBridge(saved)
  assert.ok(existsSync(join(home, '.claude/arcgis-map/sessions/session-1/map.json')))
  assert.equal(existsSync(old), false, 'a session map untouched for 30 days is deleted')
  assert.ok(existsSync(recent))

  saved = await startBridge(SAVED_PORT, env)
  const next = page({ port: SAVED_PORT })
  await next.until(() => next.messages.some(m => m.op === 'go_to'))
  const layer = next.messages.find(m => m.op === 'add_layer')
  assert.equal(layer.args.title, 'Sites')
  assert.equal((await call('GET', layer.args.url, { port: SAVED_PORT })).status, 200)
  assert.deepEqual(next.messages.at(-1).args, { center: [10, 20], zoom: 5 })
  next.close()
  await stopBridge(saved)
})

test('a bridge that cannot get its port says so, exits, and deletes no session folder', { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-home-'))
  const live = join(home, '.claude/arcgis-map/sessions/live-session')
  mkdirSync(live, { recursive: true })
  const longAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000)
  utimesSync(live, longAgo, longAgo)
  const second = await startBridge(PORT, { HOME: home, ARCGIS_MAP_SESSION: 'other-session' })
  assert.match(second.lines.find(line => line.startsWith('BRIDGE down')), /port 18765 is held/)
  await stopBridge(second)
  assert.ok(existsSync(live), 'only the bridge that holds the port cleans up')
})

test('a timeout that is zero or not a number keeps the 15 s default', async () => {
  const odd = await startBridge(SAVED_PORT, { ARCGIS_MAP_TIMEOUT_MS: 'abc' })
  const slow = page({ port: SAVED_PORT, answer: () => sleep(300).then(() => ({ ok: true, result: {} })) })
  await slow.until(() => slow.messages.length)
  assert.equal((await cmd('clear_graphics', {}, SAVED_PORT)).status, 200)
  slow.close()
  await stopBridge(odd)
})

test('/input: events before any viewer are refused; a Chrome that cannot start is reported, not hung', async () => {
  const early = await call('POST', '/input', { body: { events: [{ seq: 1, kind: 'key', key: '+' }] } })
  assert.equal(early.status, 409)
  assert.equal((await call('POST', '/input', { body: { size: { columns: 40, rows: 10 } } })).status, 200)
  await sleep(500)
  const after = await call('POST', '/input', { body: { events: [{ seq: 2, kind: 'key', key: '+' }] } })
  assert.equal(after.status, 409, 'the failed viewer was dropped, so the next size can retry')
})
