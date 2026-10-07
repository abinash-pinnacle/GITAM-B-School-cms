<?php
/**
 * Copy the whole database between backends (SQLite <-> MySQL <-> PostgreSQL).
 *
 *   php tools/db-transfer.php export dump.json     # read from the configured DB
 *   php tools/db-transfer.php import dump.json     # write into the configured DB
 *
 * Which database is used comes from the same env vars as the API
 * (DB_BACKEND / GITAM_DB / DB_HOST / DB_USER / ...), so an export and an
 * import are just two runs with different environments:
 *
 *   php tools/db-transfer.php export dump.json
 *   DB_BACKEND=mysql DB_HOST=127.0.0.1 DB_USER=root DB_PASS=secret \
 *     php tools/db-transfer.php import dump.json
 *
 * Import replaces rows with the same id and keeps everything else, so it is
 * safe to run twice.
 */
require_once __DIR__ . '/../api/db.php';

$mode = $argv[1] ?? '';
$file = $argv[2] ?? '';

if (!in_array($mode, ['export', 'import'], true) || $file === '') {
    fwrite(STDERR, "usage: php tools/db-transfer.php export|import <file.json>\n");
    exit(1);
}

$cfg = db_config();
$where = $cfg['driver'] === 'sqlite' ? $cfg['path'] : "{$cfg['driver']}://{$cfg['host']}:{$cfg['port']}/{$cfg['name']}";

if ($mode === 'export') {
    $dump = [];
    foreach (COLLECTIONS as $col => $fields) {
        $rows = table_exists($col) ? fetch_all('SELECT * FROM ' . qi($col)) : [];
        // keep only known columns so the dump stays portable
        $dump[$col] = array_map(
            fn($r) => array_intersect_key($r, array_flip($fields)),
            $rows
        );
        echo str_pad($col, 12), count($dump[$col]), " rows\n";
    }
    file_put_contents($file, json_encode($dump, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    echo "Exported from $where -> $file\n";
    exit(0);
}

$raw = file_get_contents($file);
if ($raw === false) {
    fwrite(STDERR, "Cannot read $file\n");
    exit(1);
}
$dump = json_decode($raw, true);
if (!is_array($dump)) {
    fwrite(STDERR, "$file is not valid JSON\n");
    exit(1);
}

ensure_schema();
$total = 0;
foreach ($dump as $col => $rows) {
    if (!isset(COLLECTIONS[$col]) || !is_array($rows)) {
        echo "skipped unknown collection '$col'\n";
        continue;
    }
    foreach ($rows as $row) {
        if (empty($row['id'])) {
            continue;
        }
        upsert($col, $row);
        $total++;
    }
    echo str_pad($col, 12), count($rows), " rows\n";
}
echo "Imported $total rows from $file -> $where\n";
