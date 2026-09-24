import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm';
import { toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/+esm';

const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
const ffmpeg = new FFmpeg();
let loaded = false;

function send(type, payload = {}) {
    self.postMessage({ type, ...payload }, payload.data ? [payload.data] : []);
}

async function loadEncoder() {
    if (loaded) return;
    ffmpeg.on('progress', ({ progress }) => {
        send('progress', { value: Math.max(0, Math.min(1, progress)) });
    });
    await ffmpeg.load({
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    loaded = true;
}

self.addEventListener('message', async (event) => {
    const { video, watermark } = event.data;
    try {
        if (!(video instanceof ArrayBuffer) || !(watermark instanceof ArrayBuffer)) {
            throw new Error('The browser did not provide a valid video to process.');
        }
        send('status', { message: 'Loading local video encoder...' });
        await loadEncoder();
        await ffmpeg.writeFile('input.mp4', new Uint8Array(video));
        await ffmpeg.writeFile('watermark.png', new Uint8Array(watermark));
        send('status', { message: 'Watermarking locally...' });
        const exitCode = await ffmpeg.exec([
            '-hide_banner',
            '-loglevel', 'error',
            '-i', 'input.mp4',
            '-i', 'watermark.png',
            '-filter_complex', '[1:v]scale=iw*0.18:-1[wm];[0:v][wm]overlay=W-w-18:H-h-18:format=auto[outv]',
            '-map', '[outv]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '32',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            '-y',
            'output.mp4',
        ]);
        if (exitCode !== 0) {
            throw new Error(`Local encoder exited with code ${exitCode}.`);
        }
        const output = await ffmpeg.readFile('output.mp4');
        const data = output instanceof Uint8Array
            ? output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
            : output;
        send('complete', { data });
        await ffmpeg.deleteFile('input.mp4');
        await ffmpeg.deleteFile('watermark.png');
        await ffmpeg.deleteFile('output.mp4');
    } catch (error) {
        send('error', { message: error instanceof Error ? error.message : 'Local video processing failed.' });
    }
});
