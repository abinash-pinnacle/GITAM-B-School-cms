<?php
/**
 * NMIET College Management System — backend configuration.
 *
 * Database mode is picked from the environment:
 *   sqlite (default) -> zero setup, file next to the project (nmiet.db)
 *   mysql            -> DB_BACKEND=mysql   (XAMPP / cPanel / Docker)
 *   pgsql            -> DB_BACKEND=pgsql   (docker compose setup)
 */

const BASE_DIR = __DIR__ . DIRECTORY_SEPARATOR . '..';

function env(string $key, ?string $default = null): ?string
{
    $v = getenv($key);
    if ($v === false || $v === '') {
        $v = $_SERVER[$key] ?? null;
    }
    return ($v === null || $v === '') ? $default : (string) $v;
}

/**
 * The exception message, but only when APP_DEBUG is switched on. Database
 * errors name the host and the user, so they stay out of the response until
 * someone deliberately asks for them while chasing a deploy problem.
 */
function debug_detail(Throwable $e): array
{
    return in_array(strtolower((string) env('APP_DEBUG', '')), ['1', 'true', 'yes', 'on'], true)
        ? ['detail' => $e->getMessage()]
        : [];
}

/** sqlite | mysql | pgsql */
function db_driver(): string
{
    $d = strtolower(env('DB_BACKEND', '') ?? '');
    if ($d === 'postgres' || $d === 'postgresql') {
        $d = 'pgsql';
    }
    if ($d === '' && env('PGHOST')) {
        $d = 'pgsql';   // compatible with the older compose file
    }
    if ($d === '' && env('MYSQL_HOST')) {
        $d = 'mysql';
    }
    return in_array($d, ['sqlite', 'mysql', 'pgsql'], true) ? $d : 'sqlite';
}

function db_config(): array
{
    $driver = db_driver();
    if ($driver === 'sqlite') {
        return [
            'driver' => 'sqlite',
            'path'   => env('NMIET_DB', realpath(BASE_DIR) . DIRECTORY_SEPARATOR . 'nmiet.db'),
        ];
    }
    $isPg = $driver === 'pgsql';
    return [
        'driver' => $driver,
        'host'   => env('DB_HOST', env($isPg ? 'PGHOST' : 'MYSQL_HOST', $isPg ? 'db' : 'localhost')),
        'port'   => env('DB_PORT', env($isPg ? 'PGPORT' : 'MYSQL_PORT', $isPg ? '5432' : '3306')),
        'name'   => env('DB_NAME', env($isPg ? 'PGDATABASE' : 'MYSQL_DATABASE', 'nmiet')),
        'user'   => env('DB_USER', env($isPg ? 'PGUSER' : 'MYSQL_USER', $isPg ? 'nmiet' : 'root')),
        'pass'   => env('DB_PASS', env($isPg ? 'PGPASSWORD' : 'MYSQL_PASSWORD', $isPg ? 'nmiet' : '')),
        // hosted Postgres (Neon, Supabase, …) refuses plain connections
        'sslmode' => $isPg ? env('DB_SSLMODE', env('PGSSLMODE')) : null,
    ];
}

/* Bump when the demo data in seed_data() changes. It rides along in the
   schema signature, so an install still carrying the previous demo set
   re-runs init_db() once and picks the new one up. */
const SEED_REVISION = '2026-08-20-attendance';

/** collection => table columns (id is always first and is the primary key) */
const COLLECTIONS = [
    'users'      => ['id', 'username', 'password', 'role', 'refId', 'name'],
    // course + academicYear are used by the accounts office (fee structure is per course/year);
    // cgpa/backlogs/batch drive placement eligibility (cgpa falls back to the marks average)
    /* `name` stays the full name every other screen prints — the ID card, the
       marksheet, the fee receipt — and is composed from the three parts on
       save, so nothing downstream had to learn about them. */
    /* branch is the department a student belongs to (MBA, MCA); specialisation
       is the stream inside it (Marketing, Finance, Data Science). Attendance is
       taken per specialisation, which is why both are recorded. */
    'students'   => ['id', 'roll', 'name', 'firstName', 'middleName', 'lastName',
                     'email', 'phone', 'branch', 'specialisation', 'year', 'semester',
                     'section', 'photo', 'course', 'academicYear', 'cgpa', 'backlogs',
                     'batch', 'status'],
    // reportingTo holds the id of another faculty row — the person this one
    // reports to. Blank for the top of the tree.
    'faculty'    => ['id', 'empId', 'name', 'email', 'phone', 'department', 'designation', 'photo',
                     'qualification', 'expertise', 'publications', 'reportingTo'],
    // accounts-office staff record; the login lives in `users` with role = accountant
    'accountants' => ['id', 'empId', 'name', 'email', 'phone', 'designation', 'photo'],
    // centre-monitoring staff record; the login lives in `users` with role = center_head
    'centerheads' => ['id', 'empId', 'name', 'email', 'phone', 'designation', 'photo'],
    // placement-cell staff record; the login lives in `users` with role = placement_officer
    'placementofficers' => ['id', 'empId', 'name', 'email', 'phone', 'designation', 'department', 'photo'],
    /* course coordinators run attendance for a department. They may register a
       class and correct it; they may not touch the master data behind it. */
    'coordinators' => ['id', 'empId', 'name', 'email', 'phone', 'designation', 'department', 'photo'],
    // shortName drives the timetable label; facultyId is set from the Assignments page
    'courses'    => ['id', 'code', 'name', 'branch', 'semester', 'credits', 'facultyId', 'section', 'shortName', 'type'],
    /* The curriculum: what a branch studies in each semester. Deliberately not
       the same table as `courses` — a course is one taught offering, with a
       section, a faculty member, attendance and marks hanging off it, whereas
       this is the prospectus. Keeping them apart means the admin can correct a
       syllabus entry without touching anyone's attendance record, and the
       Courses dropdowns on the attendance/marks pages do not fill up with two
       hundred catalogue entries nobody teaches this term. */
    'syllabus'   => ['id', 'branch', 'semester', 'code', 'name', 'type', 'credits'],
    /* One row per class held. `records` maps studentId -> P|A; the rest is the
       class it was held for, copied in at save time rather than derived later —
       a student who changes specialisation next term must not silently rewrite
       what was registered last term. `type` separates an academic class from a
       placement training session. */
    'attendance' => ['id', 'courseId', 'date', 'records', 'type', 'course', 'batch',
                     'semester', 'department', 'specialisation', 'paperCode',
                     'paperName', 'facultyId', 'classTime', 'markedBy'],
    'marks'      => ['id', 'studentId', 'courseId', 'internal', 'external'],
    // one row per student per semester — the single fee ledger shared by admin,
    // accountant and the student's own "My Fees" page
    'fees'       => ['id', 'studentId', 'total', 'paid', 'dueDate', 'semester', 'academicYear'],
    // college-wide fee structure (course + branch + year + fee type -> fixed amount)
    'fixedfees'  => ['id', 'course', 'branch', 'academicYear', 'feeType', 'amount', 'effectiveFrom', 'status'],
    // every collected payment; fees.paid is the roll-up, these are the receipts
    'payments'   => ['id', 'receiptNo', 'studentId', 'feeId', 'amount', 'mode', 'txnId', 'date',
                     'remarks', 'status', 'collectedBy'],
    'assets'     => ['id', 'name', 'category', 'quantity', 'purchaseDate', 'purchaseCost',
                     'currentValue', 'vendor', 'location', 'status'],
    // purchase requests raised by faculty (goods) and the librarian (books);
    // admin/accountant approve them, then convert them into assets or books
    'requisitions' => ['id', 'type', 'title', 'author', 'isbn', 'category', 'quantity', 'estimatedCost',
                       'vendor', 'purpose', 'priority', 'status', 'requestedBy', 'requesterName',
                       'requesterRole', 'department', 'requestDate', 'neededBy',
                       'reviewedBy', 'reviewedOn', 'reviewRemarks', 'linkedId'],
    // period is legacy — startTime/endTime drive the grid, room is the venue
    'timetable'  => ['id', 'branch', 'semester', 'section', 'day', 'period', 'courseId', 'startTime', 'endTime', 'room'],
    'books'      => ['id', 'title', 'author', 'isbn', 'category', 'total', 'available'],
    'issues'     => ['id', 'bookId', 'studentId', 'issueDate', 'dueDate', 'returnDate'],
    'events'     => ['id', 'title', 'date', 'description', 'createdBy'],

    /* ---------------- placement cell ----------------
       One shared set of tables for the admin and the placement officer. Student
       identity is never copied here — every row points at an existing
       `students` / `courses` record by id. */
    // engagementType: whether this company takes final-year hires or summer interns
    'companies'  => ['id', 'name', 'logo', 'industry', 'website', 'location',
                     'hrName', 'hrEmail', 'hrPhone', 'description', 'engagementType'],
    // a recruitment drive by one company, with the eligibility rule it enforces
    'drives'     => ['id', 'companyId', 'jobRole', 'jobDescription', 'package', 'location', 'openings',
                     'eligibleCourses', 'eligibleBranches', 'minCgpa', 'maxBacklogs',
                     'driveDate', 'appStartDate', 'appEndDate', 'interviewDate',
                     'selectionProcess', 'status', 'publishedOn', 'driveType'],
    // one row per student per drive — the single source for applications,
    // shortlisting and selection (status moves Applied -> ... -> Selected)
    'applications' => ['id', 'studentId', 'driveId', 'appliedOn', 'status',
                       'shortlistedOn', 'remarks', 'updatedBy', 'updatedOn'],
    // interviewType: the real interview, or a mock run before it
    'interviews' => ['id', 'applicationId', 'studentId', 'driveId', 'round', 'date', 'time',
                     'mode', 'venue', 'status', 'remarks', 'interviewType'],
    // the offer that follows a selection; `status` = Offered/Accepted/... and
    // an Accepted or Joined offer is what makes a student "Placed"
    // exitReason explains a 'Not Joined' or 'Left' status — asked for by name
    'offers'     => ['id', 'studentId', 'driveId', 'companyId', 'jobRole', 'package', 'ctc', 'location',
                     'offerDate', 'joiningDate', 'status', 'offerLetter', 'offerLetterName', 'remarks',
                     'exitReason', 'exitDate'],
    // placement calendar: drives, interviews and talks all land here
    'placementevents' => ['id', 'title', 'type', 'date', 'startTime', 'endTime',
                          'companyId', 'driveId', 'venue', 'description'],

    // admin-controlled feature switches, e.g. studentFeesVisible = '1' | '0'
    'settings'   => ['id', 'name', 'value'],
];

/** columns stored as a JSON string but exposed to the UI as an object */
const JSON_FIELDS = ['attendance' => ['records']];

/** columns that hold long text (e.g. a base64 photo) — need a wide MySQL type */
const LONGTEXT_FIELDS = [
    'students' => ['photo'],
    'faculty' => ['photo', 'expertise', 'publications'],
    'accountants' => ['photo'],
    'centerheads' => ['photo'],
    'placementofficers' => ['photo'],
    'payments' => ['remarks'],
    'requisitions' => ['purpose', 'reviewRemarks'],
    'companies' => ['logo', 'description'],
    'drives' => ['jobDescription', 'selectionProcess', 'eligibleCourses', 'eligibleBranches'],
    'applications' => ['remarks'],
    'interviews' => ['remarks', 'venue'],
    // offerLetter holds a base64 data URL of the uploaded PDF/image
    'offers' => ['offerLetter', 'remarks'],
    'placementevents' => ['description'],
];

/** columns the UI expects as numbers, not strings */
const INT_FIELDS = ['year', 'semester', 'credits', 'internal', 'external', 'total', 'paid', 'period', 'available',
                    'amount', 'quantity', 'purchaseCost', 'currentValue', 'estimatedCost',
                    'backlogs', 'openings', 'maxBacklogs', 'round'];

const ID_PREFIX = [
    'students' => 'S', 'faculty' => 'F', 'courses' => 'C', 'attendance' => 'A',
    'marks' => 'M', 'fees' => 'FE', 'timetable' => 'T', 'users' => 'u',
    'books' => 'B', 'issues' => 'IS', 'events' => 'EV', 'settings' => 'SET',
    'accountants' => 'AC', 'assets' => 'AS', 'fixedfees' => 'FF', 'payments' => 'PY',
    'requisitions' => 'RQ', 'centerheads' => 'CH', 'placementofficers' => 'PO',
    'coordinators' => 'CC',
    'companies' => 'CO', 'drives' => 'DR', 'applications' => 'AP',
    'interviews' => 'IV', 'offers' => 'OF', 'placementevents' => 'PE',
    'syllabus' => 'SY',
];

/**
 * Role-based access control.
 *
 *   ADMIN        full access
 *   ACCOUNTANT   full access to the finance modules
 *   CENTER_HEAD  view / search / filter / report / export across the whole CMS,
 *                and nothing else — never create, edit, delete or approve
 *   PLACEMENT_OFFICER
 *                full access to the placement modules, read-only on the student
 *                and course records it recruits from, and nothing else — no
 *                finance, library, staff or system administration
 *   FACULTY      own classes
 *   LIBRARIAN    library
 *   STUDENT      own record
 *
 * Every rule below is enforced in api/index.php. The UI hides the buttons as
 * well, but the server is the gate: a hand-made POST/PUT/DELETE is refused.
 */
const ROLES = ['admin', 'accountant', 'center_head', 'placement_officer',
               'course_coordinator', 'faculty', 'librarian', 'student'];

/** roles that may read anything they can see but may never write — 403 on POST/PUT/DELETE */
const READ_ONLY_ROLES = ['center_head'];

/** Financial + staff-PII data. Not everyone may even read it. */
const FINANCE_COLLECTIONS = ['fixedfees', 'payments', 'assets', 'accountants', 'centerheads'];
/** existing collections whose *writes* are restricted to the finance roles */
const FINANCE_WRITE_ONLY = ['fees'];
/** may change financial data */
const FINANCE_ROLES = ['admin', 'accountant'];
/** may read financial data — the center head monitors it without touching it */
const FINANCE_VIEW_ROLES = ['admin', 'accountant', 'center_head'];

/* ---------------- attendance ----------------
   The admin and the course coordinator always mark attendance. Faculty do so
   only while the admin leaves the `facultyAttendance` switch on — some
   institutes want the coordinator to be the single point of entry. */
const ATTENDANCE_ALWAYS_ROLES = ['admin', 'course_coordinator'];
const ATTENDANCE_OPTIONAL_ROLES = ['faculty'];
/** master data a coordinator reads but never writes */
const COORDINATOR_READONLY = ['students', 'faculty', 'courses', 'syllabus', 'timetable',
                              'settings', 'users', 'coordinators', 'events', 'marks'];

/** requisitions: staff raise them, admin/accountant approve them — students never see them */
const STAFF_COLLECTIONS = ['requisitions'];
const STAFF_ROLES = ['admin', 'accountant', 'center_head', 'faculty', 'librarian',
                     'course_coordinator'];

/* ---------------- requisition approval chain ----------------
   A request now clears the center head before the accounts office can touch
   it:  raised (Pending) -> center head Approves -> accounts Orders/Receives.

   This is the ONE thing a read-only role may write, and it is pinned down to
   a single collection, a single verb and four fields. Everything else the
   center head sends is still refused outright. */
const REQ_PENDING_STATUS = 'Pending';
const REQ_APPROVED_STATUS = 'Approved';
/** role => collection => the only columns it may change */
const READ_ONLY_WRITE_EXCEPTIONS = [
    'center_head' => [
        'requisitions' => ['status', 'reviewedBy', 'reviewedOn', 'reviewRemarks'],
    ],
];
/** roles that may only act on a requisition the center head has already cleared */
const REQ_AFTER_APPROVAL_ROLES = ['accountant'];

/* ---------------- placement cell ----------------
   The admin and the placement officer share one set of placement tables — there
   is no second copy of a company, a drive or a student anywhere. */
const PLACEMENT_COLLECTIONS = ['companies', 'drives', 'applications', 'interviews',
                               'offers', 'placementevents', 'placementofficers'];
/** may create, edit, delete and approve placement records */
const PLACEMENT_ROLES = ['admin', 'placement_officer'];
/** may read them — the center head monitors placement without touching it */
const PLACEMENT_VIEW_ROLES = ['admin', 'placement_officer', 'center_head'];

/**
 * What a placement officer may see outside its own modules. Everything not
 * listed here and not a placement collection is refused outright, which is how
 * "no fee management, no accounting, no library, no system administration"
 * is actually enforced rather than merely hidden in the sidebar.
 */
const PLACEMENT_READABLE = ['students', 'courses', 'marks', 'events', 'users', 'settings', 'syllabus'];

/* ---------------- what a student sees of the placement cell ----------------
   Which companies are visiting and on what terms is the whole point of the
   cell, so those are open. Applications, interviews and offers name specific
   students, so a student gets their own rows and nobody else's — filtered on
   the server, not merely hidden by the UI. Students never write any of it. */
const PLACEMENT_STUDENT_OPEN = ['companies', 'drives', 'placementevents'];
const PLACEMENT_STUDENT_OWN  = ['applications', 'interviews', 'offers'];

/* A student may create exactly one thing: their own application to a drive
   that is open and that they qualify for. Every part of that is checked in
   guard_student_application(), because a button on a page is not a rule. */
const DRIVE_OPEN_STATUS = ['Published', 'Ongoing'];
/** internal marks are out of this, and the GPA fallback is derived from them */
const INTERNAL_MAX = 40;

/* ---------------- curriculum ----------------
   The syllabus is a teaching document, so the accounts office has no business
   in it and everyone else does. Reads are refused for the roles below rather
   than merely hidden from the sidebar, and only the admin may change it. */
const SYLLABUS_HIDDEN_ROLES = ['accountant'];
const SYLLABUS_WRITE_ROLES = ['admin'];

/* ================= curriculum =================
   programme => semester => [ [code, subject], ... ]

   NMIET B-SCHOOL runs two postgraduate programmes, MBA and MCA. Both are two
   years — four semesters — which is why SEMESTERS and MAX_SEMESTER stop at 4
   rather than the eight an engineering scheme would need. */
function curriculum(): array
{
    return [
        'MBA' => [
            1 => [['MBA101', 'Management Principles & Practices'], ['MBA102', 'Financial Accounting'],
                  ['MBA103', 'Managerial Economics'], ['MBA104', 'Organisational Behaviour'],
                  ['MBA105', 'Business Statistics'], ['MBA106', 'Business Communication']],
            2 => [['MBA201', 'Marketing Management'], ['MBA202', 'Financial Management'],
                  ['MBA203', 'Human Resource Management'], ['MBA204', 'Operations Management'],
                  ['MBA205', 'Research Methodology'], ['MBA206', 'Legal Aspects of Business']],
            3 => [['MBA301', 'Strategic Management'], ['MBA302', 'Consumer Behaviour'],
                  ['MBA303', 'Investment Analysis & Portfolio Management'],
                  ['MBA304', 'Supply Chain Management'], ['MBA-E1', 'Elective – I'],
                  ['MBA391', 'Summer Internship Project']],
            4 => [['MBA401', 'Business Ethics & Corporate Governance'],
                  ['MBA402', 'International Business'], ['MBA403', 'Entrepreneurship Development'],
                  ['MBA-E2', 'Elective – II'], ['MBA-E3', 'Elective – III'],
                  ['MBA491', 'Dissertation / Project']],
        ],
        'MCA' => [
            1 => [['MCA101', 'Programming with C'], ['MCA102', 'Computer Organisation'],
                  ['MCA103', 'Discrete Mathematics'], ['MCA104', 'Database Management Systems'],
                  ['MCA105', 'Operating Systems'], ['MCA191', 'Programming Lab']],
            2 => [['MCA201', 'Data Structures & Algorithms'],
                  ['MCA202', 'Object Oriented Programming with Java'],
                  ['MCA203', 'Computer Networks'], ['MCA204', 'Software Engineering'],
                  ['MCA291', 'Data Structures Lab'], ['MCA292', 'Java Lab']],
            3 => [['MCA301', 'Web Technologies'], ['MCA302', 'Machine Learning'],
                  ['MCA303', 'Cloud Computing'], ['MCA-E1', 'Elective – I'],
                  ['MCA391', 'Web Technology Lab'], ['MCA392', 'Minor Project']],
            4 => [['MCA401', 'Big Data Analytics'], ['MCA402', 'Cyber Security'],
                  ['MCA-E2', 'Elective – II'], ['MCA491', 'Major Project'],
                  ['MCA492', 'Internship']],
        ],
    ];
}

/** Classify a subject from its name so the page can colour-code it. */
function syllabus_type(string $name): string
{
    if (stripos($name, 'lab') !== false) {
        return 'Lab';
    }
    foreach (['project', 'internship', 'seminar', 'viva', 'research', 'industrial training'] as $w) {
        if (stripos($name, $w) !== false) {
            return 'Project';
        }
    }
    return stripos($name, 'elective') !== false ? 'Elective' : 'Theory';
}

/** curriculum() flattened into `syllabus` rows */
function syllabus_seed(): array
{
    $rows = [];
    $n = 0;
    foreach (curriculum() as $branch => $semesters) {
        foreach ($semesters as $sem => $subjects) {
            foreach ($subjects as [$code, $name]) {
                $rows[] = ['SY' . str_pad((string) ++$n, 3, '0', STR_PAD_LEFT),
                           $branch, $sem, $code, $name, syllabus_type($name), null];
            }
        }
    }
    return $rows;
}

/** demo data — inserted per table only when that table is empty */
function seed_data(): array
{
    return [
        'users' => [
            ['u1', 'admin', 'admin123', 'admin', null, 'System Admin'],
            ['u2', 'rmehta', 'pass123', 'faculty', 'F01', 'Dr. Rajesh Mehta'],
            ['u3', 'svenkat', 'pass123', 'faculty', 'F02', 'Prof. S. Venkat'],
            ['u4', '2025180001', 'pass123', 'student', 'S01', 'Aarav Sharma'],
            ['u5', '2025180002', 'pass123', 'student', 'S02', 'Diya Patel'],
            ['u6', 'accounts', 'pass123', 'accountant', 'AC01', 'Sunita Rao'],
            ['u7', 'centerhead', 'pass123', 'center_head', 'CH01', 'Dr. Anand Rao'],
            ['u8', 'placement', 'pass123', 'placement_officer', 'PO01', 'Ms. Kavita Menon'],
            ['u9', 'coordinator', 'pass123', 'course_coordinator', 'CC01', 'Dr. Sunil Mohanty'],
        ],
        'faculty' => [
            ['F01', 'NM-F-1001', 'Dr. Rajesh Mehta', 'rmehta@nmiet.edu', '9876500011', 'MBA', 'Professor', null,
             'Ph.D. (Management)', 'Marketing Management, Consumer Behaviour', '18 journal papers, 6 conference papers'],
            ['F02', 'NM-F-1002', 'Prof. S. Venkat', 'svenkat@nmiet.edu', '9876500012', 'MBA', 'Associate Professor', null,
             'M.Com, MBA (Finance)', 'Financial Management, Investment Analysis', '9 journal papers'],
            ['F03', 'NM-F-1003', 'Dr. Meera Krishnan', 'meera@nmiet.edu', '9876500013', 'MCA', 'Assistant Professor', null,
             'Ph.D. (Computer Applications)', 'Data Structures, Database Systems', '12 journal papers'],
            ['F04', 'NM-F-1004', 'Dr. Anil Kapoor', 'anil@nmiet.edu', '9876500014', 'MCA', 'Professor', null,
             'Ph.D. (Computer Science)', 'Java, Software Engineering', '24 journal papers, 2 patents'],
        ],
        // id, roll, name, first, middle, last, email, phone, branch, year, semester,
        // section, photo, course, academicYear, cgpa, backlogs, batch, status
        'students' => [
            ['S01', '2025180001', 'Aarav Sharma', 'Aarav', null, 'Sharma', 'aarav@nmiet.in', '9810000001', 'MBA', 'Marketing', 1, 2, 'A', null, 'MBA', '2026-27', '8.6', 0, '2025-2027', 'Active'],
            ['S02', '2025180002', 'Diya Patel', 'Diya', null, 'Patel', 'diya@nmiet.in', '9810000002', 'MBA', 'Finance', 1, 2, 'A', null, 'MBA', '2026-27', '7.9', 0, '2025-2027', 'Active'],
            ['S03', '2025180003', 'Rohan Verma', 'Rohan', null, 'Verma', 'rohan@nmiet.in', '9810000003', 'MBA', 'Marketing', 1, 2, 'A', null, 'MBA', '2026-27', '6.4', 2, '2025-2027', 'Active'],
            ['S04', '2025180004', 'Ananya Iyer', 'Ananya', null, 'Iyer', 'ananya@nmiet.in', '9810000004', 'MBA', 'Human Resource', 1, 2, 'B', null, 'MBA', '2026-27', '9.1', 0, '2025-2027', 'Active'],
            ['S05', '2025190001', 'Karan Singh', 'Karan', null, 'Singh', 'karan@nmiet.in', '9810000005', 'MCA', 'Data Science', 1, 2, 'A', null, 'MCA', '2026-27', '7.2', 1, '2025-2027', 'Active'],
            ['S06', '2025190002', 'Ishita Nair', 'Ishita', null, 'Nair', 'ishita@nmiet.in', '9810000006', 'MCA', 'Software Engineering', 1, 2, 'A', null, 'MCA', '2026-27', '8.0', 0, '2025-2027', 'Active'],
        ],
        'accountants' => [
            ['AC01', 'NM-A-2001', 'Sunita Rao', 'sunita.rao@nmiet.edu', '9876500021', 'Senior Accountant', null],
        ],
        'centerheads' => [
            ['CH01', 'NM-CH-3001', 'Dr. Anand Rao', 'anand.rao@nmiet.edu', '9876500031', 'Center Head', null],
        ],
        'placementofficers' => [
            ['PO01', 'NM-P-4001', 'Ms. Kavita Menon', 'kavita.menon@nmiet.edu', '9876500041',
             'Placement Officer', 'Training & Placement Cell', null],
        ],
        'coordinators' => [
            ['CC01', 'NM-C-5001', 'Dr. Sunil Mohanty', 'sunil.mohanty@nmiet.edu', '9876500051',
             'Course Coordinator', 'MBA', null],
        ],
        'courses' => [
            ['C01', 'MBA201', 'Marketing Management', 'MBA', 2, 4, 'F01', 'A'],
            ['C02', 'MBA202', 'Financial Management', 'MBA', 2, 4, 'F02', 'A'],
            ['C03', 'MBA203', 'Human Resource Management', 'MBA', 2, 3, 'F01', 'A'],
            ['C04', 'MCA201', 'Data Structures & Algorithms', 'MCA', 2, 4, 'F03', 'A'],
            ['C05', 'MCA202', 'Object Oriented Programming with Java', 'MCA', 2, 4, 'F04', 'A'],
            ['C06', 'MBA201', 'Marketing Management', 'MBA', 2, 4, 'F02', 'B'],
        ],
        'syllabus' => syllabus_seed(),
        'attendance' => [
            ['A01', 'C01', '2026-06-15', json_encode(['S01' => 'P', 'S02' => 'P', 'S03' => 'A', 'S04' => 'P'])],
            ['A02', 'C01', '2026-06-16', json_encode(['S01' => 'P', 'S02' => 'A', 'S03' => 'P', 'S04' => 'P'])],
            ['A03', 'C02', '2026-06-16', json_encode(['S01' => 'P', 'S02' => 'P', 'S03' => 'P', 'S04' => 'A'])],
        ],
        'marks' => [
            ['M01', 'S01', 'C01', 34, 52],
            ['M02', 'S01', 'C02', 30, 48],
            ['M03', 'S02', 'C01', 28, 40],
            ['M04', 'S03', 'C01', 22, 33],
        ],
        'fees' => [
            ['FE01', 'S01', 185000, 185000, '2026-07-31', 2, '2026-27'],
            ['FE02', 'S02', 185000, 100000, '2026-07-31', 2, '2026-27'],
            ['FE03', 'S03', 185000, 0, '2026-07-31', 2, '2026-27'],
            ['FE04', 'S04', 185000, 185000, '2026-07-31', 2, '2026-27'],
            ['FE05', 'S05', 165000, 80000, '2026-07-31', 2, '2026-27'],
            ['FE06', 'S06', 165000, 165000, '2026-07-31', 2, '2026-27'],
        ],
        'fixedfees' => [
            ['FF01', 'MBA', 'MBA', '2026-27', 'Tuition Fee',     150000, '2026-06-01', 'Active'],
            ['FF02', 'MBA', 'MBA', '2026-27', 'Examination Fee',   8000, '2026-06-01', 'Active'],
            ['FF03', 'MBA', 'MBA', '2026-27', 'Library Fee',        5000, '2026-06-01', 'Active'],
            ['FF04', 'MBA', 'MBA', '2026-27', 'Development Fee',   10000, '2026-06-01', 'Active'],
            ['FF05', 'MBA', 'MBA', '2026-27', 'Placement Fee',     12000, '2026-06-01', 'Active'],
            ['FF06', 'MCA', 'MCA', '2026-27', 'Tuition Fee',      140000, '2026-06-01', 'Active'],
            ['FF07', 'MCA', 'MCA', '2026-27', 'Examination Fee',    8000, '2026-06-01', 'Active'],
            ['FF08', 'MCA', 'MCA', '2026-27', 'Computer Lab Fee',  12000, '2026-06-01', 'Active'],
        ],
        'assets' => [
            ['AS01', 'Dell OptiPlex Desktop', 'Computer', 40, '2024-07-12', 1800000, 1080000,
             'Dell India Pvt Ltd', 'Computer Lab 1', 'In Use'],
            ['AS02', 'HP ProBook Laptop', 'Laptop', 15, '2025-01-20', 975000, 780000,
             'HP Enterprise', 'Staff Room', 'In Use'],
            ['AS03', 'Epson EB-X51 Projector', 'Projector', 12, '2024-09-05', 456000, 300000,
             'Epson India', 'Lecture Halls', 'In Use'],
            ['AS04', 'Student Bench (3-seater)', 'Furniture', 220, '2023-06-18', 1320000, 792000,
             'Godrej Interio', 'Academic Block', 'In Use'],
            ['AS05', 'Interactive Smart Board', 'Laboratory Equipment', 8, '2025-03-11', 640000, 576000,
             'Samsung India', 'Seminar Hall', 'In Use'],
            ['AS06', 'Cisco 24-Port Switch', 'Networking Equipment', 6, '2024-11-02', 210000, 147000,
             'Cisco Systems', 'Server Room', 'In Use'],
            ['AS07', 'Canon LBP Printer', 'Printer', 9, '2023-12-15', 189000, 94500,
             'Canon India', 'Admin Office', 'Under Maintenance'],
            ['AS08', 'Library Book Rack', 'Library Equipment', 45, '2022-08-09', 337500, 168750,
             'Godrej Interio', 'Central Library', 'In Use'],
        ],
        'timetable' => [
            ['T01', 'MBA', 2, 'A', 'Mon', 1, 'C01', '08:30', '09:30', '403'],
            ['T02', 'MBA', 2, 'A', 'Mon', 2, 'C02', '09:30', '10:30', '403'],
            ['T03', 'MBA', 2, 'A', 'Tue', 1, 'C03', '08:30', '09:30', '403'],
            ['T04', 'MBA', 2, 'A', 'Wed', 2, 'C01', '09:30', '10:30', '403'],
            ['T05', 'MBA', 2, 'A', 'Thu', 1, 'C02', '08:30', '09:30', '403'],
            ['T06', 'MBA', 2, 'A', 'Fri', 3, 'C03', '10:30', '11:30', '403'],
        ],
        'books' => [
            ['B01', 'Marketing Management', 'Philip Kotler, Kevin Lane Keller', '9789332557185', 'Management', 5, 4],
            ['B02', 'Financial Management: Theory and Practice', 'Prasanna Chandra', '9789353166527', 'Management', 4, 4],
            ['B03', 'Organizational Behaviour', 'Stephen P. Robbins', '9789353063085', 'Management', 3, 2],
            ['B04', 'Human Resource Management', 'Gary Dessler', '9789353433154', 'Management', 4, 4],
            ['B05', 'Database System Concepts', 'Silberschatz, Korth', '9780073523323', 'Computer Applications', 3, 3],
            ['B06', 'Java: The Complete Reference', 'Herbert Schildt', '9789389538830', 'Computer Applications', 6, 5],
        ],
        'issues' => [
            ['IS01', 'B01', 'S01', '2026-06-10', '2026-06-24', ''],
            ['IS02', 'B03', 'S02', '2026-06-05', '2026-06-19', ''],
        ],
        'events' => [
            ['EV01', 'Annual Tech Fest', '2026-09-12', 'Inter-college technical festival with coding, robotics and paper-presentation events.', 'u1'],
            ['EV02', 'Mid-Semester Exams Begin', '2026-08-18', 'Mid-sem exams for all branches start from this date. Check timetable for schedule.', 'u1'],
        ],
        'requisitions' => [
            ['RQ01', 'Goods', 'Whiteboard Marker Set', null, null, 'Stationery', 40, 4000, 'Camlin',
             'Classroom teaching supplies for the semester', 'Normal', 'Pending', 'u2', 'Dr. Rajesh Mehta',
             'faculty', 'Computer Science', '2026-08-01', '2026-08-20', null, null, null, null],
            ['RQ02', 'Goods', 'Logitech Wireless Presenter', null, null, 'Other', 5, 12500, 'Logitech',
             'Needed for seminar hall presentations', 'High', 'Pending', 'u2', 'Dr. Rajesh Mehta',
             'faculty', 'Computer Science', '2026-08-05', '2026-08-25', null, null, null, null],
            ['RQ03', 'Book', 'Clean Code', 'Robert C. Martin', '9780132350884', 'Computer Science', 6, 3600,
             'Pearson India', 'Frequently requested by final-year students', 'Normal', 'Pending', null,
             'Library Desk', 'librarian', 'Library', '2026-08-04', '2026-09-01', null, null, null, null],
        ],
        /* ---- placement cell demo data ----
           A complete chain so every module has something to show on first run:
           2 companies -> 3 drives -> 6 applications -> 4 interviews -> 3 offers. */
        'companies' => [
            ['CO01', 'Infosys Ltd', null, 'IT Services', 'https://www.infosys.com', 'Bengaluru',
             'Ritu Sharma', 'ritu.sharma@infosys.com', '9845010001',
             'Global IT consulting and services firm; recruits Systems Engineers every year.'],
            ['CO02', 'Tata Consultancy Services', null, 'IT Services', 'https://www.tcs.com', 'Hyderabad',
             'Arjun Nair', 'arjun.nair@tcs.com', '9845010002',
             'Largest Indian IT services company; hires through the National Qualifier Test.'],
            ['CO03', 'HDFC Bank', null, 'Banking / Financial Services', 'https://www.hdfcbank.com', 'Mumbai',
             'Sneha Kulkarni', 'sneha.kulkarni@hdfcbank.com', '9845010003',
             'Private sector bank; recruits management trainees for retail banking and sales.'],
        ],
        'drives' => [
            ['DR01', 'CO01', 'Systems Engineer',
             'Entry-level role covering application development, testing and support.',
             450000, 'Bengaluru', 40, 'MCA', 'MBA,MCA', '6.5', 1,
             '2026-09-10', '2026-08-10', '2026-09-05', '2026-09-12',
             'Online Test -> Technical Interview -> HR Interview', 'Published', '2026-08-08'],
            ['DR02', 'CO02', 'Assistant System Engineer',
             'Ninja profile through the TCS National Qualifier Test.',
             350000, 'Hyderabad', 60, 'MCA', 'MBA,MCA', '6.0', 2,
             '2026-09-20', '2026-08-15', '2026-09-15', '2026-09-22',
             'NQT -> Technical Interview -> HR Interview', 'Published', '2026-08-08'],
            ['DR03', 'CO03', 'Management Trainee',
             'Retail banking and sales track for the 2027 batch, with a six-month rotation.',
             620000, 'Mumbai', 15, 'MBA', 'MBA', '7.0', 0,
             '2026-10-05', '2026-09-01', '2026-09-28', '2026-10-07',
             'Aptitude Test -> Group Discussion -> Personal Interview', 'Draft', null],
        ],
        'applications' => [
            ['AP01', 'S01', 'DR01', '2026-08-11', 'Selected',    '2026-08-20', 'Cleared all three rounds.', 'u8', '2026-09-12'],
            ['AP02', 'S02', 'DR01', '2026-08-11', 'Shortlisted', '2026-08-20', 'Shortlisted after the online test.', 'u8', '2026-08-20'],
            ['AP03', 'S04', 'DR01', '2026-08-12', 'Selected',    '2026-08-20', 'Strong technical round.', 'u8', '2026-09-12'],
            ['AP04', 'S03', 'DR01', '2026-08-12', 'Rejected',    null, 'Did not meet the CGPA cut-off at screening.', 'u8', '2026-08-20'],
            ['AP05', 'S02', 'DR02', '2026-08-16', 'Applied',     null, null, 'u8', '2026-08-16'],
            ['AP06', 'S06', 'DR02', '2026-08-16', 'Selected',    '2026-08-30', 'Selected in the first round itself.', 'u8', '2026-09-22'],
        ],
        'interviews' => [
            ['IV01', 'AP01', 'S01', 'DR01', 1, '2026-09-12', '10:00', 'Offline', 'Placement Cell — Room 201', 'Completed', 'Cleared technical round.'],
            ['IV02', 'AP01', 'S01', 'DR01', 2, '2026-09-12', '14:00', 'Offline', 'Placement Cell — Room 201', 'Completed', 'HR round cleared.'],
            ['IV03', 'AP02', 'S02', 'DR01', 1, '2026-09-12', '11:00', 'Online',  'Microsoft Teams', 'Scheduled', null],
            ['IV04', 'AP03', 'S04', 'DR01', 1, '2026-09-12', '12:00', 'Offline', 'Placement Cell — Room 201', 'Completed', 'Selected.'],
            ['IV05', 'AP06', 'S06', 'DR02', 1, '2026-09-22', '10:30', 'Online',  'TCS iON', 'Completed', 'Cleared NQT and interview.'],
        ],
        'offers' => [
            ['OF01', 'S01', 'DR01', 'CO01', 'Systems Engineer', 450000, '4.5 LPA', 'Bengaluru',
             '2026-09-15', '2026-07-01', 'Accepted', null, null, 'Offer accepted by the student.'],
            ['OF02', 'S04', 'DR01', 'CO01', 'Systems Engineer', 450000, '4.5 LPA', 'Bengaluru',
             '2026-09-15', '2026-07-01', 'Offered', null, null, 'Awaiting the student\'s confirmation.'],
            ['OF03', 'S06', 'DR02', 'CO02', 'Assistant System Engineer', 350000, '3.5 LPA', 'Hyderabad',
             '2026-09-25', '2026-07-15', 'Accepted', null, null, null],
        ],
        'placementevents' => [
            ['PE01', 'Infosys — Pre-Placement Talk', 'Pre-Placement Talk', '2026-09-09', '10:00', '11:30',
             'CO01', 'DR01', 'Seminar Hall', 'Company overview, role details and the selection process.'],
            ['PE02', 'Infosys — Campus Drive', 'Drive', '2026-09-10', '09:00', '17:00',
             'CO01', 'DR01', 'Computer Lab 1 & 2', 'Online test followed by shortlisting.'],
            ['PE03', 'Infosys — Interviews', 'Interview', '2026-09-12', '10:00', '16:00',
             'CO01', 'DR01', 'Placement Cell — Room 201', 'Technical and HR rounds.'],
            ['PE04', 'TCS — Campus Drive', 'Drive', '2026-09-20', '09:00', '17:00',
             'CO02', 'DR02', 'Computer Lab 1', 'TCS National Qualifier Test.'],
            ['PE05', 'Resume Building Workshop', 'Other', '2026-08-28', '14:00', '16:00',
             null, null, 'Seminar Hall', 'Mandatory for all final-year students appearing for placements.'],
        ],
        'settings' => [
            ['SET01', 'studentFeesVisible', '1'],
            ['SET02', 'regNoLength', '10'],
            ['SET03', 'facultyAttendance', '1'],
        ],
    ];
}
