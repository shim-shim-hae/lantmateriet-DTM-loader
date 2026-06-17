# Lantmäteriet DTM Loader

CLI tool that searches the Swedish [Lantmäteriet](https://www.lantmateriet.se/) STAC API for 1 m DTM tiles that intersect a given area and optionally downloads them.

## Requirements

- Node.js 18 or later
- npm
- Lantmäteriet account credentials (username + password)

## Installation

```bash
npm install
```

## Credentials

Create a `.env` file in the project root:

```
LM_USERNAME=your-username
LM_PASSWORD=your-password
```

The file is loaded automatically at startup. Alternatively, set `LM_USERNAME` and `LM_PASSWORD` as environment variables directly in your shell.

## Usage

### Bounding box mode

```bash
node src/dtm-downloader.js <min_lon,min_lat,max_lon,max_lat>
```

Coordinates must be in WGS84 (EPSG:4326).

```bash
node src/dtm-downloader.js 17.9,59.2,18.2,59.5
```

### GeoJSON polygon mode

```bash
node src/dtm-downloader.js --geojson path/to/polygon.geojson
```

Accepts a GeoJSON file containing a `Polygon` feature, a bare `Polygon` geometry, or a `FeatureCollection` with a single polygon feature (as exported by ArcGIS Pro). The polygon's extent is subdivided into a 10×10 km grid and the STAC API is queried once per cell to keep individual requests small. Duplicate tile URLs across cells are removed automatically.

## Output

All progress messages go to `stderr`; only JSON results go to `stdout`, so the output can be piped or redirected cleanly.

The tool first prints the list of matching tile URLs:

```json
{
  "dtm_tiles": [
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_25.tif",
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_26.tif"
  ]
}
```

Only `grid1m` (1 m resolution raster) assets are included. Point cloud and lower-resolution grid assets are excluded.

An estimated download size is then printed:

```json
{
  "tile_count": 2,
  "tile_size_bytes": 52428800,
  "total_download_size_gb": 0.105
}
```

You are prompted to enter a local directory path. Press **Enter** to skip the download.

If a path is provided, tiles are downloaded and two manifest files are written to that directory:

| File | Contents |
|------|----------|
| `dtm-tile-urls.json` | Full list of tile URLs that were found |
| `dtm-download-manifest.json` | Paths of successfully downloaded files and any failures |

The final result is also printed to `stdout`:

```json
{
  "downloaded_tiles": [
    "C:/output/65875_6750_25.tif",
    "C:/output/65875_6750_26.tif"
  ]
}
```

## Download behaviour

- Up to **4 tiles** are downloaded in parallel.
- Connection errors (`ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`) are retried up to **3 times** with a 3-second pause between attempts.
- STAC API rate-limit responses (HTTP 429) are retried automatically, respecting the `Retry-After` header when present.

## API

- STAC base URL: `https://api.lantmateriet.se/stac-hojd/v1/`
- Interactive docs: `https://api.lantmateriet.se/stac-hojd/v1/api.html`

Pagination is handled automatically via STAC `next` links.
