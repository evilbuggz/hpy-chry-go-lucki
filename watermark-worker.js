import {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Input,
    Mp4OutputFormat,
    Output,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.25.0/+esm';

function send(type, payload = {}) {
    self.postMessage({ type, ...payload }, payload.data ? [payload.data] : []);
}

self.addEventListener('message', async (event) => {
    const { video, watermark } = event.data;
    let input;
    try {
        if (!(video instanceof ArrayBuffer) || !(watermark instanceof ArrayBuffer)) {
            throw new Error('The browser did not provide a valid video to process.');
        }
        if (typeof VideoDecoder !== 'function' || typeof VideoEncoder !== 'function' || typeof OffscreenCanvas !== 'function') {
            throw new Error('This browser does not provide hardware video processing.');
        }

        send('status', { message: 'Preparing hardware video processing...' });
        const watermarkBitmap = await createImageBitmap(new Blob([watermark], { type: 'image/png' }));
        const source = new BlobSource(new Blob([video], { type: 'video/mp4' }));
        input = new Input({ source, formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error('The downloaded file does not contain a video track.');
        const width = typeof track.getDisplayWidth === 'function' ? await track.getDisplayWidth() : track.displayWidth;
        const height = typeof track.getDisplayHeight === 'function' ? await track.getDisplayHeight() : track.displayHeight;
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('The browser could not create a video processing canvas.');

        const output = new Output({
            format: new Mp4OutputFormat(),
            target: new BufferTarget(),
        });
        const audioTrack = await input.getPrimaryAudioTrack();
        const audioSource = audioTrack
            ? new EncodedAudioPacketSource(typeof audioTrack.getCodec === 'function' ? await audioTrack.getCodec() : audioTrack.codec)
            : null;
        const conversion = await Conversion.init({
            input,
            output,
            tracks: 'primary',
            composable: Boolean(audioSource),
            video: {
                codec: 'avc',
                bitrate: Math.max(500_000, Math.round(width * height * 0.08 * 30 / 8)),
                forceTranscode: true,
                hardwareAcceleration: 'prefer-hardware',
                processedWidth: width,
                processedHeight: height,
                process(sample) {
                    context.clearRect(0, 0, width, height);
                    sample.draw(context, 0, 0, width, height);
                    const watermarkWidth = Math.max(1, Math.round(width * 0.18));
                    const watermarkHeight = Math.max(1, Math.round(watermarkBitmap.height * watermarkWidth / watermarkBitmap.width));
                    context.drawImage(
                        watermarkBitmap,
                        width - watermarkWidth - 18,
                        height - watermarkHeight - 18,
                        watermarkWidth,
                        watermarkHeight,
                    );
                    return canvas;
                },
            },
            audio: { discard: Boolean(audioSource) },
        });
        if (!conversion.isValid) {
            throw new Error('This browser cannot encode the selected video and preserve its audio.');
        }
        conversion.onProgress = (progress) => send('progress', { value: Math.max(0, Math.min(1, progress)) });
        send('status', { message: 'Watermarking locally with hardware acceleration...' });
        if (audioSource && audioTrack) {
            output.addAudioTrack(audioSource);
            await output.start();
            const audioSink = new EncodedPacketSink(audioTrack);
            const decoderConfig = await audioTrack.getDecoderConfig();
            const audioPackets = audioSink.packets();
            const firstPacket = await audioPackets.next();
            if (firstPacket.done) throw new Error('The audio track contains no packets.');
            const audioOffset = Math.max(0, -firstPacket.value.timestamp);
            await audioSource.add(audioOffset ? firstPacket.value.clone({ timestamp: firstPacket.value.timestamp + audioOffset }) : firstPacket.value, { decoderConfig });
            await Promise.all([
                conversion.execute(),
                (async () => {
                    for await (const packet of audioPackets) {
                        await audioSource.add(audioOffset ? packet.clone({ timestamp: packet.timestamp + audioOffset }) : packet);
                    }
                    audioSource.close();
                })(),
            ]);
        } else {
            await conversion.execute();
        }
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
            throw new Error('The local encoder did not produce a playable MP4.');
        }
        send('complete', { data });
        watermarkBitmap.close();
        input.dispose();
    } catch (error) {
        input?.dispose();
        send('error', { message: error instanceof Error ? error.message : String(error) });
    }
});
