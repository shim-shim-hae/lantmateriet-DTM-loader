#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const SEARCH_URL = 'https://api.lantmateriet.se/stac-hojd/v1/search';
const GRID_CELL_SIZE_KM = 10;
const GRID_COORDINATE_EPSILON = 1e-12;
const QUERY_DELAY_MS = 1000;
const QUERY_RETRY_LIMIT = 3;
const QUERY_RETRY_BASE_DELAY_MS = 2000;
const TILE_URL_MANIFEST_FILENAME = 'dtm-tile-urls.json';
const DOWNLOAD_MANIFEST_FILENAME = 'dtm-download-manifest.json';

let axios;
let turf;
let credentials;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  return [
    'Usage:',
    '  node src/dtm-downloader.js min_lon,min_lat,max_lon,max_lat',
    '  node src/dtm-downloader.js --geojson path/to/polygon.geojson',
  ].join('\n');
}

function parseCliArgs(args) {
  if (args[0] === '--geojson') {
    if (!args[1]) {
      fail(`Missing GeoJSON file path.\n${usage()}`);
    }

    if (args.length > 2) {
      fail(`Too many arguments for GeoJSON mode.\n${usage()}`);
    }

    return { mode: 'geojson', geojsonPath: args[1] };
  }

  if (args[0]?.startsWith('--')) {
    fail(`Unknown option: ${args[0]}\n${usage()}`);
  }

  return { mode: 'bbox', bbox: parseBbox(args[0]) };
}

function parseBbox(rawBbox) {
  if (!rawBbox) {
    fail(`Missing bbox argument.\n${usage()}`);
  }

  const bbox = rawBbox.split(',').map((value) => Number(value.trim()));

  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    fail('Invalid bbox. Provide exactly 4 numeric values: min_lon,min_lat,max_lon,max_lat');
  }

  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (minLon >= maxLon) {
    fail('Invalid bbox. min_lon must be less than max_lon.');
  }

  if (minLat >= maxLat) {
    fail('Invalid bbox. min_lat must be less than max_lat.');
  }

  return bbox;
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeJsonFile(filePath, payload) {
  return fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function loadCredentials() {
  const username = process.env.LM_USERNAME;
  const password = process.env.LM_PASSWORD;
  if (!username || !password) {
    fail('Missing credentials. Set the LM_USERNAME and LM_PASSWORD environment variables.');
  }
  credentials = { username, password };
}

function loadAxios() {
  try {
    axios = require('axios');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      fail("Missing dependency 'axios'. Install it with `npm install axios` and run this script again.");
    }

    throw error;
  }
}

function loadTurf() {
  try {
    turf = require('@turf/turf');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      fail("Missing dependency '@turf/turf'. Install it with `npm install @turf/turf` and run this script again.");
    }

    throw error;
  }
}

function readGeoJsonPolygon(filePath) {
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    fail(`GeoJSON file does not exist: ${resolvedPath}`);
  }

  let geojson;
  try {
    geojson = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    fail(`GeoJSON file is not valid JSON: ${resolvedPath}. ${error.message}`);
  }

  const geometry = geojson.type === 'Feature' ? geojson.geometry : geojson;
  if (!geometry || geometry.type !== 'Polygon') {
    fail('GeoJSON input must be a Feature with Polygon geometry or a bare Polygon geometry.');
  }

  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    fail('GeoJSON Polygon must contain coordinates.');
  }

  return geometry;
}

function destinationCoordinate(coordinate, distanceKm, bearing) {
  return turf.destination(turf.point(coordinate), distanceKm, bearing, { units: 'kilometers' }).geometry.coordinates;
}

function subdividePolygonBbox(geometry) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(geometry);
  if ([minLon, minLat, maxLon, maxLat].some((value) => !Number.isFinite(value)) || minLon >= maxLon || minLat >= maxLat) {
    fail('GeoJSON Polygon has an invalid bounding box.');
  }

  const cells = [];
  let south = minLat;
  let row = 0;

  while (south < maxLat - GRID_COORDINATE_EPSILON) {
    const north = destinationCoordinate([minLon, south], GRID_CELL_SIZE_KM, 0)[1];
    if (north <= south) {
      fail('Unable to subdivide GeoJSON bounding box: latitude grid did not advance.');
    }

    let west = minLon;
    let column = 0;

    while (west < maxLon - GRID_COORDINATE_EPSILON) {
      const east = destinationCoordinate([west, south], GRID_CELL_SIZE_KM, 90)[0];
      if (east <= west) {
        fail('Unable to subdivide GeoJSON bounding box: longitude grid did not advance.');
      }

      cells.push({
        bbox: [west, south, east, north],
        row: row + 1,
        column: column + 1,
      });

      if (cells.length > 100000) {
        fail('Unable to subdivide GeoJSON bounding box: generated more than 100000 cells.');
      }

      west = east;
      column += 1;
    }

    south = north;
    row += 1;
  }

  return cells;
}

function getNextLink(responseData) {
  return responseData.links?.find((link) => link.rel === 'next');
}

async function requestStacPage(url, bbox, nextLink) {
  if (nextLink?.method?.toUpperCase() === 'GET') {
    return axios.get(url);
  }

  const body = nextLink?.body || { bbox };
  return axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/geo+json, application/json',
    },
  });
}

function resolveLinkHref(href) {
  return new URL(href, SEARCH_URL).href;
}

async function fetchDtmTileUrls(bbox) {
  const urls = new Set();
  let nextUrl = SEARCH_URL;
  let nextLink = null;

  do {
    const response = await requestStacPage(nextUrl, bbox, nextLink);
    const features = Array.isArray(response.data.features) ? response.data.features : [];

    for (const feature of features) {
      const href = feature.assets?.data?.href;
      if (typeof href === 'string' && /\/data\/grid1m\//.test(href)) {
        urls.add(href);
      }
    }

    nextLink = getNextLink(response.data);
    nextUrl = nextLink?.href ? resolveLinkHref(nextLink.href) : null;
  } while (nextUrl);

  return [...urls];
}

function formatHttpError(error) {
  const status = error.response?.status ? `HTTP ${error.response.status}` : 'No HTTP status';
  const responseMessage = error.response?.data?.message || error.response?.statusText || error.message;
  return `${status}: ${responseMessage}`;
}

function retryDelayMs(error, attempt) {
  const retryAfter = Number(error.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }

  return QUERY_RETRY_BASE_DELAY_MS * (attempt + 1);
}

async function fetchDtmTileUrlsWithRetry(bbox, label) {
  for (let attempt = 0; attempt <= QUERY_RETRY_LIMIT; attempt += 1) {
    try {
      return await fetchDtmTileUrls(bbox);
    } catch (error) {
      if (error.response?.status !== 429 || attempt === QUERY_RETRY_LIMIT) {
        throw error;
      }

      const waitMs = retryDelayMs(error, attempt);
      console.error(`${label} hit API rate limit; retrying in ${(waitMs / 1000).toFixed(1)}s...`);
      await delay(waitMs);
    }
  }

  return [];
}

async function fetchDtmTileUrlsForCells(cells) {
  const urls = new Set();
  const skippedCells = [];

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (index > 0) {
      await delay(QUERY_DELAY_MS);
    }

    console.error(`Querying cell ${index + 1}/${cells.length}...`);

    try {
      const cellUrls = await fetchDtmTileUrlsWithRetry(cell.bbox, `Cell ${index + 1}/${cells.length}`);
      for (const url of cellUrls) {
        urls.add(url);
      }
    } catch (error) {
      const message = formatHttpError(error);
      skippedCells.push({ index: index + 1, bbox: cell.bbox, error: message });
      console.error(`Skipping cell ${index + 1}/${cells.length}: ${message}`);
    }
  }

  return { tileUrls: [...urls], skippedCells };
}

function askDownloadDirectory(tileCount) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(`Download these ${tileCount} tiles? Enter directory path (or press Enter to skip): `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function progressBar(downloaded, total) {
  if (!total) {
    return '[????????????????????]';
  }

  const width = 20;
  const completed = Math.min(width, Math.floor((downloaded / total) * width));
  return `[${'#'.repeat(completed)}${'-'.repeat(width - completed)}]`;
}

function bytesToGb(bytes) {
  return bytes / 1_000_000_000;
}

async function estimateDownloadSize(tileUrls) {
  if (tileUrls.length === 0) {
    return {
      tileCount: 0,
      tileSizeBytes: 0,
      totalBytes: 0,
      totalGb: 0,
      known: true,
    };
  }

  try {
    const response = await axios.head(tileUrls[0], { auth: credentials });
    const tileSizeBytes = Number(response.headers['content-length']);
    if (!Number.isFinite(tileSizeBytes) || tileSizeBytes <= 0) {
      throw new Error('missing content-length header');
    }

    const totalBytes = tileSizeBytes * tileUrls.length;
    return {
      tileCount: tileUrls.length,
      tileSizeBytes,
      totalBytes,
      totalGb: bytesToGb(totalBytes),
      known: true,
    };
  } catch (error) {
    console.error(`Could not determine tile size: ${formatHttpError(error)}`);
    return {
      tileCount: tileUrls.length,
      tileSizeBytes: null,
      totalBytes: null,
      totalGb: null,
      known: false,
    };
  }
}

function filenameFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const filename = path.basename(decodeURIComponent(parsedUrl.pathname));
    return filename || `dtm-tile-${Date.now()}.tif`;
  } catch {
    return path.basename(url) || `dtm-tile-${Date.now()}.tif`;
  }
}

function createProgressLogger(filename, totalBytes) {
  let lastLoggedAt = 0;

  return (downloadedBytes, force = false) => {
    const now = Date.now();
    if (!force && now - lastLoggedAt < 500) {
      return;
    }

    lastLoggedAt = now;
    const total = totalBytes ? formatBytes(totalBytes) : 'unknown';
    console.error(
      `Downloading ${filename}... ${progressBar(downloadedBytes, totalBytes)} ${formatBytes(downloadedBytes)} / ${total}`,
    );
  };
}

async function downloadTile(url, directory) {
  const filename = filenameFromUrl(url);
  const destination = path.resolve(directory, filename);

  try {
    const response = await axios.get(url, { responseType: 'stream', auth: credentials });
    const totalBytes = Number(response.headers['content-length']) || 0;
    let downloadedBytes = 0;
    const logProgress = createProgressLogger(filename, totalBytes);

    logProgress(downloadedBytes, true);
    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      logProgress(downloadedBytes);
    });

    await pipeline(response.data, fs.createWriteStream(destination));
    logProgress(downloadedBytes, true);
    console.error(`Finished ${filename}`);

    return { ok: true, url, path: destination };
  } catch (error) {
    const status = error.response?.status ? `HTTP ${error.response.status}: ` : '';
    console.error(`Failed to download ${url}: ${status}${error.message}`);
    return { ok: false, url, error: `${status}${error.message}` };
  }
}

async function downloadTiles(urls, directory) {
  const resolvedDirectory = path.resolve(directory);
  await fs.promises.mkdir(resolvedDirectory, { recursive: true });

  const tileUrlManifestPath = path.join(resolvedDirectory, TILE_URL_MANIFEST_FILENAME);
  await writeJsonFile(tileUrlManifestPath, { dtm_tiles: urls });
  console.error(`Saved tile URL list to ${tileUrlManifestPath}`);

  const results = await Promise.all(urls.map((url) => downloadTile(url, resolvedDirectory)));
  const downloaded = results.filter((result) => result.ok).map((result) => result.path);
  const failed = results.filter((result) => !result.ok);

  const downloadManifestPath = path.join(resolvedDirectory, DOWNLOAD_MANIFEST_FILENAME);
  await writeJsonFile(downloadManifestPath, {
    downloaded_tiles: downloaded,
    failed_tiles: failed.map((failure) => ({
      url: failure.url,
      error: failure.error,
    })),
  });
  console.error(`Saved download manifest to ${downloadManifestPath}`);

  printJson({ downloaded_tiles: downloaded });

  if (failed.length > 0) {
    console.error('Failed tiles:');
    for (const failure of failed) {
      console.error(`- ${failure.url}: ${failure.error}`);
    }
  }
}

async function main() {
  const input = parseCliArgs(process.argv.slice(2));
  let tileUrls;
  let skippedCells = [];

  if (input.mode === 'geojson') {
    loadTurf();
    const geometry = readGeoJsonPolygon(input.geojsonPath);
    const cells = subdividePolygonBbox(geometry);
    console.error(`Created ${cells.length} 10x10 km query cells.`);

    loadAxios();
    loadCredentials();

    const result = await fetchDtmTileUrlsForCells(cells);
    tileUrls = result.tileUrls;
    skippedCells = result.skippedCells;
  } else {
    loadAxios();
    loadCredentials();

    try {
      tileUrls = await fetchDtmTileUrlsWithRetry(input.bbox, 'Bounding box query');
    } catch (error) {
      console.error(`API request failed (${formatHttpError(error)})`);
      process.exit(1);
    }
  }

  printJson({ dtm_tiles: tileUrls });

  if (skippedCells.length > 0) {
    console.error(`Skipped ${skippedCells.length} cells due to query errors:`);
    for (const skippedCell of skippedCells) {
      console.error(`- Cell ${skippedCell.index}: ${skippedCell.error}`);
    }
  }

  if (tileUrls.length === 0) {
    console.error('No DTM tiles found for the given bounding box.');
    return;
  }

  const downloadSize = await estimateDownloadSize(tileUrls);
  printJson({
    tile_count: tileUrls.length,
    tile_size_bytes: downloadSize.tileSizeBytes,
    total_download_size_gb: downloadSize.totalGb === null ? null : Number(downloadSize.totalGb.toFixed(3)),
  });

  const directory = await askDownloadDirectory(tileUrls.length);
  if (!directory) {
    return;
  }

  await downloadTiles(tileUrls, directory);
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
