# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`arcgis-map/` is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) (a plugin with a hooks module; API: [reference](https://code.claude.com/docs/en/plugins/mods/reference)) that lets Claude drive a live ArcGIS Maps SDK for JavaScript 5.2 map: nine tools (`add_graphic`, `add_layer`, `update_layer`, `remove_layer`, `clear_graphics`, `set_basemap`, `go_to`, `screenshot`, `map_state`), the `/map [pane|browser]` command, and a side pane that shows the map as streamed pictures and takes mouse and keys. Public repo `github.com/mraad/claude-mod-map` (marketplace file at `.claude-plugin/marketplace.json`). No package.json, no npm dependencies: Node stdlib, the mod API (`'claude-code'`), and the installed Google Chrome.

## Source of truth vs. loaded copy

- Edit `arcgis-map/` in this folder. The copy the engine hot-reloads lives at `~/.claude/dev-mods/<session-id>/arcgis-map/` (session id in `.resume`). After edits, sync it:
  `rsync -a --exclude .claude-plugin/types arcgis-map/ ~/.claude/dev-mods/$(cat .resume)/arcgis-map/`
  The mod reloads when the turn ends; a reload restarts the bridge, which replays the saved session map to the pages.
- Outside that session, from this folder: `claude --plugin-dir ./arcgis-map`.

## Commands

```sh
claude plugin validate arcgis-map          # manifest + hooks module as the engine reads it
claude plugin test arcgis-map              # hooks/*.test.tsx: tools, relay, pane, FRAME/VIEWER lines, /map
node --test arcgis-map/web/                # bridge + viewer; viewer.chrome.test.mjs needs Chrome and network (~25 s)
node --test --test-name-pattern="ranges" arcgis-map/web/  # one node test by name (case-sensitive regex)
```

- Type check: `arcgis-map/tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes only into the loaded copy. Copy it here once (the rsync above excludes it), then check this folder:
  `cp -R ~/.claude/dev-mods/$(cat .resume)/arcgis-map/.claude-plugin/types arcgis-map/.claude-plugin/ && npx -p typescript tsc -p arcgis-map`
- `docs/demo.mjs` replays a demo against a hand-started bridge (`node arcgis-map/web/server.mjs 8765`, no token) through `startViewer` and the `screenshot` op; no npm package.

## Architecture (read across files)

```
Claude tool call ──> hooks/register.tsx ──$.http.fetch──> web/server.mjs (bridge, 127.0.0.1:8765)
                                                             │ SSE /events      ▲ POST /ack, /state
                                                             ▼                  │
                               every open map page: web/index.html (<arcgis-map>, SDK 5.2 CDN)
                                 ├─ /map browser: Chrome app window (own profile arcgis-map/.browser-profile)
                                 └─ /map pane: headless Chrome run by web/viewer.mjs (?embedded=1)
```

- **Bridge lifecycle:** `register.tsx` spawns `node web/server.mjs 8765` at `session.start`; it dies with the module. The mod reads the bridge's **stdout line protocol**: `STATE {...}` (map state, drives `$.state` atom `status`, the status line and pane header), `FRAME <png path> <generation>` (pane picture), `VIEWER down|idle|failed <why>`, `BRIDGE down <why>` (no port: the status line says `map: off` and every tool is denied with the reason). Stderr goes to the debug log only.
- **Commands:** `/cmd {op, args}` is broadcast to every connected page; the first ok `/ack` answers (an error only when every page failed) and carries the page's state. `map_state` is answered by the bridge alone (`GET /state`). A local `path` arg (or inline GeoJSON `data`, which the bridge writes to a file) is served under a random URL; the bridge serves only those files (HEAD + Range, needed by `ParquetLayer`).
- **One map for every page:** the bridge logs each command that changes the map (not `go_to`, `screenshot`, or a command that failed everywhere) and replays the log to each page that connects: `reset` first, then the log, then the saved view. SSE ids are `<epoch>:<n>`, so a reconnecting page (`Last-Event-ID`) gets only what it missed. The bridge names new layers (`L<n>`), so ids match on every page. The page runs commands one at a time. With `ARCGIS_MAP_SESSION` (the mod passes the session id) the log, view and data files live in `~/.claude/arcgis-map/sessions/<id>/`: a reload or `--resume` gets the map back. Folders untouched for 30 days are deleted at bridge start. A replayed command gets no `/ack`; the page posts one `/state` when its queue drains and none while commands run.
- **Pane (terminal only):** `viewer.mjs` drives Chrome over raw CDP on `--remote-debugging-pipe` (Metal GPU flags), screencasts PNGs to one file (write + rename), and maps pane input to `Input.dispatch*`. In the pane tree, `hooks/viewer-client.ts` (a `Client` surface module) sits under an absolutely positioned `Image`; it posts pointer/key events with sequence numbers (a later post in a frame replaces an earlier one), the region size, and a 30 s heartbeat. `register.tsx` (`ui.message` hook) forwards only unseen events to `POST /input`. The first frame sets the `frame` atom; later frames use `$.ui.blit`.
- **Viewer recovery:** size from the pane starts Chrome; a crash prints `VIEWER down` and the mod re-posts the last size (bridge gives up after 3 failures → `VIEWER failed`, shown in the pane); no heartbeat for `ARCGIS_MAP_IDLE_MS` (90 s) → Chrome closed (`VIEWER idle`).

## Rules that are easy to break

- Bridge accepts only `Host: 127.0.0.1:8765` and no foreign `Origin` (blocks DNS rebinding and cross-site POSTs). Open the map at `127.0.0.1`, never `localhost`.
- Control endpoints (`POST /cmd`, `/input`) require header `x-arcgis-map-token` = `ARCGIS_MAP_TOKEN`, a random value the mod makes per load and passes to the bridge; unset (tests, manual runs) means no check. File URLs use random UUID keys. Keep both.
- `$.state` atoms carry a `shape` tag (`status-2`, `frame-2`): bump it when `types/index.d.ts` changes, or old stored values reach new code.
- One `tool.call` hook serves all nine tools via the RegExp matcher `/^mcp__arcgis-map__/` (the engine's tool-name type lists only tools seen at load, so a string matcher fails `tsc`). Args are picked from the tool's `inputSchema.properties`: a new field must be in the schema to reach the page.
- The bridge reads `index.html` once at startup; page changes need a bridge restart (a mod reload does it).
- Zooming to a layer uses `queryExtent()` so `definitionExpression` filters are honoured (not `fullExtent`). A GeoParquet file the SDK cannot decode (seen with GDAL 3.13 output: it loads, draws nothing, every query throws) is refused by `add_layer`; duckdb output works. `examples/cities.parquet` is written by duckdb.
- New layers always go on top (no reorder op). `set_basemap` builds keyless basemaps (`KEYLESS` in `index.html`: Esri raster tiles) and refuses `arcgis/...` styles without `?apiKey=` (they load slowly with no tiles and leave the view at zoom -1); it answers only once `view.zoom >= 0` again. The log only grows (`shortcut:` in `server.mjs`).
- `add_layer` and `update_layer` share `setProperties` in `index.html`: a property the layer lacks is an error, never skipped.
- `shortcut:` comments mark accepted limits: fixed port 8765 (one map per machine), 1:2 terminal cell assumption, browser window on the right half of the focused screen.
- `ARCGIS_MAP_TIMEOUT_MS` overrides the 15 s default command timeout (the server test uses 1000).
- Test ports: server test 18765 and 18766 (saved session), Chrome test 18769. `CHROME` env overrides the Chrome path; macOS-only paths and flags otherwise.
