<?php
/**
 * NMIET College Management System — REST API (PHP).
 *
 * Routes
 *   GET    /api/health              -> { ok: true }
 *   GET    /api/bootstrap           -> every collection in one payload
 *   GET    /api/{collection}        -> rows of one collection
 *   POST   /api/login               -> { username, password, role } -> user row
 *   POST   /api/{collection}        -> create/replace a row (id generated if absent)
 *   PUT    /api/{collection}/{id}   -> patch the given fields
 *   DELETE /api/{collection}/{id}   -> remove a row
 *
 * Public admission form (/api/apply) refuses a second entry from a mobile number
 * or email already Pending or Approved — one applicant, one form. Signing out and
 * changing one's own password are self-service — never blocked by a role guard.
 */

/* A warning belongs in the log and nowhere else.
   Nothing here ever said so, which left it to whatever the host's php.ini
   happened to say — and shared hosting usually says display_errors is on. One
   notice from any line of this file then prints itself above the payload, and
   what reaches the browser is not JSON any more. The session signs in and can
   read nothing, which is what has been happening, and the notice helpfully
   names the server's directories on the way past.
   Everything is still reported; it goes to the error log. */
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('html_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

/* And a second line of defence for anything that prints regardless — a stray
   echo, a byte-order mark ahead of an opening tag, a warning from a module
   that ignores the setting above. It is collected here and thrown away by
   send_json, so the body is the payload and nothing else. */
ob_start();

/* A fatal is the one failure the try/catch at the bottom of this file cannot
   see: PHP stops where it stands, and with warnings no longer being printed
   the browser is handed an empty body and reports that it could not reach a
   server that answered perfectly well. So the last thing this process does is
   check whether it died owing somebody a reply, and send one. */
register_shutdown_function(static function (): void {
    $e = error_get_last();
    if ($e === null || !in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        return;
    }
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    error_log('[nmiet-api] fatal: ' . $e['message'] . ' at ' . $e['file'] . ':' . $e['line']);
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    // the file and the line stay in the log; what goes out names neither
    echo json_encode(['error' => 'server error',
                      'message' => 'Server error — please try again.']);
});

require_once __DIR__ . '/db.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function send_json($data, int $status = 200): void
{
    /* Whatever else was printed is dropped, and noted where it can be read
       without breaking anything. */
    $stray = '';
    while (ob_get_level() > 0) {
        $stray .= (string) ob_get_clean();
    }
    if (trim($stray) !== '') {
        error_log('[nmiet-api] discarded stray output: ' . substr(trim($stray), 0, 500));
    }
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/* ---------------- passwords ----------------
   Stored as a bcrypt hash. A row still holding plain text is accepted once —
   the login that uses it rewrites it — so nothing had to be migrated and no
   account was locked out by the change. */

/** true when the stored value is a hash rather than somebody's password */
function is_password_hash(string $stored): bool
{
    return $stored !== '' && (bool) preg_match('/^\$(2[aby]|argon2)/', $stored);
}

/** turn a password into what gets stored */
function hash_password(string $plain): string
{
    return password_hash($plain, PASSWORD_DEFAULT);
}

/**
 * Does this password open this account? A stored hash is verified; a stored
 * plaintext is compared in constant time, so a wrong guess takes as long as a
 * right one either way.
 */
function password_matches(string $given, string $stored): bool
{
    if ($stored === '') {
        return false;
    }
    return is_password_hash($stored)
        ? password_verify($given, $stored)
        : hash_equals($stored, $given);
}

/**
 * A row on its way into `users`, with any password it carries hashed. Applied
 * to every write rather than trusting the caller: the caller is a web page.
 * A value that is already a hash is left alone, so a row can be copied without
 * being hashed twice into something nobody can sign in with.
 */
function hash_row_password(string $col, array $row): array
{
    if ($col !== 'users' || !array_key_exists('password', $row)) {
        return $row;
    }
    $pw = (string) $row['password'];
    if ($pw === '' || is_password_hash($pw)) {
        return $row;
    }
    $row['password'] = hash_password($pw);
    return $row;
}

/**
 * One sweep, once: every password still in plain text becomes a hash.
 *
 * Signing in does this too, but "eventually" means a dormant account keeps a
 * readable password for as long as nobody uses it — which is most of the risk,
 * because those are exactly the accounts nobody is watching. Nobody is locked
 * out: the value being hashed is the password its owner already knows.
 *
 * Marked in `_meta` so it is one query on every later request and not a table
 * scan. If a plaintext row somehow appears afterwards the login path still
 * upgrades it, so this is a floor and not the only defence.
 */
function migrate_plaintext_passwords(): void
{
    try {
        $done = fetch_one('SELECT ' . qi('v') . ' AS v FROM ' . qi('_meta') . " WHERE " . qi('k') . " = 'pwhash'");
        if ($done && ($done['v'] ?? '') === '1') {
            return;
        }
        $rows = fetch_all('SELECT ' . qi('id') . ', ' . qi('password') . ' FROM ' . qi('users'));
    } catch (PDOException $e) {
        return;              // the table is not there yet; init_db() runs first
    }
    $stmt = db()->prepare('UPDATE ' . qi('users') . ' SET ' . qi('password') . ' = ? WHERE ' . qi('id') . ' = ?');
    foreach ($rows as $r) {
        $pw = (string) ($r['password'] ?? '');
        if ($pw === '' || is_password_hash($pw)) {
            continue;
        }
        $stmt->execute([hash_password($pw), $r['id']]);
    }
    meta_set('pwhash', '1');
}

/** rewrite a plaintext row as a hash, the first time its owner signs in */
function upgrade_password(string $id, string $plain): void
{
    db()->prepare('UPDATE ' . qi('users') . ' SET ' . qi('password') . ' = ? WHERE ' . qi('id') . ' = ?')
        ->execute([hash_password($plain), $id]);
}

/**
 * The caller's user row, identified by the X-User-Id header the frontend sends
 * after login, or null when the request is anonymous.
 */
/* ---------------- failed sign-ins ----------------
   Kept in a table of its own, created on demand. Deliberately not a COLLECTIONS
   entry: those become API routes, and the record of who has been failing to
   sign in is not something to serve. */
function attempts_table(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $t = qi('_login_attempts');
    $kType = driver() === 'mysql' ? 'VARCHAR(190)' : 'TEXT';
    $iType = driver() === 'pgsql' ? 'BIGINT' : 'INTEGER';
    db()->exec("CREATE TABLE IF NOT EXISTS $t (" . qi('k') . " $kType PRIMARY KEY, "
        . qi('fails') . " $iType, " . qi('first_at') . " $iType, "
        . qi('locked_until') . " $iType)");
}

/**
 * Who is asking. Behind a CDN the socket address is the CDN's, so the
 * forwarded header is read first — knowing full well it can be set by hand.
 * That is why the username is counted as well: an attacker who forges a new
 * address every request still has to keep attacking the same account.
 */
function client_ip(): string
{
    foreach (FORWARDED_IP_HEADERS as $h) {
        $v = trim((string) ($_SERVER[$h] ?? ''));
        if ($v !== '') {
            $first = trim(explode(',', $v)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
    }
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

const FORWARDED_IP_HEADERS = ['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'];

/**
 * Does the address we have actually name one caller?
 *
 * Only when a proxy told us. Without that header the socket address is
 * whatever sits in front of the application — a CDN, in this deployment — and
 * every visitor in the world shares it. Locking it locks all of them, which is
 * not a theory: seventeen deliberate wrong passwords sent from one machine
 * locked the administrator out of the live site.
 *
 * A college would have managed it without any help. One public address, one
 * Monday morning, twenty people mistyping the password they changed on Friday.
 */
function client_ip_is_one_caller(): bool
{
    foreach (FORWARDED_IP_HEADERS as $h) {
        $v = trim((string) ($_SERVER[$h] ?? ''));
        if ($v !== '' && filter_var(trim(explode(',', $v)[0]), FILTER_VALIDATE_IP)) {
            return true;
        }
    }
    return false;
}

/** how long this key must wait, in seconds — 0 when it may try now */
function login_wait(string $key): int
{
    attempts_table();
    $row = fetch_one('SELECT * FROM ' . qi('_login_attempts') . ' WHERE ' . qi('k') . ' = ?', [$key]);
    if (!$row) {
        return 0;
    }
    $until = (int) ($row['locked_until'] ?? 0);
    return $until > time() ? $until - time() : 0;
}

/** record one wrong password against a key, and lock it once it has had enough */
function login_failed(string $key, int $max): void
{
    attempts_table();
    $now = time();
    $row = fetch_one('SELECT * FROM ' . qi('_login_attempts') . ' WHERE ' . qi('k') . ' = ?', [$key]);
    // a window that has run out starts again from one, so yesterday's typos
    // are not held against anybody
    $fails = ($row && $now - (int) ($row['first_at'] ?? 0) < LOGIN_WINDOW_SECONDS)
        ? (int) ($row['fails'] ?? 0) + 1 : 1;
    $firstAt = $fails === 1 ? $now : (int) ($row['first_at'] ?? $now);
    $lock = $fails >= $max ? $now + LOGIN_LOCK_SECONDS : 0;
    if ($row) {
        run_sql('UPDATE ' . qi('_login_attempts') . ' SET ' . qi('fails') . ' = ?, '
            . qi('first_at') . ' = ?, ' . qi('locked_until') . ' = ? WHERE ' . qi('k') . ' = ?',
            [$fails, $firstAt, $lock, $key]);
    } else {
        run_sql('INSERT INTO ' . qi('_login_attempts') . ' (' . qi('k') . ', ' . qi('fails')
            . ', ' . qi('first_at') . ', ' . qi('locked_until') . ') VALUES (?, ?, ?, ?)',
            [$key, $fails, $firstAt, $lock]);
    }
}

/** getting in clears the slate — for the address and for the account */
function login_succeeded(array $keys): void
{
    attempts_table();
    foreach ($keys as $k) {
        run_sql('DELETE FROM ' . qi('_login_attempts') . ' WHERE ' . qi('k') . ' = ?', [$k]);
    }
    // and sweep what has aged out, so the table cannot grow without end
    run_sql('DELETE FROM ' . qi('_login_attempts') . ' WHERE ' . qi('locked_until') . ' < ? AND '
        . qi('first_at') . ' < ?', [time(), time() - LOGIN_WINDOW_SECONDS]);
}

/* A ceiling on how fast one signed-in account can CHANGE things.
   Deliberately loud about what it is not: it counts writes only, so opening a
   page is never slowed; it is keyed by the account's token, not its address,
   so a whole college behind one address is never one client; and it is a
   short wait, not a lockout. The number is far above what a person clicking
   Save can reach and a bulk import is one request, so ordinary work never sees
   it — it is here for a script hammering the API, not for anybody working. */
const RATE_WRITE_PER_MIN = 300;

function rate_table(): void
{
    static $done = false;
    if ($done) { return; }
    $done = true;
    $t = qi('_rate');
    $kType = driver() === 'mysql' ? 'VARCHAR(190)' : 'TEXT';
    $iType = driver() === 'pgsql' ? 'BIGINT' : 'INTEGER';
    db()->exec("CREATE TABLE IF NOT EXISTS $t (" . qi('k') . " $kType PRIMARY KEY, "
        . qi('cnt') . " $iType, " . qi('win') . " $iType)");
}

/**
 * One write, counted against the caller's token in a one-minute window.
 * Refuses with a wait, never a lock, and only ever meters a mutation — a read
 * does not reach here. Called only for authenticated, non-open writes, so the
 * token is always present by the time it runs.
 */
function rate_check(): void
{
    $token = request_token();
    if ($token === '') { return; }
    rate_table();
    $now = time();
    $row = fetch_one('SELECT * FROM ' . qi('_rate') . ' WHERE ' . qi('k') . ' = ?', [$token]);
    if (!$row || $now - (int) ($row['win'] ?? 0) >= 60) {
        // a fresh window; and sweep what has aged out so the table stays small
        if ($row) {
            run_sql('UPDATE ' . qi('_rate') . ' SET ' . qi('cnt') . ' = 1, ' . qi('win')
                . ' = ? WHERE ' . qi('k') . ' = ?', [$now, $token]);
        } else {
            run_sql('INSERT INTO ' . qi('_rate') . ' (' . qi('k') . ', ' . qi('cnt') . ', '
                . qi('win') . ') VALUES (?, 1, ?)', [$token, $now]);
        }
        run_sql('DELETE FROM ' . qi('_rate') . ' WHERE ' . qi('win') . ' < ?', [$now - 3600]);
        return;
    }
    $cnt = (int) ($row['cnt'] ?? 0) + 1;
    if ($cnt > RATE_WRITE_PER_MIN) {
        $wait = max(1, 60 - ($now - (int) $row['win']));
        send_json([
            'error'      => 'rate-limited',
            'retryAfter' => $wait,
            'message'    => 'Too many changes too quickly. Please wait a few seconds and try again.',
        ], 429);
    }
    run_sql('UPDATE ' . qi('_rate') . ' SET ' . qi('cnt') . ' = ? WHERE ' . qi('k') . ' = ?',
        [$cnt, $token]);
}

/** 32 random bytes, hex — unguessable, and belonging to one account */
function new_token(): string
{
    return bin2hex(random_bytes(32));
}

/* How long a sign-in lasts. The first is the ceiling: twelve hours from
   signing in, a token is finished whatever it has been doing, so one taken
   from a machine has an end even if it is used constantly. The second is the
   one that catches the ordinary case — a browser left open on a shared desk
   in the lab, forgotten rather than logged out. */
const SESSION_MAX_SECONDS  = 12 * 3600;
const SESSION_IDLE_SECONDS = 60 * 60;
/* Every request would otherwise write a row to say the session is still alive.
   A minute's resolution is plenty for an hour's timeout and costs one write a
   minute instead of one a click. */
const SESSION_TOUCH_SECONDS = 60;

/* One row per sign-in rather than one string per account, so a person can be
   signed in on a phone and a desk machine at once and end either without
   ending the other. */
function sessions_table(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $t = qi('_sessions');
    $kType = driver() === 'mysql' ? 'VARCHAR(190)' : 'TEXT';
    $iType = driver() === 'pgsql' ? 'BIGINT' : 'INTEGER';
    db()->exec("CREATE TABLE IF NOT EXISTS $t (" . qi('token') . " $kType PRIMARY KEY, "
        . qi('userId') . " $kType, " . qi('issued_at') . " $iType, "
        . qi('seen_at') . " $iType)");
}

function session_start_for(string $userId): string
{
    sessions_table();
    $token = new_token();
    $now = time();
    run_sql('INSERT INTO ' . qi('_sessions') . ' (' . qi('token') . ', ' . qi('userId')
        . ', ' . qi('issued_at') . ', ' . qi('seen_at') . ') VALUES (?, ?, ?, ?)',
        [$token, $userId, $now, $now]);
    session_sweep();
    return $token;
}

/** what has run out, cleared on the way past — the table cannot grow forever */
function session_sweep(): void
{
    $now = time();
    run_sql('DELETE FROM ' . qi('_sessions') . ' WHERE ' . qi('issued_at') . ' < ? OR '
        . qi('seen_at') . ' < ?', [$now - SESSION_MAX_SECONDS, $now - SESSION_IDLE_SECONDS]);
}

/**
 * The account a live token belongs to, or null.
 *
 * Expiry is checked here rather than swept on a timer, because a sweep that
 * has not run yet must not let a finished token through in the meantime.
 */
function session_user(string $token): ?array
{
    sessions_table();
    $row = fetch_one('SELECT * FROM ' . qi('_sessions') . ' WHERE ' . qi('token') . ' = ?', [$token]);
    if (!$row) {
        return null;
    }
    $now = time();
    $issued = (int) ($row['issued_at'] ?? 0);
    $seen = (int) ($row['seen_at'] ?? 0);
    if ($now - $issued > SESSION_MAX_SECONDS || $now - $seen > SESSION_IDLE_SECONDS) {
        run_sql('DELETE FROM ' . qi('_sessions') . ' WHERE ' . qi('token') . ' = ?', [$token]);
        return null;
    }
    if ($now - $seen >= SESSION_TOUCH_SECONDS) {
        run_sql('UPDATE ' . qi('_sessions') . ' SET ' . qi('seen_at') . ' = ? WHERE '
            . qi('token') . ' = ?', [$now, $token]);
    }
    $user = fetch_one('SELECT * FROM ' . qi('users') . ' WHERE ' . qi('id') . ' = ?',
        [(string) ($row['userId'] ?? '')]);
    return $user ?: null;
}

/** the token this request presented, from the header or the query string */
function request_token(): string
{
    $t = (string) ($_SERVER['HTTP_X_AUTH_TOKEN'] ?? '');
    if ($t === '' && isset($_GET['token'])) {
        $t = (string) $_GET['token'];      // for a download the browser navigates to
    }
    return trim($t);
}

function current_user(): ?array
{
    static $cached = false;
    static $user = null;
    if ($cached) {
        return $user;
    }
    $cached = true;

    /* A token identifies its holder. Compared with a WHERE rather than in PHP
       because there is nothing secret about the comparison — the token itself
       is the secret, and an attacker who does not hold it learns nothing from
       how long the query takes. */
    $token = request_token();
    if ($token !== '') {
        $row = session_user($token);
        if ($row && (string) ($row['status'] ?? 'Active') !== 'Inactive') {
            return $user = $row;
        }
        return $user = null;
    }

    /* One deploy's grace for a tab still running yesterday's build. This is the
       old scheme and it is not authentication — the ids are u1, u2, u3 — so it
       goes as soon as everyone has reloaded. */
    if (!ACCEPT_LEGACY_USER_ID) {
        return $user = null;
    }
    $id = $_SERVER['HTTP_X_USER_ID'] ?? '';
    if ($id === '') {
        return $user = null;
    }
    $row = fetch_one('SELECT * FROM ' . qi('users') . ' WHERE ' . qi('id') . ' = ?', [$id]);
    return $user = $row ?: null;
}

/** the caller's role, or '' when the request is anonymous */
function current_role(): string
{
    $u = current_user();
    return $u === null ? '' : (string) ($u['role'] ?? '');
}

/** admin and accountant are the only roles allowed to change financial data */
function may_touch_finance(): bool
{
    return in_array(current_role(), FINANCE_ROLES, true);
}

/** the center head reads the same financial data without being able to change it */
function may_read_finance(): bool
{
    return in_array(current_role(), FINANCE_VIEW_ROLES, true);
}

/** requisitions are staff-only — every role except student */
function may_touch_staff(): bool
{
    return in_array(current_role(), STAFF_ROLES, true);
}

/** CENTER_HEAD: view / search / filter / report / export only */
function is_read_only_role(): bool
{
    return in_array(current_role(), READ_ONLY_ROLES, true);
}

/**
 * The single carve-out in the read-only rule: the center head signs off on
 * requisitions. It is a PUT on one collection, and api_update further narrows
 * it to the review columns — no creating, no deleting, nothing else.
 */
function read_only_write_allowed(string $resource, string $method): bool
{
    $allowed = READ_ONLY_WRITE_EXCEPTIONS[current_role()][$resource] ?? null;
    return $allowed !== null && $method === 'PUT';
}

/** the columns the caller may change on this collection (null = all of them) */
function writable_fields(string $resource): ?array
{
    return READ_ONLY_WRITE_EXCEPTIONS[current_role()][$resource] ?? null;
}

/**
 * The accounts office picks a requisition up only after the center head has
 * approved it — a hand-made PUT on a still-Pending row is refused.
 */
function guard_requisition_stage(string $id): void
{
    if (!in_array(current_role(), REQ_AFTER_APPROVAL_ROLES, true)) {
        return;
    }
    $row = fetch_one('SELECT * FROM ' . qi('requisitions') . ' WHERE ' . qi('id') . ' = ?', [$id]);
    if ($row && ($row['status'] ?? REQ_PENDING_STATUS) === REQ_PENDING_STATUS) {
        send_json([
            'error'   => 'awaiting-approval',
            'message' => 'This request is still with the center head for approval.',
        ], 403);
    }
}

/** A stored setting's value, or the fallback when it has never been set. */
function setting_value(string $name, string $default = ''): string
{
    $row = fetch_one('SELECT * FROM ' . qi('settings') . ' WHERE ' . qi('name') . ' = ?', [$name]);
    return $row === null ? $default : (string) ($row['value'] ?? $default);
}

/**
 * Who may register attendance. The admin and the course coordinator always
 * may. Faculty may while the admin leaves the switch on — an institute that
 * wants the coordinator to be the single point of entry turns it off, and
 * turning it off has to mean the API refuses them too, not merely that the
 * menu item disappears.
 */
function may_mark_attendance(): bool
{
    $role = current_role();
    if (in_array($role, ATTENDANCE_ALWAYS_ROLES, true)) {
        return true;
    }
    return in_array($role, ATTENDANCE_OPTIONAL_ROLES, true)
        && setting_value('facultyAttendance', '1') === '1';
}

/** admin and placement officer may create/edit/delete placement records */
function may_touch_placement(): bool
{
    return in_array(current_role(), PLACEMENT_ROLES, true);
}

/** the same two plus the center head, which monitors placement without touching it */
function may_read_placement(): bool
{
    return in_array(current_role(), PLACEMENT_VIEW_ROLES, true);
}

function is_placement_officer(): bool
{
    return current_role() === 'placement_officer';
}

/**
 * A placement officer sees its own modules plus the handful of collections it
 * recruits from (PLACEMENT_READABLE). Everything else — fees, payments, assets,
 * library, requisitions, timetable — is refused, not merely hidden.
 */
function placement_officer_may_read(string $col): bool
{
    return in_array($col, PLACEMENT_COLLECTIONS, true)
        || in_array($col, PLACEMENT_READABLE, true);
}

/* The two administrator roles. The Super Admin (`admin`) may do anything; the
   Admin (`subadmin`) borrows that ceiling but is held to what it has been
   granted. These live here, beside the gate that reads them, and not in
   config.php: a Hostinger deploy syncs file by file, so a constant this file
   uses has to arrive in this file — index.php referencing one config.php had
   not delivered yet would fatal the whole site for the length of that window. */
const ADMIN_FAMILY = ['admin', 'subadmin'];
const SUPER_ADMIN_ROLE = 'admin';
const ADMIN_ROLE = 'subadmin';

/* The tables the Admin may never reach, whatever it has been granted: roles and
   the audit log are how access itself is decided, and settings are the system's
   own switches — all three stay with the Super Admin. The one exception is the
   handful of operational reference lists below, which live in `settings` but are
   ordinary staff/student data an Admin extends while managing people. */
const SUBADMIN_FORBIDDEN = ['roles', 'auditlog', 'settings'];

/* The editable reference lists the forms grow on the fly — the "+ Add new…" in
   a dropdown. They sit in `settings` but are ordinary operational data an Admin
   extends while doing its job, one list or another on nearly every screen. So an
   Admin may write these by name; every other setting — the system switches
   (fees visibility, attendance mode, id length, branch codes) — stays with the
   Super Admin. This is the whole allowlist; it must match LIST_DEFS in app.js. */
const OPERATIONAL_LIST_SETTINGS = [
    'designationList', 'departmentList', 'specialisationList', 'reportingToList',
    'branchNameList', 'courseList', 'feeTypeList', 'assetCategoryList',
    'goodsCategoryList', 'bookCategoryList',
];

/** may an Admin write this settings row? Only the operational lists above. */
function subadmin_setting_write_ok(string $method, ?string $id): bool
{
    if ($id !== null) {
        $row = fetch_one('SELECT ' . qi('name') . ' AS name FROM ' . qi('settings')
            . ' WHERE ' . qi('id') . ' = ?', [$id]);
        // a new row under an id that does not exist yet is judged by its body
        if ($row !== null) {
            return in_array((string) ($row['name'] ?? ''), OPERATIONAL_LIST_SETTINGS, true);
        }
    }
    $body = body();
    $rows = (is_array($body) && array_is_list($body) && $body !== []) ? $body : [$body];
    foreach ($rows as $r) {
        if (!is_array($r) || !in_array((string) ($r['name'] ?? ''), OPERATIONAL_LIST_SETTINGS, true)) {
            return false;
        }
    }
    return $rows !== [];
}

/* What an Admin may read. The academic directory here is reference every page
   leans on (names, courses, the timetable) and is left readable; everything
   sensitive — money, marks, placement, the admission queue, staff files — is
   shown only when the module that owns it has been granted. Reads are refused
   in guard_request and emptied in the bootstrap, not merely hidden in the menu. */
const SUBADMIN_ALWAYS_READ = ['roles', 'settings', 'events', 'users', 'students',
                              'faculty', 'coordinators', 'admissions', 'courses',
                              'syllabus', 'timetable'];
/** module key => the collections granting that module lets the Admin read */
const SUBADMIN_MODULE_READS = [
    'students'     => ['submissions'],
    'fees'         => ['fees', 'fixedfees', 'payments'],
    'assets'       => ['assets'],
    'staff'        => ['accountants', 'centerheads', 'placementofficers'],
    'marks'        => ['marks'],
    'attendance'   => ['attendance'],
    'placement'    => ['companies', 'drives', 'applications', 'interviews',
                       'offers', 'placementevents', 'placementofficers'],
    'library'      => ['books', 'issues'],
    'requisitions' => ['requisitions'],
];

/** the restricted Admin */
function is_sub_admin(): bool
{
    return current_role() === ADMIN_ROLE;
}

/** either administrator — the Super Admin or a restricted Admin */
function is_admin_family(): bool
{
    return in_array(current_role(), ADMIN_FAMILY, true);
}

/**
 * An account whose access is decided entirely by a per-module grant, not by a
 * built-in role's fixed behaviour. Three kinds qualify:
 *   - the Admin (subadmin);
 *   - anyone the Super Admin put on custom access (access = restricted), whatever
 *     their role — a Faculty, an Accountant;
 *   - anyone on a custom ACCESS ROLE built on the Super Admin's ceiling
 *     (base = admin), such as "Placement Team" — the grant is the role's own
 *     template, shared by every user on that role and deny-by-default.
 * For all three the whole module range is grantable, the older per-role rules
 * step aside, and the module gate decides. The Super Admin itself never qualifies
 * — it holds everything — and a student is on the student portal, not the grid.
 */
function has_custom_access(): bool
{
    $u = current_user();
    if (!$u) {
        return false;
    }
    $role = (string) ($u['role'] ?? '');
    if ($role === SUPER_ADMIN_ROLE || $role === 'student') {
        return false;
    }
    return $role === ADMIN_ROLE
        || (string) ($u['access'] ?? 'full') === 'restricted'
        || base_role($role) === SUPER_ADMIN_ROLE;   // a custom access role on the admin ceiling
}

/**
 * May the restricted Admin read this collection?
 *
 * The academic directory is reference and always readable; everything else is
 * shown only when a module the Admin holds (with View) covers it. This is the
 * server side of "an Admin without Fees sees no fee data" — refused here and
 * emptied in the bootstrap, never merely hidden in the sidebar.
 */
function subadmin_may_read(string $col): bool
{
    if (in_array($col, SUBADMIN_ALWAYS_READ, true)) {
        return true;
    }
    $perms = effective_perms();
    foreach (SUBADMIN_MODULE_READS as $module => $cols) {
        if (in_array($col, $cols, true) && in_array('view', $perms[$module] ?? [], true)) {
            return true;
        }
    }
    return false;
}

/**
 * A stored permission set, in whichever shape it was saved, as
 * module => list of actions.
 *
 * Three shapes have existed. A plain list of module keys was the first and
 * meant full access; then 'view' | 'edit'; now a list of actions. All three are
 * read rather than rewritten, so an account narrowed before any of this keeps
 * working and keeps meaning what it always meant.
 */
function read_perm_set($raw): ?array
{
    if (is_string($raw)) {
        $raw = json_decode($raw, true);
    }
    if (!is_array($raw)) {
        return null;
    }
    $out = [];
    foreach ($raw as $key => $value) {
        if (is_int($key)) {                     // the oldest form: a bare list
            $out[(string) $value] = ACTIONS;
            continue;
        }
        if ($value === '' || $value === false || $value === null) {
            continue;
        }
        if (is_array($value)) {
            $acts = array_values(array_intersect(ACTIONS, $value));
        } elseif ($value === 'view') {
            $acts = READ_ACTIONS;
        } else {
            $acts = ACTIONS;                    // 'edit', true, 1 — the old full grant
        }
        if ($acts) {
            $out[(string) $key] = $acts;
        }
    }
    return $out;
}

/**
 * What the code supports for a role, as module => actions — the cap every
 * grant is held to. Worked out from MODULES and the carve-outs rather than
 * from a menu, because the server has no menu; it is deliberately the coarser
 * of the two, since the role rules further down guard_request() still apply on
 * top of it.
 */
function role_ceiling(string $role): array
{
    static $cache = [];
    if (isset($cache[$role])) {
        return $cache[$role];
    }
    $out = [];
    $carve = ROLE_CARVE_OUTS[$role] ?? null;
    $readOnly = $carve !== null && ($carve['readOnly'] ?? false);
    foreach (MODULES as $key => $def) {
        $acts = ($role === 'admin' || !$readOnly) ? ACTIONS : READ_ACTIONS;
        $extra = $carve['extra'][$key] ?? null;
        if ($extra) {
            $acts = array_values(array_intersect(ACTIONS, array_merge($acts, $extra)));
        }
        $out[$key] = $acts;
    }
    return $cache[$role] = $out;
}

/** the role row for a key, or null — a role nobody has edited has no row */
function role_record(string $key): ?array
{
    static $cache = [];
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }
    try {
        $row = fetch_one('SELECT * FROM ' . qi('roles') . ' WHERE ' . qi('key') . ' = ?', [$key]);
    } catch (PDOException $e) {
        $row = null;         // the table arrives with the next init_db()
    }
    return $cache[$key] = $row ?: null;
}

/** the built-in role a custom one borrows its ceiling from */
function base_role(string $key): string
{
    $row = role_record($key);
    $base = $row ? (string) ($row['base'] ?? '') : '';
    if ($base !== '' && in_array($base, ROLES, true)) {
        return $base;
    }
    return in_array($key, ROLES, true) ? $key : 'faculty';
}

/**
 * What this account may actually do: ceiling ∩ role template ∩ user override.
 * The override wins over the template, and both are capped by the ceiling —
 * the same order the browser applies, so the two never disagree.
 */
function effective_perms(): array
{
    static $cached = false;
    static $perms = [];
    if ($cached) {
        return $perms;
    }
    $cached = true;
    $u = current_user();
    if (!$u) {
        return $perms = [];
    }
    $role = (string) ($u['role'] ?? '');
    if ($role === SUPER_ADMIN_ROLE) {
        return $perms = role_ceiling('admin');   // never narrowed, never lost
    }
    $roleRow = role_record($role);
    if (has_custom_access()) {
        /* Granted from the whole module range (the Super Admin's ceiling) and
           held to one grant — deny by default, a missing grant meaning nothing.
           The grant is the per-account override when the account is on custom
           access (the Admin, or anyone set to access = restricted); otherwise it
           is the access role's own template, shared live by every user on that
           role. `?? []` is what makes "no grant" mean "no access". */
        $ceiling = role_ceiling('admin');
        $byUser = $role === ADMIN_ROLE || (string) ($u['access'] ?? 'full') === 'restricted';
        $grant = $byUser
            ? (read_perm_set($u['permissions'] ?? null) ?? [])
            : (($roleRow ? read_perm_set($roleRow['permissions'] ?? null) : null) ?? []);
        $out = [];
        foreach ($ceiling as $key => $acts) {
            $a = array_values(array_intersect($acts, $grant[$key] ?? []));
            if ($a) {
                $out[$key] = $a;
            }
        }
        return $perms = $out;
    }
    /* Not custom access: the account keeps its role's ceiling, its role template
       and any per-user override, exactly as before — nothing changes for anyone
       the Super Admin has not put on a custom access role or custom access. */
    $ceiling = role_ceiling(base_role($role));
    $fromRole = $roleRow ? read_perm_set($roleRow['permissions'] ?? null) : null;
    $own = (string) ($u['access'] ?? 'full') === 'restricted'
        ? (read_perm_set($u['permissions'] ?? null) ?? [])
        : null;
    $out = [];
    foreach ($ceiling as $key => $acts) {
        if ($fromRole !== null) {
            $acts = array_values(array_intersect($acts, $fromRole[$key] ?? []));
        }
        if ($own !== null) {
            $acts = array_values(array_intersect($acts, $own[$key] ?? []));
        }
        if ($acts) {
            $out[$key] = $acts;
        }
    }
    return $perms = $out;
}

/** may the caller do this, in this module? */
function may(string $module, string $action): bool
{
    if (current_role() === 'admin') {
        return true;
    }
    return in_array($action, effective_perms()[$module] ?? [], true);
}

/**
 * Kept for the callers that only ask "which modules". An account whose role
 * has never been narrowed and which carries no override of its own is not
 * narrowed at all, and reads as null exactly as it used to.
 */
function restricted_perms(): ?array
{
    $u = current_user();
    if (!$u) {
        return null;
    }
    $narrowed = (string) ($u['access'] ?? 'full') === 'restricted'
        || role_record((string) ($u['role'] ?? '')) !== null;
    return $narrowed ? effective_perms() : null;
}

function restricted_modules(): ?array
{
    $perms = restricted_perms();
    return $perms === null ? null : array_keys($perms);
}

/**
 * A narrowed account may change only what its modules cover. Reads are left to
 * the role — a page it can open still needs the names and the lists it prints —
 * but nothing outside its modules can be written, whatever the request looks
 * like.
 */
/**
 * The action gate. POST needs Add, PUT needs Edit, DELETE needs Delete — so a
 * hand-made DELETE against a module ticked for View and Add is refused, which
 * is the whole point of having actions at all.
 *
 * A collection can belong to more than one module (`users` is written by both
 * Students and Staff), so holding the action in any module that writes it is
 * enough — the same rule the screen draws its buttons by.
 */
function guard_module_write(string $resource, string $method): void
{
    $perms = restricted_perms();
    if ($perms === null) {
        return;
    }
    /* Settings for the Admin is decided by guard_role_write above, which has the
       record id and so can pin it to the operational lists; it does not belong
       to any one module, so the module gate would otherwise refuse a list the
       Admin is allowed to grow. Having passed that gate, it is already vetted. */
    if ($resource === 'settings' && has_custom_access()) {
        return;
    }
    $action = METHOD_ACTION[$method] ?? 'edit';
    $owners = [];
    foreach (MODULES as $key => $def) {
        if (in_array($resource, $def['write'] ?? [], true)) {
            $owners[] = $key;
        }
    }
    if (!$owners) {
        return;              // not a collection any module claims — older rules decide
    }
    foreach ($owners as $key) {
        $acts = $perms[$key] ?? [];
        if (in_array($action, $acts, true)) {
            return;
        }
        // an import writes rows the same way an add does, and Manage covers a
        // module handed over whole
        if ($action === 'add' && in_array('import', $acts, true)) {
            return;
        }
        if ($action === 'edit' && (in_array('approve', $acts, true) || in_array('manage', $acts, true))) {
            return;
        }
    }
    send_json([
        'error'   => 'not-permitted',
        'message' => 'Your account does not have permission to ' . $action . ' this.',
    ], 403);
}

/**
 * Guard for one request — the real permission gate, independent of the UI.
 *
 *  1. a read-only role (center head) is refused every write, on every
 *     collection, however the request was made;
 *  2. financial collections are readable by the finance + view roles and
 *     writable only by the finance roles; `fees` stays readable to everyone
 *     (a student sees their own record) but only the accounts office edits it;
 *  3. requisitions are staff-only;
 *  4. placement collections belong to the placement cell, and the placement
 *     officer in turn may not step outside them.
 */
/* ---------------- who may touch what ----------------

   These live beside the gate that reads them, and not in config.php, because
   the two have to arrive together. They did not once: a deploy put this file
   up while the other was still the previous one, the gate asked for a rule
   that was not there yet, and every session got as far as signing in and no
   further. A rule and the code that enforces it are one thing, so they ship
   as one file.

   ---- what each role may write ----

   Deny by default. The gate used to work the other way round: it listed what
   a role must NOT do, so every collection nobody had thought to name was
   writable by anybody holding a token. A student could rename a lecturer, edit
   a marksheet, delete an admission form, and set the administrator's password
   and sign in as the administrator.

   Each role is given the collections its own screens write, and a collection
   missing from its list is refused — whatever the request looks like, and
   whatever the browser thinks it may draw. A table added next year is closed
   until somebody decides whose it is. The rules further down can narrow any of
   this; they can no longer be the only thing standing in the way. */
const ROLE_WRITABLE = [
    'admin'              => ['*'],           // the administrator holds everything
    'accountant'         => ['fees', 'fixedfees', 'payments', 'assets',
                             'accountants', 'centerheads', 'requisitions'],
    // the centre head monitors and approves; the read-only rule below still applies
    'center_head'        => ['requisitions'],
    'placement_officer'  => ['companies', 'drives', 'applications', 'interviews',
                             'offers', 'placementevents'],
    'course_coordinator' => ['attendance'],
    // the desk that enrols people: the student, their login, and the form it came from
    'admission'          => ['students', 'users', 'submissions'],
    'faculty'            => ['attendance', 'marks', 'requisitions'],
    // a guest teacher registers attendance and marks for the classes given to
    // them; no purchasing, no staff files
    'guest_faculty'      => ['attendance', 'marks'],
    'librarian'          => ['books', 'issues', 'requisitions'],
    // a student applies to a drive and nothing else; the placement rule below
    // narrows even that to a POST
    'student'            => ['applications'],
];

/* The one record somebody may change without being given the collection it is
   in: their own staff row, which is what the Profile page saves. Matched on
   the account's refId, so it is their row or nobody's — this is the difference
   between editing your own telephone number and editing everybody's. */
const ROLE_WRITABLE_OWN = [
    'accountant'         => ['accountants'],
    'center_head'        => ['centerheads'],
    'placement_officer'  => ['placementofficers'],
    'course_coordinator' => ['coordinators'],
    'admission'          => ['admissions'],
    'faculty'            => ['faculty'],
    'guest_faculty'      => ['faculty'],
    'librarian'          => ['faculty'],
];

/* ---- what each role may read ----

   The other half of the same rule, and the wider hole of the two. A signed-in
   student could ask the API for every student on the roll — telephone,
   Aadhaar, address, guardians, health — for every employee's personal file,
   for everybody's fees, for every admission form, and for the list of login
   names with the administrator's at the top. None of it was on their screens;
   the screens were the only thing not offering it.

   Two collections are deliberately left to everyone. `roles` holds ticked
   boxes and no personal data, and the browser needs it to know what its own
   account may do. `users` is scoped rather than refused: the session is
   restored by looking the signed-in account up in it, so taking it away would
   log people out — instead everybody but the two roles that manage accounts
   sees exactly one row, their own. */
const ROLE_READABLE = [
    'admin'              => ['*'],
    'accountant'         => ['users', 'roles', 'students', 'faculty', 'accountants',
                             'centerheads', 'coordinators', 'admissions', 'courses',
                             'attendance', 'marks', 'fees', 'fixedfees', 'payments',
                             'assets', 'requisitions', 'timetable', 'books', 'issues',
                             'events', 'settings'],
    // the centre head monitors the college; that is the whole job
    'center_head'        => ['users', 'roles', 'submissions', 'students', 'faculty',
                             'accountants', 'centerheads', 'placementofficers',
                             'coordinators', 'admissions', 'courses', 'syllabus',
                             'attendance', 'marks', 'fees', 'fixedfees', 'payments',
                             'assets', 'requisitions', 'timetable', 'books', 'issues',
                             'events', 'companies', 'drives', 'applications',
                             'interviews', 'offers', 'placementevents', 'settings'],
    'placement_officer'  => ['users', 'roles', 'students', 'placementofficers', 'courses',
                             'syllabus', 'marks', 'events', 'companies', 'drives',
                             'applications', 'interviews', 'offers', 'placementevents',
                             'settings'],
    'course_coordinator' => ['users', 'roles', 'students', 'faculty', 'coordinators',
                             'courses', 'syllabus', 'attendance', 'marks', 'timetable',
                             'events', 'settings'],
    'admission'          => ['users', 'roles', 'submissions', 'students', 'admissions',
                             'courses', 'syllabus', 'events', 'settings'],
    'faculty'            => ['users', 'roles', 'students', 'faculty', 'courses', 'syllabus',
                             'attendance', 'marks', 'requisitions', 'timetable', 'books',
                             'issues', 'events', 'settings'],
    'guest_faculty'      => ['users', 'roles', 'students', 'faculty', 'courses', 'syllabus',
                             'attendance', 'marks', 'timetable', 'events', 'settings'],
    'librarian'          => ['users', 'roles', 'students', 'faculty', 'courses', 'syllabus',
                             'requisitions', 'timetable', 'books', 'issues', 'events',
                             'settings'],
    // everything a student sees of themselves; the row rules below decide whose
    'student'            => ['users', 'roles', 'students', 'faculty', 'courses', 'syllabus',
                             'attendance', 'marks', 'fees', 'timetable', 'books', 'issues',
                             'events', 'companies', 'drives', 'applications', 'interviews',
                             'offers', 'placementevents', 'settings'],
];

/* Which column ties a row to the student reading it. Their own record, their
   own fees, their own marks, their own library issues — and nobody else's, so
   the roll cannot be walked one id at a time. */
const STUDENT_OWN_ROWS = [
    'students' => 'id',
    'fees'     => 'studentId',
    'marks'    => 'studentId',
    'issues'   => 'studentId',
];

/* What a student may see of an employee. A timetable prints who takes the
   class and a profile page prints who the mentor is; neither needs the
   lecturer's telephone number, home address, Aadhaar or date of birth. */
const STAFF_PUBLIC_FIELDS = ['id', 'empId', 'name', 'designation', 'department',
                             'photo', 'role', 'specialisation', 'qualification'];

/**
 * The default-deny gate: may this role write this collection at all?
 *
 * Asked before any of the rules that follow, because those rules name the
 * things a role must not do — and anything nobody named used to fall through
 * them. This asks the opposite question, so a collection that has been granted
 * to nobody is refused rather than allowed.
 *
 * `$id` is the record in the path, which is what lets somebody edit their own
 * staff row on the Profile page without being handed the whole table.
 */
function guard_role_write(string $resource, string $method, ?string $id): void
{
    $role = current_role();
    /* A custom-access account may reach any collection its granted modules cover
       — the module gate (guard_module_write) and the escalation shield decide the
       rest — but never the three tables that decide access itself. The one give:
       it may add to the operational reference lists that live in `settings`. */
    if (has_custom_access()) {
        if ($resource === 'settings') {
            if (subadmin_setting_write_ok($method, $id)) {
                return;
            }
            send_json(['error' => 'forbidden',
                       'message' => 'Only the Super Admin changes system settings.'], 403);
        }
        if (!in_array($resource, SUBADMIN_FORBIDDEN, true)) {
            return;
        }
        send_json(['error' => 'forbidden',
                   'message' => 'Only the Super Admin manages roles and the audit log.'], 403);
    }
    $allowed = ROLE_WRITABLE[$role] ?? [];
    if (in_array('*', $allowed, true) || in_array($resource, $allowed, true)) {
        return;
    }
    /* Their own row, and only by id: a PUT naming somebody else's is not
       "editing your profile", and a POST or DELETE is not either. */
    if ($method === 'PUT' && $id !== null
        && in_array($resource, ROLE_WRITABLE_OWN[$role] ?? [], true)
        && $id === (string) (current_user()['refId'] ?? '')) {
        return;
    }
    send_json([
        'error'   => 'forbidden',
        'message' => 'Your role cannot change this record.',
    ], 403);
}

function guard_request(string $resource, string $method, ?string $id = null): void
{
    $isWrite = !in_array($method, ['GET', 'HEAD', 'OPTIONS'], true);

    /* Before any rule about which role may do what, the question of whether
       there is a role at all. Without this the guards below fall through for a
       caller who sent no identity, which is how the student roll came to be
       readable by anyone who asked for it. */
    if (!in_array($resource, OPEN_ENDPOINTS, true) && current_user() === null) {
        send_json(['error' => 'unauthorised', 'message' => 'Please sign in.'], 401);
    }

    /* A flood ceiling, on writes alone. Reads never reach it, so no page is
       ever slowed; login and the public form keep their own separate limits.
       This is the one that stops a script changing the database as fast as the
       network allows. */
    if ($isWrite && !in_array($resource, OPEN_ENDPOINTS, true)) {
        rate_check();
    }

    /* The helpdesk. Its tables are never reached through the generic collection
       API — the history is append-only and a ticket is visible only to the
       people it concerns — and its tk-* endpoints authorise every call against
       the ticket and the reporting hierarchy themselves, so the collection and
       role rules below have nothing to add for them. */
    if (in_array($resource, TICKET_TABLES, true)) {
        send_json(['error' => 'forbidden', 'message' => 'Tickets are reached through the helpdesk.'], 403);
    }
    if (preg_match('/^(tk|nt|ap|rp)-/', $resource)) {
        return;
    }
    // a reporting relationship is set by the Super Admin alone, and must make sense
    if ($isWrite && $resource === 'users') {
        guard_reporting_to($id);
    }

    /* Collections first, and by grant rather than by exception. Only then the
       older rules, which narrow what this has already allowed. */
    if ($isWrite && isset(COLLECTIONS[$resource])) {
        guard_role_write($resource, $method, $id);
    }
    if (!$isWrite && isset(COLLECTIONS[$resource]) && !role_may_read($resource)) {
        send_json(['error' => 'forbidden',
                   'message' => 'Your role cannot read this.'], 403);
    }
    /* A custom-access account reads only what its granted modules cover.
       Everything sensitive it was not given — money, marks, placement, the
       admission queue, staff files — is refused here, not merely left out of the
       menu. This is deny-by-default reaching the read side. */
    if (!$isWrite && has_custom_access() && isset(COLLECTIONS[$resource])
        && !subadmin_may_read($resource)) {
        send_json(['error' => 'forbidden',
                   'message' => 'Your account has not been granted access to this.'], 403);
    }
    if ($isWrite && !in_array($resource, ['login', 'logout', 'change-password'], true)) {
        guard_module_write($resource, $method);
    }

    /* Nobody edits their own access. A permission screen is reached by the
       admin alone, and the account it is aimed at is read from the caller's
       header, so a hand-made PUT cannot widen the login making it. */
    if ($resource === 'auditlog' && current_role() !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the administrator reads the audit log.'], 403);
    }
    /* Read by the administrator, written by nobody. The server appends to it
       from what it did; a record of what people did is worth having only if the
       people it records cannot edit it — the administrator included. */
    if ($resource === 'auditlog' && $isWrite) {
        send_json(['error' => 'forbidden',
                   'message' => 'The audit log is written by the server and cannot be edited.'], 403);
    }
    if ($isWrite && in_array($resource, ['roles', 'auditlog'], true) && current_role() !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the administrator manages roles and permissions.'], 403);
    }
    /* The escalation shield on the login table. Two lines are absolute for
       everyone but the Super Admin: nobody hands out access or permissions, and
       nobody creates, becomes, or edits an administrator (Super Admin or Admin).
       Within that, who may create which ordinary login is a question the module
       gate above already answered — an Admin granted Staff creates the employee
       logins that go with the people it manages; the admissions desk creates
       students and only students. So the role being assigned is checked against
       the admin family (always refused) and, for the desk, against `student`. */
    if ($isWrite && $resource === 'users' && current_role() !== 'admin') {
        $subAdmin = has_custom_access();
        // editing or deleting somebody: an administrator's account is off limits
        if ($id !== null) {
            $target = fetch_one('SELECT ' . qi('role') . ' AS role FROM ' . qi('users')
                . ' WHERE ' . qi('id') . ' = ?', [$id]);
            if ($target && in_array((string) ($target['role'] ?? ''), ADMIN_FAMILY, true)) {
                send_json(['error' => 'forbidden',
                           'message' => 'Only the Super Admin can change an administrator account.'], 403);
            }
        }
        $rows = body();
        $rows = (array_is_list($rows) && $rows !== []) ? $rows : [$rows];
        foreach ($rows as $r) {
            if (!is_array($r)) {
                continue;
            }
            // access and permissions are the escalation vectors — never for anyone
            // but the Super Admin, whatever else the request is doing
            if (array_key_exists('access', $r) || array_key_exists('permissions', $r)) {
                send_json(['error' => 'forbidden',
                           'message' => 'Only the Super Admin can change roles or permissions.'], 403);
            }
            if (array_key_exists('role', $r)) {
                $newRole = (string) ($r['role'] ?? '');
                // nobody but the Super Admin creates or promotes an administrator
                if (in_array($newRole, ADMIN_FAMILY, true)) {
                    send_json(['error' => 'forbidden',
                               'message' => 'Only the Super Admin can assign an administrator role.'], 403);
                }
                // the admissions desk mints students and nothing else; an Admin
                // mints whatever its granted modules manage (the module gate
                // already vetted that), so it is held only to the family rule above
                if (!$subAdmin && $newRole !== 'student') {
                    send_json(['error' => 'forbidden',
                               'message' => 'Your role can only create student logins.'], 403);
                }
            }
            // the desk does not switch accounts on and off either; an Admin may,
            // for the staff and students it manages
            if (!$subAdmin && array_key_exists('status', $r)) {
                send_json(['error' => 'forbidden',
                           'message' => 'Only the Super Admin can change an account\'s status.'], 403);
            }
        }
    }

    if ($isWrite && !in_array($resource, ['login', 'logout', 'change-password'], true) && is_read_only_role()
        && !read_only_write_allowed($resource, $method) && !has_custom_access()) {
        send_json([
            'error'   => 'read-only',
            'message' => 'Your role has view-only access and cannot change data.',
        ], 403);
    }

    if ($resource === 'syllabus') {
        $role = current_user()['role'] ?? '';
        if (in_array($role, SYLLABUS_HIDDEN_ROLES, true) && !has_custom_access()) {
            send_json(['error' => 'forbidden',
                       'message' => 'The curriculum is not part of the accounts office.'], 403);
        }
        if ($isWrite && !in_array($role, SYLLABUS_WRITE_ROLES, true) && !has_custom_access()) {
            send_json(['error' => 'forbidden',
                       'message' => 'Only the admin can change the curriculum.'], 403);
        }
    }

    /* The area rules below name the roles a module belongs to. An administrator
       — Super Admin or a granted Admin — is let past them so the per-account
       permission gate above is what actually decides; for the Admin a module it
       was not granted was already refused there. */
    if (in_array($resource, FINANCE_COLLECTIONS, true) && !has_custom_access()) {
        if ($isWrite ? !may_touch_finance() : !may_read_finance()) {
            send_json(['error' => 'forbidden'], 403);
        }
    }
    if ($isWrite && in_array($resource, FINANCE_WRITE_ONLY, true) && !may_touch_finance() && !has_custom_access()) {
        send_json(['error' => 'forbidden'], 403);
    }
    if (in_array($resource, STAFF_COLLECTIONS, true) && !may_touch_staff() && !has_custom_access()) {
        send_json(['error' => 'forbidden'], 403);
    }

    /* A course coordinator exists to run attendance. It reads the master data
       that attendance is built from — students, papers, faculty — and writes
       none of it: the one collection it may change is `attendance` itself. But a
       coordinator the Super Admin has put on custom access is governed by that
       grant instead, so this role rule steps aside for it. */
    if (current_role() === 'course_coordinator' && !has_custom_access()) {
        // signing out and changing one's own password act on the caller's own
        // session and account, not on master data — never blocked by role
        if ($isWrite && !in_array($resource, ['attendance', 'change-password', 'logout'], true)) {
            send_json([
                'error'   => 'forbidden',
                'message' => 'A course coordinator can register attendance, not change master records.',
            ], 403);
        }
        if (!$isWrite && $resource !== '' && isset(COLLECTIONS[$resource])
            && !in_array($resource, COORDINATOR_READONLY, true) && $resource !== 'attendance') {
            send_json(['error' => 'forbidden'], 403);
        }
    }

    // attendance is registered by the roles allowed to hold a class — and by an
    // Admin granted the Attendance module (the module gate above vetted that)
    if ($resource === 'attendance' && $isWrite && !may_mark_attendance() && !has_custom_access()) {
        send_json([
            'error'   => 'forbidden',
            'message' => in_array(current_role(), ['faculty', 'guest_faculty'], true)
                ? 'Attendance entry is currently handled by the course coordinator.'
                : 'Your role cannot register attendance.',
        ], 403);
    }

    /* The admissions desk enrols students and corrects them; it may not
       remove one, and outside students and their logins it may not write at
       all. Reads are narrowed to what enrolling needs. An admission officer on
       custom access is governed by its grant instead, so this steps aside. */
    if (current_role() === 'admission' && !has_custom_access()) {
        // correcting a student id is a student edit, which is what this desk does;
        // signing out and changing one's own password are self-service and never
        // blocked by role
        if ($isWrite && !in_array($resource, ['reissue-student-id', 'change-password', 'logout'], true)
            && !in_array($resource, ADMISSION_WRITABLE, true)) {
            send_json([
                'error'   => 'forbidden',
                'message' => 'The admissions desk can add and edit students, nothing else.',
            ], 403);
        }
        if ($method === 'DELETE') {
            send_json([
                'error'   => 'forbidden',
                'message' => 'A student record is removed by the administrator, not the admissions desk.',
            ], 403);
        }
        // a login it creates is a student's; it does not mint staff accounts
        if ($isWrite && $resource === 'users') {
            $rows = body();
            $rows = (array_is_list($rows) && $rows !== []) ? $rows : [$rows];
            foreach ($rows as $row) {
                if (($row['role'] ?? 'student') !== 'student') {
                    send_json(['error' => 'forbidden',
                               'message' => 'The admissions desk can only create student logins.'], 403);
                }
            }
        }
        if (!$isWrite && $resource !== '' && isset(COLLECTIONS[$resource])
            && !in_array($resource, ADMISSION_READABLE, true)) {
            send_json(['error' => 'forbidden'], 403);
        }
    }

    // The student roll is read by the accounts office, the placement cell, the
    // library and the centre head, and edited by none of them. Until now that
    // was a UI convention: the Students page simply hid its buttons, while the
    // API accepted a write from any signed-in role.
    if ($resource === 'students' && $isWrite
        && !in_array(current_role(), ['admin', 'admission'], true) && !has_custom_access()) {
        send_json([
            'error'   => 'forbidden',
            'message' => 'Only the administrator can add, edit or delete a student record.',
        ], 403);
    }

    if (in_array($resource, PLACEMENT_COLLECTIONS, true) && !has_custom_access()) {
        $isStudent = current_role() === 'student';
        $studentMayRead = !$isWrite && $isStudent
            && in_array($resource, array_merge(PLACEMENT_STUDENT_OPEN, PLACEMENT_STUDENT_OWN), true);
        // the one write a student has: applying to a drive, vetted in api_create
        $studentMayApply = $isStudent && $method === 'POST' && $resource === 'applications';
        if (!$studentMayRead && !$studentMayApply
            && ($isWrite ? !may_touch_placement() : !may_read_placement())) {
            send_json(['error' => 'forbidden'], 403);
        }
    }
    // the placement officer stays inside the placement cell
    if (is_placement_officer() && $resource !== '' && isset(COLLECTIONS[$resource])) {
        if (!placement_officer_may_read($resource)) {
            send_json(['error' => 'forbidden'], 403);
        }
        if ($isWrite && !in_array($resource, PLACEMENT_COLLECTIONS, true)) {
            send_json([
                'error'   => 'forbidden',
                'message' => 'A placement officer can only change placement records.',
            ], 403);
        }
    }
}

/** path segments after /api, e.g. ['students', 'S01'] */
function segments(): array
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
    $path = rawurldecode($path);
    if (preg_match('#/api(/.*)?$#', $path, $m)) {
        $path = $m[1] ?? '';
    }
    return array_values(array_filter(explode('/', $path), fn($s) => $s !== '' && $s !== 'index.php'));
}

// ---------------------------------------------------------------- handlers
/* ---------------- student ids ----------------
   Issued here rather than in the browser, because two people pressing Save at
   the same moment is exactly the case a browser cannot get right. */

/** the counter table, created on demand — not a COLLECTIONS entry, so not a route */
function seq_table(): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $kType = driver() === 'mysql' ? 'VARCHAR(190)' : 'TEXT';
    $iType = driver() === 'pgsql' ? 'BIGINT' : 'INTEGER';
    db()->exec('CREATE TABLE IF NOT EXISTS ' . qi('_id_seq') . ' (' . qi('k') . " $kType PRIMARY KEY, "
        . qi('n') . " $iType)");
}

/** the branch code map: the setting if there is one, the built-in list otherwise */
function branch_code_map(): array
{
    static $map = null;
    if ($map !== null) {
        return $map;
    }
    $map = BRANCH_CODES;
    /* Stored as "Branch Name=01,Other Branch=02" — one line the office can edit
       rather than a table nobody would find. */
    $raw = trim(setting_value('branchCodes', ''));
    if ($raw !== '') {
        $parsed = [];
        foreach (explode(',', $raw) as $pair) {
            $bits = explode('=', $pair, 2);
            if (count($bits) === 2 && trim($bits[0]) !== '') {
                $parsed[trim($bits[0])] = trim($bits[1]);
            }
        }
        if ($parsed) {
            $map = $parsed;
        }
    }
    return $map;
}

/** the two digits that stand for this branch, matched without regard to case */
function branch_code(string $branch): string
{
    $want = strtolower(trim($branch));
    if ($want === '') {
        return BRANCH_CODE_FALLBACK;
    }
    foreach (branch_code_map() as $name => $code) {
        if (strtolower(trim((string) $name)) === $want) {
            return (string) $code;
        }
    }
    return BRANCH_CODE_FALLBACK;
}

/** the four-digit admission year, from a full year, a date, or a two-digit year */
function admission_yy(string $value): string
{
    if (preg_match('/(\d{4})/', $value, $m)) {
        return $m[1];
    }
    if (preg_match('/^\d{2}$/', trim($value))) {
        return '20' . trim($value);       // "26" is 2026, the only century this runs in
    }
    return date('Y');
}

/**
 * Where the counter starts when there is no row for a year yet.
 *
 * Not zero, but the highest number already issued for that year. A database
 * restored from a backup, or one where the counter table was lost while the
 * students were not, would otherwise start again at 01 and hand out numbers
 * somebody already has. The counter is the mechanism; this is what makes it
 * safe to lose.
 *
 * Only ids of this scheme are read: four digits of year and branch, then the
 * number. A ten-digit id from the old scheme is a different shape and is left
 * alone, and anything absurd is ignored rather than trusted.
 */
function seed_student_seq(string $yy): int
{
    $rows = fetch_all('SELECT ' . qi('roll') . ' AS roll FROM ' . qi('students')
        . ' WHERE ' . qi('roll') . ' LIKE ?', [$yy . '%']);
    $max = 0;
    foreach ($rows as $r) {
        $roll = trim((string) ($r['roll'] ?? ''));
        $len = strlen($roll);
        if (!ctype_digit($roll) || $len < STUDENT_ID_PREFIX_WIDTH + STUDENT_SEQ_WIDTH
            || $len > STUDENT_ID_PREFIX_WIDTH + 5) {
            continue;
        }
        $n = (int) substr($roll, STUDENT_ID_PREFIX_WIDTH);
        if ($n > $max && $n <= 99999) {
            $max = $n;
        }
    }
    return $max;
}

/**
 * The next number for this year, without taking it. For the preview on the
 * form — it says what would be issued, and the real one is taken on save.
 */
function peek_student_seq(string $yy): int
{
    seq_table();
    $row = fetch_one('SELECT ' . qi('n') . ' AS n FROM ' . qi('_id_seq') . ' WHERE ' . qi('k') . ' = ?',
        ['student:' . $yy]);
    return ($row === null ? seed_student_seq($yy) : (int) ($row['n'] ?? 0)) + 1;
}

/**
 * Take the next number. The UPDATE holds the row for the length of the
 * transaction, so a second request arriving at the same moment waits for this
 * one to commit and then reads the number after it — rather than both reading
 * the same value and both believing it is theirs.
 */
function take_student_seq(string $yy): int
{
    seq_table();
    $key = 'student:' . $yy;
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        $bump = db()->prepare('UPDATE ' . qi('_id_seq') . ' SET ' . qi('n') . ' = ' . qi('n')
            . ' + 1 WHERE ' . qi('k') . ' = ?');
        $bump->execute([$key]);
        if ($bump->rowCount() === 0) {
            // first of the year; a racing insert loses and is retried as an update
            try {
                // starts above whatever this year already holds, not at one
                run_sql('INSERT INTO ' . qi('_id_seq') . ' (' . qi('k') . ', ' . qi('n')
                    . ') VALUES (?, ?)', [$key, seed_student_seq($yy) + 1]);
            } catch (PDOException $e) {
                run_sql('UPDATE ' . qi('_id_seq') . ' SET ' . qi('n') . ' = ' . qi('n')
                    . ' + 1 WHERE ' . qi('k') . ' = ?', [$key]);
            }
        }
        $row = fetch_one('SELECT ' . qi('n') . ' AS n FROM ' . qi('_id_seq') . ' WHERE ' . qi('k') . ' = ?',
            [$key]);
        $n = (int) ($row['n'] ?? 1);
        if ($own) {
            db()->commit();
        }
        return $n;
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
}

/**
 * Hold the allocation lock for one collection until this transaction commits.
 *
 * next_id() looks for a free id and the row is written afterwards; without this
 * a second request slips into that gap, is told the same id, and — because
 * upsert() is INSERT OR REPLACE — overwrites the first row rather than failing.
 * Both callers get a 201 and one record is gone.
 *
 * The row in the counter table is not a counter here, only something to hold.
 * Must be called inside a transaction, or it locks nothing.
 */
function lock_collection(string $col): void
{
    seq_table();
    $key = 'lock:' . $col;
    $take = db()->prepare('UPDATE ' . qi('_id_seq') . ' SET ' . qi('n') . ' = ' . qi('n')
        . ' + 1 WHERE ' . qi('k') . ' = ?');
    $take->execute([$key]);
    if ($take->rowCount() === 0) {
        try {
            run_sql('INSERT INTO ' . qi('_id_seq') . ' (' . qi('k') . ', ' . qi('n')
                . ') VALUES (?, 0)', [$key]);
        } catch (PDOException $e) {
            // somebody else created it in the meantime, which is fine
        }
        $take->execute([$key]);
    }
}

/** YY + branch code + running number, e.g. 250101 */
function format_student_id(string $yy, string $branch, int $seq): string
{
    return $yy . branch_code($branch) . str_pad((string) $seq, STUDENT_SEQ_WIDTH, '0', STR_PAD_LEFT);
}

/**
 * The id this student gets. `admissionDate` is the year the number belongs to;
 * `academicYear` stands in when the date was left blank, and the clock when
 * neither was given.
 */
function issue_student_id(array $row): string
{
    $yy = admission_yy((string) ($row['admissionDate'] ?? ($row['academicYear'] ?? '')));
    return format_student_id($yy, (string) ($row['branchName'] ?? ''), take_student_seq($yy));
}

/**
 * Give a student a different id.
 *
 * Two ways in. With no number, the next one is issued — the answer when a year
 * was typed wrong, and deliberately not the number the mistake consumed, since
 * an id that has been handed out is spent either way. With a number, that one
 * is used: the office sometimes knows which id a student should have and the
 * counter has no way of knowing it.
 *
 * Setting one by hand is the administrator's alone, because it is the only way
 * to put an id somewhere the counter would not have, and the counter is what
 * keeps two students from sharing one.
 *
 * Either way the login moves with the id, because the username is the id.
 */
function api_reissue_student_id(): void
{
    /* Two answers have to agree, exactly as the students page requires: the
       role list says who this is written for, the permission says whether this
       account still may. `may()` alone is too weak — a faculty member's ceiling
       covers the students module because their menu reaches the roll, and a
       teacher has no business renaming a student's login. */
    if (!in_array(base_role(current_role()), ['admin', 'admission'], true)
        || !may('students', 'edit')) {
        send_json(['error' => 'forbidden',
                   'message' => 'Your account cannot change student records.'], 403);
    }
    $body = body();
    $id = trim((string) ($body['id'] ?? ''));
    $wanted = trim((string) ($body['roll'] ?? ''));
    if ($id === '') {
        send_json(['error' => 'invalid', 'message' => 'Which student?'], 422);
    }
    if ($wanted !== '') {
        if (current_role() !== 'admin') {
            send_json(['error' => 'forbidden',
                       'message' => 'Only the administrator can set a Student ID by hand.'], 403);
        }
        if (!ctype_digit($wanted)) {
            send_json(['error' => 'invalid', 'message' => 'A Student ID is digits only.'], 422);
        }
        if (strlen($wanted) < 4 || strlen($wanted) > 12) {
            send_json(['error' => 'invalid',
                       'message' => 'A Student ID is between 4 and 12 digits.'], 422);
        }
    }

    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        lock_collection('students');
        $row = fetch_one('SELECT * FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$id]);
        if (!$row) {
            if ($own) {
                db()->rollBack();
            }
            send_json(['error' => 'not found', 'message' => 'That student is no longer on the roll.'], 404);
        }
        $was = (string) ($row['roll'] ?? '');
        if ($wanted !== '') {
            // checked inside the lock, so nobody can take it between here and the write
            $clash = fetch_one('SELECT ' . qi('name') . ' AS name FROM ' . qi('students')
                . ' WHERE ' . qi('roll') . ' = ? AND ' . qi('id') . ' <> ?', [$wanted, $id]);
            if ($clash) {
                if ($own) {
                    db()->rollBack();
                }
                send_json(['error' => 'taken',
                           'message' => 'Student ID ' . $wanted . ' already belongs to '
                               . ($clash['name'] ?: 'another student') . '.'], 409);
            }
        }
        $now = $wanted !== '' ? $wanted : issue_student_id($row);
        run_sql('UPDATE ' . qi('students') . ' SET ' . qi('roll') . ' = ? WHERE ' . qi('id') . ' = ?',
            [$now, $id]);
        /* The username is the id. Only the student's own login is touched, and
           only if it still carried the old number — an office that had already
           renamed it by hand is left alone. */
        run_sql('UPDATE ' . qi('users') . ' SET ' . qi('username') . ' = ? WHERE ' . qi('refId')
            . ' = ? AND ' . qi('role') . " = 'student' AND " . qi('username') . ' = ?',
            [$now, $id, $was]);
        if ($own) {
            db()->commit();
        }
        send_json(['ok' => true, 'was' => $was, 'roll' => $now]);
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
}

/**
 * Renumber every student's id cleanly, in one transaction.
 *
 * Within each admission year the running number is reassigned 1, 2, 3 … in the
 * students' current-id order, closing the gaps that deletions and hand-typed ids
 * leave behind, and the id keeps its meaning — year, branch code, number. The
 * login username is the id, so it moves with it. Nothing is deleted: only the
 * roll and the matching login are rewritten, and the whole thing commits or
 * rolls back as one, so a student can never be left half-renumbered. The Super
 * Admin alone may run it — it rewrites the id and login of every student.
 */
function api_renumber_students(): void
{
    if (current_role() !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the Super Admin can renumber Student IDs.'], 403);
    }
    $yearOf = fn(array $s) => admission_yy((string) ($s['admissionDate'] ?? ($s['academicYear'] ?? '')));
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        lock_collection('students');
        $students = fetch_all('SELECT * FROM ' . qi('students'));
        // stable order: admission year, then the current id (numeric), then the row id
        usort($students, function ($a, $b) use ($yearOf) {
            $c = strcmp($yearOf($a), $yearOf($b));
            if ($c !== 0) {
                return $c;
            }
            $c = ((int) ($a['roll'] ?? 0)) <=> ((int) ($b['roll'] ?? 0));
            if ($c !== 0) {
                return $c;
            }
            return strcmp((string) ($a['id'] ?? ''), (string) ($b['id'] ?? ''));
        });
        $seqByYear = [];
        $mapping = [];
        foreach ($students as $s) {
            $yy = $yearOf($s);
            $seqByYear[$yy] = ($seqByYear[$yy] ?? 0) + 1;
            $newRoll = format_student_id($yy, (string) ($s['branchName'] ?? ''), $seqByYear[$yy]);
            $oldRoll = (string) ($s['roll'] ?? '');
            if ($newRoll === $oldRoll) {
                continue;                       // already exactly right — leave it
            }
            run_sql('UPDATE ' . qi('students') . ' SET ' . qi('roll') . ' = ? WHERE ' . qi('id') . ' = ?',
                [$newRoll, (string) $s['id']]);
            /* The login username is the id. Scoped to this one student's own
               login (by refId) and only if it still carried the old number, so an
               office that renamed a login by hand is left alone — same rule as a
               single re-issue. */
            run_sql('UPDATE ' . qi('users') . ' SET ' . qi('username') . ' = ? WHERE ' . qi('refId')
                . ' = ? AND ' . qi('role') . " = 'student' AND " . qi('username') . ' = ?',
                [$newRoll, (string) $s['id'], $oldRoll]);
            $mapping[] = ['id' => (string) $s['id'], 'name' => (string) ($s['name'] ?? ''),
                          'was' => $oldRoll, 'roll' => $newRoll];
        }
        // each year's counter continues above the highest number just assigned,
        // so the next admission never collides with a renumbered student
        foreach ($seqByYear as $yy => $max) {
            run_sql('DELETE FROM ' . qi('_id_seq') . ' WHERE ' . qi('k') . ' = ?', ['student:' . $yy]);
            run_sql('INSERT INTO ' . qi('_id_seq') . ' (' . qi('k') . ', ' . qi('n') . ') VALUES (?, ?)',
                ['student:' . $yy, (int) $max]);
        }
        if ($own) {
            db()->commit();
        }
        audit('renumber-students', 'students', '', '',
              count($mapping) . ' of ' . count($students) . ' Student IDs renumbered');
        send_json(['ok' => true, 'changed' => count($mapping), 'total' => count($students), 'mapping' => $mapping]);
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
}

/** how many students on the roll hold an id of this scheme for a year */
function students_in_year(string $yy): int
{
    $rows = fetch_all('SELECT ' . qi('roll') . ' AS roll FROM ' . qi('students')
        . ' WHERE ' . qi('roll') . ' LIKE ?', [$yy . '%']);
    $n = 0;
    foreach ($rows as $r) {
        $roll = trim((string) ($r['roll'] ?? ''));
        $len = strlen($roll);
        // an id of the current scheme, not one from the old
        if (ctype_digit($roll) && $len >= STUDENT_ID_PREFIX_WIDTH + STUDENT_SEQ_WIDTH
            && $len <= STUDENT_ID_PREFIX_WIDTH + 5) {
            $n++;
        }
    }
    return $n;
}

/** every year the counter knows about, what it would issue next, and who is in the way */
function api_student_seq(): void
{
    if (base_role(current_role()) !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the administrator manages ID numbering.'], 403);
    }
    seq_table();
    $rows = fetch_all('SELECT ' . qi('k') . ' AS k, ' . qi('n') . ' AS n FROM ' . qi('_id_seq')
        . ' WHERE ' . qi('k') . " LIKE 'student:%'");
    $out = [];
    foreach ($rows as $r) {
        $yy = substr((string) $r['k'], strlen('student:'));
        $out[] = [
            'yy'       => $yy,
            'year'     => '20' . $yy,
            'issued'   => (int) $r['n'],
            'next'     => (int) $r['n'] + 1,
            'students' => students_in_year($yy),
        ];
    }
    usort($out, fn($a, $b) => strcmp($b['yy'], $a['yy']));
    send_json($out);
}

/**
 * Start a year's numbering again.
 *
 * Refused while any student holds an id for that year — that is what makes this
 * safe rather than merely warned about. Delete the practice records first and
 * the year begins at 01 again.
 */
function api_reset_student_seq(): void
{
    if (base_role(current_role()) !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the administrator manages ID numbering.'], 403);
    }
    $yy = admission_yy((string) (body()['year'] ?? ''));
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        lock_collection('students');
        $held = students_in_year($yy);
        if ($held > 0) {
            if ($own) {
                db()->rollBack();
            }
            send_json([
                'error'   => 'in-use',
                'held'    => $held,
                'message' => $held . ' student(s) still have a 20' . $yy . ' ID. '
                    . 'Delete them first, or their numbers would be given out twice.',
            ], 409);
        }
        run_sql('DELETE FROM ' . qi('_id_seq') . ' WHERE ' . qi('k') . ' = ?', ['student:' . $yy]);
        if ($own) {
            db()->commit();
        }
        send_json(['ok' => true, 'year' => '20' . $yy]);
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
}

/* ---------------- the public admission form ----------------
   Everything the form may set. A field not on this list is dropped, so the
   shape of what lands in the queue is decided here and not by the caller. */
/* The qualification rows, keyed the way the form names them. The same list
   the app holds in QUAL_LEVELS — a level added there is added here, and the
   slug is what keeps the field names readable. */
const APPLY_QUALS = [
    'q10' => '10th', 'q12' => '12th', 'qiti' => 'ITI', 'qdip' => 'Diploma',
    'qp3' => '+3', 'qbca' => 'BCA', 'qbba' => 'BBA', 'qbtech' => 'B.Tech',
    'qother' => 'Other',
];
/* Nobody applying for an MBA passed their tenth before this, so a year below
   it is a digit typed wrongly rather than a long life. Matches QUAL_YEAR_FLOOR
   in js/app.js. */
const QUAL_YEAR_FLOOR = 1950;
/** the three blocks the admission form keeps, and what each one is asked */
const APPLY_GUARDIANS = ['father' => 'Father', 'mother' => 'Mother', 'guardian' => 'Local Guardian'];
const APPLY_GUARDIAN_FIELDS = ['Name', 'Occupation', 'Mobile', 'Phone', 'Income',
                               'Email', 'Qualification', 'Address'];

/* Everything the form may set. Built from the same lists the form renders, so
   a field on the page is a field that survives the trip and one that is not
   cannot be smuggled in.

   Deliberately absent: the mentor the office assigns, the CGPA and backlogs it
   records, the biometric scan it takes, the originals it files, and the photo —
   an image posted to an open endpoint is a way to fill a database with
   something other than students. */
function apply_fields(): array
{
    static $fields = null;
    if ($fields !== null) {
        return $fields;
    }
    $f = [
        'roll', 'title', 'firstName', 'middleName', 'lastName',
        'email', 'domainEmail', 'phone', 'whatsapp',
        'course', 'branchName', 'specialisation', 'specialisation2', 'semester', 'section',
        'batch', 'house', 'admissionDate',
        'dob', 'gender', 'bloodGroup', 'aadhaar', 'univRegNo', 'admissionCategory', 'religion',
        'nationality', 'birthplace', 'identificationMark', 'hostel', 'transport',
        'nss', 'voterId', 'pan', 'drivingLicense', 'passport', 'languages', 'hobbies',
        'entranceExam', 'entranceRank',
        'address', 'state', 'district', 'city', 'country', 'pincode',
        'permAddress', 'permState', 'permDistrict', 'permCity', 'permCountry', 'permPincode',
        'height', 'weight', 'allergies', 'conditions', 'medication', 'healthNotes',
        'emergencyName', 'emergencyPhone',
    ];
    foreach (array_keys(APPLY_QUALS) as $q) {
        foreach (['Stream', 'Institute', 'Year', 'Marks'] as $part) {
            $f[] = $q . $part;
        }
    }
    foreach (array_keys(APPLY_GUARDIANS) as $g) {
        foreach (APPLY_GUARDIAN_FIELDS as $part) {
            $f[] = $g . $part;
        }
    }
    return $fields = $f;
}

/** trimmed, length-capped, and never trusted to be a string in the first place */
function apply_clean($v, int $max = 255): string
{
    if (is_array($v) || is_object($v)) {
        return '';
    }
    $s = trim((string) $v);
    // control characters have no business in a name or an address
    $s = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $s);
    return function_exists('mb_substr') ? mb_substr($s, 0, $max) : substr($s, 0, $max);
}

/**
 * The pending form already waiting for this person, or null.
 *
 * Any one of the four identifiers is enough. A form filled in twice used to
 * queue a second row unless the second attempt repeated the same registration
 * number — so somebody who came back and added their registration number, or
 * gave their email instead, was reviewed twice as two people. They are one
 * person however they identify themselves.
 *
 * Only pending rows: a form already approved or rejected is history, and
 * somebody applying again after a rejection deserves a row of their own.
 */
function pending_submission_for(string $roll, string $ureg, string $phone, string $email): ?array
{
    foreach ([['roll', $roll], ['data->univRegNo', $ureg], ['phone', $phone], ['email', $email]] as [$col, $val]) {
        $val = trim($val);
        if ($val === '') {
            continue;
        }
        if ($col === 'data->univRegNo') {
            /* The university number is inside the submitted blob, not a column
               of its own, so it is matched by reading the pending rows. There
               are never many: the queue is capped and this only runs when the
               applicant gave one. */
            $rows = fetch_all('SELECT * FROM ' . qi('submissions')
                . ' WHERE ' . qi('status') . " = 'Pending'");
            foreach ($rows as $r) {
                $d = json_decode((string) ($r['data'] ?? ''), true);
                if (is_array($d) && strcasecmp(trim((string) ($d['univRegNo'] ?? '')), $val) === 0) {
                    return $r;
                }
            }
            continue;
        }
        $hit = fetch_one('SELECT * FROM ' . qi('submissions') . ' WHERE LOWER(' . qi($col)
            . ') = LOWER(?) AND ' . qi('status') . " = 'Pending'", [$val]);
        if ($hit) {
            return $hit;
        }
    }
    return null;
}

/**
 * A student filling in the public form. No token, so everything about the row
 * that matters — its status, its timestamps, which table it lands in — is
 * decided here.
 */
function api_apply(): void
{
    $d = body();

    /* A field no human sees and no human fills. A script that posts every input
       it finds fills it, and says so. Answered with 201 rather than an error,
       because telling a bot it was caught is telling it what to change. */
    if (apply_clean($d['website'] ?? '') !== '') {
        send_json(['ok' => true], 201);
    }

    /* The registration number is optional: somebody applying for admission does
       not have one yet, and the college issues it rather than the applicant. */
    $roll = apply_clean($d['roll'] ?? '', 40);
    $first = apply_clean($d['firstName'] ?? '', 80);
    $phone = preg_replace('/\D/', '', apply_clean($d['phone'] ?? '', 20));
    if ($first === '') {
        send_json(['error' => 'incomplete', 'message' => 'Your first name is required.'], 422);
    }
    if (!preg_match(MOBILE_RE, $phone)) {
        send_json(['error' => 'bad-phone', 'message' => BAD_MOBILE], 422);
    }
    $whatsapp = preg_replace('/\D/', '', apply_clean($d['whatsapp'] ?? '', 20));
    if ($whatsapp !== '' && !preg_match(MOBILE_RE, $whatsapp)) {
        send_json(['error' => 'bad-phone',
                   'message' => 'Please enter a valid 10-digit WhatsApp number.'], 422);
    }
    /* Written back into $d, not just tested: what is stored has to be the
       blank as well, or "NA" is filed as the address and refused again on the
       day the office approves the row. */
    foreach (['email', 'domainEmail'] as $f) {
        $d[$f] = blank_if_not_applicable(apply_clean($d[$f] ?? '', 120));
        if (!email_ok($d[$f])) {
            send_json(['error' => 'bad-email', 'message' => BAD_EMAIL], 422);
        }
    }
    $email = $d['email'];
    /* An emergency contact that is the applicant's own number is not an
       emergency contact, and the office cannot ring back to ask. */
    $emergency = preg_replace('/\D/', '', apply_clean($d['emergencyPhone'] ?? '', 20));
    if ($emergency !== '' && !preg_match(MOBILE_RE, $emergency)) {
        send_json(['error' => 'bad-emergency', 'message' => BAD_EMERGENCY], 422);
    }
    if ($emergency !== '' && $emergency === $phone) {
        send_json(['error' => 'same-number', 'message' => SAME_NUMBER], 422);
    }
    /* The university's number, if they have one. The shape is checked here —
       the browser's copy of this rule is a courtesy and anything can post to
       this endpoint. Whether somebody else already holds it is not checked
       here on purpose: the same link is given to students already on the roll,
       and one re-sending their own details must not be turned away for holding
       their own number. That check happens when the office approves the row. */
    $ureg = apply_clean($d['univRegNo'] ?? '', 20);
    if ($ureg !== '' && !preg_match('/^\d{10}$/', $ureg)) {
        send_json(['error' => 'bad-univreg',
                   'message' => 'University Regd. No. must be exactly 10 digits, or left blank.'], 422);
    }

    /* One person, one form. A mobile number or email already sitting in the
       queue — or already approved into a student — cannot be used to send a
       second form: an applicant applies once, and a wrong detail on a pending
       form is fixed by the office, not by filing another. A form that was
       rejected does not block a fresh attempt — somebody turned away may
       reasonably apply again — so only Pending and Approved rows count here. */
    $clash = null;
    if (fetch_one('SELECT ' . qi('id') . ' FROM ' . qi('submissions') . ' WHERE '
            . qi('phone') . ' = ? AND ' . qi('status') . " IN ('Pending','Approved')", [$phone])) {
        $clash = 'mobile number';
    } elseif ($email !== '' && fetch_one('SELECT ' . qi('id') . ' FROM ' . qi('submissions') . ' WHERE LOWER('
            . qi('email') . ') = LOWER(?) AND ' . qi('status') . " IN ('Pending','Approved')", [$email])) {
        $clash = 'email address';
    }
    if ($clash !== null) {
        send_json([
            'error'   => 'duplicate',
            'message' => 'A form has already been submitted with this ' . $clash
                       . '. You can apply only once — if a detail is wrong, please contact the admission office.',
        ], 409);
    }

    /* A passout year is four digits or it is nothing. The form says so too;
       this is here because the form is not the only way to reach this
       endpoint, and a half-typed year would be filed as the year passed. */
    $latestYear = (int) date('Y') + 1;
    foreach (APPLY_QUALS as $q => $label) {
        $year = apply_clean($d[$q . 'Year'] ?? '', 4);
        if ($year === '') {
            continue;
        }
        if (!preg_match('/^\d{4}$/', $year)
            || (int) $year < QUAL_YEAR_FLOOR || (int) $year > $latestYear) {
            send_json(['error' => 'bad-qual-year',
                       'message' => $label . ' passout year must be a 4-digit year between '
                                    . QUAL_YEAR_FLOOR . ' and ' . $latestYear . '.'], 422);
        }
    }

    attempts_table();
    $now = time();

    /* A machine, not a crowd. Set high enough that a hall full of students
       filling this in at once never reaches it. */
    $key = 'apply:' . client_ip();
    $row = fetch_one('SELECT * FROM ' . qi('_login_attempts') . ' WHERE ' . qi('k') . ' = ?', [$key]);
    $count = ($row && $now - (int) ($row['first_at'] ?? 0) < 3600) ? (int) ($row['fails'] ?? 0) : 0;
    if ($count >= APPLY_MAX_PER_HOUR) {
        send_json(['error' => 'too-many',
                   'message' => 'Too many submissions from this connection. Please try again later.'], 429);
    }

    // and a ceiling on the queue itself, so it cannot be filled up indefinitely
    $pending = (int) (fetch_one('SELECT COUNT(*) AS c FROM ' . qi('submissions')
        . ' WHERE ' . qi('status') . " = 'Pending'")['c'] ?? 0);
    if ($pending >= APPLY_MAX_PENDING) {
        send_json(['error' => 'queue-full',
                   'message' => 'The form is not accepting entries right now. Please contact the office.'], 503);
    }

    $long = ['address', 'permAddress', 'allergies', 'conditions', 'medication', 'healthNotes',
             'fatherAddress', 'motherAddress', 'guardianAddress'];
    $data = [];
    foreach (apply_fields() as $f) {
        $v = apply_clean($d[$f] ?? '', in_array($f, $long, true) ? 500 : 255);
        if ($v !== '') {
            $data[$f] = $v;
        }
    }
    /* The photograph is a data URL — tens of kilobytes where every other answer
       is a line of text — so it is taken whole rather than clipped at 255, and
       capped instead. The page scales it to 400px before sending; anything past
       half a megabyte did not come from that page and is refused rather than
       stored. */
    $photo = trim((string) ($d['photo'] ?? ''));
    if ($photo !== '') {
        if (strlen($photo) > 512000 || !preg_match('~^data:image/(jpeg|png|webp);base64,~', $photo)) {
            send_json(['error' => 'bad-photo',
                       'message' => 'That photo could not be read. Please choose another.'], 422);
        }
        $data['photo'] = $photo;
    }
    if ($roll !== '') {
        $data['roll'] = $roll;
    }
    $data['phone'] = $phone;

    $name = trim(implode(' ', array_filter([
        apply_clean($d['firstName'] ?? '', 80),
        apply_clean($d['middleName'] ?? '', 80),
        apply_clean($d['lastName'] ?? '', 80),
    ])));

    /* Whether this is somebody already on the roll. The form no longer asks
       for a Student ID — the college issues it, and asking a student to copy it
       back confused everyone — so the university registration number does the
       work: a real number they carry, unique by rule and ten digits by the time
       it gets here. A Student ID still counts when one arrives through the API.

       A phone number deliberately does not: two students may share a parent's,
       and being wrong here puts one person's form on another person's record.
       Where neither number is given the review screen flags a likely match
       instead, and a person decides. */
    $existing = null;
    if ($roll !== '') {
        $existing = fetch_one('SELECT ' . qi('id') . ' FROM ' . qi('students')
            . ' WHERE LOWER(' . qi('roll') . ') = LOWER(?)', [$roll]);
    }
    if (!$existing && $ureg !== '') {
        $existing = fetch_one('SELECT ' . qi('id') . ' FROM ' . qi('students')
            . ' WHERE ' . qi('univRegNo') . ' = ?', [$ureg]);
    }

    /* Filling it in twice replaces the first attempt rather than queuing two.
       Matched on the registration number when there is one and on the phone
       number when there is not — which is why the form insists on a phone.
       Only while it is still pending: a row already dealt with is history. */
    $prior = pending_submission_for($roll, $ureg, $phone, $email);

    /* The second form fills gaps in the first, it does not empty them. A later
       answer wins; a blank means "not answered this time", not "delete it".
       Without this, a partial second attempt wiped the identifiers the queue
       matches people by, and their third attempt was queued as a stranger. */
    if ($prior) {
        $was = json_decode((string) ($prior['data'] ?? ''), true);
        if (is_array($was)) {
            foreach ($was as $k => $v) {
                if (!isset($data[$k]) || trim((string) $data[$k]) === '') {
                    $data[$k] = $v;
                }
            }
        }
        $keep = fn(string $now, string $before) => $now !== '' ? $now : trim((string) $before);
        $roll  = $keep($roll, $prior['roll'] ?? '');
        $email = $keep($email, $prior['email'] ?? '');
        $name  = $keep($name, $prior['name'] ?? '');
        $data['roll'] = $roll;
        $data['email'] = $email;
    }

    $out = [
        'id'          => $prior ? $prior['id'] : next_id('submissions'),
        'roll'        => $roll,
        'name'        => $name !== '' ? $name : $roll,
        'email'       => $email,
        'phone'       => $phone,
        'course'      => $data['course'] ?? '',
        'branchName'  => $data['branchName'] ?? '',
        'semester'    => $data['semester'] ?? '',
        'status'      => 'Pending',
        'submittedAt' => date('c'),
        'reviewedAt'  => '',
        'reviewedBy'  => '',
        'reviewNote'  => '',
        'kind'        => $existing ? 'update' : 'new',
        'data'        => $data,
    ];
    upsert('submissions', $out);

    // counted after the write, so a rejected submission does not count against them
    if ($row) {
        run_sql('UPDATE ' . qi('_login_attempts') . ' SET ' . qi('fails') . ' = ?, '
            . qi('first_at') . ' = ? WHERE ' . qi('k') . ' = ?',
            [$count + 1, $count === 0 ? $now : (int) ($row['first_at'] ?? $now), $key]);
    } else {
        run_sql('INSERT INTO ' . qi('_login_attempts') . ' (' . qi('k') . ', ' . qi('fails')
            . ', ' . qi('first_at') . ', ' . qi('locked_until') . ') VALUES (?, ?, ?, 0)',
            [$key, 1, $now]);
    }

    // deliberately says nothing about what is on the roll already
    send_json(['ok' => true, 'reference' => $out['id']], 201);
}

/* Collections whose every change is worth a line. The rest — a timetable
   slot, a library issue — are ordinary daily traffic and would bury the
   entries that matter. */
/* The records worth being able to undo a deletion of: people, money, the
   forms they arrived on. A deleted one of these is moved to the trash instead
   of being erased, and the administrator can put it back. High-churn tables
   whose deletions are routine (a timetable slot, a day of attendance) are left
   out; trashing every one of those would bury the deletions that matter. */
const SOFT_DELETE = ['students', 'faculty', 'accountants', 'centerheads',
                     'placementofficers', 'coordinators', 'admissions', 'users',
                     'courses', 'fees', 'marks', 'submissions'];

function trash_table(): void
{
    static $done = false;
    if ($done) { return; }
    $done = true;
    $t = qi('_trash');
    $kType = driver() === 'mysql' ? 'VARCHAR(190)' : 'TEXT';
    $iType = driver() === 'pgsql' ? 'BIGINT' : 'INTEGER';
    $txt = driver() === 'mysql' ? 'LONGTEXT' : 'TEXT';
    db()->exec("CREATE TABLE IF NOT EXISTS $t (" . qi('id') . " $kType PRIMARY KEY, "
        . qi('col') . " $kType, " . qi('rowId') . " $kType, " . qi('data') . " $txt, "
        . qi('deletedBy') . " $kType, " . qi('deletedByName') . " $kType, "
        . qi('deletedAt') . " $iType)");
}

const AUDITED = ['students', 'users', 'roles', 'faculty', 'accountants', 'centerheads',
                 'placementofficers', 'coordinators', 'admissions', 'fees', 'payments',
                 'fixedfees', 'assets', 'settings', 'submissions', 'marks'];

/* Never written to the log, whatever a caller sends. A password hash in an
   audit trail is a password hash in one more place. */
const AUDIT_NEVER = ['password', 'token', 'photo'];

/**
 * One line of the record.
 *
 * Deliberately unable to fail the request it is describing: a log that can
 * refuse a save would be a log people ask to have switched off. If it cannot
 * be written the server says so in its own error log and the work goes on.
 */
function audit(string $action, string $subjectType, string $subjectKey,
               string $subjectName = '', string $summary = '', array $changes = [],
               ?array $actor = null): void
{
    try {
        /* Signing in has no caller yet — the token is issued by the line that
           follows it — so that one line names the account it let in. */
        $me = $actor ?? current_user();
        run_sql('INSERT INTO ' . qi('auditlog') . ' (' . qi('id') . ', ' . qi('at') . ', '
            . qi('actorId') . ', ' . qi('actorName') . ', ' . qi('subjectType') . ', '
            . qi('subjectKey') . ', ' . qi('subjectName') . ', ' . qi('summary') . ', '
            . qi('changes') . ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
                /* Milliseconds first so the id sorts the way the events
                   happened, then randomness so two in the same millisecond
                   cannot collide. */
                'LOG' . str_pad(dechex((int) round(microtime(true) * 1000)), 12, '0', STR_PAD_LEFT)
                    . bin2hex(random_bytes(4)),
                gmdate('c'),
                (string) ($me['id'] ?? ''),
                (string) ($me['name'] ?? ($me['username'] ?? 'anonymous')),
                $subjectType,
                $subjectKey,
                $subjectName,
                $action . ($summary === '' ? '' : ' — ' . $summary),
                json_encode(array_merge($changes, ['action' => $action, 'ip' => client_ip()])),
            ]);
    } catch (Throwable $e) {
        error_log('[nmiet-api] audit: ' . $e->getMessage());
    }
}

/** what actually changed, without the values nobody should keep a copy of */
function audit_diff(array $before, array $after): array
{
    $out = [];
    foreach ($after as $k => $v) {
        if (in_array($k, AUDIT_NEVER, true)) {
            // recorded as having changed, never with what it changed to
            if ((string) ($before[$k] ?? '') !== (string) $v) {
                $out[$k] = ['from' => '(hidden)', 'to' => '(hidden)'];
            }
            continue;
        }
        $was = $before[$k] ?? null;
        $is = $v;
        $flat = fn($x) => is_scalar($x) || $x === null ? (string) $x : json_encode($x);
        if ($flat($was) !== $flat($is)) {
            $out[$k] = ['from' => mb_substr($flat($was), 0, 120),
                        'to'   => mb_substr($flat($is), 0, 120)];
        }
    }
    return $out;
}

/** the name a line should carry for a record, so the log reads without joins */
function audit_name(string $col, array $row): string
{
    foreach (['name', 'title', 'username', 'roll'] as $k) {
        if (!empty($row[$k]) && is_string($row[$k])) {
            return $row[$k];
        }
    }
    return '';
}

/**
 * A full snapshot of the records, for the administrator to keep.
 *
 * Read-only — it opens nothing and writes nothing, so it cannot break what is
 * running. Every collection, each row as the API hands it out, which means
 * password hashes and session tokens are NOT in it: a backup is a copy of the
 * college's records, not of its keys, and a stray copy of a hash is one more
 * place it can leak from. Logins come back on restore by being set again.
 *
 * The admin alone, checked here rather than by the collection guard, because
 * this is not a collection.
 */
function api_backup(): void
{
    if (current_role() !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the administrator can download a backup.'], 403);
    }
    $out = [
        'app'         => 'nmiet-cms',
        'kind'        => 'backup',
        'generatedAt' => gmdate('c'),
        'by'          => (string) (current_user()['name'] ?? current_user()['username'] ?? ''),
        'collections' => [],
    ];
    foreach (array_keys(COLLECTIONS) as $col) {
        $rows = fetch_all('SELECT * FROM ' . qi($col));
        $out['collections'][$col] = array_map(fn($r) => row_out($col, $r), $rows);
    }
    audit('backup', 'system', 'backup', '', count($out['collections']) . ' collections');
    send_json($out);
}

function api_bootstrap(): void
{
    $data = bootstrap_data();
    /* Lean mode: the photographs are blanked and left to /api/photos, a separate
       request the browser can cache. Sending them inline made the first load
       after sign-in drag every student's photo down before the app could paint —
       the single biggest reason signing in felt slow. A `hasPhoto` flag stays so
       the browser knows whose photo to expect. Only a caller that asks for lean
       gets it; an older cached app.js, or the moments mid-deploy when the two
       halves disagree, still receive photos inline and keep working. */
    if (isset($_GET['lean'])) {
        foreach ($data as &$rows) {
            foreach ($rows as &$r) {
                if (array_key_exists('photo', $r)) {
                    $r['hasPhoto'] = ($r['photo'] !== '' && $r['photo'] !== null);
                    $r['photo'] = '';
                }
            }
            unset($r);
        }
        unset($rows);
    }
    send_json($data);
}

/* Everything this caller may see, in the shape the browser caches. Split out of
   api_bootstrap so the signature endpoint below can build the very same picture
   and fingerprint it, rather than a second copy of the read rules drifting from
   this one. */
function bootstrap_data(): array
{
    /* A custom-access account is let through the area switches below so a module
       it *was* granted is not emptied by a rule meant for other roles; the
       per-account read gate right after decides what it actually receives. */
    $isSub = has_custom_access();
    $finance = may_read_finance() || $isSub;
    $staff = may_touch_staff() || $isSub;
    $placement = may_read_placement() || $isSub;
    $isPo = is_placement_officer();
    $out = [];
    $isAdmin = current_role() === 'admin';
    foreach (COLLECTIONS as $col => $_) {
        // tickets are served per caller by the helpdesk endpoints, never in bulk
        if (in_array($col, TICKET_TABLES, true)) {
            continue;
        }
        /* Every session needs the role table: it is how the browser works out
           what its own account may do, and it holds no data about anybody —
           only which boxes are ticked for which role. The audit log does name
           people, so it goes to the admin alone. */
        if (!role_may_read($col)) {
            $out[$col] = [];
            continue;
        }
        /* The Admin sees only the collections its granted modules cover; the
           rest arrive empty, so no unauthorised data reaches the page at all. */
        if ($isSub && !subadmin_may_read($col)) {
            $out[$col] = [];
            continue;
        }
        if ($col === 'roles' || $col === 'auditlog') {
            $rows = ($col === 'roles' || $isAdmin) ? fetch_all('SELECT * FROM ' . qi($col)) : [];
            $out[$col] = array_map(fn($r) => row_out($col, $r), $rows);
            continue;
        }
        // a student/faculty/librarian session gets the financial tables as empty
        // lists rather than a 403, so the rest of their bootstrap still works
        if ($isPo && !placement_officer_may_read($col)) {
            $out[$col] = [];
            continue;
        }
        if ($col === 'syllabus' && in_array(current_user()['role'] ?? '', SYLLABUS_HIDDEN_ROLES, true)) {
            $out[$col] = [];
            continue;
        }
        if (!$placement && in_array($col, PLACEMENT_COLLECTIONS, true)) {
            // a student still gets the drives on offer and their own records;
            // scope_rows below is what keeps other students' rows out
            $isStudent = current_role() === 'student';
            if (!$isStudent || !in_array($col, array_merge(PLACEMENT_STUDENT_OPEN, PLACEMENT_STUDENT_OWN), true)) {
                $out[$col] = [];
                continue;
            }
        }
        if (!$finance && in_array($col, FINANCE_COLLECTIONS, true)) {
            $out[$col] = [];
            continue;
        }
        if (!$staff && in_array($col, STAFF_COLLECTIONS, true)) {
            $out[$col] = [];
            continue;
        }
        $rows = scope_rows($col, fetch_all('SELECT * FROM ' . qi($col)));
        $out[$col] = array_map(fn($r) => row_out($col, $r), $rows);
    }
    return $out;
}

/* The heavy fields a live-refresh fingerprint deliberately ignores: photos are
   big to hash and almost never the thing that quietly changed under a page that
   is just sitting open. A manual refresh or a page change still pulls a new one
   in, so leaving them out of the fingerprint costs nothing anyone would notice. */
const SIGNATURE_SKIP_FIELDS = ['photo'];

/**
 * A tiny fingerprint of everything this caller can see. The browser polls it
 * every few seconds to answer one question — "has anything changed?" — without
 * pulling the whole payload, photos and all, down the wire each time. Only when
 * the fingerprint moves does the browser fetch a fresh bootstrap.
 */
function api_signature(): void
{
    $data = bootstrap_data();
    $parts = [];
    foreach ($data as $col => $rows) {
        $light = array_map(function ($r) {
            foreach (SIGNATURE_SKIP_FIELDS as $f) {
                unset($r[$f]);
            }
            return $r;
        }, $rows);
        $parts[] = $col . ':' . count($rows) . ':' . hash('crc32b', (string) json_encode($light));
    }
    send_json(['sig' => implode(';', $parts)]);
}

/**
 * Every photograph this caller may see, keyed by collection then id, in one
 * request the browser pulls once after sign-in and caches — rather than dragging
 * the same bytes down inline on every bootstrap. Same read scope as the
 * bootstrap, since it is built from exactly the same rows.
 */
function api_photos(): void
{
    $data = bootstrap_data();
    $out = [];
    foreach ($data as $col => $rows) {
        foreach ($rows as $r) {
            if (!empty($r['photo'])) {
                $out[$col][(string) ($r['id'] ?? '')] = $r['photo'];
            }
        }
    }
    send_json($out);
}

/* ---------------- a student applying to a drive ----------------
   A drive's CGPA, backlog and specialisation criteria are shown to the student
   and to the placement cell, but they decide nothing: the cell puts people
   forward. So nothing here reads them. */

/**
 * The only write a student is allowed to make. Returns the row to store —
 * built here rather than taken from the request, so a hand-made payload
 * cannot set a status, backdate itself or belong to somebody else.
 */
function guard_student_application(array $d): array
{
    $sid = current_user()['refId'] ?? null;
    $student = $sid ? fetch_one('SELECT * FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$sid]) : null;
    if (!$student) {
        send_json(['error' => 'forbidden', 'message' => 'This login is not linked to a student record.'], 403);
    }

    $drive = fetch_one('SELECT * FROM ' . qi('drives') . ' WHERE ' . qi('id') . ' = ?', [$d['driveId'] ?? '']);
    if (!$drive) {
        send_json(['error' => 'not found', 'message' => 'That drive no longer exists.'], 404);
    }
    if (!in_array((string) ($drive['status'] ?? ''), DRIVE_OPEN_STATUS, true)) {
        send_json(['error' => 'closed', 'message' => 'Applications for this drive are closed.'], 403);
    }
    $end = trim((string) ($drive['appEndDate'] ?? ''));
    if ($end !== '' && $end < date('Y-m-d')) {
        send_json(['error' => 'closed', 'message' => 'The last date to apply for this drive has passed.'], 403);
    }

    $already = fetch_one(
        'SELECT * FROM ' . qi('applications') . ' WHERE ' . qi('studentId') . ' = ? AND ' . qi('driveId') . ' = ?',
        [$sid, $drive['id']]
    );
    if ($already) {
        send_json(['error' => 'duplicate', 'message' => 'You have already applied to this drive.'], 409);
    }

    /* A drive's CGPA, backlog and specialisation criteria are not a gate. They
       are shown to the student and to the cell, and the cell decides who goes
       forward — so an application is taken either way. What is still enforced
       is that the drive is open, its closing date has not passed, and nobody
       applies to the same drive twice. */

    return [
        'studentId' => $sid,
        'driveId'   => $drive['id'],
        'appliedOn' => date('Y-m-d'),
        'status'    => 'Applied',
        'updatedBy' => current_user()['id'] ?? null,
        'updatedOn' => date('Y-m-d'),
    ];
}

/* ---------------- what a stored row has to look like ----------------
   The browser checks these too, so a person is told at the keyboard rather
   than by a 422. These exist because the browser is not the only way in:
   the bulk upload, a script, and anyone holding the URL all arrive here. */

/** Every field on this collection that holds a phone number. */
const PHONE_FIELDS = [
    'students' => ['phone'], 'faculty' => ['phone'], 'accountants' => ['phone'],
    'centerheads' => ['phone'], 'placementofficers' => ['phone'],
    'coordinators' => ['phone'], 'companies' => ['hrPhone', 'coordinatorPhone'],
];

/**
 * The complaint about this row, or null when it is fine. `$id` is the row
 * being updated, so a record does not clash with itself.
 */
/**
 * What is wrong with this row, or null.
 *
 * `$issued` says the student id came from issue_student_id() rather than from
 * a person. The digits-and-length rule describes what somebody typing a number
 * should type, and nobody types one now — an issued id is correct by the rule
 * that made it, and only has to be unique.
 */
/* An Indian mobile is ten digits and starts with 6, 7, 8 or 9. Ten digits alone
   was the old rule, which let 0000000000 through — a placeholder somebody typed
   to get past a form, found months later by whoever tried to ring them. */
const MOBILE_RE = '/^[6-9]\d{9}$/';
/* Local part, one @, a domain with a dot and nothing empty either side of it.
   Refuses "student@", "student.com", "@gmail.com" and "student gmail.com". */
const EMAIL_RE = '/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/';

const BAD_MOBILE = 'Please enter a valid 10-digit mobile number.';
const BAD_EMERGENCY = 'Please enter a valid 10-digit emergency contact number.';
const BAD_EMAIL = 'Please enter a valid email address.';
const SAME_NUMBER = 'Student mobile number and emergency contact number cannot be the same.';
const SAME_NUMBER_STAFF = 'Mobile number and emergency contact number cannot be the same.';

function mobile_ok(string $v): bool
{
    return $v === '' || (bool) preg_match(MOBILE_RE, $v);
}

function email_ok(string $v): bool
{
    return $v === '' || (bool) preg_match(EMAIL_RE, $v);
}

/* How people write "I do not have one" in a box they were told they could
   leave blank. None of it is an address, so an optional one holding it is
   read as the blank it means rather than refusing the whole form. Matches
   NOT_APPLICABLE in js/app.js and form.html. */
const NOT_APPLICABLE_RE = '/^(n\.?\s*\/?\s*a\.?|not\s*applicable|nil|none|no|-{1,3}|\.)$/i';

function blank_if_not_applicable(string $v): string
{
    $t = trim($v);
    return preg_match(NOT_APPLICABLE_RE, $t) ? '' : $t;
}

/** a value out of one of the record's JSON blobs, whichever shape it arrived in */
function blob_value(array $d, string $blob, string $key): ?string
{
    if (!array_key_exists($blob, $d)) {
        return null;                      // not part of this write at all
    }
    $part = $d[$blob];
    if (is_string($part)) {
        $part = json_decode($part, true);  // a bulk write can send it encoded
    }
    if (!is_array($part) || !array_key_exists($key, $part)) {
        return null;
    }
    return trim((string) $part[$key]);
}

/** the stored row, for the fields a partial update did not send */
function stored_row(string $col, ?string $id): array
{
    if ($id === null) {
        return [];
    }
    $row = fetch_one('SELECT * FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id]);
    return is_array($row) ? $row : [];
}

/**
 * The mobile number, the emergency number, and the rule that they differ.
 *
 * Both are resolved against the stored record first, so that changing only one
 * of them still cannot end with a student whose emergency contact is their own
 * number — which is a student with no emergency contact.
 */
function contact_problem(string $col, array $d, ?string $id): ?string
{
    $sendsPhone = array_key_exists('phone', $d);
    $emergency = blob_value($d, 'health', 'emergencyPhone');
    if (!$sendsPhone && $emergency === null) {
        return null;
    }
    $stored = stored_row($col, $id);
    $phone = $sendsPhone ? trim((string) $d['phone']) : trim((string) ($stored['phone'] ?? ''));
    if ($emergency === null) {
        $health = json_decode((string) ($stored['health'] ?? ''), true);
        $emergency = is_array($health) ? trim((string) ($health['emergencyPhone'] ?? '')) : '';
    }
    if (!mobile_ok($phone)) {
        return BAD_MOBILE;
    }
    if (!mobile_ok($emergency)) {
        return BAD_EMERGENCY;
    }
    if ($phone !== '' && $phone === $emergency) {
        return $col === 'students' ? SAME_NUMBER : SAME_NUMBER_STAFF;
    }
    return null;
}

/** whoever else already holds this address, as a message, or null */
function email_taken(string $col, string $field, string $value, ?string $id): ?string
{
    if (trim($value) === '') {
        return null;
    }
    // an employee's address spans all six staff tables; everything else is its own
    $tables = in_array($col, STAFF_TABLES, true) ? STAFF_TABLES : [$col];
    foreach ($tables as $table) {
        $sql = 'SELECT * FROM ' . qi($table) . ' WHERE LOWER(' . qi($field) . ') = LOWER(?)';
        $args = [trim($value)];
        if ($id !== null && $table === $col) {
            $sql .= ' AND ' . qi('id') . ' <> ?';
            $args[] = $id;
        }
        $clash = fetch_one($sql, $args);
        if ($clash) {
            return 'The email address ' . trim($value) . ' already belongs to '
                . ($clash['name'] ?? 'another record') . '.';
        }
    }
    return null;
}

function row_problem(string $col, array $d, ?string $id = null, bool $issued = false): ?string
{
    foreach (PHONE_FIELDS[$col] ?? [] as $field) {
        if (!array_key_exists($field, $d)) {
            continue;
        }
        // blank is allowed — half the staff records have no number on file
        if (!mobile_ok(trim((string) ($d[$field] ?? '')))) {
            return BAD_MOBILE;
        }
    }
    if (array_key_exists('whatsapp', $d) && !mobile_ok(trim((string) $d['whatsapp']))) {
        return 'Please enter a valid 10-digit WhatsApp number.';
    }

    foreach (EMAIL_FIELDS[$col] ?? [] as $field) {
        if (array_key_exists($field, $d) && !email_ok(trim((string) ($d[$field] ?? '')))) {
            return BAD_EMAIL;
        }
    }
    /* The address a password reset goes to. Students by their own column;
       employees across all six staff tables, the same as their employee id. */
    foreach (UNIQUE_EMAIL[$col] ?? (in_array($col, STAFF_TABLES, true) ? ['email'] : []) as $field) {
        if (!array_key_exists($field, $d)) {
            continue;
        }
        $held = email_taken($col, $field, (string) $d[$field], $id);
        if ($held !== null) {
            return $held;
        }
    }

    /* A login username must be unique — the schema does not enforce it, so this
       is what stops a second row from ever sharing one (the state that made a
       real account un-signable with an "ambiguous" error). Checked here so every
       write path — form, import, Login Sheet — is covered at once. */
    if ($col === 'users' && array_key_exists('username', $d)) {
        $uname = trim((string) $d['username']);
        if ($uname !== '') {
            $skip = trim((string) ($id ?? ($d['id'] ?? '')));
            $clash = fetch_one('SELECT ' . qi('id') . ' AS id, ' . qi('name') . ' AS name FROM ' . qi('users')
                . ' WHERE LOWER(' . qi('username') . ') = LOWER(?) AND ' . qi('id') . ' <> ?', [$uname, $skip]);
            if ($clash) {
                return 'The user id "' . $uname . '" is already in use'
                    . (trim((string) ($clash['name'] ?? '')) !== '' ? ' by ' . $clash['name'] : '') . '.';
            }
        }
    }

    // the emergency contact, which lives inside the health blob
    $contactBad = contact_problem($col, $d, $id);
    if ($contactBad !== null) {
        return $contactBad;
    }

    // every guardian's mobile and email, which live inside the guardians blob
    if (array_key_exists('guardians', $d)) {
        $list = is_string($d['guardians']) ? json_decode($d['guardians'], true) : $d['guardians'];
        foreach (is_array($list) ? $list : [] as $g) {
            if (!is_array($g)) {
                continue;
            }
            $who = strtolower(trim((string) ($g['relation'] ?? 'guardian')));
            if (!mobile_ok(trim((string) ($g['mobile'] ?? '')))) {
                return rtrim(BAD_MOBILE, '.') . ' for the ' . $who . '.';
            }
            if (!email_ok(trim((string) ($g['email'] ?? '')))) {
                return rtrim(BAD_EMAIL, '.') . ' for the ' . $who . '.';
            }
        }
    }

    if ($col === 'students' && array_key_exists('roll', $d)) {
        $roll = trim((string) ($d['roll'] ?? ''));
        $len = (int) setting_value('regNoLength', '10');
        if ($roll === '') {
            return 'A registration number is required.';
        }
        // A number issued under an older scheme keeps its shape; the rule is
        // for what is being written now, and is checked on the way in.
        $existing = $id ? fetch_one('SELECT * FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$id]) : null;
        $changed = $existing === null || (string) ($existing['roll'] ?? '') !== $roll;
        if ($changed && !$issued) {
            if (!preg_match('/^\d+$/', $roll)) {
                return 'A Student ID is digits only.';
            }
            /* Two shapes are legitimate now: the configured length, which is
               what an id from the old scheme is, and the issued shape of four
               digits plus a running number. A student moved from one scheme to
               the other must not be refused for being the wrong length. */
            $issuedShape = strlen($roll) >= STUDENT_ID_PREFIX_WIDTH + STUDENT_SEQ_WIDTH
                && strlen($roll) <= STUDENT_ID_PREFIX_WIDTH + 5;
            if ($len > 0 && strlen($roll) !== $len && !$issuedShape) {
                return "A Student ID is $len digits, or an issued one.";
            }
        }
        $clash = fetch_one(
            'SELECT * FROM ' . qi('students') . ' WHERE ' . qi('roll') . ' = ?' .
            ($id ? ' AND ' . qi('id') . ' <> ?' : ''),
            $id ? [$roll, $id] : [$roll]
        );
        if ($clash) {
            return "Student ID $roll already belongs to " . ($clash['name'] ?? 'another student') . '.';
        }
    }

    /* The university's registration number. Ten digits or nothing — it arrives
       weeks after admission, so blank has to be allowed, but a half-typed one
       is worse than none. Checked here and not only in the browser: the public
       admission form posts straight past the browser's copy of this rule. */
    if ($col === 'students' && array_key_exists('univRegNo', $d)) {
        $reg = trim((string) ($d['univRegNo'] ?? ''));
        if ($reg !== '') {
            if (!preg_match('/^\d{10}$/', $reg)) {
                return 'A university registration number is exactly 10 digits.';
            }
            $clash = fetch_one(
                'SELECT * FROM ' . qi('students') . ' WHERE ' . qi('univRegNo') . ' = ?' .
                ($id ? ' AND ' . qi('id') . ' <> ?' : ''),
                $id ? [$reg, $id] : [$reg]
            );
            if ($clash) {
                return "University registration number $reg already belongs to "
                    . ($clash['name'] ?? 'another student') . '.';
            }
        }
    }
    return null;
}

/** Refuse the write, naming the row when a whole sheet was posted. */
function reject_row(string $problem, ?int $index = null): void
{
    send_json([
        'error'   => 'invalid',
        'message' => $index === null ? $problem : "Row " . ($index + 2) . ": $problem",
    ], 422);
}

/**
 * Rows the caller is allowed to see. A student reading their own placement
 * records gets exactly theirs — the filter lives here so it applies to
 * /api/{collection} and to the bootstrap payload alike.
 */
/**
 * May this role read this collection at all?
 *
 * Strict for the student, who is the one role the college has not vetted and
 * the one that could read everybody's file. For everyone on the staff the
 * answer is what it was before this gate existed — the older rules below
 * still keep finance, placement and the audit log to the roles they belong
 * to — because tightening the staff list without walking every staff screen
 * against real data was what left the admissions desk signed in and unable
 * to draw a page. What a clerk may see of a lecturer is a real question; it
 * is not one to answer by guesswork on a live system.
 */
function role_may_read(string $col): bool
{
    $role = current_role();
    if ($role !== 'student') {
        return true;
    }
    $allowed = ROLE_READABLE[$role] ?? [];
    return in_array('*', $allowed, true) || in_array($col, $allowed, true);
}

/**
 * Which rows of a collection this caller is actually allowed to see, and how
 * much of each one.
 *
 * The collection gate above answers "may you open this drawer"; this answers
 * "which files in it are yours". Without it a student granted the roll — which
 * they need, to read their own record — is granted everybody's.
 */
function scope_rows(string $col, array $rows): array
{
    $me = current_user();
    $role = current_role();

    /* The login table is never a directory. Everybody's session is restored by
       looking their own account up here, so it stays readable — as one row. */
    if ($col === 'users' && !in_array($role, ['admin', 'admission'], true)) {
        $mine = (string) ($me['id'] ?? '');
        return array_values(array_filter($rows, fn($r) => (string) ($r['id'] ?? '') === $mine));
    }

    if ($role !== 'student') {
        return $rows;
    }
    $sid = (string) ($me['refId'] ?? '');

    if (in_array($col, PLACEMENT_STUDENT_OWN, true)) {
        return array_values(array_filter($rows, fn($r) => (string) ($r['studentId'] ?? '') === $sid));
    }
    if (isset(STUDENT_OWN_ROWS[$col])) {
        $key = STUDENT_OWN_ROWS[$col];
        return array_values(array_filter($rows, fn($r) => (string) ($r[$key] ?? '') === $sid));
    }
    /* A register is one row for a whole class, so the row cannot be filtered —
       what is filtered is the register itself, down to the one line about the
       student reading it. */
    if ($col === 'attendance') {
        return array_values(array_map(function (array $r) use ($sid) {
            $recs = $r['records'] ?? null;
            if (is_string($recs)) {
                $recs = json_decode($recs, true);
            }
            if (is_array($recs)) {
                $r['records'] = json_encode(array_values(array_filter(
                    $recs,
                    fn($e) => is_array($e) && (string) ($e['studentId'] ?? '') === $sid
                )));
            }
            return $r;
        }, $rows));
    }
    // an employee is a name and a designation to a student, not a personal file
    if (in_array($col, STAFF_TABLES, true)) {
        return array_values(array_map(
            fn(array $r) => array_intersect_key($r, array_flip(STAFF_PUBLIC_FIELDS)),
            $rows
        ));
    }
    return $rows;
}

function api_list(string $col): void
{
    $rows = scope_rows($col, fetch_all('SELECT * FROM ' . qi($col)));
    send_json(array_map(fn($r) => row_out($col, $r), $rows));
}

/**
 * The role is not part of the credentials. Whichever account the username and
 * password belong to decides the role, so a user cannot pick the wrong one and
 * cannot try to sign in as a role they do not hold.
 */
function api_login(): void
{
    $d = body();
    $given = (string) ($d['password'] ?? '');
    $name = strtolower(trim((string) ($d['username'] ?? '')));

    /* Checked before the password is looked at, so a locked-out attacker
       cannot even learn whether the account exists. */
    /* The account is always counted; the address only when it names somebody.
       Both are cleared by getting in, so an honest person who fumbles their
       password twice and then remembers it starts from nothing again. */
    $keys = ['user:' . $name];
    $ipKey = client_ip_is_one_caller() ? 'ip:' . client_ip() : null;
    if ($ipKey !== null) {
        $keys[] = $ipKey;
    }
    foreach ($keys as $k) {
        $wait = login_wait($k);
        if ($wait > 0) {
            send_json([
                'error'   => 'too-many-attempts',
                'retryAfter' => $wait,
                'message' => 'Too many failed sign-ins. Try again in '
                    . max(1, (int) ceil($wait / 60)) . ' minute(s).',
            ], 429);
        }
    }
    /* The password is no longer part of the query — a hash cannot be matched in
       SQL. The row is found by username and the password checked in PHP. */
    $rows = fetch_all(
        'SELECT * FROM ' . qi('users') . ' WHERE LOWER(' . qi('username') . ') = LOWER(?)',
        [$d['username'] ?? '']
    );
    // whether anybody holds this name at all, which is a different question
    // from whether the password was right
    $known = $rows !== [];
    $rows = array_values(array_filter(
        $rows,
        fn($r) => password_matches($given, (string) ($r['password'] ?? ''))
    ));
    if (!$rows) {
        login_failed('user:' . $name, LOGIN_MAX_PER_USER);
        /* The address is counted only for a name nobody holds. Somebody working
           through a list of guesses trips it quickly; somebody getting their own
           password wrong never touches it, however many times they do it. */
        if ($ipKey !== null && !$known) {
            login_failed($ipKey, LOGIN_MAX_PER_IP);
        }
        /* The name that was tried, never the password that was tried with it —
           people mistype one into the other, and a log holding that is a log
           holding a password. */
        audit('login-failed', 'users', '', $name, 'from ' . client_ip());
        send_json(['error' => 'invalid', 'message' => 'Invalid username or password.'], 401);
    }
    // signing in is what migrates the row; after this it is a hash for good
    if (!is_password_hash((string) ($rows[0]['password'] ?? ''))) {
        upgrade_password((string) $rows[0]['id'], $given);
    }
    if ((string) ($rows[0]['status'] ?? 'Active') === 'Inactive') {
        // deliberately the same wording as a wrong password: whether an account
        // exists is not something a sign-in page should confirm
        send_json(['error' => 'inactive',
                   'message' => 'This account has been deactivated. Contact the administrator.'], 403);
    }
    if (count($rows) > 1) {
        /* The UI rejects a duplicate username, but nothing in the schema enforces
           it, so two rows can end up sharing one. When those rows are the SAME
           person (same role, and the same staff/student record or the same name)
           they are just a duplicate of one account — sign in as the first rather
           than lock the person out. Only refuse when the matched rows are
           genuinely different people, which is the case the warning is for. */
        $first = $rows[0];
        $samePerson = true;
        foreach ($rows as $r) {
            $sameRole = strtolower((string) ($r['role'] ?? '')) === strtolower((string) ($first['role'] ?? ''));
            $sameRef  = trim((string) ($r['refId'] ?? '')) !== '' && (string) $r['refId'] === (string) $first['refId'];
            $sameName = strtolower(trim((string) ($r['name'] ?? ''))) === strtolower(trim((string) ($first['name'] ?? '')))
                        && trim((string) ($first['name'] ?? '')) !== '';
            if (!($sameRole && ($sameRef || $sameName))) {
                $samePerson = false;
                break;
            }
        }
        if (!$samePerson) {
            send_json([
                'error'   => 'ambiguous',
                'message' => 'More than one account uses this username. Contact the administrator.',
            ], 409);
        }
        $rows = [$first];   // a duplicate of one account — carry on as that account
    }
    /* A fresh session every time, always.

       This used to reuse a token already sitting in the users.token column
       when one was there — a leftover from before sessions lived in their own
       table. But that column's value has no row in _sessions, so login handed
       it back, the very next request looked it up in _sessions, found nothing,
       and answered 401: signed in, and unable to read a thing. It only bit the
       accounts that still carried an old token — which is why it looked like it
       was one login and not the rest.

       So the token is always minted here, and the stale column is wiped on the
       way past so it can never be mistaken for a session again. */
    $token = session_start_for((string) $rows[0]['id']);
    if (($rows[0]['token'] ?? '') !== '' && in_array('token', COLLECTIONS['users'], true)) {
        run_sql('UPDATE ' . qi('users') . ' SET ' . qi('token') . ' = NULL WHERE ' . qi('id') . ' = ?',
            [(string) $rows[0]['id']]);
    }
    login_succeeded($keys);
    audit('login', 'users', (string) $rows[0]['id'],
          (string) ($rows[0]['name'] ?? $rows[0]['username'] ?? ''),
          'from ' . client_ip(), [], $rows[0]);
    $out = row_out('users', $rows[0]);
    $out['token'] = $token;          // the only response that carries it
    send_json($out);
}

/** Give the token up. Anything still holding it is a 401 from here on. */
function api_logout(): void
{
    /* This device only. Somebody signing out of a lab machine has not asked to
       be signed out of their phone. */
    sessions_table();
    $me = current_user();
    $token = request_token();
    if ($token !== '') {
        run_sql('DELETE FROM ' . qi('_sessions') . ' WHERE ' . qi('token') . ' = ?', [$token]);
    }
    if ($me) {
        audit('logout', 'users', (string) $me['id'], (string) ($me['name'] ?? ''));
    }
    send_json(['ok' => true]);
}

/**
 * Anybody signed in may change their own password, and only their own: the
 * account is taken from the caller's header, never from the request body, so
 * a hand-made payload cannot aim this at somebody else. The current password
 * has to be right, which is what stops a borrowed unlocked screen from
 * becoming a permanent takeover.
 */
const MIN_PASSWORD_LENGTH = 6;

function api_change_password(): void
{
    $me = current_user();
    if (!$me) {
        send_json(['error' => 'unauthorised', 'message' => 'Please sign in again.'], 401);
    }
    $d = body();
    $current = (string) ($d['current'] ?? '');
    $next = (string) ($d['next'] ?? '');

    if (!password_matches($current, (string) ($me['password'] ?? ''))) {
        send_json(['error' => 'wrong-password', 'message' => 'Your current password is not right.'], 403);
    }
    if (strlen($next) < MIN_PASSWORD_LENGTH) {
        send_json(['error' => 'too-short',
                   'message' => 'The new password must be at least ' . MIN_PASSWORD_LENGTH . ' characters.'], 422);
    }
    if ($next === $current) {
        send_json(['error' => 'unchanged', 'message' => 'That is the password you already have.'], 422);
    }

    /* A new token with the new password: whoever knew the old one is signed
       out, which is the point of changing it after a screen was left unlocked. */
    /* Changing a password is what somebody does when they think a key is
       loose, so every other session on the account ends here — the new one is
       issued after, which is why the browser doing this is not logged out. */
    sessions_table();
    db()->prepare('UPDATE ' . qi('users') . ' SET ' . qi('password') . ' = ? WHERE ' . qi('id') . ' = ?')
        ->execute([hash_password($next), $me['id']]);
    run_sql('DELETE FROM ' . qi('_sessions') . ' WHERE ' . qi('userId') . ' = ?', [$me['id']]);
    $token = session_start_for((string) $me['id']);
    audit('password-changed', 'users', (string) $me['id'], (string) ($me['name'] ?? ''),
          'every other session on this account was ended');
    send_json(['ok' => true, 'token' => $token]);
}

function api_create(string $col): void
{
    $d = body();

    // A student posting to `applications` gets the row rebuilt from scratch:
    // only the drive is taken from the request, everything else is decided here.
    if ($col === 'applications' && current_role() === 'student') {
        $row = guard_student_application(is_array($d) && !array_is_list($d) ? $d : []);
        $row['id'] = next_id($col);
        upsert($col, $row);
        send_json($row, 201);
    }

    // A bulk upload posts the whole spreadsheet as an array. One request beats
    // one-per-row over a hosted database, and one transaction means a failure
    // half way through does not leave half a class imported.
    if (is_array($d) && array_is_list($d) && $d !== [] && is_array($d[0])) {
        // the whole sheet is checked before any of it is written, so a bad row
        // half way down does not leave the first half imported
        /* The id is issued first, so the row being judged is the row that will
           be written. A sheet that leaves the column blank is asking for one;
           checking before issuing would refuse the request for being blank. */
        foreach ($d as $i => $row) {
            $row = is_array($row) ? $row : [];
            $issued = false;
            if ($col === 'students' && trim((string) ($row['roll'] ?? '')) === '') {
                $row['roll'] = issue_student_id($row);
                $issued = true;
                $d[$i] = $row;
            }
            $problem = row_problem($col, $row, null, $issued);
            if ($problem !== null) {
                reject_row($problem, $i);
            }
        }
        $rows = [];
        db()->beginTransaction();
        try {
            lock_collection($col);
            foreach ($d as $row) {
                if (empty($row['id'])) {
                    $row['id'] = next_id($col);
                }
                $row = hash_row_password($col, $row);
                upsert($col, $row);
                $rows[] = $row;
            }
            db()->commit();
        } catch (Throwable $e) {
            db()->rollBack();
            throw $e;
        }
        if (in_array($col, AUDITED, true)) {
            // a spreadsheet import is one act, and reads better as one line
            audit('import', $col, (string) count($rows),
                  '', count($rows) . ' row(s) imported');
        }
        send_json($rows, 201);
    }

    /* Everything from here to the write happens with this collection's
       allocation lock held, so the id chosen below is still free when it is
       used. Issuance comes before validation: a create asking for an id sends a
       blank one, and a blank one is what the rule would otherwise reject. */
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        lock_collection($col);
        $issued = false;
        if ($col === 'students' && trim((string) ($d['roll'] ?? '')) === '') {
            $d['roll'] = issue_student_id($d);
            $issued = true;
        }
        $problem = row_problem($col, $d, null, $issued);
        if ($problem !== null) {
            if ($own) {
                db()->rollBack();
            }
            reject_row($problem);
        }
        if (empty($d['id'])) {
            $d['id'] = next_id($col);
        }
        $d = hash_row_password($col, $d);
        upsert($col, $d);
        if ($own) {
            db()->commit();
        }
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
    if (in_array($col, AUDITED, true)) {
        audit('create', $col, (string) $d['id'], audit_name($col, $d));
    }
    send_json(row_out($col, $d), 201);
}

function api_update(string $col, string $id): void
{
    $d = body();
    /* A submitted register locks after the editing window: nobody but the Super
       Admin edits it directly after that — a correction request is the way. The
       approved correction is applied by the server itself, not through here. */
    if ($col === 'attendance') {
        $me = current_user();
        if ((string) ($me['role'] ?? '') !== 'admin') {
            $ex = fetch_one('SELECT ' . qi('savedAt') . ' AS savedAt FROM ' . qi('attendance')
                . ' WHERE ' . qi('id') . ' = ?', [$id]);
            $savedAt = $ex ? (int) ($ex['savedAt'] ?? 0) : 0;
            if ($savedAt > 0 && time() > $savedAt + attendance_lock_hours() * 3600) {
                send_json(['error' => 'locked',
                    'message' => 'This attendance is locked. Raise a correction request to change it.'], 423);
            }
        }
    }
    // read before writing, so the line can say what it changed from
    $before = in_array($col, AUDITED, true)
        ? (fetch_one('SELECT * FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id]) ?: [])
        : [];
    $problem = row_problem($col, $d, $id);
    if ($problem !== null) {
        reject_row($problem);
    }
    // a role with a column allowlist gets everything else in the body dropped,
    // so a crafted payload cannot ride along with a legitimate one
    $d = hash_row_password($col, $d);
    $allowed = writable_fields($col);
    $fields = array_values(array_filter(
        COLLECTIONS[$col],
        fn($f) => $f !== 'id' && array_key_exists($f, $d)
            && ($allowed === null || in_array($f, $allowed, true))
    ));
    if (!$fields) {
        send_json(['error' => 'no fields'], 400);
    }
    $sets = [];
    $values = [];
    foreach ($fields as $f) {
        $sets[] = qi($f) . ' = ?';
        $values[] = serialize_value($col, $f, $d[$f]);
    }
    $values[] = $id;
    run_sql('UPDATE ' . qi($col) . ' SET ' . implode(', ', $sets) . ' WHERE ' . qi('id') . ' = ?', $values);
    if (in_array($col, AUDITED, true)) {
        $moved = audit_diff($before, array_intersect_key($d, array_flip($fields)));
        if ($moved !== []) {
            audit('update', $col, $id, audit_name($col, $before ?: $d),
                  implode(', ', array_keys($moved)), $moved);
        }
    }
    send_json(['ok' => true, 'id' => $id]);
}

function api_delete(string $col, string $id): void
{
    // read before removing, so the trash and the log both know what was removed
    $soft = in_array($col, SOFT_DELETE, true);
    $before = ($soft || in_array($col, AUDITED, true))
        ? fetch_one('SELECT * FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id])
        : null;

    if ($soft && $before) {
        /* The whole row is kept, exactly as it was, so a restore is faithful.
           Password hashes are kept with it on purpose: a login put back without
           one is a login nobody can sign in to. The trash is admin-only, which
           is what keeps that hash as safe as it was in the table it left. */
        trash_table();
        $me = current_user();
        run_sql('INSERT INTO ' . qi('_trash') . ' (' . qi('id') . ', ' . qi('col') . ', '
            . qi('rowId') . ', ' . qi('data') . ', ' . qi('deletedBy') . ', '
            . qi('deletedByName') . ', ' . qi('deletedAt') . ') VALUES (?, ?, ?, ?, ?, ?, ?)', [
                'TRSH' . dechex((int) round(microtime(true) * 1000)) . bin2hex(random_bytes(4)),
                $col, $id, json_encode($before),
                (string) ($me['id'] ?? ''), (string) ($me['name'] ?? $me['username'] ?? ''), time(),
            ]);
    }
    run_sql('DELETE FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id]);
    if ($soft || in_array($col, AUDITED, true)) {
        audit('delete', $col, $id, $before ? audit_name($col, $before) : '');
    }
    send_json(['ok' => true]);
}

/** the trash, newest first: the administrator alone */
function api_trash_list(): void
{
    if (current_role() !== 'admin') {
        send_json(['error' => 'forbidden', 'message' => 'Only the administrator sees the trash.'], 403);
    }
    trash_table();
    $rows = fetch_all('SELECT ' . qi('id') . ', ' . qi('col') . ', ' . qi('rowId') . ', '
        . qi('data') . ', ' . qi('deletedByName') . ', ' . qi('deletedAt')
        . ' FROM ' . qi('_trash') . ' ORDER BY ' . qi('deletedAt') . ' DESC');
    $out = array_map(function ($r) {
        $data = json_decode((string) ($r['data'] ?? ''), true) ?: [];
        return [
            'id'        => $r['id'],
            'col'       => $r['col'],
            'rowId'     => $r['rowId'],
            'name'      => $data['name'] ?? $data['title'] ?? $data['username'] ?? $data['roll'] ?? $r['rowId'],
            'deletedBy' => $r['deletedByName'],
            'deletedAt' => (int) $r['deletedAt'],
        ];
    }, $rows);
    send_json($out);
}

/** put a trashed row back where it came from, if its id is still free */
function api_trash_restore(string $trashId): void
{
    if (current_role() !== 'admin') {
        send_json(['error' => 'forbidden', 'message' => 'Only the administrator can restore.'], 403);
    }
    trash_table();
    $t = fetch_one('SELECT * FROM ' . qi('_trash') . ' WHERE ' . qi('id') . ' = ?', [$trashId]);
    if (!$t) {
        send_json(['error' => 'not-found', 'message' => 'That item is no longer in the trash.'], 404);
    }
    $col = (string) $t['col'];
    $rowId = (string) $t['rowId'];
    $data = json_decode((string) $t['data'], true);
    if (!is_array($data) || !isset(COLLECTIONS[$col])) {
        send_json(['error' => 'bad-data', 'message' => 'That item cannot be restored.'], 422);
    }
    if (fetch_one('SELECT ' . qi('id') . ' FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$rowId])) {
        send_json(['error' => 'exists',
                   'message' => 'A record with that id already exists, so it was not restored.'], 409);
    }
    // written back through the same path a normal write uses, so a JSON blob
    // column is serialised the way that table expects
    upsert($col, $data);
    run_sql('DELETE FROM ' . qi('_trash') . ' WHERE ' . qi('id') . ' = ?', [$trashId]);
    audit('restore', $col, $rowId, audit_name($col, $data));
    send_json(['ok' => true, 'col' => $col, 'id' => $rowId]);
}

/** empty one item from the trash for good: the permanent deletion */
function api_trash_purge(string $trashId): void
{
    if (current_role() !== 'admin') {
        send_json(['error' => 'forbidden',
                   'message' => 'Only the administrator can permanently delete.'], 403);
    }
    trash_table();
    $t = fetch_one('SELECT * FROM ' . qi('_trash') . ' WHERE ' . qi('id') . ' = ?', [$trashId]);
    if ($t) {
        run_sql('DELETE FROM ' . qi('_trash') . ' WHERE ' . qi('id') . ' = ?', [$trashId]);
        audit('purge', (string) $t['col'], (string) $t['rowId'], '');
    }
    send_json(['ok' => true]);
}

// ---------------------------------------------------------------- routing
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$seg = segments();
$resource = $seg[0] ?? '';
$id = $seg[1] ?? null;
$isCollection = isset(COLLECTIONS[$resource]) && $resource !== '';

/**
 * Everything after the health check, in one callable so it can be retried
 * once if the schema turns out to be behind (see the catch below).
 */
/* =====================================================================
   REPORTING HIERARCHY + HELPDESK
   ---------------------------------------------------------------------
   One relationship — users.reportingTo — and one set of role chains drive
   the org tree, ticket routing and escalation. The CMS runs a single centre,
   so "the Course Coordinator" of a ticket is resolved first through the
   requester's own reporting line and otherwise to the first active account
   holding that role. Everything here lives in index.php on purpose: a
   Hostinger deploy lands file by file, and a constant or a required file
   that has not arrived yet would take the whole API down.
   ===================================================================== */

/* the private tables: helpdesk, bell and approvals — reached only through their own endpoints */
const TICKET_TABLES = ['tickets', 'tickethistory', 'ticketcomments', 'notifications', 'approvals', 'approvalsteps'];

/** which roles an account of a role may report to (by role key) */
const REPORTS_TO = [
    'subadmin'           => ['admin'],
    'center_head'        => ['subadmin', 'admin'],
    'academic_head'      => ['center_head'],
    'admission'          => ['academic_head', 'center_head'],
    'accountant'         => ['academic_head', 'center_head'],
    'librarian'          => ['academic_head', 'center_head'],
    'course_coordinator' => ['academic_head'],
    'dean_placement'     => ['academic_head'],
    'plmt_officer'       => ['dean_placement'],
    'placement_officer'  => ['dean_placement'],
    'plmt_coordinator'   => ['plmt_officer', 'placement_officer'],
    'faculty'            => ['course_coordinator', 'academic_head'],
    'guest_faculty'      => ['course_coordinator', 'academic_head'],
    'student'            => [],
];

/** names used in server messages when a role has no row of its own */
const ROLE_TITLES = [
    'admin' => 'Super Admin', 'subadmin' => 'Admin', 'center_head' => 'Center Head',
    'academic_head' => 'Academic Head', 'admission' => 'Admission', 'accountant' => 'Finance',
    'librarian' => 'Library', 'course_coordinator' => 'Course Coordinator',
    'dean_placement' => 'Dean T&P', 'plmt_officer' => 'Placement Officer',
    'placement_officer' => 'Placement Officer (Cell)', 'plmt_coordinator' => 'Assistant TPO',
    'faculty' => 'Faculty', 'guest_faculty' => 'Guest Faculty', 'student' => 'Student',
];

/* The escalation ladder of each function, lowest level first. A level lists
   the role keys that can hold it — the built-in placement cell officer and the
   Placement Officer access role are the same rung. A ticket climbs only as far
   as somebody escalates it; nothing forces it through every level. */
const TICKET_CHAINS = [
    'academic'  => [['academic_head'], ['center_head'], ['subadmin'], ['admin']],
    'admission' => [['admission'], ['academic_head'], ['center_head'], ['subadmin'], ['admin']],
    'finance'   => [['accountant'], ['center_head'], ['subadmin'], ['admin']],
    'tnp'       => [['plmt_coordinator'], ['plmt_officer', 'placement_officer'], ['dean_placement'],
                    ['academic_head'], ['center_head'], ['subadmin'], ['admin']],
    'library'   => [['librarian'], ['academic_head'], ['center_head'], ['subadmin'], ['admin']],
    'technical' => [['subadmin'], ['admin']],
    'other'     => [['center_head'], ['subadmin'], ['admin']],
];

const TICKET_CATEGORIES = [
    'Academic'  => ['chain' => 'academic',
                    'subs' => ['Attendance', 'Examination', 'Marks', 'Results', 'Subject', 'Course',
                               'Timetable', 'Faculty', 'Student']],
    'Admission' => ['chain' => 'admission', 'subs' => ['Application', 'Admission', 'Documents', 'Registration']],
    'Finance'   => ['chain' => 'finance', 'subs' => ['Fees', 'Payment', 'Receipt', 'Refund']],
    'T&P'       => ['chain' => 'tnp', 'subs' => ['Placement', 'Company', 'Drive', 'Interview', 'Training', 'Offer']],
    'Library'   => ['chain' => 'library', 'subs' => ['Book', 'Issue/Return', 'Inventory', 'Fine']],
    'Technical' => ['chain' => 'technical', 'subs' => ['Login', 'Password', 'CMS Bug', 'System Error']],
    'Other'     => ['chain' => 'other', 'subs' => ['General Request', 'Complaint', 'Suggestion', 'Other']],
];
const TICKET_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
/** hours; the Super Admin overrides these in the `ticketSla` setting */
const TICKET_SLA_DEFAULT = ['Low' => 72, 'Medium' => 48, 'High' => 24, 'Critical' => 4];
/** history actions that hand the ticket to somebody — each one opens a stage */
const TICKET_STAGE_ACTIONS = ['assigned', 'escalated', 'reassigned', 'reopened'];
const TICKET_ATTACH_TYPES = [
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png',
];
const TICKET_ATTACH_MAX = 2 * 1024 * 1024;
/** who may see the whole organisation tree */
const ORG_TREE_ROLES = ['admin', 'subadmin', 'center_head', 'academic_head'];

function role_title(string $key): string
{
    $r = role_record($key);
    if ($r && trim((string) ($r['label'] ?? '')) !== '') {
        return (string) $r['label'];
    }
    return ROLE_TITLES[$key] ?? ucwords(str_replace('_', ' ', $key));
}

/** why this reporting relationship is not allowed, or null when it is */
function reporting_problem(string $selfId, string $role, string $parentId): ?string
{
    if ($selfId !== '' && $parentId === $selfId) {
        return 'An account cannot report to itself.';
    }
    if ($role === 'admin') {
        return 'The Super Admin reports to nobody.';
    }
    $cols = qi('id') . ' AS id, ' . qi('role') . ' AS role, ' . qi('reportingTo') . ' AS reportingTo';
    $parent = fetch_one('SELECT ' . $cols . ' FROM ' . qi('users') . ' WHERE ' . qi('id') . ' = ?', [$parentId]);
    if (!$parent) {
        return 'The selected Reporting To account does not exist.';
    }
    $allowed = REPORTS_TO[$role] ?? null;
    if ($allowed === []) {
        return 'A ' . role_title($role) . ' does not report to a staff account.';
    }
    if ($allowed !== null && !in_array((string) $parent['role'], $allowed, true)) {
        return 'A ' . role_title($role) . ' must report to '
            . implode(' or ', array_map('role_title', $allowed)) . '.';
    }
    // walking up from the new manager must never arrive back here
    $cur = $parent;
    for ($i = 0; $i < 25 && $cur; $i++) {
        if ($selfId !== '' && (string) $cur['id'] === $selfId) {
            return 'That would create a reporting loop.';
        }
        $up = trim((string) ($cur['reportingTo'] ?? ''));
        if ($up === '') {
            break;
        }
        $cur = fetch_one('SELECT ' . $cols . ' FROM ' . qi('users') . ' WHERE ' . qi('id') . ' = ?', [$up]);
    }
    return null;
}

/**
 * The login table's reportingTo, guarded: only the Super Admin changes it,
 * and the new manager must hold a role this account may report to. A role
 * change on its own is checked too, so it cannot leave a relationship wrong.
 */
function guard_reporting_to(?string $id): void
{
    $rows = body();
    $rows = (array_is_list($rows) && $rows !== []) ? $rows : [$rows];
    $existing = $id !== null
        ? fetch_one('SELECT ' . qi('id') . ' AS id, ' . qi('role') . ' AS role, ' . qi('reportingTo')
            . ' AS reportingTo FROM ' . qi('users') . ' WHERE ' . qi('id') . ' = ?', [$id])
        : null;
    foreach ($rows as $r) {
        if (!is_array($r)) {
            continue;
        }
        $role = (string) ($r['role'] ?? ($existing['role'] ?? ''));
        $selfId = (string) ($existing['id'] ?? ($r['id'] ?? ''));
        if (array_key_exists('reportingTo', $r)) {
            $new = trim((string) ($r['reportingTo'] ?? ''));
            $old = trim((string) ($existing['reportingTo'] ?? ''));
            if ($new === $old && !array_key_exists('role', $r)) {
                continue;
            }
            if ($new !== $old && current_role() !== 'admin') {
                send_json(['error' => 'forbidden',
                           'message' => 'Only the Super Admin changes who an account reports to.'], 403);
            }
            if ($new !== '' && ($problem = reporting_problem($selfId, $role, $new))) {
                send_json(['error' => 'invalid', 'message' => $problem], 422);
            }
        } elseif ($existing && array_key_exists('role', $r)) {
            $p = trim((string) ($existing['reportingTo'] ?? ''));
            if ($p !== '' && ($problem = reporting_problem($selfId, $role, $p))) {
                send_json(['error' => 'invalid',
                           'message' => $problem . ' Change Reporting To along with the role.'], 422);
            }
        }
    }
}

/* ---------------- helpdesk helpers ---------------- */

function tk_bad(string $message, int $code = 422): void
{
    send_json(['error' => 'invalid', 'message' => $message], $code);
}

/** a time-ordered, collision-safe id — history grows fast and next_id() probes row by row */
function tk_id(string $prefix): string
{
    return $prefix . str_pad(dechex((int) round(microtime(true) * 1000)), 12, '0', STR_PAD_LEFT)
        . bin2hex(random_bytes(3));
}

/** the next number of a named counter in _id_seq (ticket:2026 -> 1, 2, 3 …) */
function tk_take_seq(string $key): int
{
    seq_table();
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        $bump = db()->prepare('UPDATE ' . qi('_id_seq') . ' SET ' . qi('n') . ' = ' . qi('n')
            . ' + 1 WHERE ' . qi('k') . ' = ?');
        $bump->execute([$key]);
        if ($bump->rowCount() === 0) {
            try {
                run_sql('INSERT INTO ' . qi('_id_seq') . ' (' . qi('k') . ', ' . qi('n') . ') VALUES (?, 1)', [$key]);
            } catch (PDOException $e) {
                run_sql('UPDATE ' . qi('_id_seq') . ' SET ' . qi('n') . ' = ' . qi('n') . ' + 1 WHERE '
                    . qi('k') . ' = ?', [$key]);
            }
        }
        $row = fetch_one('SELECT ' . qi('n') . ' AS n FROM ' . qi('_id_seq') . ' WHERE ' . qi('k') . ' = ?', [$key]);
        if ($own) {
            db()->commit();
        }
        return (int) ($row['n'] ?? 1);
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
}

function tk_user_cols(): string
{
    return qi('id') . ' AS id, ' . qi('name') . ' AS name, ' . qi('username') . ' AS username, '
        . qi('role') . ' AS role, ' . qi('status') . ' AS status, ' . qi('reportingTo') . ' AS reportingTo';
}

function tk_user(string $id): ?array
{
    if ($id === '') {
        return null;
    }
    return fetch_one('SELECT ' . tk_user_cols() . ' FROM ' . qi('users') . ' WHERE ' . qi('id') . ' = ?', [$id]);
}

function tk_active(?array $u): bool
{
    return $u !== null && (string) ($u['status'] ?? 'Active') !== 'Inactive';
}

function tk_name(array $u): string
{
    $n = trim((string) ($u['name'] ?? ''));
    return $n !== '' ? $n : (string) ($u['username'] ?? '');
}

/** active accounts holding any of these roles, in a stable order */
function tk_users_with_roles(array $roles): array
{
    if (!$roles) {
        return [];
    }
    $ph = implode(', ', array_fill(0, count($roles), '?'));
    $rows = fetch_all('SELECT ' . tk_user_cols() . ' FROM ' . qi('users') . ' WHERE ' . qi('role')
        . ' IN (' . $ph . ')', array_values($roles));
    $rows = array_values(array_filter($rows, 'tk_active'));
    usort($rows, fn($a, $b) => strnatcmp((string) $a['id'], (string) $b['id']));
    return $rows;
}

/** the chain of people above an account, nearest first */
function tk_line_above(array $u): array
{
    $out = [];
    $cur = $u;
    for ($i = 0; $i < 12; $i++) {
        $p = trim((string) ($cur['reportingTo'] ?? ''));
        if ($p === '' || in_array($p, $out, true)) {
            break;
        }
        $out[] = $p;
        $cur = tk_user($p);
        if (!$cur) {
            break;
        }
    }
    return $out;
}

function tk_level_of(array $chain, string $role): int
{
    foreach ($chain as $i => $roles) {
        if (in_array($role, $roles, true)) {
            return $i;
        }
    }
    return -1;
}

/**
 * The first account that can take a ticket at or above $from: somebody on the
 * requester's own reporting line if they hold the level, otherwise the first
 * active holder of it. Levels nobody holds are skipped.
 */
function tk_route(array $chain, int $from, array $line, string $excludeId = ''): ?array
{
    for ($lvl = max(0, $from); $lvl < count($chain); $lvl++) {
        foreach ($line as $hid) {
            $u = tk_user((string) $hid);
            if (tk_active($u) && $u['id'] !== $excludeId && in_array((string) $u['role'], $chain[$lvl], true)) {
                return ['user' => $u, 'level' => $lvl];
            }
        }
        foreach (tk_users_with_roles($chain[$lvl]) as $u) {
            if ($u['id'] !== $excludeId) {
                return ['user' => $u, 'level' => $lvl];
            }
        }
    }
    return null;
}

/** every active account on levels $lo..$hi, tagged with its level */
function tk_targets(array $chain, int $lo, int $hi, string $excludeId, ?array $suggest): array
{
    $out = [];
    for ($lvl = max(0, $lo); $lvl <= min($hi, count($chain) - 1); $lvl++) {
        foreach (tk_users_with_roles($chain[$lvl]) as $u) {
            if ($u['id'] === $excludeId) {
                continue;
            }
            $out[] = ['id' => $u['id'], 'name' => tk_name($u), 'role' => $u['role'], 'level' => $lvl,
                      'suggested' => $suggest !== null && $suggest['user']['id'] === $u['id']];
        }
    }
    return $out;
}

function tk_sla_hours(): array
{
    $out = TICKET_SLA_DEFAULT;
    $d = json_decode(setting_value('ticketSla', ''), true);
    if (is_array($d)) {
        foreach (TICKET_PRIORITIES as $p) {
            if (isset($d[$p]) && is_numeric($d[$p]) && (float) $d[$p] > 0 && (float) $d[$p] <= 8760) {
                $out[$p] = (float) $d[$p];
            }
        }
    }
    return $out;
}

/** data-URL attachments, checked for type and size before anything is stored */
function tk_clean_attachments($list, int $max = 3): array
{
    if (!is_array($list)) {
        return [];
    }
    $out = [];
    foreach (array_slice($list, 0, $max) as $a) {
        if (!is_array($a) || ($a['data'] ?? '') === '') {
            continue;
        }
        $data = (string) $a['data'];
        $comma = strpos($data, ',');
        $head = $comma === false ? '' : substr($data, 0, $comma);
        if (strncmp($head, 'data:', 5) !== 0 || substr($head, -7) !== ';base64') {
            tk_bad('An attachment could not be read.');
        }
        $type = strtolower(substr($head, 5, -7));
        if (!in_array($type, TICKET_ATTACH_TYPES, true)) {
            tk_bad('Only PDF, Word, Excel, JPG and PNG files can be attached.');
        }
        $b64 = substr($data, $comma + 1);
        if ($b64 === '' || strspn($b64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') !== strlen($b64)) {
            tk_bad('An attachment could not be read.');
        }
        // decoded size: every 4 characters are 3 bytes, less the '=' padding
        $bytes = (int) floor(strlen($b64) * 3 / 4) - (substr($b64, -2) === '==' ? 2 : (substr($b64, -1) === '=' ? 1 : 0));
        if ($bytes > TICKET_ATTACH_MAX) {
            tk_bad('Each attachment must be 2 MB or smaller.');
        }
        $name = substr(preg_replace('/[^\w.\- ()]+/u', '_', basename((string) ($a['name'] ?? 'file'))), 0, 120);
        $out[] = ['name' => $name !== '' ? $name : 'file', 'type' => $type, 'size' => $bytes, 'data' => $data];
    }
    return $out;
}

function tk_load(string $id): ?array
{
    if ($id === '') {
        return null;
    }
    $t = fetch_one('SELECT * FROM ' . qi('tickets') . ' WHERE ' . qi('id') . ' = ?', [$id]);
    return $t ? row_out('tickets', $t) : null;
}

function tk_save(array $t): void
{
    upsert('tickets', $t);
}

/** append one row to a ticket's history; missing columns are stored empty */
function tk_log(array $row): void
{
    $cols = COLLECTIONS['tickethistory'];
    $row['id'] = $row['id'] ?? tk_id('TH');
    $vals = [];
    foreach ($cols as $c) {
        $vals[] = array_key_exists($c, $row) && $row[$c] !== null ? (string) $row[$c] : null;
    }
    run_sql('INSERT INTO ' . qi('tickethistory') . ' (' . implode(', ', array_map('qi', $cols)) . ') VALUES ('
        . implode(', ', array_fill(0, count($cols), '?')) . ')', $vals);
}

/** the stage the ticket is sitting in now ends at $now */
function tk_close_stage(string $ticketId, int $now): void
{
    $in = implode(', ', array_fill(0, count(TICKET_STAGE_ACTIONS), '?'));
    $st = fetch_one('SELECT ' . qi('id') . ' AS id, ' . qi('assignedAt') . ' AS assignedAt FROM '
        . qi('tickethistory') . ' WHERE ' . qi('ticketId') . ' = ? AND ' . qi('action') . ' IN (' . $in
        . ') AND (' . qi('completedAt') . ' IS NULL OR ' . qi('completedAt') . " = '') ORDER BY "
        . qi('assignedAt') . ' DESC, ' . qi('id') . ' DESC LIMIT 1',
        array_merge([$ticketId], TICKET_STAGE_ACTIONS));
    if ($st) {
        run_sql('UPDATE ' . qi('tickethistory') . ' SET ' . qi('completedAt') . ' = ?, ' . qi('seconds')
            . ' = ? WHERE ' . qi('id') . ' = ?',
            [(string) $now, (string) max(0, $now - (int) $st['assignedAt']), $st['id']]);
    }
}

/**
 * Who sees a ticket. The Super Admin and the Center Head see every one (a
 * single centre); anybody who raised it, holds it or ever handled it sees it;
 * and the people on the ticket's own function ladder — the team it belongs to
 * and the authorities it can climb to — see it.
 */
function tk_can_see(array $t, array $me, ?bool $involved = null): bool
{
    $role = (string) ($me['role'] ?? '');
    $uid = (string) ($me['id'] ?? '');
    if (in_array($role, ['admin', 'center_head'], true)) {
        return true;
    }
    if ((string) $t['createdBy'] === $uid || (string) $t['assignedTo'] === $uid) {
        return true;
    }
    if ($involved === null) {
        $involved = (bool) fetch_one('SELECT 1 AS x FROM ' . qi('tickethistory') . ' WHERE ' . qi('ticketId')
            . ' = ? AND (' . qi('toUser') . ' = ? OR ' . qi('fromUser') . ' = ?) LIMIT 1',
            [(string) $t['id'], $uid, $uid]);
    }
    if ($involved) {
        return true;
    }
    return tk_level_of(TICKET_CHAINS[(string) $t['chain']] ?? [], $role) >= 0;
}

/** what the caller may do to this ticket right now */
function tk_allowed(array $t, array $me): array
{
    $chain = TICKET_CHAINS[(string) $t['chain']] ?? [];
    $myLevel = tk_level_of($chain, (string) $me['role']);
    $cur = (int) $t['escalationLevel'];
    $uid = (string) $me['id'];
    $assigned = (string) $t['assignedTo'] !== '';
    $holder = $assigned && (string) $t['assignedTo'] === $uid;
    $isAdmin = (string) $me['role'] === 'admin';
    // a higher rung of the same ladder may step in; the Super Admin always may
    $super = $isAdmin || ($assigned ? $myLevel > $cur : $myLevel >= 0);
    $creator = (string) $t['createdBy'] === $uid;
    $s = (string) $t['status'];
    $done = in_array($s, ['Resolved', 'Closed'], true);
    $act = $holder || $super;
    return [
        'holder'       => $holder,
        'supervisor'   => $super,
        'myLevel'      => $myLevel,
        'assign'       => !$assigned && !$done && $super,
        'start'        => $act && $assigned && in_array($s, ['Assigned', 'Escalated', 'Reopened', 'Waiting for Information'], true),
        'request_info' => $holder && in_array($s, ['Assigned', 'In Progress', 'Escalated', 'Reopened'], true),
        'escalate'     => $act && $assigned && !$done && $cur + 1 < count($chain),
        'reassign'     => $act && $assigned && !$done,
        'resolve'      => $act && $assigned && !$done,
        'close'        => $s === 'Resolved' && ($creator || $holder || $super),
        'reopen'       => $done && ($creator || $super),
        'comment'      => $s !== 'Closed',
    ];
}

function tk_int_fields(array $row, array $fields): array
{
    foreach ($fields as $f) {
        if (array_key_exists($f, $row)) {
            $row[$f] = ($row[$f] === null || $row[$f] === '') ? null : (int) $row[$f];
        }
    }
    return $row;
}

const TICKET_TIME_FIELDS = ['assignedAt', 'escalationLevel', 'slaDueAt', 'createdAt', 'updatedAt',
                            'resolvedAt', 'closedAt'];
const TICKET_LIST_FIELDS = ['id', 'ticketNo', 'subject', 'category', 'subcategory', 'priority', 'department',
                            'course', 'module', 'createdBy', 'createdByName', 'createdByRole', 'assignedTo',
                            'assignedName', 'assignedRole', 'assignedAt', 'status', 'chain',
                            'escalationLevel', 'slaHours', 'slaDueAt', 'createdAt', 'updatedAt',
                            'resolvedAt', 'closedAt'];

/* ---------------- helpdesk endpoints ---------------- */

/** categories, priorities, SLA hours and ladders — what the forms and badges need */
function api_tk_meta(): void
{
    $me = current_user();
    $cats = [];
    foreach (TICKET_CATEGORIES as $name => $def) {
        $cats[] = ['name' => $name, 'chain' => $def['chain'], 'subs' => $def['subs']];
    }
    send_json([
        'now' => time(), 'categories' => $cats, 'priorities' => TICKET_PRIORITIES,
        'sla' => tk_sla_hours(), 'chains' => TICKET_CHAINS, 'reportsTo' => REPORTS_TO,
        'canConfigure' => (string) ($me['role'] ?? '') === 'admin',
        'orgTree' => in_array((string) ($me['role'] ?? ''), ORG_TREE_ROLES, true),
    ]);
}

/** every ticket the caller may see, lean, plus the counters the dashboards draw */
function api_tk_list(): void
{
    $me = current_user();
    $uid = (string) $me['id'];
    $rows = fetch_all('SELECT ' . implode(', ', array_map('qi', TICKET_LIST_FIELDS)) . ' FROM ' . qi('tickets')
        . ' ORDER BY ' . qi('createdAt') . ' DESC');
    $mine = [];
    foreach (fetch_all('SELECT DISTINCT ' . qi('ticketId') . ' AS t FROM ' . qi('tickethistory') . ' WHERE '
        . qi('toUser') . ' = ? OR ' . qi('fromUser') . ' = ?', [$uid, $uid]) as $r) {
        $mine[(string) $r['t']] = true;
    }
    $out = [];
    $ids = [];
    foreach ($rows as $t) {
        if (!tk_can_see($t, $me, isset($mine[(string) $t['id']]))) {
            continue;
        }
        $t = tk_int_fields($t, TICKET_TIME_FIELDS);
        $t['slaHours'] = (float) $t['slaHours'];
        $t['involved'] = isset($mine[(string) $t['id']]);
        $t['escalations'] = 0;
        $t['reopens'] = 0;
        $t['firstStartAt'] = null;
        $out[(string) $t['id']] = $t;
    }
    if ($out) {
        foreach (fetch_all('SELECT ' . qi('ticketId') . ' AS t, ' . qi('action') . ' AS a, ' . qi('at') . ' AS at FROM '
            . qi('tickethistory') . ' WHERE ' . qi('action') . " IN ('escalated', 'reopened', 'started')") as $h) {
            $k = (string) $h['t'];
            if (!isset($out[$k])) {
                continue;
            }
            if ($h['a'] === 'escalated') {
                $out[$k]['escalations']++;
            } elseif ($h['a'] === 'reopened') {
                $out[$k]['reopens']++;
            } elseif ($out[$k]['firstStartAt'] === null || (int) $h['at'] < $out[$k]['firstStartAt']) {
                $out[$k]['firstStartAt'] = (int) $h['at'];
            }
        }
    }
    send_json(['now' => time(), 'me' => ['id' => $uid, 'role' => (string) $me['role']],
               'sla' => tk_sla_hours(), 'tickets' => array_values($out)]);
}

/** one ticket with its whole story and what the caller may do with it */
function api_tk_get(?string $id): void
{
    $me = current_user();
    $t = tk_load((string) $id);
    if (!$t) {
        send_json(['error' => 'not found', 'message' => 'Ticket not found.'], 404);
    }
    if (!tk_can_see($t, $me)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — this ticket is outside your scope.'], 403);
    }
    $hist = array_map(fn($h) => tk_int_fields($h, ['level', 'at', 'assignedAt', 'completedAt', 'seconds']),
        fetch_all('SELECT * FROM ' . qi('tickethistory') . ' WHERE ' . qi('ticketId') . ' = ? ORDER BY '
            . qi('at') . ' ASC, ' . qi('id') . ' ASC', [(string) $t['id']]));
    $comments = array_map(fn($c) => tk_int_fields(row_out('ticketcomments', $c), ['at']),
        fetch_all('SELECT * FROM ' . qi('ticketcomments') . ' WHERE ' . qi('ticketId') . ' = ? ORDER BY '
            . qi('at') . ' ASC, ' . qi('id') . ' ASC', [(string) $t['id']]));
    $allowed = tk_allowed($t, $me);
    $chain = TICKET_CHAINS[(string) $t['chain']] ?? [];
    $cur = (int) $t['escalationLevel'];
    $holder = tk_user((string) $t['assignedTo']);
    $line = $holder ? tk_line_above($holder) : [];
    $next = $cur + 1 < count($chain) ? tk_route($chain, $cur + 1, $line, (string) $t['assignedTo']) : null;
    $escalate = $allowed['escalate'] ? tk_targets($chain, $cur + 1, count($chain) - 1, (string) $t['assignedTo'], $next) : [];
    $reHi = (string) $me['role'] === 'admin' ? count($chain) - 1 : max($cur, (int) $allowed['myLevel']);
    $reassign = ($allowed['reassign'] || $allowed['assign'])
        ? tk_targets($chain, 0, $allowed['assign'] ? count($chain) - 1 : $reHi, (string) $t['assignedTo'], null)
        : [];
    $t = tk_int_fields($t, TICKET_TIME_FIELDS);
    $t['slaHours'] = (float) $t['slaHours'];
    send_json([
        'now' => time(), 'ticket' => $t, 'history' => $hist, 'comments' => $comments,
        'allowed' => $allowed, 'chain' => $chain,
        'next' => $next ? ['id' => $next['user']['id'], 'name' => tk_name($next['user']),
                           'role' => $next['user']['role'], 'level' => $next['level']] : null,
        'escalateTargets' => $escalate, 'reassignTargets' => $reassign,
        'me' => ['id' => (string) $me['id'], 'role' => (string) $me['role']],
    ]);
}

function api_tk_create(): void
{
    $me = current_user();
    $b = body();
    $subject = trim((string) ($b['subject'] ?? ''));
    $desc = trim((string) ($b['description'] ?? ''));
    $cat = (string) ($b['category'] ?? '');
    $sub = (string) ($b['subcategory'] ?? '');
    $pri = (string) ($b['priority'] ?? 'Medium');
    if (mb_strlen($subject) < 3 || mb_strlen($subject) > 200) {
        tk_bad('Give the ticket a subject of 3 to 200 characters.');
    }
    if ($desc === '') {
        tk_bad('Describe the issue.');
    }
    if (!isset(TICKET_CATEGORIES[$cat])) {
        tk_bad('Choose a category.');
    }
    if (!in_array($sub, TICKET_CATEGORIES[$cat]['subs'], true)) {
        tk_bad('Choose a subcategory.');
    }
    if (!in_array($pri, TICKET_PRIORITIES, true)) {
        tk_bad('Choose a priority.');
    }
    $attachments = tk_clean_attachments($b['attachments'] ?? []);
    $chainKey = TICKET_CATEGORIES[$cat]['chain'];
    $chain = TICKET_CHAINS[$chainKey];
    $now = time();
    $hours = tk_sla_hours()[$pri];
    $year = gmdate('Y', $now);
    $no = sprintf('NMIET-%s-%06d', $year, tk_take_seq('ticket:' . $year));
    $meRow = tk_user((string) $me['id']) ?? $me;
    $creatorLevel = tk_level_of($chain, (string) $me['role']);
    $route = tk_route($chain, $creatorLevel + 1, tk_line_above($meRow), (string) $me['id']);
    $t = [
        'id' => tk_id('TK'), 'ticketNo' => $no, 'subject' => $subject, 'description' => $desc,
        'category' => $cat, 'subcategory' => $sub, 'priority' => $pri,
        'department' => substr(trim((string) ($b['department'] ?? '')), 0, 120),
        'course' => substr(trim((string) ($b['course'] ?? '')), 0, 120),
        'module' => substr(trim((string) ($b['module'] ?? '')), 0, 120),
        'createdBy' => (string) $me['id'], 'createdByName' => tk_name($me), 'createdByRole' => (string) $me['role'],
        'assignedTo' => $route ? $route['user']['id'] : '',
        'assignedName' => $route ? tk_name($route['user']) : '',
        'assignedRole' => $route ? $route['user']['role'] : '',
        'assignedAt' => $route ? (string) $now : '',
        'status' => $route ? 'Assigned' : 'Open', 'chain' => $chainKey,
        'escalationLevel' => (string) ($route ? $route['level'] : max(0, $creatorLevel + 1)),
        'slaHours' => (string) $hours, 'slaDueAt' => (string) ($now + (int) round($hours * 3600)),
        'createdAt' => (string) $now, 'updatedAt' => (string) $now,
        'resolution' => '', 'resolvedBy' => '', 'resolvedByName' => '', 'resolvedAt' => '',
        'closedBy' => '', 'closedByName' => '', 'closedAt' => '', 'attachments' => $attachments,
    ];
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        tk_save($t);
        tk_log(['ticketId' => $t['id'], 'action' => 'created', 'fromUser' => $me['id'], 'fromName' => tk_name($me),
                'fromRole' => $me['role'], 'status' => 'Open', 'at' => $now]);
        if ($route) {
            tk_log(['ticketId' => $t['id'], 'action' => 'assigned', 'fromUser' => $me['id'],
                    'fromName' => tk_name($me), 'fromRole' => $me['role'], 'toUser' => $route['user']['id'],
                    'toName' => tk_name($route['user']), 'toRole' => $route['user']['role'],
                    'status' => 'Assigned', 'level' => $route['level'], 'at' => $now, 'assignedAt' => $now]);
        }
        if ($own) {
            db()->commit();
        }
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
    if ($route) {
        nt_push((string) $route['user']['id'], 'ticket_assigned', 'New ticket ' . $no,
            $subject . ' — from ' . tk_name($me) . ' (' . role_title((string) $me['role']) . ')', 'tickets::' . $t['id'],
            $t['id'], in_array($pri, ['High', 'Critical'], true) ? 'warning' : 'info');
    }
    audit('ticket-create', 'tickets', $t['id'], $no,
        $subject . ' — ' . ($route ? 'assigned to ' . tk_name($route['user']) . ' (' . role_title($route['user']['role']) . ')'
                                   : 'no handler available, left open'));
    send_json(['ok' => true, 'id' => $t['id'], 'ticketNo' => $no, 'status' => $t['status'],
               'assignedName' => $t['assignedName'], 'assignedRole' => $t['assignedRole']], 201);
}

/** every change to a ticket goes through here, one action per call */
function api_tk_action(): void
{
    $me = current_user();
    $b = body();
    $t = tk_load((string) ($b['id'] ?? ''));
    if (!$t) {
        send_json(['error' => 'not found', 'message' => 'Ticket not found.'], 404);
    }
    if (!tk_can_see($t, $me)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — this ticket is outside your scope.'], 403);
    }
    $act = (string) ($b['action'] ?? '');
    $allowed = tk_allowed($t, $me);
    if (empty($allowed[$act]) || in_array($act, ['holder', 'supervisor', 'myLevel'], true)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — you cannot do that on this ticket now.'], 403);
    }
    $now = time();
    $uid = (string) $me['id'];
    $meName = tk_name($me);
    $reason = trim((string) ($b['reason'] ?? ''));
    $comment = trim((string) ($b['comment'] ?? ''));
    $chain = TICKET_CHAINS[(string) $t['chain']] ?? [];
    $cur = (int) $t['escalationLevel'];
    $prevStatus = (string) $t['status'];
    $holderId = (string) $t['assignedTo'];
    $holder = tk_user($holderId);
    $summary = '';

    // the account a hand-off goes to must be one this action may reach
    $pickTarget = function (int $lo, int $hi) use ($b, $chain, $holderId): array {
        $to = tk_user((string) ($b['toUser'] ?? ''));
        if (!tk_active($to) || (string) $to['id'] === $holderId) {
            tk_bad('Choose who the ticket goes to.');
        }
        $lvl = tk_level_of($chain, (string) $to['role']);
        if ($lvl < $lo || $lvl > $hi) {
            send_json(['error' => 'forbidden',
                       'message' => 'ACCESS DENIED — that account is not an authority this ticket can go to.'], 403);
        }
        return ['user' => $to, 'level' => $lvl];
    };
    $handOff = function (string $action, array $target, string $status) use (&$t, $now, $holder, $me, $meName, $reason, $comment) {
        tk_close_stage((string) $t['id'], $now);
        $from = $holder ?: $me;
        tk_log(['ticketId' => $t['id'], 'action' => $action, 'fromUser' => $from['id'], 'fromName' => tk_name($from),
                'fromRole' => $from['role'], 'toUser' => $target['user']['id'], 'toName' => tk_name($target['user']),
                'toRole' => $target['user']['role'], 'status' => $status, 'level' => $target['level'],
                'reason' => $reason, 'comment' => $comment, 'at' => $now, 'assignedAt' => $now]);
        $t['assignedTo'] = $target['user']['id'];
        $t['assignedName'] = tk_name($target['user']);
        $t['assignedRole'] = $target['user']['role'];
        $t['assignedAt'] = (string) $now;
        $t['escalationLevel'] = (string) $target['level'];
        $t['status'] = $status;
    };
    $event = function (string $action, string $status, string $text = '') use (&$t, $now, $me, $meName) {
        tk_log(['ticketId' => $t['id'], 'action' => $action, 'fromUser' => $me['id'], 'fromName' => $meName,
                'fromRole' => $me['role'], 'status' => $status, 'comment' => $text, 'at' => $now]);
        $t['status'] = $status;
    };
    $addComment = function (string $kind, string $message, array $attachment) use ($t, $now, $me, $meName) {
        run_sql('INSERT INTO ' . qi('ticketcomments') . ' (' . implode(', ', array_map('qi', COLLECTIONS['ticketcomments']))
            . ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
                tk_id('TC'), $t['id'], $me['id'], $meName, $me['role'], $kind, $message,
                $attachment ? json_encode($attachment) : null, (string) $now,
            ]);
    };

    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        switch ($act) {
            case 'start':
                $event($prevStatus === 'Waiting for Information' ? 'resumed' : 'started', 'In Progress');
                $summary = 'work started';
                break;
            case 'request_info':
                if ($comment === '') {
                    tk_bad('Say what information is needed.');
                }
                $event('waiting', 'Waiting for Information', $comment);
                $addComment('request_info', $comment, []);
                $summary = 'information requested';
                break;
            case 'comment':
                $att = tk_clean_attachments(isset($b['attachment']) ? [$b['attachment']] : [], 1);
                $message = trim((string) ($b['message'] ?? ''));
                if ($message === '' && !$att) {
                    tk_bad('Write a message or attach a file.');
                }
                $addComment('comment', $message, $att[0] ?? []);
                // the requester answering a request for information puts it back to work
                if ($prevStatus === 'Waiting for Information' && (string) $t['createdBy'] === $uid) {
                    $event('info_provided', 'In Progress', $message);
                }
                $summary = 'comment added';
                break;
            case 'escalate':
                if ($reason === '') {
                    tk_bad('Give a reason for escalating.');
                }
                $target = $pickTarget($cur + 1, count($chain) - 1);
                $handOff('escalated', $target, 'Escalated');
                $summary = 'escalated to ' . tk_name($target['user']) . ' (' . role_title($target['user']['role']) . '): ' . $reason;
                break;
            case 'reassign':
                $hi = (string) $me['role'] === 'admin' ? count($chain) - 1 : max($cur, (int) $allowed['myLevel']);
                $target = $pickTarget(0, $hi);
                $handOff('reassigned', $target, 'Assigned');
                $summary = 'reassigned to ' . tk_name($target['user']) . ' (' . role_title($target['user']['role']) . ')';
                break;
            case 'assign':
                $target = $pickTarget(0, count($chain) - 1);
                $handOff('assigned', $target, 'Assigned');
                $summary = 'assigned to ' . tk_name($target['user']);
                break;
            case 'resolve':
                $resolution = trim((string) ($b['resolution'] ?? ''));
                if (mb_strlen($resolution) < 5) {
                    tk_bad('Describe how the issue was resolved.');
                }
                tk_close_stage((string) $t['id'], $now);
                $event('resolved', 'Resolved', $resolution);
                $t['resolution'] = $resolution;
                $t['resolvedBy'] = $uid;
                $t['resolvedByName'] = $meName;
                $t['resolvedAt'] = (string) $now;
                $summary = 'resolved';
                break;
            case 'close':
                $event('closed', 'Closed', $comment);
                $t['closedBy'] = $uid;
                $t['closedByName'] = $meName;
                $t['closedAt'] = (string) $now;
                $summary = 'closed';
                break;
            case 'reopen':
                if ($reason === '') {
                    tk_bad('Give a reason for reopening.');
                }
                // back to whoever resolved it, if they still can; otherwise routed afresh
                $resolver = tk_user((string) $t['resolvedBy']);
                $rl = $resolver ? tk_level_of($chain, (string) $resolver['role']) : -1;
                $target = (tk_active($resolver) && $rl >= 0)
                    ? ['user' => $resolver, 'level' => $rl]
                    : tk_route($chain, 0, [], '');
                if (!$target) {
                    tk_bad('Nobody is available to take the reopened ticket.');
                }
                $t['resolution'] = '';
                $t['resolvedBy'] = $t['resolvedByName'] = $t['resolvedAt'] = '';
                $t['closedBy'] = $t['closedByName'] = $t['closedAt'] = '';
                $holder = null;   // a reopened ticket arrives from the person reopening it
                tk_log(['ticketId' => $t['id'], 'action' => 'reopened', 'fromUser' => $uid, 'fromName' => $meName,
                        'fromRole' => $me['role'], 'toUser' => $target['user']['id'], 'toName' => tk_name($target['user']),
                        'toRole' => $target['user']['role'], 'status' => 'Reopened', 'level' => $target['level'],
                        'reason' => $reason, 'comment' => $comment, 'at' => $now, 'assignedAt' => $now]);
                $t['assignedTo'] = $target['user']['id'];
                $t['assignedName'] = tk_name($target['user']);
                $t['assignedRole'] = $target['user']['role'];
                $t['assignedAt'] = (string) $now;
                $t['escalationLevel'] = (string) $target['level'];
                $t['status'] = 'Reopened';
                $summary = 'reopened: ' . $reason;
                break;
            default:
                tk_bad('Unknown action.');
        }
        $t['updatedAt'] = (string) $now;
        tk_save($t);
        if ($own) {
            db()->commit();
        }
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
    $link = 'tickets::' . $t['id'];
    $no = (string) $t['ticketNo'];
    $sub = (string) $t['subject'];
    $creator = (string) $t['createdBy'];
    $holderNow = (string) $t['assignedTo'];
    switch ($act) {
        case 'escalate':
            nt_push($holderNow, 'ticket_escalated', 'Escalated to you: ' . $no, $sub . ' — from ' . $meName . ': ' . $reason, $link, (string) $t['id'], 'warning');
            nt_push($creator, 'ticket_escalated', 'Your ticket was escalated: ' . $no, 'Now with ' . $t['assignedName'] . ' (' . role_title((string) $t['assignedRole']) . ').', $link, (string) $t['id']);
            break;
        case 'reassign':
        case 'assign':
            nt_push($holderNow, 'ticket_assigned', 'Ticket assigned to you: ' . $no, $sub . ' — by ' . $meName . '.', $link, (string) $t['id']);
            break;
        case 'comment':
            nt_push_many([$creator, $holderNow], 'ticket_comment', 'New message on ' . $no, $meName . ': ' . mb_substr(trim((string) ($b['message'] ?? 'sent an attachment')), 0, 140), $link, (string) $t['id']);
            break;
        case 'request_info':
            nt_push($creator, 'ticket_info_requested', 'Information needed: ' . $no, $meName . ': ' . $comment, $link, (string) $t['id'], 'warning');
            break;
        case 'resolve':
            nt_push($creator, 'ticket_resolved', 'Resolved: ' . $no, $sub . ' — resolved by ' . $meName . '. Please confirm and close.', $link, (string) $t['id'], 'success');
            break;
        case 'close':
            nt_push_many([$holderNow, (string) $t['resolvedBy']], 'ticket_closed', 'Closed: ' . $no, $sub . ' — closed by ' . $meName . '.', $link, (string) $t['id'], 'success');
            break;
        case 'reopen':
            nt_push($holderNow, 'ticket_reopened', 'Reopened: ' . $no, $sub . ' — reopened by ' . $meName . ': ' . $reason, $link, (string) $t['id'], 'warning');
            break;
    }
    if ($act !== 'comment') {
        audit('ticket-' . $act, 'tickets', (string) $t['id'], (string) $t['ticketNo'], $summary,
            ['from' => $prevStatus, 'to' => (string) $t['status']]);
    }
    send_json(['ok' => true, 'status' => $t['status']]);
}

/** the Super Admin sets the SLA hours per priority */
function api_tk_settings(): void
{
    if (current_role() !== 'admin') {
        send_json(['error' => 'forbidden', 'message' => 'Only the Super Admin configures the SLA.'], 403);
    }
    $in = body()['sla'] ?? null;
    if (!is_array($in)) {
        tk_bad('Send the SLA hours per priority.');
    }
    $out = [];
    foreach (TICKET_PRIORITIES as $p) {
        $h = $in[$p] ?? null;
        if (!is_numeric($h) || (float) $h <= 0 || (float) $h > 8760) {
            tk_bad('SLA for ' . $p . ' must be between 0 and 8760 hours.');
        }
        $out[$p] = (float) $h;
    }
    $before = tk_sla_hours();
    $row = fetch_one('SELECT ' . qi('id') . ' AS id FROM ' . qi('settings') . ' WHERE ' . qi('name') . " = 'ticketSla'");
    upsert('settings', ['id' => $row ? $row['id'] : next_id('settings'), 'name' => 'ticketSla', 'value' => json_encode($out)]);
    audit('ticket-sla', 'settings', 'ticketSla', 'Ticket SLA', 'SLA hours changed',
        ['before' => $before, 'after' => $out]);
    send_json(['ok' => true, 'sla' => $out]);
}

/** the organisation as it is actually wired: every staff login and who it reports to */
function api_tk_org(): void
{
    if (!in_array(current_role(), ORG_TREE_ROLES, true)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — the organisation tree is for the leadership roles.'], 403);
    }
    $rows = fetch_all('SELECT ' . tk_user_cols() . ', ' . qi('empId') . ' AS empId FROM ' . qi('users')
        . ' WHERE ' . qi('role') . " <> 'student'");
    $out = array_map(fn($u) => ['id' => $u['id'], 'name' => tk_name($u), 'username' => $u['username'],
        'role' => $u['role'], 'roleTitle' => role_title((string) $u['role']),
        'active' => tk_active($u), 'reportingTo' => (string) ($u['reportingTo'] ?? ''),
        'empId' => (string) ($u['empId'] ?? '')], $rows);
    send_json(['users' => $out, 'reportsTo' => REPORTS_TO]);
}

/* =====================================================================
   NOTIFICATIONS (in-app bell) — Phase 3
   ---------------------------------------------------------------------
   One row per person per event, written by the server at the moment the
   event happens, never by a browser. SLA warnings are raised by a sweep that
   runs at most once a minute, piggy-backed on the bell's own poll, so no
   cron is needed on shared hosting.
   ===================================================================== */

/** a notification for one account; nobody is told about their own action */
function nt_push(string $userId, string $kind, string $title, string $message, string $link,
                 string $refId = '', string $severity = 'info'): void
{
    if ($userId === '') {
        return;
    }
    $me = current_user();
    if ($me && (string) $me['id'] === $userId && strncmp($kind, 'sla_', 4) !== 0) {
        return;
    }
    try {
        run_sql('INSERT INTO ' . qi('notifications') . ' (' . implode(', ', array_map('qi', COLLECTIONS['notifications']))
            . ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
                tk_id('NT'), $userId, $kind, mb_substr($title, 0, 190), $message, $link, $refId, $severity,
                (string) time(), null,
            ]);
    } catch (Throwable $e) {
        // a notification must never break the action that raised it
        error_log('[nmiet-api] notify: ' . $e->getMessage());
    }
}

function nt_push_many(array $userIds, string $kind, string $title, string $message, string $link,
                      string $refId = '', string $severity = 'info'): void
{
    foreach (array_unique(array_filter(array_map('strval', $userIds))) as $uid) {
        nt_push($uid, $kind, $title, $message, $link, $refId, $severity);
    }
}

/** a small key/value in _meta, which is outside the live-poll signature */
function nt_meta_get(string $k): string
{
    try {
        $r = fetch_one('SELECT ' . qi('v') . ' AS v FROM ' . qi('_meta') . ' WHERE ' . qi('k') . ' = ?', [$k]);
        return $r ? (string) $r['v'] : '';
    } catch (Throwable $e) {
        return '';
    }
}

function nt_meta_set(string $k, string $v): void
{
    $st = db()->prepare('UPDATE ' . qi('_meta') . ' SET ' . qi('v') . ' = ? WHERE ' . qi('k') . ' = ?');
    $st->execute([$v, $k]);
    if ($st->rowCount() === 0 && nt_meta_get($k) === '') {
        try {
            run_sql('INSERT INTO ' . qi('_meta') . ' (' . qi('k') . ', ' . qi('v') . ') VALUES (?, ?)', [$k, $v]);
        } catch (PDOException $e) {
            // a racing request wrote it first
        }
    }
}

/**
 * SLA warnings, following the hierarchy: at 75% of the budget the holder is
 * warned; past the deadline the holder and the next authority above them are
 * told. Each ticket is warned once per threshold.
 */
function tk_sla_sweep(): void
{
    $now = time();
    if ($now - (int) nt_meta_get('slaSweepAt') < 60) {
        return;
    }
    nt_meta_set('slaSweepAt', (string) $now);
    $rows = fetch_all('SELECT ' . implode(', ', array_map('qi', ['id', 'ticketNo', 'subject', 'status', 'assignedTo',
        'assignedName', 'assignedRole', 'chain', 'escalationLevel', 'slaHours', 'createdAt', 'slaRiskNotifiedAt',
        'slaBreachNotifiedAt'])) . ' FROM ' . qi('tickets') . ' WHERE ' . qi('status') . " NOT IN ('Resolved', 'Closed')");
    foreach ($rows as $t) {
        $budget = (int) round((float) $t['slaHours'] * 3600);
        if ($budget <= 0) {
            continue;
        }
        $used = $now - (int) $t['createdAt'];
        $link = 'tickets::' . $t['id'];
        if ($used > $budget && (string) ($t['slaBreachNotifiedAt'] ?? '') === '') {
            $holder = tk_user((string) $t['assignedTo']);
            $chain = TICKET_CHAINS[(string) $t['chain']] ?? [];
            $cur = (int) $t['escalationLevel'];
            $next = $cur + 1 < count($chain)
                ? tk_route($chain, $cur + 1, $holder ? tk_line_above($holder) : [], (string) $t['assignedTo']) : null;
            $msg = $t['subject'] . ' — SLA breached; now with ' . ($t['assignedName'] ?: 'nobody') . '.';
            nt_push_many([(string) $t['assignedTo'], $next ? $next['user']['id'] : ''], 'sla_breach',
                'SLA breached: ' . $t['ticketNo'], $msg, $link, (string) $t['id'], 'danger');
            run_sql('UPDATE ' . qi('tickets') . ' SET ' . qi('slaBreachNotifiedAt') . ' = ?, ' . qi('slaRiskNotifiedAt')
                . ' = COALESCE(NULLIF(' . qi('slaRiskNotifiedAt') . ", ''), ?) WHERE " . qi('id') . ' = ?',
                [(string) $now, (string) $now, $t['id']]);
        } elseif ($used >= $budget * 0.75 && $used <= $budget && (string) ($t['slaRiskNotifiedAt'] ?? '') === '') {
            nt_push((string) $t['assignedTo'], 'sla_risk', 'SLA at risk: ' . $t['ticketNo'],
                $t['subject'] . ' — ' . max(1, (int) round(($budget - $used) / 60)) . ' min left before the SLA deadline.',
                $link, (string) $t['id'], 'warning');
            run_sql('UPDATE ' . qi('tickets') . ' SET ' . qi('slaRiskNotifiedAt') . ' = ? WHERE ' . qi('id') . ' = ?',
                [(string) $now, $t['id']]);
        }
    }
}

/** the bell: this account's latest notifications and how many are unread */
function api_nt_list(): void
{
    $me = current_user();
    try {
        tk_sla_sweep();
    } catch (Throwable $e) {
        error_log('[nmiet-api] sla sweep: ' . $e->getMessage());
    }
    $uid = (string) $me['id'];
    $rows = fetch_all('SELECT * FROM ' . qi('notifications') . ' WHERE ' . qi('userId') . ' = ? ORDER BY '
        . qi('at') . ' DESC, ' . qi('id') . ' DESC LIMIT 40', [$uid]);
    $unread = fetch_one('SELECT COUNT(*) AS n FROM ' . qi('notifications') . ' WHERE ' . qi('userId') . ' = ? AND ('
        . qi('readAt') . ' IS NULL OR ' . qi('readAt') . " = '')", [$uid]);
    send_json(['now' => time(), 'unread' => (int) ($unread['n'] ?? 0),
               'items' => array_map(fn($r) => tk_int_fields($r, ['at', 'readAt']), $rows)]);
}

/** mark one, or all, of the caller's own notifications read */
function api_nt_read(): void
{
    $me = current_user();
    $b = body();
    $now = (string) time();
    if (!empty($b['all'])) {
        run_sql('UPDATE ' . qi('notifications') . ' SET ' . qi('readAt') . ' = ? WHERE ' . qi('userId') . ' = ? AND ('
            . qi('readAt') . ' IS NULL OR ' . qi('readAt') . " = '')", [$now, (string) $me['id']]);
    } else {
        run_sql('UPDATE ' . qi('notifications') . ' SET ' . qi('readAt') . ' = ? WHERE ' . qi('id') . ' = ? AND '
            . qi('userId') . ' = ?', [$now, (string) ($b['id'] ?? ''), (string) $me['id']]);
    }
    send_json(['ok' => true]);
}

/* =====================================================================
   APPROVALS — Phase 4
   ---------------------------------------------------------------------
   A request climbs the requester's reporting line. Each type names the
   authority needed to finally approve it (a rank); an approver who holds
   that authority decides, one who does not forwards it upward with their
   approval recorded — so unnecessary levels are skipped and necessary ones
   are not. Returned requests go back to the requester to correct.
   ===================================================================== */

/** how much authority a role carries — higher decides more */
const AUTH_RANK = [
    'admin' => 100, 'subadmin' => 90, 'center_head' => 80, 'academic_head' => 70,
    'dean_placement' => 60, 'course_coordinator' => 60, 'admission' => 55, 'accountant' => 55,
    'librarian' => 55, 'plmt_officer' => 50, 'placement_officer' => 50, 'plmt_coordinator' => 40,
    'faculty' => 20, 'guest_faculty' => 15, 'student' => 0,
];
const APPROVAL_TYPES = [
    'Leave Request'                 => ['rank' => 60, 'authority' => 'Course Coordinator / reporting manager'],
    'Academic Change'               => ['rank' => 70, 'authority' => 'Academic Head'],
    'Event / Activity'              => ['rank' => 70, 'authority' => 'Academic Head'],
    'Training / Placement Activity' => ['rank' => 60, 'authority' => 'Dean T&P'],
    'Purchase / Expense'            => ['rank' => 80, 'authority' => 'Center Head'],
    'Policy / Exception'            => ['rank' => 90, 'authority' => 'Admin'],
    'Attendance Correction'         => ['rank' => 100, 'authority' => 'Super Admin'],
    'Other'                         => ['rank' => 80, 'authority' => 'Center Head'],
];
const APPROVAL_STAGE_ACTIONS = ['assigned', 'forwarded', 'escalated', 'resubmitted'];
const APPROVAL_OPEN = ['Pending', 'Escalated', 'Returned'];

/* A fixed approval ladder for the roles that use one. Their requests ignore the
   day-to-day reporting line and always climb this chain, lowest rung first; the
   last rung is the final approver. The Super Admin can still act on anything. */
const APPROVAL_CHAINS = [
    'faculty'       => ['academic_head', 'center_head'],
    'guest_faculty' => ['academic_head', 'center_head'],
];

/** the authority a request needs to be decided, given who raised it */
function ap_required_rank(string $requesterRole, string $type): int
{
    // an attendance correction always climbs the full chain to the Super Admin,
    // regardless of the requester's usual fixed ladder
    if ($type === 'Attendance Correction') {
        return AUTH_RANK['admin'];
    }
    if (isset(APPROVAL_CHAINS[$requesterRole])) {
        $chain = APPROVAL_CHAINS[$requesterRole];
        return ap_rank((string) end($chain));
    }
    return (int) (APPROVAL_TYPES[$type]['rank'] ?? 80);
}

/** the label shown for who gives the final decision, given who raised it */
function ap_authority_label(string $requesterRole, string $type): string
{
    if ($type === 'Attendance Correction') {
        return 'Super Admin';
    }
    if (isset(APPROVAL_CHAINS[$requesterRole])) {
        $chain = APPROVAL_CHAINS[$requesterRole];
        return role_title((string) end($chain));
    }
    return (string) (APPROVAL_TYPES[$type]['authority'] ?? 'Center Head');
}

/** hours after which a submitted register locks (Super Admin setting, default 24) */
function attendance_lock_hours(): int
{
    $v = (int) setting_value('attendanceLockHours', '24');
    return $v > 0 ? $v : 24;
}

/* Apply an approved attendance-correction to the register and log it. The
   original marks stay in the approval + audit trail, so nothing is lost. */
function ap_apply_attendance_correction(array $a, array $me, int $now): ?string
{
    $data = $a['linkData'] ?? [];
    if (is_string($data)) {
        $data = json_decode($data, true) ?: [];
    }
    $attId = (string) ($data['attendanceId'] ?? '');
    $sid   = (string) ($data['studentId'] ?? '');
    $newSt = (string) ($data['newStatus'] ?? '');
    if ($attId === '' || $sid === '' || !in_array($newSt, ['P', 'A'], true)) {
        return null;
    }
    $row = fetch_one('SELECT * FROM ' . qi('attendance') . ' WHERE ' . qi('id') . ' = ?', [$attId]);
    if (!$row) {
        return null;
    }
    $records = json_decode((string) ($row['records'] ?? '{}'), true);
    if (!is_array($records)) {
        $records = [];
    }
    $old = (string) ($records[$sid] ?? '');
    $records[$sid] = $newSt;
    run_sql('UPDATE ' . qi('attendance') . ' SET ' . qi('records') . ' = ? WHERE ' . qi('id') . ' = ?',
        [json_encode($records), $attId]);
    audit('attendance-correction-applied', 'attendance', $attId,
        (string) ($data['studentName'] ?? $sid),
        'Attendance corrected via ' . (string) $a['approvalNo'] . ' — ' . ($old === 'A' ? 'Absent' : 'Present')
            . ' → ' . ($newSt === 'A' ? 'Absent' : 'Present') . ' (approved by ' . tk_name($me) . ')',
        ['from' => $old, 'to' => $newSt, 'student' => $sid, 'approval' => $a['approvalNo']]);
    return $old . '→' . $newSt;
}

function ap_rank(string $role): int
{
    if (isset(AUTH_RANK[$role])) {
        return AUTH_RANK[$role];
    }
    return base_role($role) === 'admin' ? 50 : 10;
}

/** who an account's requests go to: its own manager, else a holder of a role it reports to */
function ap_manager_of(array $u): ?array
{
    /* Roles with a fixed ladder skip their day-to-day reporting line: the
       request goes to the first rung above them that has a holder (e.g. a
       faculty member's request goes to the Academic Head, not their
       Coordinator). The rungs above them are ordinary roles, so when they
       forward it climbs on through the normal path below to the Center Head. */
    $chain = APPROVAL_CHAINS[(string) $u['role']] ?? null;
    if ($chain) {
        foreach ($chain as $nextRole) {
            foreach (tk_users_with_roles([$nextRole]) as $c) {
                if ((string) $c['id'] !== (string) $u['id']) {
                    return $c;
                }
            }
        }
    }
    $p = tk_user(trim((string) ($u['reportingTo'] ?? '')));
    if (tk_active($p) && (string) $p['id'] !== (string) $u['id']) {
        return $p;
    }
    $roles = REPORTS_TO[(string) $u['role']] ?? ['center_head', 'subadmin', 'admin'];
    foreach (array_merge($roles, ['center_head', 'admin']) as $role) {
        foreach (tk_users_with_roles([$role]) as $c) {
            if ((string) $c['id'] !== (string) $u['id'] && ap_rank((string) $c['role']) > ap_rank((string) $u['role'])) {
                return $c;
            }
        }
    }
    return null;
}

function ap_load(string $id): ?array
{
    if ($id === '') {
        return null;
    }
    $a = fetch_one('SELECT * FROM ' . qi('approvals') . ' WHERE ' . qi('id') . ' = ?', [$id]);
    return $a ? row_out('approvals', $a) : null;
}

function ap_log(array $row): void
{
    $cols = COLLECTIONS['approvalsteps'];
    $row['id'] = $row['id'] ?? tk_id('AS');
    $vals = [];
    foreach ($cols as $c) {
        $vals[] = array_key_exists($c, $row) && $row[$c] !== null ? (string) $row[$c] : null;
    }
    run_sql('INSERT INTO ' . qi('approvalsteps') . ' (' . implode(', ', array_map('qi', $cols)) . ') VALUES ('
        . implode(', ', array_fill(0, count($cols), '?')) . ')', $vals);
}

function ap_close_stage(string $approvalId, int $now): void
{
    $in = implode(', ', array_fill(0, count(APPROVAL_STAGE_ACTIONS), '?'));
    $st = fetch_one('SELECT ' . qi('id') . ' AS id, ' . qi('assignedAt') . ' AS assignedAt FROM ' . qi('approvalsteps')
        . ' WHERE ' . qi('approvalId') . ' = ? AND ' . qi('action') . ' IN (' . $in . ') AND (' . qi('completedAt')
        . ' IS NULL OR ' . qi('completedAt') . " = '') ORDER BY " . qi('assignedAt') . ' DESC, ' . qi('id') . ' DESC LIMIT 1',
        array_merge([$approvalId], APPROVAL_STAGE_ACTIONS));
    if ($st) {
        run_sql('UPDATE ' . qi('approvalsteps') . ' SET ' . qi('completedAt') . ' = ?, ' . qi('seconds') . ' = ? WHERE '
            . qi('id') . ' = ?', [(string) $now, (string) max(0, $now - (int) $st['assignedAt']), $st['id']]);
    }
}

function ap_can_see(array $a, array $me, ?bool $involved = null): bool
{
    $uid = (string) $me['id'];
    if (in_array((string) $me['role'], ['admin', 'center_head', 'subadmin'], true)) {
        return true;
    }
    if ((string) $a['requestedBy'] === $uid || (string) $a['currentApprover'] === $uid) {
        return true;
    }
    if ($involved === null) {
        $involved = (bool) fetch_one('SELECT 1 AS x FROM ' . qi('approvalsteps') . ' WHERE ' . qi('approvalId')
            . ' = ? AND (' . qi('toUser') . ' = ? OR ' . qi('fromUser') . ' = ?) LIMIT 1', [(string) $a['id'], $uid, $uid]);
    }
    return $involved;
}

function ap_allowed(array $a, array $me): array
{
    $uid = (string) $me['id'];
    $s = (string) $a['status'];
    $approver = (string) $a['currentApprover'] === $uid && in_array($s, ['Pending', 'Escalated'], true);
    $override = (string) $me['role'] === 'admin' && in_array($s, ['Pending', 'Escalated'], true)
        && (string) $a['requestedBy'] !== $uid;
    $requester = (string) $a['requestedBy'] === $uid;
    return [
        'approve'  => $approver || $override,
        'reject'   => $approver || $override,
        'return'   => $approver,
        'escalate' => $approver,
        'resubmit' => $requester && $s === 'Returned',
    ];
}

const APPROVAL_LIST_FIELDS = ['id', 'approvalNo', 'type', 'title', 'amount', 'fromDate', 'toDate', 'requiredRank',
    'requestedBy', 'requestedByName', 'requestedByRole', 'requestedReportsTo', 'currentApprover',
    'currentApproverName', 'currentApproverRole', 'assignedAt', 'status', 'level', 'createdAt', 'updatedAt',
    'decidedAt', 'decidedByName'];
const APPROVAL_TIME_FIELDS = ['assignedAt', 'level', 'createdAt', 'updatedAt', 'decidedAt', 'requiredRank'];

function api_ap_meta(): void
{
    $me = current_user();
    $role = (string) $me['role'];
    $types = [];
    foreach (APPROVAL_TYPES as $name => $d) {
        // Attendance Correction is raised only from the attendance register (it
        // carries the record it changes), never picked by hand here
        if ($name === 'Attendance Correction') {
            continue;
        }
        // authority and rank follow who is asking, so a fixed-ladder role sees
        // its own final approver (the Center Head), not the type's default
        $types[] = ['name' => $name, 'authority' => ap_authority_label($role, $name),
                    'rank' => ap_required_rank($role, $name)];
    }
    $mgr = $role === 'student' ? null : ap_manager_of(tk_user((string) $me['id']) ?? $me);
    send_json(['types' => $types, 'myRank' => ap_rank($role),
               'manager' => $mgr ? ['id' => $mgr['id'], 'name' => tk_name($mgr), 'role' => $mgr['role']] : null]);
}

function api_ap_list(): void
{
    $me = current_user();
    $uid = (string) $me['id'];
    $mine = [];
    foreach (fetch_all('SELECT DISTINCT ' . qi('approvalId') . ' AS a FROM ' . qi('approvalsteps') . ' WHERE '
        . qi('toUser') . ' = ? OR ' . qi('fromUser') . ' = ?', [$uid, $uid]) as $r) {
        $mine[(string) $r['a']] = true;
    }
    $out = [];
    foreach (fetch_all('SELECT ' . implode(', ', array_map('qi', APPROVAL_LIST_FIELDS)) . ' FROM ' . qi('approvals')
        . ' ORDER BY ' . qi('createdAt') . ' DESC') as $a) {
        if (!ap_can_see($a, $me, isset($mine[(string) $a['id']]))) {
            continue;
        }
        $a = tk_int_fields($a, APPROVAL_TIME_FIELDS);
        $a['involved'] = isset($mine[(string) $a['id']]);
        $out[] = $a;
    }
    send_json(['now' => time(), 'me' => ['id' => $uid, 'role' => (string) $me['role']], 'approvals' => $out]);
}

function api_ap_get(?string $id): void
{
    $me = current_user();
    $a = ap_load((string) $id);
    if (!$a) {
        send_json(['error' => 'not found', 'message' => 'Request not found.'], 404);
    }
    if (!ap_can_see($a, $me)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — this request is outside your scope.'], 403);
    }
    $steps = array_map(fn($s) => tk_int_fields($s, ['level', 'at', 'assignedAt', 'completedAt', 'seconds']),
        fetch_all('SELECT * FROM ' . qi('approvalsteps') . ' WHERE ' . qi('approvalId') . ' = ? ORDER BY '
            . qi('at') . ' ASC, ' . qi('id') . ' ASC', [(string) $a['id']]));
    $allowed = ap_allowed($a, $me);
    $approver = tk_user((string) $a['currentApprover']);
    $next = null;
    if ($approver && in_array((string) $a['status'], ['Pending', 'Escalated'], true)) {
        $n = ap_manager_of($approver);
        $next = $n ? ['id' => $n['id'], 'name' => tk_name($n), 'role' => $n['role']] : null;
    }
    $decides = $approver ? ap_rank((string) $approver['role']) >= (int) $a['requiredRank'] || (string) $approver['role'] === 'admin' : false;
    $a = tk_int_fields($a, APPROVAL_TIME_FIELDS);
    send_json(['now' => time(), 'approval' => $a, 'steps' => $steps, 'allowed' => $allowed, 'next' => $next,
               'approverDecides' => $decides, 'authority' => ap_authority_label((string) $a['requestedByRole'], (string) $a['type']),
               'me' => ['id' => (string) $me['id'], 'role' => (string) $me['role']]]);
}

function api_ap_create(): void
{
    $me = current_user();
    $role = (string) $me['role'];
    if ($role === 'student') {
        send_json(['error' => 'forbidden', 'message' => 'Students raise a ticket instead of an approval request.'], 403);
    }
    if ($role === 'admin') {
        send_json(['error' => 'forbidden', 'message' => 'The Super Admin decides requests; there is nobody above to ask.'], 403);
    }
    $b = body();
    $type = (string) ($b['type'] ?? '');
    $title = trim((string) ($b['title'] ?? ''));
    $details = trim((string) ($b['details'] ?? ''));
    if (!isset(APPROVAL_TYPES[$type])) {
        tk_bad('Choose a request type.');
    }
    if (mb_strlen($title) < 3 || mb_strlen($title) > 200) {
        tk_bad('Give the request a title of 3 to 200 characters.');
    }
    if ($details === '') {
        tk_bad('Describe what you are asking for.');
    }
    $amount = trim((string) ($b['amount'] ?? ''));
    if ($amount !== '' && (!is_numeric($amount) || (float) $amount < 0)) {
        tk_bad('Amount must be a positive number.');
    }
    $from = trim((string) ($b['fromDate'] ?? ''));
    $to = trim((string) ($b['toDate'] ?? ''));
    foreach ([$from, $to] as $d) {
        if ($d !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
            tk_bad('Dates must be in YYYY-MM-DD form.');
        }
    }
    if ($from !== '' && $to !== '' && $to < $from) {
        tk_bad('The end date is before the start date.');
    }
    // an attendance correction carries the register + student it will change; it
    // is validated here so nothing bogus enters the approval chain
    $linkType = ''; $linkData = [];
    if ($type === 'Attendance Correction') {
        $ld = $b['linkData'] ?? null;
        if (is_string($ld)) { $ld = json_decode($ld, true); }
        $attId = is_array($ld) ? (string) ($ld['attendanceId'] ?? '') : '';
        $sid   = is_array($ld) ? (string) ($ld['studentId'] ?? '') : '';
        $newSt = is_array($ld) ? (string) ($ld['newStatus'] ?? '') : '';
        if ($attId === '' || $sid === '' || !in_array($newSt, ['P', 'A'], true)) {
            tk_bad('The correction is missing the class, student or new status.');
        }
        $att = fetch_one('SELECT * FROM ' . qi('attendance') . ' WHERE ' . qi('id') . ' = ?', [$attId]);
        if (!$att) {
            tk_bad('That attendance register no longer exists.');
        }
        $records = json_decode((string) ($att['records'] ?? '{}'), true) ?: [];
        if (!array_key_exists($sid, $records)) {
            tk_bad('That student is not in this register.');
        }
        $old = (string) $records[$sid];
        if ($old === $newSt) {
            tk_bad('The requested status is the same as the current one.');
        }
        $linkType = 'attendance-correction';
        $linkData = ['attendanceId' => $attId, 'studentId' => $sid,
                     'studentName' => (string) ($ld['studentName'] ?? ''),
                     'subject' => (string) ($ld['subject'] ?? ''), 'date' => (string) ($ld['date'] ?? ''),
                     'oldStatus' => $old, 'newStatus' => $newSt];
    }
    $meRow = tk_user((string) $me['id']) ?? $me;
    $approver = ap_manager_of($meRow);
    if (!$approver) {
        tk_bad('Nobody is available in your reporting line to approve this. Ask the Super Admin to set your Reporting To.');
    }
    $boss = tk_user(trim((string) ($meRow['reportingTo'] ?? '')));
    $now = time();
    $year = gmdate('Y', $now);
    $a = [
        'id' => tk_id('AP'), 'approvalNo' => sprintf('APR-%s-%05d', $year, tk_take_seq('approval:' . $year)),
        'type' => $type, 'title' => $title, 'details' => $details, 'amount' => $amount,
        'fromDate' => $from, 'toDate' => $to, 'requiredRank' => (string) ap_required_rank($role, $type),
        'requestedBy' => (string) $me['id'], 'requestedByName' => tk_name($me), 'requestedByRole' => $role,
        'requestedReportsTo' => $boss ? tk_name($boss) . ' (' . role_title((string) $boss['role']) . ')' : '',
        'currentApprover' => $approver['id'], 'currentApproverName' => tk_name($approver),
        'currentApproverRole' => $approver['role'], 'assignedAt' => (string) $now,
        'status' => 'Pending', 'level' => '1', 'createdAt' => (string) $now, 'updatedAt' => (string) $now,
        'decidedAt' => '', 'decidedBy' => '', 'decidedByName' => '', 'finalRemarks' => '',
        'attachments' => tk_clean_attachments($b['attachments'] ?? []),
        'linkType' => $linkType, 'linkData' => $linkData,
    ];
    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        upsert('approvals', $a);
        ap_log(['approvalId' => $a['id'], 'action' => 'requested', 'fromUser' => $me['id'], 'fromName' => tk_name($me),
                'fromRole' => $role, 'status' => 'Pending', 'at' => $now]);
        ap_log(['approvalId' => $a['id'], 'action' => 'assigned', 'fromUser' => $me['id'], 'fromName' => tk_name($me),
                'fromRole' => $role, 'toUser' => $approver['id'], 'toName' => tk_name($approver),
                'toRole' => $approver['role'], 'status' => 'Pending', 'level' => 1, 'at' => $now, 'assignedAt' => $now]);
        if ($own) {
            db()->commit();
        }
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
    nt_push((string) $approver['id'], 'approval_requested', 'Approval needed: ' . $a['approvalNo'],
        $type . ' — ' . $title . ' (from ' . tk_name($me) . ', ' . role_title($role) . ')', 'approvals::' . $a['id'], $a['id'], 'warning');
    audit('approval-request', 'approvals', $a['id'], $a['approvalNo'], $type . ': ' . $title . ' → ' . tk_name($approver));
    send_json(['ok' => true, 'id' => $a['id'], 'approvalNo' => $a['approvalNo'],
               'approverName' => tk_name($approver), 'approverRole' => $approver['role']], 201);
}

function api_ap_action(): void
{
    $me = current_user();
    $b = body();
    $a = ap_load((string) ($b['id'] ?? ''));
    if (!$a) {
        send_json(['error' => 'not found', 'message' => 'Request not found.'], 404);
    }
    if (!ap_can_see($a, $me)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — this request is outside your scope.'], 403);
    }
    $act = (string) ($b['action'] ?? '');
    $allowed = ap_allowed($a, $me);
    if (empty($allowed[$act])) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — you cannot do that on this request now.'], 403);
    }
    $remarks = trim((string) ($b['remarks'] ?? ''));
    $now = time();
    $uid = (string) $me['id'];
    $meName = tk_name($me);
    $link = 'approvals::' . $a['id'];
    $requester = (string) $a['requestedBy'];
    $prev = (string) $a['status'];
    $notes = [];
    $summary = '';
    $step = function (array $row) use ($a, $now, $me, $meName) {
        ap_log(array_merge(['approvalId' => $a['id'], 'fromUser' => $me['id'], 'fromName' => $meName,
                            'fromRole' => $me['role'], 'at' => $now], $row));
    };
    $moveTo = function (array $to, string $action, string $status) use (&$a, $now, $step, $remarks) {
        $a['level'] = (string) ((int) $a['level'] + 1);
        $step(['action' => $action, 'toUser' => $to['id'], 'toName' => tk_name($to), 'toRole' => $to['role'],
               'status' => $status, 'remarks' => $remarks, 'level' => $a['level'], 'assignedAt' => $now]);
        $a['currentApprover'] = $to['id'];
        $a['currentApproverName'] = tk_name($to);
        $a['currentApproverRole'] = $to['role'];
        $a['assignedAt'] = (string) $now;
        $a['status'] = $status;
    };
    $decide = function (string $status) use (&$a, $now, $uid, $meName, $remarks) {
        $a['status'] = $status;
        $a['decidedAt'] = (string) $now;
        $a['decidedBy'] = $uid;
        $a['decidedByName'] = $meName;
        $a['finalRemarks'] = $remarks;
    };

    $own = !db()->inTransaction();
    if ($own) {
        db()->beginTransaction();
    }
    try {
        switch ($act) {
            case 'approve':
                ap_close_stage((string) $a['id'], $now);
                $authority = (string) $me['role'] === 'admin' || ap_rank((string) $me['role']) >= (int) $a['requiredRank'];
                $up = $authority ? null : ap_manager_of(tk_user($uid) ?? $me);
                if ($authority || !$up) {
                    $step(['action' => 'approved', 'status' => 'Approved', 'remarks' => $remarks, 'level' => $a['level']]);
                    $decide('Approved');
                    $notes[] = [[$requester], 'approval_approved', 'Approved: ' . $a['approvalNo'],
                                $a['title'] . ' — approved by ' . $meName . '.', 'success'];
                    $summary = 'approved';
                } else {
                    // approved at this level, but it needs a higher authority
                    $step(['action' => 'approved', 'status' => 'Pending', 'remarks' => $remarks, 'level' => $a['level']]);
                    $moveTo($up, 'forwarded', 'Pending');
                    $notes[] = [[$up['id']], 'approval_requested', 'Approval needed: ' . $a['approvalNo'],
                                $a['type'] . ' — ' . $a['title'] . ' (approved by ' . $meName . ', needs your decision)', 'warning'];
                    $notes[] = [[$requester], 'approval_forwarded', 'Moving up: ' . $a['approvalNo'],
                                $meName . ' approved; forwarded to ' . tk_name($up) . ' (' . role_title((string) $up['role']) . ').', 'info'];
                    $summary = 'approved at level, forwarded to ' . tk_name($up);
                }
                break;
            case 'reject':
                if ($remarks === '') {
                    tk_bad('Give a reason for rejecting.');
                }
                ap_close_stage((string) $a['id'], $now);
                $step(['action' => 'rejected', 'status' => 'Rejected', 'remarks' => $remarks, 'level' => $a['level']]);
                $decide('Rejected');
                $notes[] = [[$requester], 'approval_rejected', 'Rejected: ' . $a['approvalNo'],
                            $a['title'] . ' — rejected by ' . $meName . ': ' . $remarks, 'danger'];
                $summary = 'rejected: ' . $remarks;
                break;
            case 'return':
                if ($remarks === '') {
                    tk_bad('Say what needs to be corrected.');
                }
                ap_close_stage((string) $a['id'], $now);
                $step(['action' => 'returned', 'toUser' => $requester, 'toName' => $a['requestedByName'],
                       'toRole' => $a['requestedByRole'], 'status' => 'Returned', 'remarks' => $remarks, 'level' => $a['level']]);
                $a['status'] = 'Returned';
                $notes[] = [[$requester], 'approval_returned', 'Returned for correction: ' . $a['approvalNo'],
                            $meName . ': ' . $remarks, 'warning'];
                $summary = 'returned: ' . $remarks;
                break;
            case 'escalate':
                if ($remarks === '') {
                    tk_bad('Give a reason for escalating.');
                }
                $up = ap_manager_of(tk_user($uid) ?? $me);
                if (!$up) {
                    tk_bad('There is no higher authority to escalate to.');
                }
                ap_close_stage((string) $a['id'], $now);
                $moveTo($up, 'escalated', 'Escalated');
                $notes[] = [[$up['id']], 'approval_requested', 'Escalated to you: ' . $a['approvalNo'],
                            $a['title'] . ' — escalated by ' . $meName . ': ' . $remarks, 'warning'];
                $notes[] = [[$requester], 'approval_escalated', 'Escalated: ' . $a['approvalNo'],
                            $meName . ' escalated it to ' . tk_name($up) . '.', 'info'];
                $summary = 'escalated to ' . tk_name($up);
                break;
            case 'resubmit':
                $details = trim((string) ($b['details'] ?? ''));
                if ($details !== '') {
                    $a['details'] = $details;
                }
                $approver = tk_user((string) $a['currentApprover']);
                if (!tk_active($approver)) {
                    $approver = ap_manager_of(tk_user($uid) ?? $me);
                }
                if (!$approver) {
                    tk_bad('Nobody is available to review the resubmitted request.');
                }
                $step(['action' => 'resubmitted', 'toUser' => $approver['id'], 'toName' => tk_name($approver),
                       'toRole' => $approver['role'], 'status' => 'Pending', 'remarks' => $remarks,
                       'level' => $a['level'], 'assignedAt' => $now]);
                $a['currentApprover'] = $approver['id'];
                $a['currentApproverName'] = tk_name($approver);
                $a['currentApproverRole'] = $approver['role'];
                $a['assignedAt'] = (string) $now;
                $a['status'] = 'Pending';
                $notes[] = [[$approver['id']], 'approval_requested', 'Resubmitted: ' . $a['approvalNo'],
                            $a['title'] . ' — corrected and resubmitted by ' . $meName . '.', 'warning'];
                $summary = 'resubmitted';
                break;
            default:
                tk_bad('Unknown action.');
        }
        // a linked record (e.g. an attendance correction) is applied the moment
        // the request reaches its final approval — inside this same transaction
        if ($a['status'] === 'Approved' && (string) ($a['linkType'] ?? '') === 'attendance-correction') {
            ap_apply_attendance_correction($a, $me, $now);
        }
        $a['updatedAt'] = (string) $now;
        upsert('approvals', $a);
        if ($own) {
            db()->commit();
        }
    } catch (Throwable $e) {
        if ($own && db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
    foreach ($notes as [$ids, $kind, $title, $msg, $sev]) {
        nt_push_many($ids, $kind, $title, $msg, $link, (string) $a['id'], $sev);
    }
    audit('approval-' . $act, 'approvals', (string) $a['id'], (string) $a['approvalNo'], $summary,
        ['from' => $prev, 'to' => (string) $a['status']]);
    send_json(['ok' => true, 'status' => $a['status'], 'approverName' => $a['currentApproverName']]);
}

/* =====================================================================
   REPORTS — Phase 5
   ---------------------------------------------------------------------
   Every report is built on the server from rows the caller is already
   allowed to see — the ticket and approval visibility rules, the reporting
   line, assigned courses, and the RBAC grant — so filters and exports can
   only ever narrow that set. Every export is written to the audit log.
   ===================================================================== */

const REPORT_CATALOG = [
    'tickets'    => ['label' => 'Ticket Report', 'group' => 'Helpdesk'],
    'approvals'  => ['label' => 'Approval Report', 'group' => 'Approvals'],
    'myteam'     => ['label' => 'Team & Hierarchy Report', 'group' => 'Organisation'],
    'attendance' => ['label' => 'Attendance Report', 'group' => 'Academic', 'module' => 'attendance',
                     'roles' => ['center_head', 'course_coordinator', 'faculty', 'guest_faculty']],
    'marks'      => ['label' => 'Marks & Results Report', 'group' => 'Academic', 'module' => 'marks',
                     'roles' => ['center_head', 'course_coordinator', 'faculty', 'guest_faculty']],
    'workload'   => ['label' => 'Faculty Workload Report', 'group' => 'Academic', 'module' => 'academics',
                     'roles' => ['center_head', 'course_coordinator']],
    'admissions' => ['label' => 'Admission Report', 'group' => 'Admission', 'module' => 'students',
                     'roles' => ['center_head', 'admission']],
    'fees'       => ['label' => 'Fee & Payment Report', 'group' => 'Finance', 'module' => 'fees',
                     'roles' => ['center_head', 'accountant']],
    'placement'  => ['label' => 'Training & Placement Report', 'group' => 'T&P', 'module' => 'placement',
                     'roles' => ['center_head', 'placement_officer']],
    'library'    => ['label' => 'Library Report', 'group' => 'Library', 'module' => 'library',
                     'roles' => ['center_head', 'librarian']],
];
const REPORT_OPEN = ['tickets', 'approvals', 'myteam'];

function rp_allowed(string $key, array $me, string $need = 'view'): bool
{
    $role = (string) $me['role'];
    $def = REPORT_CATALOG[$key] ?? null;
    if (!$def || $role === 'student') {
        return false;
    }
    if ($role === 'admin' || in_array($key, REPORT_OPEN, true)) {
        return true;
    }
    if (has_custom_access()) {
        return in_array($need, effective_perms()[$def['module']] ?? [], true);
    }
    return in_array($role, $def['roles'], true);
}

function rp_tz(): DateTimeZone
{
    static $tz = null;
    return $tz ?? ($tz = new DateTimeZone('Asia/Kolkata'));
}

/** epoch seconds -> Y-m-d in the college's own time zone */
function rp_day(?int $ts): string
{
    return $ts ? (new DateTime('@' . $ts))->setTimezone(rp_tz())->format('Y-m-d') : '';
}

function rp_dt(?int $ts): string
{
    return $ts ? (new DateTime('@' . $ts))->setTimezone(rp_tz())->format('d M Y, H:i') : '';
}

function rp_in_range(string $day, array $f): bool
{
    if ($day === '') {
        return ($f['from'] ?? '') === '' && ($f['to'] ?? '') === '';
    }
    if (($f['from'] ?? '') !== '' && $day < $f['from']) {
        return false;
    }
    if (($f['to'] ?? '') !== '' && $day > $f['to']) {
        return false;
    }
    return true;
}

/** every login below an account in the reporting tree */
function rp_descendants(string $uid): array
{
    $rows = fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('reportingTo') . ' AS p FROM ' . qi('users'));
    $kids = [];
    foreach ($rows as $r) {
        $kids[(string) $r['p']][] = (string) $r['id'];
    }
    $out = [];
    $queue = $kids[$uid] ?? [];
    while ($queue) {
        $id = array_shift($queue);
        if (isset($out[$id]) || $id === $uid) {
            continue;
        }
        $out[$id] = true;
        foreach ($kids[$id] ?? [] as $k) {
            $queue[] = $k;
        }
    }
    return array_keys($out);
}

/**
 * The courses an academic report may cover: a teacher's own, a coordinator's
 * team's (when a team has been placed under them), everyone else's all.
 */
function rp_course_scope(array $me): ?array
{
    $role = (string) $me['role'];
    if (in_array($role, ['faculty', 'guest_faculty'], true)) {
        return array_column(fetch_all('SELECT ' . qi('id') . ' AS id FROM ' . qi('courses') . ' WHERE '
            . qi('facultyId') . ' = ?', [(string) ($me['refId'] ?? '')]), 'id');
    }
    if ($role === 'course_coordinator' && !has_custom_access()) {
        $team = rp_descendants((string) $me['id']);
        $refs = [];
        foreach ($team as $tid) {
            $u = fetch_one('SELECT ' . qi('role') . ' AS role, ' . qi('refId') . ' AS refId FROM ' . qi('users')
                . ' WHERE ' . qi('id') . ' = ?', [$tid]);
            if ($u && in_array((string) $u['role'], ['faculty', 'guest_faculty'], true) && (string) $u['refId'] !== '') {
                $refs[] = (string) $u['refId'];
            }
        }
        if ($refs) {
            $ph = implode(', ', array_fill(0, count($refs), '?'));
            return array_column(fetch_all('SELECT ' . qi('id') . ' AS id FROM ' . qi('courses') . ' WHERE '
                . qi('facultyId') . ' IN (' . $ph . ')', $refs), 'id');
        }
    }
    return null;
}

function rp_opts(array $values): array
{
    $v = array_values(array_unique(array_filter(array_map('strval', $values), fn($x) => $x !== '')));
    sort($v, SORT_NATURAL | SORT_FLAG_CASE);
    return $v;
}

function rp_filters(): array
{
    $f = [];
    foreach (['from', 'to', 'status', 'course', 'semester', 'category', 'priority', 'type', 'role', 'department',
              'result', 'academicYear', 'driveType'] as $k) {
        $f[$k] = trim((string) ($_GET[$k] ?? ''));
    }
    foreach (['from', 'to'] as $k) {
        if ($f[$k] !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $f[$k])) {
            $f[$k] = '';
        }
    }
    return $f;
}

function rp_build(string $key, array $me, array $f): array
{
    $now = time();
    $col = fn($k, $l, $t = 'text') => ['key' => $k, 'label' => $l, 'type' => $t];
    switch ($key) {
        case 'tickets': {
            $uid = (string) $me['id'];
            $mine = [];
            foreach (fetch_all('SELECT DISTINCT ' . qi('ticketId') . ' AS t FROM ' . qi('tickethistory') . ' WHERE '
                . qi('toUser') . ' = ? OR ' . qi('fromUser') . ' = ?', [$uid, $uid]) as $r) {
                $mine[(string) $r['t']] = true;
            }
            $esc = [];
            foreach (fetch_all('SELECT ' . qi('ticketId') . ' AS t FROM ' . qi('tickethistory') . ' WHERE ' . qi('action')
                . " = 'escalated'") as $r) {
                $esc[(string) $r['t']] = ($esc[(string) $r['t']] ?? 0) + 1;
            }
            $rows = [];
            $opts = ['status' => [], 'category' => [], 'priority' => []];
            $breached = 0; $resTimes = []; $met = 0; $finished = 0; $open = 0; $escalated = 0;
            foreach (fetch_all('SELECT * FROM ' . qi('tickets') . ' ORDER BY ' . qi('createdAt') . ' DESC') as $t) {
                if (!tk_can_see($t, $me, isset($mine[(string) $t['id']]))) {
                    continue;
                }
                $opts['status'][] = $t['status']; $opts['category'][] = $t['category']; $opts['priority'][] = $t['priority'];
                if (!rp_in_range(rp_day((int) $t['createdAt']), $f)
                    || ($f['status'] !== '' && $t['status'] !== $f['status'])
                    || ($f['category'] !== '' && $t['category'] !== $f['category'])
                    || ($f['priority'] !== '' && $t['priority'] !== $f['priority'])) {
                    continue;
                }
                $done = in_array($t['status'], ['Resolved', 'Closed'], true);
                $budget = (int) round((float) $t['slaHours'] * 3600);
                $end = (int) $t['resolvedAt'] ?: ($t['status'] === 'Closed' ? (int) $t['closedAt'] : $now) ?: $now;
                $used = $end - (int) $t['createdAt'];
                $sla = $used > $budget ? 'SLA BREACHED' : ($done ? 'SLA MET' : ($used >= $budget * 0.75 ? 'AT RISK' : 'ON TRACK'));
                if ($sla === 'SLA BREACHED') { $breached++; }
                if (!$done) { $open++; }
                if ($t['status'] === 'Escalated' || !empty($esc[(string) $t['id']])) { $escalated++; }
                if ((int) $t['resolvedAt']) {
                    $finished++;
                    $resTimes[] = (int) $t['resolvedAt'] - (int) $t['createdAt'];
                    if ((int) $t['resolvedAt'] <= (int) $t['slaDueAt']) { $met++; }
                }
                $rows[] = [
                    'ticketNo' => $t['ticketNo'], 'subject' => $t['subject'], 'category' => $t['category'],
                    'subcategory' => $t['subcategory'], 'priority' => $t['priority'], 'status' => $t['status'],
                    'createdBy' => $t['createdByName'], 'createdRole' => role_title((string) $t['createdByRole']),
                    'with' => $done ? '' : (string) $t['assignedName'],
                    'withRole' => $done || !$t['assignedRole'] ? '' : role_title((string) $t['assignedRole']),
                    'created' => rp_dt((int) $t['createdAt']),
                    'ageHours' => round(((($t['status'] === 'Closed' && (int) $t['closedAt']) ? (int) $t['closedAt'] : $now) - (int) $t['createdAt']) / 3600, 1),
                    'sla' => $sla, 'escalations' => $esc[(string) $t['id']] ?? 0,
                    'resolutionHours' => (int) $t['resolvedAt'] ? round(((int) $t['resolvedAt'] - (int) $t['createdAt']) / 3600, 1) : '',
                ];
            }
            return [
                'columns' => [$col('ticketNo', 'Ticket ID'), $col('subject', 'Subject'), $col('category', 'Category'),
                    $col('subcategory', 'Subcategory'), $col('priority', 'Priority'), $col('status', 'Status'),
                    $col('createdBy', 'Created By'), $col('createdRole', 'Creator Role'), $col('with', 'Currently With'),
                    $col('withRole', 'Current Role'), $col('created', 'Created'), $col('ageHours', 'Age (h)', 'number'),
                    $col('sla', 'SLA Status'), $col('escalations', 'Escalations', 'number'),
                    $col('resolutionHours', 'Resolution (h)', 'number')],
                'rows' => $rows,
                'summary' => [['Tickets', count($rows)], ['Open', $open], ['Escalated', $escalated], ['SLA Breached', $breached],
                    ['Avg Resolution', $resTimes ? round(array_sum($resTimes) / count($resTimes) / 3600, 1) . ' h' : '—'],
                    ['SLA Compliance', $finished ? round($met / $finished * 100) . '%' : '—']],
                'filters' => ['status' => rp_opts($opts['status']), 'category' => rp_opts($opts['category']),
                              'priority' => rp_opts($opts['priority'])],
                'note' => 'Tickets you raised, handled, or oversee in the reporting hierarchy.',
            ];
        }
        case 'approvals': {
            $uid = (string) $me['id'];
            $mine = [];
            foreach (fetch_all('SELECT DISTINCT ' . qi('approvalId') . ' AS a FROM ' . qi('approvalsteps') . ' WHERE '
                . qi('toUser') . ' = ? OR ' . qi('fromUser') . ' = ?', [$uid, $uid]) as $r) {
                $mine[(string) $r['a']] = true;
            }
            $rows = [];
            $opts = ['status' => [], 'type' => []];
            $count = ['Pending' => 0, 'Approved' => 0, 'Rejected' => 0, 'Returned' => 0, 'Escalated' => 0];
            $times = [];
            foreach (fetch_all('SELECT * FROM ' . qi('approvals') . ' ORDER BY ' . qi('createdAt') . ' DESC') as $a) {
                if (!ap_can_see($a, $me, isset($mine[(string) $a['id']]))) {
                    continue;
                }
                $opts['status'][] = $a['status']; $opts['type'][] = $a['type'];
                if (!rp_in_range(rp_day((int) $a['createdAt']), $f)
                    || ($f['status'] !== '' && $a['status'] !== $f['status'])
                    || ($f['type'] !== '' && $a['type'] !== $f['type'])) {
                    continue;
                }
                $count[$a['status']] = ($count[$a['status']] ?? 0) + 1;
                if ((int) $a['decidedAt']) {
                    $times[] = (int) $a['decidedAt'] - (int) $a['createdAt'];
                }
                $open = in_array($a['status'], APPROVAL_OPEN, true);
                $rows[] = [
                    'approvalNo' => $a['approvalNo'], 'type' => $a['type'], 'title' => $a['title'],
                    'requestedBy' => $a['requestedByName'], 'role' => role_title((string) $a['requestedByRole']),
                    'reportsTo' => $a['requestedReportsTo'], 'approver' => $open ? $a['currentApproverName'] : '',
                    'approverRole' => $open ? role_title((string) $a['currentApproverRole']) : '',
                    'status' => $a['status'], 'created' => rp_dt((int) $a['createdAt']),
                    'decidedBy' => $a['decidedByName'], 'decided' => rp_dt((int) $a['decidedAt']),
                    'remarks' => $a['finalRemarks'],
                    'amount' => $a['amount'] === '' || $a['amount'] === null ? '' : (float) $a['amount'],
                ];
            }
            return [
                'columns' => [$col('approvalNo', 'Request ID'), $col('type', 'Type'), $col('title', 'Title'),
                    $col('requestedBy', 'Requested By'), $col('role', 'Role'), $col('reportsTo', 'Reporting To'),
                    $col('approver', 'Pending With'), $col('approverRole', 'Approver Role'), $col('status', 'Status'),
                    $col('amount', 'Amount', 'money'), $col('created', 'Requested'), $col('decidedBy', 'Decided By'),
                    $col('decided', 'Decided'), $col('remarks', 'Remarks')],
                'rows' => $rows,
                'summary' => [['Requests', count($rows)], ['Pending', $count['Pending'] + $count['Escalated']],
                    ['Approved', $count['Approved']], ['Rejected', $count['Rejected']], ['Returned', $count['Returned']],
                    ['Avg Decision Time', $times ? round(array_sum($times) / count($times) / 3600, 1) . ' h' : '—']],
                'filters' => ['status' => rp_opts($opts['status']), 'type' => rp_opts($opts['type'])],
                'note' => 'Requests you made, decided, or oversee.',
            ];
        }
        case 'myteam': {
            $all = in_array((string) $me['role'], ['admin', 'center_head'], true);
            $users = fetch_all('SELECT ' . tk_user_cols() . ', ' . qi('empId') . ' AS empId FROM ' . qi('users') . ' WHERE '
                . qi('role') . " <> 'student'");
            $byId = [];
            foreach ($users as $u) { $byId[(string) $u['id']] = $u; }
            $scope = $all ? array_keys($byId) : rp_descendants((string) $me['id']);
            $direct = [];
            foreach ($users as $u) { if ((string) $u['reportingTo'] !== '') { $direct[(string) $u['reportingTo']] = ($direct[(string) $u['reportingTo']] ?? 0) + 1; } }
            $held = [];
            foreach (fetch_all('SELECT ' . qi('assignedTo') . ' AS u, COUNT(*) AS n FROM ' . qi('tickets') . ' WHERE ' . qi('status')
                . " NOT IN ('Resolved', 'Closed') GROUP BY " . qi('assignedTo')) as $r) { $held[(string) $r['u']] = (int) $r['n']; }
            $pend = [];
            foreach (fetch_all('SELECT ' . qi('currentApprover') . ' AS u, COUNT(*) AS n FROM ' . qi('approvals') . ' WHERE '
                . qi('status') . " IN ('Pending', 'Escalated') GROUP BY " . qi('currentApprover')) as $r) { $pend[(string) $r['u']] = (int) $r['n']; }
            $rows = [];
            $opts = ['role' => [], 'status' => []];
            foreach ($scope as $id) {
                $u = $byId[$id] ?? null;
                if (!$u) { continue; }
                $rt = role_title((string) $u['role']);
                $st = tk_active($u) ? 'Active' : 'Inactive';
                $opts['role'][] = $rt; $opts['status'][] = $st;
                if (($f['role'] !== '' && $rt !== $f['role']) || ($f['status'] !== '' && $st !== $f['status'])) { continue; }
                $boss = $byId[(string) $u['reportingTo']] ?? null;
                $rows[] = ['name' => tk_name($u), 'empId' => (string) $u['empId'], 'role' => $rt,
                    'reportsTo' => $boss ? tk_name($boss) : '', 'status' => $st, 'direct' => $direct[$id] ?? 0,
                    'tickets' => $held[$id] ?? 0, 'approvals' => $pend[$id] ?? 0];
            }
            usort($rows, fn($a, $b) => strcmp($a['role'], $b['role']) ?: strcmp($a['name'], $b['name']));
            return [
                'columns' => [$col('name', 'Name'), $col('empId', 'Employee ID'), $col('role', 'Role'),
                    $col('reportsTo', 'Reports To'), $col('status', 'Status'), $col('direct', 'Direct Reports', 'number'),
                    $col('tickets', 'Open Tickets Held', 'number'), $col('approvals', 'Approvals Pending With', 'number')],
                'rows' => $rows,
                'summary' => [['People', count($rows)], ['Active', count(array_filter($rows, fn($r) => $r['status'] === 'Active'))],
                    ['Open Tickets Held', array_sum(array_column($rows, 'tickets'))],
                    ['Approvals Pending', array_sum(array_column($rows, 'approvals'))]],
                'filters' => ['role' => rp_opts($opts['role']), 'status' => rp_opts($opts['status'])],
                'note' => $all ? 'Everyone at the centre.' : 'Everyone below you in the reporting hierarchy.',
            ];
        }
        case 'attendance':
        case 'marks': {
            $scope = rp_course_scope($me);
            $courses = [];
            foreach (fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('code') . ' AS code, ' . qi('name') . ' AS name, '
                . qi('semester') . ' AS semester FROM ' . qi('courses')) as $c) {
                if ($scope === null || in_array((string) $c['id'], $scope, true)) { $courses[(string) $c['id']] = $c; }
            }
            $students = [];
            foreach (fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('roll') . ' AS roll, ' . qi('name') . ' AS name, '
                . qi('section') . ' AS section FROM ' . qi('students')) as $s) { $students[(string) $s['id']] = $s; }
            $label = fn($c) => trim(($c['code'] ?? '') . ' — ' . ($c['name'] ?? ''), ' —');
            $opts = ['course' => [], 'semester' => []];
            foreach ($courses as $c) { $opts['course'][] = $label($c); $opts['semester'][] = (string) $c['semester']; }
            $okCourse = fn($c) => ($f['course'] === '' || $label($c) === $f['course'])
                && ($f['semester'] === '' || (string) $c['semester'] === $f['semester']);
            if ($key === 'attendance') {
                $agg = []; $sessions = 0;
                foreach (fetch_all('SELECT ' . qi('courseId') . ' AS courseId, ' . qi('date') . ' AS date, ' . qi('records')
                    . ' AS records FROM ' . qi('attendance')) as $a) {
                    $c = $courses[(string) $a['courseId']] ?? null;
                    if (!$c || !$okCourse($c) || !rp_in_range((string) $a['date'], $f)) { continue; }
                    $sessions++;
                    foreach ((json_decode((string) $a['records'], true) ?: []) as $sid => $v) {
                        $k = $a['courseId'] . '|' . $sid;
                        $agg[$k] = $agg[$k] ?? ['c' => (string) $a['courseId'], 's' => (string) $sid, 'n' => 0, 'p' => 0];
                        $agg[$k]['n']++;
                        if ($v === 'P') { $agg[$k]['p']++; }
                    }
                }
                $rows = []; $low = 0; $pcts = [];
                foreach ($agg as $g) {
                    $s = $students[$g['s']] ?? ['roll' => $g['s'], 'name' => '(removed student)', 'section' => ''];
                    $c = $courses[$g['c']];
                    $pct = $g['n'] ? round($g['p'] / $g['n'] * 100) : 0;
                    $pcts[] = $pct;
                    if ($pct < 75) { $low++; }
                    $rows[] = ['roll' => $s['roll'], 'name' => $s['name'], 'section' => $s['section'], 'course' => $label($c),
                        'semester' => $c['semester'], 'sessions' => $g['n'], 'present' => $g['p'], 'absent' => $g['n'] - $g['p'],
                        'percent' => $pct];
                }
                usort($rows, fn($a, $b) => strcmp((string) $a['course'], (string) $b['course']) ?: strnatcmp((string) $a['roll'], (string) $b['roll']));
                return [
                    'columns' => [$col('roll', 'Reg No'), $col('name', 'Student'), $col('section', 'Section'), $col('course', 'Course'),
                        $col('semester', 'Sem'), $col('sessions', 'Sessions', 'number'), $col('present', 'Present', 'number'),
                        $col('absent', 'Absent', 'number'), $col('percent', 'Attendance %', 'number')],
                    'rows' => $rows,
                    'summary' => [['Courses', count($courses)], ['Class Sessions', $sessions], ['Student Records', count($rows)],
                        ['Average Attendance', $pcts ? round(array_sum($pcts) / count($pcts)) . '%' : '—'], ['Below 75%', $low]],
                    'filters' => ['course' => rp_opts($opts['course']), 'semester' => rp_opts($opts['semester'])],
                    'note' => $scope === null ? 'All courses at the centre.' : 'Only the courses assigned to you or your team.',
                ];
            }
            $rows = []; $pass = 0; $fail = 0; $pending = 0; $optsResult = [];
            foreach (fetch_all('SELECT ' . qi('studentId') . ' AS studentId, ' . qi('courseId') . ' AS courseId, '
                . qi('internal') . ' AS internal, ' . qi('external') . ' AS external FROM ' . qi('marks')) as $m) {
                $c = $courses[(string) $m['courseId']] ?? null;
                if (!$c || !$okCourse($c)) { continue; }
                $has = $m['internal'] !== null && $m['internal'] !== '';
                $pct = $has ? (int) round((float) $m['internal'] / 40 * 100) : null;   // INTERNAL_MAX, as the app grades
                $result = $pct === null ? 'Pending' : ($pct >= 40 ? 'Pass' : 'Fail');
                $optsResult[] = $result;
                if ($f['result'] !== '' && $result !== $f['result']) { continue; }
                if ($result === 'Pass') { $pass++; } elseif ($result === 'Fail') { $fail++; } else { $pending++; }
                $grade = $pct === null ? '' : ($pct >= 90 ? 'O' : ($pct >= 80 ? 'A+' : ($pct >= 70 ? 'A' : ($pct >= 60 ? 'B+'
                    : ($pct >= 50 ? 'B' : ($pct >= 40 ? 'C' : 'F'))))));
                $s = $students[(string) $m['studentId']] ?? ['roll' => $m['studentId'], 'name' => '(removed student)'];
                $rows[] = ['roll' => $s['roll'], 'name' => $s['name'], 'course' => $label($c), 'semester' => $c['semester'],
                    'internal' => $has ? (float) $m['internal'] : '', 'external' => $m['external'] === null || $m['external'] === '' ? '' : (float) $m['external'],
                    'percent' => $pct ?? '', 'grade' => $grade, 'result' => $result];
            }
            usort($rows, fn($a, $b) => strcmp((string) $a['course'], (string) $b['course']) ?: strnatcmp((string) $a['roll'], (string) $b['roll']));
            return [
                'columns' => [$col('roll', 'Reg No'), $col('name', 'Student'), $col('course', 'Course'), $col('semester', 'Sem'),
                    $col('internal', 'Internal', 'number'), $col('external', 'External', 'number'),
                    $col('percent', 'Percent', 'number'), $col('grade', 'Grade'), $col('result', 'Result')],
                'rows' => $rows,
                'summary' => [['Mark Records', count($rows)], ['Pass', $pass], ['Fail', $fail], ['Pending', $pending],
                    ['Pass Rate', ($pass + $fail) ? round($pass / ($pass + $fail) * 100) . '%' : '—']],
                'filters' => ['course' => rp_opts($opts['course']), 'semester' => rp_opts($opts['semester']),
                              'result' => rp_opts($optsResult)],
                'note' => $scope === null ? 'All courses at the centre.' : 'Only the courses assigned to you or your team.',
            ];
        }
        case 'workload': {
            $scope = rp_course_scope($me);
            $courses = fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('code') . ' AS code, ' . qi('credits') . ' AS credits, '
                . qi('facultyId') . ' AS facultyId FROM ' . qi('courses'));
            $byFac = [];
            $courseFac = [];
            foreach ($courses as $c) {
                if ($scope !== null && !in_array((string) $c['id'], $scope, true)) { continue; }
                $courseFac[(string) $c['id']] = (string) $c['facultyId'];
                $byFac[(string) $c['facultyId']]['codes'][] = (string) $c['code'];
                $byFac[(string) $c['facultyId']]['credits'] = ($byFac[(string) $c['facultyId']]['credits'] ?? 0) + (float) $c['credits'];
            }
            $periods = [];
            foreach (fetch_all('SELECT ' . qi('courseId') . ' AS c FROM ' . qi('timetable')) as $t) {
                $fid = $courseFac[(string) $t['c']] ?? null;
                if ($fid !== null) { $periods[$fid] = ($periods[$fid] ?? 0) + 1; }
            }
            $taken = [];
            foreach (fetch_all('SELECT ' . qi('courseId') . ' AS c, ' . qi('date') . ' AS d FROM ' . qi('attendance')) as $a) {
                $fid = $courseFac[(string) $a['c']] ?? null;
                if ($fid !== null && rp_in_range((string) $a['d'], $f)) { $taken[$fid] = ($taken[$fid] ?? 0) + 1; }
            }
            $rows = []; $opts = ['department' => [], 'role' => []];
            foreach (fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('name') . ' AS name, ' . qi('role') . ' AS role, '
                . qi('department') . ' AS department, ' . qi('designation') . ' AS designation, ' . qi('status') . ' AS status FROM '
                . qi('faculty')) as $fac) {
                $role = (string) ($fac['role'] ?: 'faculty');
                if (!in_array($role, ['faculty', 'guest_faculty'], true)) { continue; }
                if ($scope !== null && empty($byFac[(string) $fac['id']])) { continue; }
                $rt = role_title($role);
                $opts['department'][] = (string) $fac['department']; $opts['role'][] = $rt;
                if (($f['department'] !== '' && (string) $fac['department'] !== $f['department']) || ($f['role'] !== '' && $rt !== $f['role'])) { continue; }
                $w = $byFac[(string) $fac['id']] ?? ['codes' => [], 'credits' => 0];
                $rows[] = ['name' => $fac['name'], 'role' => $rt, 'department' => $fac['department'],
                    'designation' => $fac['designation'], 'courses' => count($w['codes'] ?? []),
                    'codes' => implode(', ', $w['codes'] ?? []), 'credits' => $w['credits'] ?? 0,
                    'periods' => $periods[(string) $fac['id']] ?? 0, 'sessions' => $taken[(string) $fac['id']] ?? 0];
            }
            usort($rows, fn($a, $b) => $b['credits'] <=> $a['credits'] ?: strcmp($a['name'], $b['name']));
            return [
                'columns' => [$col('name', 'Faculty'), $col('role', 'Type'), $col('department', 'Department'),
                    $col('designation', 'Designation'), $col('courses', 'Courses', 'number'), $col('codes', 'Course Codes'),
                    $col('credits', 'Credits', 'number'), $col('periods', 'Weekly Periods', 'number'),
                    $col('sessions', 'Classes Taken', 'number')],
                'rows' => $rows,
                'summary' => [['Faculty', count($rows)], ['Courses Assigned', array_sum(array_column($rows, 'courses'))],
                    ['Total Credits', array_sum(array_column($rows, 'credits'))], ['Classes Taken', array_sum(array_column($rows, 'sessions'))],
                    ['Without Courses', count(array_filter($rows, fn($r) => !$r['courses']))]],
                'filters' => ['department' => rp_opts($opts['department']), 'role' => rp_opts($opts['role'])],
                'note' => $scope === null ? 'All teaching staff. Classes Taken follows the date range.' : 'Your team only.',
            ];
        }
        case 'admissions': {
            $rows = []; $opts = ['status' => [], 'course' => []]; $count = [];
            foreach (fetch_all('SELECT ' . implode(', ', array_map('qi', ['roll', 'name', 'email', 'phone', 'course', 'branchName',
                'semester', 'status', 'submittedAt', 'reviewedAt', 'reviewedBy', 'reviewNote'])) . ' FROM ' . qi('submissions')
                . ' ORDER BY ' . qi('submittedAt') . ' DESC') as $s) {
                $opts['status'][] = (string) $s['status']; $opts['course'][] = (string) $s['course'];
                if (!rp_in_range(substr((string) $s['submittedAt'], 0, 10), $f) || ($f['status'] !== '' && $s['status'] !== $f['status'])
                    || ($f['course'] !== '' && $s['course'] !== $f['course'])) { continue; }
                $count[$s['status'] ?: 'Pending'] = ($count[$s['status'] ?: 'Pending'] ?? 0) + 1;
                $rows[] = ['roll' => $s['roll'], 'name' => $s['name'], 'phone' => $s['phone'], 'course' => $s['course'],
                    'branch' => $s['branchName'], 'semester' => $s['semester'], 'status' => $s['status'] ?: 'Pending',
                    'submitted' => substr(str_replace('T', ' ', (string) $s['submittedAt']), 0, 16),
                    'reviewed' => substr(str_replace('T', ' ', (string) $s['reviewedAt']), 0, 16),
                    'reviewer' => $s['reviewedBy'], 'note' => $s['reviewNote']];
            }
            $students = fetch_one('SELECT COUNT(*) AS n FROM ' . qi('students'));
            $summary = [['Applications', count($rows)]];
            foreach ($count as $st => $n) { $summary[] = [$st, $n]; }
            $summary[] = ['Students Enrolled', (int) ($students['n'] ?? 0)];
            return [
                'columns' => [$col('roll', 'Reg / Ref No'), $col('name', 'Applicant'), $col('phone', 'Phone'), $col('course', 'Course'),
                    $col('branch', 'Branch'), $col('semester', 'Sem'), $col('status', 'Status'), $col('submitted', 'Submitted'),
                    $col('reviewed', 'Reviewed'), $col('reviewer', 'Reviewed By'), $col('note', 'Review Note')],
                'rows' => $rows, 'summary' => $summary,
                'filters' => ['status' => rp_opts($opts['status']), 'course' => rp_opts($opts['course'])],
                'note' => 'Online admission applications. Date range follows the submission date.',
            ];
        }
        case 'fees': {
            $students = [];
            foreach (fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('roll') . ' AS roll, ' . qi('name') . ' AS name FROM ' . qi('students')) as $s) {
                $students[(string) $s['id']] = $s;
            }
            $rows = []; $opts = ['academicYear' => [], 'semester' => [], 'status' => []];
            $billed = 0; $paid = 0;
            foreach (fetch_all('SELECT * FROM ' . qi('fees')) as $fe) {
                $total = (float) $fe['total']; $pd = min($total, (float) $fe['paid']);
                $st = $pd >= $total && $total > 0 ? 'Paid' : ($pd > 0 ? 'Partial' : 'Unpaid');
                $opts['academicYear'][] = (string) $fe['academicYear']; $opts['semester'][] = (string) $fe['semester']; $opts['status'][] = $st;
                if (($f['academicYear'] !== '' && (string) $fe['academicYear'] !== $f['academicYear'])
                    || ($f['semester'] !== '' && (string) $fe['semester'] !== $f['semester']) || ($f['status'] !== '' && $st !== $f['status'])) { continue; }
                $billed += $total; $paid += $pd;
                $s = $students[(string) $fe['studentId']] ?? ['roll' => $fe['studentId'], 'name' => '(removed student)'];
                $rows[] = ['roll' => $s['roll'], 'name' => $s['name'], 'semester' => $fe['semester'], 'academicYear' => $fe['academicYear'],
                    'total' => $total, 'paid' => $pd, 'pending' => max(0, $total - $pd), 'dueDate' => $fe['dueDate'], 'status' => $st];
            }
            $collected = 0; $receipts = 0;
            foreach (fetch_all('SELECT ' . qi('amount') . ' AS amount, ' . qi('date') . ' AS date, ' . qi('status') . ' AS status FROM ' . qi('payments')) as $p) {
                if (rp_in_range((string) $p['date'], $f) && strtolower((string) $p['status']) !== 'cancelled') { $collected += (float) $p['amount']; $receipts++; }
            }
            return [
                'columns' => [$col('roll', 'Reg No'), $col('name', 'Student'), $col('semester', 'Sem'), $col('academicYear', 'Academic Year'),
                    $col('total', 'Total Fee', 'money'), $col('paid', 'Paid', 'money'), $col('pending', 'Pending', 'money'),
                    $col('dueDate', 'Due Date'), $col('status', 'Status')],
                'rows' => $rows,
                'summary' => [['Fee Records', count($rows)], ['Billed', '₹' . number_format($billed)], ['Collected', '₹' . number_format($paid)],
                    ['Pending', '₹' . number_format(max(0, $billed - $paid))], ['Collection', $billed ? round($paid / $billed * 100) . '%' : '—'],
                    ['Receipts in Period', $receipts . ' · ₹' . number_format($collected)]],
                'filters' => ['academicYear' => rp_opts($opts['academicYear']), 'semester' => rp_opts($opts['semester']),
                              'status' => rp_opts($opts['status'])],
                'note' => 'Fee status per student. "Receipts in Period" follows the date range.',
                'totals' => ['total' => $billed, 'paid' => $paid, 'pending' => max(0, $billed - $paid)],
            ];
        }
        case 'placement': {
            $companies = [];
            foreach (fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('name') . ' AS name FROM ' . qi('companies')) as $c) { $companies[(string) $c['id']] = $c['name']; }
            $apps = []; $short = []; $sel = [];
            foreach (fetch_all('SELECT ' . qi('driveId') . ' AS d, ' . qi('status') . ' AS s FROM ' . qi('applications')) as $a) {
                $apps[(string) $a['d']] = ($apps[(string) $a['d']] ?? 0) + 1;
                if (in_array($a['s'], ['Shortlisted', 'Selected'], true)) { $short[(string) $a['d']] = ($short[(string) $a['d']] ?? 0) + 1; }
                if ($a['s'] === 'Selected') { $sel[(string) $a['d']] = ($sel[(string) $a['d']] ?? 0) + 1; }
            }
            $ivs = [];
            foreach (fetch_all('SELECT ' . qi('driveId') . ' AS d FROM ' . qi('interviews')) as $i) { $ivs[(string) $i['d']] = ($ivs[(string) $i['d']] ?? 0) + 1; }
            $offers = []; $placed = [];
            foreach (fetch_all('SELECT ' . qi('driveId') . ' AS d, ' . qi('studentId') . ' AS s, ' . qi('status') . ' AS st FROM ' . qi('offers')) as $o) {
                $offers[(string) $o['d']] = ($offers[(string) $o['d']] ?? 0) + 1;
                if (in_array($o['st'], ['Accepted', 'Joined'], true)) { $placed[(string) $o['s']] = true; }
            }
            $rows = []; $opts = ['status' => [], 'driveType' => []];
            foreach (fetch_all('SELECT * FROM ' . qi('drives') . ' ORDER BY ' . qi('driveDate') . ' DESC') as $d) {
                $type = (string) ($d['driveType'] ?: 'On Campus');
                $opts['status'][] = (string) $d['status']; $opts['driveType'][] = $type;
                if (!rp_in_range((string) $d['driveDate'], $f) || ($f['status'] !== '' && $d['status'] !== $f['status'])
                    || ($f['driveType'] !== '' && $type !== $f['driveType'])) { continue; }
                $id = (string) $d['id'];
                $rows[] = ['company' => $companies[(string) $d['companyId']] ?? '', 'role' => $d['jobRole'], 'type' => $type,
                    'package' => $d['package'], 'date' => $d['driveDate'], 'status' => $d['status'], 'applications' => $apps[$id] ?? 0,
                    'shortlisted' => $short[$id] ?? 0, 'interviews' => $ivs[$id] ?? 0, 'selected' => $sel[$id] ?? 0, 'offers' => $offers[$id] ?? 0];
            }
            $students = fetch_one('SELECT COUNT(*) AS n FROM ' . qi('students'));
            $ns = (int) ($students['n'] ?? 0);
            return [
                'columns' => [$col('company', 'Company'), $col('role', 'Job Role'), $col('type', 'Drive Type'), $col('package', 'Package'),
                    $col('date', 'Drive Date'), $col('status', 'Status'), $col('applications', 'Applications', 'number'),
                    $col('shortlisted', 'Shortlisted', 'number'), $col('interviews', 'Interviews', 'number'),
                    $col('selected', 'Selected', 'number'), $col('offers', 'Offers', 'number')],
                'rows' => $rows,
                'summary' => [['Companies', count($companies)], ['Drives', count($rows)], ['Applications', array_sum(array_column($rows, 'applications'))],
                    ['Offers', array_sum(array_column($rows, 'offers'))], ['Students Placed', count($placed)],
                    ['Placement Rate', $ns ? round(count($placed) / $ns * 100) . '%' : '—']],
                'filters' => ['status' => rp_opts($opts['status']), 'driveType' => rp_opts($opts['driveType'])],
                'note' => 'Drives with their funnel. Date range follows the drive date.',
            ];
        }
        case 'library': {
            $books = [];
            $copies = 0; $available = 0;
            foreach (fetch_all('SELECT * FROM ' . qi('books')) as $b) { $books[(string) $b['id']] = $b; $copies += (int) $b['total']; $available += (int) $b['available']; }
            $students = [];
            foreach (fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('roll') . ' AS roll, ' . qi('name') . ' AS name FROM ' . qi('students')) as $s) { $students[(string) $s['id']] = $s; }
            $today = (new DateTime('now', rp_tz()))->format('Y-m-d');
            $rows = []; $opts = ['status' => []]; $overdue = 0; $onLoan = 0;
            foreach (fetch_all('SELECT * FROM ' . qi('issues') . ' ORDER BY ' . qi('issueDate') . ' DESC') as $i) {
                $returned = (string) $i['returnDate'] !== '';
                $late = !$returned && (string) $i['dueDate'] !== '' && (string) $i['dueDate'] < $today;
                $st = $returned ? 'Returned' : ($late ? 'Overdue' : 'On Loan');
                $opts['status'][] = $st;
                if (!rp_in_range((string) $i['issueDate'], $f) || ($f['status'] !== '' && $st !== $f['status'])) { continue; }
                if (!$returned) { $onLoan++; }
                $days = $late ? (int) ((new DateTime($today))->diff(new DateTime((string) $i['dueDate']))->days) : 0;
                if ($late) { $overdue++; }
                $b = $books[(string) $i['bookId']] ?? ['title' => '(removed book)', 'author' => ''];
                $s = $students[(string) $i['studentId']] ?? ['roll' => $i['studentId'], 'name' => ''];
                $rows[] = ['title' => $b['title'], 'author' => $b['author'], 'roll' => $s['roll'], 'name' => $s['name'],
                    'issued' => $i['issueDate'], 'due' => $i['dueDate'], 'returned' => $i['returnDate'], 'status' => $st, 'overdueDays' => $days];
            }
            return [
                'columns' => [$col('title', 'Book'), $col('author', 'Author'), $col('roll', 'Reg No'), $col('name', 'Borrower'),
                    $col('issued', 'Issued'), $col('due', 'Due'), $col('returned', 'Returned'), $col('status', 'Status'),
                    $col('overdueDays', 'Overdue Days', 'number')],
                'rows' => $rows,
                'summary' => [['Titles', count($books)], ['Copies', $copies], ['Available', $available], ['On Loan', $onLoan], ['Overdue', $overdue]],
                'filters' => ['status' => rp_opts($opts['status'])],
                'note' => 'Issue and return register. The CMS has no fine rate configured, so fines are not computed — overdue days are shown instead.',
            ];
        }
    }
    return ['columns' => [], 'rows' => [], 'summary' => [], 'filters' => [], 'note' => ''];
}

function api_rp_catalog(): void
{
    $me = current_user();
    $out = [];
    foreach (REPORT_CATALOG as $key => $def) {
        if (rp_allowed($key, $me)) {
            $out[] = ['key' => $key, 'label' => $def['label'], 'group' => $def['group'],
                      'canExport' => rp_allowed($key, $me, in_array($key, REPORT_OPEN, true) ? 'view' : 'export')];
        }
    }
    send_json(['reports' => $out]);
}

function rp_guard(?string $key, string $need): array
{
    $me = current_user();
    $key = (string) $key;
    if (!isset(REPORT_CATALOG[$key])) {
        send_json(['error' => 'not found', 'message' => 'Unknown report.'], 404);
    }
    $need = in_array($key, REPORT_OPEN, true) ? 'view' : $need;
    if (!rp_allowed($key, $me, $need)) {
        send_json(['error' => 'forbidden', 'message' => 'ACCESS DENIED — this report is outside your role or permissions.'], 403);
    }
    return [$me, $key];
}

function api_rp_data(?string $key): void
{
    [$me, $key] = rp_guard($key, 'view');
    $f = rp_filters();
    $r = rp_build($key, $me, $f);
    $r['summary'] = array_map(fn($s) => ['label' => $s[0], 'value' => $s[1]], $r['summary']);
    send_json(array_merge(['key' => $key, 'label' => REPORT_CATALOG[$key]['label'], 'applied' => $f,
        'canExport' => rp_allowed($key, $me, in_array($key, REPORT_OPEN, true) ? 'view' : 'export'),
        'generatedAt' => rp_dt(time())], $r));
}

/** CSV straight from the server — so it carries exactly the scoped rows, and is audited */
function api_rp_csv(?string $key): void
{
    [$me, $key] = rp_guard($key, 'export');
    $f = rp_filters();
    $r = rp_build($key, $me, $f);
    audit('report-export', 'reports', $key, REPORT_CATALOG[$key]['label'], 'CSV — ' . count($r['rows']) . ' rows',
        ['format' => 'csv', 'rows' => count($r['rows']), 'filters' => array_filter($f, fn($v) => $v !== '')]);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $name = preg_replace('/[^A-Za-z0-9]+/', '-', REPORT_CATALOG[$key]['label']) . '-' . (new DateTime('now', rp_tz()))->format('Y-m-d') . '.csv';
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $name . '"');
    header('Cache-Control: no-store');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, array_map(fn($c) => $c['label'], $r['columns']));
    foreach ($r['rows'] as $row) {
        // a cell that opens with = + - @ would run as a formula in Excel
        fputcsv($out, array_map(function ($c) use ($row) {
            $v = (string) ($row[$c['key']] ?? '');
            return ($v !== '' && strpos('=+-@', $v[0]) !== false && !is_numeric($v)) ? "'" . $v : $v;
        }, $r['columns']));
    }
    fclose($out);
    exit;
}

/** Excel and PDF are drawn in the browser; the server still records that they were taken */
function api_rp_log(): void
{
    $b = body();
    [$me, $key] = rp_guard((string) ($b['key'] ?? ''), 'export');
    $format = in_array($b['format'] ?? '', ['excel', 'pdf'], true) ? $b['format'] : 'excel';
    $filters = is_array($b['filters'] ?? null) ? array_filter(array_map('strval', $b['filters']), fn($v) => $v !== '') : [];
    audit('report-export', 'reports', $key, REPORT_CATALOG[$key]['label'],
        strtoupper($format) . ' — ' . (int) ($b['rows'] ?? 0) . ' rows',
        ['format' => $format, 'rows' => (int) ($b['rows'] ?? 0), 'filters' => $filters]);
    send_json(['ok' => true]);
}

function dispatch(string $method, string $resource, ?string $id, bool $isCollection): void
{
    ensure_schema();
    migrate_plaintext_passwords();
    /* Before anything opens a transaction. MySQL commits implicitly on DDL, so
       a CREATE TABLE reached from inside one silently ends it — and the commit
       that follows fails with "there is no active transaction". Once per
       process; the function guards itself after that. */
    seq_table();
    guard_request($resource, $method, $id);

    if ($method === 'GET' && $resource === 'bootstrap') {
        api_bootstrap();
    }
    if ($method === 'GET' && $resource === 'signature') {
        api_signature();
    }
    if ($method === 'GET' && $resource === 'photos') {
        api_photos();
    }
    if ($method === 'GET' && $resource === 'backup') {
        api_backup();
    }
    if ($method === 'GET' && $resource === 'trash' && $id === null) {
        api_trash_list();
    }
    if ($method === 'POST' && $resource === 'trash' && $id !== null) {
        api_trash_restore($id);
    }
    if ($method === 'DELETE' && $resource === 'trash' && $id !== null) {
        api_trash_purge($id);
    }
    if ($method === 'GET' && $isCollection && $id === null) {
        api_list($resource);
    }
    if ($method === 'POST' && $resource === 'login') {
        api_login();
    }
    if ($method === 'POST' && $resource === 'apply') {
        api_apply();
    }
    if ($method === 'POST' && $resource === 'reissue-student-id') {
        api_reissue_student_id();
    }
    if ($method === 'GET' && $resource === 'student-seq') {
        api_student_seq();
    }
    if ($method === 'POST' && $resource === 'reset-student-seq') {
        api_reset_student_seq();
    }
    if ($method === 'POST' && $resource === 'renumber-students') {
        api_renumber_students();
    }
    // helpdesk + organisation — each authorises the caller itself
    if ($method === 'GET' && $resource === 'tk-meta') {
        api_tk_meta();
    }
    if ($method === 'GET' && $resource === 'tk-list') {
        api_tk_list();
    }
    if ($method === 'GET' && $resource === 'tk-get') {
        api_tk_get($id);
    }
    if ($method === 'POST' && $resource === 'tk-create') {
        api_tk_create();
    }
    if ($method === 'POST' && $resource === 'tk-action') {
        api_tk_action();
    }
    if ($method === 'POST' && $resource === 'tk-settings') {
        api_tk_settings();
    }
    if ($method === 'GET' && $resource === 'tk-org') {
        api_tk_org();
    }
    // notifications, approvals and reports — each authorises the caller itself
    if ($method === 'GET' && $resource === 'nt-list') {
        api_nt_list();
    }
    if ($method === 'POST' && $resource === 'nt-read') {
        api_nt_read();
    }
    if ($method === 'GET' && $resource === 'ap-meta') {
        api_ap_meta();
    }
    if ($method === 'GET' && $resource === 'ap-list') {
        api_ap_list();
    }
    if ($method === 'GET' && $resource === 'ap-get') {
        api_ap_get($id);
    }
    if ($method === 'POST' && $resource === 'ap-create') {
        api_ap_create();
    }
    if ($method === 'POST' && $resource === 'ap-action') {
        api_ap_action();
    }
    if ($method === 'GET' && $resource === 'rp-catalog') {
        api_rp_catalog();
    }
    if ($method === 'GET' && $resource === 'rp-data') {
        api_rp_data($id);
    }
    if ($method === 'GET' && $resource === 'rp-csv') {
        api_rp_csv($id);
    }
    if ($method === 'POST' && $resource === 'rp-log') {
        api_rp_log();
    }
    /* What the next id would be, without taking it. Signed in only — it says
       how many students the college has admitted this year. */
    if ($method === 'GET' && $resource === 'next-student-id') {
        $yy = admission_yy((string) ($_GET['year'] ?? ''));
        send_json([
            'id'   => format_student_id($yy, (string) ($_GET['branch'] ?? ''), peek_student_seq($yy)),
            'next' => peek_student_seq($yy),
        ]);
    }
    if ($method === 'POST' && $resource === 'logout') {
        api_logout();
    }
    if ($method === 'POST' && $resource === 'change-password') {
        api_change_password();
    }
    if ($method === 'POST' && $isCollection) {
        api_create($resource);
    }
    if ($method === 'PUT' && $isCollection && $id !== null) {
        if ($resource === 'requisitions') {
            guard_requisition_stage($id);
        }
        api_update($resource, $id);
    }
    if ($method === 'DELETE' && $isCollection && $id !== null) {
        api_delete($resource, $id);
    }

    send_json(['error' => 'not found'], 404);
}

/** SQLSTATEs meaning "that table/column is not there" on MySQL or Postgres. */
const SCHEMA_BEHIND = ['42703', '42P01', '42S02', '42S22'];

/**
 * PostgreSQL 0A000 here means "cached plan must not change result type": a
 * pooled connection is holding a plan from before a column was added.
 * PostgreSQL drops the stale plan as it raises this, so the retry succeeds.
 */
const STALE_PLAN = '0A000';

try {
    if ($method === 'OPTIONS') {
        http_response_code(204);
        exit;
    }

    // Plain /api/health is a liveness check and must not touch the database —
    // the platform restarts the container when it fails, and a database
    // outage is not something a restart fixes. /api/health?db=1 is the
    // deliberate deep check: it reports whether the database is reachable.
    if ($method === 'GET' && $resource === 'health') {
        /* The fingerprint of this very file. Deploys have twice now put a new
           front end up with an older back end behind it, and the only symptom
           was a session that signed in and could read nothing — with no way to
           tell from outside which of the two was actually running. Now there
           is: compare this against the same hash of the file being deployed.
           It reveals nothing; the file it hashes cannot be read over HTTP. */
        $build = ['build' => substr(hash_file('sha256', __FILE__) ?: '', 0, 12)];
        if (!isset($_GET['db'])) {
            send_json(['ok' => true] + $build);
        }
        try {
            db()->query('SELECT 1');
            send_json(['ok' => true, 'db' => 'ok', 'driver' => driver()] + $build);
        } catch (Throwable $e) {
            error_log('[nmiet-api] health db: ' . $e->getMessage());
            send_json(['ok' => false, 'db' => 'error'] + debug_detail($e), 503);
        }
    }

    try {
        dispatch($method, $resource, $id, $isCollection);
    } catch (PDOException $e) {
        // The schema is created and migrated on first use, and _meta records
        // that it is current. If a table or column is missing anyway — the
        // signature said "done" while an ALTER never landed — one blind retry
        // beats serving 500s until someone notices.
        $code = (string) $e->getCode();
        if ($code === STALE_PLAN) {
            error_log('[nmiet-api] stale query plan, retrying: ' . $e->getMessage());
            dispatch($method, $resource, $id, $isCollection);
        }
        if (!in_array($code, SCHEMA_BEHIND, true)) {
            throw $e;
        }
        error_log('[nmiet-api] schema behind (' . $code . '), rebuilding: ' . $e->getMessage());
        init_db();
        dispatch($method, $resource, $id, $isCollection);
    }
} catch (Throwable $e) {
    error_log('[nmiet-api] ' . $e->getMessage());
    // The SQLSTATE names the kind of failure without revealing the query, the
    // schema or the connection details, and it is what makes a production-only
    // failure diagnosable without turning APP_DEBUG on.
    $extra = $e instanceof PDOException && $e->getCode() ? ['code' => (string) $e->getCode()] : [];
    send_json(['error' => 'server error', 'message' => 'Server error — please try again.']
        + $extra + debug_detail($e), 500);
}
