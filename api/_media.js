const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36';

function requestHeaders(referer) {
  return {
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    referer,
    'user-agent': USER_AGENT,
  };
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? combined.split(/,(?=[^;]+=[^;]+)/) : [];
}

function updateCookieJar(cookieJar, headers) {
  for (const header of getSetCookieHeaders(headers)) {
    const cookie = header.split(';', 1)[0].trim();
    const separator = cookie.indexOf('=');
    if (separator > 0) cookieJar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function fetchRemote(url, referer, cookieJar) {
  const headers = requestHeaders(referer);
  const cookies = cookieHeader(cookieJar);
  if (cookies) headers.cookie = cookies;

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    cache: 'no-store',
  });
  updateCookieJar(cookieJar, response.headers);
  return response;
}

async function fetchText(url, referer, cookieJar) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const separator = url.includes('?') ? '&' : '?';
      const requestUrl = `${url}${separator}_resolver_attempt=${attempt}`;
      const response = await fetchRemote(requestUrl, referer, cookieJar);
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Remote request returned HTTP ${response.status}.`);
      }
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
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
  const title = page.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const titleMessage = title ? ` (upstream title: ${title})` : '';
  throw new Error(`No player media data was found in ${sourceName}${titleMessage}.`);
}

async function getVideoPage(videoPageUrl) {
  const videoUrl = new URL(videoPageUrl);
  const viewkey = videoUrl.searchParams.get('viewkey') || videoUrl.pathname.split('/').filter(Boolean).pop();
  const candidates = [videoPageUrl];
  if (viewkey && !videoUrl.pathname.startsWith('/embed/')) {
    candidates.push(`https://www.pornhub.com/embed/${encodeURIComponent(viewkey)}`);
  }

  const errors = [];
  const cookieJar = new Map();
  for (const candidate of candidates) {
    try {
      return {
        clipsData: extractPlayerData(
          await fetchText(candidate, 'https://www.pornhub.com/', cookieJar),
          `the remote video page (${candidate})`,
        ),
        cookieJar,
      };
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(errors.join(' '));
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
  const { clipsData, cookieJar } = await getVideoPage(videoPageUrl);
  const definition = (clipsData.mediaDefinition || []).find(
    (source) => source.format === 'mp4' && source.videoUrl,
  );
  if (!definition) throw new Error('The fresh page did not contain an MP4 source.');

  const resolverResponse = await fetchRemote(definition.videoUrl, videoPageUrl, cookieJar);
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
