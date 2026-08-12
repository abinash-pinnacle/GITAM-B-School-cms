<?php
/**
 * Router for PHP's built-in web server:
 *
 *   php -S localhost:5500 router.php
 *
 * Sends /api/* to the PHP backend and serves the static frontend for
 * everything else. Apache/Nginx setups don't need this file — see api/.htaccess.
 */
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

if (preg_match('#^/api(/|$)#', $path)) {
    require __DIR__ . '/api/index.php';
    return true;
}

if ($path === '/' || $path === '') {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    readfile(__DIR__ . '/index.html');
    return true;
}

// let the built-in server serve real files (it sets the right MIME type)
$file = realpath(__DIR__ . rawurldecode($path));
if ($file !== false && is_file($file) && str_starts_with($file, realpath(__DIR__))) {
    return false;
}

http_response_code(404);
header('Content-Type: application/json');
echo json_encode(['error' => 'not found']);
return true;
