import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.25.0/+esm';

const INTRO_DURATION = 3;
const INTRO_FPS = 30;

function send(type, payload = {}) {
    self.postMessage({ type, ...payload }, payload.data ? [payload.data] : []);
}

function scaleAt(time) {
    if (time < 0.45) return 0.72 + time / 0.45 * 0.43;
    if (time < 0.8) return 1.15 - (time - 0.45) / 0.35 * 0.15;
    return 1 + Math.sin((time - 0.8) * Math.PI * 4) * 0.035;
}

function opacityAt(time) {
    return time < 2 ? 1 : Math.max(0, 1 - (time - 2));
}

self.addEventListener('message', async (event) => {
    const { video, watermark, watermarkBackground } = event.data;
    let input;
    let encoder;
    let watermarkBitmap;
    let backgroundBitmap;
    try {
        if (!(video instanceof Blob) || !(watermark instanceof Blob) || !(watermarkBackground instanceof Blob)) {
            throw new Error('The browser did not provide valid intro assets.');
        }
        if (typeof VideoEncoder !== 'function' || typeof OffscreenCanvas !== 'function') {
            throw new Error('This browser does not provide local video encoding.');
        }

        send('status', { message: 'Preparing three-second intro...' });
        watermarkBitmap = await createImageBitmap(watermark);
        backgroundBitmap = await createImageBitmap(watermarkBackground);
        input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error('The downloaded file does not contain a video track.');
        const width = typeof videoTrack.getDisplayWidth === 'function' ? await videoTrack.getDisplayWidth() : videoTrack.displayWidth;
        const height = typeof videoTrack.getDisplayHeight === 'function' ? await videoTrack.getDisplayHeight() : videoTrack.displayHeight;
        const codedWidth = typeof videoTrack.getCodedWidth === 'function' ? await videoTrack.getCodedWidth() : videoTrack.codedWidth || width;
        const codedHeight = typeof videoTrack.getCodedHeight === 'function' ? await videoTrack.getCodedHeight() : videoTrack.codedHeight || height;
        const decoderConfig = await videoTrack.getDecoderConfig();
        if (!decoderConfig || !String(decoderConfig.codec).startsWith('avc')) {
            throw new Error('This browser cannot create a fast local intro for this video format.');
        }

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context) throw new Error('The browser could not create the intro canvas.');
        const packets = [];
        encoder = new VideoEncoder({
            output: (chunk, metadata) => packets.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { throw error; },
        });
        const support = await VideoEncoder.isConfigSupported({
            ...decoderConfig,
            width: codedWidth,
            height: codedHeight,
            bitrate: Math.max(500_000, Math.round(width * height * 0.08 * INTRO_FPS / 8)),
            framerate: INTRO_FPS,
            hardwareAcceleration: 'prefer-hardware',
        });
        if (!support.supported) throw new Error('This browser cannot encode the intro locally.');
        encoder.configure(support.config);

        for (let index = 0; index < INTRO_DURATION * INTRO_FPS; index += 1) {
            const time = index / INTRO_FPS;
            context.globalCompositeOperation = 'source-over';
            context.globalAlpha = 1;
            context.clearRect(0, 0, width, height);
            context.drawImage(backgroundBitmap, 0, 0, width, height);
            context.globalAlpha = opacityAt(time);
            const logoWidth = Math.round(width * 0.18 * scaleAt(time));
            const logoHeight = Math.round(watermarkBitmap.height * logoWidth / watermarkBitmap.width);
            const wobble = Math.sin(time * Math.PI * 6) * 0.08;
            context.save();
            context.translate(width / 2, height / 2);
            context.rotate(wobble);
            context.scale(1 + wobble * 0.35, 1 - wobble * 0.2);
            context.drawImage(watermarkBitmap, -logoWidth / 2, -logoHeight / 2, logoWidth, logoHeight);
            context.restore();
            const frame = new VideoFrame(canvas, {
                timestamp: index * 1_000_000 / INTRO_FPS,
                duration: 1_000_000 / INTRO_FPS,
            });
            encoder.encode(frame, { keyFrame: index === 0 });
            frame.close();
            while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 0));
            send('progress', { value: (index + 1) / (INTRO_DURATION * INTRO_FPS) });
        }
        await encoder.flush();
        encoder.close();
        encoder = null;
        if (!packets.length) throw new Error('The intro encoder produced no frames.');

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const source = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(source, { frameRate: INTRO_FPS });
        await output.start();
        for (const item of packets) await source.add(item.packet, item.metadata);
        source.close();
        await output.finalize();
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('The intro MP4 could not be created.');
        send('complete', { data });
    } catch (error) {
        encoder?.close();
        input?.dispose();
        send('error', { message: error instanceof Error ? error.message : String(error) });
    } finally {
        watermarkBitmap?.close();
        backgroundBitmap?.close();
    }
});
