<?php
declare(strict_types=1);

require_once __DIR__ . '/resolve.php';

set_time_limit(0);
ignore_user_abort(true);

$requestedQuality = (string)($_GET['quality'] ?? '');

try {
    $input = $_GET['url'] ?? $_GET['viewkey'] ?? null;
    $session = null;
    $sources = resolveMedia($input, $session);
    $source = $sources[0] ?? null;
    foreach ($sources as $candidate) {
        if ((string)$candidate['quality'] === $requestedQuality) {
            $source = $candidate;
            break;
        }
    }
    if (!$source || ($source['format'] ?? '') !== 'mp4') {
        throw new RuntimeException('The requested MP4 source is unavailable.');
    }

    $inputValue = trim((string)($input ?? ''));
    $viewkey = $inputValue;
    if (filter_var($inputValue, FILTER_VALIDATE_URL)) {
        $parsedInput = parse_url($inputValue);
        parse_str((string)($parsedInput['query'] ?? ''), $inputQuery);
        $viewkey = (string)($inputQuery['viewkey'] ?? basename((string)($parsedInput['path'] ?? '')));
    }
    $viewkey = preg_replace('/[^0-9A-Za-z_-]/', '', $viewkey) ?: 'video';
    $quality = preg_replace('/[^0-9A-Za-z_-]/', '', (string)$source['quality']) ?: 'source';

    $temporaryDirectory = sys_get_temp_dir();
    $errorPath = tempnam($temporaryDirectory, 'peachy-ffmpeg-');
    $inputPath = tempnam($temporaryDirectory, 'peachy-input-');
    $outputPath = tempnam($temporaryDirectory, 'peachy-output-');
    $watermarkPath = __DIR__ . '/img/watermark.png';
    if ($errorPath === false || $inputPath === false || $outputPath === false || !is_file($watermarkPath)) {
        throw new RuntimeException('The video processing files could not be prepared.');
    }
    unlink($outputPath);
    $outputPath .= '.mp4';

    register_shutdown_function(static function () use ($errorPath, $inputPath, $outputPath): void {
        @unlink($errorPath);
        @unlink($inputPath);
        @unlink($outputPath);
    });

    $videoFile = fopen($inputPath, 'wb');
    if ($videoFile === false) {
        throw new RuntimeException('The temporary video file could not be opened.');
    }
    $curl = $session ?? curl_init($source['videoUrl']);
    curl_setopt_array($curl, [
        CURLOPT_URL => $source['videoUrl'],
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HEADER => false,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
        CURLOPT_REFERER => 'https://www.pornhub.com/',
        CURLOPT_FILE => $videoFile,
    ]);
    if (curl_exec($curl) === false) {
        fclose($videoFile);
        throw new RuntimeException(curl_error($curl));
    }
    fclose($videoFile);
    $httpStatus = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if ($httpStatus >= 400 || filesize($inputPath) === 0) {
        throw new RuntimeException("The video server returned HTTP {$httpStatus}.");
    }

    $ffmpegCommand = implode(' ', [
        'ffmpeg',
        '-hide_banner',
        '-loglevel', 'error',
        '-threads', '0',
        '-filter_threads', '2',
        '-filter_complex_threads', '2',
        '-y',
        '-i', escapeshellarg($inputPath),
        '-i', escapeshellarg($watermarkPath),
            '-filter_complex', escapeshellarg('[0:v]scale=min(1280\,iw):-2[video];[1:v]scale=iw*0.15:-1[watermark];[video][watermark]overlay=W-w-18:18:format=auto[outv]'),
            '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-x264-params', 'rc-lookahead=0:ref=1:bframes=0:threads=0',
        '-crf', '30',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        escapeshellarg($outputPath),
    ]);

    $ffmpegOutput = [];
    $exitCode = 0;
    exec($ffmpegCommand . ' 2>&1', $ffmpegOutput, $exitCode);
    if ($exitCode !== 0 || !is_file($outputPath) || filesize($outputPath) === 0) {
        $details = trim(implode(PHP_EOL, $ffmpegOutput));
        $fileState = is_file($outputPath) ? (string)filesize($outputPath) : 'missing';
        throw new RuntimeException("The video could not be watermarked (ffmpeg exit {$exitCode}, output {$fileState})." . ($details ? ' ' . $details : ''));
    }

    header('Content-Type: video/mp4');
    header('Content-Length: ' . filesize($outputPath));
    header('Content-Disposition: attachment; filename="' . $quality . 'ph-' . $viewkey . '.mp4"');
    header('Cache-Control: no-store');
    readfile($outputPath);
} catch (Throwable $error) {
    if (!headers_sent()) {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
    }
    echo 'Download failed: ' . $error->getMessage();
}
