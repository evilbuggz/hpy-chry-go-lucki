import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    EncodedPacket,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    Mp4OutputFormat,
    Output,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.25.0/+esm';

const INTRO_DURATION = 3;
const FALLBACK_FPS = 30;

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
        const frameRateMetrics = typeof videoTrack.computeFrameRateMetrics === 'function'
            ? await videoTrack.computeFrameRateMetrics({ targetPacketCount: 256 })
            : null;
        const frameRate = Math.max(1, Math.min(240, Number(
            frameRateMetrics?.underlyingFrameRate
            || frameRateMetrics?.bestGuessFrameRate
            || FALLBACK_FPS,
        )));
        const introFrameCount = Math.max(1, Math.round(INTRO_DURATION * frameRate));

        const canvas = new OffscreenCanvas(codedWidth, codedHeight);
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context) throw new Error('The browser could not create the intro canvas.');
        const packets = [];
        encoder = new VideoEncoder({
            output: (chunk, metadata) => packets.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { throw error; },
        });
        const support = await VideoEncoder.isConfigSupported({
            codec: decoderConfig.codec,
            width: codedWidth,
            height: codedHeight,
            bitrate: Math.max(500_000, Math.round(codedWidth * codedHeight * 0.08 * frameRate / 8)),
            framerate: frameRate,
            hardwareAcceleration: 'prefer-hardware',
        });
        if (!support.supported) throw new Error('This browser cannot encode the intro locally.');
        encoder.configure(support.config);

        for (let index = 0; index < introFrameCount; index += 1) {
            const time = index / frameRate;
            context.globalCompositeOperation = 'source-over';
            context.globalAlpha = 1;
            context.clearRect(0, 0, codedWidth, codedHeight);
            context.drawImage(backgroundBitmap, 0, 0, codedWidth, codedHeight);
            context.globalAlpha = opacityAt(time);
            const logoWidth = Math.round(codedWidth * 0.18 * scaleAt(time));
            const logoHeight = Math.round(watermarkBitmap.height * logoWidth / watermarkBitmap.width);
            const wobble = Math.sin(time * Math.PI * 6) * 0.08;
            context.save();
            context.translate(codedWidth / 2, codedHeight / 2);
            context.rotate(wobble);
            context.scale(1 + wobble * 0.35, 1 - wobble * 0.2);
            context.drawImage(watermarkBitmap, -logoWidth / 2, -logoHeight / 2, logoWidth, logoHeight);
            context.restore();
            const frame = new VideoFrame(canvas, {
                timestamp: index * 1_000_000 / frameRate,
                duration: 1_000_000 / frameRate,
            });
            encoder.encode(frame, { keyFrame: index === 0 });
            frame.close();
            while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 0));
            send('progress', { value: (index + 1) / introFrameCount });
        }
        await encoder.flush();
        encoder.close();
        encoder = null;
        if (!packets.length) throw new Error('The intro encoder produced no frames.');

        send('status', { message: 'Combining intro with the original video...' });
        const originalVideoSink = new EncodedPacketSink(videoTrack);
        const originalAudioTrack = await input.getPrimaryAudioTrack();
        const originalAudioSink = originalAudioTrack ? new EncodedPacketSink(originalAudioTrack) : null;
        const videoCodec = typeof videoTrack.getCodec === 'function'
            ? await videoTrack.getCodec()
            : videoTrack.codec;
        const videoDecoderConfig = await videoTrack.getDecoderConfig();
        if (!videoCodec || !videoDecoderConfig) throw new Error('The original video codec could not be read.');

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new EncodedVideoPacketSource(videoCodec);
        output.addVideoTrack(videoSource, {
            frameRate,
            decoderConfig: videoDecoderConfig,
        });
        let audioSource = null;
        let audioDecoderConfig = null;
        if (originalAudioTrack && originalAudioSink) {
            const audioCodec = typeof originalAudioTrack.getCodec === 'function'
                ? await originalAudioTrack.getCodec()
                : originalAudioTrack.codec;
            audioDecoderConfig = await originalAudioTrack.getDecoderConfig();
            if (audioCodec && audioDecoderConfig) {
                audioSource = new EncodedAudioPacketSource(audioCodec);
                output.addAudioTrack(audioSource, { decoderConfig: audioDecoderConfig });
            }
        }
        await output.start();
        for (let index = 0; index < packets.length; index += 1) {
            const item = packets[index];
            await videoSource.add(item.packet, index === 0 ? { decoderConfig: videoDecoderConfig } : undefined);
        }
        for await (const packet of originalVideoSink.packets()) {
            await videoSource.add(packet.clone({ timestamp: packet.timestamp + INTRO_DURATION }));
        }
        videoSource.close();
        if (audioSource && originalAudioSink) {
            let isFirstAudioPacket = true;
            for await (const packet of originalAudioSink.packets()) {
                const shiftedPacket = packet.clone({ timestamp: packet.timestamp + INTRO_DURATION });
                await audioSource.add(shiftedPacket, isFirstAudioPacket ? { decoderConfig: audioDecoderConfig } : undefined);
                isFirstAudioPacket = false;
            }
            audioSource.close();
        }
        await output.finalize();
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('The combined MP4 could not be created.');
        send('complete', { data });
    } catch (error) {
        encoder?.close();
        send('error', { message: error instanceof Error ? error.message : String(error) });
    } finally {
        if (input) input.dispose();
        watermarkBitmap?.close();
        backgroundBitmap?.close();
    }
});
