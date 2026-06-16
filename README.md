# Lantmäteriet DTM Loader

CLI tool that searches the Swedish [Lantmäteriet](https://www.lantmateriet.se/) STAC API for DTM (Digital Terrain Model) tiles that intersect a given bounding box and optionally downloads them.

## Requirements

- Node.js 18 or later
- npm

## Installation

```bash
npm install
```

## Usage

```bash
node src/dtm-downloader.js <min_lon,min_lat,max_lon,max_lat>
```

Coordinates must be in WGS84 (EPSG:4326).

**Example**

```bash
node src/dtm-downloader.js 17.9,59.2,18.2,59.5
```

The tool first prints the matching tile URLs as JSON:

```json
{
  "dtm_tiles": [
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_25.tif",
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_26.tif"
  ]
}
```

You are then prompted to enter a local directory path. Press **Enter** to skip the download. If a path is provided the tiles are downloaded in parallel and the result is printed:

```json
{
  "downloaded_tiles": [
    "/path/to/output/65875_6750_25.tif",
    "/path/to/output/65875_6750_26.tif"
  ]
}
```

Progress is written to `stderr` so that `stdout` stays clean JSON.

## API

The tool queries the Lantmäteriet STAC API:

- Base URL: `https://api.lantmateriet.se/stac-hojd/v1/`
- Interactive docs: `https://api.lantmateriet.se/stac-hojd/v1/api.html`

Pagination is handled automatically via STAC `next` links.
