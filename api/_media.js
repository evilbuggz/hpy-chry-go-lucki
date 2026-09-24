import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO_KEY = '6a0f3e5a30bab';
const VIDEO_PAGE = `https://www.pornhub.com/view_video.php?viewkey=${VIDEO_KEY}`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36';

function requestHeaders(referer) {
  return {
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    referer,
    'user-agent': USER_AGENT,
  };
}

async function fetchText(url, referer) {
  const response = await fetch(url, {
    headers: requestHeaders(referer),
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Remote request returned HTTP ${response.status}.`);
  }
  return response.text();
}

function extractClipsData(page, sourceName = 'remote response') {
  const match = page.match(/var\s+CLIPS_DATA\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!match) {
    if (/requiring us to verify your age/i.test(page)) {
      throw new Error(`${sourceName} returned an age-verification page instead of the video page.`);
    }
    throw new Error(`CLIPS_DATA was not found in the ${sourceName}.`);
  }
  return JSON.parse(match[1]);
}

async function getVideoPage() {
  let remoteError;
  try {
    return extractClipsData(
      await fetchText(VIDEO_PAGE, 'https://www.pornhub.com/'),
      'the remote video page',
    );
  } catch (error) {
    remoteError = error;
  }

  const functionDirectory = fileURLToPath(new URL('.', import.meta.url));
  const fallbackPaths = [
    join(process.cwd(), 'index.html'),
    join(process.cwd(), 'src', 'index.html'),
    join(functionDirectory, '..', 'index.html'),
  ];

  let localError;
  for (const fallbackPath of fallbackPaths) {
    try {
      const localPage = await readFile(fallbackPath, 'utf8');
      return extractClipsData(localPage, `the bundled index.html at ${fallbackPath}`);
    } catch (error) {
      localError = error;
    }
  }

  throw new Error(`${remoteError.message} The bundled fallback also failed: ${localError.message}`);
}

function collectSources(value, sources = []) {
  if (!value || typeof value !== 'object') return sources;
  const url = value.videoUrl || value.url || value.src;
  if (typeof url === 'string' && url.startsWith('https://')) {
    sources.push({
      quality: String(value.quality || value.height || ''),
      format: String(value.format || 'mp4'),
      videoUrl: url,
    });
  }
  Object.values(value).forEach((child) => collectSources(child, sources));
  return sources;
}

export async function resolveMedia() {
  const clipsData = await getVideoPage();
  const definition = (clipsData.mediaDefinition || []).find(
    (source) => source.format === 'mp4' && source.videoUrl,
  );
  if (!definition) throw new Error('The fresh page did not contain an MP4 source.');

  const resolverResponse = await fetch(definition.videoUrl, {
    headers: requestHeaders(VIDEO_PAGE),
    redirect: 'follow',
  });
  if (!resolverResponse.ok) {
    throw new Error(`Media resolver returned HTTP ${resolverResponse.status}.`);
  }
  const resolved = await resolverResponse.json();
  const unique = new Map();
  collectSources(resolved).forEach((source) => unique.set(source.videoUrl, source));
  const sources = [...unique.values()].filter((source) => source.format === 'mp4');
  if (!sources.length) throw new Error('The media resolver returned no MP4 sources.');
  return sources;
}

export { VIDEO_PAGE, USER_AGENT };
