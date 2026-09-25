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

const INTRO_DURATION = 2;
const INTRO_FPS = 30;

function send(type, payload = {}) {
    self.postMessage({ type, ...payload }, payload.data ? [payload.data] : []);
}

function getTrackSize(track) {
    return Promise.all([
        typeof track.getDisplayWidth === 'function' ? track.getDisplayWidth() : track.displayWidth,
        typeof track.getDisplayHeight === 'function' ? track.getDisplayHeight() : track.displayHeight,
    ]);
}

function introScale(time) {
    if (time < 0.45) return 0.72 + (time / 0.45) * 0.43;
    if (time < 0.8) return 1.15 - ((time - 0.45) / 0.35) * 0.15;
    return 1 + Math.sin((time - 0.8) * Math.PI * 4) * 0.035;
}

function introOpacity(time) {
    return time < 1.35 ? 1 : Math.max(0, 1 - ((time - 1.35) / 0.65));
}

self.addEventListener('message', async (event) => {
    const { video, watermark, watermarkBackground } = event.data;
    let input;
    let watermarkBitmap;
    let backgroundBitmap;
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
        const [width, height] = await getTrackSize(videoTrack);
        const codedWidth = typeof videoTrack.getCodedWidth === 'function' ? await videoTrack.getCodedWidth() : videoTrack.codedWidth || width;
        const codedHeight = typeof videoTrack.getCodedHeight === 'function' ? await videoTrack.getCodedHeight() : videoTrack.codedHeight || height;
        const codecConfig = await videoTrack.getDecoderConfig();
        if (!codecConfig || !String(codecConfig.codec).startsWith('avc')) {
            throw new Error('This video format cannot receive a fast intro without re-encoding the full video.');
        }

        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
        if (!context) throw new Error('The browser could not create the intro canvas.');
        const encodedIntro = [];
        const introEncoder = new VideoEncoder({
            output: (chunk, metadata) => encodedIntro.push({ packet: EncodedPacket.fromEncodedChunk(chunk), metadata }),
            error: (error) => { throw error; },
        });
        const encoderConfig = {
            ...codecConfig,
            width: codedWidth,
            height: codedHeight,
            bitrate: Math.max(500_000, Math.round(width * height * 0.08 * INTRO_FPS / 8)),
            framerate: INTRO_FPS,
            hardwareAcceleration: 'prefer-hardware',
        };
        const support = await VideoEncoder.isConfigSupported(encoderConfig);
        if (!support.supported) throw new Error('This browser cannot encode the one-second intro with hardware acceleration.');
        introEncoder.configure(support.config);

        for (let index = 0; index < INTRO_FPS; index += 1) {
            const time = index / INTRO_FPS;
            const opacity = introOpacity(time);
            const scale = introScale(time);
            context.clearRect(0, 0, width, height);
            context.globalAlpha = opacity;
            context.drawImage(backgroundBitmap, 0, 0, width, height);
            const logoWidth = Math.round(width * 0.18 * scale);
            const logoHeight = Math.round(watermarkBitmap.height * logoWidth / watermarkBitmap.width);
            context.drawImage(
                watermarkBitmap,
                (width - logoWidth) / 2,
                (height - logoHeight) / 2,
                logoWidth,
                logoHeight,
            );
            const frame = new VideoFrame(canvas, {
                timestamp: index * 1_000_000 / INTRO_FPS,
                duration: 1_000_000 / INTRO_FPS,
            });
            introEncoder.encode(frame, { keyFrame: index === 0 });
            frame.close();
        }
        await introEncoder.flush();
        introEncoder.close();
        if (!encodedIntro.length) throw new Error('The intro encoder produced no frames.');

        const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
        const videoSource = new EncodedVideoPacketSource('avc');
        output.addVideoTrack(videoSource, { frameRate: INTRO_FPS });
        const audioTrack = await input.getPrimaryAudioTrack();
        const audioSource = audioTrack
            ? new EncodedAudioPacketSource(typeof audioTrack.getCodec === 'function' ? await audioTrack.getCodec() : audioTrack.codec)
            : null;
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();

        send('status', { message: 'Adding intro before the original video...' });
        const firstVideoPacket = encodedIntro[0];
        await videoSource.add(firstVideoPacket.packet, { decoderConfig: codecConfig });
        for (const item of encodedIntro.slice(1)) await videoSource.add(item.packet, item.metadata);

        const sourceVideoPackets = new EncodedPacketSink(videoTrack).packets();
        const firstSourceVideo = await sourceVideoPackets.next();
        if (firstSourceVideo.done) throw new Error('The original video contains no packets.');
        const sourceVideoOffset = INTRO_DURATION - firstSourceVideo.value.timestamp;
        const sourceAudioPackets = audioTrack ? new EncodedPacketSink(audioTrack).packets() : null;
        const decoderConfig = audioTrack ? await audioTrack.getDecoderConfig() : null;
        const firstAudio = sourceAudioPackets ? await sourceAudioPackets.next() : null;
        const audioOffset = firstAudio && !firstAudio.done ? INTRO_DURATION - firstAudio.value.timestamp : 0;

        const sourceDuration = typeof videoTrack.computeDuration === 'function'
            ? await videoTrack.computeDuration()
            : 1;
        const copyVideo = async function* () {
            yield firstSourceVideo.value;
            for await (const packet of sourceVideoPackets) yield packet;
        };
        for await (const packet of copyVideo()) {
            await videoSource.add(packet.clone({ timestamp: packet.timestamp + sourceVideoOffset }));
            send('progress', { value: Math.min(0.99, Math.max(0, (packet.timestamp / sourceDuration) * 0.98)) });
        }
        videoSource.close();

        if (audioSource && firstAudio && !firstAudio.done) {
            await audioSource.add(firstAudio.value.clone({ timestamp: firstAudio.value.timestamp + audioOffset }), { decoderConfig });
            for await (const packet of sourceAudioPackets) await audioSource.add(packet.clone({ timestamp: packet.timestamp + audioOffset }));
            audioSource.close();
        }
        await output.finalize();
        const data = output.target.buffer;
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('The intro MP4 could not be created.');
        send('progress', { value: 1 });
        send('complete', { data });
    } catch (error) {
        input?.dispose();
        send('error', { message: error instanceof Error ? error.message : String(error) });
    } finally {
        watermarkBitmap?.close();
        backgroundBitmap?.close();
    }
});
