<?php
/**
 * GITAM B-School CMS — Faculty Class Attendance / Teaching Activity (server side).
 *
 * This is NOT employee attendance. It answers, for every scheduled class:
 * who was timetabled, did they conduct it, if not why, who actually conducted
 * it (a substitute keeps BOTH names), when it really started and ended, how
 * long it ran, and how much teaching time was lost.
 *
 *   MASTER SOURCE = the existing timetable. A class instance is a timetable
 *   row on a particular date (weekday match). The timetable is never changed;
 *   nothing is created by hand. Each record snapshots the scheduled faculty, so
 *   a later timetable edit never rewrites history.
 *
 * Every call arrives as /api/tc-<action> and is authorised HERE:
 *   admin / Super Admin        full access
 *   course_coordinator         record classes within their course scope
 *   center_head                read everything, change nothing
 *   faculty (HOD by desig.)    read their department
 *   faculty / guest faculty    read their own teaching activity
 *
 * The record and log tables never travel in the bootstrap and the generic
 * collection API refuses them (TEACHING_TABLES); a substitute marked here never
 * touches the employee attendance module.
 */

const TC_STATUSES = ['Pending', 'Ongoing', 'Completed', 'Not Conducted', 'Cancelled', 'Rescheduled'];
const TC_METHODS = ['Lecture', 'Tutorial', 'Lab / Practical', 'Seminar', 'Presentation', 'Discussion',
    'Guest Lecture', 'Industrial Visit', 'Test / Exam', 'Revision', 'Other'];
const TC_NC_REASONS = ['Faculty Absent', 'Faculty on Leave', 'Faculty Unavailable', 'Class Cancelled',
    'Room Issue', 'Holiday', 'Official Duty', 'Emergency', 'Other'];
const TC_SUB_REASONS = ['Faculty Absent', 'Faculty on Leave', 'Faculty Unavailable', 'Official Duty',
    'Emergency', 'Other'];
const TC_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/* the day-view window either side of today a coordinator may open without a
   from/to, and the hard cap on a report's date span */
const TC_MAX_RANGE_DAYS = 400;

/* ------------------------------------------------------------------ basics */

function tc_tz(): DateTimeZone
{
    static $tz = null;
    return $tz ?? ($tz = new DateTimeZone('Asia/Kolkata'));
}
function tc_today(): string
{
    return (new DateTime('now', tc_tz()))->format('Y-m-d');
}
function tc_now(): string
{
    return (new DateTime('now', tc_tz()))->format('c');
}
function tc_now_minutes(): int
{
    $n = new DateTime('now', tc_tz());
    return (int) $n->format('G') * 60 + (int) $n->format('i');
}
function tc_weekday(string $date): string
{
    return TC_DAYS[(int) (new DateTime($date, tc_tz()))->format('w')];
}
function tc_id(string $prefix): string
{
    return $prefix . strtoupper(str_pad(dechex((int) round(microtime(true) * 1000)), 12, '0', STR_PAD_LEFT)
        . bin2hex(random_bytes(3)));
}
function tc_fail(string $message, int $status = 422, string $error = 'invalid'): void
{
    send_json(['error' => $error, 'message' => $message], $status);
}
function tc_str($v, int $max = 255): string
{
    if (is_array($v) || is_object($v) || $v === null) {
        return '';
    }
    $s = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', (string) $v) ?? '');
    return mb_substr($s, 0, $max);
}
function tc_date($v): string
{
    $s = tc_str($v, 10);
    if ($s === '' || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        return '';
    }
    return $s;
}
/** "HH:MM" -> minutes since midnight, or null */
function tc_time_min($v): ?int
{
    $s = tc_str($v, 5);
    if (!preg_match('/^(\d{1,2}):(\d{2})$/', $s, $m)) {
        return null;
    }
    $h = (int) $m[1];
    $mm = (int) $m[2];
    if ($h > 23 || $mm > 59) {
        return null;
    }
    return $h * 60 + $mm;
}
function tc_time_str(?int $min): string
{
    if ($min === null) {
        return '';
    }
    return sprintf('%02d:%02d', intdiv($min, 60) % 24, $min % 60);
}
function tc_pick($v, array $allowed, string $fallback = ''): string
{
    $s = tc_str($v, 80);
    foreach ($allowed as $a) {
        if (strcasecmp($a, $s) === 0) {
            return $a;
        }
    }
    return $fallback;
}
function tc_q(string $key, string $default = ''): string
{
    return tc_str($_GET[$key] ?? $default, 120);
}
function tc_fetch_in(string $table, string $col, array $values, string $select = '*'): array
{
    $values = array_values(array_unique(array_map('strval', $values)));
    $out = [];
    foreach (array_chunk($values, 500) as $chunk) {
        if (!$chunk) {
            continue;
        }
        $ph = implode(', ', array_fill(0, count($chunk), '?'));
        foreach (fetch_all("SELECT $select FROM " . qi($table) . ' WHERE ' . qi($col) . " IN ($ph)", $chunk) as $r) {
            $out[] = $r;
        }
    }
    return $out;
}

/* ------------------------------------------------------------ master data */

/** courses by id, with the fields a class line needs */
function tc_courses(): array
{
    static $map = null;
    if ($map !== null) {
        return $map;
    }
    $map = [];
    foreach (fetch_all('SELECT ' . implode(', ', array_map('qi', ['id', 'code', 'name', 'shortName', 'branch', 'semester', 'section', 'facultyId', 'credits']))
        . ' FROM ' . qi('courses')) as $c) {
        $map[(string) $c['id']] = $c;
    }
    return $map;
}
function tc_faculty_map(): array
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
/** the timetable rows, decorated with their course and scheduled faculty */
function tc_timetable(): array
{
    static $rows = null;
    if ($rows !== null) {
        return $rows;
    }
    $courses = tc_courses();
    $rows = [];
    foreach (fetch_all('SELECT * FROM ' . qi('timetable')) as $t) {
        $c = $courses[(string) $t['courseId']] ?? null;
        $t['course'] = $c;
        $t['scheduledFacultyId'] = $c ? (string) $c['facultyId'] : '';
        $rows[] = $t;
    }
    return $rows;
}

/* ------------------------------------------------------------------- scope */

function tc_dept_branches(string $dept): array
{
    $d = strtolower(trim($dept));
    if ($d === '') {
        return [];
    }
    $map = ['management' => 'MBA', 'business administration' => 'MBA', 'master of business administration' => 'MBA',
            'mba' => 'MBA', 'computer applications' => 'MCA', 'master of computer applications' => 'MCA', 'mca' => 'MCA'];
    if (isset($map[$d])) {
        return [$map[$d]];
    }
    $hit = fetch_one('SELECT ' . qi('branch') . ' AS b FROM ' . qi('students') . ' WHERE LOWER(' . qi('branch') . ') = ?', [$d]);
    return $hit ? [(string) $hit['b']] : [];
}
function tc_is_hod(array $f): bool
{
    $d = (string) ($f['designation'] ?? '');
    return (bool) preg_match('/\bH\.?\s?O\.?\s?D\b|head\s+of\s+(the\s+)?department|department\s+head|\bdean\b/i', $d);
}

/** the descendants of a user in the reporting tree (for a coordinator's team) */
function tc_team_faculty(string $userId): array
{
    $all = fetch_all('SELECT ' . qi('id') . ' AS id, ' . qi('reportingTo') . ' AS rt, ' . qi('role') . ' AS role, ' . qi('refId') . ' AS refId FROM ' . qi('users'));
    $kids = [];
    foreach ($all as $u) {
        $kids[(string) $u['rt']][] = $u;
    }
    $seen = [];
    $queue = [$userId];
    $refs = [];
    while ($queue) {
        $id = array_shift($queue);
        if (isset($seen[$id])) {
            continue;
        }
        $seen[$id] = true;
        foreach ($kids[$id] ?? [] as $u) {
            $queue[] = (string) $u['id'];
            if (in_array((string) $u['role'], ['faculty', 'guest_faculty'], true) && (string) $u['refId'] !== '') {
                $refs[(string) $u['refId']] = true;
            }
        }
    }
    return array_keys($refs);
}

/**
 * Who is asking and what they may do.
 * level: all | coord | dept | own     write: may record classes
 */
function tc_ctx(): array
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
    $c = ['level' => 'none', 'write' => false, 'manage' => false, 'role' => $role, 'facultyId' => (string) ($me['refId'] ?? ''),
          'userId' => (string) $me['id'], 'name' => (string) ($me['name'] ?? ''), 'courseScope' => null, 'dept' => '', 'deptBranches' => []];
    if ($role === 'admin') {
        $c['level'] = 'all';
        $c['write'] = true;
        $c['manage'] = true;
    } elseif ($role === 'course_coordinator' && !has_custom_access()) {
        $c['level'] = 'coord';
        $c['write'] = true;
        $refs = tc_team_faculty((string) $me['id']);
        if ($refs) {
            // only the courses taught by the coordinator's team
            $c['courseScope'] = array_map(fn($x) => (string) $x['id'],
                tc_fetch_in('courses', 'facultyId', $refs, qi('id') . ' AS id'));
        }
        // no team placed under them -> they coordinate the whole centre (scope null = all)
    } elseif ($role === 'center_head') {
        $c['level'] = 'all';
    } elseif (in_array($role, ['faculty', 'guest_faculty'], true)) {
        $f = $c['facultyId'] !== '' ? (tc_faculty_map()[$c['facultyId']] ?? null) : null;
        if ($f && tc_is_hod($f)) {
            $c['level'] = 'dept';
            $c['dept'] = (string) ($f['department'] ?? '');
            $c['deptBranches'] = tc_dept_branches($c['dept']);
        } else {
            $c['level'] = 'own';
        }
    } elseif (has_custom_access() && may('teaching', 'view')) {
        $c['level'] = 'all';
        $c['write'] = may('teaching', 'add') || may('teaching', 'edit');
        $c['manage'] = may('teaching', 'manage');
    }
    if ($c['level'] === 'none') {
        send_json(['error' => 'forbidden', 'message' => 'Class attendance is not available for this account.'], 403);
    }
    if (is_read_only_role()) {
        $c['write'] = false;
    }
    return $ctx = $c;
}

/** does a decorated timetable row fall inside the caller's scope? */
function tc_tt_in_scope(array $c, array $tt): bool
{
    if ($c['level'] === 'all') {
        return true;
    }
    if ($c['level'] === 'coord') {
        return $c['courseScope'] === null || in_array((string) $tt['courseId'], $c['courseScope'], true);
    }
    if ($c['level'] === 'dept') {
        return in_array((string) ($tt['branch'] ?? ''), $c['deptBranches'], true)
            || in_array(strtoupper((string) (($tt['course']['branch'] ?? ''))), array_map('strtoupper', $c['deptBranches']), true);
    }
    // own: the faculty was scheduled for it (substitute classes are added separately where needed)
    return (string) $tt['scheduledFacultyId'] === $c['facultyId'];
}

function tc_require_write(array $c): void
{
    if (!$c['write']) {
        tc_fail('Your account can view class attendance but not record it.', 403, 'forbidden');
    }
}

/* ----------------------------------------------------------- calculations */

/** fill in the derived minutes for a record from its times */
function tc_compute(array &$r): void
{
    $ss = tc_time_min($r['scheduledStart']);
    $se = tc_time_min($r['scheduledEnd']);
    $as = tc_time_min($r['actualStart']);
    $ae = tc_time_min($r['actualEnd']);
    $sched = ($ss !== null && $se !== null && $se > $ss) ? $se - $ss : 0;
    $actual = ($as !== null && $ae !== null && $ae > $as) ? $ae - $as : 0;
    $r['scheduledMinutes'] = $sched;
    $r['actualMinutes'] = $actual;
    $r['lateMinutes'] = ($as !== null && $ss !== null && $as > $ss) ? $as - $ss : 0;
    $r['earlyMinutes'] = ($ae !== null && $se !== null && $se > $ae) ? $se - $ae : 0;
    // shortfall only counts for a class that was actually held
    $r['shortfallMinutes'] = ($actual > 0 && $sched > 0 && $sched > $actual) ? $sched - $actual : 0;
}

/* --------------------------------------------------------------- the data */

/** records in a date range, optionally limited to a set of timetable ids, keyed by timetableId|date */
function tc_records(?string $from, ?string $to): array
{
    $where = [];
    $params = [];
    if ($from) {
        $where[] = qi('scheduledDate') . ' >= ?';
        $params[] = $from;
    }
    if ($to) {
        $where[] = qi('scheduledDate') . ' <= ?';
        $params[] = $to;
    }
    $sql = 'SELECT * FROM ' . qi('classattendance') . ($where ? ' WHERE ' . implode(' AND ', $where) : '');
    $out = [];
    foreach (fetch_all($sql, $params) as $r) {
        $out[$r['timetableId'] . '|' . $r['scheduledDate']] = $r;
    }
    return $out;
}

/**
 * One day's classes: every timetable row for that weekday in the caller's
 * scope, each overlaid with its saved record (or a Pending placeholder).
 */
function tc_day_rows(array $c, string $date): array
{
    $weekday = tc_weekday($date);
    $recs = tc_records($date, $date);
    $fac = tc_faculty_map();
    $today = tc_today();
    $nowMin = tc_now_minutes();
    $rows = [];
    foreach (tc_timetable() as $tt) {
        if ((string) $tt['day'] !== $weekday || !tc_tt_in_scope($c, $tt)) {
            continue;
        }
        $rows[] = tc_present($tt, $recs[$tt['id'] . '|' . $date] ?? null, $date, $fac, $today, $nowMin);
    }
    usort($rows, fn($a, $b) => strcmp($a['scheduledStart'] . $a['subject'], $b['scheduledStart'] . $b['subject']));
    return $rows;
}

/** the shape the browser gets for one class line */
function tc_present(array $tt, ?array $rec, string $date, array $fac, string $today, int $nowMin): array
{
    $course = $tt['course'] ?? null;
    $schedF = (string) $tt['scheduledFacultyId'];
    $o = [
        'timetableId' => (string) $tt['id'], 'recordId' => $rec ? (string) $rec['id'] : '', 'date' => $date,
        'day' => (string) $tt['day'], 'period' => $tt['period'],
        'courseId' => (string) $tt['courseId'],
        'subject' => $course ? (string) $course['name'] : '(removed course)',
        'subjectCode' => $course ? (string) $course['code'] : '',
        'course' => $course ? (string) ($course['branch'] ?: '') : (string) ($tt['branch'] ?? ''),
        'branchName' => (string) ($tt['branchName'] ?? ''),
        'semester' => (string) ($tt['semester'] ?? ($course['semester'] ?? '')),
        'section' => (string) ($tt['section'] ?? ($course['section'] ?? '')),
        'room' => (string) ($tt['room'] ?? ''),
        'scheduledFacultyId' => $schedF,
        'scheduledFaculty' => $schedF !== '' ? (string) ($fac[$schedF]['name'] ?? '(unassigned)') : '(unassigned)',
        'scheduledStart' => (string) $tt['startTime'], 'scheduledEnd' => (string) $tt['endTime'],
    ];
    if (!$rec) {
        // nothing recorded yet — a placeholder the coordinator fills in
        $future = $date > $today || ($date === $today && tc_time_min((string) $tt['startTime']) !== null && tc_time_min((string) $tt['startTime']) > $nowMin);
        $o += ['status' => 'Pending', 'recorded' => false, 'isSubstitute' => false, 'actualFacultyId' => '',
               'actualFaculty' => '', 'actualStart' => '', 'actualEnd' => '', 'reason' => '', 'topic' => '',
               'method' => '', 'remarks' => '', 'scheduledMinutes' => 0, 'actualMinutes' => 0, 'lateMinutes' => 0,
               'earlyMinutes' => 0, 'shortfallMinutes' => 0, 'rescheduledDate' => '', 'rescheduledStart' => '',
               'rescheduledEnd' => '', 'updatedByName' => '', 'updatedAt' => '',
               'displayStatus' => $future ? 'Scheduled' : 'Pending'];
        $o['scheduledMinutes'] = (tc_time_min($o['scheduledStart']) !== null && tc_time_min($o['scheduledEnd']) !== null)
            ? max(0, (tc_time_min($o['scheduledEnd']) - tc_time_min($o['scheduledStart']))) : 0;
        return $o;
    }
    $actF = (string) $rec['actualFacultyId'];
    $o += [
        'status' => (string) $rec['status'], 'recorded' => true, 'isSubstitute' => (int) $rec['isSubstitute'] === 1,
        'actualFacultyId' => $actF, 'actualFaculty' => $actF !== '' ? (string) ($fac[$actF]['name'] ?? '') : '',
        'actualStart' => (string) $rec['actualStart'], 'actualEnd' => (string) $rec['actualEnd'],
        'reason' => (string) $rec['reason'], 'topic' => (string) $rec['topic'], 'method' => (string) $rec['method'],
        'remarks' => (string) $rec['remarks'],
        'scheduledMinutes' => (int) $rec['scheduledMinutes'], 'actualMinutes' => (int) $rec['actualMinutes'],
        'lateMinutes' => (int) $rec['lateMinutes'], 'earlyMinutes' => (int) $rec['earlyMinutes'],
        'shortfallMinutes' => (int) $rec['shortfallMinutes'],
        'rescheduledDate' => (string) $rec['rescheduledDate'], 'rescheduledStart' => (string) $rec['rescheduledStart'],
        'rescheduledEnd' => (string) $rec['rescheduledEnd'],
        'updatedByName' => (string) $rec['updatedByName'], 'updatedAt' => (string) $rec['updatedAt'],
    ];
    $o['displayStatus'] = ((int) $rec['isSubstitute'] === 1 && $rec['status'] === 'Completed') ? 'Substitute' : (string) $rec['status'];
    return $o;
}

/* ---------------------------------------------------- scheduled workload */

/**
 * How many classes each faculty was timetabled for across [from,to], by
 * expanding the timetable over the weekdays in the range. The master-source
 * scheduled count — independent of whether anything was recorded.
 * Returns [facultyId => count] and the grand total.
 */
function tc_scheduled_counts(array $c, string $from, string $to): array
{
    $byFaculty = [];
    $total = 0;
    // group timetable rows (in scope) by weekday
    $byDay = [];
    foreach (tc_timetable() as $tt) {
        if (!tc_tt_in_scope($c, $tt)) {
            continue;
        }
        $byDay[(string) $tt['day']][] = $tt;
    }
    $cursor = new DateTime($from, tc_tz());
    $end = new DateTime($to, tc_tz());
    $guard = 0;
    while ($cursor <= $end && $guard++ < TC_MAX_RANGE_DAYS + 2) {
        $wd = TC_DAYS[(int) $cursor->format('w')];
        foreach ($byDay[$wd] ?? [] as $tt) {
            $f = (string) $tt['scheduledFacultyId'];
            if ($f !== '') {
                $byFaculty[$f] = ($byFaculty[$f] ?? 0) + 1;
            }
            $total++;
        }
        $cursor->modify('+1 day');
    }
    return ['byFaculty' => $byFaculty, 'total' => $total];
}

/* --------------------------------------------------------------- endpoints */

function tc_dispatch(string $method, string $resource, ?string $id): void
{
    if (!defined('TEACHING_TABLES')) {
        tc_fail('The class-attendance module is still being installed — please try again shortly.', 503, 'unavailable');
    }
    $routes = [
        'GET tc-context' => 'tc_api_context',
        'GET tc-day' => 'tc_api_day',
        'GET tc-class' => 'tc_api_class',
        'POST tc-record' => 'tc_api_record',
        'GET tc-dashboard' => 'tc_api_dashboard',
        'GET tc-faculty' => 'tc_api_faculty',
        'GET tc-faculty-detail' => 'tc_api_faculty_detail',
        'GET tc-report' => 'tc_api_report',
    ];
    $fn = $routes[$method . ' ' . $resource] ?? null;
    if ($fn === null) {
        send_json(['error' => 'not_found', 'message' => 'Unknown class-attendance request.'], 404);
    }
    $fn();
}

function tc_api_context(): void
{
    $c = tc_ctx();
    $fac = tc_faculty_map();
    // the substitute picker: active faculty only
    $subs = [];
    foreach ($fac as $id => $f) {
        if ((string) ($f['status'] ?? 'Active') !== 'Inactive') {
            $subs[] = ['id' => $id, 'empId' => (string) $f['empId'], 'name' => (string) $f['name'], 'department' => (string) $f['department']];
        }
    }
    usort($subs, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
    $depts = [];
    foreach ($fac as $f) {
        $d = trim((string) $f['department']);
        if ($d !== '') {
            $depts[$d] = true;
        }
    }
    $courses = tc_courses();
    $courseOpts = [];
    foreach ($courses as $cc) {
        if ($c['level'] === 'coord' && $c['courseScope'] !== null && !in_array((string) $cc['id'], $c['courseScope'], true)) {
            continue;
        }
        $courseOpts[] = ['id' => (string) $cc['id'], 'label' => (string) $cc['code'] . ' — ' . (string) $cc['name']];
    }
    usort($courseOpts, fn($a, $b) => strnatcasecmp($a['label'], $b['label']));
    $deptList = array_keys($depts);
    sort($deptList, SORT_NATURAL | SORT_FLAG_CASE);
    send_json([
        'level' => $c['level'], 'write' => $c['write'], 'manage' => $c['manage'], 'facultyId' => $c['facultyId'],
        'dept' => $c['dept'], 'today' => tc_today(),
        'substitutes' => $c['write'] ? $subs : [], 'departments' => $deptList, 'courses' => $courseOpts,
        'lists' => ['statuses' => TC_STATUSES, 'methods' => TC_METHODS, 'ncReasons' => TC_NC_REASONS,
                    'subReasons' => TC_SUB_REASONS],
    ]);
}

function tc_api_day(): void
{
    $c = tc_ctx();
    $date = tc_date(tc_q('date')) ?: tc_today();
    $rows = tc_day_rows($c, $date);
    // search / status filter on the day view
    $q = strtolower(tc_q('q'));
    $status = tc_q('status');
    $rows = array_values(array_filter($rows, function ($r) use ($q, $status) {
        if ($status !== '' && $r['displayStatus'] !== $status && $r['status'] !== $status) {
            return false;
        }
        if ($q !== '' && strpos(strtolower($r['subject'] . ' ' . $r['subjectCode'] . ' ' . $r['scheduledFaculty'] . ' '
            . $r['actualFaculty'] . ' ' . $r['room'] . ' ' . $r['section']), $q) === false) {
            return false;
        }
        return true;
    }));
    $counts = ['Pending' => 0, 'Ongoing' => 0, 'Completed' => 0, 'Substitute' => 0, 'Not Conducted' => 0, 'Cancelled' => 0, 'Rescheduled' => 0, 'total' => count($rows)];
    foreach ($rows as $r) {
        $key = $r['displayStatus'] === 'Scheduled' ? 'Pending' : $r['displayStatus'];
        if (isset($counts[$key])) {
            $counts[$key]++;
        }
    }
    send_json(['date' => $date, 'weekday' => tc_weekday($date), 'rows' => $rows, 'counts' => $counts]);
}

/** one class with its change history */
function tc_api_class(): void
{
    $c = tc_ctx();
    $ttId = tc_q('timetableId');
    $date = tc_date(tc_q('date'));
    if ($ttId === '' || $date === '') {
        tc_fail('A class and a date are required.');
    }
    $tt = null;
    foreach (tc_timetable() as $row) {
        if ((string) $row['id'] === $ttId) {
            $tt = $row;
            break;
        }
    }
    if (!$tt || !tc_tt_in_scope($c, $tt)) {
        tc_fail('This class is not in your scope.', 403, 'forbidden');
    }
    $rec = fetch_one('SELECT * FROM ' . qi('classattendance') . ' WHERE ' . qi('timetableId') . ' = ? AND ' . qi('scheduledDate') . ' = ?', [$ttId, $date]);
    $line = tc_present($tt, $rec, $date, tc_faculty_map(), tc_today(), tc_now_minutes());
    $history = [];
    if ($rec) {
        foreach (fetch_all('SELECT * FROM ' . qi('classattendancelog') . ' WHERE ' . qi('recordId') . ' = ? ORDER BY ' . qi('at') . ' DESC', [(string) $rec['id']]) as $h) {
            $history[] = ['action' => (string) $h['action'], 'summary' => (string) $h['summary'],
                          'byName' => (string) $h['byName'], 'at' => (string) $h['at'], 'reason' => (string) $h['reason']];
        }
    }
    $line['canWrite'] = $c['write'];
    $line['history'] = $history;
    send_json($line);
}

/**
 * Record (or correct) one class. The timetable supplies the scheduled faculty
 * and times; the coordinator supplies what actually happened. The scheduled
 * faculty is NEVER overwritten.
 */
function tc_api_record(): void
{
    $c = tc_ctx();
    tc_require_write($c);
    $b = body();
    $ttId = tc_str($b['timetableId'] ?? '', 64);
    $date = tc_date($b['date'] ?? '');
    if ($ttId === '' || $date === '') {
        tc_fail('A class and a date are required.');
    }
    $tt = null;
    foreach (tc_timetable() as $row) {
        if ((string) $row['id'] === $ttId) {
            $tt = $row;
            break;
        }
    }
    if (!$tt) {
        tc_fail('That class is not on the timetable.', 404, 'not_found');
    }
    if (!tc_tt_in_scope($c, $tt)) {
        tc_fail('You can record classes only within your assigned scope.', 403, 'forbidden');
    }
    $weekday = tc_weekday($date);
    if ((string) $tt['day'] !== $weekday) {
        tc_fail('That class is scheduled on ' . $tt['day'] . ', not on ' . $date . ' (' . $weekday . ').');
    }
    if ($date > tc_today()) {
        tc_fail('You cannot record a class in the future.');
    }
    $status = tc_pick($b['status'] ?? '', TC_STATUSES);
    if ($status === '') {
        tc_fail('Choose a class status.');
    }
    $schedF = (string) $tt['scheduledFacultyId'];
    $fac = tc_faculty_map();
    $existing = fetch_one('SELECT * FROM ' . qi('classattendance') . ' WHERE ' . qi('timetableId') . ' = ? AND ' . qi('scheduledDate') . ' = ?', [$ttId, $date]);

    $row = [
        'id' => $existing ? (string) $existing['id'] : tc_id('CA'),
        'timetableId' => $ttId, 'scheduledDate' => $date, 'day' => $weekday,
        'courseId' => (string) $tt['courseId'], 'scheduledFacultyId' => $schedF,
        'scheduledStart' => (string) $tt['startTime'], 'scheduledEnd' => (string) $tt['endTime'],
        'actualFacultyId' => '', 'isSubstitute' => '0', 'reason' => '',
        'actualStart' => '', 'actualEnd' => '', 'rescheduledDate' => '', 'rescheduledStart' => '', 'rescheduledEnd' => '',
        'topic' => tc_str($b['topic'] ?? '', 255), 'method' => tc_pick($b['method'] ?? '', TC_METHODS, ''),
        'remarks' => tc_str($b['remarks'] ?? '', 2000), 'status' => $status,
        'createdBy' => $existing ? (string) $existing['createdBy'] : $c['userId'],
        'createdByName' => $existing ? (string) $existing['createdByName'] : $c['name'],
        'createdAt' => $existing ? (string) $existing['createdAt'] : tc_now(),
        'updatedBy' => $c['userId'], 'updatedByName' => $c['name'], 'updatedAt' => tc_now(),
    ];

    $conducted = !empty($b['conducted']);   // did the scheduled faculty take it?
    if (in_array($status, ['Completed', 'Ongoing'], true)) {
        $as = tc_time_min($b['actualStart'] ?? '');
        if ($as === null) {
            tc_fail('Enter the actual start time.');
        }
        $ae = tc_time_min($b['actualEnd'] ?? '');
        if ($status === 'Completed' && $ae === null) {
            tc_fail('Enter the actual end time.');
        }
        if ($ae !== null && $ae <= $as) {
            tc_fail('The end time must be after the start time.');
        }
        $row['actualStart'] = tc_time_str($as);
        $row['actualEnd'] = tc_time_str($ae);
        if ($conducted) {
            if ($schedF === '') {
                tc_fail('This class has no scheduled faculty on the timetable — record a substitute instead.');
            }
            $row['actualFacultyId'] = $schedF;
            $row['isSubstitute'] = '0';
        } else {
            $sub = tc_str($b['substituteFacultyId'] ?? '', 64);
            if ($sub === '' || !isset($fac[$sub])) {
                tc_fail('Choose the substitute faculty who conducted the class.');
            }
            if ($sub === $schedF) {
                tc_fail('The substitute is the same as the scheduled faculty — mark the class as conducted instead.');
            }
            $reason = tc_pick($b['reason'] ?? '', TC_SUB_REASONS, '');
            if ($reason === '') {
                tc_fail('Give the reason the scheduled faculty did not conduct the class.');
            }
            $row['actualFacultyId'] = $sub;
            $row['isSubstitute'] = '1';
            $row['reason'] = $reason;
        }
    } elseif ($status === 'Not Conducted' || $status === 'Cancelled') {
        $reason = tc_pick($b['reason'] ?? '', TC_NC_REASONS, '');
        if ($reason === '') {
            tc_fail('A reason is required when a class is not conducted.');
        }
        $row['reason'] = $reason;
        // no actual faculty, no times
    } elseif ($status === 'Rescheduled') {
        $rd = tc_date($b['rescheduledDate'] ?? '');
        if ($rd === '') {
            tc_fail('Give the new date the class is rescheduled to.');
        }
        $reason = tc_str($b['reason'] ?? '', 120);
        $row['rescheduledDate'] = $rd;
        $row['rescheduledStart'] = tc_time_str(tc_time_min($b['rescheduledStart'] ?? ''));
        $row['rescheduledEnd'] = tc_time_str(tc_time_min($b['rescheduledEnd'] ?? ''));
        $row['reason'] = $reason;
    } elseif ($status === 'Pending') {
        tc_fail('Pending is the default — choose what actually happened.');
    }
    tc_compute($row);
    $row['scheduledMinutes'] = (string) $row['scheduledMinutes'];
    $row['actualMinutes'] = (string) $row['actualMinutes'];
    $row['lateMinutes'] = (string) $row['lateMinutes'];
    $row['earlyMinutes'] = (string) $row['earlyMinutes'];
    $row['shortfallMinutes'] = (string) $row['shortfallMinutes'];

    upsert('classattendance', $row);

    // audit: what changed, in words
    $course = $tt['course'] ?? null;
    $subj = $course ? (string) $course['name'] : $ttId;
    $who = $row['isSubstitute'] === '1'
        ? ('substitute ' . ($fac[$row['actualFacultyId']]['name'] ?? '?') . ' for ' . ($fac[$schedF]['name'] ?? '?'))
        : ($row['actualFacultyId'] !== '' ? (string) ($fac[$row['actualFacultyId']]['name'] ?? '') : 'not conducted');
    $summary = "$subj ($date) — " . ($row['isSubstitute'] === '1' ? 'Substitute' : $status)
        . ($who ? ' · ' . $who : '') . ($row['actualStart'] !== '' ? ' · ' . $row['actualStart'] . '–' . $row['actualEnd'] : '');
    $changes = tc_change_summary($existing, $row, $fac);
    $action = $existing ? 'correct' : 'record';
    upsert('classattendancelog', [
        'id' => tc_id('CL'), 'recordId' => $row['id'], 'timetableId' => $ttId, 'scheduledDate' => $date,
        'action' => $action, 'summary' => $summary, 'changes' => json_encode($changes), 'reason' => $row['reason'],
        'byId' => $c['userId'], 'byName' => $c['name'], 'at' => tc_now(),
    ]);
    audit($action === 'record' ? 'create' : 'update', 'teaching', $row['id'], $subj, $summary,
        ['timetableId' => $ttId, 'date' => $date, 'status' => $status, 'isSubstitute' => $row['isSubstitute'],
         'changes' => $changes]);

    $line = tc_present($tt, $row, $date, $fac, tc_today(), tc_now_minutes());
    send_json(['ok' => true, 'class' => $line], $existing ? 200 : 201);
}

/** a short before/after of the fields that matter, for the audit trail */
function tc_change_summary(?array $before, array $after, array $fac): array
{
    $fields = ['status' => 'Status', 'actualFacultyId' => 'Actual faculty', 'isSubstitute' => 'Substitute',
               'actualStart' => 'Actual start', 'actualEnd' => 'Actual end', 'reason' => 'Reason',
               'topic' => 'Topic', 'method' => 'Method', 'rescheduledDate' => 'Rescheduled to'];
    $name = fn($v) => $v !== '' ? (string) ($fac[$v]['name'] ?? $v) : '—';
    $out = [];
    foreach ($fields as $k => $label) {
        $old = $before[$k] ?? '';
        $new = $after[$k] ?? '';
        if ((string) $old === (string) $new) {
            continue;
        }
        if ($k === 'actualFacultyId') {
            $old = $name($old);
            $new = $name($new);
        } elseif ($k === 'isSubstitute') {
            $old = $old === '1' ? 'Yes' : 'No';
            $new = $new === '1' ? 'Yes' : 'No';
        }
        $out[$label] = ['from' => (string) $old === '' ? '—' : (string) $old, 'to' => (string) $new === '' ? '—' : (string) $new];
    }
    return $out;
}

/* --------------------------------------------------------------- dashboard */

function tc_api_dashboard(): void
{
    $c = tc_ctx();
    $date = tc_date(tc_q('date')) ?: tc_today();
    $rows = tc_day_rows($c, $date);
    $k = ['total' => count($rows), 'completed' => 0, 'pending' => 0, 'ongoing' => 0, 'notConducted' => 0,
          'substitute' => 0, 'cancelled' => 0, 'rescheduled' => 0, 'scheduledMin' => 0, 'actualMin' => 0,
          'shortfallMin' => 0, 'lateStarts' => 0, 'earlyFinishes' => 0, 'facultyNotConducted' => 0];
    $subList = [];
    $ncList = [];
    foreach ($rows as $r) {
        $k['scheduledMin'] += $r['scheduledMinutes'];
        $k['actualMin'] += $r['actualMinutes'];
        $k['shortfallMin'] += $r['shortfallMinutes'];
        if ($r['lateMinutes'] > 0) {
            $k['lateStarts']++;
        }
        if ($r['earlyMinutes'] > 0) {
            $k['earlyFinishes']++;
        }
        if ($r['isSubstitute']) {
            $k['substitute']++;
            $k['facultyNotConducted']++;
            $subList[] = ['subject' => $r['subject'], 'scheduledFaculty' => $r['scheduledFaculty'],
                          'actualFaculty' => $r['actualFaculty'], 'time' => $r['actualStart'] . '–' . $r['actualEnd'],
                          'scheduled' => $r['scheduledStart'] . '–' . $r['scheduledEnd'], 'reason' => $r['reason'],
                          'section' => $r['section'], 'room' => $r['room']];
        }
        $ds = $r['displayStatus'];
        if ($ds === 'Completed') {
            $k['completed']++;
        } elseif ($ds === 'Ongoing') {
            $k['ongoing']++;
        } elseif ($ds === 'Not Conducted') {
            $k['notConducted']++;
            $k['facultyNotConducted']++;
            $ncList[] = ['subject' => $r['subject'], 'scheduledFaculty' => $r['scheduledFaculty'],
                         'reason' => $r['reason'], 'time' => $r['scheduledStart'] . '–' . $r['scheduledEnd'], 'section' => $r['section']];
        } elseif ($ds === 'Cancelled') {
            $k['cancelled']++;
        } elseif ($ds === 'Rescheduled') {
            $k['rescheduled']++;
        } elseif ($ds === 'Substitute') {
            // a substitute class is a conducted class — already counted under 'substitute'
        } else {
            $k['pending']++;   // Pending / Scheduled
        }
    }
    send_json(['date' => $date, 'weekday' => tc_weekday($date), 'kpi' => $k, 'substitutes' => $subList,
               'notConducted' => $ncList]);
}

/* ----------------------------------------------------- faculty workload */

/**
 * Faculty teaching activity over a range: scheduled (from the timetable),
 * regular conducted, substitute taken, not conducted, and shortfall. The
 * substitute's classes count for the substitute; the original faculty's
 * un-conducted classes are never shown as conducted by them.
 */
function tc_faculty_metrics(array $c, string $from, string $to): array
{
    $sched = tc_scheduled_counts($c, $from, $to);
    $recs = tc_records($from, $to);
    $fac = tc_faculty_map();
    $m = [];
    $get = function ($id) use (&$m) {
        if (!isset($m[$id])) {
            $m[$id] = ['scheduled' => 0, 'conducted' => 0, 'substitute' => 0, 'notConducted' => 0, 'cancelled' => 0,
                       'scheduledMin' => 0, 'actualMin' => 0, 'shortfallMin' => 0, 'lateStarts' => 0];
        }
        return $id;
    };
    foreach ($sched['byFaculty'] as $fid => $n) {
        $m[$get($fid)]['scheduled'] = $n;
    }
    foreach ($recs as $r) {
        $schedF = (string) $r['scheduledFacultyId'];
        $actF = (string) $r['actualFacultyId'];
        $sub = (int) $r['isSubstitute'] === 1;
        $status = (string) $r['status'];
        // the substitute's own conducted workload
        if ($sub && $actF !== '' && in_array($status, ['Completed', 'Ongoing'], true)) {
            $g = $get($actF);
            $m[$g]['substitute']++;
            $m[$g]['actualMin'] += (int) $r['actualMinutes'];
            if ((int) $r['lateMinutes'] > 0) {
                $m[$g]['lateStarts']++;
            }
        }
        if ($schedF === '') {
            continue;
        }
        $g = $get($schedF);
        if (!$sub && in_array($status, ['Completed', 'Ongoing'], true)) {
            $m[$g]['conducted']++;
            $m[$g]['actualMin'] += (int) $r['actualMinutes'];
            $m[$g]['shortfallMin'] += (int) $r['shortfallMinutes'];
            if ((int) $r['lateMinutes'] > 0) {
                $m[$g]['lateStarts']++;
            }
        } elseif ($sub) {
            // scheduled faculty did not conduct it — a substitute did
            $m[$g]['notConducted']++;
        } elseif ($status === 'Not Conducted') {
            $m[$g]['notConducted']++;
        } elseif ($status === 'Cancelled') {
            $m[$g]['cancelled']++;
        }
    }
    $rows = [];
    foreach ($m as $fid => $v) {
        $f = $fac[$fid] ?? null;
        if (!$f && $v['scheduled'] === 0 && $v['conducted'] === 0 && $v['substitute'] === 0) {
            continue;
        }
        $v['id'] = $fid;
        $v['empId'] = (string) ($f['empId'] ?? '');
        $v['name'] = (string) ($f['name'] ?? '(removed faculty)');
        $v['department'] = (string) ($f['department'] ?? '');
        $v['designation'] = (string) ($f['designation'] ?? '');
        $v['totalConducted'] = $v['conducted'] + $v['substitute'];
        $v['scheduledHours'] = round($v['scheduledMin'] / 60, 1);
        $v['actualHours'] = round($v['actualMin'] / 60, 1);
        $v['shortfallHours'] = round($v['shortfallMin'] / 60, 1);
        $v['completion'] = $v['scheduled'] > 0 ? round($v['conducted'] / $v['scheduled'] * 100, 1) : 0;
        // the scheduled minutes a timetable gives this faculty: from the expansion, so use scheduled × avg slot? keep from records where known
        $rows[] = $v;
    }
    // scheduled hours from the timetable expansion (slot length × count) — recompute precisely
    tc_fill_scheduled_hours($c, $from, $to, $rows);
    return $rows;
}

/** scheduled teaching hours per faculty = sum of slot lengths over the range */
function tc_fill_scheduled_hours(array $c, string $from, string $to, array &$rows): void
{
    $byDayMin = [];   // facultyId => total scheduled minutes per weekday occurrence
    $byDay = [];
    foreach (tc_timetable() as $tt) {
        if (!tc_tt_in_scope($c, $tt)) {
            continue;
        }
        $byDay[(string) $tt['day']][] = $tt;
    }
    $mins = [];
    $cursor = new DateTime($from, tc_tz());
    $end = new DateTime($to, tc_tz());
    $guard = 0;
    while ($cursor <= $end && $guard++ < TC_MAX_RANGE_DAYS + 2) {
        $wd = TC_DAYS[(int) $cursor->format('w')];
        foreach ($byDay[$wd] ?? [] as $tt) {
            $f = (string) $tt['scheduledFacultyId'];
            $s = tc_time_min((string) $tt['startTime']);
            $e = tc_time_min((string) $tt['endTime']);
            $len = ($s !== null && $e !== null && $e > $s) ? $e - $s : 0;
            if ($f !== '') {
                $mins[$f] = ($mins[$f] ?? 0) + $len;
            }
        }
        $cursor->modify('+1 day');
    }
    foreach ($rows as &$r) {
        $r['scheduledHours'] = round(($mins[$r['id']] ?? 0) / 60, 1);
    }
    unset($r);
}

function tc_api_faculty(): void
{
    $c = tc_ctx();
    if ($c['level'] === 'own') {
        tc_fail('The faculty workload list is for coordinators, heads of department and administrators.', 403, 'forbidden');
    }
    $to = tc_date(tc_q('to')) ?: tc_today();
    $from = tc_date(tc_q('from')) ?: date('Y-m-d', strtotime($to . ' -30 days'));
    if (strtotime($to) - strtotime($from) > TC_MAX_RANGE_DAYS * 86400) {
        tc_fail('Choose a date range of at most ' . TC_MAX_RANGE_DAYS . ' days.');
    }
    $rows = tc_faculty_metrics($c, $from, $to);
    $q = strtolower(tc_q('q'));
    $dept = tc_q('department');
    $rows = array_values(array_filter($rows, fn($r) => ($q === '' || strpos(strtolower($r['name'] . ' ' . $r['empId'] . ' ' . $r['department']), $q) !== false)
        && ($dept === '' || strcasecmp($r['department'], $dept) === 0)
        && ($r['scheduled'] > 0 || $r['totalConducted'] > 0)));
    $rows = tc_sort($rows, ['name', 'empId', 'department', 'scheduled', 'conducted', 'substitute', 'notConducted',
        'totalConducted', 'completion', 'shortfallHours'], 'name');
    send_json(tc_page($rows) + ['from' => $from, 'to' => $to]);
}

function tc_api_faculty_detail(): void
{
    $c = tc_ctx();
    $fid = tc_q('id') ?: $c['facultyId'];
    if ($c['level'] === 'own' && $fid !== $c['facultyId']) {
        tc_fail('You can view only your own teaching activity.', 403, 'forbidden');
    }
    $to = tc_date(tc_q('to')) ?: tc_today();
    $from = tc_date(tc_q('from')) ?: date('Y-m-d', strtotime($to . ' -90 days'));
    $all = tc_faculty_metrics(['level' => 'all', 'courseScope' => null, 'deptBranches' => [], 'facultyId' => ''], $from, $to);
    $m = null;
    foreach ($all as $r) {
        if ($r['id'] === $fid) {
            $m = $r;
            break;
        }
    }
    $fac = tc_faculty_map();
    $f = $fac[$fid] ?? [];
    if (!$m) {
        $m = ['id' => $fid, 'name' => (string) ($f['name'] ?? ''), 'scheduled' => 0, 'conducted' => 0, 'substitute' => 0,
              'notConducted' => 0, 'cancelled' => 0, 'totalConducted' => 0, 'scheduledHours' => 0, 'actualHours' => 0,
              'shortfallHours' => 0, 'completion' => 0];
    }
    // recent classes involving this faculty (scheduled or substitute)
    $recs = tc_records($from, $to);
    $tt = [];
    foreach (tc_timetable() as $row) {
        $tt[(string) $row['id']] = $row;
    }
    $courses = tc_courses();
    $recent = [];
    foreach ($recs as $r) {
        $isSched = (string) $r['scheduledFacultyId'] === $fid;
        $isAct = (string) $r['actualFacultyId'] === $fid;
        if (!$isSched && !$isAct) {
            continue;
        }
        $course = $courses[(string) $r['courseId']] ?? null;
        $recent[] = ['date' => (string) $r['scheduledDate'], 'subject' => $course ? (string) $course['name'] : '',
            'role' => $isAct && (int) $r['isSubstitute'] === 1 ? 'Substitute' : ($isSched && (int) $r['isSubstitute'] === 1 ? 'Not conducted (substituted)' : ($isSched ? 'Regular' : 'Substitute')),
            'status' => (string) $r['status'], 'isSubstitute' => (int) $r['isSubstitute'] === 1,
            'actualStart' => (string) $r['actualStart'], 'actualEnd' => (string) $r['actualEnd'],
            'reason' => (string) $r['reason'], 'topic' => (string) $r['topic'], 'shortfall' => (int) $r['shortfallMinutes']];
    }
    usort($recent, fn($a, $b) => strcmp($b['date'], $a['date']));
    send_json(['faculty' => ['id' => $fid, 'name' => (string) ($f['name'] ?? ''), 'empId' => (string) ($f['empId'] ?? ''),
        'department' => (string) ($f['department'] ?? ''), 'designation' => (string) ($f['designation'] ?? '')],
        'metrics' => $m, 'recent' => array_slice($recent, 0, 100), 'from' => $from, 'to' => $to,
        'canView' => true]);
}

/* ------------------------------------------------------------- list tools */

function tc_sort(array $rows, array $keys, string $default, string $defaultDir = 'asc'): array
{
    $key = tc_q('sort', $default);
    if (!in_array($key, $keys, true)) {
        $key = $default;
    }
    $dir = tc_q('dir', $defaultDir) === 'desc' ? -1 : 1;
    usort($rows, function ($a, $b) use ($key, $dir) {
        $x = $a[$key] ?? null;
        $y = $b[$key] ?? null;
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
function tc_page(array $rows): array
{
    $total = count($rows);
    if (tc_q('export') === '1') {
        return ['rows' => array_slice($rows, 0, 10000), 'total' => $total, 'page' => 1, 'pages' => 1, 'size' => $total];
    }
    $size = max(5, min(100, (int) tc_q('size', '25')));
    $pages = max(1, (int) ceil($total / $size));
    $page = max(1, min($pages, (int) tc_q('page', '1')));
    return ['rows' => array_slice($rows, ($page - 1) * $size, $size), 'total' => $total, 'page' => $page, 'pages' => $pages, 'size' => $size];
}

/* --------------------------------------------------------------- reports */

/** every recorded class in a range, decorated for the record-level reports */
function tc_report_records(array $c, string $from, string $to): array
{
    $recs = tc_records($from, $to);
    $courses = tc_courses();
    $fac = tc_faculty_map();
    $tt = [];
    foreach (tc_timetable() as $row) {
        $tt[(string) $row['id']] = $row;
    }
    $out = [];
    foreach ($recs as $r) {
        $ttRow = $tt[(string) $r['timetableId']] ?? null;
        if ($ttRow && !tc_tt_in_scope($c, $ttRow)) {
            continue;
        }
        if ($c['level'] === 'own' && (string) $r['scheduledFacultyId'] !== $c['facultyId'] && (string) $r['actualFacultyId'] !== $c['facultyId']) {
            continue;
        }
        $course = $courses[(string) $r['courseId']] ?? null;
        $schedF = (string) $r['scheduledFacultyId'];
        $actF = (string) $r['actualFacultyId'];
        $sub = (int) $r['isSubstitute'] === 1;
        $out[] = [
            'date' => (string) $r['scheduledDate'], 'day' => (string) $r['day'],
            'subject' => $course ? (string) $course['name'] : '', 'subjectCode' => $course ? (string) $course['code'] : '',
            'course' => $course ? (string) $course['branch'] : (string) ($ttRow['branch'] ?? ''),
            'semester' => (string) ($ttRow['semester'] ?? ($course['semester'] ?? '')),
            'section' => (string) ($ttRow['section'] ?? ($course['section'] ?? '')), 'room' => (string) ($ttRow['room'] ?? ''),
            'scheduledFaculty' => $schedF !== '' ? (string) ($fac[$schedF]['name'] ?? '') : '',
            'scheduledFacultyDept' => $schedF !== '' ? (string) ($fac[$schedF]['department'] ?? '') : '',
            'actualFaculty' => $actF !== '' ? (string) ($fac[$actF]['name'] ?? '') : '',
            'isSubstitute' => $sub, 'substitute' => $sub ? 'Yes' : 'No', 'reason' => (string) $r['reason'],
            'scheduledTime' => (string) $r['scheduledStart'] . '–' . (string) $r['scheduledEnd'],
            'actualTime' => $r['actualStart'] !== '' ? (string) $r['actualStart'] . '–' . (string) $r['actualEnd'] : '',
            'scheduledMinutes' => (int) $r['scheduledMinutes'], 'actualMinutes' => (int) $r['actualMinutes'],
            'lateMinutes' => (int) $r['lateMinutes'], 'earlyMinutes' => (int) $r['earlyMinutes'],
            'shortfallMinutes' => (int) $r['shortfallMinutes'], 'status' => (string) $r['status'],
            'displayStatus' => ($sub && (string) $r['status'] === 'Completed') ? 'Substitute' : (string) $r['status'],
            'topic' => (string) $r['topic'], 'method' => (string) $r['method'], 'remarks' => (string) $r['remarks'],
            'rescheduledDate' => (string) $r['rescheduledDate'],
            'rescheduledTime' => $r['rescheduledStart'] !== '' ? (string) $r['rescheduledStart'] . '–' . (string) $r['rescheduledEnd'] : '',
            'updatedBy' => (string) $r['updatedByName'], 'updatedAt' => substr((string) $r['updatedAt'], 0, 10),
        ];
    }
    usort($out, fn($a, $b) => strcmp($b['date'] . $b['scheduledTime'], $a['date'] . $a['scheduledTime']));
    return $out;
}

function tc_api_report(): void
{
    $c = tc_ctx();
    $type = tc_q('type');
    $to = tc_date(tc_q('to')) ?: tc_today();
    $from = tc_date(tc_q('from')) ?: date('Y-m-d', strtotime($to . ' -30 days'));
    if (strtotime($to) - strtotime($from) > TC_MAX_RANGE_DAYS * 86400) {
        tc_fail('Choose a date range of at most ' . TC_MAX_RANGE_DAYS . ' days.');
    }
    $col = fn($h, $k, $w = 16) => ['header' => $h, 'key' => $k, 'width' => $w];
    $q = strtolower(tc_q('q'));
    $dept = tc_q('department');
    $facId = tc_q('facultyId');
    $courseId = tc_q('courseId');
    $hhmm = fn($min) => $min > 0 ? intdiv($min, 60) . 'h ' . ($min % 60) . 'm' : '—';

    if (in_array($type, ['faculty', 'performance'], true)) {
        if ($c['level'] === 'own') {
            tc_fail('This report is for coordinators, heads of department and administrators.', 403, 'forbidden');
        }
        $rows = tc_faculty_metrics($c, $from, $to);
        $rows = array_values(array_filter($rows, fn($r) => ($r['scheduled'] > 0 || $r['totalConducted'] > 0)
            && ($dept === '' || strcasecmp($r['department'], $dept) === 0)
            && ($q === '' || strpos(strtolower($r['name'] . ' ' . $r['empId'] . ' ' . $r['department']), $q) !== false)));
        foreach ($rows as &$r) {
            $r['completionText'] = $r['completion'] . '%';
        }
        unset($r);
        usort($rows, fn($a, $b) => strnatcasecmp($a['name'], $b['name']));
        $title = $type === 'performance' ? 'Faculty Performance Report' : 'Faculty Teaching Report';
        $cols = [$col('Emp ID', 'empId', 12), $col('Faculty', 'name', 22), $col('Department', 'department', 16),
            $col('Scheduled', 'scheduled', 10), $col('Regular Conducted', 'conducted', 14), $col('Substitute Taken', 'substitute', 14),
            $col('Not Conducted', 'notConducted', 13), $col('Cancelled', 'cancelled', 10), $col('Total Conducted', 'totalConducted', 13),
            $col('Scheduled Hrs', 'scheduledHours', 12), $col('Actual Hrs', 'actualHours', 11), $col('Shortfall Hrs', 'shortfallHours', 12),
            $col('Completion %', 'completionText', 12)];
        send_json(['title' => $title, 'columns' => $cols, 'rows' => array_slice($rows, 0, 10000), 'total' => count($rows), 'from' => $from, 'to' => $to]);
    }

    $recs = tc_report_records($c, $from, $to);
    $recs = array_values(array_filter($recs, fn($r) => ($facId === '' || $r['scheduledFaculty'] === tc_faculty_name($facId) || $r['actualFaculty'] === tc_faculty_name($facId))
        && ($dept === '' || strcasecmp($r['scheduledFacultyDept'], $dept) === 0)
        && ($q === '' || strpos(strtolower($r['subject'] . ' ' . $r['scheduledFaculty'] . ' ' . $r['actualFaculty'] . ' ' . $r['topic'] . ' ' . $r['reason'] . ' ' . $r['section']), $q) !== false)));

    switch ($type) {
        case 'daily':
            $rows = $recs;
            $title = 'Daily Teaching Activity Report';
            $cols = [$col('Date', 'date', 12), $col('Subject', 'subject', 22), $col('Sem', 'semester', 6), $col('Sec', 'section', 6),
                $col('Room', 'room', 8), $col('Scheduled Faculty', 'scheduledFaculty', 20), $col('Actual Faculty', 'actualFaculty', 20),
                $col('Substitute', 'substitute', 10), $col('Scheduled', 'scheduledTime', 13), $col('Actual', 'actualTime', 13),
                $col('Status', 'displayStatus', 14), $col('Topic', 'topic', 24)];
            break;
        case 'substitute':
            $rows = array_values(array_filter($recs, fn($r) => $r['isSubstitute']));
            $title = 'Substitute Teaching Report';
            $cols = [$col('Date', 'date', 12), $col('Subject', 'subject', 22), $col('Original Faculty', 'scheduledFaculty', 20),
                $col('Substitute Faculty', 'actualFaculty', 20), $col('Sem', 'semester', 6), $col('Sec', 'section', 6),
                $col('Scheduled', 'scheduledTime', 13), $col('Actual', 'actualTime', 13), $col('Duration (min)', 'actualMinutes', 12),
                $col('Reason', 'reason', 16), $col('Topic', 'topic', 22)];
            break;
        case 'notconducted':
            $rows = array_values(array_filter($recs, fn($r) => $r['status'] === 'Not Conducted' || $r['status'] === 'Cancelled'));
            $title = 'Non-Conducted Class Report';
            $cols = [$col('Date', 'date', 12), $col('Subject', 'subject', 22), $col('Scheduled Faculty', 'scheduledFaculty', 20),
                $col('Sem', 'semester', 6), $col('Sec', 'section', 6), $col('Scheduled', 'scheduledTime', 13),
                $col('Status', 'status', 14), $col('Reason', 'reason', 18), $col('Recorded By', 'updatedBy', 18)];
            break;
        case 'shortfall':
            $rows = array_values(array_filter($recs, fn($r) => $r['shortfallMinutes'] > 0));
            usort($rows, fn($a, $b) => $b['shortfallMinutes'] <=> $a['shortfallMinutes']);
            $title = 'Teaching Shortfall Report';
            $cols = [$col('Date', 'date', 12), $col('Subject', 'subject', 22), $col('Faculty', 'actualFaculty', 20),
                $col('Sem', 'semester', 6), $col('Sec', 'section', 6), $col('Scheduled', 'scheduledTime', 13), $col('Actual', 'actualTime', 13),
                $col('Scheduled (min)', 'scheduledMinutes', 13), $col('Actual (min)', 'actualMinutes', 12),
                $col('Late (min)', 'lateMinutes', 10), $col('Early (min)', 'earlyMinutes', 11), $col('Shortfall (min)', 'shortfallMinutes', 13)];
            break;
        case 'late':
            $rows = array_values(array_filter($recs, fn($r) => $r['lateMinutes'] > 0));
            usort($rows, fn($a, $b) => $b['lateMinutes'] <=> $a['lateMinutes']);
            $title = 'Late Start Report';
            $cols = [$col('Date', 'date', 12), $col('Subject', 'subject', 22), $col('Faculty', 'actualFaculty', 20),
                $col('Sem', 'semester', 6), $col('Sec', 'section', 6), $col('Scheduled Start', 'scheduledTime', 13),
                $col('Actual', 'actualTime', 13), $col('Late (min)', 'lateMinutes', 10)];
            break;
        case 'early':
            $rows = array_values(array_filter($recs, fn($r) => $r['earlyMinutes'] > 0));
            usort($rows, fn($a, $b) => $b['earlyMinutes'] <=> $a['earlyMinutes']);
            $title = 'Early Finish Report';
            $cols = [$col('Date', 'date', 12), $col('Subject', 'subject', 22), $col('Faculty', 'actualFaculty', 20),
                $col('Sem', 'semester', 6), $col('Sec', 'section', 6), $col('Scheduled End', 'scheduledTime', 13),
                $col('Actual', 'actualTime', 13), $col('Early (min)', 'earlyMinutes', 11)];
            break;
        case 'rescheduled':
            $rows = array_values(array_filter($recs, fn($r) => $r['status'] === 'Rescheduled'));
            $title = 'Rescheduled Class Report';
            $cols = [$col('Original Date', 'date', 13), $col('Subject', 'subject', 22), $col('Scheduled Faculty', 'scheduledFaculty', 20),
                $col('Sem', 'semester', 6), $col('Sec', 'section', 6), $col('Original Time', 'scheduledTime', 13),
                $col('Rescheduled To', 'rescheduledDate', 14), $col('New Time', 'rescheduledTime', 13), $col('Reason', 'reason', 18)];
            break;
        case 'course':
            $rows = tc_group_report($recs, fn($r) => $r['subjectCode'] . '|' . $r['section'],
                fn($r) => ['group' => $r['subject'] . ' · Sem ' . $r['semester'] . ' / ' . $r['section'], 'subject' => $r['subject'],
                           'semester' => $r['semester'], 'section' => $r['section']]);
            $title = 'Course-wise Teaching Report';
            $cols = [$col('Course', 'group', 30), $col('Scheduled Faculty Classes', 'conducted', 16), $col('Substitute', 'substitute', 11),
                $col('Not Conducted', 'notConducted', 13), $col('Total Held', 'held', 11), $col('Shortfall (min)', 'shortfallMinutes', 14)];
            break;
        case 'department':
            $rows = tc_group_report($recs, fn($r) => $r['scheduledFacultyDept'] ?: '—',
                fn($r) => ['group' => $r['scheduledFacultyDept'] ?: '—']);
            $title = 'Department-wise Teaching Report';
            $cols = [$col('Department', 'group', 24), $col('Conducted', 'conducted', 11), $col('Substitute', 'substitute', 11),
                $col('Not Conducted', 'notConducted', 13), $col('Total Held', 'held', 11), $col('Shortfall (min)', 'shortfallMinutes', 14)];
            break;
        default:
            tc_fail('Unknown report.', 404, 'not_found');
            return;
    }
    send_json(['title' => $title, 'columns' => $cols, 'rows' => array_slice($rows, 0, 10000), 'total' => count($rows), 'from' => $from, 'to' => $to]);
}

function tc_faculty_name(string $id): string
{
    return (string) (tc_faculty_map()[$id]['name'] ?? '');
}

/** group record rows into per-group tallies for the course/department reports */
function tc_group_report(array $recs, callable $keyFn, callable $metaFn): array
{
    $g = [];
    foreach ($recs as $r) {
        $k = $keyFn($r);
        if (!isset($g[$k])) {
            $g[$k] = $metaFn($r) + ['conducted' => 0, 'substitute' => 0, 'notConducted' => 0, 'held' => 0, 'shortfallMinutes' => 0];
        }
        if (in_array($r['status'], ['Completed', 'Ongoing'], true)) {
            $g[$k]['held']++;
            if ($r['isSubstitute']) {
                $g[$k]['substitute']++;
            } else {
                $g[$k]['conducted']++;
            }
            $g[$k]['shortfallMinutes'] += $r['shortfallMinutes'];
        } elseif ($r['status'] === 'Not Conducted' || $r['status'] === 'Cancelled') {
            $g[$k]['notConducted']++;
        }
    }
    $rows = array_values($g);
    usort($rows, fn($a, $b) => strnatcasecmp($a['group'], $b['group']));
    return $rows;
}
