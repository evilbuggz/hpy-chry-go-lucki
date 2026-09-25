<?php
declare(strict_types=1);

require_once __DIR__ . '/resolve.php';

set_time_limit(0);
ignore_user_abort(true);

function commandPath(string $environmentVariable, string $fallback): string
{
    $configured = getenv($environmentVariable);
    if (is_string($configured) && $configured !== '') {
        return $configured;
    }
    return $fallback;
}

function runWatermarkEncode(string $inputPath, string $outputPath): void
{
    $ffprobe = commandPath('FFPROBE_PATH', PHP_OS_FAMILY === 'Windows' ? 'C:\\ProgramData\\chocolatey\\bin\\ffprobe.exe' : '/usr/bin/ffprobe');
    $ffmpeg = commandPath('FFMPEG_PATH', PHP_OS_FAMILY === 'Windows' ? 'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe' : '/usr/bin/ffmpeg');
    $probeCommand = escapeshellarg($ffprobe) . ' -v error -select_streams v:0 -show_entries stream=pix_fmt -of json ' . escapeshellarg($inputPath);
    $probeJson = shell_exec($probeCommand);
    $probe = is_string($probeJson) ? json_decode($probeJson, true) : null;
    $pixelFormat = (string)($probe['streams'][0]['pix_fmt'] ?? 'yuv420p');
    $allowedPixelFormats = ['yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le'];
    if (!in_array($pixelFormat, $allowedPixelFormats, true)) {
        $pixelFormat = 'yuv420p';
    }

    $encoder = getenv('PEACHY_VIDEO_ENCODER') ?: 'libx264';
    $encoderOptions = match ($encoder) {
        'h264_nvenc' => '-c:v h264_nvenc -preset p1 -rc:v vbr -cq:v 28 -b:v 0',
        'h264_qsv' => '-c:v h264_qsv -preset veryfast -global_quality 25',
        default => '-c:v libx264 -preset ultrafast -tune zerolatency -crf 23',
    };

    $watermarkPath = __DIR__ . '/img/watermark.png';
    $logPath = $outputPath . '.log';
    $command = implode(' ', [
        escapeshellarg($ffmpeg),
        '-hide_banner -loglevel error -y',
        '-i', escapeshellarg($inputPath),
        '-i', escapeshellarg($watermarkPath),
        '-filter_complex', escapeshellarg('[1:v]scale=iw*0.18:-1[watermark];[0:v][watermark]overlay=main_w-overlay_w-24:24:format=auto[video]'),
        '-map', escapeshellarg('[video]'),
        '-map 0:a?',
        $encoderOptions . ' -pix_fmt ' . escapeshellarg($pixelFormat),
        '-c:a copy -movflags +faststart -threads 0',
        escapeshellarg($outputPath),
        '>', escapeshellarg($logPath), '2>&1',
    ]);
    exec($command, $ignoredOutput, $exitCode);
    if ($exitCode !== 0 || !is_file($outputPath) || filesize($outputPath) === 0) {
        $details = is_file($logPath) ? trim((string)file_get_contents($logPath)) : '';
        @unlink($logPath);
        throw new RuntimeException('FFmpeg watermarking failed.' . ($details ? ' ' . $details : ''));
    }
    @unlink($logPath);
}

function sendWatermarkedVideo(string $sourceUrl, string $filename, string $cacheKey, ?CurlHandle $session): never
{
    $cacheDirectory = __DIR__ . '/files/watermarked';
    if (!is_dir($cacheDirectory) && !mkdir($cacheDirectory, 0775, true) && !is_dir($cacheDirectory)) {
        throw new RuntimeException('The watermark cache directory could not be created.');
    }
    $cachedPath = $cacheDirectory . '/' . $cacheKey . '.mp4';
    $lockPath = $cachedPath . '.lock';
    $lockHandle = fopen($lockPath, 'c');
    if ($lockHandle === false) {
        throw new RuntimeException('The watermark cache lock could not be created.');
    }
    flock($lockHandle, LOCK_EX);
    try {
        if (!is_file($cachedPath) || filesize($cachedPath) === 0) {
            $inputPath = tempnam(sys_get_temp_dir(), 'peachy-source-');
            $workingPath = $cachedPath . '.tmp';
            if ($inputPath === false) {
                throw new RuntimeException('A temporary download file could not be created.');
            }
            try {
                $curl = $session ?? curl_init($sourceUrl);
                $inputHandle = fopen($inputPath, 'wb');
                if ($inputHandle === false) {
                    throw new RuntimeException('The temporary download file could not be opened.');
                }
                curl_setopt_array($curl, [
                    CURLOPT_URL => $sourceUrl,
                    CURLOPT_FOLLOWLOCATION => true,
                    CURLOPT_HEADER => false,
                    CURLOPT_RETURNTRANSFER => false,
                    CURLOPT_FILE => $inputHandle,
                    CURLOPT_TIMEOUT => 0,
                    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
                    CURLOPT_REFERER => 'https://www.pornhub.com/',
                ]);
                if (curl_exec($curl) === false) {
                    fclose($inputHandle);
                    throw new RuntimeException(curl_error($curl));
                }
                fclose($inputHandle);
                curl_close($curl);
                runWatermarkEncode($inputPath, $workingPath);
                if (!rename($workingPath, $cachedPath)) {
                    throw new RuntimeException('The watermarked video could not be cached.');
                }
            } finally {
                @unlink($inputPath);
                @unlink($workingPath);
            }
        }
    } finally {
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
        @unlink($lockPath);
    }

    sendCachedVideo($cachedPath, $filename);
}

function sendCachedVideo(string $cachedPath, string $filename): never
{
    header('Content-Type: video/mp4');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Cache-Control: no-store');
    header('X-Peachy-Processing: server-side-ffmpeg-cache');
    readfile($cachedPath);
    exit;
}

try {
    $input = $_GET['url'] ?? $_GET['viewkey'] ?? null;
    $requestedQuality = (string)($_GET['quality'] ?? '');
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

    if (filter_var($_GET['watermark'] ?? false, FILTER_VALIDATE_BOOLEAN)) {
        $cacheKey = hash('sha256', (string)$source['videoUrl'] . '|' . $quality . '|' . (string)@filemtime(__DIR__ . '/img/watermark.png'));
        sendWatermarkedVideo($source['videoUrl'], $quality . 'ph-' . $viewkey . '-watermarked.mp4', $cacheKey, $session);
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
        CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk): int {
            echo $chunk;
            flush();
            return strlen($chunk);
        },
    ]);

    header('Content-Type: video/mp4');
    header('Content-Disposition: attachment; filename="' . $quality . 'ph-' . $viewkey . '.mp4"');
    header('Cache-Control: no-store');
    header('X-Peachy-Processing: client-side-only');
    if (curl_exec($curl) === false) {
        throw new RuntimeException(curl_error($curl));
    }
    curl_close($curl);
} catch (Throwable $error) {
    if (!headers_sent()) {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
    }
    echo 'Download failed: ' . $error->getMessage();
}
