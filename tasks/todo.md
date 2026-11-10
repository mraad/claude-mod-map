# 0.1.2: one map for all views, analyst tools

Branch `fix/analyst-mapping`. From the 2026-11-10 review.

Bugs:
- [x] Bridge keeps a log of map changes; a new or reconnected page replays it (SSE `id:` + `Last-Event-ID`, epoch for a new log)
- [x] Bridge assigns layer ids, so ids match in pane and browser
- [x] Page runs commands one at a time, in order
- [x] The answer is the first ok page, or the first error when all pages failed
- [x] Log + view saved per session (`ARCGIS_MAP_HOME`): mod reload and `--resume` restore the map; local paths stored, not file URLs
- [x] Bridge that cannot get port 8765: status line and tools say so; token error names another session
- [x] `renderer` / `definitionExpression` on a layer without them: error, not silence
- [x] `add_layer` timeout 60 s

Features:
- [x] `add_layer` `data`: inline GeoJSON (bridge writes it to a file)
- [x] `screenshot` tool: PNG file path
- [x] `update_layer` tool: title, renderer, definitionExpression, opacity, visible, labelingInfo
- [x] Legend; default popups for layers without a template
- [x] Wheel zoom in the pane (`ui.scroll` -> CDP `mouseWheel`)
- [x] `csv` and `map-image` layer types
- [x] `set_basemap` tool

Simplify / optimize:
- [x] Layer classes imported on first use
- [x] File registration moves into the bridge (`POST /files` goes)
- [x] Pane at deviceScaleFactor 2: measured, no gain (headless screencast stays 800x600), kept at 1

Finish:
- [x] Version 0.1.1; README, CLAUDE.md, docs/index.html
- [x] Tests: node, plugin test, tsc, validate; live check in Chrome
