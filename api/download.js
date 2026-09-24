const { resolveMedia } = require('./_media.js');

async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).send('Method not allowed.');
  }

  const requestedQuality = String(request.query.quality || '');

  try {
    const sources = await resolveMedia(request.query.url || request.query.viewkey);
    const source = sources.find((item) => item.quality === requestedQuality) || sources[0];
    const mediaUrl = new URL(source.videoUrl);
    if (mediaUrl.protocol !== 'https:' || !mediaUrl.hostname.endsWith('.phncdn.com')) {
      throw new Error('The resolved media host is not allowed.');
    }

    response.setHeader('Cache-Control', 'no-store');
    return response.redirect(307, mediaUrl.toString());
  } catch (error) {
    return response.status(502).send(`Download failed: ${error.message || 'unknown error'}`);
  }
}

module.exports = handler;
