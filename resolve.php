<?php
declare(strict_types=1);

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

function videoPageUrl(?string $input): string
{
    $input = trim((string)$input);
    $candidate = str_contains($input, '://')
        ? $input
        : 'https://www.pornhub.com/view_video.php?viewkey=' . rawurlencode($input);
    $url = filter_var($candidate, FILTER_VALIDATE_URL);
    $parts = $url ? parse_url($url) : false;
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if (!$url || ($parts['scheme'] ?? '') !== 'https' || !($host === 'pornhub.com' || str_ends_with($host, '.pornhub.com'))) {
        throw new RuntimeException('Enter a valid Pornhub video URL or viewkey.');
    }
    if (!str_contains($path, 'view_video.php') && !str_starts_with($path, '/embed/')) {
        throw new RuntimeException('The URL must point to a Pornhub video page or embed.');
    }
    return $url;
}

function playerData(string $page, string $source): array
{
    if (preg_match('~var\s+CLIPS_DATA\s*=\s*(\{.*?\});\s*</script>~s', $page, $matches)) {
        return json_decode($matches[1], true, 512, JSON_THROW_ON_ERROR);
    }
    if (preg_match('~var\s+flashvars_[^=]+\s*=\s*(\{.*?\});\s*var\s+player_mp4_seek~s', $page, $matches)) {
        $flashvars = json_decode($matches[1], true, 512, JSON_THROW_ON_ERROR);
        return ['mediaDefinition' => $flashvars['mediaDefinitions'] ?? []];
    }
    $title = preg_match('~<title[^>]*>([^<]*)</title>~i', $page, $titleMatch) ? trim($titleMatch[1]) : 'unknown';
    throw new RuntimeException("No player media data was found in {$source} (upstream title: {$title}).");
}

function resolveMedia(?string $input = null, ?CurlHandle &$session = null): array
{
    if (!function_exists('curl_init')) {
        throw new RuntimeException('PHP cURL is not enabled.');
    }

    $videoPage = videoPageUrl($input);
    $parts = parse_url($videoPage);
    parse_str((string)($parts['query'] ?? ''), $query);
    $viewkey = $query['viewkey'] ?? basename((string)($parts['path'] ?? ''));
    $candidates = [$videoPage];
    if ($viewkey && !str_starts_with((string)$parts['path'], '/embed/')) {
        $candidates[] = 'https://www.pornhub.com/embed/' . rawurlencode((string)$viewkey);
    }

    $curl = curl_init();
    curl_setopt($curl, CURLOPT_COOKIEFILE, '');

    $keepSession = false;
    $sessionRequested = func_num_args() >= 2;
    try {
        $clipsData = null;
        $pageErrors = [];
        foreach ($candidates as $candidate) {
            try {
                $clipsData = playerData(fetchWithSession($curl, $candidate, 'https://www.pornhub.com/'), $candidate);
                break;
            } catch (Throwable $error) {
                $pageErrors[] = $error->getMessage();
            }
        }
        if ($clipsData === null) {
            throw new RuntimeException(implode(' ', $pageErrors));
        }
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

        $mediaResponse = fetchWithSession($curl, $mp4Definition['videoUrl'], $videoPage);
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
        if ($sessionRequested) {
            $session = $curl;
            $keepSession = true;
        }
        return array_values($unique);
    } finally {
        if (!$keepSession) {
            curl_close($curl);
        }
    }
}

if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    try {
        $input = $_GET['url'] ?? $_GET['viewkey'] ?? null;
        $sources = resolveMedia($input);
        foreach ($sources as $index => &$source) {
            $source['downloadUrl'] = 'download.php?url=' . rawurlencode((string)$input) . '&quality=' . rawurlencode((string)$source['quality']);
        }
        unset($source);
        jsonResponse(['sources' => $sources]);
    } catch (Throwable $error) {
        jsonResponse(['error' => $error->getMessage()], 502);
    }
}
