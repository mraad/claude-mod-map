// Bridge tests: node --test web/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 18765
const HOST = `127.0.0.1:${PORT}`
let bridge

before(async () => {
  bridge = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, String(PORT)], {
    env: { ...process.env, CHROME: '/usr/bin/false', ARCGIS_MAP_TOKEN: 'test-token' },
  })
  for await (const chunk of bridge.stdout) if (String(chunk).includes('bridge:')) break
})
after(async () => {
  bridge.kill()
  await once(bridge, 'exit')
})

// node:http, not fetch: fetch will not send a custom Host header.
const call = (method, path, { body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { host: HOST, 'x-arcgis-map-token': 'test-token', ...headers } }, res => {
      let text = ''
      res.on('data', c => (text += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })

test('a foreign Host (DNS rebinding) or Origin (other web page) is refused', async () => {
  assert.equal((await call('GET', '/state', { headers: { host: 'evil.example:18765' } })).status, 403)
  const crossSite = await call('POST', '/files', {
    body: { path: '/etc/hosts' },
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
  })
  assert.equal(crossSite.status, 403)
  assert.equal((await call('GET', '/state', { headers: { origin: `http://${HOST}` } })).status, 200)
})

test('/files refuses a path that is not a file', async () => {
  const res = await call('POST', '/files', { body: { path: '/no/such/file.parquet' } })
  assert.equal(res.status, 400)
  assert.equal((await call('GET', '/files/999/x')).status, 404)
})

test('a registered file is served whole, by HEAD, and by suffix and open ranges', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'data.parquet')
  writeFileSync(path, '0123456789')
  const { url } = JSON.parse((await call('POST', '/files', { body: { path } })).text)
  assert.equal(JSON.parse((await call('POST', '/files', { body: { path } })).text).url, url, 'same path, same URL')

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
})

test('/cmd with no map tab answers 503 with the map state', async () => {
  const res = await call('POST', '/cmd', { body: { op: 'go_to', args: { zoom: 3 } } })
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.text).state.isConnected, false)
})

test('/input: events before any viewer are refused; a Chrome that cannot start is reported, not hung', async () => {
  const early = await call('POST', '/input', { body: { events: [{ seq: 1, kind: 'key', key: '+' }] } })
  assert.equal(early.status, 409)
  assert.equal((await call('POST', '/input', { body: { size: { columns: 40, rows: 10 } } })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 500))
  const after = await call('POST', '/input', { body: { events: [{ seq: 2, kind: 'key', key: '+' }] } })
  assert.equal(after.status, 409, 'the failed viewer was dropped, so the next size can retry')
})

test('control endpoints need the mod token; file URLs are unguessable', async () => {
  for (const path of ['/cmd', '/files', '/input']) {
    const res = await call('POST', path, { body: {}, headers: { 'x-arcgis-map-token': 'wrong' } })
    assert.equal(res.status, 403, path)
  }
  assert.equal((await call('GET', '/state', { headers: { 'x-arcgis-map-token': '' } })).status, 200, 'pages need no token')
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'a.geojson')
  writeFileSync(file, '{}')
  const { url } = JSON.parse((await call('POST', '/files', { body: { path: file } })).text)
  assert.match(url, /^\/files\/[0-9a-f-]{36}\/a\.geojson$/)
})
