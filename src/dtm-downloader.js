#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const SEARCH_URL = 'https://api.lantmateriet.se/stac-hojd/v1/search';
let axios;
let credentials;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseBbox(rawBbox) {
  if (!rawBbox) {
    fail('Missing bbox argument. Usage: node src/dtm-downloader.js min_lon,min_lat,max_lon,max_lat');
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
  await fs.promises.mkdir(directory, { recursive: true });
  const results = await Promise.all(urls.map((url) => downloadTile(url, directory)));
  const downloaded = results.filter((result) => result.ok).map((result) => result.path);
  const failed = results.filter((result) => !result.ok);

  printJson({ downloaded_tiles: downloaded });

  if (failed.length > 0) {
    console.error('Failed tiles:');
    for (const failure of failed) {
      console.error(`- ${failure.url}: ${failure.error}`);
    }
  }
}

async function main() {
  const bbox = parseBbox(process.argv[2]);
  loadAxios();
  loadCredentials();

  let tileUrls;
  try {
    tileUrls = await fetchDtmTileUrls(bbox);
  } catch (error) {
    const status = error.response?.status ? `HTTP ${error.response.status}` : 'No HTTP status';
    const responseMessage = error.response?.data?.message || error.response?.statusText || error.message;
    console.error(`API request failed (${status}): ${responseMessage}`);
    process.exit(1);
  }

  printJson({ dtm_tiles: tileUrls });

  if (tileUrls.length === 0) {
    console.error('No DTM tiles found for the given bounding box.');
    return;
  }

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
