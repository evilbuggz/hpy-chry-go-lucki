const { resolveMedia } = require('./_media.js');
const crypto = require('node:crypto');

async function handler(request, response) {
  const requestId = crypto.randomUUID();
  const logger = (event) => console.log(JSON.stringify({ requestId, endpoint: 'resolve', ...event }));
  response.setHeader('X-Request-Id', requestId);
  logger({ stage: 'request.start', method: request.method, hasUrl: Boolean(request.query.url), hasViewkey: Boolean(request.query.viewkey) });

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const sources = await resolveMedia(request.query.url || request.query.viewkey, logger);
    response.setHeader('Cache-Control', 'no-store');
    logger({ stage: 'request.success', sourceCount: sources.length });
    return response.status(200).json({ sources });
  } catch (error) {
    logger({ stage: 'request.failed', name: error.name, message: error.message, stack: error.stack });
    return response.status(502).json({ error: error.message || 'Could not resolve the video source.', requestId });
  }
}

module.exports = handler;
