// Bridge between the arcgis-map mod and the browser tab that holds the map.
// Mod: POST /cmd {op, args} -> waits for the tab's answer; POST /files {path} -> {url}.
// Tab: GET /events (SSE), POST /ack (a command's answer), POST /state (manual pan or layer change).
// Pane: POST /input {size} starts headless Chrome on this page (viewer.mjs); {events} are its mouse and keys.
// Stdout lines the mod reads: `STATE {...}` per map change, `FRAME <path> <generation>` per pane picture,
// `VIEWER down` (Chrome died: send the size again to restart), `VIEWER failed <why>` (gave up), `VIEWER idle`.
import { createServer } from 'node:http'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { text } from 'node:stream/consumers'

import { startViewer } from './viewer.mjs'

const PORT = Number(process.argv[2] ?? 8765)
const PAGE = readFileSync(new URL('./index.html', import.meta.url))
const TIMEOUT_MS = 15000

const tabs = new Set()
const pending = new Map()
let state = { layers: [] }
let nextId = 1
// Local files the mod asked to show, by key and by path; only these are served, never an arbitrary path.
const files = new Map()
const fileKeys = new Map()
// The pane's headless Chrome: started by the first size the pane reports, stopped when the pane goes quiet
// (its Client posts a heartbeat every 30 s while mounted), restarted on request after a crash, 3 tries at most.
let viewer
let viewerFailures = 0
let lastInput = 0
const MAX_VIEWER_FAILURES = 3
const IDLE_MS = Number(process.env.ARCGIS_MAP_IDLE_MS ?? 90000)

function viewerDown(reason) {
  console.error(`viewer down: ${reason}`)
  console.log(++viewerFailures >= MAX_VIEWER_FAILURES ? `VIEWER failed ${reason}` : 'VIEWER down')
}

function startPaneViewer(size) {
  if (viewerFailures >= MAX_VIEWER_FAILURES) return
  const mine = startViewer({
    url: `http://${HOST}/?embedded=1`,
    columns: size.columns,
    rows: size.rows,
    onFrame: (path, generation) => console.log(`FRAME ${path} ${generation}`),
    onExit: code => {
      if (viewer === mine) viewer = undefined
      viewerDown(`Chrome exited (${code})`)
    },
    log: line => console.error(line),
  })
  viewer = mine
  mine.catch(err => {
    if (viewer === mine) viewer = undefined
    viewerDown(err.message)
  })
}

const body = async req => {
  const raw = await text(req)
  return raw ? JSON.parse(raw) : {}
}

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const snapshot = () => ({ ...state, isConnected: tabs.size > 0 })
const publish = () => console.log(`STATE ${JSON.stringify(snapshot())}`)

const HOST = `127.0.0.1:${PORT}`
// The mod's per-session secret: the Host/Origin guard stops web pages, not other local programs.
// Set, it is required on the control endpoints (/cmd, /files, /input) that only the mod calls.
const TOKEN = process.env.ARCGIS_MAP_TOKEN
const CONTROL = new Set(['/cmd', '/files', '/input'])

const server = createServer(async (req, res) => {
  try {
    // Any web page can reach 127.0.0.1: refuse a foreign Host (DNS rebinding) or Origin (cross-site POST).
    if (req.headers.host !== HOST || (req.headers.origin && req.headers.origin !== `http://${HOST}`)) {
      return json(res, 403, { ok: false, error: `only http://${HOST}/ may call the bridge` })
    }
    if (TOKEN && req.method === 'POST' && CONTROL.has(req.url) && req.headers['x-arcgis-map-token'] !== TOKEN) {
      return json(res, 403, { ok: false, error: 'missing or wrong bridge token' })
    }
    if (req.method === 'GET' && req.url.split('?')[0] === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      tabs.add(res)
      req.on('close', () => {
        tabs.delete(res)
        publish()
      })
      return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/files/')) {
      // Parquet readers send HEAD for the size, then Range GETs for the footer and row groups.
      const path = files.get(req.url.split('/')[2])
      if (!path) return json(res, 404, { ok: false, error: 'not found' })
      const size = statSync(path).size
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
        if (start > end) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' })
        return createReadStream(path, { start, end }).pipe(res)
      }
      res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(path).pipe(res)
    }
    if (req.method === 'GET' && req.url === '/state') return json(res, 200, snapshot())
    if (req.method === 'POST' && req.url === '/state') {
      state = (await body(req)).state ?? state
      publish()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/ack') {
      const ack = await body(req)
      if (ack.state) state = ack.state
      pending.get(ack.id)?.(ack)
      publish()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/files') {
      const { path } = await body(req)
      try {
        if (typeof path !== 'string' || !statSync(path).isFile()) throw new Error('not a file')
      } catch (err) {
        return json(res, 400, { ok: false, error: `cannot read ${path}: ${err.message}` })
      }
      let key = fileKeys.get(path)
      if (!key) {
        key = randomUUID() // unguessable: a file URL is its only key
        files.set(key, path)
        fileKeys.set(path, key)
      }
      return json(res, 200, { ok: true, url: `/files/${key}/${encodeURIComponent(basename(path))}` })
    }
    if (req.method === 'POST' && req.url === '/input') {
      const { size, events } = await body(req)
      lastInput = Date.now()
      if (size) {
        if (!viewer) startPaneViewer(size)
        else (await viewer).resize(size.columns, size.rows)
      }
      if (Array.isArray(events) && events.length) {
        if (!viewer) return json(res, 409, { ok: false, error: 'viewer not started' })
        ;(await viewer).input(events)
      }
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/cmd') {
      const cmd = await body(req)
      if (typeof cmd.op !== 'string') return json(res, 400, { ok: false, error: 'op missing' })
      if (tabs.size === 0) {
        return json(res, 503, {
          ok: false,
          error: `No map tab is open. Open http://127.0.0.1:${PORT}/ (or run /map).`,
          state: snapshot(),
        })
      }
      const id = nextId++
      const ack = await new Promise(resolve => {
        const settle = value => pending.delete(id) && resolve(value)
        pending.set(id, settle)
        setTimeout(() => settle({ ok: false, error: `map tab did not answer in ${TIMEOUT_MS} ms; it may still finish, so call map_state before retrying` }), TIMEOUT_MS)
        const line = `data: ${JSON.stringify({ id, op: cmd.op, args: cmd.args ?? {} })}\n\n`
        for (const tab of tabs) tab.write(line)
      })
      return json(res, ack.ok ? 200 : 422, { ...ack, state: snapshot() })
    }
    json(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    json(res, 400, { ok: false, error: String(err?.message ?? err) })
  }
})

// A mod reload starts the new bridge before the old one has let go of the port: retry.
let tries = 0
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && tries++ < 20) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250)
  console.error(`bridge: ${err.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`bridge: http://127.0.0.1:${PORT}/`)
  publish()
})
// A closed pane stops posting: free Chrome's 1-2 GB. Reopening the pane posts its size and starts it again.
setInterval(
  async () => {
    if (!viewer || Date.now() - lastInput < IDLE_MS) return
    const idle = viewer
    viewer = undefined
    await (await idle.catch(() => undefined))?.close()
    console.log('VIEWER idle')
  },
  Math.min(IDLE_MS / 3, 10000),
).unref()
// Chrome must not outlive the bridge: the mod's unload sends SIGTERM.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await (await viewer?.catch(() => undefined))?.close()
    process.exit(0)
  })
}
// Keep SSE connections alive through proxies and idle timeouts.
setInterval(() => tabs.forEach(tab => tab.write(': ping\n\n')), 20000)
