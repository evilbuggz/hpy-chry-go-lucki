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
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.25.0/+esm';

const FALLBACK_FPS = 30;

function send(type, payload = {}) {
    self.postMessage({ type, ...payload }, payload.data ? [payload.data] : []);
}

self.addEventListener('message', async (event) => {
    const { video, watermark } = event.data;
    let input;
    let encoder;
    let decoder;
    let watermarkBitmap;

    try {
        if (!(video instanceof Blob) || !(watermark instanceof Blob)) {
            throw new Error('The browser did not provide valid watermark assets.');
        }
        if (typeof VideoDecoder !== 'function' || typeof VideoEncoder !== 'function' || typeof OffscreenCanvas !== 'function') {
            throw new Error('This browser does not provide local hardware video processing.');
        }

        send('status', { message: 'Reading video encoding information...' });
        watermarkBitmap = await createImageBitmap(watermark);
        input = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error('The downloaded file does not contain a video track.');

        const width = typeof videoTrack.getDisplayWidth === 'function' ? await videoTrack.getDisplayWidth() : videoTrack.displayWidth;
        const height = typeof videoTrack.getDisplayHeight === 'function' ? await videoTrack.getDisplayHeight() : videoTrack.displayHeight;
        const codedWidth = typeof videoTrack.getCodedWidth === 'function' ? await videoTrack.getCodedWidth() : videoTrack.codedWidth || width;
        const codedHeight = typeof videoTrack.getCodedHeight === 'function' ? await videoTrack.getCodedHeight() : videoTrack.codedHeight || height;
        const decoderConfig = await videoTrack.getDecoderConfig();
        if (!decoderConfig || !String(decoderConfig.codec).startsWith('avc')) {
            throw new Error('This browser local path supports H.264 video only.');
        }

        const frameRateMetrics = typeof videoTrack.computeFrameRateMetrics === 'function'
            ? await videoTrack.computeFrameRateMetrics({ targetPacketCount: 256 })
            : null;
        const frameRate = Math.max(1, Math.min(240, Number(
            frameRateMetrics?.underlyingFrameRate
            || frameRateMetrics?.bestGuessFrameRate
            || FALLBACK_FPS,
        )));
        const canvas = new OffscreenCanvas(codedWidth, codedHeight);
        const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!context) throw new Error('The browser could not create the watermark canvas.');

        const packets = [];
        encoder = new VideoEncoder({
            output: (chunk, metadata) => packets.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { throw error; },
        });
        const encoderConfig = {
            codec: decoderConfig.codec,
            width: codedWidth,
            height: codedHeight,
            bitrate: Math.max(500_000, Math.round(codedWidth * codedHeight * 0.08 * frameRate / 8)),
            framerate: frameRate,
            hardwareAcceleration: 'prefer-hardware',
            ...(decoderConfig.description ? { description: decoderConfig.description } : {}),
        };
        const support = await VideoEncoder.isConfigSupported(encoderConfig);
        if (!support.supported) throw new Error('This browser cannot encode the video locally.');
        encoder.configure(support.config);

        const watermarkWidth = Math.max(1, Math.round(codedWidth * 0.18));
        const watermarkHeight = Math.max(1, Math.round(watermarkBitmap.height * watermarkWidth / watermarkBitmap.width));
        const margin = Math.max(12, Math.round(codedWidth * 0.018));
        const originalVideoSink = new EncodedPacketSink(videoTrack);
        const originalAudioTrack = await input.getPrimaryAudioTrack();
        const originalAudioSink = originalAudioTrack ? new EncodedPacketSink(originalAudioTrack) : null;
        const videoCodec = typeof videoTrack.getCodec === 'function' ? await videoTrack.getCodec() : videoTrack.codec;
        if (!videoCodec) throw new Error('The original video codec could not be read.');

        send('status', { message: 'Watermarking locally with hardware acceleration when available...' });
        let decoderError;
        let frameCount = 0;
        let timestampOffset = null;
        decoder = new VideoDecoder({
            output: (frame) => {
                try {
                    if (frame.timestamp + (timestampOffset || 0) < 0) {
                        timestampOffset = (timestampOffset || 0) - frame.timestamp;
                    }
                    context.globalAlpha = 1;
                    context.globalCompositeOperation = 'copy';
                    context.drawImage(frame, 0, 0, codedWidth, codedHeight);
                    context.globalCompositeOperation = 'source-over';
                    context.drawImage(watermarkBitmap, codedWidth - watermarkWidth - margin, margin, watermarkWidth, watermarkHeight);
                    const encodedFrame = new VideoFrame(canvas, {
                        timestamp: frame.timestamp + (timestampOffset || 0),
                        duration: frame.duration ?? 1_000_000 / frameRate,
                    });
                    encoder.encode(encodedFrame, { keyFrame: frameCount === 0 });
                    encodedFrame.close();
                    frameCount += 1;
                } catch (error) {
                    decoderError = error;
                } finally {
                    frame.close();
                }
            },
            error: (error) => { decoderError = error; },
        });
        decoder.configure({ ...decoderConfig, hardwareAcceleration: 'prefer-hardware' });

        let packetCount = 0;
        for await (const packet of originalVideoSink.packets()) {
            if (decoderError) throw decoderError;
            if (timestampOffset === null) timestampOffset = Math.max(0, -packet.timestamp * 1_000_000);
            const shiftedPacket = timestampOffset ? packet.clone({ timestamp: packet.timestamp + timestampOffset / 1_000_000 }) : packet;
            decoder.decode(shiftedPacket.toEncodedVideoChunk());
            packetCount += 1;
            if (packetCount % 30 === 0) send('status', { message: `Watermarking locally... ${packetCount} source packets processed.` });
            while (decoder.decodeQueueSize > 4 || encoder.encodeQueueSize > 4) {
                await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
            }
        }
        await decoder.flush();
        decoder.close();
        decoder = null;
        if (decoderError) throw decoderError;
        await encoder.flush();
        encoder.close();
        encoder = null;
        if (!packets.length) throw new Error('The local watermark encoder produced no frames.');

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new EncodedVideoPacketSource(videoCodec);
        const encodedVideoMetadata = packets[0].metadata?.decoderConfig || decoderConfig;
        output.addVideoTrack(videoSource, { frameRate, decoderConfig: encodedVideoMetadata });
        let audioSource = null;
        let audioDecoderConfig = null;
        if (originalAudioTrack && originalAudioSink) {
            const audioCodec = typeof originalAudioTrack.getCodec === 'function' ? await originalAudioTrack.getCodec() : originalAudioTrack.codec;
            audioDecoderConfig = await originalAudioTrack.getDecoderConfig();
            if (audioCodec && audioDecoderConfig) {
                audioSource = new EncodedAudioPacketSource(audioCodec);
                output.addAudioTrack(audioSource, { decoderConfig: audioDecoderConfig });
            }
        }

        await output.start();
        for (let index = 0; index < packets.length; index += 1) {
            const item = packets[index];
            await videoSource.add(item.packet, index === 0 ? { decoderConfig: encodedVideoMetadata } : undefined);
        }
        videoSource.close();
        if (audioSource && originalAudioSink) {
            let isFirstAudioPacket = true;
            let audioTimestampOffset = null;
            for await (const packet of originalAudioSink.packets()) {
                if (audioTimestampOffset === null) audioTimestampOffset = Math.max(0, -packet.timestamp);
                const shiftedPacket = audioTimestampOffset ? packet.clone({ timestamp: packet.timestamp + audioTimestampOffset }) : packet;
                await audioSource.add(shiftedPacket, isFirstAudioPacket ? { decoderConfig: audioDecoderConfig } : undefined);
                isFirstAudioPacket = false;
            }
            audioSource.close();
        }
        await output.finalize();
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('The local watermarked MP4 could not be created.');
        send('complete', { data });
    } catch (error) {
        encoder?.close();
        decoder?.close();
        send('error', { message: error instanceof Error ? error.message : String(error) });
    } finally {
        input?.dispose();
        watermarkBitmap?.close();
    }
});
