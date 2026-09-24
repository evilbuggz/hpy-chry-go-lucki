const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

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

function getVideoPageUrl(input) {
  const value = String(input || '').trim();
  const candidate = value.includes('://') ? value : `https://www.pornhub.com/view_video.php?viewkey=${value}`;
  const url = new URL(candidate);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(hostname === 'pornhub.com' || hostname.endsWith('.pornhub.com'))) {
    throw new Error('Enter a valid Pornhub video URL or viewkey.');
  }
  if (!url.pathname.includes('view_video.php') && !url.pathname.startsWith('/embed/')) {
    throw new Error('The URL must point to a Pornhub video page or embed.');
  }
  return url.toString();
}

function extractPlayerData(page, sourceName = 'remote response') {
  const match = page.match(/var\s+CLIPS_DATA\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (match) return JSON.parse(match[1]);

  const flashvarsMatch = page.match(/var\s+flashvars_[^=]+\s*=\s*(\{[\s\S]*?\});\s*var\s+player_mp4_seek/);
  if (flashvarsMatch) {
    const flashvars = JSON.parse(flashvarsMatch[1]);
    return { mediaDefinition: flashvars.mediaDefinitions || [] };
  }

  if (/requiring us to verify your age/i.test(page)) {
    throw new Error(`${sourceName} returned an age-verification page instead of the video page.`);
  }
  throw new Error(`No player media data was found in ${sourceName}.`);
}

async function getVideoPage(videoPageUrl, useFallback) {
  const videoUrl = new URL(videoPageUrl);
  const viewkey = videoUrl.searchParams.get('viewkey') || videoUrl.pathname.split('/').filter(Boolean).pop();
  const candidates = [videoPageUrl];
  if (viewkey && !videoUrl.pathname.startsWith('/embed/')) {
    candidates.push(`https://www.pornhub.com/embed/${encodeURIComponent(viewkey)}`);
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      return extractPlayerData(await fetchText(candidate, 'https://www.pornhub.com/'), `the remote video page (${candidate})`);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!useFallback) throw new Error(errors.join(' '));

  const fallbackPaths = [
    join(process.cwd(), 'index.html'),
    join(process.cwd(), 'src', 'index.html'),
    join(__dirname, '..', 'index.html'),
  ];

  let localError;
  for (const fallbackPath of fallbackPaths) {
    try {
      const localPage = await readFile(fallbackPath, 'utf8');
      return extractPlayerData(localPage, `the bundled index.html at ${fallbackPath}`);
    } catch (error) {
      localError = error;
    }
  }

  throw new Error(`${errors.join(' ')} The bundled fallback also failed: ${localError.message}`);
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

async function resolveMedia(input) {
  const videoPageUrl = getVideoPageUrl(input);
  const defaultVideoPage = 'https://www.pornhub.com/view_video.php?viewkey=6a0f3e5a30bab';
  const clipsData = await getVideoPage(videoPageUrl, videoPageUrl === defaultVideoPage);
  const definition = (clipsData.mediaDefinition || []).find(
    (source) => source.format === 'mp4' && source.videoUrl,
  );
  if (!definition) throw new Error('The fresh page did not contain an MP4 source.');

  const resolverResponse = await fetch(definition.videoUrl, {
    headers: requestHeaders(videoPageUrl),
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

module.exports = { getVideoPageUrl, resolveMedia, USER_AGENT };
