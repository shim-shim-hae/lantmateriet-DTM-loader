# Lantmäteriet DTM Loader — codebase notes

Single-file Node.js CLI tool. All logic lives in `src/dtm-downloader.js`. No build step; run directly with `node`.

## Dependencies

| Package | Purpose |
|---------|---------|
| `axios` | HTTP requests (STAC API + tile downloads) |
| `dotenv` | Load `LM_USERNAME` / `LM_PASSWORD` from `.env` |
| `@turf/turf` | Geodesic distance for 10×10 km grid subdivision |

## Credentials

Downloaded from `dl1.lantmateriet.se` using HTTP Basic Auth. Credentials come from `LM_USERNAME` and `LM_PASSWORD` env vars (loaded from `.env` via dotenv). The STAC search API is public and needs no auth.

## Input modes

### Bbox mode
`node src/dtm-downloader.js min_lon,min_lat,max_lon,max_lat`  
Parses four comma-separated WGS84 values, queries the STAC API once.

### GeoJSON mode
`node src/dtm-downloader.js --geojson path/to/polygon.geojson`  
Accepts `FeatureCollection`, `Feature`, or bare `Polygon` geometry (handles ArcGIS Pro exports which wrap in a FeatureCollection). If a FeatureCollection has multiple features, the first is used with a warning.

## Grid subdivision (GeoJSON mode)

`subdividePolygonBbox` tiles the polygon's bounding box into 10×10 km cells. Cell size is computed geodesically via `turf.destination` (not a fixed degree offset) so the metric size is correct at any latitude. Cells are queried sequentially with a 1-second delay between requests to avoid rate limiting.

## STAC API

- Search endpoint: `https://api.lantmateriet.se/stac-hojd/v1/search`
- POST with `{ bbox }` body; pagination follows STAC `next` links
- A `next` link with `method: GET` is followed as a GET request; all others as POST
- HTTP 429 responses are retried up to 3 times, honouring `Retry-After` if present

## Asset filtering

Only assets whose `href` matches `/\/data\/grid1m\//` are kept. This excludes lower-resolution `grid/` assets and `pointcloud/` assets.

## Download behaviour

- `DOWNLOAD_CONCURRENCY = 4` — worker-pool pattern, not `Promise.all`
- `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED` are retried up to 3 times with a 3-second delay
- Other errors (HTTP 4xx/5xx) fail immediately
- `stdout` receives only JSON; all progress and errors go to `stderr`

## Output files (written to the user-chosen download directory)

| File | Contents |
|------|---------|
| `dtm-tile-urls.json` | Full deduplicated list of tile URLs found |
| `dtm-download-manifest.json` | Successfully downloaded paths + any per-tile errors |

## Key constants (top of file)

```
GRID_CELL_SIZE_KM          10
QUERY_DELAY_MS             1000   between grid-cell STAC requests
QUERY_RETRY_LIMIT          3      STAC HTTP 429 retries
DOWNLOAD_CONCURRENCY       4      parallel tile downloads
DOWNLOAD_RETRY_LIMIT       3      per-tile connection-error retries
DOWNLOAD_RETRY_DELAY_MS    3000
```
