const { resolveMedia } = require('./_media.js');

async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const sources = await resolveMedia(request.query.url || request.query.viewkey);
    response.setHeader('Cache-Control', 'no-store');
    return response.status(200).json({ sources });
  } catch (error) {
    return response.status(502).json({ error: error.message || 'Could not resolve the video source.' });
  }
}

module.exports = handler;
