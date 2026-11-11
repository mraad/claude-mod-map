# claude-mod-map

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) (`arcgis-map/`) that lets Claude drive a live ArcGIS Maps SDK for JavaScript 5.2 map: add graphics, add layers (feature, GeoJSON, CSV, GeoParquet, tile, vector tile, imagery, map image, portal item, or inline GeoJSON results), change their symbology, filter and labels, change the basemap, zoom, take screenshots, and read map state.

Full documentation: [`docs/index.html`](docs/index.html) (one self-contained HTML file, images inline; download it and open it in a browser).

![browser window: dark basemap, labeled cities, great-circle route](docs/img/browser-world.jpg)

## Install

Needs Claude Code v2.1.287 or later (mods), macOS, Node.js and Google Chrome. A mod runs with your permissions inside Claude Code: read the code before you install it. At the prompt of a Claude Code terminal session:

```
/plugin install arcgis-map --marketplace mraad/claude-mod-map
```

Type `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install arcgis-map --marketplace mraad/claude-mod-map
```

## How it works

```
Claude --tool call--> mod (hooks/register.tsx) --POST /cmd--> bridge (web/server.mjs, 127.0.0.1:8765)
                                                                 | SSE /events      ^ POST /ack (result + map state)
                                                                 v                  |
                                                              map pages: web/index.html (<arcgis-map>, SDK 5.2)
```

- The mod spawns the bridge at session start (`node web/server.mjs 8765`); it stops when the mod unloads.
- Tools: `mcp__arcgis-map__add_graphic`, `add_layer`, `update_layer`, `remove_layer`, `clear_graphics`, `set_basemap`, `go_to`, `screenshot`, `map_state`.
- `add_layer` takes `path` (absolute local `.parquet` / `.geojson` / `.csv`) or `data` (inline GeoJSON, for analysis results): the bridge serves only files passed this way, with HEAD and Range support for Parquet. Features get an attribute popup; the map has a legend (bottom left).
- `update_layer` changes `renderer`, `definitionExpression`, `labelingInfo`, `opacity`, `visible` or `title` of a layer in place. A property the layer type does not have is an error.
- `screenshot` saves a PNG of the map and answers its path: Claude can read it to check its work. Give `width` and `height` for the same size from the pane and the browser.
- Every map page shows the same map: the bridge replays its log of map changes to each page that opens or reconnects, and layer ids match on all pages. The log is saved per Claude Code session in `~/.claude/arcgis-map/sessions/<session id>/` (with inline data and screenshots), so a mod reload or `claude --resume` shows the map again. Session folders not used for 30 days are deleted when the bridge starts.
- An open map page reloads itself when a restarted bridge serves a changed `index.html`: the bridge stamps the page with a hash and sends it as `event: version` on each connect. A page opened before this check needs one manual reload.
- One map per machine (port 8765). A second session's bridge cannot start: its status line shows `map: off` and its tools say why.
- `/map` opens the map **inside the Claude Code pane** (right side; Ghostty, kitty or iTerm2 under fullscreen). The bridge renders the page in headless Chrome (Metal GPU, raw CDP over a pipe, no dependency; `web/viewer.mjs`) and streams PNG frames into the pane's `Image`. Drag to pan; the wheel, a double-click or the map's +/- buttons zoom; click once, then arrows and `+`/`-` work. Set `CHROME` if Chrome is not at `/Applications/Google Chrome.app`. Chrome stops about 90 s after the pane closes and restarts when it reopens; after a crash it restarts by itself (3 tries), then the pane says why.
- `/map browser` opens the same map as a Chrome app window on the right half of the screen Ghostty is on (its own Chrome profile in the mod's `.browser-profile/`). Full browser map: wheel zoom, sharp picture, layer list. Pane and browser can be open together; every tool updates both.
- `/map clear` empties the map at once, with no model turn: every layer and graphic goes, the basemap returns to OpenStreetMap, the view stays. The mod calls the bridge (`POST /clear`) directly; every open page resets, and the saved session map and its inline GeoJSON files are deleted too.
- `/map stop` stops the map bridge and its Chrome, closes the pane and the `/map browser` window. The map tools answer that the map is stopped; `/map` or `/map browser` starts it again with the same map.
- Any browser works too: `http://127.0.0.1:8765/`.
- The bridge only answers requests whose Host is `127.0.0.1:8765` and that carry no foreign Origin, so other web pages (and DNS rebinding) cannot reach it. Open the map at `127.0.0.1`, not `localhost`.
- Control endpoints (`/cmd`, `/input`) also need a per-load random token that only the mod knows (`ARCGIS_MAP_TOKEN`), and registered file URLs carry random keys, so other local programs cannot drive the map or read files through it. Single-user machine assumed.
- Basemap is OSM. `set_basemap` also takes `dark-gray` (dark mode), `light-gray`, `imagery`, `topo` and `streets` with no key (Esri raster tiles from `services.arcgisonline.com`). Esri basemap styles (`arcgis/...`) need `?apiKey=...` in the page URL; without it `set_basemap` refuses them.

## Run from this folder (development)

```sh
git clone https://github.com/mraad/claude-mod-map.git && cd claude-mod-map
claude --plugin-dir ./arcgis-map
```

Then `/map` (pane) or `/map browser` (browser window), and ask e.g. "put a blue point on Kuwait City" or "add /path/to/sites.parquet as a layer".

## Check

```sh
claude plugin validate arcgis-map
claude plugin test arcgis-map      # mod: tools, pane, bridge lines, /map
node --test arcgis-map/web/        # bridge, viewer input mapping, real-Chrome viewer test (needs Chrome + network)
```

`docs/demo.mjs` replays the demo in headless Chrome against a bridge you start by hand (`node arcgis-map/web/server.mjs 8765`); no npm package needed.

## Example

`examples/cities-route.geojson`: one FeatureCollection with seven city Points (Sydney, Dubai, Beirut, Florence, Paris, New York, San Francisco) and one geodesic LineString through them in that order, densified along great circles (32 points per leg, 27,397 km). It is the data behind the screenshot above.

`examples/cities.parquet`: the seven cities as GeoParquet (WKB, Snappy), written with duckdb:

```sh
duckdb -c "LOAD spatial; COPY (SELECT name, \"order\", geom AS geometry FROM ST_Read('examples/cities-route.geojson') WHERE kind='city' ORDER BY \"order\") TO 'examples/cities.parquet' (FORMAT parquet, COMPRESSION snappy)"
```

Try `add_layer {"type": "parquet", "path": "<repo>/examples/cities.parquet"}`. `examples/cities-gdal.parquet` holds the same cities written by GDAL 3.13 (`ogr2ogr -f Parquet`) with no `crs`; the map applies the GeoParquet default (OGC:CRS84). A file with its own `crs` keeps it (`examples/cities-3857.parquet`).

## License

MIT, see [`LICENSE`](LICENSE). The map page loads the ArcGIS Maps SDK for JavaScript from Esri's CDN at runtime; the SDK, basemaps and services are under Esri's own terms.

## References

- [Claude Code mods: overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Claude Code mods: create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Claude Code mods: reference](https://code.claude.com/docs/en/plugins/mods/reference) (events, API, limits)
- [ArcGIS Maps SDK for JavaScript](https://developers.arcgis.com/javascript/latest/)
- [RFC 7946: GeoJSON](https://www.rfc-editor.org/rfc/rfc7946)
