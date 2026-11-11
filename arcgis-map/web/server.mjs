// Bridge between the arcgis-map mod and the pages that show the map (browser window, pane, any tab).
// Mod: POST /cmd {op, args} -> waits for a page's answer. A local `path` (or inline GeoJSON `data`) is
// served here under a random URL; only such files are served, never an arbitrary path.
// Page: GET /events (SSE), POST /ack (a command's answer), POST /state (manual pan or layer change).
// Mod: POST /clear empties the map (every layer gone, default basemap, view kept), with or without a page open.
// Pane: POST /input {size} starts headless Chrome on this page (viewer.mjs); {events} are its mouse, keys, wheel.
// Stdout lines the mod reads: `STATE {...}` per map change, `FRAME <path> <generation>` per pane picture,
// `VIEWER down` (Chrome died: send the size again to restart), `VIEWER failed <why>` (gave up), `VIEWER idle`.
//
// Every page shows the same map: the bridge keeps a log of the commands that change it and replays the log
// to each page that connects (SSE ids `<epoch>:<n>`, so a reconnecting page gets only what it missed).
// With ARCGIS_MAP_SESSION set, the log and the view are saved there, so a mod reload or `--resume` gets the map back.
import { createServer } from 'node:http'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { text } from 'node:stream/consumers'

import { startViewer } from './viewer.mjs'

const PORT = Number(process.argv[2] ?? 8765)
// An open page keeps its code across bridge restarts: each connect sends this version, and a page with another one reloads.
const TEMPLATE = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const PAGE_VERSION = createHash('sha256').update(TEMPLATE).digest('hex').slice(0, 12)
const PAGE = TEMPLATE.replace('__PAGE_VERSION__', PAGE_VERSION)
// A large local file or a slow service can take a while to load; the rest is quick.
const TIMEOUT_MS = { add_layer: 60000, screenshot: 30000 }
// A duration from the environment; zero, negative or not a number keeps the default (Node runs a NaN timer in 1 ms).
const msFromEnv = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback)
const DEFAULT_TIMEOUT_MS = msFromEnv('ARCGIS_MAP_TIMEOUT_MS', 15000)
// Commands that do not change what the map holds: never logged, never replayed.
const READ_ONLY = new Set(['go_to', 'screenshot'])

// The mod passes its session id: the map of each session is saved in its own folder.
const SESSION = process.env.ARCGIS_MAP_SESSION?.replace(/[^\w-]/g, '')
const SESSIONS = join(homedir(), '.claude', 'arcgis-map', 'sessions')
const HOME = SESSION && join(SESSIONS, SESSION)
const KEEP_SESSION_MS = 30 * 24 * 3600 * 1000
const SAVE = HOME && join(HOME, 'map.json')
// Inline GeoJSON and screenshots are written here: the session folder, or a temp folder when nothing is saved.
const DATA = HOME ? join(HOME, 'data') : mkdtempSync(join(tmpdir(), 'arcgis-map-data-'))
mkdirSync(DATA, { recursive: true })
// Session maps not touched for 30 days go, with their data and screenshots. Called once the port is ours:
// only one bridge runs (port 8765), so no other session is live, and this one skips its own folder.
function removeOldSessions() {
  if (!HOME) return
  for (const name of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, name)
    try {
      if (dir !== HOME && Date.now() - statSync(dir).mtimeMs > KEEP_SESSION_MS) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

function load() {
  try {
    const saved = JSON.parse(readFileSync(SAVE, 'utf8'))
    if (typeof saved.epoch === 'string' && Array.isArray(saved.log)) return saved
  } catch {}
  return { epoch: randomUUID().slice(0, 8), log: [], view: {} }
}
// shortcut: the log only grows (a removed layer stays as add + remove); compact it if replays get slow.
const saved = SAVE ? load() : { epoch: randomUUID().slice(0, 8), log: [], view: {} }
// A new epoch on /clear: a page that reconnects with an id from the old log starts over.
let { epoch } = saved
let log = saved.log
let nextId = Math.max(0, ...log.map(entry => entry.id)) + 1

const save = () => {
  if (!SAVE) return
  writeFileSync(`${SAVE}.tmp`, JSON.stringify({ epoch, log, view: { center: state.center, zoom: state.zoom } }))
  renameSync(`${SAVE}.tmp`, SAVE)
}

const tabs = new Set()
const pending = new Map()
let state = { layers: [], ...saved.view }
// Local files the mod asked to show, by key and by path.
const files = new Map()
const fileKeys = new Map()
// The pane's headless Chrome: started by the first size the pane reports, stopped when the pane goes quiet
// (its Client posts a heartbeat every 30 s while mounted), restarted on request after a crash, 3 tries at most.
let viewer
let viewerFailures = 0
let lastInput = 0
const MAX_VIEWER_FAILURES = 3
const IDLE_MS = msFromEnv('ARCGIS_MAP_IDLE_MS', 90000)

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

/** The URL a page reads a registered local file from; throws if it is not a readable file. */
function serve(path) {
  if (typeof path !== 'string' || !statSync(path).isFile()) throw new Error(`${path} is not a file`)
  let key = fileKeys.get(path)
  if (!key) {
    key = randomUUID() // unguessable: a file URL is its only key
    files.set(key, path)
    fileKeys.set(path, key)
  }
  return `/files/${key}/${encodeURIComponent(basename(path))}`
}

// The log keeps local paths (file URLs change per bridge); a page gets URLs.
function toPage(entry, replay) {
  let { args } = entry
  if (typeof args.path === 'string') {
    const { path, ...rest } = args
    try {
      args = { ...rest, url: serve(path) }
    } catch (err) {
      args = { ...rest, missing: err.message } // the page reports it; a replay goes on without it
    }
  }
  return { id: entry.id, op: entry.op, args, layerId: `L${entry.id}`, ...(replay ? { replay: true } : {}) }
}

const sse = (res, message, withId = true) =>
  res.write(`${withId && message.id != null ? `id: ${epoch}:${message.id}\n` : ''}data: ${JSON.stringify(message)}\n\n`)

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
// Set, it is required on the control endpoints (/cmd, /input, /clear) that only the mod calls.
const TOKEN = process.env.ARCGIS_MAP_TOKEN
const CONTROL = new Set(['/cmd', '/input', '/clear'])

// Inline GeoJSON becomes a file in the data folder, so the log stays small and holds a path like any other.
function prepare(cmd, id) {
  const args = { ...(cmd.args ?? {}) }
  if (args.data !== undefined) {
    if (cmd.op !== 'add_layer' || args.type !== 'geojson') throw new Error('data is for add_layer with type "geojson" only')
    const path = join(DATA, `layer-${epoch}-${id}.geojson`)
    writeFileSync(path, typeof args.data === 'string' ? args.data : JSON.stringify(args.data))
    delete args.data
    args.path = path
  }
  if (args.path !== undefined) serve(args.path) // refuse a bad path now, not on the page
  return { id, op: cmd.op, args }
}

const server = createServer(async (req, res) => {
  try {
    // Any web page can reach 127.0.0.1: refuse a foreign Host (DNS rebinding) or Origin (cross-site POST).
    if (req.headers.host !== HOST || (req.headers.origin && req.headers.origin !== `http://${HOST}`)) {
      return json(res, 403, { ok: false, error: `only http://${HOST}/ may call the bridge` })
    }
    if (TOKEN && req.method === 'POST' && CONTROL.has(req.url) && req.headers['x-arcgis-map-token'] !== TOKEN) {
      return json(res, 403, {
        ok: false,
        error: `wrong bridge token: the map bridge on port ${PORT} belongs to another Claude Code session. Close that session's map, then reload this one.`,
      })
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
      res.write(`: connected\n\nevent: version\ndata: ${PAGE_VERSION}\n\n`)
      // A page that reconnects to this log gets only what it missed; any other page starts over.
      const [lastEpoch, lastN] = String(req.headers['last-event-id'] ?? '').split(':')
      const isKnown = lastEpoch === epoch && Number(lastN) < nextId
      if (!isKnown) sse(res, { op: 'reset' }, false)
      for (const entry of log) if (!isKnown || entry.id > Number(lastN)) sse(res, toPage(entry, true))
      if (!isKnown && state.center) sse(res, { op: 'go_to', args: { center: state.center, zoom: state.zoom }, replay: true }, false)
      tabs.add(res)
      publish()
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
      save()
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/ack') {
      const ack = await body(req)
      if (ack.state) state = ack.state
      pending.get(ack.id)?.(ack)
      publish()
      return json(res, 200, { ok: true })
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
    if (req.method === 'POST' && req.url === '/clear') {
      log = []
      epoch = randomUUID().slice(0, 8)
      state = { ...state, layers: [] }
      // Sent as a replay: the page posts its state once the reset has run.
      for (const tab of tabs) sse(tab, { op: 'reset', replay: true }, false)
      save()
      publish()
      return json(res, 200, { ok: true, state: snapshot() })
    }
    if (req.method === 'POST' && req.url === '/cmd') {
      const cmd = await body(req)
      if (typeof cmd.op !== 'string') return json(res, 400, { ok: false, error: 'op missing' })
      if (tabs.size === 0) {
        return json(res, 503, {
          ok: false,
          error: `No map page is open. Run /map (pane) or /map browser, or open http://${HOST}/.`,
          state: snapshot(),
        })
      }
      let entry
      try {
        entry = prepare(cmd, nextId++)
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message, state: snapshot() })
      }
      const isLogged = !READ_ONLY.has(cmd.op)
      // Logged before it is sent, so a page that connects meanwhile gets it in its replay.
      if (isLogged) log.push(entry)
      const expected = tabs.size
      const timeout = TIMEOUT_MS[cmd.op] ?? DEFAULT_TIMEOUT_MS
      // The first page that succeeds answers; an error answers only when every page failed.
      const ack = await new Promise(resolve => {
        let failures = 0
        let firstError
        const settle = value => {
          clearTimeout(timer)
          pending.delete(entry.id)
          resolve(value)
        }
        pending.set(entry.id, answer => {
          if (answer.ok) return settle(answer)
          firstError ??= answer
          if (++failures >= expected) settle(firstError)
        })
        const timer = setTimeout(
          () => settle(firstError ?? { ok: false, timedOut: true, error: `the map did not answer in ${timeout} ms; it may still finish, so call map_state before retrying` }),
          timeout,
        )
        const message = toPage(entry, false)
        for (const tab of tabs) sse(tab, message)
      })
      // A timed-out command may still finish on a page: keep it, so later pages replay the same map.
      if (isLogged && !ack.ok && !ack.timedOut) log = log.filter(e => e !== entry)
      if (isLogged) save()
      let { result } = ack
      if (ack.ok && cmd.op === 'screenshot' && typeof result?.dataUrl === 'string') {
        const path = join(DATA, `map-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
        writeFileSync(path, Buffer.from(result.dataUrl.split(',')[1] ?? '', 'base64'))
        result = { path, width: result.width, height: result.height }
      }
      return json(res, ack.ok ? 200 : 422, { ok: ack.ok, error: ack.error, result, state: snapshot() })
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
  // The mod shows this line in the status line and in tool errors.
  const why = err.code === 'EADDRINUSE' ? `port ${PORT} is held by another program (another Claude Code session's map?)` : err.message
  // Exit after the write: a pipe write is asynchronous on macOS.
  if (!HOME) rmSync(DATA, { recursive: true, force: true })
  process.stdout.write(`BRIDGE down ${why}\n`, () => process.exit(1))
})
server.listen(PORT, '127.0.0.1', () => {
  removeOldSessions()
  console.log(`bridge: http://${HOST}/`)
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
    if (!HOME) rmSync(DATA, { recursive: true, force: true }) // nothing saved: the temp folder goes too
    process.exit(0)
  })
}
// Keep SSE connections alive through proxies and idle timeouts.
setInterval(() => tabs.forEach(tab => tab.write(': ping\n\n')), 20000)
