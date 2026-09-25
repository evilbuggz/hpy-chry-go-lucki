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

const INTRO_DURATION = 2;
const INTRO_FPS = 30;

function send(type, payload = {}) {
    self.postMessage({ type, ...payload }, payload.data ? [payload.data] : []);
}

async function getSize(track) {
    return [
        typeof track.getDisplayWidth === 'function' ? await track.getDisplayWidth() : track.displayWidth,
        typeof track.getDisplayHeight === 'function' ? await track.getDisplayHeight() : track.displayHeight,
    ];
}

function scaleAt(time) {
    if (time < 0.45) return 0.72 + time / 0.45 * 0.43;
    if (time < 0.8) return 1.15 - (time - 0.45) / 0.35 * 0.15;
    return 1 + Math.sin((time - 0.8) * Math.PI * 4) * 0.035;
}

function opacityAt(time) {
    return time < 1.35 ? 1 : Math.max(0, 1 - (time - 1.35) / 0.65);
}

self.addEventListener('message', async (event) => {
    const { video, watermark, watermarkBackground } = event.data;
    let input;
    let watermarkBitmap;
    let backgroundBitmap;
    let encoder;
    try {
        if (!(video instanceof Blob) || !(watermark instanceof Blob) || !(watermarkBackground instanceof Blob)) {
            throw new Error('The browser did not provide valid intro assets.');
        }
        if (typeof VideoEncoder !== 'function' || typeof OffscreenCanvas !== 'function') {
            throw new Error('This browser does not provide local video encoding.');
        }

        send('status', { message: 'Preparing two-second intro...' });
        watermarkBitmap = await createImageBitmap(watermark);
        backgroundBitmap = await createImageBitmap(watermarkBackground);
        input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error('The downloaded file does not contain a video track.');
        const [width, height] = await getSize(videoTrack);
        const codedWidth = typeof videoTrack.getCodedWidth === 'function' ? await videoTrack.getCodedWidth() : videoTrack.codedWidth || width;
        const codedHeight = typeof videoTrack.getCodedHeight === 'function' ? await videoTrack.getCodedHeight() : videoTrack.codedHeight || height;
        const decoderConfig = await videoTrack.getDecoderConfig();
        if (!decoderConfig || !String(decoderConfig.codec).startsWith('avc')) {
            throw new Error('This video format cannot be processed locally without a full format conversion.');
        }

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context) throw new Error('The browser could not create the video canvas.');
        const encodedVideo = [];
        let encoderError;
        encoder = new VideoEncoder({
            output: (chunk, metadata) => encodedVideo.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { encoderError = error; },
        });
        const support = await VideoEncoder.isConfigSupported({
            ...decoderConfig,
            width: codedWidth,
            height: codedHeight,
            bitrate: Math.max(500_000, Math.round(width * height * 0.08 * 30 / 8)),
            framerate: 30,
            hardwareAcceleration: 'prefer-hardware',
        });
        if (!support.supported) throw new Error('This browser cannot encode the video with hardware acceleration.');
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
            context.drawImage(watermarkBitmap, (width - logoWidth) / 2, (height - logoHeight) / 2, logoWidth, logoHeight);
            const frame = new VideoFrame(canvas, { timestamp: index * 1_000_000 / INTRO_FPS, duration: 1_000_000 / INTRO_FPS });
            encoder.encode(frame, { keyFrame: index === 0 });
            frame.close();
        }

        send('status', { message: 'Encoding the original video locally with hardware acceleration...' });
        const samples = new VideoSampleSink(videoTrack).samples();
        let firstMainFrame = true;
        let sourceDuration = typeof videoTrack.computeDuration === 'function' ? await videoTrack.computeDuration() : 1;
        for await (const sample of samples) {
            context.globalAlpha = 1;
            context.globalCompositeOperation = 'source-over';
            context.clearRect(0, 0, width, height);
            sample.draw(context, 0, 0, width, height);
            const frame = new VideoFrame(canvas, {
                timestamp: Math.round((sample.timestamp + INTRO_DURATION) * 1_000_000),
                duration: Math.max(1, Math.round(sample.duration * 1_000_000)),
            });
            encoder.encode(frame, { keyFrame: firstMainFrame });
            firstMainFrame = false;
            frame.close();
            sample.close();
            send('progress', { value: Math.min(0.98, 0.02 + sample.timestamp / Math.max(1, sourceDuration) * 0.96) });
        }
        await encoder.flush();
        if (encoderError) throw encoderError;
        encoder.close();
        encoder = null;

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(videoSource, { frameRate: INTRO_FPS });
        const audioTrack = await input.getPrimaryAudioTrack();
        const audioSource = audioTrack ? new EncodedAudioPacketSource(typeof audioTrack.getCodec === 'function' ? await audioTrack.getCodec() : audioTrack.codec) : null;
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();
        for (const item of encodedVideo) await videoSource.add(item.packet, item.metadata);
        videoSource.close();

        if (audioSource && audioTrack) {
            const packets = new EncodedPacketSink(audioTrack).packets();
            const first = await packets.next();
            if (first.done) throw new Error('The audio track contains no packets.');
            const audioConfig = await audioTrack.getDecoderConfig();
            const offset = INTRO_DURATION - first.value.timestamp;
            await audioSource.add(first.value.clone({ timestamp: first.value.timestamp + offset }), { decoderConfig: audioConfig });
            for await (const packet of packets) await audioSource.add(packet.clone({ timestamp: packet.timestamp + offset }));
            audioSource.close();
        }
        await output.finalize();
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('The local MP4 could not be created.');
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
