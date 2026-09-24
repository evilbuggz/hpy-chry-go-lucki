import { resolveMedia } from './_media.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const sources = await resolveMedia();
    response.setHeader('Cache-Control', 'no-store');
    return response.status(200).json({ sources });
  } catch (error) {
    return response.status(502).json({ error: error.message || 'Could not resolve the video source.' });
  }
}
