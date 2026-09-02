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
 */
require_once __DIR__ . '/db.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function send_json($data, int $status = 200): void
{
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
    $ceiling = role_ceiling(base_role($role));
    if ($role === 'admin') {
        return $perms = $ceiling;              // never narrowed, never lost
    }
    $roleRow = role_record($role);
    $fromRole = $roleRow ? read_perm_set($roleRow['permissions'] ?? null) : null;
    $own = ((string) ($u['access'] ?? 'full') === 'restricted')
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

    /* Collections first, and by grant rather than by exception. Only then the
       older rules, which narrow what this has already allowed. */
    if ($isWrite && isset(COLLECTIONS[$resource])) {
        guard_role_write($resource, $method, $id);
    }
    if (!$isWrite && isset(COLLECTIONS[$resource]) && !role_may_read($resource)) {
        send_json(['error' => 'forbidden',
                   'message' => 'Your role cannot read this.'], 403);
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
    if ($isWrite && $resource === 'users' && current_role() !== 'admin') {
        $body = body();
        foreach (['access', 'permissions', 'role', 'status'] as $field) {
            if (array_key_exists($field, $body)) {
                send_json(['error' => 'forbidden',
                           'message' => 'Only the administrator can change roles or permissions.'], 403);
            }
        }
    }

    if ($isWrite && !in_array($resource, ['login', 'logout', 'change-password'], true) && is_read_only_role()
        && !read_only_write_allowed($resource, $method)) {
        send_json([
            'error'   => 'read-only',
            'message' => 'Your role has view-only access and cannot change data.',
        ], 403);
    }

    if ($resource === 'syllabus') {
        $role = current_user()['role'] ?? '';
        if (in_array($role, SYLLABUS_HIDDEN_ROLES, true)) {
            send_json(['error' => 'forbidden',
                       'message' => 'The curriculum is not part of the accounts office.'], 403);
        }
        if ($isWrite && !in_array($role, SYLLABUS_WRITE_ROLES, true)) {
            send_json(['error' => 'forbidden',
                       'message' => 'Only the admin can change the curriculum.'], 403);
        }
    }

    if (in_array($resource, FINANCE_COLLECTIONS, true)) {
        if ($isWrite ? !may_touch_finance() : !may_read_finance()) {
            send_json(['error' => 'forbidden'], 403);
        }
    }
    if ($isWrite && in_array($resource, FINANCE_WRITE_ONLY, true) && !may_touch_finance()) {
        send_json(['error' => 'forbidden'], 403);
    }
    if (in_array($resource, STAFF_COLLECTIONS, true) && !may_touch_staff()) {
        send_json(['error' => 'forbidden'], 403);
    }

    /* A course coordinator exists to run attendance. It reads the master data
       that attendance is built from — students, papers, faculty — and writes
       none of it: the one collection it may change is `attendance` itself. */
    if (current_role() === 'course_coordinator') {
        if ($isWrite && $resource !== 'attendance') {
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

    // attendance is registered by the roles allowed to hold a class
    if ($resource === 'attendance' && $isWrite && !may_mark_attendance()) {
        send_json([
            'error'   => 'forbidden',
            'message' => current_role() === 'faculty'
                ? 'Attendance entry is currently handled by the course coordinator.'
                : 'Your role cannot register attendance.',
        ], 403);
    }

    /* The admissions desk enrols students and corrects them; it may not
       remove one, and outside students and their logins it may not write at
       all. Reads are narrowed to what enrolling needs. */
    if (current_role() === 'admission') {
        // correcting a student id is a student edit, which is what this desk does
        if ($isWrite && $resource !== 'reissue-student-id'
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
        && !in_array(current_role(), ['admin', 'admission'], true)) {
        send_json([
            'error'   => 'forbidden',
            'message' => 'Only the administrator can add, edit or delete a student record.',
        ], 403);
    }

    if (in_array($resource, PLACEMENT_COLLECTIONS, true)) {
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

/** the last two digits of an admission year, from a year or a date */
function admission_yy(string $value): string
{
    if (preg_match('/(\d{4})/', $value, $m)) {
        return substr($m[1], -2);
    }
    if (preg_match('/^\d{2}$/', trim($value))) {
        return trim($value);
    }
    return date('y');
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
        if (!ctype_digit($roll) || $len < 4 + STUDENT_SEQ_WIDTH || $len > 8) {
            continue;
        }
        $n = (int) substr($roll, 4);
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

/** how many students on the roll hold an id of this scheme for a year */
function students_in_year(string $yy): int
{
    $rows = fetch_all('SELECT ' . qi('roll') . ' AS roll FROM ' . qi('students')
        . ' WHERE ' . qi('roll') . ' LIKE ?', [$yy . '%']);
    $n = 0;
    foreach ($rows as $r) {
        $roll = trim((string) ($r['roll'] ?? ''));
        $len = strlen($roll);
        // an id of the current scheme, not a ten-digit one from the old
        if (ctype_digit($roll) && $len >= 4 + STUDENT_SEQ_WIDTH && $len <= 8) {
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

function api_bootstrap(): void
{
    $finance = may_read_finance();
    $staff = may_touch_staff();
    $placement = may_read_placement();
    $isPo = is_placement_officer();
    $out = [];
    $isAdmin = current_role() === 'admin';
    foreach (COLLECTIONS as $col => $_) {
        /* Every session needs the role table: it is how the browser works out
           what its own account may do, and it holds no data about anybody —
           only which boxes are ticked for which role. The audit log does name
           people, so it goes to the admin alone. */
        if (!role_may_read($col)) {
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
            $issuedShape = strlen($roll) >= 4 + STUDENT_SEQ_WIDTH && strlen($roll) <= 8;
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
/** may this role read this collection at all? */
function role_may_read(string $col): bool
{
    $allowed = ROLE_READABLE[current_role()] ?? [];
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
        // The UI rejects a duplicate username, but nothing in the schema
        // enforces it. Refuse rather than silently granting whichever role
        // happened to come back first.
        send_json([
            'error'   => 'ambiguous',
            'message' => 'More than one account uses this username. Contact the administrator.',
        ], 409);
    }
    /* Reused when the account already has one, so signing in on a phone does
       not sign the same person out on their desk. Logout, a password change and
       being deactivated all clear it, which is what makes it revocable. */
    $token = (string) ($rows[0]['token'] ?? '');
    if ($token === '') {
        $token = session_start_for((string) $rows[0]['id']);
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
    // read before removing, so the line can say what was removed
    $before = in_array($col, AUDITED, true)
        ? fetch_one('SELECT * FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id])
        : null;
    run_sql('DELETE FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id]);
    if (in_array($col, AUDITED, true)) {
        audit('delete', $col, $id, $before ? audit_name($col, $before) : '');
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
