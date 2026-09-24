const { resolveMedia } = require('./_media.js');
const crypto = require('node:crypto');

async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).send('Method not allowed.');
  }

  const requestId = crypto.randomUUID();
  const logger = (event) => console.log(JSON.stringify({ requestId, endpoint: 'download', ...event }));
  response.setHeader('X-Request-Id', requestId);
  logger({ stage: 'request.start', method: request.method, hasUrl: Boolean(request.query.url), hasViewkey: Boolean(request.query.viewkey), quality: request.query.quality || null });

  const requestedQuality = String(request.query.quality || '');

  try {
    const sources = await resolveMedia(request.query.url || request.query.viewkey, logger);
    const source = sources.find((item) => item.quality === requestedQuality) || sources[0];
    const mediaUrl = new URL(source.videoUrl);
    if (mediaUrl.protocol !== 'https:' || !mediaUrl.hostname.endsWith('.phncdn.com')) {
      throw new Error('The resolved media host is not allowed.');
    }

    response.setHeader('Cache-Control', 'no-store');
    logger({ stage: 'request.redirect', quality: source.quality });
    return response.redirect(307, mediaUrl.toString());
  } catch (error) {
    logger({ stage: 'request.failed', name: error.name, message: error.message, stack: error.stack });
    return response.status(502).send(`Download failed: ${error.message || 'unknown error'}`);
  }
}

module.exports = handler;
