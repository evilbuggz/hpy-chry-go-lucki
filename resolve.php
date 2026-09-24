<?php
declare(strict_types=1);

const VIDEO_KEY = '6a0f3e5a30bab';
const VIDEO_PAGE = 'https://www.pornhub.com/view_video.php?viewkey=' . VIDEO_KEY;

function jsonResponse(mixed $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function fetchWithSession(CurlHandle $curl, string $url, string $referer): string
{
    curl_setopt_array($curl, [
        CURLOPT_URL => $url,
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
        ],
        CURLOPT_REFERER => $referer,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_ENCODING => '',
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
    ]);

    $body = curl_exec($curl);
    if ($body === false) {
        throw new RuntimeException(curl_error($curl));
    }

    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    if ($status >= 400) {
        throw new RuntimeException("Remote request returned HTTP {$status}.");
    }

    return $body;
}

function resolveMedia(): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL is not enabled.');
    }

    $curl = curl_init();
    curl_setopt($curl, CURLOPT_COOKIEFILE, '');

    try {
        $page = fetchWithSession($curl, VIDEO_PAGE, 'https://www.pornhub.com/');
        $pattern = '~var\s+CLIPS_DATA\s*=\s*(\{.*?\});\s*</script>~s';
        if (!preg_match($pattern, $page, $matches)) {
            if (stripos($page, 'requiring us to verify your age') !== false) {
                throw new RuntimeException('The remote site returned an age-verification page instead of the video page.');
            }
            throw new RuntimeException('CLIPS_DATA was not found in the fresh video page.');
        }

        $clipsData = json_decode($matches[1], true, 512, JSON_THROW_ON_ERROR);
        $definitions = $clipsData['mediaDefinition'] ?? [];
        $mp4Definition = null;
        foreach ($definitions as $definition) {
            if (($definition['format'] ?? '') === 'mp4' && !empty($definition['videoUrl'])) {
                $mp4Definition = $definition;
                break;
            }
        }

        if (!$mp4Definition) {
            throw new RuntimeException('The fresh page did not contain an MP4 source.');
        }

        $mediaResponse = fetchWithSession($curl, $mp4Definition['videoUrl'], VIDEO_PAGE);
        $resolved = json_decode($mediaResponse, true);
        if (!is_array($resolved) || $resolved === []) {
            throw new RuntimeException('The media resolver returned no MP4 sources.');
        }

        $sources = [];
        $collect = function (mixed $value) use (&$collect, &$sources): void {
            if (!is_array($value)) {
                return;
            }
            $url = $value['videoUrl'] ?? $value['url'] ?? $value['src'] ?? null;
            if (is_string($url) && preg_match('~^https://~', $url)) {
                $sources[] = [
                    'quality' => (string)($value['quality'] ?? $value['height'] ?? ''),
                    'format' => (string)($value['format'] ?? 'mp4'),
                    'videoUrl' => $url,
                ];
            }
            foreach ($value as $child) {
                $collect($child);
            }
        };
        $collect($resolved);

        $unique = [];
        foreach ($sources as $source) {
            $unique[$source['videoUrl']] = $source;
        }
        return array_values($unique);
    } finally {
        curl_close($curl);
    }
}

if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    try {
        $sources = resolveMedia();
        foreach ($sources as $index => &$source) {
            $source['downloadUrl'] = 'download.php?source=' . rawurlencode((string)$index);
        }
        unset($source);
        jsonResponse(['sources' => $sources]);
    } catch (Throwable $error) {
        jsonResponse(['error' => $error->getMessage()], 502);
    }
}
