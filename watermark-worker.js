import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
    VideoSampleSink,
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

async function findFirstKeyPacket(sink) {
    for await (const packet of sink.packets()) {
        if (packet.type === 'key') return packet;
    }
    return null;
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
        const scale = Math.min(1, 1280 / Math.max(width, height));
        const outputWidth = Math.max(2, Math.round(width * scale / 2) * 2);
        const outputHeight = Math.max(2, Math.round(height * scale / 2) * 2);
        const codedWidth = typeof videoTrack.getCodedWidth === 'function' ? await videoTrack.getCodedWidth() : videoTrack.codedWidth || width;
        const codedHeight = typeof videoTrack.getCodedHeight === 'function' ? await videoTrack.getCodedHeight() : videoTrack.codedHeight || height;
        const decoderConfig = await videoTrack.getDecoderConfig();
        if (!decoderConfig || !String(decoderConfig.codec).startsWith('avc')) {
            throw new Error('This video format cannot use the fast intro-only path.');
        }

        const canvas = new OffscreenCanvas(outputWidth, outputHeight);
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        const introPackets = [];
        encoder = new VideoEncoder({
            output: (chunk, metadata) => introPackets.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { throw error; },
        });
        const support = await VideoEncoder.isConfigSupported({
            ...decoderConfig,
            width: outputWidth,
            height: outputHeight,
            bitrate: Math.max(500_000, Math.round(outputWidth * outputHeight * 0.08 * INTRO_FPS / 8)),
            framerate: INTRO_FPS,
            hardwareAcceleration: 'prefer-hardware',
        });
        if (!support.supported) throw new Error('This browser cannot encode the intro locally.');
        encoder.configure(support.config);

        for (let index = 0; index < INTRO_DURATION * INTRO_FPS; index += 1) {
            const time = index / INTRO_FPS;
            context.globalCompositeOperation = 'source-over';
            context.globalAlpha = 1;
            context.clearRect(0, 0, outputWidth, outputHeight);
            context.drawImage(backgroundBitmap, 0, 0, outputWidth, outputHeight);
            context.globalAlpha = opacityAt(time);
            const logoWidth = Math.round(outputWidth * 0.18 * scaleAt(time));
            const logoHeight = Math.round(watermarkBitmap.height * logoWidth / watermarkBitmap.width);
            const wobble = Math.sin(time * Math.PI * 6) * 0.08;
            context.save();
            context.translate(outputWidth / 2, outputHeight / 2);
            context.rotate(wobble);
            context.scale(1 + wobble * 0.35, 1 - wobble * 0.2);
            context.drawImage(watermarkBitmap, -logoWidth / 2, -logoHeight / 2, logoWidth, logoHeight);
            context.restore();
            const frame = new VideoFrame(canvas, { timestamp: index * 1_000_000 / INTRO_FPS, duration: 1_000_000 / INTRO_FPS });
            encoder.encode(frame, { keyFrame: index === 0 });
            frame.close();
        }
        await encoder.flush();
        encoder.close();
        encoder = null;
        if (!introPackets.length) throw new Error('The intro encoder produced no frames.');

        send('status', { message: 'Encoding the original video locally with hardware acceleration...' });
        const samples = new VideoSampleSink(videoTrack).samples();
        const sourceDuration = typeof videoTrack.computeDuration === 'function' ? await videoTrack.computeDuration() : 1;
        let firstMainFrame = true;
        let mainEncoderError;
        encoder = new VideoEncoder({
            output: (chunk, metadata) => introPackets.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { mainEncoderError = error; },
        });
        encoder.configure(support.config);
        for await (const sample of samples) {
            context.globalAlpha = 1;
            context.globalCompositeOperation = 'source-over';
            context.clearRect(0, 0, outputWidth, outputHeight);
            sample.draw(context, 0, 0, outputWidth, outputHeight);
            const frame = new VideoFrame(canvas, {
                timestamp: Math.round((sample.timestamp + INTRO_DURATION) * 1_000_000),
                duration: Math.max(1, Math.round(sample.duration * 1_000_000)),
            });
            encoder.encode(frame, { keyFrame: firstMainFrame });
            firstMainFrame = false;
            frame.close();
            sample.close();
            while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 0));
            send('progress', { value: Math.min(0.98, 0.02 + sample.timestamp / Math.max(1, sourceDuration) * 0.96) });
        }
        await encoder.flush();
        encoder.close();
        encoder = null;
        if (mainEncoderError) throw mainEncoderError;

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(videoSource, { frameRate: INTRO_FPS });
        const audioTrack = await input.getPrimaryAudioTrack();
        const audioSource = audioTrack ? new EncodedAudioPacketSource(typeof audioTrack.getCodec === 'function' ? await audioTrack.getCodec() : audioTrack.codec) : null;
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();
        for (const item of introPackets) await videoSource.add(item.packet, item.metadata);
        videoSource.close();

        if (audioSource && audioTrack) {
            const audioPackets = new EncodedPacketSink(audioTrack).packets();
            const firstAudio = await audioPackets.next();
            if (firstAudio.done) throw new Error('The audio track contains no packets.');
            const audioConfig = await audioTrack.getDecoderConfig();
            const audioOffset = INTRO_DURATION - firstAudio.value.timestamp;
            await audioSource.add(firstAudio.value.clone({ timestamp: firstAudio.value.timestamp + audioOffset }), { decoderConfig: audioConfig });
            for await (const packet of audioPackets) await audioSource.add(packet.clone({ timestamp: packet.timestamp + audioOffset }));
            audioSource.close();
        }
        await output.finalize();
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('The intro MP4 could not be created.');
        send('progress', { value: 1 });
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
