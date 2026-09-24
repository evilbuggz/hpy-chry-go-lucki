<?php
declare(strict_types=1);

require_once __DIR__ . '/resolve.php';

$sourceIndex = filter_input(INPUT_GET, 'source', FILTER_VALIDATE_INT);
if ($sourceIndex === false || $sourceIndex === null || $sourceIndex < 0) {
    http_response_code(400);
    exit('Invalid source.');
}

try {
    $sources = resolveMedia();
    $source = $sources[$sourceIndex] ?? null;
    if (!$source || ($source['format'] ?? '') !== 'mp4') {
        throw new RuntimeException('The requested MP4 source is unavailable.');
    }

    $curl = curl_init($source['videoUrl']);
    curl_setopt_array($curl, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HEADER => false,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_TIMEOUT => 0,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
        CURLOPT_REFERER => VIDEO_PAGE,
        CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk): int {
            echo $chunk;
            flush();
            return strlen($chunk);
        },
    ]);

    header('Content-Type: video/mp4');
    header('Content-Disposition: attachment; filename="video-' . preg_replace('/[^0-9A-Za-z_-]/', '', $source['quality']) . 'p.mp4"');
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
