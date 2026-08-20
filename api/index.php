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

/**
 * The caller's user row, identified by the X-User-Id header the frontend sends
 * after login, or null when the request is anonymous.
 */
function current_user(): ?array
{
    static $cached = false;
    static $user = null;
    if ($cached) {
        return $user;
    }
    $cached = true;
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
function guard_request(string $resource, string $method): void
{
    $isWrite = !in_array($method, ['GET', 'HEAD', 'OPTIONS'], true);

    if ($isWrite && $resource !== 'login' && is_read_only_role()
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

    // The student roll is read by the accounts office, the placement cell, the
    // library and the centre head, and edited by none of them. Until now that
    // was a UI convention: the Students page simply hid its buttons, while the
    // API accepted a write from any signed-in role.
    if ($resource === 'students' && $isWrite && current_role() !== 'admin') {
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
function api_bootstrap(): void
{
    $finance = may_read_finance();
    $staff = may_touch_staff();
    $placement = may_read_placement();
    $isPo = is_placement_officer();
    $out = [];
    foreach (COLLECTIONS as $col => $_) {
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
   Mirrors the eligibility the page shows, on the server, because the page is
   only a suggestion. Same rule as driveEligibility() in app.js, including the
   fallback to the average of internal marks when no CGPA has been entered. */

/** The student's CGPA, or the GPA implied by their internal marks, or null. */
function student_cgpa(array $s): ?float
{
    $raw = trim((string) ($s['cgpa'] ?? ''));
    if ($raw !== '' && is_numeric($raw)) {
        return (float) $raw;
    }
    $marks = fetch_all('SELECT * FROM ' . qi('marks') . ' WHERE ' . qi('studentId') . ' = ?', [$s['id']]);
    if (!$marks) {
        return null;
    }
    $points = 0.0;
    $credits = 0.0;
    foreach ($marks as $m) {
        if (($m['internal'] ?? '') === '' || $m['internal'] === null) {
            continue;
        }
        $course = fetch_one('SELECT * FROM ' . qi('courses') . ' WHERE ' . qi('id') . ' = ?', [$m['courseId']]);
        $credit = (float) ($course['credits'] ?? 0);
        $pct = round(((float) $m['internal'] / INTERNAL_MAX) * 100);
        $grade = $pct >= 90 ? 10 : ($pct >= 80 ? 9 : ($pct >= 70 ? 8 :
                 ($pct >= 60 ? 7 : ($pct >= 50 ? 6 : ($pct >= 40 ? 5 : 0)))));
        $points += $grade * $credit;
        $credits += $credit;
    }
    return $credits > 0 ? round($points / $credits, 2) : null;
}

/** Reasons this student does not qualify for this drive; empty means they do. */
function drive_blockers(array $s, array $d): array
{
    $out = [];
    $min = trim((string) ($d['minCgpa'] ?? ''));
    if ($min !== '' && is_numeric($min) && (float) $min > 0) {
        $cg = student_cgpa($s);
        if ($cg === null) {
            $out[] = 'no CGPA on record';
        } elseif ($cg < (float) $min) {
            $out[] = "CGPA $cg is below $min";
        }
    }
    $maxB = $d['maxBacklogs'] ?? '';
    if ($maxB !== '' && $maxB !== null && is_numeric($maxB)
        && (int) ($s['backlogs'] ?? 0) > (int) $maxB) {
        $out[] = 'too many backlogs';
    }
    foreach ([['eligibleBranches', 'branch', 'branch'], ['eligibleCourses', 'course', 'course']] as [$f, $sf, $label]) {
        $list = array_filter(array_map('trim', explode(',', (string) ($d[$f] ?? ''))));
        if ($list && !in_array((string) ($s[$sf] ?? ''), $list, true)) {
            $out[] = "this drive is not open to your $label";
        }
    }
    return $out;
}

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

    $blockers = drive_blockers($student, $drive);
    if ($blockers) {
        send_json(['error' => 'not-eligible',
                   'message' => 'You do not meet this drive\'s requirements: ' . implode('; ', $blockers) . '.'], 403);
    }

    return [
        'studentId' => $sid,
        'driveId'   => $drive['id'],
        'appliedOn' => date('Y-m-d'),
        'status'    => 'Applied',
        'updatedBy' => current_user()['id'] ?? null,
        'updatedOn' => date('Y-m-d'),
    ];
}

/**
 * Rows the caller is allowed to see. A student reading their own placement
 * records gets exactly theirs — the filter lives here so it applies to
 * /api/{collection} and to the bootstrap payload alike.
 */
function scope_rows(string $col, array $rows): array
{
    if (current_role() !== 'student' || !in_array($col, PLACEMENT_STUDENT_OWN, true)) {
        return $rows;
    }
    $sid = current_user()['refId'] ?? null;
    return array_values(array_filter($rows, fn($r) => ($r['studentId'] ?? null) === $sid));
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
    $rows = fetch_all(
        'SELECT * FROM ' . qi('users') . ' WHERE LOWER(' . qi('username') . ') = LOWER(?)
         AND ' . qi('password') . ' = ?',
        [$d['username'] ?? '', $d['password'] ?? '']
    );
    if (!$rows) {
        send_json(['error' => 'invalid', 'message' => 'Invalid username or password.'], 401);
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
    send_json(row_out('users', $rows[0]));
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
        $rows = [];
        db()->beginTransaction();
        try {
            foreach ($d as $row) {
                if (empty($row['id'])) {
                    $row['id'] = next_id($col);
                }
                upsert($col, $row);
                $rows[] = $row;
            }
            db()->commit();
        } catch (Throwable $e) {
            db()->rollBack();
            throw $e;
        }
        send_json($rows, 201);
    }

    if (empty($d['id'])) {
        $d['id'] = next_id($col);
    }
    upsert($col, $d);
    send_json($d, 201);
}

function api_update(string $col, string $id): void
{
    $d = body();
    // a role with a column allowlist gets everything else in the body dropped,
    // so a crafted payload cannot ride along with a legitimate one
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
    send_json(['ok' => true, 'id' => $id]);
}

function api_delete(string $col, string $id): void
{
    run_sql('DELETE FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id]);
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
    guard_request($resource, $method);

    if ($method === 'GET' && $resource === 'bootstrap') {
        api_bootstrap();
    }
    if ($method === 'GET' && $isCollection && $id === null) {
        api_list($resource);
    }
    if ($method === 'POST' && $resource === 'login') {
        api_login();
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
        if (!isset($_GET['db'])) {
            send_json(['ok' => true]);
        }
        try {
            db()->query('SELECT 1');
            send_json(['ok' => true, 'db' => 'ok', 'driver' => driver()]);
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
