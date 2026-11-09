import type { ClientModule, JsonValue } from 'claude-code'

// Runs in the pane: an empty region under the map picture that catches the pointer and keys and posts them.
// A post replaces an undelivered one from the same frame, so every post carries the recent events with
// sequence numbers, plus the region size, and the mod forwards only what it has not seen.
type Event = { seq: number; kind: 'pointer' | 'key'; [field: string]: JsonValue }
// `log` is one object for the instance's life, shared by the handlers and every call.
type State = { id: string; columns: number; rows: number; log: { recent: Event[] } }

const KEEP = 32

const Viewer: ClientModule<null, State> = (_props, surface) => {
  const { Box } = surface.elements
  const state = surface.state
  if (!state) {
    const id = Math.random().toString(36).slice(2)
    let seq = 0
    const log = { recent: [] as Event[] }
    const push = (event: Omit<Event, 'seq'>) => {
      const last = log.recent.at(-1)
      // Moves between presses only matter as the latest position.
      if (event.type === 'move' && last?.type === 'move') log.recent.pop()
      log.recent = [...log.recent, { ...event, seq: ++seq } as Event].slice(-KEEP)
      surface.post({ id, events: log.recent, size: { columns: surface.columns, rows: surface.rows } })
    }
    surface.onPointer(e => {
      // Hovering does nothing on the map; only presses, drags and releases are sent.
      if (e.type === 'enter' || e.type === 'leave' || (e.type === 'move' && !e.button)) return
      const columns = Math.max(1, surface.columns)
      const rows = Math.max(1, surface.rows)
      push({
        kind: 'pointer',
        type: e.type,
        x: (e.fine?.x ?? e.x + 0.5) / columns,
        y: (e.fine?.y ?? e.y + 0.5) / rows,
        ...(e.button ? { button: e.button } : {}),
        ...(e.shift ? { shift: true } : {}),
        at: Date.now(),
      })
    })
    // While the pane shows this Client it says so; a closed pane stops, and the bridge frees Chrome.
    surface.every(30000, () => surface.post({ id, events: log.recent, size: { columns: surface.columns, rows: surface.rows } }))
    surface.onKey(e =>
      push({ kind: 'key', key: e.key, at: Date.now(), ...(e.shift ? { shift: true } : {}), ...(e.ctrl ? { ctrl: true } : {}), ...(e.meta ? { meta: true } : {}) }),
    )
    surface.setState({ id, columns: 0, rows: 0, log })
  } else if (surface.columns > 0 && (state.columns !== surface.columns || state.rows !== surface.rows)) {
    surface.post({ id: state.id, events: state.log.recent, size: { columns: surface.columns, rows: surface.rows } })
    surface.setState({ ...state, columns: surface.columns, rows: surface.rows })
  }

  return Box({ width: '100%', height: '100%' })
}

export default Viewer
