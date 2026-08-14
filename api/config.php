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

/** collection => table columns (id is always first and is the primary key) */
const COLLECTIONS = [
    'users'      => ['id', 'username', 'password', 'role', 'refId', 'name'],
    // course + academicYear are used by the accounts office (fee structure is per course/year);
    // cgpa/backlogs/batch drive placement eligibility (cgpa falls back to the marks average)
    'students'   => ['id', 'roll', 'name', 'email', 'phone', 'branch', 'year', 'semester', 'section', 'photo',
                     'course', 'academicYear', 'cgpa', 'backlogs', 'batch'],
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
    'attendance' => ['id', 'courseId', 'date', 'records'],   // records = JSON object
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
    'companies'  => ['id', 'name', 'logo', 'industry', 'website', 'location',
                     'hrName', 'hrEmail', 'hrPhone', 'description'],
    // a recruitment drive by one company, with the eligibility rule it enforces
    'drives'     => ['id', 'companyId', 'jobRole', 'jobDescription', 'package', 'location', 'openings',
                     'eligibleCourses', 'eligibleBranches', 'minCgpa', 'maxBacklogs',
                     'driveDate', 'appStartDate', 'appEndDate', 'interviewDate',
                     'selectionProcess', 'status', 'publishedOn'],
    // one row per student per drive — the single source for applications,
    // shortlisting and selection (status moves Applied -> ... -> Selected)
    'applications' => ['id', 'studentId', 'driveId', 'appliedOn', 'status',
                       'shortlistedOn', 'remarks', 'updatedBy', 'updatedOn'],
    'interviews' => ['id', 'applicationId', 'studentId', 'driveId', 'round', 'date', 'time',
                     'mode', 'venue', 'status', 'remarks'],
    // the offer that follows a selection; `status` = Offered/Accepted/... and
    // an Accepted or Joined offer is what makes a student "Placed"
    'offers'     => ['id', 'studentId', 'driveId', 'companyId', 'jobRole', 'package', 'ctc', 'location',
                     'offerDate', 'joiningDate', 'status', 'offerLetter', 'offerLetterName', 'remarks'],
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
               'faculty', 'librarian', 'student'];

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

/** requisitions: staff raise them, admin/accountant approve them — students never see them */
const STAFF_COLLECTIONS = ['requisitions'];
const STAFF_ROLES = ['admin', 'accountant', 'center_head', 'faculty', 'librarian'];

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

/* ---------------- curriculum ----------------
   The syllabus is a teaching document, so the accounts office has no business
   in it and everyone else does. Reads are refused for the roles below rather
   than merely hidden from the sidebar, and only the admin may change it. */
const SYLLABUS_HIDDEN_ROLES = ['accountant'];
const SYLLABUS_WRITE_ROLES = ['admin'];

/* ================= B.Tech curriculum =================
   branch => semester => [ [code, subject], ... ]

   CSE and AI & ML are coded scheme-wise. The other four branches are listed in
   the institute's chart as key subjects per semester without codes, so their
   code is left blank here rather than inventing identifiers that would not
   match any real scheme; the admin can fill them in from the Subjects page. */
function btech_curriculum(): array
{
    return [
        'CSE' => [
            1 => [['BS101', 'Engineering Mathematics-I'], ['PH101', 'Engineering Physics'],
                  ['CS101', 'Programming for Problem Solving'], ['EE101', 'Basic Electrical Engineering'],
                  ['ME101', 'Engineering Graphics & Design'], ['HS101', 'English / Communication Skills'],
                  ['PH191', 'Engineering Physics Lab'], ['CS191', 'Programming Lab']],
            2 => [['BS102', 'Engineering Mathematics-II'], ['CH101', 'Engineering Chemistry'],
                  ['CS102', 'Data Structures'], ['CS103', 'Object Oriented Programming'],
                  ['EE102', 'Basic Electronics'], ['EVS101', 'Environmental Science'],
                  ['CS192', 'Data Structures Lab'], ['CS193', 'OOP Lab']],
            3 => [['BS201', 'Discrete Mathematics'], ['CS201', 'Digital Logic Design'],
                  ['CS202', 'Computer Organization & Architecture'], ['CS203', 'Database Management System'],
                  ['CS204', 'Operating Systems'], ['CS291', 'Data Structures & Algorithms Lab'],
                  ['CS292', 'DBMS Lab']],
            4 => [['CS205', 'Computer Networks'], ['CS206', 'Theory of Computation'],
                  ['CS207', 'Software Engineering'], ['BS202', 'Probability & Statistics'],
                  ['CS208', 'Web Technologies'], ['CS293', 'Operating Systems Lab'],
                  ['CS294', 'Computer Networks Lab']],
            5 => [['CS301', 'Design & Analysis of Algorithms'], ['CS302', 'Artificial Intelligence'],
                  ['CS303', 'Computer Graphics'], ['CS304', 'Web Development'],
                  ['PE-I', 'Professional Elective – I'], ['CS391', 'AI Lab'], ['CS392', 'Web Technology Lab']],
            6 => [['CS305', 'Machine Learning'], ['CS306', 'Compiler Design'],
                  ['CS307', 'Internet of Things'], ['CS308', 'Cyber Security'],
                  ['PE-II', 'Professional Elective – II'], ['CS393', 'ML Lab'], ['CS394', 'IoT Lab']],
            7 => [['CS401', 'Distributed Systems'], ['CS402', 'Cloud Computing'],
                  ['PE-III', 'Professional Elective – III'], ['PE-IV', 'Professional Elective – IV'],
                  ['CS491', 'Seminar'], ['CS492', 'Project – I'], ['CS493', 'Internship']],
            8 => [['CS403', 'Big Data / Data Science'], ['OE', 'Open Elective'],
                  ['CS494', 'Project – II'], ['CS495', 'Internship / Industrial Training'],
                  ['CS496', 'Comprehensive Viva']],
        ],
        'AI & ML' => [
            1 => [['BS101', 'Engineering Mathematics-I'], ['PH101', 'Engineering Physics'],
                  ['CS101', 'Programming for Problem Solving'], ['EE101', 'Basic Electrical Engineering'],
                  ['ME101', 'Engineering Graphics & Design'], ['HS101', 'English / Communication Skills'],
                  ['CS191', 'Programming Lab'], ['PH191', 'Physics Lab']],
            2 => [['BS102', 'Engineering Mathematics-II'], ['CH101', 'Engineering Chemistry'],
                  ['CS102', 'Data Structures'], ['CS103', 'Object Oriented Programming'],
                  ['EE102', 'Basic Electronics'], ['EVS101', 'Environmental Science'],
                  ['CS192', 'Data Structures Lab'], ['CS193', 'OOP Lab']],
            3 => [['BS201', 'Discrete Mathematics'], ['CS201', 'Data Structures'],
                  ['CS202', 'Database Management System'], ['CS203', 'Computer Organization & Architecture'],
                  ['CS204', 'Object Oriented Programming'], ['CS291', 'Programming Lab']],
            4 => [['CS205', 'Operating Systems'], ['CS206', 'Computer Networks'],
                  ['CS207', 'Software Engineering'], ['CS208', 'Artificial Intelligence'],
                  ['CS209', 'Web Technologies'], ['CS293', 'AI / Programming Lab'],
                  ['CS294', 'Web Technologies Lab']],
            5 => [['CS301', 'Machine Learning'], ['CS302', 'Deep Learning'],
                  ['BS301', 'Probability & Statistics'], ['CS303', 'Data Science'],
                  ['CS304', 'Internet of Things'], ['CS391', 'Machine Learning Lab']],
            6 => [['CS305', 'Natural Language Processing'], ['CS306', 'Big Data Analytics'],
                  ['CS307', 'Computer Vision'], ['CS308', 'Cloud Computing'],
                  ['PE-I', 'Professional Elective'], ['CS392', 'NLP / AI Lab']],
            7 => [['CS401', 'Generative AI / LLM'], ['CS402', 'Reinforcement Learning'],
                  ['CS403', 'AI Ethics'], ['PE-II', 'Advanced Elective'],
                  ['CS491', 'Seminar'], ['CS492', 'Project – I']],
            8 => [['CS493', 'Major Project'], ['CS494', 'Internship / Industrial Training'],
                  ['CS495', 'Research / Publication'], ['CS496', 'Comprehensive Viva']],
        ],
        'EEE' => [
            1 => [['', 'Engineering Mathematics'], ['', 'Physics'], ['', 'Basic Electrical Engg.'],
                  ['', 'Engineering Graphics']],
            2 => [['', 'Engineering Chemistry'], ['', 'Basic Electronics'], ['', 'Circuit Analysis']],
            3 => [['', 'Electrical Machines'], ['', 'Digital Electronics'], ['', 'Network Analysis']],
            4 => [['', 'Control Systems'], ['', 'Power Electronics'], ['', 'Microprocessors']],
            5 => [['', 'Power Systems'], ['', 'Power Plant Engineering'], ['', 'Elective-I']],
            6 => [['', 'Power System Protection'], ['', 'PLC'], ['', 'Elective-II']],
            7 => [['', 'Renewable Energy Systems'], ['', 'Elective-III'], ['', 'Project-I']],
            8 => [['', 'Project-II'], ['', 'Internship'], ['', 'Viva']],
        ],
        'ECE' => [
            1 => [['', 'Engineering Mathematics'], ['', 'Physics'], ['', 'Basic Electrical'],
                  ['', 'Engineering Graphics']],
            2 => [['', 'Engineering Chemistry'], ['', 'Basic Electronics'], ['', 'Digital Logic']],
            3 => [['', 'Signals & Systems'], ['', 'Network Theory'], ['', 'Electronic Devices']],
            4 => [['', 'Microprocessors'], ['', 'Communication Systems'], ['', 'Electromagnetic Fields']],
            5 => [['', 'Digital Signal Processing'], ['', 'VLSI Design'], ['', 'Elective-I']],
            6 => [['', 'Embedded Systems'], ['', 'Antennas & Wave Propagation'], ['', 'Elective-II']],
            7 => [['', 'Wireless Communication'], ['', 'Elective-III'], ['', 'Project-I']],
            8 => [['', 'Project-II'], ['', 'Internship'], ['', 'Viva']],
        ],
        'ME' => [
            1 => [['', 'Engineering Mathematics'], ['', 'Physics'], ['', 'Engineering Graphics'],
                  ['', 'Workshop Practice']],
            2 => [['', 'Engineering Chemistry'], ['', 'Mechanics of Materials']],
            3 => [['', 'Thermodynamics'], ['', 'Fluid Mechanics'], ['', 'Manufacturing Process']],
            4 => [['', 'Strength of Materials'], ['', 'Machine Design'], ['', 'Kinematics']],
            5 => [['', 'Heat Transfer'], ['', 'CAD/CAM'], ['', 'Elective-I']],
            6 => [['', 'Industrial Engineering'], ['', 'Elective-II']],
            7 => [['', 'Automation in Manufacturing'], ['', 'Project-I'], ['', 'Elective-III']],
            8 => [['', 'Project-II'], ['', 'Internship'], ['', 'Viva']],
        ],
        'CE' => [
            1 => [['', 'Engineering Mathematics'], ['', 'Physics'], ['', 'Engineering Graphics']],
            2 => [['', 'Engineering Chemistry'], ['', 'Basic Civil Engineering']],
            3 => [['', 'Strength of Materials'], ['', 'Fluid Mechanics'], ['', 'Surveying']],
            4 => [['', 'Concrete Technology'], ['', 'Building Materials'], ['', 'Soil Mechanics']],
            5 => [['', 'Structural Analysis'], ['', 'Transportation Engineering'], ['', 'Elective-I']],
            6 => [['', 'Environmental Engineering'], ['', 'Elective-II']],
            7 => [['', 'Construction Management'], ['', 'Elective-III'], ['', 'Project-I']],
            8 => [['', 'Project-II'], ['', 'Internship'], ['', 'Viva']],
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

/** btech_curriculum() flattened into `syllabus` rows */
function syllabus_seed(): array
{
    $rows = [];
    $n = 0;
    foreach (btech_curriculum() as $branch => $semesters) {
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
            ['u4', '21CS001', 'pass123', 'student', 'S01', 'Aarav Sharma'],
            ['u5', '21CS002', 'pass123', 'student', 'S02', 'Diya Patel'],
            ['u6', 'accounts', 'pass123', 'accountant', 'AC01', 'Sunita Rao'],
            ['u7', 'centerhead', 'pass123', 'center_head', 'CH01', 'Dr. Anand Rao'],
            ['u8', 'placement', 'pass123', 'placement_officer', 'PO01', 'Ms. Kavita Menon'],
        ],
        'faculty' => [
            ['F01', 'NM-F-1001', 'Dr. Rajesh Mehta', 'rmehta@nmiet.edu', '9876500011', 'Computer Science', 'Professor', null,
             'Ph.D. (Computer Science)', 'Algorithms, Operating Systems', '18 journal papers, 6 conference papers'],
            ['F02', 'NM-F-1002', 'Prof. S. Venkat', 'svenkat@nmiet.edu', '9876500012', 'Computer Science', 'Associate Professor', null,
             'M.Tech (CSE)', 'Database Systems, Data Mining', '9 journal papers'],
            ['F03', 'NM-F-1003', 'Dr. Meera Krishnan', 'meera@nmiet.edu', '9876500013', 'Electronics', 'Assistant Professor', null,
             'Ph.D. (Electronics)', 'VLSI Design, Embedded Systems', '12 journal papers'],
            ['F04', 'NM-F-1004', 'Dr. Anil Kapoor', 'anil@nmiet.edu', '9876500014', 'Mechanical', 'Professor', null,
             'Ph.D. (Mechanical Engineering)', 'Thermodynamics, Heat Transfer', '24 journal papers, 2 patents'],
        ],
        // ..., course, academicYear, cgpa, backlogs, batch
        'students' => [
            ['S01', '21CS001', 'Aarav Sharma', 'aarav@nmiet.in', '9810000001', 'CSE', 3, 5, 'A', null, 'B.Tech', '2026-27', '8.6', 0, '2021-2025'],
            ['S02', '21CS002', 'Diya Patel', 'diya@nmiet.in', '9810000002', 'CSE', 3, 5, 'A', null, 'B.Tech', '2026-27', '7.9', 0, '2021-2025'],
            ['S03', '21CS003', 'Rohan Verma', 'rohan@nmiet.in', '9810000003', 'CSE', 3, 5, 'A', null, 'B.Tech', '2026-27', '6.4', 2, '2021-2025'],
            ['S04', '21CS004', 'Ananya Iyer', 'ananya@nmiet.in', '9810000004', 'CSE', 3, 5, 'B', null, 'B.Tech', '2026-27', '9.1', 0, '2021-2025'],
            ['S05', '21EC001', 'Karan Singh', 'karan@nmiet.in', '9810000005', 'ECE', 2, 3, 'A', null, 'B.Tech', '2026-27', '7.2', 1, '2022-2026'],
            ['S06', '21ME001', 'Ishita Nair', 'ishita@nmiet.in', '9810000006', 'ME', 2, 3, 'A', null, 'B.Tech', '2026-27', '8.0', 0, '2022-2026'],
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
        'courses' => [
            ['C01', 'CS501', 'Data Structures & Algorithms', 'CSE', 5, 4, 'F01', 'A'],
            ['C02', 'CS502', 'Database Management Systems', 'CSE', 5, 4, 'F02', 'A'],
            ['C03', 'CS503', 'Operating Systems', 'CSE', 5, 3, 'F01', 'A'],
            ['C04', 'EC301', 'Digital Electronics', 'ECE', 3, 4, 'F03', 'A'],
            ['C05', 'ME301', 'Thermodynamics', 'ME', 3, 4, 'F04', 'A'],
            ['C06', 'CS501', 'Data Structures & Algorithms', 'CSE', 5, 4, 'F02', 'B'],
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
            ['FE01', 'S01', 185000, 185000, '2026-07-31', 5, '2026-27'],
            ['FE02', 'S02', 185000, 100000, '2026-07-31', 5, '2026-27'],
            ['FE03', 'S03', 185000, 0, '2026-07-31', 5, '2026-27'],
            ['FE04', 'S04', 185000, 185000, '2026-07-31', 5, '2026-27'],
            ['FE05', 'S05', 165000, 80000, '2026-07-31', 3, '2026-27'],
            ['FE06', 'S06', 165000, 165000, '2026-07-31', 3, '2026-27'],
        ],
        'fixedfees' => [
            ['FF01', 'B.Tech', 'CSE', '2026-27', 'Tuition Fee',     150000, '2026-06-01', 'Active'],
            ['FF02', 'B.Tech', 'CSE', '2026-27', 'Examination Fee',   8000, '2026-06-01', 'Active'],
            ['FF03', 'B.Tech', 'CSE', '2026-27', 'Laboratory Fee',   12000, '2026-06-01', 'Active'],
            ['FF04', 'B.Tech', 'CSE', '2026-27', 'Library Fee',       5000, '2026-06-01', 'Active'],
            ['FF05', 'B.Tech', 'CSE', '2026-27', 'Development Fee',  10000, '2026-06-01', 'Active'],
            ['FF06', 'B.Tech', 'ECE', '2026-27', 'Tuition Fee',     140000, '2026-06-01', 'Active'],
            ['FF07', 'B.Tech', 'ECE', '2026-27', 'Examination Fee',   8000, '2026-06-01', 'Active'],
            ['FF08', 'B.Tech', 'ME',  '2026-27', 'Tuition Fee',     140000, '2026-06-01', 'Active'],
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
            ['AS05', 'Digital Oscilloscope', 'Laboratory Equipment', 8, '2025-03-11', 640000, 576000,
             'Tektronix', 'Electronics Lab', 'In Use'],
            ['AS06', 'Cisco 24-Port Switch', 'Networking Equipment', 6, '2024-11-02', 210000, 147000,
             'Cisco Systems', 'Server Room', 'In Use'],
            ['AS07', 'Canon LBP Printer', 'Printer', 9, '2023-12-15', 189000, 94500,
             'Canon India', 'Admin Office', 'Under Maintenance'],
            ['AS08', 'Library Book Rack', 'Library Equipment', 45, '2022-08-09', 337500, 168750,
             'Godrej Interio', 'Central Library', 'In Use'],
        ],
        'timetable' => [
            ['T01', 'CSE', 5, 'A', 'Mon', 1, 'C01', '08:30', '09:30', '403'],
            ['T02', 'CSE', 5, 'A', 'Mon', 2, 'C02', '09:30', '10:30', '403'],
            ['T03', 'CSE', 5, 'A', 'Tue', 1, 'C03', '08:30', '09:30', '403'],
            ['T04', 'CSE', 5, 'A', 'Wed', 2, 'C01', '09:30', '10:30', '403'],
            ['T05', 'CSE', 5, 'A', 'Thu', 1, 'C02', '08:30', '09:30', '403'],
            ['T06', 'CSE', 5, 'A', 'Fri', 3, 'C03', '10:30', '11:30', '403'],
        ],
        'books' => [
            ['B01', 'Introduction to Algorithms', 'Cormen, Leiserson, Rivest', '9780262033848', 'Computer Science', 5, 4],
            ['B02', 'Database System Concepts', 'Silberschatz, Korth', '9780073523323', 'Computer Science', 4, 4],
            ['B03', 'Operating System Concepts', 'Silberschatz, Galvin', '9781118063330', 'Computer Science', 3, 2],
            ['B04', 'Digital Design', 'M. Morris Mano', '9780132774208', 'Electronics', 4, 4],
            ['B05', 'Engineering Thermodynamics', 'P. K. Nag', '9780070151314', 'Mechanical', 3, 3],
            ['B06', 'The C Programming Language', 'Kernighan & Ritchie', '9780131103627', 'Computer Science', 6, 5],
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
            ['CO03', 'Bosch India', null, 'Manufacturing / Engineering', 'https://www.bosch.in', 'Pune',
             'Sneha Kulkarni', 'sneha.kulkarni@bosch.in', '9845010003',
             'Engineering and technology group; recruits for embedded and mechanical roles.'],
        ],
        'drives' => [
            ['DR01', 'CO01', 'Systems Engineer',
             'Entry-level engineering role covering application development, testing and support.',
             450000, 'Bengaluru', 40, 'B.Tech', 'CSE,ECE,IT', '6.5', 1,
             '2026-09-10', '2026-08-10', '2026-09-05', '2026-09-12',
             'Online Test -> Technical Interview -> HR Interview', 'Published', '2026-08-08'],
            ['DR02', 'CO02', 'Assistant System Engineer',
             'Ninja profile through the TCS National Qualifier Test.',
             350000, 'Hyderabad', 60, 'B.Tech', 'CSE,ECE,ME,IT', '6.0', 2,
             '2026-09-20', '2026-08-15', '2026-09-15', '2026-09-22',
             'NQT -> Technical Interview -> HR Interview', 'Published', '2026-08-08'],
            ['DR03', 'CO03', 'Graduate Engineer Trainee',
             'Embedded systems and mechanical design roles for the 2026 batch.',
             620000, 'Pune', 15, 'B.Tech', 'ECE,ME', '7.0', 0,
             '2026-10-05', '2026-09-01', '2026-09-28', '2026-10-07',
             'Aptitude Test -> Group Discussion -> Technical Interview', 'Draft', null],
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
        ],
    ];
}
