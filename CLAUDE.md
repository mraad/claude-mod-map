# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`arcgis-map/` is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) (a plugin with a hooks module; API: [reference](https://code.claude.com/docs/en/plugins/mods/reference)) that lets Claude drive a live ArcGIS Maps SDK for JavaScript 5.2 map: six tools (`add_graphic`, `add_layer`, `remove_layer`, `clear_graphics`, `go_to`, `map_state`), the `/map [pane|browser]` command, and a side pane that shows the map as streamed pictures and takes mouse and keys. Public repo `github.com/mraad/claude-mod-map` (marketplace file at `.claude-plugin/marketplace.json`). No package.json, no npm dependencies: Node stdlib, the mod API (`'claude-code'`), and the installed Google Chrome.

## Source of truth vs. loaded copy

- Edit `arcgis-map/` in this folder. The copy the engine hot-reloads lives at `~/.claude/dev-mods/<session-id>/arcgis-map/` (session id in `.resume`). After edits, sync it:
  `rsync -a --exclude .claude-plugin/types arcgis-map/ ~/.claude/dev-mods/$(cat .resume)/arcgis-map/`
  The mod reloads when the turn ends; a reload restarts the bridge, so the map page (browser window or pane) loses its graphics.
- Outside that session, from this folder: `claude --plugin-dir ./arcgis-map`.

## Commands

```sh
claude plugin validate arcgis-map          # manifest + hooks module as the engine reads it
claude plugin test arcgis-map              # hooks/*.test.tsx: tools, relay, pane, FRAME/VIEWER lines, /map
node --test arcgis-map/web/                # bridge + viewer; viewer.chrome.test.mjs needs Chrome and network (~16 s)
node --test --test-name-pattern="ranges" arcgis-map/web/  # one node test by name (case-sensitive regex)
```

- Type check: `arcgis-map/tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes only into the loaded copy. Copy it here once (the rsync above excludes it), then check this folder:
  `cp -R ~/.claude/dev-mods/$(cat .resume)/arcgis-map/.claude-plugin/types arcgis-map/.claude-plugin/ && npx -p typescript tsc -p arcgis-map`
- `docs/demo.mjs` (headless replay of a demo) needs `puppeteer-core`, which is not declared anywhere.

## Architecture (read across files)

```
Claude tool call ──> hooks/register.tsx ──$.http.fetch──> web/server.mjs (bridge, 127.0.0.1:8765)
                                                             │ SSE /events      ▲ POST /ack, /state
                                                             ▼                  │
                               every open map page: web/index.html (<arcgis-map>, SDK 5.2 CDN)
                                 ├─ /map browser: Chrome app window (own profile arcgis-map/.browser-profile)
                                 └─ /map pane: headless Chrome run by web/viewer.mjs (?embedded=1)
```

- **Bridge lifecycle:** `register.tsx` spawns `node web/server.mjs 8765` at `session.start`; it dies with the module. The mod reads the bridge's **stdout line protocol**: `STATE {...}` (map state, drives `$.state` atom `status`, the status line and pane header), `FRAME <png path> <generation>` (pane picture), `VIEWER down|idle|failed <why>`. Stderr goes to the debug log only.
- **Commands:** `/cmd {op, args}` is broadcast to every connected page; the first `/ack` wins and carries the page's state. `map_state` is answered by the bridge alone (`GET /state`). A local `path` arg is first registered via `POST /files`; the bridge serves only registered files (HEAD + Range, needed by `ParquetLayer`).
- **Pane (terminal only):** `viewer.mjs` drives Chrome over raw CDP on `--remote-debugging-pipe` (Metal GPU flags), screencasts PNGs to one file (write + rename), and maps pane input to `Input.dispatch*`. In the pane tree, `hooks/viewer-client.ts` (a `Client` surface module) sits under an absolutely positioned `Image`; it posts pointer/key events with sequence numbers (a later post in a frame replaces an earlier one), the region size, and a 30 s heartbeat. `register.tsx` (`ui.message` hook) forwards only unseen events to `POST /input`. The first frame sets the `frame` atom; later frames use `$.ui.blit`.
- **Viewer recovery:** size from the pane starts Chrome; a crash prints `VIEWER down` and the mod re-posts the last size (bridge gives up after 3 failures → `VIEWER failed`, shown in the pane); no heartbeat for `ARCGIS_MAP_IDLE_MS` (90 s) → Chrome closed (`VIEWER idle`).

## Rules that are easy to break

- Bridge accepts only `Host: 127.0.0.1:8765` and no foreign `Origin` (blocks DNS rebinding and cross-site POSTs). Open the map at `127.0.0.1`, never `localhost`.
- Control endpoints (`POST /cmd`, `/files`, `/input`) require header `x-arcgis-map-token` = `ARCGIS_MAP_TOKEN`, a random value the mod makes per load and passes to the bridge; unset (tests, manual runs) means no check. File URLs use random UUID keys. Keep both.
- `$.state` atoms carry a `shape` tag (`status-1`, `frame-2`): bump it when `types/index.d.ts` changes, or old stored values reach new code.
- One `tool.call` hook serves all six tools via the RegExp matcher `/^mcp__arcgis-map__/` (the engine's tool-name type lists only tools seen at load, so a string matcher fails `tsc`). Args are picked from the tool's `inputSchema.properties`: a new field must be in the schema to reach the page.
- The bridge reads `index.html` once at startup; page changes need a bridge restart (a mod reload does it).
- Zooming to a layer uses `queryExtent()` so `definitionExpression` filters are honoured (not `fullExtent`).
- There is no basemap tool; new layers always go on top (no reorder op).
- `shortcut:` comments mark accepted limits: fixed port 8765 (one map per machine), 1:2 terminal cell assumption, browser window on the right half of the focused screen.
- Test ports: server test 18765, Chrome test 18769. `CHROME` env overrides the Chrome path; macOS-only paths and flags otherwise.
