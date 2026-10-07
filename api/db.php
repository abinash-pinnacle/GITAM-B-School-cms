<?php
/**
 * PDO database layer — works with SQLite (default), MySQL and PostgreSQL.
 * Tables are created and demo-seeded on first use, and new columns added to
 * COLLECTIONS are migrated in automatically.
 */
require_once __DIR__ . '/config.php';

/** how many times a *transient* connection failure is retried, 1s apart */
const DB_CONNECT_ATTEMPTS = 6;

/**
 * True when the driver says the server is not accepting connections yet —
 * a container still booting, or a serverless Postgres (Neon, Supabase) waking
 * from idle. Anything else (bad password, unknown database, unknown host) is
 * a configuration error and is reported immediately.
 */
function connect_error_is_transient(PDOException $e): bool
{
    $m = $e->getMessage();
    foreach ([
        'Connection refused',           // nothing listening yet
        'could not connect to server',
        'the database system is starting up',
        'server closed the connection unexpectedly',
        'Connection timed out',
        'timeout expired',
        'MySQL server has gone away',
        'No connection could be made',  // Windows wording
        '2002',                         // MySQL: can't connect
    ] as $needle) {
        if (stripos($m, $needle) !== false) {
            return true;
        }
    }
    return false;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $cfg = db_config();
    if (!in_array($cfg['driver'], PDO::getAvailableDrivers(), true)) {
        throw new RuntimeException(
            "PHP extension pdo_{$cfg['driver']} is not enabled — turn it on in php.ini "
            . '(available: ' . implode(', ', PDO::getAvailableDrivers()) . ')'
        );
    }
    $opts = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        // Server-side prepares cache a query plan on the *server* connection.
        // Behind a pooler (Neon, Supabase, PgBouncer) those connections are
        // shared and outlive the request, so after a column is added the next
        // `SELECT *` on a reused connection fails with 0A000, "cached plan must
        // not change result type" — permanently, for that one table. Emulating
        // prepares keeps the plan client-side, where a schema change cannot
        // strand it. Every pgsql column here is TEXT, so nothing depends on
        // server-side parameter typing.
        PDO::ATTR_EMULATE_PREPARES   => $cfg['driver'] === 'pgsql',
    ];

    if ($cfg['driver'] === 'sqlite') {
        $dir = dirname($cfg['path']);
        if ($dir && !is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
        $pdo = new PDO('sqlite:' . $cfg['path'], null, null, $opts);
        $pdo->exec('PRAGMA busy_timeout = 5000');
        try {
            // better concurrency; not supported on some network/shared mounts
            $pdo->exec('PRAGMA journal_mode = WAL');
        } catch (PDOException $e) {
            // keep the default rollback journal
        }
        return $pdo;
    }

    // MySQL / PostgreSQL may still be starting up (container boot), so retry —
    // but only while the error says the server is not up *yet*. A rejected
    // password or a missing database never fixes itself, and retrying those
    // 30 times turned a one-second config mistake into a 60-second wait that
    // the browser could only report as a failed login.
    $lastError = null;
    for ($attempt = 0; $attempt < DB_CONNECT_ATTEMPTS; $attempt++) {
        try {
            if ($cfg['driver'] === 'mysql') {
                $dsn = "mysql:host={$cfg['host']};port={$cfg['port']};charset=utf8mb4";
                try {
                    // convenience for XAMPP-style root access; a restricted user
                    // may not be allowed to do this, and that is fine
                    (new PDO($dsn, $cfg['user'], $cfg['pass'], $opts))
                        ->exec("CREATE DATABASE IF NOT EXISTS `{$cfg['name']}`
                                CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
                } catch (PDOException $e) {
                    // database must already exist — the next line will tell us
                }
                $pdo = new PDO("$dsn;dbname={$cfg['name']}", $cfg['user'], $cfg['pass'], $opts);
            } else {
                $dsn = "pgsql:host={$cfg['host']};port={$cfg['port']};dbname={$cfg['name']}";
                if (!empty($cfg['sslmode'])) {
                    $dsn .= ";sslmode={$cfg['sslmode']}";
                }
                $pdo = new PDO($dsn, $cfg['user'], $cfg['pass'], $opts);
            }
            return $pdo;
        } catch (PDOException $e) {
            $lastError = $e;
            if (!connect_error_is_transient($e)) {
                break;
            }
            sleep(1);
        }
    }
    throw new RuntimeException('Could not connect to the database: ' . $lastError->getMessage());
}

function driver(): string
{
    return db()->getAttribute(PDO::ATTR_DRIVER_NAME);
}

function fetch_all(string $sql, array $params = []): array
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st->fetchAll();
}

function fetch_one(string $sql, array $params = []): ?array
{
    $rows = fetch_all($sql, $params);
    return $rows[0] ?? null;
}

function run_sql(string $sql, array $params = []): void
{
    $st = db()->prepare($sql);
    $st->execute($params);
}

/** quote an identifier for the active driver */
function qi(string $name): string
{
    return driver() === 'mysql' ? "`$name`" : "\"$name\"";
}

function column_type(string $col, string $field): string
{
    if ($field === 'id') {
        return driver() === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
    }
    if (in_array($field, JSON_FIELDS[$col] ?? [], true) || in_array($field, LONGTEXT_FIELDS[$col] ?? [], true)) {
        return driver() === 'mysql' ? 'LONGTEXT' : 'TEXT';
    }
    return driver() === 'mysql' ? 'VARCHAR(255)' : 'TEXT';
}

function existing_columns(string $col): array
{
    if (driver() === 'sqlite') {
        return array_column(fetch_all("PRAGMA table_info($col)"), 'name');
    }
    // MySQL labels information_schema columns in upper case, PostgreSQL in lower
    // case, so read the first value of each row instead of a fixed key.
    $scope = driver() === 'mysql' ? 'DATABASE()' : 'current_schema()';
    $rows = fetch_all(
        "SELECT column_name FROM information_schema.columns
         WHERE table_schema = $scope AND table_name = ?",
        [$col]
    );
    return array_map(fn($r) => reset($r), $rows);
}

function table_exists(string $col): bool
{
    try {
        fetch_all("SELECT 1 FROM " . qi($col) . " LIMIT 1");
        return true;
    } catch (PDOException $e) {
        return false;
    }
}

/** Create/migrate tables and insert demo data. Safe to call repeatedly. */
function init_db(): void
{
    foreach (COLLECTIONS as $col => $fields) {
        $defs = [];
        foreach ($fields as $i => $f) {
            $defs[] = qi($f) . ' ' . column_type($col, $f) . ($i === 0 ? ' PRIMARY KEY' : '');
        }
        db()->exec('CREATE TABLE IF NOT EXISTS ' . qi($col) . ' (' . implode(', ', $defs) . ')');

        // add any column that exists in COLLECTIONS but not yet in the table
        $existing = existing_columns($col);
        foreach ($fields as $f) {
            if (!in_array($f, $existing, true)) {
                db()->exec('ALTER TABLE ' . qi($col) . ' ADD COLUMN ' . qi($f) . ' ' . column_type($col, $f));
            }
        }
    }

    /* Demo data goes in once, on a database that has never held anything.
       It used to go in whenever a table happened to be empty, which meant an
       institute that cleared the demo students to type in its own found them
       back the next time COLLECTIONS changed and the migration re-ran. A table
       emptied on purpose stays empty. */
    $seedDone = meta_value('seeded') !== null || meta_value('schema') !== null;

    foreach ($seedDone ? [] : seed_data() as $col => $rows) {
        $count = (int) fetch_one('SELECT COUNT(*) AS c FROM ' . qi($col))['c'];
        if ($count > 0) {
            continue;
        }
        $width = count(COLLECTIONS[$col]);
        $cols = implode(', ', array_map('qi', COLLECTIONS[$col]));
        $ph = implode(', ', array_fill(0, $width, '?'));
        foreach ($rows as $row) {
            // tolerate seed rows written before a column was added
            $row = array_slice(array_pad($row, $width, null), 0, $width);
            run_sql('INSERT INTO ' . qi($col) . " ($cols) VALUES ($ph)", $row);
        }
    }

    /* Students written before the name was split carry only the full name, and
       the new columns would render as blank cells. Fill them once, here, where
       every install passes through: first word is the given name, last word the
       surname, anything between them the middle name. */
    foreach (fetch_all('SELECT * FROM ' . qi('students')) as $s) {
        $needsName = trim((string) ($s['firstName'] ?? '')) === '' && trim((string) ($s['name'] ?? '')) !== '';
        $needsStatus = trim((string) ($s['status'] ?? '')) === '';
        if (!$needsName && !$needsStatus) {
            continue;
        }
        $patch = [];
        if ($needsName) {
            $parts = preg_split('/\s+/', trim((string) $s['name']));
            $patch['firstName'] = array_shift($parts);
            $patch['lastName'] = $parts ? array_pop($parts) : '';
            $patch['middleName'] = $parts ? implode(' ', $parts) : '';
        }
        if ($needsStatus) {
            $patch['status'] = 'Active';
        }
        $sets = implode(', ', array_map(fn($f) => qi($f) . ' = ?', array_keys($patch)));
        run_sql('UPDATE ' . qi('students') . " SET $sets WHERE " . qi('id') . ' = ?',
                array_merge(array_values($patch), [$s['id']]));
    }

    // a class with no section is a class in Section A
    db()->exec('UPDATE ' . qi('courses') . ' SET ' . qi('section') . "='A'
                WHERE " . qi('section') . ' IS NULL OR ' . qi('section') . "=''");

    /* The Admin role row, backfilled on every install that lacks it — run
       outside the demo-seed gate so a live database created before this
       release gains it on the next deploy. */
    seed_admin_role();
    seed_placement_roles();
    seed_academic_head_role();
    undo_placement_roles_full();
    rename_drive_type_nta();
    hierarchy_labels_and_ticket_indexes();
    drop_goods_requisitions();
    students_login_as_studentid();
    rename_accountant_designation();
    add_mca_programme();
    mentorship_indexes_and_grants();

    /* The logins below belong to the demo set too: they exist so a database
       created before a role was invented still has one account to sign in
       with. On a database that has been used, a deleted account stays deleted. */
    if (!$seedDone) {
        upsert('courses', [
            'id' => 'C06', 'code' => 'MBA201', 'name' => 'Marketing Management',
            'branch' => 'MBA', 'semester' => 2, 'credits' => 4, 'facultyId' => 'F02', 'section' => 'B',
        ]);
        seed_accountant_login();
        seed_center_head_login();
        seed_staff_login('placement_officer', 'placementofficers', 'placement');
        meta_set('seeded', date('c'));
    }
    mark_schema_ready();
}

/**
 * Mentorship: the lookups every mentor page makes (by student, by mentor, by
 * date) get an index, and the Academic Head — who oversees academics — is
 * given read access to the mentorship pages once. A grant the Super Admin
 * later removes stays removed.
 */
function mentorship_indexes_and_grants(): void
{
    foreach ([['ix_mas_student', 'mentorassignments', 'studentId'], ['ix_mas_mentor', 'mentorassignments', 'mentorId'],
              ['ix_mas_status', 'mentorassignments', 'status'],
              ['ix_mint_student', 'mentorinteractions', 'studentId'], ['ix_mint_mentor', 'mentorinteractions', 'mentorId'],
              ['ix_mint_date', 'mentorinteractions', 'date'],
              ['ix_mfu_student', 'mentorfollowups', 'studentId'], ['ix_mfu_due', 'mentorfollowups', 'dueDate'],
              ['ix_mfu_status', 'mentorfollowups', 'status']] as [$name, $table, $col]) {
        try {
            db()->exec('CREATE INDEX ' . qi($name) . ' ON ' . qi($table) . ' (' . qi($col) . ')');
        } catch (PDOException $e) {
            // already there
        }
    }
    if (meta_value('mentorshipGrant') !== null) {
        return;
    }
    try {
        $r = fetch_one('SELECT * FROM ' . qi('roles') . ' WHERE ' . qi('key') . " = 'academic_head'");
        if ($r) {
            $perms = json_decode((string) ($r['permissions'] ?? ''), true);
            if (is_array($perms) && !isset($perms['mentorship'])) {
                $perms['mentorship'] = ['view', 'export', 'print', 'reports'];
                run_sql('UPDATE ' . qi('roles') . ' SET ' . qi('permissions') . ' = ? WHERE ' . qi('id') . ' = ?',
                        [json_encode($perms), $r['id']]);
            }
        }
        meta_set('mentorshipGrant', date('c'));
    } catch (Throwable $e) {
        error_log('[gitam-db] mentorship grant skipped: ' . $e->getMessage());
    }
}

/**
 * The MCA arrived after the first release, so a live database never re-runs
 * the syllabus seed. Give it the MCA scheme and put MCA into every master list
 * the admin has already saved — once: a subject or list entry the admin later
 * removes stays removed.
 */
function add_mca_programme(): void
{
    if (meta_value('mca_programme') !== null) {
        return;
    }
    $has = fetch_one('SELECT COUNT(*) AS c FROM ' . qi('syllabus') . ' WHERE ' . qi('branch') . " = 'MCA'");
    if ((int) $has['c'] === 0) {
        foreach (mca_curriculum() as $sem => $subjects) {
            foreach ($subjects as [$code, $name]) {
                run_sql('INSERT INTO ' . qi('syllabus') . ' (' . qi('id') . ', ' . qi('branch') . ', '
                        . qi('semester') . ', ' . qi('code') . ', ' . qi('name') . ', ' . qi('type') . ', '
                        . qi('credits') . ') VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [next_id('syllabus'), 'MCA', $sem, $code, $name, syllabus_type($name), null]);
            }
        }
    }

    /* A list nobody has saved falls back to the app's defaults, which already
       carry MCA; only a saved list needs the value written into it. */
    $lists = [
        'courseList' => ['MCA'],
        'branchList' => ['MCA'],
        'departmentList' => ['MCA'],
    ];
    foreach ($lists as $name => $add) {
        $row = fetch_one('SELECT * FROM ' . qi('settings') . ' WHERE ' . qi('name') . ' = ?', [$name]);
        if (!$row || trim((string) $row['value']) === '') {
            continue;
        }
        $vals = array_values(array_filter(array_map('trim', explode(',', (string) $row['value'])), 'strlen'));
        $merged = array_values(array_unique(array_merge($vals, $add)));
        if ($merged !== $vals) {
            run_sql('UPDATE ' . qi('settings') . ' SET ' . qi('value') . ' = ? WHERE ' . qi('id') . ' = ?',
                    [implode(',', $merged), $row['id']]);
        }
    }
    // a saved student-id code map gets the MCA its own two digits
    $codes = fetch_one('SELECT * FROM ' . qi('settings') . ' WHERE ' . qi('name') . " = 'branchCodes'");
    if ($codes && trim((string) $codes['value']) !== ''
        && !preg_match('/(^|,)\s*MCA\s*=/i', (string) $codes['value'])) {
        run_sql('UPDATE ' . qi('settings') . ' SET ' . qi('value') . ' = ? WHERE ' . qi('id') . ' = ?',
                [rtrim((string) $codes['value'], ', ') . ',MCA=04', $codes['id']]);
    }
    meta_set('mca_programme', date('c'));
}

/**
 * The accountant role was added after the first release, so a database that
 * already has users never re-runs the `users` seed. Give such a database one
 * accountant login to start from — but only when it has none at all, so an
 * account the admin renamed or removed is never resurrected.
 */
function seed_accountant_login(): void
{
    $has = fetch_one('SELECT 1 AS x FROM ' . qi('users') . ' WHERE ' . qi('role') . " = 'accountant'");
    if ($has) {
        return;
    }
    $staff = fetch_one('SELECT * FROM ' . qi('accountants') . ' ORDER BY ' . qi('id') . ' LIMIT 1');
    if (!$staff) {
        return;
    }
    upsert('users', [
        'id' => next_id('users'), 'username' => 'accounts', 'password' => 'pass123',
        'role' => 'accountant', 'refId' => $staff['id'], 'name' => $staff['name'],
    ]);
}

/**
 * Same story for the center head, which was added later still: an existing
 * database never re-runs the `users` seed, so give it one center-head login to
 * start from — only when it has none, so a removed account is never restored.
 */
function seed_center_head_login(): void
{
    $has = fetch_one('SELECT 1 AS x FROM ' . qi('users') . ' WHERE ' . qi('role') . " = 'center_head'");
    if ($has) {
        return;
    }
    $staff = fetch_one('SELECT * FROM ' . qi('centerheads') . ' ORDER BY ' . qi('id') . ' LIMIT 1');
    if (!$staff) {
        return;
    }
    upsert('users', [
        'id' => next_id('users'), 'username' => 'centerhead', 'password' => 'pass123',
        'role' => 'center_head', 'refId' => $staff['id'], 'name' => $staff['name'],
    ]);
}

/**
 * Same story for any staff role added after the first release: an existing
 * database never re-runs the `users` seed, so give the role one login to start
 * from — but only when it has none at all, so an account the admin renamed or
 * removed is never resurrected.
 */
function seed_staff_login(string $role, string $table, string $username): void
{
    $has = fetch_one('SELECT 1 AS x FROM ' . qi('users') . ' WHERE ' . qi('role') . ' = ?', [$role]);
    if ($has) {
        return;
    }
    $staff = fetch_one('SELECT * FROM ' . qi($table) . ' ORDER BY ' . qi('id') . ' LIMIT 1');
    if (!$staff) {
        return;
    }
    upsert('users', [
        'id' => next_id('users'), 'username' => $username, 'password' => 'pass123',
        'role' => $role, 'refId' => $staff['id'], 'name' => $staff['name'],
    ]);
}

/**
 * The Admin role. Seeded as a real row so it is a first-class role and not a
 * one-off in the code: `base = admin` hands it the Super Admin's ceiling and
 * menu shape, `permissions = NULL` leaves the role itself un-narrowed (every
 * Admin account carries its own grant), and `builtin = 1` keeps the Roles
 * screen from letting anyone rename or delete it.
 *
 * Idempotent, and run on every init so a database created before this release
 * gains the row on the next deploy — but only when it is absent, so a Super
 * Admin who edited its description is never overwritten.
 */
function seed_admin_role(): void
{
    $has = fetch_one('SELECT 1 AS x FROM ' . qi('roles') . ' WHERE ' . qi('key') . " = 'subadmin'");
    if ($has) {
        return;
    }
    upsert('roles', [
        'id'          => next_id('roles'),
        'key'         => 'subadmin',
        'label'       => 'Admin',
        'base'        => 'admin',
        'builtin'     => '1',
        'status'      => 'Active',
        'description' => 'Restricted administrator. Sees and does only what the Super Admin grants.',
        'permissions' => null,
    ]);
}

/**
 * The placement-department ACCESS roles: Dean Placement, Placement Officer and
 * Placement Coordinator. Each is a custom access role built on the Super Admin's
 * ceiling (base = admin), so any module can be assigned to it, and starts with
 * `permissions = NULL` which reads as deny-by-default — the role sees nothing
 * until the Super Admin ticks modules on it. The grant is the role template,
 * shared live by every user assigned the role, so changing it moves them all;
 * an individual user can still be given a per-account override on top.
 *
 * These are access roles, distinct from the built-in `placement_officer` role
 * (the placement-cell designation), which is left untouched. Keys are chosen not
 * to collide with it. Idempotent and run on every init, each seeded only when
 * absent, so an edited template is never wiped.
 */
function seed_placement_roles(): void
{
    $roles = [
        ['dean_placement', 'Dean T&P',
         'Placement department head. No access until the Super Admin assigns modules.'],
        ['plmt_officer', 'Placement Officer',
         'Placement officer access role. No access until the Super Admin assigns modules.'],
        ['plmt_coordinator', 'Assistant TPO',
         'Placement coordinator access role. No access until the Super Admin assigns modules.'],
    ];
    foreach ($roles as [$key, $label, $desc]) {
        if (fetch_one('SELECT 1 AS x FROM ' . qi('roles') . ' WHERE ' . qi('key') . ' = ?', [$key])) {
            continue;
        }
        upsert('roles', [
            'id'          => next_id('roles'),
            'key'         => $key,
            'label'       => $label,
            'base'        => 'admin',
            'builtin'     => '1',
            'status'      => 'Active',
            'description' => $desc,
            'permissions' => null,
        ]);
    }
}

/**
 * The Academics Head ACCESS role — a new academic-operations role under the
 * existing Center Head. Like the placement access roles it is built on the Super
 * Admin's ceiling (base = admin) so any module may be assigned to it, but unlike
 * them it ships with a sensible academic starter template rather than empty:
 * full control of Courses & Curriculum, Marks & Results and Attendance, and
 * view of Students, Faculty and Events. The template is capped by the ceiling
 * (effective = ceiling ∩ template) and the Super Admin can widen or narrow it,
 * module by module, in Roles > Academics Head. Idempotent: seeded only when
 * absent, so an edited template is never wiped.
 *
 * It does NOT touch Super Admin or Center Head, and holds no roles/settings/
 * audit access (the escalation shield in index.php already forbids that for any
 * non-Super-Admin), so an Academics Head can never change its own role or reach
 * global settings.
 */
function seed_academic_head_role(): void
{
    if (fetch_one('SELECT 1 AS x FROM ' . qi('roles') . ' WHERE ' . qi('key') . " = 'academic_head'")) {
        return;
    }
    $all = ['view', 'add', 'edit', 'delete', 'import', 'export', 'print', 'approve', 'manage', 'reports'];
    upsert('roles', [
        'id'          => next_id('roles'),
        'key'         => 'academic_head',
        'label'       => 'Academic Head',
        'base'        => 'admin',
        'builtin'     => '1',
        'status'      => 'Active',
        'description' => 'Head of academics, under the Center Head. Manages curriculum, '
                       . 'attendance and results; views students and faculty.',
        'permissions' => [
            'academics'  => $all,          // courses, subjects, timetable, curriculum
            'marks'      => $all,          // internal/semester marks & results
            'attendance' => $all,          // attendance and its records
            'students'   => ['view'],      // student academic details, read
            'staff'      => ['view'],      // faculty list & workload, read
            'events'     => ['view'],      // notices / notifications
        ],
    ]);
}

/**
 * Undo of a short-lived backfill (2026-09-16, reverted the same evening) that
 * wrote a "full access to every module" template onto the three placement
 * access roles. It had already run on any database that served a request in
 * between, so reverting the code alone leaves those rows granted. This puts
 * them back to NULL — deny-by-default, exactly as seed_placement_roles() first
 * created them — but only where the template is byte-for-byte the one that
 * backfill wrote, so a role the Super Admin has since shaped is left alone.
 * Idempotent: once reset, nothing matches and it does nothing.
 */
function undo_placement_roles_full(): void
{
    $all = ['view', 'add', 'edit', 'delete', 'import', 'export', 'print', 'approve', 'manage', 'reports'];
    $full = [];
    foreach (['students', 'staff', 'academics', 'attendance', 'marks', 'fees', 'assets',
              'requisitions', 'library', 'placement', 'events', 'reports'] as $m) {
        $full[$m] = $all;
    }
    foreach (['dean_placement', 'plmt_officer', 'plmt_coordinator'] as $key) {
        $row = fetch_one('SELECT ' . qi('id') . ' AS id, ' . qi('permissions') . ' AS p FROM ' . qi('roles')
            . ' WHERE ' . qi('key') . ' = ?', [$key]);
        if (!$row) {
            continue;
        }
        $cur = json_decode((string) ($row['p'] ?? ''), true);
        if ($cur !== $full) {
            continue;                       // not the backfill's template — leave it
        }
        run_sql('UPDATE ' . qi('roles') . ' SET ' . qi('permissions') . ' = NULL WHERE ' . qi('id') . ' = ?',
            [(string) $row['id']]);
    }
}

/**
 * The placement drive type once labelled "NTA" is NATS (National Apprenticeship
 * Training Scheme). The browser's DRIVE_TYPES list now says NATS, and a drive
 * type is stored as that literal string, so rows saved under the old label
 * must move with it or they drop out of the NATS filter and lose the value in
 * the edit form. Idempotent: once renamed nothing matches.
 */
function rename_drive_type_nta(): void
{
    run_sql('UPDATE ' . qi('drives') . ' SET ' . qi('driveType') . " = 'NATS' WHERE " . qi('driveType') . " = 'NTA'");
}

/**
 * The organisational hierarchy names the placement access roles Dean T&P and
 * Assistant TPO and calls the academic role Academic Head. Seeded rows still
 * carrying the old default labels are renamed; a label the Super Admin typed
 * is left alone. Keys never change, so no account moves.
 *
 * Also indexes the helpdesk tables on the columns every ticket screen filters
 * by. CREATE INDEX has no portable IF NOT EXISTS (MySQL lacks it), so an index
 * that is already there simply fails quietly on the next pass.
 */
function hierarchy_labels_and_ticket_indexes(): void
{
    foreach ([['dean_placement', 'Dean Placement', 'Dean T&P'],
              ['plmt_coordinator', 'Placement Coordinator', 'Assistant TPO'],
              ['academic_head', 'Academics Head', 'Academic Head']] as [$key, $old, $new]) {
        run_sql('UPDATE ' . qi('roles') . ' SET ' . qi('label') . ' = ? WHERE ' . qi('key') . ' = ? AND '
            . qi('label') . ' = ?', [$new, $key, $old]);
    }
    foreach ([['ix_tkh_ticket', 'tickethistory', 'ticketId'],
              ['ix_tkc_ticket', 'ticketcomments', 'ticketId'],
              ['ix_tk_assigned', 'tickets', 'assignedTo'],
              ['ix_tk_created', 'tickets', 'createdBy'],
              ['ix_tkh_to', 'tickethistory', 'toUser'],
              ['ix_users_reporting', 'users', 'reportingTo'],
              ['ix_nt_user', 'notifications', 'userId'],
              ['ix_ap_approver', 'approvals', 'currentApprover'],
              ['ix_ap_requester', 'approvals', 'requestedBy'],
              ['ix_aps_approval', 'approvalsteps', 'approvalId']] as [$name, $table, $col]) {
        try {
            db()->exec('CREATE INDEX ' . qi($name) . ' ON ' . qi($table) . ' (' . qi($col) . ')');
        } catch (PDOException $e) {
            // already there
        }
    }
}

/* The standalone Goods Requisition module was retired: goods purchases now go
   through the hierarchy approval flow (its Purchase / Expense type). The old
   goods requests are cleared on the deploy that removes it. Book requisitions
   share this table and are deliberately left untouched. Gated by a meta flag
   so it runs exactly once, even though the DELETE is itself idempotent. */
function drop_goods_requisitions(): void
{
    if (meta_value('goodsReqDropped') !== null) {
        return;
    }
    try {
        run_sql('DELETE FROM ' . qi('requisitions') . ' WHERE ' . qi('type') . " = 'Goods'");
    } catch (PDOException $e) {
        return;   // requisitions table not there yet -> nothing to drop, try again next deploy
    }
    meta_set('goodsReqDropped', date('c'));
}

/* One-time, for launch: every existing student signs in with their Student ID
   (the `roll`) as BOTH username and password. New students already get this from
   the form; this brings the students already on file into line. Passwords are
   stored hashed like everywhere else. Gated by a meta flag so it runs once, and
   each row is guarded so one clash cannot abort the whole pass. Book/other data
   is untouched — this only writes the `users` rows whose role is student. */
function students_login_as_studentid(): void
{
    if (meta_value('studentLoginIsRoll') !== null) {
        return;
    }
    try {
        $students = fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('roll') . ' AS roll, ' . qi('name') . ' AS name FROM ' . qi('students'));
    } catch (PDOException $e) {
        return;   // students table not there yet -> try again next deploy
    }
    foreach ($students as $s) {
        $roll = trim((string) $s['roll']);
        if ($roll === '') {
            continue;
        }
        try {
            $u = fetch_one('SELECT ' . qi('id') . ' AS id FROM ' . qi('users') . ' WHERE ' . qi('role')
                . " = 'student' AND " . qi('refId') . ' = ?', [(string) $s['id']]);
            if ($u) {
                run_sql('UPDATE ' . qi('users') . ' SET ' . qi('username') . ' = ?, ' . qi('password')
                    . ' = ? WHERE ' . qi('id') . ' = ?', [$roll, hash_password($roll), (string) $u['id']]);
            } else {
                upsert('users', ['id' => next_id('users'), 'username' => $roll, 'password' => hash_password($roll),
                                 'role' => 'student', 'refId' => (string) $s['id'], 'name' => (string) $s['name']]);
            }
        } catch (Throwable $e) {
            // a duplicate roll or other row-level clash: skip this one, keep going
            error_log('[gitam-db] student login backfill skipped ' . $s['id'] . ': ' . $e->getMessage());
        }
    }
    meta_set('studentLoginIsRoll', date('c'));
}

/* The "Accountant" role was relabelled "Finance" in the UI, so its job titles
   follow: every stored "Accountant"/"Senior Accountant" designation becomes
   "Finance Officer"/"Senior Finance Officer" so no record still reads the old
   word. Runs across every staff table that carries a designation column, and is
   a no-op once done (nothing matches the old strings any more). */
function rename_accountant_designation(): void
{
    if (meta_value('accountantIsFinance') !== null) {
        return;
    }
    $map = ['Accountant' => 'Finance Officer', 'Senior Accountant' => 'Senior Finance Officer'];
    foreach (COLLECTIONS as $col => $fields) {
        if (!in_array('designation', $fields, true)) {
            continue;
        }
        foreach ($map as $old => $new) {
            try {
                run_sql('UPDATE ' . qi($col) . ' SET ' . qi('designation') . ' = ? WHERE '
                    . qi('designation') . ' = ?', [$new, $old]);
            } catch (Throwable $e) {
                // table not ready this deploy -> the flag stays unset, retried next time
                error_log('[gitam-db] designation rename skipped for ' . $col . ': ' . $e->getMessage());
                return;
            }
        }
    }
    /* The designation picker offers an editable list, kept in a setting. If a site
       curated it to include the old titles, rewrite them there too so the dropdown
       stops offering "Accountant" (longer string first, so "Senior Accountant" is
       not half-matched by "Accountant"). */
    try {
        $row = fetch_one('SELECT ' . qi('value') . ' AS value FROM ' . qi('settings')
            . ' WHERE ' . qi('name') . " = 'designationList'");
        if ($row) {
            $v = (string) $row['value'];
            $v2 = str_replace(['Senior Accountant', 'Accountant'],
                              ['Senior Finance Officer', 'Finance Officer'], $v);
            if ($v2 !== $v) {
                run_sql('UPDATE ' . qi('settings') . ' SET ' . qi('value') . ' = ? WHERE '
                    . qi('name') . " = 'designationList'", [$v2]);
            }
        }
    } catch (Throwable $e) {
        error_log('[gitam-db] designationList setting rename skipped: ' . $e->getMessage());
    }
    meta_set('accountantIsFinance', date('c'));
}

/* A marker for migrations that live in THIS file rather than in COLLECTIONS or
   SEED_REVISION (which are in config.php). A Hostinger deploy syncs file by file,
   so config.php can arrive before db.php: the old db.php would run init_db,
   mark the new signature ready, and the backfill that only the new db.php
   carries — seed_admin_role() — would never run. Folding this into the
   signature means the signature also moves when db.php itself changes, so the
   new db.php always gets its one pass whichever file lands first. Bump it
   whenever a backfill is added or changed here. */
const DB_MIGRATION_REV = '2026-10-07-mentorship';

/**
 * Changes whenever the tables or the demo data change. SEED_REVISION is in it
 * because seeding fills empty tables only: without it, a table emptied on
 * purpose stays empty for good, and a rewritten demo set never reaches a
 * database that was created before it. A live install with real data is
 * unaffected either way — init_db() never overwrites a table that has rows.
 */
function schema_signature(): string
{
    return substr(md5(json_encode(COLLECTIONS) . '|' . SEED_REVISION . '|' . DB_MIGRATION_REV), 0, 16);
}

/** Has this database ever been seeded, or written to at all? */
function meta_value(string $key): ?string
{
    try {
        $row = fetch_one('SELECT ' . qi('v') . ' AS v FROM ' . qi('_meta') . ' WHERE ' . qi('k') . ' = ?', [$key]);
        return $row ? (string) $row['v'] : null;
    } catch (PDOException $e) {
        return null;   // _meta not there yet -> brand new database
    }
}

function meta_set(string $key, string $value): void
{
    $t = qi('_meta');
    $kType = driver() === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
    $vType = driver() === 'mysql' ? 'VARCHAR(255)' : 'TEXT';
    db()->exec("CREATE TABLE IF NOT EXISTS $t (" . qi('k') . " $kType PRIMARY KEY, " . qi('v') . " $vType)");
    run_sql('DELETE FROM ' . $t . ' WHERE ' . qi('k') . ' = ?', [$key]);
    run_sql('INSERT INTO ' . $t . ' (' . qi('k') . ', ' . qi('v') . ') VALUES (?, ?)', [$key, $value]);
}

function mark_schema_ready(): void
{
    $t = qi('_meta');
    $kType = driver() === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
    $vType = driver() === 'mysql' ? 'VARCHAR(255)' : 'TEXT';
    db()->exec("CREATE TABLE IF NOT EXISTS $t (" . qi('k') . " $kType PRIMARY KEY, " . qi('v') . " $vType)");
    run_sql('DELETE FROM ' . $t . ' WHERE ' . qi('k') . " = 'schema'");
    run_sql('INSERT INTO ' . $t . ' (' . qi('k') . ', ' . qi('v') . ") VALUES ('schema', ?)", [schema_signature()]);
}

/**
 * One cheap query per request: if the schema marker is missing or stale
 * (COLLECTIONS changed), run the full create/migrate/seed pass.
 */
function ensure_schema(): void
{
    try {
        $row = fetch_one('SELECT ' . qi('v') . ' AS v FROM ' . qi('_meta') . ' WHERE ' . qi('k') . " = 'schema'");
        if ($row && $row['v'] === schema_signature()) {
            return;
        }
    } catch (PDOException $e) {
        // _meta missing -> first run
    }
    init_db();
}

/** INSERT-or-REPLACE, written per driver */
function upsert(string $col, array $data): void
{
    $fields = COLLECTIONS[$col];
    $cols = implode(', ', array_map('qi', $fields));
    $ph = implode(', ', array_fill(0, count($fields), '?'));
    $values = [];
    foreach ($fields as $f) {
        $values[] = serialize_value($col, $f, $data[$f] ?? null);
    }

    switch (driver()) {
        case 'sqlite':
            $sql = 'INSERT OR REPLACE INTO ' . qi($col) . " ($cols) VALUES ($ph)";
            break;
        case 'mysql':
            $sets = [];
            foreach ($fields as $f) {
                if ($f !== 'id') {
                    $sets[] = qi($f) . ' = VALUES(' . qi($f) . ')';
                }
            }
            $sql = 'INSERT INTO ' . qi($col) . " ($cols) VALUES ($ph) ON DUPLICATE KEY UPDATE " . implode(', ', $sets);
            break;
        default: // pgsql
            $sets = [];
            foreach ($fields as $f) {
                if ($f !== 'id') {
                    $sets[] = qi($f) . ' = EXCLUDED.' . qi($f);
                }
            }
            $sql = 'INSERT INTO ' . qi($col) . " ($cols) VALUES ($ph) ON CONFLICT (" . qi('id')
                . ') DO UPDATE SET ' . implode(', ', $sets);
    }
    run_sql($sql, $values);
}

/** JSON columns are stored as text */
function serialize_value(string $col, string $field, $value)
{
    if (in_array($field, JSON_FIELDS[$col] ?? [], true) && !is_string($value) && $value !== null) {
        return json_encode($value);
    }
    if (is_bool($value)) {
        return $value ? '1' : '0';
    }
    return $value;
}

/** DB row -> the shape the frontend expects (JSON objects, numeric fields as numbers) */
function row_out(string $col, array $row): array
{
    /* The password hash never leaves the server. Handed to every signed-in
       browser it becomes something an attacker can work on offline at their
       leisure, and no screen has needed to read one since they stopped being
       readable at all. */
    if ($col === 'users') {
        // api_login() puts the token back in afterwards, for its owner alone
        unset($row['password'], $row['token']);
    }
    foreach (JSON_FIELDS[$col] ?? [] as $f) {
        if (!empty($row[$f]) && is_string($row[$f])) {
            $decoded = json_decode($row[$f], true);
            $row[$f] = is_array($decoded) ? $decoded : [];
        } elseif (array_key_exists($f, $row) && !is_array($row[$f])) {
            $row[$f] = new stdClass();
        }
    }
    foreach (INT_FIELDS as $f) {
        if (isset($row[$f]) && $row[$f] !== '') {
            $int = filter_var($row[$f], FILTER_VALIDATE_INT);
            if ($int !== false) {
                $row[$f] = $int;
            }
        }
    }
    return $row;
}

/** next free id for a collection, e.g. S07 / FE03 */
function next_id(string $col): string
{
    $prefix = ID_PREFIX[$col] ?? 'X';
    for ($n = 1; $n < 100000; $n++) {
        $id = $prefix . str_pad((string) $n, 2, '0', STR_PAD_LEFT);
        if (!fetch_one('SELECT 1 AS x FROM ' . qi($col) . ' WHERE ' . qi('id') . ' = ?', [$id])) {
            return $id;
        }
    }
    throw new RuntimeException("Ran out of ids for $col");
}
