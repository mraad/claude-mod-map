// Headless Chrome that renders the map page for the Claude Code pane.
// Raw CDP over --remote-debugging-pipe (no dependency); PNG screencast frames go to one file.
import { spawn } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// shortcut: assumes a 1:2 terminal cell and 10x20 px per cell; read the real cell size if pictures look stretched.
const CELL_W = 10
const CELL_H = 20
// Metal GPU: 2.6x faster first draw than SwiftShader in the 2026-11-09 benchmark. The rest are puppeteer's quiet defaults.
const FLAGS = [
  '--headless',
  '--remote-debugging-pipe',
  '--use-angle=metal',
  '--enable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--password-store=basic',
  '--use-mock-keychain',
]

const SPECIAL_KEYS = {
  up: ['ArrowUp', 38],
  down: ['ArrowDown', 40],
  left: ['ArrowLeft', 37],
  right: ['ArrowRight', 39],
  return: ['Enter', 13],
  tab: ['Tab', 9],
  backspace: ['Backspace', 8],
  delete: ['Delete', 46],
  pageup: ['PageUp', 33],
  pagedown: ['PageDown', 34],
  home: ['Home', 36],
  end: ['End', 35],
}

/** Pixel size of the page for a pane region of `columns` x `rows` cells. */
export const pixelSize = (columns, rows) => ({
  width: Math.max(1, Math.round(columns * CELL_W)),
  height: Math.max(1, Math.round(rows * CELL_H)),
})

/**
 * One pointer event from the pane (x, y as 0-1 fractions of the region) to CDP Input.dispatchMouseEvent
 * params, or null for events the map does not need. `last` remembers the previous press for double-clicks.
 */
export function toMouse(event, size, last = {}) {
  const x = Math.min(Math.max(event.x, 0), 1) * size.width
  const y = Math.min(Math.max(event.y, 0), 1) * size.height
  const button = event.button ?? last.button ?? 'left'
  const buttons = { left: 1, right: 2, middle: 4 }[button] ?? 1
  const modifiers = event.shift ? 8 : 0
  if (event.type === 'down') {
    const now = event.at ?? Date.now()
    const isDouble = last.downAt != null && now - last.downAt < 400 && Math.hypot(x - last.x, y - last.y) < 8
    last.downAt = isDouble ? undefined : now
    last.x = x
    last.y = y
    last.button = button
    last.clickCount = isDouble ? 2 : 1
    return { type: 'mousePressed', x, y, button, buttons, clickCount: last.clickCount, modifiers }
  }
  if (event.type === 'up')
    return { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: last.clickCount ?? 1, modifiers }
  if (event.type === 'move') return { type: 'mouseMoved', x, y, button, buttons, modifiers }
  return null
}

/** One key from the pane to the CDP Input.dispatchKeyEvent params for keyDown and keyUp. */
export function toKeys(event) {
  const special = SPECIAL_KEYS[event.key]
  const modifiers = (event.shift ? 8 : 0) | (event.ctrl ? 2 : 0) | (event.meta ? 4 : 0)
  if (special) {
    const [key, code] = special
    return [
      { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, modifiers },
      { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers },
    ]
  }
  if (event.key.length !== 1) return []
  return [
    { type: 'keyDown', key: event.key, text: event.key, modifiers },
    { type: 'keyUp', key: event.key, modifiers },
  ]
}

/**
 * Starts Chrome on `url` at the pixel size of `columns` x `rows` cells.
 * Calls onFrame(path, generation) after each new frame lands in its file, and onExit(code) if Chrome
 * exits on its own after it started (a crash), never for close().
 */
export async function startViewer({ url, columns, rows, onFrame, onExit = () => {}, log = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-map-view-'))
  const framePath = join(dir, 'frame.png')
  const proc = spawn(CHROME, [...FLAGS, `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', () => {}) // Chrome is chatty on stderr; drain it so it never blocks.
  const exited = new Promise(resolve => proc.on('exit', resolve))
  const toChrome = proc.stdio[3]
  const fromChrome = proc.stdio[4]
  let nextId = 0
  let buffer = ''
  const waits = new Map()
  const events = new Map()
  fromChrome.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (message.id) {
        waits.get(message.id)?.(message)
        waits.delete(message.id)
      } else events.get(message.method)?.(message.params)
    }
  })
  toChrome.on('error', () => {}) // a Chrome that died closes the pipe; `exited` reports it.
  // A Chrome that exits (missing, crashed) fails every call still waiting instead of hanging it.
  const gone = exited.then(code => {
    throw new Error(`Chrome exited (${code}); set CHROME to its path if it is not ${CHROME}`)
  })
  gone.catch(() => {})
  const send = (method, params = {}, sessionId) =>
    Promise.race([
      gone,
      new Promise((resolve, reject) => {
        const id = ++nextId
        waits.set(id, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
        toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
      }),
    ])

  let isClosing = false
  let isStarted = false
  proc.on('exit', code => {
    if (!isStarted || isClosing) return
    rmSync(dir, { recursive: true, force: true }) // a crash skips close(): clean up here
    onExit(code)
  })
  const close = async () => {
    isClosing = true
    proc.kill()
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    const viewer = await connect()
    isStarted = true
    return viewer
  } catch (err) {
    await close()
    throw err
  }

  async function connect() {
    const { targetInfos } = await send('Target.getTargets')
    const target = targetInfos.find(t => t.type === 'page')
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const page = (method, params) => send(method, params, sessionId)

    let size = pixelSize(columns, rows)
    let generation = 0
    const last = {}
    const setSize = () => page('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false })
    const startCast = () =>
      page('Page.startScreencast', { format: 'png', maxWidth: size.width, maxHeight: size.height })

    events.set('Page.screencastFrame', ({ data, sessionId: frameId }) => {
      page('Page.screencastFrameAck', { sessionId: frameId }).catch(() => {})
      // Write then rename, so the terminal never reads a half-written picture.
      writeFileSync(`${framePath}.tmp`, Buffer.from(data, 'base64'))
      renameSync(`${framePath}.tmp`, framePath)
      onFrame(framePath, ++generation)
    })

    await page('Page.enable')
    await setSize()
    // A screencast started while the navigation commits fails ("Not attached to an active page"): wait for load.
    const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve))
    await page('Page.navigate', { url })
    await Promise.race([loaded, gone])
    await startCast()
    log(`viewer: ${size.width}x${size.height} px`)

    // Input arrives faster than CDP answers: keep it in order on one chain.
    let queue = Promise.resolve()
    const enqueue = work => (queue = queue.then(work).catch(err => log(`viewer: ${err.message}`)))

    return {
      resize: (newColumns, newRows) =>
        enqueue(async () => {
          const next = pixelSize(newColumns, newRows)
          if (next.width === size.width && next.height === size.height) return
          size = next
          await page('Page.stopScreencast')
          await setSize()
          await startCast()
        }),
      input: list =>
        enqueue(async () => {
          for (const event of list) {
            if (event.kind === 'pointer') {
              const params = toMouse(event, size, last)
              if (params) await page('Input.dispatchMouseEvent', params)
            } else if (event.kind === 'key') {
              for (const params of toKeys(event)) await page('Input.dispatchKeyEvent', params)
            }
          }
        }),
      close,
    }
  }
}
