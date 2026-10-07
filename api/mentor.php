<?php
/**
 * GITAM B-School CMS — Mentorship module (server side).
 *
 * Every call arrives as /api/mt-<action> and is authorised HERE, against the
 * signed-in account and the student/mentor the request names. The mentor
 * tables never travel in the bootstrap and the generic collection API refuses
 * them outright (MENTOR_TABLES), so nothing a browser sends — a studentId, a
 * mentorId, an interaction or follow-up id — is trusted until it has been
 * checked against the caller's scope:
 *
 *   admin / Super Admin       everything, may assign mentors and change settings
 *   custom-access + grant     everything their `mentorship` grant allows
 *   center_head               read everything, change nothing
 *   faculty (HOD)             read their department, write their own mentees
 *   faculty / guest faculty   their own mentees only
 *
 * The module reuses the CMS data — students, faculty, attendance, marks,
 * courses, settings and the audit log — and only adds what did not exist:
 * who mentors whom (with history), the interactions, the follow-ups and the
 * last risk level seen per student (so a change of level can be audited).
 */

const MT_STUDENT_TYPES = ['Student Meeting', 'Phone Call', 'WhatsApp', 'Email', 'Counselling',
    'Academic Discussion', 'Attendance Discussion', 'Career Guidance', 'Placement Guidance',
    'Personal Issue', 'Other'];
const MT_STUDENT_MODES = ['In Person', 'Phone', 'WhatsApp', 'Email', 'Online', 'Other'];
const MT_PARENT_MODES = ['Phone', 'WhatsApp', 'Email', 'In Person', 'Other'];
const MT_CATEGORIES = ['Academic', 'Attendance', 'Career', 'Placement', 'Personal', 'Health',
    'Financial', 'Behaviour', 'General'];
const MT_STATUSES = ['Open', 'In Progress', 'Resolved', 'Follow-up Required'];
const MT_OPEN_STATUSES = ['Open', 'In Progress', 'Follow-up Required'];
const MT_PRIORITIES = ['Low', 'Medium', 'High'];
const MT_RELATIONS = ['Father', 'Mother', 'Local Guardian', 'Other'];

/* The default thresholds. The Super Admin changes them on Mentor Settings; the
   saved copy lives in the `mentorRiskSettings` setting and is merged over
   these, so a key added in a later release still has a value. */
const MT_RISK_DEFAULTS = [
    'attHigh' => 60,          // attendance below this % → high risk
    'attMedium' => 75,        // attendance up to this % → needs attention
    'cgpaHigh' => 5.5,        // CGPA below this → high risk
    'cgpaMedium' => 6.5,      // CGPA up to this → needs attention
    'backlogHigh' => 2,       // this many backlogs or more → high risk
    'backlogMedium' => 1,     // this many → needs attention
    'noContactDays' => 30,    // no mentor interaction for longer → high risk
    'contactWindowDays' => 30, // a student contacted within this many days counts as contacted
    'parentWindowDays' => 30, // the window for the parent contact rate
    'declineDrop' => 0.5,     // an SGPA fall of this much semester on semester → needs attention
];

/* ------------------------------------------------------------------ basics */

function mt_tz(): DateTimeZone
{
    static $tz = null;
    return $tz ?? ($tz = new DateTimeZone('Asia/Kolkata'));
}

function mt_today(): string
{
    return (new DateTime('now', mt_tz()))->format('Y-m-d');
}

function mt_now(): string
{
    return (new DateTime('now', mt_tz()))->format('c');
}

/** days from $date (Y-m-d) to today; null for no date */
function mt_days_since(?string $date): ?int
{
    if (!$date || !preg_match('/^\d{4}-\d{2}-\d{2}/', $date)) {
        return null;
    }
    $a = new DateTime(substr($date, 0, 10), mt_tz());
    $b = new DateTime(mt_today(), mt_tz());
    return (int) $a->diff($b)->format('%r%a');
}

function mt_add_days(string $date, int $n): string
{
    $d = new DateTime($date, mt_tz());
    $d->modify(($n >= 0 ? '+' : '') . $n . ' days');
    return $d->format('Y-m-d');
}

/** an id that sorts by creation time and never needs a "next free number" scan */
function mt_id(string $prefix): string
{
    return $prefix . strtoupper(str_pad(dechex((int) round(microtime(true) * 1000)), 12, '0', STR_PAD_LEFT)
        . bin2hex(random_bytes(3)));
}

function mt_fail(string $message, int $status = 422, string $error = 'invalid'): void
{
    send_json(['error' => $error, 'message' => $message], $status);
}

/** trimmed, length-capped text — never trusted to be a string */
function mt_str($v, int $max = 255): string
{
    if (is_array($v) || is_object($v) || $v === null) {
        return '';
    }
    $s = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', (string) $v) ?? '');
    return mb_substr($s, 0, $max);
}

function mt_date($v): string
{
    $s = mt_str($v, 10);
    if ($s === '' || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        return '';
    }
    return $s;
}

/** one of a fixed list, or the fallback */
function mt_pick($v, array $allowed, string $fallback = ''): string
{
    $s = mt_str($v, 80);
    foreach ($allowed as $a) {
        if (strcasecmp($a, $s) === 0) {
            return $a;
        }
    }
    return $fallback;
}

function mt_q(string $key, string $default = ''): string
{
    return mt_str($_GET[$key] ?? $default, 120);
}

function mt_in(string $col, array $values): array
{
    $values = array_values(array_unique(array_map('strval', $values)));
    if (!$values) {
        return ['1 = 0', []];
    }
    return [qi($col) . ' IN (' . implode(', ', array_fill(0, count($values), '?')) . ')', $values];
}

/** fetch rows whose $col is in $values, a chunk at a time so huge IN lists never hit a driver limit */
function mt_fetch_in(string $table, string $col, array $values, string $select = '*'): array
{
    $values = array_values(array_unique(array_map('strval', $values)));
    $out = [];
    foreach (array_chunk($values, 500) as $chunk) {
        [$where, $params] = mt_in($col, $chunk);
        foreach (fetch_all("SELECT $select FROM " . qi($table) . " WHERE $where", $params) as $r) {
            $out[] = $r;
        }
    }
    return $out;
}

/* ---------------------------------------------------------------- settings */

function mt_settings(): array
{
    $raw = setting_value('mentorRiskSettings', '');
    $saved = $raw !== '' ? json_decode($raw, true) : null;
    $out = MT_RISK_DEFAULTS;
    if (is_array($saved)) {
        foreach (MT_RISK_DEFAULTS as $k => $def) {
            if (isset($saved[$k]) && is_numeric($saved[$k])) {
                $out[$k] = is_float($def) ? (float) $saved[$k] : (int) $saved[$k];
            }
        }
    }
    return $out;
}

/** mentors the Super Admin has switched off — kept in one setting, a list of faculty ids */
function mt_inactive_mentors(): array
{
    $raw = setting_value('mentorInactive', '');
    return array_values(array_filter(array_map('trim', explode(',', $raw)), 'strlen'));
}

function mt_set_setting(string $name, string $value): void
{
    $row = fetch_one('SELECT ' . qi('id') . ' AS id FROM ' . qi('settings') . ' WHERE ' . qi('name') . ' = ?', [$name]);
    if ($row) {
        run_sql('UPDATE ' . qi('settings') . ' SET ' . qi('value') . ' = ? WHERE ' . qi('id') . ' = ?', [$value, $row['id']]);
    } else {
        upsert('settings', ['id' => mt_id('SET'), 'name' => $name, 'value' => $value]);
    }
}

/* ------------------------------------------------------------------- scope */

/** Head of Department: decided by the designation the office gave the faculty member */
function mt_is_hod(array $f): bool
{
    $d = (string) ($f['designation'] ?? '');
    return (bool) preg_match('/\bH\.?\s?O\.?\s?D\b|head\s+of\s+(the\s+)?department|department\s+head|\bdean\b/i', $d);
}

/** the programmes (students.branch) a department covers — mirrors branchOfDepartment() in app.js */
function mt_dept_branches(string $dept): array
{
    $d = strtolower(trim($dept));
    if ($d === '') {
        return [];
    }
    $map = [
        'management' => 'MBA', 'business administration' => 'MBA',
        'master of business administration' => 'MBA', 'mba' => 'MBA',
        'computer applications' => 'MCA', 'master of computer applications' => 'MCA', 'mca' => 'MCA',
    ];
    if (isset($map[$d])) {
        return [$map[$d]];
    }
    $hit = fetch_one('SELECT ' . qi('branch') . ' AS b FROM ' . qi('students') . ' WHERE LOWER(' . qi('branch') . ') = ?', [$d]);
    return $hit ? [(string) $hit['b']] : [];
}

/**
 * Who is asking, and what they may do here. Decided once per request.
 * level: all | dept | mentor   write: may record interactions/follow-ups
 * manage: may assign mentors and change settings
 */
function mt_ctx(): array
{
    static $ctx = null;
    if ($ctx !== null) {
        return $ctx;
    }
    $me = current_user();
    if (!$me) {
        send_json(['error' => 'unauthorised', 'message' => 'Please sign in.'], 401);
    }
    $role = current_role();
    $c = ['level' => 'none', 'write' => false, 'manage' => false, 'mentorId' => null,
          'hod' => false, 'dept' => '', 'deptBranches' => [], 'userId' => (string) $me['id'],
          'name' => (string) ($me['name'] ?? ''), 'role' => $role];
    if ($role === 'admin') {
        $c['level'] = 'all';
        $c['write'] = true;
        $c['manage'] = true;
    } elseif (in_array($role, ['faculty', 'guest_faculty'], true)) {
        /* A teacher mentors on their own account, whatever modules it was
           narrowed to elsewhere: being assigned mentees is the grant. */
        $f = !empty($me['refId'])
            ? fetch_one('SELECT * FROM ' . qi('faculty') . ' WHERE ' . qi('id') . ' = ?', [(string) $me['refId']])
            : null;
        if ($f) {
            $c['mentorId'] = (string) $f['id'];
            $c['level'] = 'mentor';
            $c['write'] = true;
            if (mt_is_hod($f)) {
                $c['hod'] = true;
                $c['dept'] = (string) ($f['department'] ?? '');
                $c['deptBranches'] = mt_dept_branches($c['dept']);
                if ($c['deptBranches']) {
                    $c['level'] = 'dept';
                }
            }
        }
    } elseif ($role === 'center_head') {
        $c['level'] = 'all';
    } elseif (has_custom_access() && may('mentorship', 'view')) {
        $c['level'] = 'all';
        $c['write'] = may('mentorship', 'add') || may('mentorship', 'edit');
        $c['manage'] = may('mentorship', 'manage');
    }
    if ($c['level'] === 'none') {
        send_json(['error' => 'forbidden', 'message' => 'Mentorship is not available for this account.'], 403);
    }
    if (is_read_only_role()) {
        $c['write'] = false;
        $c['manage'] = false;
    }
    return $ctx = $c;
}

function mt_require_manage(): array
{
    $c = mt_ctx();
    if (!$c['manage']) {
        mt_fail('Only the Super Admin can manage mentor assignments and settings.', 403, 'forbidden');
    }
    return $c;
}

/** active assignment rows, keyed by studentId */
function mt_active_assignments(?array $studentIds = null): array
{
    $sql = 'SELECT * FROM ' . qi('mentorassignments') . ' WHERE ' . qi('status') . " = 'Active'";
    $rows = $studentIds === null ? fetch_all($sql) : [];
    if ($studentIds !== null) {
        foreach (array_chunk(array_values(array_unique($studentIds)), 500) as $chunk) {
            [$where, $params] = mt_in('studentId', $chunk);
            foreach (fetch_all($sql . ' AND ' . $where, $params) as $r) {
                $rows[] = $r;
            }
        }
    }
    $out = [];
    foreach ($rows as $r) {
        $out[(string) $r['studentId']] = $r;
    }
    return $out;
}

/** ids of this mentor's current mentees */
function mt_mentee_ids(string $mentorId): array
{
    return array_map(fn($r) => (string) $r['studentId'], fetch_all(
        'SELECT ' . qi('studentId') . ' FROM ' . qi('mentorassignments') . ' WHERE ' . qi('mentorId') . ' = ? AND '
        . qi('status') . " = 'Active'", [$mentorId]));
}

/** the student ids the caller may read; null means every student */
function mt_scope_ids(array $c): ?array
{
    if ($c['level'] === 'all') {
        return null;
    }
    $ids = $c['mentorId'] ? mt_mentee_ids($c['mentorId']) : [];
    if ($c['level'] === 'dept' && $c['deptBranches']) {
        foreach (mt_fetch_in('students', 'branch', $c['deptBranches'], qi('id')) as $r) {
            $ids[] = (string) $r['id'];
        }
    }
    return array_values(array_unique($ids));
}

/** may the caller read this student at all? */
function mt_can_read_student(array $c, string $sid): bool
{
    $scope = mt_scope_ids($c);
    return $scope === null || in_array($sid, $scope, true);
}

/** may the caller record something against this student? Mentors: own mentees only. */
function mt_can_write_student(array $c, string $sid): bool
{
    if (!$c['write']) {
        // a read-only account is told so, rather than that the student is not theirs
        mt_fail('Your account can view mentorship records but not change them.', 403, 'forbidden');
    }
    if ($c['level'] === 'all') {
        return (bool) fetch_one('SELECT 1 AS x FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$sid]);
    }
    return $c['mentorId'] !== null && in_array($sid, mt_mentee_ids($c['mentorId']), true);
}

/* ---------------------------------------------------------------- the data */

const MT_STUDENT_COLS = ['id', 'roll', 'name', 'branch', 'branchName', 'specialisation', 'semester',
    'section', 'academicYear', 'course', 'cgpa', 'backlogs', 'status', 'photo', 'phone', 'email',
    'batch', 'guardians', 'univRegNo'];

/** the students in scope, as plain arrays */
function mt_load_students(?array $ids): array
{
    $sel = implode(', ', array_map('qi', MT_STUDENT_COLS));
    $rows = $ids === null
        ? fetch_all("SELECT $sel FROM " . qi('students'))
        : mt_fetch_in('students', 'id', $ids, $sel);
    return $rows;
}

/** faculty rows by id (only the columns the module shows) */
function mt_faculty_map(): array
{
    static $map = null;
    if ($map !== null) {
        return $map;
    }
    $map = [];
    foreach (fetch_all('SELECT ' . implode(', ', array_map('qi', ['id', 'empId', 'name', 'department', 'designation', 'email', 'phone', 'status', 'photo']))
        . ' FROM ' . qi('faculty')) as $f) {
        $map[(string) $f['id']] = $f;
    }
    return $map;
}

/** attendance present/total per student — academic classes only, as the student pages count it */
function mt_attendance(array $ids): array
{
    $want = array_fill_keys($ids, true);
    $out = [];
    foreach (fetch_all('SELECT ' . qi('records') . ', ' . qi('type') . ' FROM ' . qi('attendance')) as $a) {
        $type = strtolower(trim((string) ($a['type'] ?? '')));
        if ($type !== '' && $type !== 'academic') {
            continue;
        }
        $rec = json_decode((string) ($a['records'] ?? ''), true);
        if (!is_array($rec)) {
            continue;
        }
        foreach ($rec as $sid => $mark) {
            if (!isset($want[$sid])) {
                continue;
            }
            $o = $out[$sid] ?? [0, 0];
            $o[1]++;
            if ($mark === 'P') {
                $o[0]++;
            }
            $out[$sid] = $o;
        }
    }
    return $out;
}

/** grade point for an internal score — mirrors gradeFor()/markPercent() in app.js */
function mt_grade_point(?float $internal): int
{
    if ($internal === null) {
        return 0;
    }
    $pct = round(($internal / (defined('INTERNAL_MAX') ? INTERNAL_MAX : 40)) * 100);
    foreach ([[90, 10], [80, 9], [70, 8], [60, 7], [50, 6], [40, 5]] as [$min, $p]) {
        if ($pct >= $min) {
            return $p;
        }
    }
    return 0;
}

/** per student: GPA by semester (from marks × course credits), the overall figure and the internal average */
function mt_marks(array $ids): array
{
    $courses = [];
    foreach (fetch_all('SELECT ' . qi('id') . ', ' . qi('semester') . ', ' . qi('credits') . ' FROM ' . qi('courses')) as $c) {
        $courses[(string) $c['id']] = $c;
    }
    $acc = [];
    foreach (mt_fetch_in('marks', 'studentId', $ids, implode(', ', array_map('qi', ['studentId', 'courseId', 'internal']))) as $m) {
        if ($m['internal'] === null || $m['internal'] === '') {
            continue;
        }
        $c = $courses[(string) $m['courseId']] ?? null;
        $cr = $c ? (float) ($c['credits'] ?: 0) : 0;
        $sem = $c ? (int) ($c['semester'] ?: 0) : 0;
        $sid = (string) $m['studentId'];
        $gp = mt_grade_point((float) $m['internal']);
        $acc[$sid]['sem'][$sem][0] = ($acc[$sid]['sem'][$sem][0] ?? 0) + $gp * $cr;
        $acc[$sid]['sem'][$sem][1] = ($acc[$sid]['sem'][$sem][1] ?? 0) + $cr;
        $acc[$sid]['all'][0] = ($acc[$sid]['all'][0] ?? 0) + $gp * $cr;
        $acc[$sid]['all'][1] = ($acc[$sid]['all'][1] ?? 0) + $cr;
        $acc[$sid]['int'][0] = ($acc[$sid]['int'][0] ?? 0) + (float) $m['internal'];
        $acc[$sid]['int'][1] = ($acc[$sid]['int'][1] ?? 0) + 1;
    }
    $out = [];
    foreach ($acc as $sid => $a) {
        $bySem = [];
        ksort($a['sem']);
        foreach ($a['sem'] as $sem => [$pts, $cr]) {
            if ($cr > 0) {
                $bySem[$sem] = round($pts / $cr, 2);
            }
        }
        $out[$sid] = [
            'gpa' => !empty($a['all'][1]) ? round($a['all'][0] / $a['all'][1], 2) : null,
            'bySem' => $bySem,
            'internalAvg' => !empty($a['int'][1]) ? round($a['int'][0] / $a['int'][1], 1) : null,
        ];
    }
    return $out;
}

/** last student / parent contact, open issues and resolved cases, per student */
function mt_interaction_stats(array $ids): array
{
    $out = [];
    foreach (array_chunk(array_values(array_unique($ids)), 500) as $chunk) {
        [$where, $params] = mt_in('studentId', $chunk);
        foreach (fetch_all('SELECT ' . qi('studentId') . ' AS s, ' . qi('kind') . ' AS k, MAX(' . qi('date') . ') AS d, COUNT(*) AS n FROM '
            . qi('mentorinteractions') . " WHERE $where GROUP BY " . qi('studentId') . ', ' . qi('kind'), $params) as $r) {
            $out[$r['s']][$r['k'] === 'parent' ? 'lastParent' : 'lastStudent'] = $r['d'];
            $out[$r['s']]['count'] = ($out[$r['s']]['count'] ?? 0) + (int) $r['n'];
        }
        [$where2, $params2] = mt_in('studentId', $chunk);
        foreach (fetch_all('SELECT ' . qi('studentId') . ' AS s, ' . qi('status') . ' AS st, COUNT(*) AS n FROM '
            . qi('mentorinteractions') . " WHERE $where2 GROUP BY " . qi('studentId') . ', ' . qi('status'), $params2) as $r) {
            if (in_array($r['st'], MT_OPEN_STATUSES, true)) {
                $out[$r['s']]['open'] = ($out[$r['s']]['open'] ?? 0) + (int) $r['n'];
            } elseif ($r['st'] === 'Resolved') {
                $out[$r['s']]['resolved'] = ($out[$r['s']]['resolved'] ?? 0) + (int) $r['n'];
            }
        }
    }
    return $out;
}

/** pending follow-ups per student: the next due date and how many are overdue */
function mt_followup_stats(array $ids): array
{
    $today = mt_today();
    $out = [];
    foreach (mt_fetch_in('mentorfollowups', 'studentId', $ids,
        implode(', ', array_map('qi', ['studentId', 'dueDate', 'status']))) as $f) {
        $sid = (string) $f['studentId'];
        if ($f['status'] !== 'Pending') {
            continue;
        }
        $o = $out[$sid] ?? ['next' => null, 'overdue' => 0, 'pending' => 0];
        $o['pending']++;
        if ($f['dueDate'] && $f['dueDate'] < $today) {
            $o['overdue']++;
        }
        if ($f['dueDate'] && ($o['next'] === null || $f['dueDate'] < $o['next'])) {
            $o['next'] = $f['dueDate'];
        }
        $out[$sid] = $o;
    }
    return $out;
}

/**
 * Risk for one student from the configured thresholds. High wins over
 * Medium; the score weighs each reason so the list can be ranked.
 */
function mt_risk(array $s, array $set): array
{
    $high = [];
    $med = [];
    $att = $s['attendance'];
    if ($att !== null) {
        if ($att < $set['attHigh']) {
            $high[] = "Attendance: {$att}%";
        } elseif ($att <= $set['attMedium']) {
            $med[] = "Attendance: {$att}%";
        }
    }
    $cg = $s['cgpaValue'];
    if ($cg !== null) {
        if ($cg < $set['cgpaHigh']) {
            $high[] = 'CGPA: ' . $cg;
        } elseif ($cg <= $set['cgpaMedium']) {
            $med[] = 'CGPA: ' . $cg;
        }
    }
    $bl = (int) ($s['backlogs'] ?? 0);
    if ($bl >= $set['backlogHigh']) {
        $high[] = "Backlogs: $bl";
    } elseif ($set['backlogMedium'] > 0 && $bl >= $set['backlogMedium']) {
        $med[] = "Backlogs: $bl";
    }
    if ($s['mentorId']) {
        $last = max((string) ($s['lastStudentContact'] ?? ''), (string) ($s['lastParentContact'] ?? ''));
        $days = $last !== '' ? mt_days_since($last) : mt_days_since($s['assignedAt'] ?? null);
        if ($days !== null && $days > $set['noContactDays']) {
            $high[] = $last !== '' ? "No mentor contact: $days days" : "Not contacted since assignment: $days days";
        }
    } else {
        $med[] = 'No mentor assigned';
    }
    if ($s['sgpaDrop'] !== null && $s['sgpaDrop'] >= $set['declineDrop']) {
        $med[] = 'SGPA fell by ' . $s['sgpaDrop'];
    }
    if (($s['overdueFollowups'] ?? 0) > 0) {
        $med[] = 'Overdue follow-up' . ($s['overdueFollowups'] > 1 ? 's: ' . $s['overdueFollowups'] : '');
    }
    if (($s['openIssues'] ?? 0) > 0) {
        $med[] = 'Unresolved issue' . ($s['openIssues'] > 1 ? 's: ' . $s['openIssues'] : '');
    }
    $level = $high ? 'High' : ($med ? 'Medium' : 'Normal');
    return ['level' => $level, 'score' => min(100, count($high) * 30 + count($med) * 10),
            'reasons' => array_merge($high, $med)];
}

/**
 * Every student in scope with the figures the module works from: academic,
 * attendance, mentor, contacts, follow-ups and risk. One pass per source —
 * no query per student.
 */
function mt_build(array $c, bool $currentOnly = true): array
{
    static $memo = [];
    $key = ($currentOnly ? '1' : '0');
    if (isset($memo[$key])) {
        return $memo[$key];
    }
    $students = mt_load_students(mt_scope_ids($c));
    if ($currentOnly) {
        $students = array_values(array_filter($students, fn($s) => in_array((string) ($s['status'] ?? ''), ['', 'Active'], true)));
    }
    $ids = array_map(fn($s) => (string) $s['id'], $students);
    $set = mt_settings();
    $att = mt_attendance($ids);
    $marks = mt_marks($ids);
    $inter = mt_interaction_stats($ids);
    $fu = mt_followup_stats($ids);
    $assign = mt_active_assignments($ids);
    $fac = mt_faculty_map();
    $today = mt_today();
    $rows = [];
    foreach ($students as $s) {
        $sid = (string) $s['id'];
        $a = $att[$sid] ?? null;
        $m = $marks[$sid] ?? null;
        $as = $assign[$sid] ?? null;
        $bySem = $m['bySem'] ?? [];
        $semVals = array_values($bySem);
        $sgpa = $semVals ? end($semVals) : null;
        $prev = count($semVals) > 1 ? $semVals[count($semVals) - 2] : null;
        $cgpaRaw = trim((string) ($s['cgpa'] ?? ''));
        $cgpaValue = is_numeric($cgpaRaw) ? round((float) $cgpaRaw, 2) : ($m['gpa'] ?? null);
        $row = [
            'id' => $sid, 'roll' => (string) ($s['roll'] ?? ''), 'name' => (string) ($s['name'] ?? ''),
            'course' => (string) ($s['course'] ?: $s['branch']), 'branch' => (string) ($s['branch'] ?? ''),
            'branchName' => (string) ($s['branchName'] ?? ''), 'specialisation' => (string) ($s['specialisation'] ?? ''),
            'semester' => (string) ($s['semester'] ?? ''), 'section' => (string) ($s['section'] ?? ''),
            'academicYear' => (string) ($s['academicYear'] ?? ''), 'batch' => (string) ($s['batch'] ?? ''),
            'status' => (string) ($s['status'] ?: 'Active'), 'photo' => (string) ($s['photo'] ?? ''),
            'phone' => (string) ($s['phone'] ?? ''), 'email' => (string) ($s['email'] ?? ''),
            'attendance' => $a && $a[1] > 0 ? (int) round($a[0] / $a[1] * 100) : null,
            'attendanceClasses' => $a ? $a[1] : 0,
            'cgpa' => $cgpaRaw !== '' ? $cgpaRaw : (($m['gpa'] ?? null) !== null ? (string) $m['gpa'] : ''),
            'cgpaValue' => $cgpaValue,
            'sgpa' => $sgpa, 'sgpaDrop' => ($sgpa !== null && $prev !== null && $prev > $sgpa) ? round($prev - $sgpa, 2) : null,
            'backlogs' => (int) ($s['backlogs'] ?? 0),
            'internalAvg' => $m['internalAvg'] ?? null,
            'mentorId' => $as ? (string) $as['mentorId'] : '',
            'mentorName' => $as ? (string) ($fac[(string) $as['mentorId']]['name'] ?? '') : '',
            'assignedAt' => $as ? substr((string) $as['assignedAt'], 0, 10) : '',
            'lastStudentContact' => $inter[$sid]['lastStudent'] ?? '',
            'lastParentContact' => $inter[$sid]['lastParent'] ?? '',
            'interactions' => $inter[$sid]['count'] ?? 0,
            'openIssues' => $inter[$sid]['open'] ?? 0,
            'resolved' => $inter[$sid]['resolved'] ?? 0,
            'nextFollowUp' => $fu[$sid]['next'] ?? '',
            'pendingFollowups' => $fu[$sid]['pending'] ?? 0,
            'overdueFollowups' => $fu[$sid]['overdue'] ?? 0,
        ];
        $last = $row['lastStudentContact'];
        $row['contactStatus'] = $last === '' ? 'Not Contacted'
            : ((mt_days_since($last) ?? 0) > $set['contactWindowDays'] ? 'Due for Contact' : 'Contacted');
        $row['parentContacted'] = $row['lastParentContact'] !== ''
            && (mt_days_since($row['lastParentContact']) ?? 999) <= $set['parentWindowDays'];
        $r = mt_risk($row, $set);
        $row['risk'] = $r['level'];
        $row['riskScore'] = $r['score'];
        $row['riskReasons'] = $r['reasons'];
        $rows[] = $row;
    }
    mt_track_risk($rows);
    return $memo[$key] = $rows;
}

/* Remember the level each student was last seen at, and audit a change. Only
   rows whose level actually moved are written, so a read costs one SELECT. */
function mt_track_risk(array $rows): void
{
    if (!$rows) {
        return;
    }
    try {
        $known = [];
        foreach (mt_fetch_in('mentorriskstate', 'id', array_map(fn($r) => $r['id'], $rows)) as $k) {
            $known[(string) $k['id']] = $k;
        }
        foreach ($rows as $r) {
            $was = $known[$r['id']]['level'] ?? null;
            if ($was === $r['risk']) {
                continue;
            }
            upsert('mentorriskstate', ['id' => $r['id'], 'level' => $r['risk'], 'score' => (string) $r['riskScore'],
                'reasons' => implode('; ', $r['riskReasons']), 'changedAt' => mt_now()]);
            if ($was !== null) {
                audit('risk-change', 'mentorship', $r['id'], $r['name'], "Risk $was → {$r['risk']}",
                    ['from' => $was, 'to' => $r['risk'], 'reasons' => $r['riskReasons']]);
            }
        }
    } catch (Throwable $e) {
        error_log('[gitam-mentor] risk tracking: ' . $e->getMessage());
    }
}

/* -------------------------------------------------------------- list tools */

function mt_filter_students(array $rows): array
{
    $q = strtolower(mt_q('q'));
    $f = [
        'mentorId' => mt_q('mentorId'), 'academicYear' => mt_q('academicYear'), 'course' => mt_q('course'),
        'branch' => mt_q('branch'), 'semester' => mt_q('semester'), 'section' => mt_q('section'),
        'risk' => mt_q('risk'), 'att' => mt_q('att'), 'contact' => mt_q('contact'), 'assigned' => mt_q('assigned'),
        'attention' => mt_q('attention'),
    ];
    return array_values(array_filter($rows, function ($r) use ($q, $f) {
        if ($q !== '' && strpos(strtolower($r['roll'] . ' ' . $r['name'] . ' ' . $r['mentorName'] . ' ' . $r['email']), $q) === false) {
            return false;
        }
        if ($f['mentorId'] !== '' && $r['mentorId'] !== $f['mentorId']) {
            return false;
        }
        if ($f['academicYear'] !== '' && $r['academicYear'] !== $f['academicYear']) {
            return false;
        }
        if ($f['course'] !== '' && strcasecmp($r['course'], $f['course']) !== 0 && strcasecmp($r['branch'], $f['course']) !== 0) {
            return false;
        }
        if ($f['branch'] !== '' && $r['branchName'] !== $f['branch'] && $r['specialisation'] !== $f['branch']) {
            return false;
        }
        if ($f['semester'] !== '' && (string) $r['semester'] !== $f['semester']) {
            return false;
        }
        if ($f['section'] !== '' && strcasecmp($r['section'], $f['section']) !== 0) {
            return false;
        }
        if ($f['risk'] !== '' && $r['risk'] !== $f['risk']) {
            return false;
        }
        if ($f['contact'] !== '' && $r['contactStatus'] !== $f['contact']) {
            return false;
        }
        if ($f['assigned'] === 'yes' && $r['mentorId'] === '') {
            return false;
        }
        if ($f['assigned'] === 'no' && $r['mentorId'] !== '') {
            return false;
        }
        if ($f['attention'] === '1' && $r['risk'] === 'Normal') {
            return false;
        }
        if ($f['att'] !== '') {
            $a = $r['attendance'];
            if ($f['att'] === 'none' && $a !== null) {
                return false;
            }
            if ($f['att'] === 'lt60' && !($a !== null && $a < 60)) {
                return false;
            }
            if ($f['att'] === '60to75' && !($a !== null && $a >= 60 && $a <= 75)) {
                return false;
            }
            if ($f['att'] === 'gt75' && !($a !== null && $a > 75)) {
                return false;
            }
        }
        return true;
    }));
}

/** sort by a whitelisted key; the risk sort ranks High → Medium → Normal, then by score */
function mt_sort(array $rows, array $keys, string $default, string $defaultDir = 'asc'): array
{
    $key = mt_q('sort', $default);
    if (!in_array($key, $keys, true)) {
        $key = $default;
    }
    $dir = mt_q('dir', $defaultDir) === 'desc' ? -1 : 1;
    $rank = ['High' => 3, 'Medium' => 2, 'Normal' => 1];
    usort($rows, function ($a, $b) use ($key, $dir, $rank) {
        $x = $a[$key] ?? null;
        $y = $b[$key] ?? null;
        if ($key === 'risk') {
            $c = ($rank[$x] ?? 0) <=> ($rank[$y] ?? 0);
            if ($c === 0) {
                $c = ($a['riskScore'] ?? 0) <=> ($b['riskScore'] ?? 0);
            }
            return $c * $dir;
        }
        if ($x === null || $x === '') {
            return 1;
        }
        if ($y === null || $y === '') {
            return -1;
        }
        $c = (is_numeric($x) && is_numeric($y)) ? ((float) $x <=> (float) $y) : strnatcasecmp((string) $x, (string) $y);
        return $c * $dir;
    });
    return $rows;
}

/** one page of rows plus the totals; ?export=1 returns everything (capped) for Excel/PDF */
function mt_page(array $rows): array
{
    $total = count($rows);
    if (mt_q('export') === '1') {
        return ['rows' => array_slice($rows, 0, 10000), 'total' => $total, 'page' => 1, 'pages' => 1, 'size' => $total];
    }
    $size = max(5, min(100, (int) mt_q('size', '25')));
    $pages = max(1, (int) ceil($total / $size));
    $page = max(1, min($pages, (int) mt_q('page', '1')));
    return ['rows' => array_slice($rows, ($page - 1) * $size, $size), 'total' => $total,
            'page' => $page, 'pages' => $pages, 'size' => $size];
}

/** student fields the browser may see — never the whole student record */
function mt_public_student(array $r): array
{
    unset($r['cgpaValue']);
    return $r;
}

/* --------------------------------------------------------------- endpoints */

function mt_dispatch(string $method, string $resource, ?string $id): void
{
    if (!defined('MENTOR_TABLES')) {
        mt_fail('The mentorship module is still being installed — please try again in a minute.', 503, 'unavailable');
    }
    $routes = [
        'GET mt-context' => 'mt_api_context',
        'GET mt-dashboard' => 'mt_api_dashboard',
        'GET mt-students' => 'mt_api_students',
        'GET mt-student' => 'mt_api_student',
        'GET mt-interactions' => 'mt_api_interactions',
        'POST mt-interaction' => 'mt_api_add_interaction',
        'POST mt-interaction-status' => 'mt_api_interaction_status',
        'GET mt-followups' => 'mt_api_followups',
        'POST mt-followup' => 'mt_api_add_followup',
        'POST mt-followup-update' => 'mt_api_update_followup',
        'GET mt-mentors' => 'mt_api_mentors',
        'POST mt-mentor-status' => 'mt_api_mentor_status',
        'GET mt-assignments' => 'mt_api_assignments',
        'POST mt-assign' => 'mt_api_assign',
        'POST mt-unassign' => 'mt_api_unassign',
        'POST mt-transfer' => 'mt_api_transfer',
        'POST mt-import' => 'mt_api_import',
        'GET mt-settings' => 'mt_api_get_settings',
        'POST mt-settings' => 'mt_api_save_settings',
        'GET mt-performance' => 'mt_api_performance',
        'GET mt-activity' => 'mt_api_activity',
        'GET mt-report' => 'mt_api_report',
    ];
    $fn = $routes[$method . ' ' . $resource] ?? null;
    if ($fn === null) {
        send_json(['error' => 'not_found', 'message' => 'Unknown mentorship request.'], 404);
    }
    $fn();
}

/** what the screens need to draw their filters and forms */
function mt_api_context(): void
{
    $c = mt_ctx();
    $years = [];
    $courses = [];
    $branches = [];
    $sections = [];
    $add = function (array &$set, $v): void {
        $v = trim((string) $v);
        if ($v !== '') {
            $set[$v] = true;
        }
    };
    foreach (fetch_all('SELECT DISTINCT ' . qi('academicYear') . ' AS y, ' . qi('branch') . ' AS b, ' . qi('course') . ' AS c, '
        . qi('branchName') . ' AS bn, ' . qi('specialisation') . ' AS sp, ' . qi('section') . ' AS sec FROM ' . qi('students')) as $r) {
        $add($years, $r['y']);
        $add($courses, $r['c'] ?: $r['b']);
        $add($branches, $r['bn']);
        $add($branches, $r['sp']);
        $add($sections, $r['sec']);
    }
    $mentors = [];
    if ($c['level'] !== 'mentor') {
        $inactive = mt_inactive_mentors();
        foreach (mt_faculty_map() as $f) {
            if ($c['level'] === 'dept' && !in_array(strtoupper((string) $f['department']), array_map('strtoupper', array_merge([$c['dept']], $c['deptBranches'])), true)
                && (string) $f['id'] !== $c['mentorId']) {
                continue;
            }
            $mentors[] = ['id' => $f['id'], 'empId' => $f['empId'], 'name' => $f['name'],
                          'department' => $f['department'], 'active' => !in_array((string) $f['id'], $inactive, true)];
        }
        usort($mentors, fn($a, $b) => strnatcasecmp((string) $a['name'], (string) $b['name']));
    }
    $sortKeys = fn($a) => array_values(array_filter(array_keys($a), 'strlen'));
    $y = $sortKeys($years);
    rsort($y);
    $co = $sortKeys($courses);
    sort($co);
    $br = $sortKeys($branches);
    sort($br);
    $se = $sortKeys($sections);
    sort($se);
    send_json([
        'level' => $c['level'], 'write' => $c['write'], 'manage' => $c['manage'], 'hod' => $c['hod'],
        'mentorId' => $c['mentorId'], 'dept' => $c['dept'], 'today' => mt_today(),
        'settings' => mt_settings(), 'mentors' => $mentors,
        'years' => $y, 'courses' => $co, 'branches' => $br, 'sections' => $se,
        'lists' => ['studentTypes' => MT_STUDENT_TYPES, 'studentModes' => MT_STUDENT_MODES,
                    'parentModes' => MT_PARENT_MODES, 'categories' => MT_CATEGORIES,
                    'statuses' => MT_STATUSES, 'priorities' => MT_PRIORITIES, 'relations' => MT_RELATIONS],
    ]);
}

/** follow-up rows the caller may see, with the derived Due Today / Overdue / Upcoming state */
function mt_followups_in_scope(array $c, ?string $from = null, ?string $to = null): array
{
    $scope = mt_scope_ids($c);
    $rows = $scope === null
        ? fetch_all('SELECT * FROM ' . qi('mentorfollowups'))
        : mt_fetch_in('mentorfollowups', 'studentId', $scope);
    $today = mt_today();
    foreach ($rows as &$f) {
        $f['state'] = mt_followup_state($f, $today);
    }
    unset($f);
    if ($from || $to) {
        $rows = array_values(array_filter($rows, fn($f) => (!$from || $f['dueDate'] >= $from) && (!$to || $f['dueDate'] <= $to)));
    }
    return $rows;
}

function mt_followup_state(array $f, string $today): string
{
    if ($f['status'] === 'Completed' || $f['status'] === 'Cancelled') {
        return $f['status'];
    }
    if (!$f['dueDate'] || $f['dueDate'] > $today) {
        return 'Upcoming';
    }
    return $f['dueDate'] === $today ? 'Due Today' : 'Overdue';
}

/** interactions the caller may see, optionally narrowed */
function mt_interactions_in_scope(array $c, ?string $kind = null, ?string $from = null, ?string $to = null): array
{
    $scope = mt_scope_ids($c);
    $rows = $scope === null
        ? fetch_all('SELECT * FROM ' . qi('mentorinteractions'))
        : mt_fetch_in('mentorinteractions', 'studentId', $scope);
    return array_values(array_filter($rows, fn($r) => (!$kind || $r['kind'] === $kind)
        && (!$from || $r['date'] >= $from) && (!$to || $r['date'] <= $to)));
}

function mt_api_dashboard(): void
{
    $c = mt_ctx();
    $rows = mt_build($c);
    $mentorId = mt_q('mentorId');
    if ($mentorId !== '' && $c['level'] !== 'mentor') {
        $rows = array_values(array_filter($rows, fn($r) => $r['mentorId'] === $mentorId));
    } elseif ($c['level'] === 'mentor' || mt_q('mine') === '1') {
        $rows = array_values(array_filter($rows, fn($r) => $r['mentorId'] === $c['mentorId']));
    }
    $set = mt_settings();
    $ids = array_fill_keys(array_map(fn($r) => $r['id'], $rows), true);
    $n = count($rows);
    $assigned = array_values(array_filter($rows, fn($r) => $r['mentorId'] !== ''));
    $na = count($assigned);
    $contact = ['Contacted' => 0, 'Not Contacted' => 0, 'Due for Contact' => 0];
    $risk = ['Normal' => 0, 'Medium' => 0, 'High' => 0];
    $parents = 0;
    foreach ($rows as $r) {
        $risk[$r['risk']]++;
        if ($r['mentorId'] !== '') {
            $contact[$r['contactStatus']]++;
            if ($r['parentContacted']) {
                $parents++;
            }
        }
    }
    $fu = array_values(array_filter(mt_followups_in_scope($c), fn($f) => isset($ids[$f['studentId']])));
    $fuc = ['Overdue' => 0, 'Due Today' => 0, 'Upcoming' => 0, 'Completed' => 0];
    foreach ($fu as $f) {
        if (isset($fuc[$f['state']])) {
            $fuc[$f['state']]++;
        }
    }
    $inter = array_values(array_filter(mt_interactions_in_scope($c), fn($i) => isset($ids[$i['studentId']])));
    $resolved = count(array_filter($inter, fn($i) => $i['status'] === 'Resolved'));
    // parent contacts per week, last 30 days (oldest first)
    $since = mt_add_days(mt_today(), -($set['parentWindowDays'] - 1));
    $weeks = [];
    for ($w = 3; $w >= 0; $w--) {
        $start = mt_add_days(mt_today(), -($w * 7 + 6));
        $end = mt_add_days(mt_today(), -($w * 7));
        $weeks[] = ['label' => date('d M', strtotime($start)) . ' – ' . date('d M', strtotime($end)),
                    'count' => count(array_filter($inter, fn($i) => $i['kind'] === 'parent' && $i['date'] >= $start && $i['date'] <= $end))];
    }
    $parentRecent = count(array_filter($inter, fn($i) => $i['kind'] === 'parent' && $i['date'] >= $since));
    usort($inter, fn($a, $b) => strcmp($b['date'] . $b['createdAt'], $a['date'] . $a['createdAt']));
    $names = [];
    foreach ($rows as $r) {
        $names[$r['id']] = $r;
    }
    $recent = array_map(fn($i) => mt_interaction_out($i, $names), array_slice($inter, 0, 8));
    $atRisk = array_values(array_filter($rows, fn($r) => $r['risk'] === 'High'));
    usort($atRisk, fn($a, $b) => $b['riskScore'] <=> $a['riskScore']);
    send_json([
        'kpi' => [
            'assigned' => $na,
            'students' => $n,
            'studentContactRate' => $na ? (int) round($contact['Contacted'] / $na * 100) : 0,
            'parentContactRate' => $na ? (int) round($parents / $na * 100) : 0,
            'atRisk' => $risk['High'],
            'needsAttention' => $risk['Medium'],
            'pendingFollowups' => $fuc['Overdue'] + $fuc['Due Today'] + $fuc['Upcoming'],
            'resolved' => $resolved,
        ],
        'contact' => $contact, 'risk' => $risk, 'followups' => $fuc,
        'parent' => ['contacted' => $parents, 'notContacted' => max(0, $na - $parents), 'recent' => $parentRecent, 'weeks' => $weeks],
        'recent' => $recent,
        'atRisk' => array_map('mt_public_student', array_slice($atRisk, 0, 6)),
        'windowDays' => $set['contactWindowDays'], 'parentWindowDays' => $set['parentWindowDays'],
    ]);
}

function mt_api_students(): void
{
    $c = mt_ctx();
    $rows = mt_build($c, mt_q('all') !== '1');
    if ($c['level'] === 'mentor' || mt_q('mine') === '1') {
        $rows = array_values(array_filter($rows, fn($r) => $r['mentorId'] === $c['mentorId']));
    }
    $rows = mt_filter_students($rows);
    $counts = ['High' => 0, 'Medium' => 0, 'Normal' => 0, 'total' => count($rows)];
    foreach ($rows as $r) {
        $counts[$r['risk']]++;
    }
    $rows = mt_sort($rows, ['roll', 'name', 'semester', 'section', 'attendance', 'cgpa', 'lastStudentContact',
        'lastParentContact', 'risk', 'nextFollowUp', 'mentorName', 'course'], mt_q('attention') === '1' ? 'risk' : 'roll',
        mt_q('attention') === '1' ? 'desc' : 'asc');
    $page = mt_page($rows);
    $page['rows'] = array_map('mt_public_student', $page['rows']);
    $page['counts'] = $counts;
    send_json($page);
}

/** the mentorship profile of one student — refused unless the student is in the caller's scope */
function mt_api_student(): void
{
    $c = mt_ctx();
    $sid = mt_q('id');
    if ($sid === '' || !mt_can_read_student($c, $sid)) {
        mt_fail('This student is not in your mentorship list.', 403, 'forbidden');
    }
    $row = null;
    foreach (mt_build($c, false) as $r) {
        if ($r['id'] === $sid) {
            $row = $r;
            break;
        }
    }
    if (!$row) {
        mt_fail('Student not found.', 404, 'not_found');
    }
    $s = fetch_one('SELECT ' . qi('guardians') . ' FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$sid]);
    $g = json_decode((string) ($s['guardians'] ?? ''), true);
    $guardians = [];
    foreach (is_array($g) ? $g : [] as $x) {
        if (!is_array($x) || trim((string) ($x['name'] ?? '')) === '') {
            continue;
        }
        $guardians[] = ['relation' => (string) ($x['relation'] ?? ''), 'name' => (string) ($x['name'] ?? ''),
                        'mobile' => (string) ($x['mobile'] ?? ''), 'email' => (string) ($x['email'] ?? '')];
    }
    $names = [$sid => $row];
    $inter = array_values(array_filter(mt_interactions_in_scope($c), fn($i) => $i['studentId'] === $sid));
    usort($inter, fn($a, $b) => strcmp($b['date'] . $b['createdAt'], $a['date'] . $a['createdAt']));
    $fus = array_values(array_filter(mt_followups_in_scope($c), fn($f) => $f['studentId'] === $sid));
    usort($fus, fn($a, $b) => strcmp((string) $a['dueDate'], (string) $b['dueDate']));
    $history = fetch_all('SELECT * FROM ' . qi('mentorassignments') . ' WHERE ' . qi('studentId') . ' = ? ORDER BY ' . qi('assignedAt') . ' DESC', [$sid]);
    $fac = mt_faculty_map();
    $m = mt_marks([$sid])[$sid] ?? ['bySem' => []];
    send_json([
        'student' => mt_public_student($row),
        'guardians' => $guardians,
        'semesterGpa' => $m['bySem'],
        'interactions' => array_map(fn($i) => mt_interaction_out($i, $names), $inter),
        'followups' => array_map(fn($f) => mt_followup_out($f, $names), $fus),
        'assignments' => array_map(fn($a) => [
            'mentorName' => (string) ($fac[(string) $a['mentorId']]['name'] ?? $a['mentorId']),
            'academicYear' => $a['academicYear'], 'status' => $a['status'],
            'assignedAt' => substr((string) $a['assignedAt'], 0, 10), 'endedAt' => substr((string) $a['endedAt'], 0, 10),
            'endReason' => $a['endReason'],
        ], $history),
        'canWrite' => $c['write'] && mt_can_write_student($c, $sid),
    ]);
}

function mt_interaction_out(array $i, array $names): array
{
    $fac = mt_faculty_map();
    $s = $names[$i['studentId']] ?? null;
    return [
        'id' => $i['id'], 'kind' => $i['kind'], 'studentId' => $i['studentId'],
        'studentName' => $s['name'] ?? '', 'roll' => $s['roll'] ?? '',
        'mentorId' => $i['mentorId'], 'mentorName' => (string) ($fac[(string) $i['mentorId']]['name'] ?? ($i['createdByName'] ?? '')),
        'date' => $i['date'], 'type' => $i['type'], 'mode' => $i['mode'], 'category' => $i['category'],
        'discussion' => $i['discussion'], 'concern' => $i['concern'], 'actionTaken' => $i['actionTaken'],
        'outcome' => $i['outcome'], 'guardianName' => $i['guardianName'], 'relationship' => $i['relationship'],
        'parentResponse' => $i['parentResponse'], 'priority' => $i['priority'], 'status' => $i['status'],
        'nextFollowUp' => $i['nextFollowUp'], 'remarks' => $i['remarks'],
        'createdByName' => $i['createdByName'], 'createdAt' => $i['createdAt'],
    ];
}

function mt_followup_out(array $f, array $names): array
{
    $fac = mt_faculty_map();
    $s = $names[$f['studentId']] ?? null;
    return [
        'id' => $f['id'], 'studentId' => $f['studentId'], 'studentName' => $s['name'] ?? '', 'roll' => $s['roll'] ?? '',
        'mentorId' => $f['mentorId'], 'mentorName' => (string) ($fac[(string) $f['mentorId']]['name'] ?? ''),
        'interactionId' => $f['interactionId'], 'reason' => $f['reason'], 'createdAt' => substr((string) $f['createdAt'], 0, 10),
        'dueDate' => $f['dueDate'], 'priority' => $f['priority'], 'status' => $f['status'],
        'state' => $f['state'] ?? mt_followup_state($f, mt_today()),
        'completedAt' => substr((string) $f['completedAt'], 0, 10), 'note' => $f['note'],
    ];
}

/** the names table for out-functions, built only for the students the rows mention */
function mt_names_for(array $rows): array
{
    $ids = array_values(array_unique(array_map(fn($r) => (string) $r['studentId'], $rows)));
    $out = [];
    foreach (mt_fetch_in('students', 'id', $ids, implode(', ', array_map('qi', ['id', 'roll', 'name']))) as $s) {
        $out[(string) $s['id']] = $s;
    }
    return $out;
}

function mt_api_interactions(): void
{
    $c = mt_ctx();
    $kind = mt_pick(mt_q('kind'), ['student', 'parent']) ?: null;
    $rows = mt_interactions_in_scope($c, $kind, mt_date(mt_q('from')) ?: null, mt_date(mt_q('to')) ?: null);
    if ($c['level'] === 'mentor' || mt_q('mine') === '1') {
        $mine = array_fill_keys(mt_mentee_ids((string) $c['mentorId']), true);
        $rows = array_values(array_filter($rows, fn($r) => isset($mine[$r['studentId']])));
    }
    foreach (['studentId', 'mentorId', 'status', 'type', 'mode', 'category', 'priority'] as $k) {
        $v = mt_q($k);
        if ($v !== '') {
            $rows = array_values(array_filter($rows, fn($r) => (string) $r[$k] === $v));
        }
    }
    $names = mt_names_for($rows);
    $out = array_map(fn($r) => mt_interaction_out($r, $names), $rows);
    $q = strtolower(mt_q('q'));
    if ($q !== '') {
        $out = array_values(array_filter($out, fn($r) => strpos(strtolower(implode(' ', [$r['studentName'], $r['roll'],
            $r['mentorName'], $r['type'], $r['category'], $r['discussion'], $r['concern'], $r['guardianName']])), $q) !== false));
    }
    $sorted = mt_sort($out, ['date', 'studentName', 'roll', 'type', 'mode', 'status', 'priority', 'mentorName', 'nextFollowUp'], 'date', 'desc');
    send_json(mt_page($sorted));
}

/** a new student or parent interaction; a follow-up date also books the follow-up */
function mt_api_add_interaction(): void
{
    $c = mt_ctx();
    $b = body();
    $kind = mt_pick($b['kind'] ?? '', ['student', 'parent']);
    $sid = mt_str($b['studentId'] ?? '', 64);
    if ($kind === '') {
        mt_fail('Choose whether this is a student or a parent interaction.');
    }
    if ($sid === '' || !mt_can_write_student($c, $sid)) {
        mt_fail('You can record interactions only for students assigned to you.', 403, 'forbidden');
    }
    $date = mt_date($b['date'] ?? '') ?: mt_today();
    if ($date > mt_today()) {
        mt_fail('The interaction date cannot be in the future.');
    }
    $next = mt_date($b['nextFollowUp'] ?? '');
    if ($next !== '' && $next < $date) {
        mt_fail('The next follow-up must be on or after the interaction date.');
    }
    $status = mt_pick($b['status'] ?? '', MT_STATUSES, 'Open');
    if ($status === 'Follow-up Required' && $next === '') {
        mt_fail('Give a follow-up date when the status is "Follow-up Required".');
    }
    $discussion = mt_str($b['discussion'] ?? '', 4000);
    if ($discussion === '') {
        mt_fail('Please write what was discussed.');
    }
    $row = [
        'id' => mt_id('MI'), 'kind' => $kind, 'studentId' => $sid,
        'mentorId' => (string) (mt_active_assignments([$sid])[$sid]['mentorId'] ?? ($c['mentorId'] ?? '')),
        'date' => $date,
        'type' => $kind === 'student' ? mt_pick($b['type'] ?? '', MT_STUDENT_TYPES, 'Student Meeting') : 'Parent Contact',
        'mode' => mt_pick($b['mode'] ?? '', $kind === 'student' ? MT_STUDENT_MODES : MT_PARENT_MODES,
                          $kind === 'student' ? 'In Person' : 'Phone'),
        'category' => mt_pick($b['category'] ?? '', MT_CATEGORIES, 'General'),
        'discussion' => $discussion,
        'concern' => mt_str($b['concern'] ?? '', 2000),
        'actionTaken' => mt_str($b['actionTaken'] ?? '', 2000),
        'outcome' => mt_str($b['outcome'] ?? '', 2000),
        'guardianName' => $kind === 'parent' ? mt_str($b['guardianName'] ?? '', 120) : '',
        'relationship' => $kind === 'parent' ? mt_pick($b['relationship'] ?? '', MT_RELATIONS, 'Other') : '',
        'parentResponse' => $kind === 'parent' ? mt_str($b['parentResponse'] ?? '', 2000) : '',
        'priority' => mt_pick($b['priority'] ?? '', MT_PRIORITIES, 'Medium'),
        'status' => $status, 'nextFollowUp' => $next,
        'remarks' => mt_str($b['remarks'] ?? '', 2000),
        'createdBy' => $c['userId'], 'createdByName' => $c['name'], 'createdAt' => mt_now(),
    ];
    if ($kind === 'parent' && $row['guardianName'] === '') {
        mt_fail('Name the parent or guardian you spoke to.');
    }
    upsert('mentorinteractions', $row);
    $student = fetch_one('SELECT ' . qi('name') . ' FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$sid]);
    $label = $kind === 'parent' ? 'parent interaction' : 'student interaction';
    audit('create', 'mentorship', $row['id'], (string) ($student['name'] ?? $sid), "$label ({$row['type']}, {$row['date']})",
        ['studentId' => $sid, 'kind' => $kind]);
    $fid = null;
    if ($next !== '') {
        $fid = mt_create_followup($c, $sid, $row['mentorId'],
            mt_str(($row['concern'] !== '' ? $row['concern'] : $row['category'] . ' — ' . $row['type']), 255),
            $next, $row['priority'], $row['id'], (string) ($student['name'] ?? $sid));
    }
    send_json(['ok' => true, 'id' => $row['id'], 'followupId' => $fid], 201);
}

/** mark an interaction In Progress / Resolved etc. — only on a student the caller may write */
function mt_api_interaction_status(): void
{
    $c = mt_ctx();
    $b = body();
    $iid = mt_str($b['id'] ?? '', 64);
    $row = $iid !== '' ? fetch_one('SELECT * FROM ' . qi('mentorinteractions') . ' WHERE ' . qi('id') . ' = ?', [$iid]) : null;
    if (!$row || !mt_can_write_student($c, (string) $row['studentId'])) {
        mt_fail('This interaction is not one you can update.', 403, 'forbidden');
    }
    $status = mt_pick($b['status'] ?? '', MT_STATUSES);
    if ($status === '') {
        mt_fail('Unknown status.');
    }
    $outcome = mt_str($b['outcome'] ?? '', 2000);
    run_sql('UPDATE ' . qi('mentorinteractions') . ' SET ' . qi('status') . ' = ?' . ($outcome !== '' ? ', ' . qi('outcome') . ' = ?' : '')
        . ' WHERE ' . qi('id') . ' = ?', $outcome !== '' ? [$status, $outcome, $iid] : [$status, $iid]);
    audit('update', 'mentorship', $iid, '', "interaction status {$row['status']} → $status", ['studentId' => $row['studentId']]);
    send_json(['ok' => true]);
}

function mt_create_followup(array $c, string $sid, string $mentorId, string $reason, string $due, string $priority,
                            ?string $interactionId, string $studentName): string
{
    $id = mt_id('MF');
    upsert('mentorfollowups', [
        'id' => $id, 'studentId' => $sid, 'mentorId' => $mentorId, 'interactionId' => (string) $interactionId,
        'reason' => $reason !== '' ? $reason : 'Follow-up', 'createdAt' => mt_now(), 'dueDate' => $due,
        'priority' => mt_pick($priority, MT_PRIORITIES, 'Medium'), 'status' => 'Pending',
        'completedAt' => '', 'completedBy' => '', 'note' => '', 'createdBy' => $c['userId'],
    ]);
    audit('create', 'mentorship', $id, $studentName, "follow-up due $due", ['studentId' => $sid, 'reason' => $reason]);
    return $id;
}

function mt_api_followups(): void
{
    $c = mt_ctx();
    $rows = mt_followups_in_scope($c, mt_date(mt_q('from')) ?: null, mt_date(mt_q('to')) ?: null);
    if ($c['level'] === 'mentor' || mt_q('mine') === '1') {
        $mine = array_fill_keys(mt_mentee_ids((string) $c['mentorId']), true);
        $rows = array_values(array_filter($rows, fn($r) => isset($mine[$r['studentId']])));
    }
    $counts = ['Overdue' => 0, 'Due Today' => 0, 'Upcoming' => 0, 'Completed' => 0, 'Cancelled' => 0];
    foreach ($rows as $r) {
        $counts[$r['state']] = ($counts[$r['state']] ?? 0) + 1;
    }
    foreach (['studentId', 'mentorId', 'priority'] as $k) {
        $v = mt_q($k);
        if ($v !== '') {
            $rows = array_values(array_filter($rows, fn($r) => (string) $r[$k] === $v));
        }
    }
    $state = mt_q('state');
    if ($state === 'Pending') {
        $rows = array_values(array_filter($rows, fn($r) => in_array($r['state'], ['Overdue', 'Due Today', 'Upcoming'], true)));
    } elseif ($state !== '') {
        $rows = array_values(array_filter($rows, fn($r) => $r['state'] === $state));
    }
    $names = mt_names_for($rows);
    $out = array_map(fn($r) => mt_followup_out($r, $names), $rows);
    $q = strtolower(mt_q('q'));
    if ($q !== '') {
        $out = array_values(array_filter($out, fn($r) => strpos(strtolower($r['studentName'] . ' ' . $r['roll'] . ' ' . $r['reason'] . ' ' . $r['mentorName']), $q) !== false));
    }
    $sorted = mt_sort($out, ['dueDate', 'studentName', 'priority', 'state', 'createdAt', 'mentorName'], 'dueDate', 'asc');
    $page = mt_page($sorted);
    $page['counts'] = $counts;
    send_json($page);
}

function mt_api_add_followup(): void
{
    $c = mt_ctx();
    $b = body();
    $sid = mt_str($b['studentId'] ?? '', 64);
    if ($sid === '' || !mt_can_write_student($c, $sid)) {
        mt_fail('You can create follow-ups only for students assigned to you.', 403, 'forbidden');
    }
    $due = mt_date($b['dueDate'] ?? '');
    if ($due === '') {
        mt_fail('Give the follow-up a due date.');
    }
    if ($due < mt_today()) {
        mt_fail('The due date cannot be in the past.');
    }
    $reason = mt_str($b['reason'] ?? '', 255);
    if ($reason === '') {
        mt_fail('Say what the follow-up is for.');
    }
    $student = fetch_one('SELECT ' . qi('name') . ' FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$sid]);
    $mentorId = (string) (mt_active_assignments([$sid])[$sid]['mentorId'] ?? ($c['mentorId'] ?? ''));
    $id = mt_create_followup($c, $sid, $mentorId, $reason, $due, (string) ($b['priority'] ?? ''), null, (string) ($student['name'] ?? $sid));
    send_json(['ok' => true, 'id' => $id], 201);
}

/** complete, cancel or reschedule — the follow-up must belong to a student the caller may write */
function mt_api_update_followup(): void
{
    $c = mt_ctx();
    $b = body();
    $fid = mt_str($b['id'] ?? '', 64);
    $f = $fid !== '' ? fetch_one('SELECT * FROM ' . qi('mentorfollowups') . ' WHERE ' . qi('id') . ' = ?', [$fid]) : null;
    if (!$f || !mt_can_write_student($c, (string) $f['studentId'])) {
        mt_fail('This follow-up is not one you can update.', 403, 'forbidden');
    }
    $action = mt_pick($b['action'] ?? '', ['complete', 'cancel', 'reschedule', 'reopen']);
    $note = mt_str($b['note'] ?? '', 1000);
    $student = fetch_one('SELECT ' . qi('name') . ' FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [(string) $f['studentId']]);
    $sname = (string) ($student['name'] ?? $f['studentId']);
    if ($action === 'complete' || $action === 'cancel') {
        if ($f['status'] !== 'Pending') {
            mt_fail('This follow-up is already ' . strtolower((string) $f['status']) . '.');
        }
        $st = $action === 'complete' ? 'Completed' : 'Cancelled';
        run_sql('UPDATE ' . qi('mentorfollowups') . ' SET ' . qi('status') . ' = ?, ' . qi('completedAt') . ' = ?, '
            . qi('completedBy') . ' = ?, ' . qi('note') . ' = ? WHERE ' . qi('id') . ' = ?',
            [$st, mt_now(), $c['userId'], $note, $fid]);
        audit($action === 'complete' ? 'complete' : 'cancel', 'mentorship', $fid, $sname, 'follow-up ' . strtolower($st),
            ['studentId' => $f['studentId'], 'note' => $note]);
    } elseif ($action === 'reschedule') {
        $due = mt_date($b['dueDate'] ?? '');
        if ($due === '' || $due < mt_today()) {
            mt_fail('Pick a new due date from today onwards.');
        }
        run_sql('UPDATE ' . qi('mentorfollowups') . ' SET ' . qi('dueDate') . ' = ?, ' . qi('status') . " = 'Pending' WHERE " . qi('id') . ' = ?', [$due, $fid]);
        audit('update', 'mentorship', $fid, $sname, "follow-up rescheduled {$f['dueDate']} → $due", ['studentId' => $f['studentId']]);
    } elseif ($action === 'reopen') {
        run_sql('UPDATE ' . qi('mentorfollowups') . ' SET ' . qi('status') . " = 'Pending', " . qi('completedAt') . " = '' WHERE " . qi('id') . ' = ?', [$fid]);
        audit('update', 'mentorship', $fid, $sname, 'follow-up reopened', ['studentId' => $f['studentId']]);
    } else {
        mt_fail('Unknown action.');
    }
    send_json(['ok' => true]);
}

/* ------------------------------------------------------- admin: the mentors */

/** per-mentor figures from the built student rows, the interactions and the follow-ups */
function mt_mentor_metrics(array $c, ?string $from = null, ?string $to = null, ?array $studentRows = null): array
{
    $rows = $studentRows ?? mt_build($c);
    $by = [];
    foreach ($rows as $r) {
        if ($r['mentorId'] === '') {
            continue;
        }
        $m = &$by[$r['mentorId']];
        $m['students'] = ($m['students'] ?? 0) + 1;
        $m['contacted'] = ($m['contacted'] ?? 0) + ($r['contactStatus'] === 'Contacted' ? 1 : 0);
        $m['parents'] = ($m['parents'] ?? 0) + ($r['parentContacted'] ? 1 : 0);
        $m['atRisk'] = ($m['atRisk'] ?? 0) + ($r['risk'] === 'High' ? 1 : 0);
        $m['attention'] = ($m['attention'] ?? 0) + ($r['risk'] === 'Medium' ? 1 : 0);
        unset($m);
    }
    $ids = array_fill_keys(array_map(fn($r) => $r['id'], $rows), true);
    foreach (mt_interactions_in_scope($c, null, $from, $to) as $i) {
        if (!isset($ids[$i['studentId']]) || $i['mentorId'] === '') {
            continue;
        }
        $m = &$by[$i['mentorId']];
        $m['interactions'] = ($m['interactions'] ?? 0) + 1;
        $m[$i['kind'] === 'parent' ? 'parentInteractions' : 'studentInteractions'] = ($m[$i['kind'] === 'parent' ? 'parentInteractions' : 'studentInteractions'] ?? 0) + 1;
        $m['resolved'] = ($m['resolved'] ?? 0) + ($i['status'] === 'Resolved' ? 1 : 0);
        $m['lastActivity'] = max((string) ($m['lastActivity'] ?? ''), (string) $i['date']);
        unset($m);
    }
    foreach (mt_followups_in_scope($c) as $f) {
        if (!isset($ids[$f['studentId']]) || $f['mentorId'] === '') {
            continue;
        }
        $m = &$by[$f['mentorId']];
        if ($f['state'] === 'Completed' && (!$from || substr((string) $f['completedAt'], 0, 10) >= $from)
            && (!$to || substr((string) $f['completedAt'], 0, 10) <= $to)) {
            $m['completedFollowups'] = ($m['completedFollowups'] ?? 0) + 1;
        }
        if (in_array($f['state'], ['Overdue', 'Due Today', 'Upcoming'], true)) {
            $m['pendingFollowups'] = ($m['pendingFollowups'] ?? 0) + 1;
            $m['overdueFollowups'] = ($m['overdueFollowups'] ?? 0) + ($f['state'] === 'Overdue' ? 1 : 0);
        }
        unset($m);
    }
    $fac = mt_faculty_map();
    $inactive = mt_inactive_mentors();
    $out = [];
    foreach ($fac as $fid => $f) {
        $m = $by[$fid] ?? [];
        $n = (int) ($m['students'] ?? 0);
        $out[] = [
            'id' => $fid, 'empId' => (string) $f['empId'], 'name' => (string) $f['name'],
            'department' => (string) $f['department'], 'designation' => (string) $f['designation'],
            'email' => (string) $f['email'], 'phone' => (string) $f['phone'],
            'status' => in_array($fid, $inactive, true) ? 'Inactive' : 'Active',
            'students' => $n,
            'studentContactRate' => $n ? (int) round(($m['contacted'] ?? 0) / $n * 100) : 0,
            'parentContactRate' => $n ? (int) round(($m['parents'] ?? 0) / $n * 100) : 0,
            'interactions' => (int) ($m['interactions'] ?? 0),
            'studentInteractions' => (int) ($m['studentInteractions'] ?? 0),
            'parentInteractions' => (int) ($m['parentInteractions'] ?? 0),
            'completedFollowups' => (int) ($m['completedFollowups'] ?? 0),
            'pendingFollowups' => (int) ($m['pendingFollowups'] ?? 0),
            'overdueFollowups' => (int) ($m['overdueFollowups'] ?? 0),
            'atRisk' => (int) ($m['atRisk'] ?? 0), 'attention' => (int) ($m['attention'] ?? 0),
            'resolved' => (int) ($m['resolved'] ?? 0),
            'lastActivity' => (string) ($m['lastActivity'] ?? ''),
        ];
    }
    return $out;
}

function mt_scope_mentors(array $c, array $rows): array
{
    if ($c['level'] === 'all') {
        return $rows;
    }
    $keep = array_map('strtoupper', array_merge([$c['dept']], $c['deptBranches']));
    return array_values(array_filter($rows, fn($m) => $m['id'] === $c['mentorId']
        || ($c['level'] === 'dept' && in_array(strtoupper($m['department']), $keep, true))));
}

function mt_api_mentors(): void
{
    $c = mt_ctx();
    if ($c['level'] === 'mentor') {
        mt_fail('The mentor list is for administrators and heads of department.', 403, 'forbidden');
    }
    $rows = mt_scope_mentors($c, mt_mentor_metrics($c));
    $q = strtolower(mt_q('q'));
    $dept = mt_q('department');
    $status = mt_q('status');
    $only = mt_q('onlyMentors');
    $rows = array_values(array_filter($rows, fn($m) => ($q === '' || strpos(strtolower($m['name'] . ' ' . $m['empId'] . ' ' . $m['department']), $q) !== false)
        && ($dept === '' || strcasecmp($m['department'], $dept) === 0)
        && ($status === '' || $m['status'] === $status)
        && ($only !== '1' || $m['students'] > 0)));
    $sorted = mt_sort($rows, ['name', 'empId', 'department', 'students', 'studentContactRate', 'parentContactRate',
        'atRisk', 'pendingFollowups', 'interactions', 'resolved'], 'name');
    send_json(mt_page($sorted));
}

function mt_api_mentor_status(): void
{
    $c = mt_require_manage();
    $b = body();
    $mid = mt_str($b['mentorId'] ?? '', 64);
    $fac = mt_faculty_map();
    if (!isset($fac[$mid])) {
        mt_fail('Mentor not found.', 404, 'not_found');
    }
    $active = !empty($b['active']);
    $list = mt_inactive_mentors();
    $list = $active ? array_values(array_diff($list, [$mid])) : array_values(array_unique(array_merge($list, [$mid])));
    mt_set_setting('mentorInactive', implode(',', $list));
    audit($active ? 'activate' : 'deactivate', 'mentorship', $mid, (string) $fac[$mid]['name'], $active ? 'mentor activated' : 'mentor deactivated');
    send_json(['ok' => true]);
}

/* --------------------------------------------------- admin: the assignments */

function mt_api_assignments(): void
{
    $c = mt_ctx();
    if ($c['level'] === 'mentor') {
        mt_fail('Assignments are managed by the Super Admin.', 403, 'forbidden');
    }
    $status = mt_pick(mt_q('status'), ['Active', 'Ended']);
    $sql = 'SELECT * FROM ' . qi('mentorassignments');
    $rows = $status !== '' ? fetch_all($sql . ' WHERE ' . qi('status') . ' = ?', [$status]) : fetch_all($sql);
    $scope = mt_scope_ids($c);
    if ($scope !== null) {
        $keep = array_fill_keys($scope, true);
        $rows = array_values(array_filter($rows, fn($r) => isset($keep[$r['studentId']])));
    }
    $stu = [];
    foreach (mt_fetch_in('students', 'id', array_map(fn($r) => $r['studentId'], $rows),
        implode(', ', array_map('qi', ['id', 'roll', 'name', 'branch', 'course', 'branchName', 'semester', 'section']))) as $s) {
        $stu[(string) $s['id']] = $s;
    }
    $fac = mt_faculty_map();
    $users = [];
    foreach (fetch_all('SELECT ' . qi('id') . ', ' . qi('name') . ' FROM ' . qi('users')) as $u) {
        $users[(string) $u['id']] = (string) $u['name'];
    }
    $out = [];
    foreach ($rows as $r) {
        $s = $stu[(string) $r['studentId']] ?? [];
        $out[] = [
            'id' => $r['id'], 'studentId' => $r['studentId'], 'roll' => (string) ($s['roll'] ?? ''),
            'studentName' => (string) ($s['name'] ?? '(removed student)'),
            'course' => (string) (($s['course'] ?? '') ?: ($s['branch'] ?? '')), 'branchName' => (string) ($s['branchName'] ?? ''),
            'semester' => (string) ($s['semester'] ?? ''), 'section' => (string) ($s['section'] ?? ''),
            'mentorId' => $r['mentorId'], 'mentorName' => (string) ($fac[(string) $r['mentorId']]['name'] ?? $r['mentorId']),
            'empId' => (string) ($fac[(string) $r['mentorId']]['empId'] ?? ''),
            'academicYear' => $r['academicYear'], 'status' => $r['status'],
            'assignedAt' => substr((string) $r['assignedAt'], 0, 10), 'assignedBy' => $users[(string) $r['assignedBy']] ?? '',
            'endedAt' => substr((string) $r['endedAt'], 0, 10), 'endReason' => (string) $r['endReason'],
        ];
    }
    $mentorId = mt_q('mentorId');
    $q = strtolower(mt_q('q'));
    $out = array_values(array_filter($out, fn($r) => ($mentorId === '' || $r['mentorId'] === $mentorId)
        && ($q === '' || strpos(strtolower($r['roll'] . ' ' . $r['studentName'] . ' ' . $r['mentorName'] . ' ' . $r['empId']), $q) !== false)));
    $sorted = mt_sort($out, ['assignedAt', 'studentName', 'roll', 'mentorName', 'academicYear', 'status', 'endedAt'], 'assignedAt', 'desc');
    send_json(mt_page($sorted));
}

/**
 * Assign (or, with transfer=true, move) students to a mentor. Each student
 * holds at most one Active assignment; ending one keeps it as history.
 * Returns what happened to every student so the screen can say so.
 */
function mt_assign_many(array $c, string $mentorId, array $studentIds, string $year, bool $transfer, string $reason = ''): array
{
    $fac = mt_faculty_map();
    if (!isset($fac[$mentorId])) {
        mt_fail('Choose a valid mentor.');
    }
    if (in_array($mentorId, mt_inactive_mentors(), true)) {
        mt_fail($fac[$mentorId]['name'] . ' is marked inactive as a mentor — activate them first.');
    }
    $studentIds = array_values(array_unique(array_filter(array_map(fn($v) => mt_str($v, 64), $studentIds), 'strlen')));
    if (!$studentIds) {
        mt_fail('Select at least one student.');
    }
    if (count($studentIds) > 2000) {
        mt_fail('Assign at most 2000 students at a time.');
    }
    $known = [];
    foreach (mt_fetch_in('students', 'id', $studentIds, implode(', ', array_map('qi', ['id', 'name', 'academicYear']))) as $s) {
        $known[(string) $s['id']] = $s;
    }
    $result = ['assigned' => 0, 'transferred' => 0, 'duplicate' => 0, 'skipped' => 0, 'invalid' => 0, 'messages' => []];
    lock_collection('mentorassignments');
    $active = mt_active_assignments($studentIds);
    $now = mt_now();
    db()->beginTransaction();
    try {
        foreach ($studentIds as $sid) {
            if (!isset($known[$sid])) {
                $result['invalid']++;
                continue;
            }
            $cur = $active[$sid] ?? null;
            if ($cur && $cur['mentorId'] === $mentorId) {
                $result['duplicate']++;
                continue;
            }
            if ($cur && !$transfer) {
                $result['skipped']++;
                $result['messages'][] = $known[$sid]['name'] . ' is already mentored by ' . ($fac[(string) $cur['mentorId']]['name'] ?? 'another mentor') . ' — use Transfer.';
                continue;
            }
            if ($cur) {
                run_sql('UPDATE ' . qi('mentorassignments') . ' SET ' . qi('status') . " = 'Ended', " . qi('endedAt') . ' = ?, '
                    . qi('endedBy') . ' = ?, ' . qi('endReason') . ' = ? WHERE ' . qi('id') . ' = ?',
                    [$now, $c['userId'], $reason !== '' ? $reason : 'Transferred to ' . $fac[$mentorId]['name'], $cur['id']]);
            }
            upsert('mentorassignments', [
                'id' => mt_id('MA'), 'studentId' => $sid, 'mentorId' => $mentorId,
                'academicYear' => $year !== '' ? $year : (string) ($known[$sid]['academicYear'] ?? ''),
                'status' => 'Active', 'assignedAt' => $now, 'assignedBy' => $c['userId'],
                'endedAt' => '', 'endedBy' => '', 'endReason' => '',
            ]);
            // keep the student record's own "Mentor" field in step, so the rest of the CMS agrees
            run_sql('UPDATE ' . qi('students') . ' SET ' . qi('mentor') . ' = ? WHERE ' . qi('id') . ' = ?', [(string) $fac[$mentorId]['name'], $sid]);
            if ($cur) {
                $result['transferred']++;
                audit('mentor-change', 'mentorship', $sid, (string) $known[$sid]['name'],
                    'mentor ' . ($fac[(string) $cur['mentorId']]['name'] ?? '?') . ' → ' . $fac[$mentorId]['name'],
                    ['from' => $cur['mentorId'], 'to' => $mentorId]);
            } else {
                $result['assigned']++;
                audit('mentor-assign', 'mentorship', $sid, (string) $known[$sid]['name'], 'mentor ' . $fac[$mentorId]['name'],
                    ['mentorId' => $mentorId, 'academicYear' => $year]);
            }
        }
        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }
    return $result;
}

function mt_valid_year(string $y): bool
{
    return $y === '' || (bool) preg_match('/^\d{4}\s*[-–]\s*(\d{2}|\d{4})$/', $y);
}

function mt_api_assign(): void
{
    $c = mt_require_manage();
    $b = body();
    $year = mt_str($b['academicYear'] ?? '', 20);
    if (!mt_valid_year($year)) {
        mt_fail('Academic year should look like 2026-27.');
    }
    $res = mt_assign_many($c, mt_str($b['mentorId'] ?? '', 64), is_array($b['studentIds'] ?? null) ? $b['studentIds'] : [],
        $year, !empty($b['transfer']));
    send_json(['ok' => true] + $res);
}

function mt_api_unassign(): void
{
    $c = mt_require_manage();
    $b = body();
    $ids = is_array($b['studentIds'] ?? null) ? array_map(fn($v) => mt_str($v, 64), $b['studentIds']) : [];
    $reason = mt_str($b['reason'] ?? '', 255) ?: 'Removed by administrator';
    $active = mt_active_assignments($ids);
    $fac = mt_faculty_map();
    $n = 0;
    foreach ($active as $sid => $a) {
        run_sql('UPDATE ' . qi('mentorassignments') . ' SET ' . qi('status') . " = 'Ended', " . qi('endedAt') . ' = ?, '
            . qi('endedBy') . ' = ?, ' . qi('endReason') . ' = ? WHERE ' . qi('id') . ' = ?', [mt_now(), $c['userId'], $reason, $a['id']]);
        run_sql('UPDATE ' . qi('students') . ' SET ' . qi('mentor') . " = '' WHERE " . qi('id') . ' = ?', [$sid]);
        $s = fetch_one('SELECT ' . qi('name') . ' FROM ' . qi('students') . ' WHERE ' . qi('id') . ' = ?', [$sid]);
        audit('mentor-remove', 'mentorship', $sid, (string) ($s['name'] ?? $sid),
            'mentor ' . ($fac[(string) $a['mentorId']]['name'] ?? '?') . ' removed', ['reason' => $reason]);
        $n++;
    }
    send_json(['ok' => true, 'removed' => $n]);
}

/** move all (or some) of one mentor's students to another */
function mt_api_transfer(): void
{
    $c = mt_require_manage();
    $b = body();
    $from = mt_str($b['fromMentorId'] ?? '', 64);
    $to = mt_str($b['toMentorId'] ?? '', 64);
    if ($from === '' || $to === '' || $from === $to) {
        mt_fail('Choose two different mentors.');
    }
    $mine = mt_mentee_ids($from);
    $ids = is_array($b['studentIds'] ?? null) && $b['studentIds']
        ? array_values(array_intersect($mine, array_map(fn($v) => mt_str($v, 64), $b['studentIds'])))
        : $mine;
    if (!$ids) {
        mt_fail('That mentor has no students to transfer.');
    }
    $fac = mt_faculty_map();
    $res = mt_assign_many($c, $to, $ids, mt_str($b['academicYear'] ?? '', 20), true,
        'Transferred from ' . ($fac[$from]['name'] ?? $from) . ' to ' . ($fac[$to]['name'] ?? $to));
    send_json(['ok' => true] + $res);
}

/**
 * Bulk assignment from a spreadsheet: Registration No, Mentor Employee ID,
 * Academic Year. Every row is checked first; with commit=true only the valid
 * rows are applied. The reply lists each problem row for the error report.
 */
function mt_api_import(): void
{
    $c = mt_require_manage();
    $b = body();
    $rows = is_array($b['rows'] ?? null) ? array_slice($b['rows'], 0, 5000) : [];
    if (!$rows) {
        mt_fail('The file has no rows to import.');
    }
    $byRoll = [];
    $byUniv = [];
    foreach (fetch_all('SELECT ' . qi('id') . ', ' . qi('roll') . ', ' . qi('univRegNo') . ', ' . qi('name') . ' FROM ' . qi('students')) as $s) {
        if ((string) $s['roll'] !== '') {
            $byRoll[strtolower(trim((string) $s['roll']))] = $s;
        }
        if ((string) $s['univRegNo'] !== '') {
            $byUniv[strtolower(trim((string) $s['univRegNo']))] = $s;
        }
    }
    $byEmp = [];
    foreach (mt_faculty_map() as $f) {
        if ((string) $f['empId'] !== '') {
            $byEmp[strtolower(trim((string) $f['empId']))] = $f;
        }
        $byEmp[strtolower((string) $f['id'])] = $byEmp[strtolower((string) $f['id'])] ?? $f;
    }
    $inactive = mt_inactive_mentors();
    $years = array_fill_keys(array_filter(array_map(fn($r) => trim((string) $r['y']),
        fetch_all('SELECT DISTINCT ' . qi('academicYear') . ' AS y FROM ' . qi('students')))), true);
    $active = mt_active_assignments();
    $summary = ['total' => count($rows), 'imported' => 0, 'failed' => 0, 'duplicate' => 0, 'invalid' => 0];
    $errors = [];
    $valid = [];
    $seen = [];
    foreach ($rows as $i => $r) {
        $line = $i + 2;   // the header is row 1
        $roll = mt_str(is_array($r) ? ($r['roll'] ?? '') : '', 40);
        $emp = mt_str(is_array($r) ? ($r['empId'] ?? '') : '', 40);
        $year = mt_str(is_array($r) ? ($r['academicYear'] ?? '') : '', 20);
        $err = function (string $kind, string $msg) use (&$errors, &$summary, $line, $roll, $emp, $year) {
            $summary[$kind]++;
            $errors[] = ['row' => $line, 'roll' => $roll, 'empId' => $emp, 'academicYear' => $year, 'problem' => $msg, 'type' => $kind];
        };
        if ($roll === '' || $emp === '') {
            $err('invalid', 'Registration No and Mentor Employee ID are both required.');
            continue;
        }
        $s = $byRoll[strtolower($roll)] ?? $byUniv[strtolower($roll)] ?? null;
        if (!$s) {
            $err('invalid', 'No student with this registration number.');
            continue;
        }
        $f = $byEmp[strtolower($emp)] ?? null;
        if (!$f) {
            $err('invalid', 'No mentor (faculty) with this employee ID.');
            continue;
        }
        if (in_array((string) $f['id'], $inactive, true)) {
            $err('failed', $f['name'] . ' is marked inactive as a mentor.');
            continue;
        }
        if ($year !== '' && (!mt_valid_year($year) || ($years && !isset($years[$year])))) {
            $err('invalid', 'Academic year "' . $year . '" is not one the CMS uses.');
            continue;
        }
        $sid = (string) $s['id'];
        if (isset($seen[$sid])) {
            $err('duplicate', 'This student appears more than once in the file (row ' . $seen[$sid] . ').');
            continue;
        }
        $seen[$sid] = $line;
        $cur = $active[$sid] ?? null;
        if ($cur && (string) $cur['mentorId'] === (string) $f['id']) {
            $err('duplicate', 'Already assigned to ' . $f['name'] . '.');
            continue;
        }
        if ($cur) {
            $err('failed', 'Already mentored by ' . (mt_faculty_map()[(string) $cur['mentorId']]['name'] ?? 'another mentor') . ' — use Transfer.');
            continue;
        }
        $valid[] = ['sid' => $sid, 'mentorId' => (string) $f['id'], 'year' => $year];
    }
    if (!empty($b['commit']) && $valid) {
        $byMentor = [];
        foreach ($valid as $v) {
            $byMentor[$v['mentorId'] . '|' . $v['year']][] = $v['sid'];
        }
        foreach ($byMentor as $k => $sids) {
            [$mid, $yr] = explode('|', $k, 2);
            $res = mt_assign_many($c, $mid, $sids, $yr, false);
            $summary['imported'] += $res['assigned'];
        }
        audit('import', 'mentorship', 'mentorassignments', '', "bulk mentor assignment: {$summary['imported']} of {$summary['total']}", $summary);
    }
    send_json(['ok' => true, 'summary' => $summary, 'ready' => count($valid), 'errors' => $errors,
               'committed' => !empty($b['commit'])]);
}

/* -------------------------------------------------------------- settings */

function mt_api_get_settings(): void
{
    mt_ctx();
    send_json(['settings' => mt_settings(), 'defaults' => MT_RISK_DEFAULTS]);
}

function mt_api_save_settings(): void
{
    mt_require_manage();
    $b = body();
    $in = is_array($b['settings'] ?? null) ? $b['settings'] : [];
    $out = mt_settings();
    foreach (MT_RISK_DEFAULTS as $k => $def) {
        if (!isset($in[$k]) || !is_numeric($in[$k])) {
            continue;
        }
        $v = is_float($def) ? round((float) $in[$k], 2) : (int) $in[$k];
        if ($v < 0 || ($k !== 'declineDrop' && strpos($k, 'cgpa') === false && $v > 365)) {
            mt_fail('Every threshold must be a sensible positive number.');
        }
        $out[$k] = $v;
    }
    if ($out['attHigh'] > $out['attMedium']) {
        mt_fail('The high-risk attendance limit must be below the needs-attention limit.');
    }
    if ($out['cgpaHigh'] > $out['cgpaMedium'] || $out['cgpaMedium'] > 10) {
        mt_fail('The high-risk CGPA limit must be below the needs-attention limit (and at most 10).');
    }
    if ($out['attMedium'] > 100) {
        mt_fail('Attendance limits are percentages (0–100).');
    }
    mt_set_setting('mentorRiskSettings', json_encode($out));
    audit('update', 'mentorship', 'mentorRiskSettings', 'Mentor settings', 'risk thresholds changed', $out);
    send_json(['ok' => true, 'settings' => $out]);
}

/* -------------------------------------------------- performance & activity */

function mt_api_performance(): void
{
    $c = mt_ctx();
    if ($c['level'] === 'mentor') {
        mt_fail('Mentor performance is for administrators and heads of department.', 403, 'forbidden');
    }
    $from = mt_date(mt_q('from')) ?: null;
    $to = mt_date(mt_q('to')) ?: null;
    $rows = mt_filter_students(mt_build($c));   // academicYear/course/branch/semester narrow the students counted
    $metrics = array_values(array_filter(mt_scope_mentors($c, mt_mentor_metrics($c, $from, $to, $rows)),
        fn($m) => $m['students'] > 0 || $m['interactions'] > 0));
    $dept = mt_q('department');
    if ($dept !== '') {
        $metrics = array_values(array_filter($metrics, fn($m) => strcasecmp($m['department'], $dept) === 0));
    }
    $sorted = mt_sort($metrics, ['name', 'students', 'studentContactRate', 'parentContactRate', 'interactions',
        'completedFollowups', 'pendingFollowups', 'atRisk', 'resolved'], 'name');
    send_json(mt_page($sorted));
}

/** one feed of everything mentors did: interactions, follow-up changes and assignment changes */
function mt_api_activity(): void
{
    $c = mt_ctx();
    $from = mt_date(mt_q('from')) ?: null;
    $to = mt_date(mt_q('to')) ?: null;
    $inter = mt_interactions_in_scope($c, null, $from, $to);
    if ($c['level'] === 'mentor') {
        $mine = array_fill_keys(mt_mentee_ids((string) $c['mentorId']), true);
        $inter = array_values(array_filter($inter, fn($r) => isset($mine[$r['studentId']])));
    }
    $names = mt_names_for($inter);
    $out = [];
    foreach ($inter as $i) {
        $o = mt_interaction_out($i, $names);
        $out[] = ['date' => $o['date'], 'at' => $o['createdAt'], 'kind' => $o['kind'] === 'parent' ? 'Parent Interaction' : 'Student Interaction',
                  'type' => $o['type'], 'mode' => $o['mode'], 'studentId' => $o['studentId'], 'studentName' => $o['studentName'], 'roll' => $o['roll'],
                  'mentorId' => $o['mentorId'], 'mentorName' => $o['mentorName'], 'summary' => $o['discussion'],
                  'status' => $o['status'], 'priority' => $o['priority']];
    }
    $mentorId = mt_q('mentorId');
    $q = strtolower(mt_q('q'));
    $kind = mt_q('kind');
    $out = array_values(array_filter($out, fn($r) => ($mentorId === '' || $r['mentorId'] === $mentorId)
        && ($kind === '' || $r['kind'] === $kind)
        && ($q === '' || strpos(strtolower($r['studentName'] . ' ' . $r['roll'] . ' ' . $r['mentorName'] . ' ' . $r['type'] . ' ' . $r['summary']), $q) !== false)));
    $sorted = mt_sort($out, ['date', 'studentName', 'mentorName', 'type', 'kind', 'status'], 'date', 'desc');
    send_json(mt_page($sorted));
}

/**
 * The six reports, each as columns + rows so the screen can show, print and
 * export them the same way. Filters and the date range come from the query.
 */
function mt_api_report(): void
{
    $c = mt_ctx();
    $type = mt_q('type');
    $from = mt_date(mt_q('from')) ?: null;
    $to = mt_date(mt_q('to')) ?: null;
    $col = fn($h, $k, $w = 16) => ['header' => $h, 'key' => $k, 'width' => $w];
    $mineOnly = $c['level'] === 'mentor';
    $mine = $mineOnly ? array_fill_keys(mt_mentee_ids((string) $c['mentorId']), true) : null;
    $keepMine = fn($rows) => $mine === null ? $rows : array_values(array_filter($rows, fn($r) => isset($mine[$r['studentId'] ?? $r['id']])));
    $q = strtolower(mt_q('q'));
    $match = fn(array $r, array $keys) => $q === '' || strpos(strtolower(implode(' ', array_map(fn($k) => (string) ($r[$k] ?? ''), $keys))), $q) !== false;
    switch ($type) {
        case 'activity':
        case 'parents':
            $kind = $type === 'parents' ? 'parent' : null;
            $rows = $keepMine(mt_interactions_in_scope($c, $kind, $from, $to));
            $names = mt_names_for($rows);
            $rows = array_map(fn($r) => mt_interaction_out($r, $names), $rows);
            $rows = array_values(array_filter($rows, fn($r) => (mt_q('mentorId') === '' || $r['mentorId'] === mt_q('mentorId'))
                && $match($r, ['studentName', 'roll', 'mentorName', 'type', 'discussion', 'guardianName'])));
            usort($rows, fn($a, $b) => strcmp($b['date'], $a['date']));
            $title = $type === 'parents' ? 'Parent Contact Report' : 'Mentor Activity Report';
            $cols = $type === 'parents'
                ? [$col('Date', 'date', 12), $col('Student ID', 'roll', 14), $col('Student', 'studentName', 22), $col('Parent / Guardian', 'guardianName', 20),
                   $col('Relationship', 'relationship', 14), $col('Mode', 'mode', 12), $col('Category', 'category', 14), $col('Discussion', 'discussion', 36),
                   $col('Parent Response', 'parentResponse', 26), $col('Outcome', 'outcome', 24), $col('Status', 'status', 14), $col('Mentor', 'mentorName', 20)]
                : [$col('Date', 'date', 12), $col('Mentor', 'mentorName', 20), $col('Student ID', 'roll', 14), $col('Student', 'studentName', 22),
                   $col('Interaction', 'type', 18), $col('Mode', 'mode', 12), $col('Category', 'category', 14), $col('Discussion', 'discussion', 36),
                   $col('Action Taken', 'actionTaken', 26), $col('Outcome', 'outcome', 24), $col('Priority', 'priority', 10), $col('Status', 'status', 14),
                   $col('Next Follow-up', 'nextFollowUp', 14)];
            break;
        case 'students':
        case 'risk':
            $rows = mt_filter_students(mt_build($c));
            if ($mineOnly) {
                $rows = array_values(array_filter($rows, fn($r) => $r['mentorId'] === $c['mentorId']));
            }
            if ($type === 'risk') {
                $rows = array_values(array_filter($rows, fn($r) => $r['risk'] !== 'Normal'));
                $rows = mt_sort($rows, ['risk'], 'risk', 'desc');
            }
            foreach ($rows as &$r) {
                $r['reasons'] = implode('; ', $r['riskReasons']);
                $r['attendanceText'] = $r['attendance'] === null ? '—' : $r['attendance'] . '%';
                $r['branchText'] = trim($r['course'] . ($r['branchName'] !== '' ? ' / ' . $r['branchName'] : ($r['specialisation'] !== '' ? ' / ' . $r['specialisation'] : '')));
            }
            unset($r);
            $rows = array_map('mt_public_student', $rows);
            $title = $type === 'risk' ? 'At-Risk Student Report' : 'Student Mentorship Report';
            $cols = $type === 'risk'
                ? [$col('Student ID', 'roll', 14), $col('Student', 'name', 22), $col('Programme / Branch', 'branchText', 22), $col('Sem', 'semester', 6),
                   $col('Risk', 'risk', 10), $col('Score', 'riskScore', 8), $col('Reasons', 'reasons', 50), $col('Mentor', 'mentorName', 20),
                   $col('Last Contact', 'lastStudentContact', 14), $col('Next Follow-up', 'nextFollowUp', 14)]
                : [$col('Student ID', 'roll', 14), $col('Student', 'name', 22), $col('Programme / Branch', 'branchText', 22), $col('Sem', 'semester', 6),
                   $col('Sec', 'section', 6), $col('Attendance', 'attendanceText', 11), $col('CGPA', 'cgpa', 8), $col('Backlogs', 'backlogs', 9),
                   $col('Mentor', 'mentorName', 20), $col('Last Student Contact', 'lastStudentContact', 16), $col('Last Parent Contact', 'lastParentContact', 16),
                   $col('Interactions', 'interactions', 11), $col('Risk', 'risk', 10), $col('Next Follow-up', 'nextFollowUp', 14)];
            break;
        case 'followups':
            $rows = $keepMine(mt_followups_in_scope($c, $from, $to));
            $names = mt_names_for($rows);
            $rows = array_map(fn($r) => mt_followup_out($r, $names), $rows);
            $rows = array_values(array_filter($rows, fn($r) => (mt_q('mentorId') === '' || $r['mentorId'] === mt_q('mentorId'))
                && (mt_q('state') === '' || $r['state'] === mt_q('state'))
                && $match($r, ['studentName', 'roll', 'reason', 'mentorName'])));
            usort($rows, fn($a, $b) => strcmp((string) $a['dueDate'], (string) $b['dueDate']));
            $title = 'Follow-up Report';
            $cols = [$col('Student ID', 'roll', 14), $col('Student', 'studentName', 22), $col('Reason', 'reason', 36), $col('Created', 'createdAt', 12),
                     $col('Due', 'dueDate', 12), $col('Priority', 'priority', 10), $col('Status', 'state', 12), $col('Completed', 'completedAt', 12),
                     $col('Mentor', 'mentorName', 20), $col('Note', 'note', 26)];
            break;
        case 'performance':
            if ($mineOnly) {
                mt_fail('Mentor performance is for administrators and heads of department.', 403, 'forbidden');
            }
            $rows = array_values(array_filter(mt_scope_mentors($c, mt_mentor_metrics($c, $from, $to, mt_filter_students(mt_build($c)))),
                fn($m) => $m['students'] > 0 || $m['interactions'] > 0));
            $rows = array_values(array_filter($rows, fn($r) => $match($r, ['name', 'empId', 'department'])));
            foreach ($rows as &$r) {
                $r['studentContactText'] = $r['studentContactRate'] . '%';
                $r['parentContactText'] = $r['parentContactRate'] . '%';
            }
            unset($r);
            $title = 'Mentor Performance Report';
            $cols = [$col('Emp ID', 'empId', 12), $col('Mentor', 'name', 22), $col('Department', 'department', 16), $col('Students', 'students', 10),
                     $col('Student Contact', 'studentContactText', 14), $col('Parent Contact', 'parentContactText', 14),
                     $col('Interactions', 'interactions', 12), $col('Follow-ups Done', 'completedFollowups', 14),
                     $col('Follow-ups Pending', 'pendingFollowups', 16), $col('At Risk', 'atRisk', 9), $col('Resolved', 'resolved', 10)];
            break;
        default:
            mt_fail('Unknown report.', 404, 'not_found');
            return;
    }
    send_json(['title' => $title, 'columns' => $cols, 'rows' => array_slice($rows, 0, 10000), 'total' => count($rows),
               'from' => $from, 'to' => $to]);
}
