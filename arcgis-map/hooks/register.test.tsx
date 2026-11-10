import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'arcgis-map',
  component: 'Pane',
  requestId: 'arcgis-map',
  props: {
    title: 'ArcGIS map',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const STATE = {
  isConnected: true,
  layers: [{ id: 'g1', title: 'Graphics', type: 'graphics', count: 1 }],
  center: [47.98, 29.37],
  zoom: 10,
}

// A request body is text, or { base64 } bytes in the engine's types; the mod only sends text.
const bodyText = (body: string | { readonly base64: string } | undefined) => (typeof body === 'string' ? body : '{}')

const reply = (value: unknown, status = 200) => ({
  value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) },
})

test('add_graphic sends only its own arguments to the bridge and answers the map state', async ($, on) => {
  const posted: { url: string; body?: string }[] = []
  on('http.fetch', (_, e) => {
    posted.push({ url: e.url, body: bodyText(e.init?.body) })
    return reply({ ok: true, result: { layerId: 'g1', graphics: 1 }, state: STATE })
  })
  on('tool.call', () => ({ result: {} }))

  const geometry = { type: 'Point', coordinates: [47.98, 29.37] }
  const ran = await $.tool.call({ tool: 'mcp__arcgis-map__add_graphic', geometry })

  expect(posted[0]?.url).toBe('http://127.0.0.1:8765/cmd')
  expect(JSON.parse(posted[0]?.body ?? '{}')).toEqual({ op: 'add_graphic', args: { geometry } })
  expect(JSON.parse(String(ran.result))).toEqual({ result: { layerId: 'g1', graphics: 1 }, map: STATE })
})

test('add_layer passes a local path and inline data to the bridge, which serves them', async ($, on) => {
  const posted: { url: string; body?: string }[] = []
  on('http.fetch', (_, e) => {
    posted.push({ url: e.url, body: bodyText(e.init?.body) })
    return reply({ ok: true, result: { layerId: 'L1' }, state: STATE })
  })
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: 'mcp__arcgis-map__add_layer', type: 'parquet', path: '/data/sites.parquet' })
  const data = { type: 'FeatureCollection', features: [] }
  await $.tool.call({ tool: 'mcp__arcgis-map__add_layer', type: 'geojson', data, labelingInfo: [{ labelExpressionInfo: { expression: '$feature.name' } }] })

  expect(posted.map(p => p.url)).toEqual(['http://127.0.0.1:8765/cmd', 'http://127.0.0.1:8765/cmd'])
  expect(JSON.parse(posted[0]?.body ?? '{}')).toEqual({ op: 'add_layer', args: { type: 'parquet', path: '/data/sites.parquet' } })
  expect(JSON.parse(posted[1]?.body ?? '{}').args).toEqual({ type: 'geojson', data, labelingInfo: [{ labelExpressionInfo: { expression: '$feature.name' } }] })
})

test('map_state reads the bridge, not the tab', async ($, on) => {
  const urls: string[] = []
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    return reply(STATE)
  })
  on('tool.call', () => ({ result: {} }))

  const ran = await $.tool.call({ tool: 'mcp__arcgis-map__map_state' })

  expect(urls).toEqual(['http://127.0.0.1:8765/state'])
  expect(JSON.parse(String(ran.result)).map).toEqual(STATE)
})

test('map_state with the bridge down is a deny, not a state', async ($, on) => {
  on('http.fetch', () => ({ deny: 'connection refused' }))
  on('tool.call', () => ({ result: {} }))

  const ran = await $.tool.call({ tool: 'mcp__arcgis-map__map_state' })

  expect(ran.deny).toContain('arcgis-map: bridge unreachable')
})

test('a map error reaches the model as a deny', async ($, on) => {
  on('http.fetch', () => reply({ ok: false, error: 'No map tab is open.' }, 503))
  on('tool.call', () => ({ result: {} }))

  const ran = await $.tool.call({ tool: 'mcp__arcgis-map__go_to', zoom: 3 })

  expect(ran.deny).toBe('arcgis-map: No map tab is open.')
})

test('the pane follows the STATE lines the bridge prints, past stderr and a bad line', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__arcgis-map__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'map' } }))
  on('process.spawn', async function* () {
    // Split mid-line on purpose: the mod must buffer to the newline.
    // stderr in the middle and a bad STATE line must neither corrupt nor end the reader.
    const line = `bridge: up\nSTATE {broken\nSTATE ${JSON.stringify(STATE)}\n`
    yield { stream: 'stdout' as const, text: line.slice(0, 40) }
    yield { stream: 'stderr' as const, text: '(node) warning\n' }
    yield { stream: 'stdout' as const, text: line.slice(40) }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 layers · zoom 10/ }))?.text).toContain('1 layers')
    expect((await ui.find({ type: 'Text', text: /^Graphics \(1\)$/ }))?.text).toBe('Graphics (1)')
    await ui.unmount()
  }
})

test('the bridge gets the session id; when it cannot start, the status line and every tool say why', async ($, on) => {
  const spawned: Record<string, string>[] = []
  const statuses: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abc-123' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__arcgis-map__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'map' } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('process.spawn', async function* (_, e) {
    spawned.push({ ...e.env })
    yield { stream: 'stdout' as const, text: "BRIDGE down port 8765 is held by another program (another Claude Code session's map?)\n" }
    return { value: { code: 1, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let ran = await $.tool.call({ tool: 'mcp__arcgis-map__map_state' })
  for (let i = 0; i < 100 && !ran.deny?.includes('not running'); i++) ran = await $.tool.call({ tool: 'mcp__arcgis-map__map_state' })

  expect(spawned[0]).toMatchObject({ ARCGIS_MAP_SESSION: 'abc-123' })
  expect(ran.deny).toBe("arcgis-map: the map bridge is not running: port 8765 is held by another program (another Claude Code session's map?)")
  expect(statuses.at(-1)).toBe('map: off')
})

// The bridge's output for the frame tests: one STATE, then two pictures in the same file.
const bridgeWithFrames = async function* () {
  yield { stream: 'stdout' as const, text: `STATE ${JSON.stringify(STATE)}\nFRAME /tmp/v/frame.png 1\n` }
  yield { stream: 'stdout' as const, text: 'FRAME /tmp/v/frame.png 2\n' }
  return { value: { code: 0, signal: null } }
}

test('the first FRAME draws the Image in the pane; the next one only swaps its picture', async ($, on) => {
  const blits: unknown[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__arcgis-map__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'map' } }))
  on('ui.blit', (_, e) => {
    blits.push(e)
    return { value: {} }
  })
  on('process.spawn', bridgeWithFrames)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const image = await ui.find({ type: 'Image', key: 'map' })
  expect(image?.props).toMatchObject({ source: { file: '/tmp/v/frame.png', format: 'png', generation: 1 }, columns: 40, rows: 18 })
  expect(blits).toEqual([
    expect.objectContaining({ requestId: 'arcgis-map', key: 'map', source: { file: '/tmp/v/frame.png', format: 'png', generation: 2 } }),
  ])
  await ui.unmount()
})

test('a click, a drag and a key in the pane reach the bridge once each, after its size', async ($, on) => {
  const bodies: { size?: unknown; events?: { seq: number; kind: string; type?: string; key?: string; x?: number }[] }[] = []
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/input')) bodies.push(JSON.parse(bodyText(e.init?.body)))
    return reply({ ok: true })
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 40, rows: 18, in: 'map' })
  await ui.pointer({ type: 'down', x: 19, y: 9, button: 'left', in: 'map' })
  await ui.pointer({ type: 'move', x: 25, y: 9, button: 'left', in: 'map' })
  await ui.pointer({ type: 'up', x: 25, y: 9, button: 'left', in: 'map' })
  await ui.pointer({ type: 'move', x: 30, y: 2, in: 'map' }) // a hover with no button is not sent
  await ui.key({ key: '+', in: 'map' })

  expect(bodies[0]?.size).toEqual({ columns: 40, rows: 18 })
  const events = bodies.flatMap(b => b.events ?? [])
  expect(events.map(e => e.seq)).toEqual([...new Set(events.map(e => e.seq))])
  expect(events.map(e => e.type ?? e.key)).toEqual(['down', 'move', 'up', '+'])
  expect(events[0]?.x).toBe(19.5 / 40)
  expect(bodies.filter(b => b.size).length).toBe(1)
  await ui.unmount()
})

test('a Chrome crash (VIEWER down) restarts it with the pane size; VIEWER failed shows why in the pane', async ($, on) => {
  const inputs: unknown[] = []
  let crash = () => {}
  const crashed = new Promise<void>(resolve => (crash = resolve))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__arcgis-map__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'map' } }))
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/input')) inputs.push(JSON.parse(bodyText(e.init?.body)))
    return reply({ ok: true })
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'FRAME /tmp/v/frame.png 1\n' }
    await crashed
    yield { stream: 'stdout' as const, text: 'VIEWER down\n' }
    yield { stream: 'stdout' as const, text: 'VIEWER failed Chrome exited (1)\n' }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 40, rows: 18, in: 'map' })
  inputs.length = 0
  crash()
  // The bridge reader runs on its own; each find is a round trip that lets it advance.
  for (let i = 0; i < 100 && !(await ui.find({ type: 'Text', text: /could not start/ })); i++);

  expect(inputs).toEqual([{ size: { columns: 40, rows: 18 } }])
  expect((await ui.find({ type: 'Text', text: /could not start/ }))?.text).toBe('The map could not start: Chrome exited (1)')
  expect(await ui.find({ type: 'Image', key: 'map' })).toBeUndefined()
  await ui.unmount()
})

test('after a reload forgets the pane, its old events are not replayed; the post still says the pane is open', async ($, on) => {
  const inputs: { size?: unknown; events?: unknown[] }[] = []
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/input')) inputs.push(JSON.parse(bodyText(e.init?.body)))
    return reply({ ok: true })
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const old = Date.now() - 60000
  await ui.post(
    {
      id: 'from-before-the-reload',
      events: [
        { seq: 7, kind: 'pointer', type: 'down', x: 0.5, y: 0.5, button: 'left', at: old },
        { seq: 8, kind: 'pointer', type: 'up', x: 0.2, y: 0.5, button: 'left', at: old },
      ],
      size: { columns: 40, rows: 18 },
    },
    { in: 'map' },
  )

  expect(inputs.at(-1)).toEqual({ size: { columns: 40, rows: 18 } })
  await ui.unmount()
})

test('the pane Client sends a heartbeat every 30 s, so the bridge keeps Chrome while the pane is open', async ($, on) => {
  let calls = 0
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/input')) calls++
    return reply({ ok: true })
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 40, rows: 18, in: 'map' })
  const before = calls
  await ui.advance(30000)
  expect(calls).toBe(before + 1)
  await ui.unmount()
})

test('the wheel over the pane zooms the map instead of scrolling the pane', async ($, on) => {
  const inputs: unknown[] = []
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/input')) inputs.push(JSON.parse(bodyText(e.init?.body)))
    return reply({ ok: true })
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 40, rows: 18, in: 'map' })
  // A wheel tick up over the map region's cell (9, 11): body row 11 is region row 9, under the 2 header rows.
  const wheel = { component: 'Pane', requestId: 'arcgis-map', offset: 0, by: -1, bodyRows: 20, contentRows: 20, origin: { kind: 'person' }, pointer: { column: 9, row: 11 } }
  const result = await $.ui.scroll(wheel as never)
  expect(result).toEqual({})
  expect(inputs.at(-1)).toEqual({ events: [{ kind: 'wheel', by: -1, x: 9.5 / 40, y: 9.5 / 18 }] })
  await ui.unmount()
})

// `/map …` typed at the prompt of a fullscreen terminal.
const TYPED = { command: 'map', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

test('/map browser opens a Chrome app window on the right half of the focused screen; /map opens the pane', async ($, on) => {
  const runs: string[][] = []
  const opened: string[] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: e.argv[0] === 'osascript' ? '0,33,1728,1084\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  const browser = await $.command.run({ ...TYPED, args: 'browser' })
  expect(browser.text).toBe('Map opened in a browser window at http://127.0.0.1:8765/')
  expect(runs[1]).toEqual(['open', '-na', 'Google Chrome', '--args', '--app=http://127.0.0.1:8765/',
    expect.stringMatching(/^--user-data-dir=.+\/\.browser-profile$/), '--window-position=864,33', '--window-size=864,1084'])
  expect(opened).toEqual([])

  await $.command.run({ ...TYPED, args: '' })
  expect(opened).toEqual(['arcgis-map'])
  expect((await $.command.run({ ...TYPED, args: 'globe' })).text).toBe('Usage: /map [pane|browser]')
})

test('/map browser without Chrome says so and names the URL', async ($, on) => {
  on('process.run', (_, e) =>
    ({ value: { exitCode: e.argv[0] === 'open' ? 1 : 0, stdout: '', stderr: e.argv[0] === 'open' ? 'Unable to find application named Google Chrome\n' : '', isStdoutTruncated: false, isStderrTruncated: false } }))

  const ran = await $.command.run({ ...TYPED, args: 'browser' })

  expect(ran.text).toBe('Chrome did not open: Unable to find application named Google Chrome. Open http://127.0.0.1:8765/ in any browser.')
})
