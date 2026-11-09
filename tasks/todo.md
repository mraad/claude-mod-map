# Embedded map pane, version 2 (mouse)

Goal: the ArcGIS map shows inside the Claude Code pane (right side) and takes mouse and keys.

Design (from the 2026-11-09 benchmark: Chrome + Metal GPU + raw CDP + screencast):
- Bridge starts headless Chrome on its own page (raw CDP over `--remote-debugging-pipe`, no dependency) when the pane first reports its size.
- Chrome screencasts PNG frames; bridge writes each to one file (atomic rename) and prints `FRAME <path> <gen>`.
- Pane: a `Client` (empty, takes pointer + keys) with the `Image` absolutely on top of it; mod swaps frames with `$.ui.blit`.
- Client posts pointer/key events (with sequence numbers, so a replaced post loses nothing) -> mod `ui.message` -> bridge `POST /input` -> CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`.
- No wheel in the pointer API: zoom by double-click, the map's +/- buttons, or `+`/`-` keys after a click.

Steps:
- [x] `web/viewer.mjs`: launch Chrome, screencast to file, resize, input mapping (pure helpers exported)
- [x] `web/server.mjs`: `POST /input` (size starts the viewer; events go to it), FRAME lines, stop Chrome on exit
- [x] `web/index.html`: `?embedded=1` hides badge and layer list
- [x] `hooks/viewer-client.ts`: surface module (pointer, keys, size, sequence numbers)
- [x] `hooks/register.tsx`: pane with Client + Image, `ui.message` relay, FRAME -> atom / blit, `/map` stops opening a browser
- [x] `types/index.d.ts`: frame state
- [x] Tests: viewer helpers + `/input` (node:test), mod relay/frame/pane (claude plugin test)
- [x] Live check: headless run, drag pans the map, frames land in the file
- [ ] Load into the session; person checks the pane by hand
