/* ===== NMIET CMS — Application logic ===== */
(function () {
  'use strict';

  let user = null;            // logged-in user
  let currentView = 'dashboard';

  /* ---------- tiny helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  // small circular table thumbnail — actual photo if set, else the name's first letter
  const avatarHtml = (photo, name) => photo
    ? `<img src="${esc(photo)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;display:block">`
    : `<span style="width:32px;height:32px;border-radius:50%;background:var(--primary,#123f8c);color:#fff;
        display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px">${esc((name||'?')[0])}</span>`;

  /* ---------- pagination (shared by every list table) ---------- */
  const PAGE_SIZE = 10;
  function pageSlice(rows, page) {
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }
  function pageCount(total) {
    return Math.max(1, Math.ceil(total / PAGE_SIZE));
  }
  function pagerHtml(total, page) {
    const pages = pageCount(total);
    if (total <= PAGE_SIZE) return '';
    return `<div class="pager">
      <span class="pager-info">${total} total · Page ${page} of ${pages}</span>
      <button type="button" class="btn-sm btn-outline" data-pg="prev" ${page<=1?'disabled':''}>‹ Prev</button>
      <button type="button" class="btn-sm btn-outline" data-pg="next" ${page>=pages?'disabled':''}>Next ›</button>
    </div>`;
  }
  // wires the Prev/Next buttons inside `pagerEl`; calls setPage(newPage) then redraws
  function bindPager(pagerEl, total, page, setPage, redraw) {
    if (!pagerEl) return;
    const pages = pageCount(total);
    pagerEl.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => {
      if (b.dataset.pg === 'prev' && page > 1) { setPage(page - 1); redraw(); }
      if (b.dataset.pg === 'next' && page < pages) { setPage(page + 1); redraw(); }
    });
  }

  function toast(msg, type = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + type;
    setTimeout(() => t.classList.add('hidden'), 2600);
  }

  function openModal(title, html, wide) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modalOverlay').querySelector('.modal').classList.toggle('modal-wide', !!wide);
    $('#modalOverlay').classList.remove('hidden');
  }
  function closeModal() { $('#modalOverlay').classList.add('hidden'); }

  /* The second layer. A list picker is opened from inside a form, and reusing
     the one modal would throw the half-filled form away. */
  function openModal2(title, html, wide) {
    $('#modal2Title').textContent = title;
    $('#modal2Body').innerHTML = html;
    $('#modal2Overlay').querySelector('.modal').classList.toggle('modal-wide', !!wide);
    $('#modal2Overlay').classList.remove('hidden');
  }
  function closeModal2() { $('#modal2Overlay').classList.add('hidden'); }

  /* ---------- lookups ---------- */
  const courseName = (id) => { const c = Store.find('courses', id); return c ? `${c.code} — ${c.name}` : '—'; };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const facultyName = (id) => { const f = Store.find('faculty', id); return f ? f.name : '—'; };
  const studentName = (id) => { const s = Store.find('students', id); return s ? s.name : '—'; };

  /* ---------- admin-controlled feature switches ---------- */
  const SET_STUDENT_FEES = 'studentFeesVisible';
  function settingRow(name) { return Store.all('settings').find(x => x.name === name); }
  /* Faculty mark attendance only while the admin leaves this on; the
     coordinator and the admin always may. The server enforces the same rule —
     this only decides whether the page is offered. */
  function facultyAttendanceOn() { return settingOn('facultyAttendance', true); }
  function canMarkAttendance() {
    if (!user) return false;
    if (['admin', 'course_coordinator'].includes(user.role)) return true;
    return user.role === 'faculty' && facultyAttendanceOn();
  }

  function settingOn(name, dflt) {
    const row = settingRow(name);
    return row ? String(row.value) === '1' : dflt;
  }
  function setSetting(name, on) {
    const row = settingRow(name);
    const value = on ? '1' : '0';
    if (row) Store.update('settings', row.id, { value });
    else Store.add('settings', { name, value });
  }
  // when the admin turns this off, students lose the My Fees page entirely
  function studentFeesVisible() { return settingOn(SET_STUDENT_FEES, true); }

  /* ---------- grade logic ----------
     The college is affiliated, not autonomous: external/university exams are not
     conducted here, so only internal marks are recorded and every grade is
     derived from the internal score alone. */
  const INTERNAL_MAX = 40;
  function markPercent(m) {
    if (!m || m.internal === null || m.internal === undefined || m.internal === '') return null;
    return Math.round(((+m.internal || 0) / INTERNAL_MAX) * 100);
  }
  function gradeFor(total) {
    if (total >= 90) return { g: 'O',  p: 10 };
    if (total >= 80) return { g: 'A+', p: 9 };
    if (total >= 70) return { g: 'A',  p: 8 };
    if (total >= 60) return { g: 'B+', p: 7 };
    if (total >= 50) return { g: 'B',  p: 6 };
    if (total >= 40) return { g: 'C',  p: 5 };
    return { g: 'F', p: 0 };
  }
  function studentAttendancePct(sid) {
    const sessions = Store.all('attendance').filter(a => sid in a.records);
    if (!sessions.length) return null;
    const present = sessions.filter(a => a.records[sid] === 'P').length;
    return Math.round((present / sessions.length) * 100);
  }
  function studentGPA(sid) {
    const ms = Store.all('marks').filter(m => m.studentId === sid);
    if (!ms.length) return null;
    let pts = 0, cr = 0;
    ms.forEach(m => {
      const c = Store.find('courses', m.courseId);
      const credits = c ? c.credits : 0;
      pts += gradeFor(markPercent(m) || 0).p * credits;
      cr += credits;
    });
    return cr ? (pts / cr).toFixed(2) : null;
  }

  /* =========================================================
     ROLE CAPABILITIES — the UI half of the RBAC in api/config.php.

       ADMIN        full access
       ACCOUNTANT   full access to the finance modules
       CENTER_HEAD  view / search / filter / sort / report / print / export
                    across the whole college — and nothing else
       FACULTY / LIBRARIAN / STUDENT   unchanged

     Hiding a button is a courtesy, not a permission: every write is refused by
     the server (api/index.php) and by Store itself, so a read-only role cannot
     change data even by calling the API directly.
     ========================================================= */
  const READ_ONLY_ROLES = ['center_head'];
  const ROLE_LABEL = {
    admin: 'Admin', accountant: 'Accountant', center_head: 'Center Head',
    placement_officer: 'Placement Officer', course_coordinator: 'Course Coordinator',
    admission: 'Admission Officer',
    faculty: 'Faculty', librarian: 'Librarian', student: 'Student',
  };
  /** the placement cell — the admin runs everything, the officer runs placement */
  const PLACEMENT_MANAGE_ROLES = ['admin', 'placement_officer'];
  function canManagePlacement() { return !!user && PLACEMENT_MANAGE_ROLES.includes(user.role); }
  function isPlacementOfficer() { return !!user && user.role === 'placement_officer'; }
  /** true for a role that may only look at data, never change it */
  function roleReadOnly() { return !!user && READ_ONLY_ROLES.includes(user.role); }
  /* True when nothing on the page the user is looking at may be changed —
     either because the role never writes, or because the module this page
     belongs to was given to the account for viewing only. Every view asks this
     before it draws an Add, Edit or Delete button, so the second case needs no
     separate handling anywhere. */
  /* Every page hangs its Add, Edit and Delete controls off this one answer, so
     a module granted for viewing draws none of them without each page having
     to learn the rule. `canHere(action)` is the finer question, for the pages
     that separate Add from Import from Export. */
  function readOnly() {
    const m = moduleOfView(splitViewKey(currentView).view);
    if (!m) return roleReadOnly();
    return !can(m, 'add') && !can(m, 'edit') && !can(m, 'delete');
  }
  /* The one write a read-only role keeps: the center head approves requisitions.
     Kept in step with READ_ONLY_WRITE_EXCEPTIONS in api/config.php. */
  function readOnlyWritable() {
    return user && user.role === 'center_head' ? { requisitions: ['update'] } : {};
  }
  /* The same answer the buttons got, in the shape Store checks — so a request
     the screen would not have offered is refused before it leaves the browser
     too. The server refuses it again regardless; this is only so a bug shows up
     as a blocked write rather than a silent one.

     An account nobody has narrowed keeps exactly what its role always had: the
     guard is switched on only once there is something to enforce. */
  function applyReadOnly() {
    if (!user || user.role === 'admin') { Store.setReadOnly(false, {}); return; }
    const base = baseRoleOf(user.role);
    const narrowed = !!rolePerms(user.role) || !!userPerms(user)
      || READ_ONLY_ROLES.includes(base) || !!ROLE_CARVE_OUTS[base];
    if (!narrowed) { Store.setReadOnly(false, {}); return; }
    const allow = {};
    MODULES.forEach(([key, , , write]) => {
      const acts = PERMS[key] || [];
      (write || []).forEach(col => {
        const ops = new Set(allow[col] || []);
        if (acts.includes('add') || acts.includes('import')) ops.add('add');
        if (acts.includes('edit') || acts.includes('approve') || acts.includes('manage')) ops.add('update');
        if (acts.includes('delete')) ops.add('remove');
        if (ops.size) allow[col] = [...ops];
      });
    });
    Store.setReadOnly(true, allow);
  }
  /** true for a role that may look at the master data but never change it */
  function viewsMasterOnly() {
    return readOnly() || (!!user && ['course_coordinator', 'admission'].includes(user.role));
  }
  /** roles whose scope is the whole college: the admin runs it, the center head watches it */
  function collegeWide() { return !!user && (user.role === 'admin' || user.role === 'center_head'); }
  /* ---------- actions ----------
     What can be done inside a module. One list, drawn by the permission screen
     and checked by the server, so a box ticked there is the box the API reads. */
  const ACTIONS = [
    ['view', 'View'], ['add', 'Add'], ['edit', 'Edit'], ['delete', 'Delete'],
    ['import', 'Import'], ['export', 'Export'], ['print', 'Print'],
    ['approve', 'Approve'], ['manage', 'Manage'], ['reports', 'Reports'],
  ];
  const ACTION_KEYS = ACTIONS.map(([k]) => k);
  /** what a role that may look and never touch is allowed */
  const READ_ACTIONS = ['view', 'export', 'print', 'reports'];
  /** the actions that change something — what Store and the API gate on */
  const WRITE_ACTIONS = ['add', 'edit', 'delete', 'import', 'approve', 'manage'];
  const BUILTIN_ROLES = Object.keys(ROLE_LABEL);

  /* ---------- roles ----------
     A row exists only for a role the admin has edited and for every custom
     role. No row means "everything this role's ceiling allows", which is what
     every login did before any of this — so there was nothing to migrate. */
  function roleRow(key) {
    return Store.all('roles').find(r => String(r.key) === String(key)) || null;
  }
  /** every role that can be assigned, built-in and custom, in a stable order */
  function allRoleKeys() {
    const custom = Store.all('roles').filter(r => !BUILTIN_ROLES.includes(r.key))
      .map(r => r.key).sort();
    return BUILTIN_ROLES.concat(custom);
  }
  /* The built-in role a custom one takes its menu shape and its ceiling from.
     A custom role is a narrowing of something the code already supports, never
     a new kind of user the pages have never been written for. */
  function baseRoleOf(key) {
    const r = roleRow(key);
    if (r && r.base && BUILTIN_ROLES.includes(r.base)) return r.base;
    return BUILTIN_ROLES.includes(key) ? key : 'faculty';
  }
  /** the label shown in the top bar and the sidebar */
  function roleLabel(role) {
    const r = roleRow(role);
    return (r && r.label) || ROLE_LABEL[role] || role;
  }
  const ROLE_LIST = Object.keys(ROLE_LABEL);

  /* ---------- who the college employs ----------
     Derived from ROLE_LABEL rather than listed a second time, so a role added
     there is offered on the Employees form the same day and there is only ever
     one place a role is defined. The student is the one role left out: a
     student is enrolled, not employed. */
  function employeeRoles() { return ROLE_LIST.filter(r => r !== 'student'); }
  /* Records written before the register carried a role are faculty — that is
     the only kind of employee it could hold. */
  function employeeRole(f) { return (f && f.role) || 'faculty'; }
  /** the role key behind whatever was written — "Center Head", "center_head", "CENTERHEAD" */
  function roleKeyFromLabel(v) {
    const k = String(v || '').trim().toLowerCase().replace(/[^a-z]+/g, '');
    if (!k) return '';
    return employeeRoles().find(r => r.replace(/[^a-z]+/g, '') === k
      || roleLabel(r).toLowerCase().replace(/[^a-z]+/g, '') === k) || '';
  }

  /* ========================================================= */
  /*  AUTH                                                      */
  /* ========================================================= */
  async function doLogin(e) {
    e.preventDefault();
    const u = $('#loginUser').value.trim();
    const p = $('#loginPass').value;
    const btn = $('#loginForm button[type="submit"]');
    $('#loginError').textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in...';
    try {
      // no role picker — the account the credentials belong to sets the role
      const found = await Store.login(u, p);
      if (!found || found.error) {
        $('#loginError').textContent = (found && found.error) || 'Invalid username or password.';
        return;
      }
      user = found;
      /* Store.login() has already kept the token; this records who it belongs
         to. Both have to be in place before the first load(), because the
         server answers 401 to a request that carries neither. */
      Store.setUser(found.id, found.token);
      delete user.token;   // held by the store alone, never by a page
      applyReadOnly();
      await Store.load();
      startApp();
    } catch (err) {
      // Sign-in itself can succeed and the load right after it still fail, so
      // this must not claim the server is unreachable — and telling a college
      // office to run a dev server was never useful advice.
      $('#loginError').textContent =
        'Signed in, but the app could not load its data. Please try again in a moment.';
    } finally {
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  }

  function logout() {
    user = null;
    // tell the server to forget the token first; a copy left behind is a session
    Store.logout();
    Store.setReadOnly(false);
    document.body.classList.remove('read-only');
    stopDashboardPolling();
    $('#appScreen').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
    $('#loginForm').reset();
    $('#loginError').textContent = '';
  }

  // ---- live dashboard refresh: re-pull from server every 15s while the
  // dashboard is the open view, so numbers/charts update without a reload ----
  let dashboardPollTimer = null;
  function startDashboardPolling() {
    stopDashboardPolling();
    dashboardPollTimer = setInterval(async () => {
      if (!user || currentView !== 'dashboard') { stopDashboardPolling(); return; }
      try {
        await Store.load();
        if (user && currentView === 'dashboard') render();
      } catch (e) { /* server hiccup — try again next tick */ }
    }, 15000);
  }
  function stopDashboardPolling() {
    if (dashboardPollTimer) { clearInterval(dashboardPollTimer); dashboardPollTimer = null; }
  }

  /* ========================================================= */
  /*  NAV + ROUTER                                              */
  /* ========================================================= */
  // a ['--', '', 'Label'] entry draws a sub-heading instead of a clickable item
  const NAV_SECTION = '--';
  /* A [NAV_LINK, ico, label, url] entry opens an external site in a new tab
     instead of routing to a view. Used for services the college runs outside
     this CMS, such as the biometric attendance portal. */
  const NAV_LINK = '>>';
  /* A [NAV_GROUP, ico, label, key, children] entry is a page with a short list
     under it. The parent still opens the page unfiltered; each child opens it
     narrowed to one kind. */
  const NAV_GROUP = '::';
  /** the filter a submenu entry opened the page with, '' for the plain page */
  let viewPreset = '';
  /* What the cell is running, in its own words: a company visits campus, or
     recruits off it, or takes summer interns, or comes through the national
     test. Declared here because the sidebar lists them under Placement Drives. */
  const DRIVE_TYPES = ['On Campus', 'Off Campus', 'Summer Placement', 'NTA'];
  // the mark-attendance page itself, not the portal root — /emp/ only lands on
  // the login index, which is a step further from what staff actually need
  const EMP_ATTENDANCE_URL = 'https://pinnacle.myattendance.co.in/emp/add_attendance';
  const EMP_ATTENDANCE = [NAV_LINK, '🕐', 'Employee Attendance', EMP_ATTENDANCE_URL];
  const MENU = {
    admin: [
      ['dashboard','📊','Dashboard'], ['events','📅','Events'], ['students','🎓','Students'],
      ['batchsem','🎯','Semester Update'], ['faculty','🧑‍💼','Employees'],
      ['courses','📚','Courses'], ['syllabus','🧾','Subjects by Semester'],
      ['assignments','🗂️','Assignments'], ['attendance','✅','Attendance'],
      ['attrecords','🗂️','Attendance Records'],
      ['marks','📝','Marks & Results'], ['timetable','🗓️','Timetable'], ['library','📖','Library'], ['reports','📊','Library Reports'], ['fees','💳','Fees'],
      ['accounts','🔑','Login Accounts'],
      // the accounts-office modules — the admin gets every one of them
      [NAV_SECTION,'','Finance'],
      ['finstudents','🎓','Student List'], ['assets','🏢','Asset List'], ['fixedfee','📋','Fixed Fee'],
      ['semfee','📆','Semester-wise Fee'], ['feecollect','💰','Fee Collection'],
      ['payments','🧾','Payment History'], ['pendingfees','⏳','Pending Fees'], ['requisitions','📦','Requisitions'],
      ['finreports','📈','Financial Reports'], ['accountants','🧑‍💼','Accountants'],
      // the placement cell — the admin gets every one of these too, with full rights
      [NAV_SECTION,'','Placement'],
      ['plstudents','🎓','Placement Students'], ['companies','🏢','Companies'],
      [NAV_GROUP,'🚀','Placement Drives','drives',DRIVE_TYPES],
      ['applications','📨','Applications'],
      ['interviews','🎤','Interviews'], ['placements','🏆','Selections'],
      ['offers','📜','Offers'], ['plcalendar','📅','Placement Calendar'],
      ['plreports','📊','Placement Reports'], ['placementofficers','🧑‍💼','Placement Officers'],
      ['usersettings','⚙️','User Management'], ['roles','🛡️','Roles & Permissions'],
      [NAV_SECTION,'','Staff'],
      EMP_ATTENDANCE,
    ],
    // manages the placement cell end to end; read-only on the student records it recruits from
    placement_officer: [
      ['dashboard','📊','Dashboard'], ['students','🎓','All Students'],
      ['plstudents','🎓','Placement Students'],
      ['syllabus','🧾','Subjects by Semester'],
      ['companies','🏢','Companies'],
      [NAV_GROUP,'🚀','Placement Drives','drives',DRIVE_TYPES],
      ['applications','📨','Applications'], ['interviews','🎤','Interviews'],
      ['placements','🏆','Selections'], ['offers','📜','Offers'],
      ['plcalendar','📅','Placement Calendar'], ['plreports','📊','Reports'],
      ['events','🔔','Notifications'], EMP_ATTENDANCE, ['profile','👤','Profile'],
    ],
    // read-only monitoring role — the same modules the admin sees, no actions.
    // Every page below renders without a single Add/Edit/Delete/Approve control.
    center_head: [
      ['dashboard','📊','Dashboard'], ['students','🎓','All Students'], ['faculty','🧑‍💼','Employees'],
      ['departments','🏛️','Departments'], ['courses','📚','Courses'], ['branches','🌿','Specialisations'],
      ['syllabus','🧾','Subjects by Semester'],
      ['attendance','✅','Attendance'], ['timetable','🗓️','Timetable'],
      [NAV_SECTION,'','Fees & Finance'],
      ['finstudents','🎓','Student List'], ['fixedfee','📋','Fixed Fee'],
      ['semfee','📆','Semester-wise Fee'], ['payments','🧾','Payment History'],
      ['pendingfees','⏳','Pending Fees'],
      [NAV_SECTION,'','Monitoring'],
      ['assets','🏢','Assets'], ['library','📖','Library'], ['chreports','📈','Reports'],
      // the one thing this role decides rather than just watches
      ['requisitions','📦','Approvals'],
      ['events','🔔','Notifications'], EMP_ATTENDANCE, ['profile','👤','Profile'],
    ],
    accountant: [
      ['dashboard','📊','Dashboard'], ['students','🎓','All Students'],
      ['finstudents','🎓','Student List'], ['assets','🏢','Asset List'],
      ['fixedfee','📋','Fixed Fee'], ['semfee','📆','Semester-wise Fee'], ['feecollect','💰','Fee Collection'],
      ['payments','🧾','Payment History'], ['pendingfees','⏳','Pending Fees'], ['requisitions','📦','Requisitions'],
      ['finreports','📈','Reports'], EMP_ATTENDANCE, ['profile','👤','Profile'],
    ],
    faculty: [
      ['dashboard','📊','Dashboard'], ['events','📅','Events'], ['students','🎓','Students'], ['attendance','✅','Attendance'],
      ['marks','📝','Marks & Results'], ['timetable','🗓️','Timetable'],
      ['syllabus','🧾','Subjects by Semester'], ['goodsreq','📦','Goods Requisition'],
      EMP_ATTENDANCE, ['profile','👤','My Profile'],
    ],
    student: [
      ['dashboard','📊','Dashboard'], ['events','📅','Events'], ['myattendance','✅','My Attendance'], ['myresults','📝','My Results'],
      ['timetable','🗓️','Timetable'], ['syllabus','🧾','Subjects by Semester'],
      ['mybooks','📖','My Library'], ['myfees','💳','My Fees'],
      ['myplacement','🏆','My Placement'], ['profile','👤','My Profile'],
    ],
    /* The admissions desk enrols students and corrects them. Courses and the
       scheme are there because an admission has to be put on one. */
    admission: [
      ['dashboard','📊','Dashboard'], ['students','🎓','All Students'],
      ['courses','📚','Courses'], ['syllabus','🧾','Subjects by Semester'],
      ['events','📅','Events'], EMP_ATTENDANCE, ['profile','👤','Profile'],
    ],
    /* The coordinator runs attendance and reads what it is built from. Nothing
       here writes master data — the server refuses it either way. */
    course_coordinator: [
      ['dashboard','📊','Dashboard'], ['attendance','✅','Attendance'],
      ['attrecords','🗂️','Attendance Records'],
      ['students','🎓','Students'], ['courses','📚','Courses'],
      ['syllabus','🧾','Subjects by Semester'], ['timetable','🗓️','Timetable'],
      ['events','📅','Events'], EMP_ATTENDANCE, ['profile','👤','Profile'],
    ],
    librarian: [
      ['dashboard','📊','Dashboard'], ['library','📖','Library'], ['issueBook','⬇️','Issue a Book'],
      ['returnBook','⬆️','Return a Book'], ['bookreq','📚','Book Requisition'],
      ['students','🎓','Students'], ['syllabus','🧾','Subjects by Semester'],
      ['events','📅','Events'], ['reports','📊','Reports'],
      EMP_ATTENDANCE,
    ],
  };

  // the role's menu after applying the admin's feature switches
  /* The menu a built-in role has always had, before anybody was narrowed. The
     ceiling is worked out from this, so it must not depend on the account. */
  function rawMenu(role) {
    let items = MENU[role] || [];
    if (role === 'student' && !studentFeesVisible()) items = items.filter(([key]) => key !== 'myfees');
    if (role === 'faculty' && !facultyAttendanceOn()) items = items.filter(([key]) => key !== 'attendance');
    return items;
  }
  /* What this account actually sees. A custom role has no menu of its own — it
     borrows the shape of the role it is based on, and its permissions cut that
     down. Section headings and the external link are structure rather than
     pages, so they survive the filter; a section left with nothing under it is
     dropped afterwards. */
  function menuFor(u) {
    const role = typeof u === 'string' ? u : baseRoleOf((u || {}).role);
    let items = rawMenu(role);
    const allowed = (key) => {
      if (ALWAYS_ALLOWED.includes(key)) return true;
      const m = moduleOfView(key);
      return m ? can(m, 'view') : true;
    };
    items = items.filter(([key, , , url]) =>
      key === NAV_SECTION || key === NAV_LINK
      || allowed(key === NAV_GROUP ? url : key));
    return items.filter(([key], i) =>
      key !== NAV_SECTION || items.slice(i + 1).some(([k]) => k !== NAV_SECTION));
  }

  function buildNav() {
    refreshPerms();
    const nav = $('#navMenu');
    /* A custom role reads its own name over the menu it borrowed — the person
       signed in knows what they were made, not what it was built from. */
    const label = BUILTIN_ROLES.includes(user.role)
      ? ({ admin: 'Administration', faculty: 'Faculty Menu', student: 'Student Menu',
           librarian: 'Library Menu', accountant: 'Accounts Menu',
           center_head: 'Center Head · View Only',
           placement_officer: 'Placement Cell' }[user.role] || 'Menu')
      : roleLabel(user.role);
    nav.innerHTML = `<div class="nav-section">${label}</div>`;
    menuFor(user).forEach(([key, ico, txt, url, kids]) => {
      /* A group renders its own row plus one indented row per child. The
         child's key carries the filter — "drives::On Campus" — so the router
         needs no special case and the active highlight still works. */
      if (key === NAV_GROUP) {
        const parent = document.createElement('div');
        parent.className = 'nav-item' + (currentView === url ? ' active' : '');
        parent.title = txt;
        parent.innerHTML = `<span class="ico">${ico}</span><span>${txt}</span>`;
        parent.onclick = () => navigate(url);
        nav.appendChild(parent);
        (kids || []).forEach((kid) => {
          const childKey = `${url}${NAV_GROUP}${kid}`;
          const child = document.createElement('div');
          child.className = 'nav-item nav-child' + (currentView === childKey ? ' active' : '');
          child.title = kid;
          child.innerHTML = `<span class="ico">•</span><span>${esc(kid)}</span>`;
          child.onclick = () => navigate(childKey);
          nav.appendChild(child);
        });
        return;
      }
      if (key === NAV_SECTION) {
        const head = document.createElement('div');
        head.className = 'nav-section nav-section-mid';
        head.textContent = txt;
        nav.appendChild(head);
        return;
      }
      // an external service opens in its own tab, so the CMS session is kept
      if (key === NAV_LINK) {
        const a = document.createElement('a');
        a.className = 'nav-item nav-link';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = txt + ' — opens in a new tab';
        a.innerHTML = `<span class="ico">${ico}</span><span>${txt}</span><span class="nav-ext">↗</span>`;
        nav.appendChild(a);
        return;
      }
      const div = document.createElement('div');
      div.className = 'nav-item' + (key === currentView ? ' active' : '');
      div.title = txt;
      div.innerHTML = `<span class="ico">${ico}</span><span>${txt}</span>`;
      div.onclick = () => navigate(key);
      nav.appendChild(div);
    });
  }

  /* Server-side rules are the real gate (see api/index.php); this keeps a role
     from opening a page it has no business seeing even by hand. */
  /** "drives::On Campus" -> { view: 'drives', preset: 'On Campus' } */
  function splitViewKey(key) {
    const at = String(key || '').indexOf(NAV_GROUP);
    return at === -1 ? { view: key, preset: '' }
                     : { view: key.slice(0, at), preset: key.slice(at + NAV_GROUP.length) };
  }

  /* The one question the router asks, and the same one the sidebar asked to
     decide whether to draw the item at all. The API refuses the same pages'
     writes either way — this only keeps a page from being opened by hand. */
  function canView(key) {
    const { view } = splitViewKey(key);
    if (ALWAYS_ALLOWED.includes(view)) return true;
    /* A student's file is reached from the roll rather than from the sidebar,
       so it is open to whoever may open the roll itself. */
    if (view === 'stuprofile') return canView('students');
    if (view === 'facprofile') return canView('faculty');
    const m = moduleOfView(view);
    if (m && !can(m, 'view')) return false;
    return rawMenu(baseRoleOf(user.role)).some(([k, , , url]) =>
      k === view || (k === NAV_GROUP && url === view));
  }

  function navigate(key) {
    // the sidebar stays in the DOM after logout (the app screen is just hidden),
    // so ignore a stray click that arrives once the session is gone
    if (!user) return;
    currentView = key;
    buildNav();
    $('.sidebar').classList.remove('open');
    render();
    if (key === 'dashboard') startDashboardPolling(); else stopDashboardPolling();
  }

  // sidebar close/open: desktop -> collapse to icon rail (remembered); mobile -> slide in/out
  const SIDEBAR_KEY = 'nmiet_sidebar_collapsed';
  function toggleSidebar() {
    if (window.innerWidth <= 860) {
      $('.sidebar').classList.toggle('open');
    } else {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    }
  }

  /* One entry per part of the college — the same list the API holds, because
     the menu here is a convenience and the API is the rule. */
  /* key, label, the pages it opens, and the collections it may write. The
     write lists are the same ones MODULES carries in api/config.php — the
     server is what actually refuses a change; these let the screen agree with
     it instead of offering a button that always fails. */
  const MODULES = [
    ['students',     'Students',                    ['students', 'stuprofile', 'batchsem'],
                                                    ['students', 'users']],
    ['staff',        'Faculty & Staff',             ['faculty', 'facprofile', 'accountants', 'placementofficers'],
                                                    ['faculty', 'accountants', 'centerheads', 'placementofficers',
                                                     'coordinators', 'admissions', 'users']],
    ['academics',    'Courses & Curriculum',        ['courses', 'syllabus', 'assignments', 'timetable'],
                                                    ['courses', 'syllabus', 'timetable']],
    ['attendance',   'Attendance',                  ['attendance', 'attrecords'],
                                                    ['attendance']],
    ['marks',        'Marks & Results',             ['marks'],
                                                    ['marks']],
    ['fees',         'Fees & Finance',              ['fees', 'finstudents', 'fixedfee', 'semfee', 'feecollect',
                                                     'payments', 'pendingfees', 'finreports'],
                                                    ['fees', 'fixedfees', 'payments']],
    ['assets',       'Assets',                      ['assets'],
                                                    ['assets']],
    ['requisitions', 'Requisitions',                ['requisitions', 'goodsreq', 'bookreq'],
                                                    ['requisitions']],
    ['library',      'Library',                     ['library', 'issueBook', 'returnBook', 'reports'],
                                                    ['books', 'issues']],
    ['placement',    'Placement Cell',              ['plstudents', 'companies', 'drives', 'applications',
                                                     'interviews', 'placements', 'offers', 'plcalendar', 'plreports'],
                                                    ['companies', 'drives', 'applications', 'interviews',
                                                     'offers', 'placementevents']],
    ['events',       'Events & Notices',            ['events'],
                                                    ['events']],
    ['reports',      'Reports & Departments',       ['chreports', 'departments', 'branches'],
                                                    []],
    ['system',       'Users, Roles & Settings',     ['accounts', 'usersettings', 'roles'],
                                                    ['users', 'settings', 'roles', 'auditlog']],
  ];
  /* Pages nobody is ever narrowed out of: the dashboard they land on and the
     pages that are about themselves. */
  const ALWAYS_ALLOWED = ['dashboard', 'profile', 'myattendance', 'myresults', 'myfees',
                          'mybooks', 'myplacement'];

  /* ---------- the ceiling ----------
     What the code supports for a role, as module => actions. A permission can
     narrow this and can never exceed it: a fees screen assumes an accountant,
     so ticking Fees for a librarian would hand them a page nobody has written.
     That cap is also what makes an escalation impossible — every edit on the
     permission screen moves in one direction. */
  const ROLE_CARVE_OUTS = {
    // read-only monitoring, except the one thing it decides
    center_head: { readOnly: true, extra: { requisitions: ['approve'] } },
    // exists to run attendance, and writes nothing else
    course_coordinator: { readOnly: true, extra: { attendance: ['add', 'edit', 'delete'] } },
    // enrols and corrects; removing a student is not its call
    admission: { readOnly: true, extra: { students: ['add', 'edit', 'import'] } },
  };
  const CEILING_CACHE = {};
  function roleCeiling(role) {
    if (CEILING_CACHE[role]) return CEILING_CACHE[role];
    const out = {};
    if (role === 'admin') {
      MODULES.forEach(([key]) => { out[key] = ACTION_KEYS.slice(); });
      return (CEILING_CACHE[role] = out);
    }
    const views = roleViewKeys(role);
    const carve = ROLE_CARVE_OUTS[role];
    MODULES.forEach(([key, , mviews]) => {
      if (!mviews.some(v => views.has(v))) return;
      let acts = carve && carve.readOnly ? READ_ACTIONS.slice() : ACTION_KEYS.slice();
      const extra = carve && carve.extra && carve.extra[key];
      if (extra) acts = [...new Set(acts.concat(extra))];
      out[key] = ACTION_KEYS.filter(a => acts.includes(a));   // always in the one order
    });
    return (CEILING_CACHE[role] = out);
  }

  /* A stored permission set, in whatever shape it was saved. The two-level
     form predates actions, so it is read rather than rewritten: an account
     narrowed years ago keeps working and means the same thing it always did. */
  function readPermSet(raw) {
    const val = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw); } catch (e) { return null; } })() : raw;
    if (Array.isArray(val)) {
      // the oldest form: a plain list of module keys, which meant full access
      const out = {};
      val.forEach(k => { if (k) out[String(k)] = ACTION_KEYS.slice(); });
      return out;
    }
    if (!val || typeof val !== 'object') return null;
    const out = {};
    Object.keys(val).forEach(k => {
      const v = val[k];
      if (!v) return;
      if (Array.isArray(v)) out[k] = v.filter(a => ACTION_KEYS.includes(a));
      else if (v === 'view') out[k] = READ_ACTIONS.slice();
      else out[k] = ACTION_KEYS.slice();          // 'edit', true, 1 — the old full grant
    });
    return out;
  }
  /** the role template, or null when the role has never been narrowed */
  function rolePerms(key) {
    const r = roleRow(key);
    return r ? readPermSet(r.permissions) : null;
  }
  /** the per-user override, or null when the account is not narrowed */
  function userPerms(u) {
    if (!u || (u.access || 'full') !== 'restricted') return null;
    return readPermSet(u.permissions) || {};
  }

  /* ---------- what this account may actually do ----------
     ceiling ∩ role template ∩ user override. The override wins over the
     template — that is the priority, and it is the same everywhere — but both
     are capped by the ceiling, so neither can hand out more than the code has. */
  function effectivePerms(u) {
    if (!u) return {};
    const ceiling = roleCeiling(baseRoleOf(u.role));
    if (u.role === 'admin') return ceiling;      // never narrowed, never lost
    const role = rolePerms(u.role);
    const own = userPerms(u);
    const out = {};
    Object.keys(ceiling).forEach(m => {
      let acts = ceiling[m];
      if (role) acts = acts.filter(a => (role[m] || []).includes(a));
      if (own) acts = acts.filter(a => (own[m] || []).includes(a));
      if (acts.length) out[m] = acts;
    });
    return out;
  }

  /* Worked out once per render rather than per button — a page draws dozens of
     them and the answer cannot change while it is drawing. */
  let PERMS = {};
  function refreshPerms() { PERMS = effectivePerms(user); }
  /** may the signed-in account do this, in this module? */
  function can(module, action) {
    if (user && user.role === 'admin') return true;
    return (PERMS[module] || []).includes(action);
  }
  /** the module a page belongs to, or null for the pages everyone keeps */
  function moduleOfView(viewKey) {
    const owner = MODULES.find(([, , views]) => views.includes(viewKey));
    return owner ? owner[0] : null;
  }
  /** may the signed-in account do this on the page it is looking at? */
  function canHere(action) {
    const m = moduleOfView(splitViewKey(currentView).view);
    return m ? can(m, action) : !roleReadOnly();
  }

  /* What a narrowed account was given, as { moduleKey: 'view' | 'edit' }, or
     null when the account is not narrowed at all. Accounts saved before the
     two levels existed hold a plain list of keys, which meant they could
     change those modules — so a list still reads as 'edit'. */
  function accountPerms(u) {
    if (!u || (u.access || 'full') !== 'restricted') return null;
    const raw = u.permissions;
    const val = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw); } catch (e) { return null; } })() : raw;
    if (Array.isArray(val)) {
      const out = {};
      val.forEach(k => { if (k) out[String(k)] = 'edit'; });
      return out;
    }
    if (val && typeof val === 'object') {
      const out = {};
      Object.keys(val).forEach(k => { if (val[k]) out[k] = val[k] === 'view' ? 'view' : 'edit'; });
      return out;
    }
    return {};
  }
  /** the module keys this account is limited to, or null when it is not */
  function accountModules(u) {
    const perms = accountPerms(u);
    return perms === null ? null : Object.keys(perms);
  }
  /** true when the page belongs to a module this account may only look at */
  function moduleViewOnly(viewKey) {
    const m = moduleOfView(viewKey);
    if (!m || !can(m, 'view')) return false;
    // it opens, and nothing on it writes
    return !can(m, 'add') && !can(m, 'edit') && !can(m, 'delete')
        && !can(m, 'approve') && !can(m, 'manage');
  }
  /** every page key a role's own menu leads to */
  function roleViewKeys(role) {
    const out = new Set(ALWAYS_ALLOWED);
    (rawMenu(role) || []).forEach(([key, , , url]) => {
      if (key === NAV_SECTION || key === NAV_LINK) return;
      out.add(key === NAV_GROUP ? url : key);
    });
    return out;
  }
  /* The modules worth asking about for one role. A placement officer's menu
     never had a Fees page, so offering to grant or withhold Fees says nothing
     — narrowing an account should be a choice among the pages it could
     actually open. A module already saved on the account stays on the list
     whatever the role, so it can be seen and taken away. */
  function modulesForRole(role, perms) {
    const views = roleViewKeys(role);
    return MODULES.filter(([key, , mviews]) =>
      (perms && perms[key]) || mviews.some(v => views.has(v)));
  }
  /** every view key a set of modules covers */
  function viewsForModules(keys) {
    const out = new Set(ALWAYS_ALLOWED);
    MODULES.forEach(([key, , views]) => {
      if (keys.includes(key)) views.forEach(v => out.add(v));
    });
    return out;
  }

  const TITLES = {
    dashboard:'Dashboard', students:'All Students', stuprofile:'Student Profile',
    usersettings:'User Management', roles:'Roles & Permissions',
    faculty:'Employees', facprofile:'Employee Profile', courses:'Courses',
    attendance:'Attendance', attrecords:'Attendance Records', marks:'Marks & Results', timetable:'Timetable', fees:'Fees Management',
    assignments:'Class Assignments', library:'Library Management', mybooks:'My Library',
    myattendance:'My Attendance', myresults:'My Results', myfees:'My Fees',
    myplacement:'My Placement', profile:'My Profile',
    events:'Events', issueBook:'Issue a Book', returnBook:'Return a Book', reports:'Library Reports',
    accounts:'Login Accounts',
    finstudents:'Student List — Fee Overview', assets:'Asset List', fixedfee:'Fixed Fee Structure',
    semfee:'Semester-wise Fee', feecollect:'Fee Collection', payments:'Payment History',
    pendingfees:'Pending Fees', finreports:'Financial Reports', accountants:'Accountants',
    goodsreq:'Goods Requisition', bookreq:'Book Requisition', requisitions:'Requisitions & Approvals',
    batchsem:'Batch Semester Update',
    departments:'Departments', branches:'Specialisations', chreports:'Reports',
    syllabus:'Subjects — Semester wise',
    plstudents:'Students — Placement', companies:'Companies', drives:'Placement Drives',
    applications:'Applications', interviews:'Interviews', placements:'Selections & Placements',
    offers:'Offers', plcalendar:'Placement Calendar', plreports:'Placement Reports',
    placementofficers:'Placement Officers',
  };
  // pages the center head reaches through a different lens than the admin
  const READ_ONLY_TITLES = {
    dashboard: 'Center Head Dashboard', attendance: 'Attendance Overview',
    requisitions: 'Requisition Approvals',
    events: 'Notifications & Events', library: 'Library Overview',
    finstudents: 'Student List — Fee Overview', assets: 'Asset Register',
    profile: 'My Profile',
  };

  /* What somebody sees when they open a page by hand that their account does
     not reach. Deliberately says nothing about what is on the other side. */
  function accessDenied() {
    return `<div class="panel" style="text-align:center;padding:46px 22px">
      <div style="font-size:44px;line-height:1">🔒</div>
      <h3 style="margin:12px 0 6px;color:var(--primary-dark)">Access Denied</h3>
      <p style="color:var(--muted);margin:0 0 18px">
        You do not have permission to access this module.<br>
        Ask the administrator if you need it.</p>
      <button class="btn-primary btn-sm" id="adHome">← Back to Dashboard</button></div>`;
  }

  /* Which action a toolbar control needs. The two patterns are the codebase's
     own naming — a button that prints is called somethingPrint — and the few
     that do not follow it are named outright. A control matching nothing is
     left alone, so a page nobody has considered is never silently disarmed.

     Export and Print are hidden rather than refused: the rows are already in
     the browser by the time the page draws, so this is a control on the screen
     and not a gate. Import writes, and the server refuses that one for real. */
  const ACTION_CONTROL_PATTERNS = [[/Print$/, 'print'], [/(Csv|Xls)$/, 'export']];
  const ACTION_CONTROL_IDS = { impStu: 'import', impFac: 'import', dashImport: 'import' };
  function gateControls(root, viewKey) {
    const m = moduleOfView(viewKey);
    if (!m) return;
    root.querySelectorAll('button[id]').forEach(b => {
      const act = ACTION_CONTROL_IDS[b.id]
        || (ACTION_CONTROL_PATTERNS.find(([re]) => re.test(b.id)) || [])[1];
      if (act && !can(m, act)) b.classList.add('hidden');
    });
  }

  function render() {
    /* A submenu key carries the filter it opens with — the page itself reads
       it from viewPreset and the title says which kind is being shown. */
    const { view, preset } = splitViewKey(currentView);
    viewPreset = preset;
    /* Worked out once, here, before anything asks: a role edited in another tab
       or a permission just saved is in force on the very next render. */
    refreshPerms();
    applyReadOnly();
    paintUser();
    $('#pageTitle').textContent =
      ((readOnly() && READ_ONLY_TITLES[view]) || TITLES[view] || 'Dashboard')
      + (preset ? ' — ' + preset : '');
    const v = $('#view');
    if (view !== 'dashboard' && !canView(currentView)) {
      v.innerHTML = accessDenied();
      return;
    }
    const fn = {
      dashboard: viewDashboard, students: viewStudents, faculty: viewFaculty, courses: viewCourses,
      syllabus: viewSyllabus,
      attendance: viewAttendance, marks: viewMarks, timetable: viewTimetable, fees: viewFees,
      assignments: viewAssignments, library: viewLibrary, mybooks: viewMyBooks,
      myattendance: viewMyAttendance, myresults: viewMyResults, myfees: viewMyFees,
      myplacement: viewMyPlacement, profile: viewProfile,
      attrecords: viewAttendanceRecords,
      events: viewEvents, issueBook: viewIssueBook, returnBook: viewReturnBook, reports: viewLibraryReports,
      accounts: viewAccounts,
      finstudents: viewFinStudents, assets: viewAssets, fixedfee: viewFixedFee, semfee: viewSemFee,
      feecollect: viewFeeCollection, payments: viewPayments, pendingfees: viewPendingFees,
      finreports: viewFinReports, accountants: viewAccountants,
      goodsreq: viewGoodsRequisition, bookreq: viewBookRequisition, requisitions: viewRequisitions,
      batchsem: viewBatchSemester,
      departments: viewDepartments, branches: viewBranches, chreports: viewCenterReports,
      plstudents: viewPlacementStudents, companies: viewCompanies, drives: viewDrives,
      applications: viewApplications, interviews: viewInterviews, placements: viewPlacements,
      offers: viewOffers, plcalendar: viewPlacementCalendar, plreports: viewPlacementReports,
      placementofficers: viewPlacementOfficers,
      stuprofile: viewStudentProfile, facprofile: viewFacultyProfile,
      usersettings: viewUserSettings, roles: viewRoles,
    }[view] || viewDashboard;
    v.innerHTML = fn();
    const home = $('#adHome'); if (home) home.onclick = () => navigate('dashboard');
    // every page a read-only role opens says so — views that already carry a
    // banner with a page-specific message keep theirs
    if (readOnly() && !v.querySelector('.ro-banner')) {
      v.insertAdjacentHTML('afterbegin', readOnlyBanner());
    }
    /* A module handed over for viewing only keeps its lists, filters, printing
       and exports and loses the controls that would write. Pages gate their
       buttons on a dozen different role checks, so this is done once here
       rather than trusted to each of them — and Store and the server refuse
       the write in any case. */
    v.classList.toggle('view-frozen', moduleViewOnly(view));
    if (typeof fn.after === 'function') fn.after();
    gateControls(v, view);
  }

  /* ========================================================= */
  /*  VIEWS                                                     */
  /* ========================================================= */
  function statCard(ico, val, lbl, cls = '') {
    return `<div class="stat-card ${cls}"><div class="s-ico">${ico}</div>
      <div><div class="s-val">${val}</div><div class="s-lbl">${lbl}</div></div></div>`;
  }
  // CSS conic-gradient string for a multi-segment donut chart
  function donutGradient(segments) {
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    let acc = 0;
    return 'conic-gradient(' + segments.map(seg => {
      const start = acc / total * 360; acc += seg.value; const end = acc / total * 360;
      return `${seg.color} ${start}deg ${end}deg`;
    }).join(', ') + ')';
  }
  // small inline SVG line chart for two series over the same set of day labels
  function lineChartSvg(days, seriesA, seriesB, colorA, colorB) {
    const w = 560, h = 190, padL = 26, padR = 10, padT = 10, padB = 24;
    const maxV = Math.max(1, ...seriesA, ...seriesB);
    const stepX = (w - padL - padR) / Math.max(1, days.length - 1);
    const toXY = (v, i) => [padL + i * stepX, padT + (h - padT - padB) * (1 - v / maxV)];
    const path = (series) => series.map((v, i) => toXY(v, i))
      .map(([x, y], i) => (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
    const area = (series) => {
      const pts = series.map((v, i) => toXY(v, i));
      return `M${pts[0][0].toFixed(1)},${h - padB} ` +
        pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
        ` L${pts[pts.length - 1][0].toFixed(1)},${h - padB} Z`;
    };
    const dots = (series, color) => series.map((v, i) => {
      const [x, y] = toXY(v, i);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${color}"/>`;
    }).join('');
    const gridLines = [0, .25, .5, .75, 1].map(f => {
      const y = (padT + (h - padT - padB) * f).toFixed(1);
      return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    }).join('');
    const xLabels = days.map((d, i) => {
      const [x] = toXY(0, i);
      return `<text x="${x.toFixed(1)}" y="${h - 6}" font-size="10" fill="var(--muted)" text-anchor="middle">${esc(d.slice(5))}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:190px">
      ${gridLines}
      <path d="${area(seriesA)}" fill="${colorA}" fill-opacity="0.12" stroke="none"/>
      <path d="${path(seriesA)}" fill="none" stroke="${colorA}" stroke-width="2.5"/>
      <path d="${path(seriesB)}" fill="none" stroke="${colorB}" stroke-width="2.5"/>
      ${dots(seriesA, colorA)}${dots(seriesB, colorB)}
      ${xLabels}
    </svg>`;
  }

  // ---- DASHBOARD ----
  function viewDashboard() {
    viewDashboard.after = null;
    if (user.role === 'student') return studentDashboard();
    if (user.role === 'faculty') return facultyDashboard();
    if (user.role === 'librarian') return librarianDashboard();
    if (user.role === 'accountant') return accountantDashboard();
    if (user.role === 'center_head') return centerHeadDashboard();
    if (user.role === 'placement_officer') return placementDashboard();
    if (user.role === 'admission') return admissionDashboard();
    const students = Store.all('students');
    const nStu = students.length;
    const nFac = Store.all('faculty').length;
    const nCou = Store.all('courses').length;
    const nBooks = Store.all('books').reduce((s, b) => s + (b.total || 0), 0);
    const fees = Store.all('fees');
    const totalFee = fees.reduce((s, f) => s + (f.total || 0), 0);
    const collected = fees.reduce((s, f) => s + Math.min(f.total, f.paid || 0), 0);
    const pending = totalFee - collected;
    const collPct = totalFee ? Math.round((collected / totalFee) * 100) : 0;
    const onLoan = Store.all('issues').filter(i => !i.returnDate).length;

    // branch distribution
    const byBranch = {};
    students.forEach(s => { const k = specOf(s) || 'Not set'; byBranch[k] = (byBranch[k] || 0) + 1; });
    const branchRows = Object.entries(byBranch).sort((a, b) => b[1] - a[1]);
    const maxBranch = Math.max(1, ...branchRows.map(r => r[1]));

    // next few college events
    const upcomingEvents = Store.all('events')
      .filter(e => (e.date || '') >= today())
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
      .slice(0, 4);

    // top performers by GPA
    const top = students
      .map(s => ({ s, gpa: studentGPA(s.id) }))
      .filter(x => x.gpa !== null)
      .sort((a, b) => b.gpa - a.gpa).slice(0, 5);

    // ---- welcome banner ----
    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(user.name))} 👋</h2>
        <p>NMIET B-SCHOOL College Management System · ${prettyDate()}</p>
        <div class="wb-chips">
          <span>🎓 ${nStu} students</span><span>📚 ${nCou} courses</span>
          <span>📖 ${onLoan} books on loan</span><span>💳 ${collPct}% fees collected</span>
        </div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    // ---- stat cards ----
    html += `<div class="stat-grid">
      ${statCard('🎓', nStu, 'Total Students')}
      ${statCard('👨‍🏫', nFac, 'Faculty Members', 'c2')}
      ${statCard('📚', nCou, 'Courses Offered', 'c3')}
      ${statCard('📖', nBooks, 'Library Books', 'c2')}
    </div>`;

    // ---- charts row: branch distribution + fee donut ----
    html += `<div class="dash-2col">
      <div class="panel">
        <div class="panel-head"><h3>Students by Specialisation</h3></div>
        ${branchRows.length ? branchRows.map(([b, n]) => `
          <div class="dist-row">
            <span class="dist-label">${esc(b)}</span>
            <span class="dist-bar"><i style="width:${Math.round(n / maxBranch * 100)}%"></i></span>
            <span class="dist-val">${n}</span>
          </div>`).join('') : `<p class="empty">No data.</p>`}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Fee Collection</h3></div>
        <div class="donut-wrap">
          ${donutSVG(collPct, 'collected')}
          <div class="donut-legend">
            <div><span class="dot green"></span> Collected <b>${money(collected)}</b></div>
            <div><span class="dot line"></span> Pending <b>${money(pending)}</b></div>
            <div style="margin-top:6px;color:var(--muted);font-size:12.5px">Total ${money(totalFee)}</div>
          </div>
        </div>
      </div>
    </div>`;

    // ---- top performers + attendance health ----
    html += `<div class="dash-2col">
      <div class="panel">
        <div class="panel-head"><h3>🏆 Top Performers</h3></div>
        ${top.length ? top.map((x, i) => `
          <div class="rank-row">
            <span class="rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}">${i + 1}</span>
            <div class="rank-info"><strong>${esc(x.s.name)}</strong><small>${esc(x.s.roll)} · ${esc(x.s.branch)}</small></div>
            <span class="pill green">GPA ${x.gpa}</span>
          </div>`).join('') : `<p class="empty">No results yet.</p>`}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>📅 Upcoming Events</h3>
          <span style="font-size:12.5px;color:var(--muted)">Next ${upcomingEvents.length}</span></div>
        <div class="lib-events-list">${upcomingEvents.length ? upcomingEvents.map(e => {
          const d = new Date(e.date + 'T00:00:00');
          const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
          const days = Math.round((d - new Date(today() + 'T00:00:00')) / 86400000);
          return `<div class="lib-event">
            <div class="lib-event-badge"><span class="mon">${mon}</span><span class="day">${d.getDate()}</span></div>
            <div><div class="lib-event-title">${esc(e.title)}</div>
            <div class="lib-event-meta">${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : 'in ' + days + ' days'}
              · ${esc((e.description || '').slice(0, 45))}</div></div>
          </div>`;
        }).join('') : '<p class="empty">No upcoming events. Add one from the Events page.</p>'}</div>
      </div>
    </div>`;

    // ---- students overview table ----
    html += `<div class="panel"><div class="panel-head"><h3>Students Overview</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Reg No</th><th>Name</th><th>Specialisation</th><th>Sem</th><th>Attendance</th><th>GPA</th>
      </tr></thead><tbody>`;
    students.forEach(s => {
      const att = studentAttendancePct(s.id);
      const gpa = studentGPA(s.id);
      html += `<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${esc(s.branch)}</td>
        <td>${s.semester}</td><td>${attBar(att)}</td><td>${gpa ?? '—'}</td></tr>`;
    });
    html += `</tbody></table></div></div>`;
    return html;
  }

  // greeting + date helpers for the dashboard banner
  /* The name a person is called by. "Ms. Kavita Menon" greeted as "Menon" reads
     like a summons; the honorific is dropped and the given name used. */
  function firstName(full) {
    return String(full || '').split(/\s+/)
      .filter(w => w && !/^(dr|prof|mr|mrs|ms|miss|shri|smt)\.?$/i.test(w))[0] || String(full || '');
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  function prettyDate() {
    return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  // SVG donut chart (no library)
  function donutSVG(pct, sub) {
    const r = 52, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    return `<svg class="donut" viewBox="0 0 140 140">
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--line)" stroke-width="16"></circle>
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--primary)" stroke-width="16"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
        transform="rotate(-90 70 70)"></circle>
      <text x="70" y="68" text-anchor="middle" font-size="26" font-weight="700" fill="var(--primary-dark)">${pct}%</text>
      <text x="70" y="90" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(sub)}</text>
    </svg>`;
  }

  // ---- FACULTY dashboard: only the classes the admin assigned ----
  function facultyDashboard() {
    const f = Store.find('faculty', user.refId) || {};
    const classes = teacherCourses();          // courses assigned to this faculty
    const studentSet = visibleStudents();      // students in those classes

    // real numbers taken from this faculty's own attendance sessions
    const sessions = myAttendanceSessions();
    const tally = sessions.reduce((acc, a) => {
      const n = sessionCounts(a);
      acc.present += n.present; acc.total += n.total;
      return acc;
    }, { present: 0, total: 0 });
    const avgAtt = tally.total ? Math.round(tally.present / tally.total * 100) : null;

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(user.name))} 👋</h2>
        <p>${esc(f.designation || 'Faculty')} · ${esc(f.department || '')} · ${prettyDate()}</p>
        <div class="wb-chips"><span>📚 ${classes.length} classes assigned</span><span>🎓 ${studentSet.length} students</span></div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    html += `<div class="stat-grid">
      ${statCard('📚', classes.length, 'Assigned Classes')}
      ${statCard('🎓', studentSet.length, 'My Students', 'c3')}
      ${statCard('✅', avgAtt === null ? '—' : avgAtt + '%', 'Avg. Class Attendance', avgAtt !== null && avgAtt < 75 ? 'c4' : 'c2')}
      ${statCard('🗂️', sessions.length, 'Classes Conducted')}
    </div>`;

    html += `<div class="panel"><div class="panel-head"><h3>📋 My Assigned Classes</h3>
      <span style="font-size:12.5px;color:var(--muted)">Assigned by the System Admin</span></div>`;
    if (!classes.length) {
      html += `<p class="empty">No classes have been assigned to you yet. Please contact the System Admin.</p>`;
    } else {
      html += `<div class="tbl-wrap"><table><thead><tr>
        <th>Code</th><th>Course</th><th>Specialisation</th><th>Sem</th><th>Section</th><th>Students</th><th>Actions</th>
      </tr></thead><tbody>${classes.map(c => `<tr>
        <td>${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc(c.branch)}</td><td>${c.semester}</td>
        <td><span class="pill blue">Sec ${esc(c.section || 'A')}</span></td>
        <td>${studentsOfCourse(c).length}</td>
        <td><div class="row-actions">
          <button class="btn-sm btn-edit" data-att="${c.id}">✅ Attendance</button>
          <button class="btn-sm btn-outline" data-mk="${c.id}">📝 Marks</button></div></td></tr>`).join('')}</tbody></table></div>`;
    }
    html += `</div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Quick Actions</h3></div>
      <div class="lib-qa-grid">
        <div class="lib-qa-btn" id="qaAtt"><span class="lib-qa-ico" style="background:var(--primary)">✅</span>Take Attendance</div>
        <div class="lib-qa-btn" id="qaHist"><span class="lib-qa-ico" style="background:var(--blue)">🗂️</span>Attendance History</div>
        <div class="lib-qa-btn" id="qaRep"><span class="lib-qa-ico" style="background:var(--purple)">📄</span>Generate Attendance Report</div>
        <div class="lib-qa-btn" id="qaMarks"><span class="lib-qa-ico" style="background:var(--accent)">📝</span>Enter Marks</div>
      </div></div>`;

    viewDashboard.after = () => {
      document.querySelectorAll('[data-att]').forEach(b => b.onclick = () => navigate('attendance'));
      document.querySelectorAll('[data-mk]').forEach(b => b.onclick = () => navigate('marks'));
      $('#qaAtt').onclick = () => navigate('attendance');
      $('#qaHist').onclick = () => navigate('attendance');
      $('#qaMarks').onclick = () => navigate('marks');
      $('#qaRep').onclick = () => attendanceReport('');
    };
    return html;
  }

  /* The admissions desk was landing on the admin's dashboard: fee collection,
     library stock, faculty strength — none of which it can even open. This
     counts the thing it is responsible for, which is who is on the roll. */
  function admissionDashboard() {
    const students = Store.all('students');
    const active = students.filter(s => (s.status || 'Active') === 'Active');
    // the same session the student form defaults to
    const y = new Date().getFullYear();
    const thisYear = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    const admittedThisYear = students.filter(s => (s.academicYear || '') === thisYear);

    const tally = (key) => {
      const out = {};
      students.forEach(s => {
        const v = String(s[key] || '').trim() || 'Not set';
        out[v] = (out[v] || 0) + 1;
      });
      return Object.entries(out).sort((a, b) => b[1] - a[1]);
    };
    const byCourse = tally('course');
    const bySpec = tally('specialisation');
    const colours = ['#123f8c', '#2f6fed', '#f5a623', '#8b5cf6', '#22b8b8', '#e0414f'];
    const segments = byCourse.map(([label, value], i) =>
      ({ label, value, color: colours[i % colours.length] }));

    /* Ids are handed out in order, so the highest are the most recent
       enrolments — there is no admission date on the record to sort by. */
    const latest = [...students].sort((a, b) =>
      String(b.id || '').localeCompare(String(a.id || ''), undefined, { numeric: true })).slice(0, 6);
    const maxSpec = bySpec.length ? bySpec[0][1] : 0;

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(user.name))} 👋</h2>
        <p>Admissions · ${prettyDate()}</p>
        <div class="wb-chips">
          <span>🎓 ${students.length} on the roll</span>
          <span>🆕 ${admittedThisYear.length} admitted in ${esc(thisYear)}</span>
        </div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    html += `<div class="stat-grid">
      ${statCard('🎓', students.length, 'Students on the Roll')}
      ${statCard('🆕', admittedThisYear.length, `Admitted in ${esc(thisYear)}`, 'c3')}
      ${statCard('✅', active.length, 'Active', 'c3')}
      ${statCard('⏸️', students.length - active.length, 'Inactive', 'c4')}
    </div>`;

    html += `<div class="dash-2col">
      <div class="panel"><div class="panel-head"><h3>Students by Course</h3></div>
        <div class="lib-donut-wrap">
          <div class="lib-donut" style="background:${segments.length ? donutGradient(segments) : 'var(--primary-light)'}">
            <div class="lib-donut-center"><strong>${students.length}</strong><span>Total</span></div>
          </div>
          <div class="lib-legend">
            <div class="lib-legend-head"><span>Course</span><span>Students</span></div>
            ${segments.length ? segments.map(seg => `<div class="lib-legend-row">
              <span class="dotlbl"><span class="ldot" style="background:${seg.color}"></span>${esc(seg.label)}</span>
              <span>${seg.value}</span></div>`).join('')
              : `<p class="empty">No students on record.</p>`}
          </div>
        </div></div>

      <div class="panel"><div class="panel-head"><h3>Students by Specialisation</h3></div>
          ${bySpec.length ? bySpec.map(([label, n]) => `<div class="dist-row">
            <span class="dist-label">${esc(label)}</span>
            <span class="dist-bar"><i style="width:${maxSpec ? Math.round(n / maxSpec * 100) : 0}%"></i></span>
            <span class="dist-val">${n}</span></div>`).join('')
          : `<p class="empty">No students on record.</p>`}
      </div>
    </div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Latest Admissions</h3>
        <div class="panel-tools">
          <button class="btn-outline" id="dashImport">⬆ Bulk Upload</button>
          <button class="btn-primary" id="dashAdd">+ Add Student</button>
        </div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Student ID</th><th>Name</th><th>Course</th><th>Specialisation</th>
        <th>Batch</th><th>Status</th>
      </tr></thead><tbody>
        ${latest.length ? latest.map(s => `<tr>
          <td class="mono">${esc(s.roll || '—')}</td><td>${esc(s.name || '—')}</td>
          <td>${esc(s.course || '—')}</td><td>${esc(s.specialisation || '—')}</td>
          <td>${esc(s.batch || '—')}</td>
          <td><span class="pill ${(s.status || 'Active') === 'Active' ? 'green' : 'red'}">${
            esc(s.status || 'Active')}</span></td>
        </tr>`).join('') : `<tr><td colspan="6" class="empty">Nobody has been admitted yet.</td></tr>`}
      </tbody></table></div></div>`;

    viewDashboard.after = () => {
      $('#dashAdd').onclick = () => studentForm();
      $('#dashImport').onclick = () => bulkImportModal('students');
    };
    return html;
  }

  function librarianDashboard() {
    const books = Store.all('books');
    const totalBooks = books.reduce((s, b) => s + (b.total || 0), 0);
    const availableBooks = books.reduce((s, b) => s + (b.available || 0), 0);
    const issues = Store.all('issues');
    const issuedBooks = issues.filter(i => !i.returnDate).length;
    const totalStudents = Store.all('students').length;

    const byCat = {};
    books.forEach(b => { const c = b.category || 'Others'; byCat[c] = (byCat[c] || 0) + (b.total || 0); });
    const catColors = ['#123f8c', '#2f6fed', '#f5a623', '#8b5cf6', '#e0414f', '#22b8b8'];
    const catSegments = Object.entries(byCat).sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: catColors[i % catColors.length] }));

    const recentIssues = [...issues].sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || '')).slice(0, 5);

    const days = [...Array(7)].map((_, i) => addDays(today(), i - 6));
    const issuedSeries = days.map(d => issues.filter(i => i.issueDate === d).length);
    const returnedSeries = days.map(d => issues.filter(i => i.returnDate === d).length);

    const upcoming = Store.all('events').filter(e => (e.date || '') >= today())
      .sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, 3);

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, Librarian 👋</h2>
        <p>Welcome to Library Management System · ${prettyDate()}</p>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    html += `<div class="lib-stats-grid">
      <div class="lib-stat-card"><div class="lib-stat-ico green">📚</div><div>
        <div class="lib-stat-lbl">Total Books</div><div class="lib-stat-val">${totalBooks}</div>
        <div class="lib-stat-sub">All books in library</div></div></div>
      <div class="lib-stat-card"><div class="lib-stat-ico blue">📗</div><div>
        <div class="lib-stat-lbl">Available Books</div><div class="lib-stat-val">${availableBooks}</div>
        <div class="lib-stat-sub">Books available</div></div></div>
      <div class="lib-stat-card"><div class="lib-stat-ico amber">🔖</div><div>
        <div class="lib-stat-lbl">Issued Books</div><div class="lib-stat-val">${issuedBooks}</div>
        <div class="lib-stat-sub">Currently issued</div></div></div>
      <div class="lib-stat-card"><div class="lib-stat-ico purple">🎓</div><div>
        <div class="lib-stat-lbl">Total Students</div><div class="lib-stat-val">${totalStudents}</div>
        <div class="lib-stat-sub">Registered students</div></div></div>
    </div>`;

    html += `<div class="lib-row">
      <div class="panel"><div class="panel-head"><h3>Books by Category</h3></div>
        <div class="lib-donut-wrap">
          <div class="lib-donut" style="background:${catSegments.length ? donutGradient(catSegments) : 'var(--primary-light)'}">
            <div class="lib-donut-center"><strong>${totalBooks}</strong><span>Total</span></div>
          </div>
          <div class="lib-legend">
            <div class="lib-legend-head"><span>Category</span><span>Books</span></div>
            ${catSegments.length ? catSegments.map(seg => `<div class="lib-legend-row">
              <span class="dotlbl"><span class="ldot" style="background:${seg.color}"></span>${esc(seg.label)}</span>
              <span>${seg.value}</span></div>`).join('') : '<p class="empty">No books yet.</p>'}
          </div>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Recent Issued Books</h3></div>
        <div class="tbl-wrap"><table><thead><tr><th>Book</th><th>Student</th><th>Issued</th><th>Due</th></tr></thead>
        <tbody>${recentIssues.length ? recentIssues.map(i => {
          const b = Store.find('books', i.bookId) || {}; const s = Store.find('students', i.studentId) || {};
          const overdue = !i.returnDate && i.dueDate < today();
          return `<tr><td>${esc(b.title || '?')}</td><td>${esc(s.name || '?')}</td><td>${esc(i.issueDate)}</td>
            <td style="color:${overdue ? 'var(--red)' : 'inherit'}">${esc(i.dueDate)}</td></tr>`;
        }).join('') : `<tr><td colspan="4" class="empty">No books issued yet.</td></tr>`}</tbody></table></div>
      </div>
    </div>`;

    html += `<div class="lib-row3">
      <div class="panel"><div class="panel-head"><h3>Issue &amp; Return Overview</h3>
        <span style="font-size:12px;color:var(--muted)">Last 7 Days</span></div>
        ${lineChartSvg(days, issuedSeries, returnedSeries, 'var(--primary)', 'var(--blue)')}
        <div style="display:flex;gap:18px;margin-top:8px;font-size:12.5px;color:var(--muted)">
          <span><span class="ldot" style="background:var(--primary);display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px"></span>Issued</span>
          <span><span class="ldot" style="background:var(--blue);display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px"></span>Returned</span>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Upcoming Events</h3></div>
        <div class="lib-events-list">${upcoming.length ? upcoming.map(e => {
          const d = new Date(e.date + 'T00:00:00');
          const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
          return `<div class="lib-event">
            <div class="lib-event-badge"><span class="mon">${mon}</span><span class="day">${d.getDate()}</span></div>
            <div><div class="lib-event-title">${esc(e.title)}</div>
            <div class="lib-event-meta">${esc((e.description || '').slice(0, 60))}</div></div>
          </div>`;
        }).join('') : '<p class="empty">No upcoming events.</p>'}</div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Quick Actions</h3></div>
        <div class="lib-qa-grid">
          <div class="lib-qa-btn" id="qaAddBook"><span class="lib-qa-ico" style="background:var(--primary)">➕</span>Add Book</div>
          <div class="lib-qa-btn" id="qaIssueBook"><span class="lib-qa-ico" style="background:var(--blue)">⬇️</span>Issue Book</div>
          <div class="lib-qa-btn" id="qaReturnBook"><span class="lib-qa-ico" style="background:var(--accent)">⬆️</span>Return Book</div>
          <div class="lib-qa-btn" id="qaReports"><span class="lib-qa-ico" style="background:var(--purple)">📊</span>View Reports</div>
        </div>
      </div>
    </div>`;

    viewDashboard.after = () => {
      $('#qaAddBook').onclick = () => bookForm(null, render);
      $('#qaIssueBook').onclick = () => navigate('issueBook');
      $('#qaReturnBook').onclick = () => navigate('returnBook');
      $('#qaReports').onclick = () => navigate('reports');
    };
    return html;
  }

  // short weekday name ('Mon', 'Tue', ...) the way timetable slots store it
  function dayNameOffset(n) {
    const d = new Date(); d.setDate(d.getDate() + n);
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  }
  // next few timetable slots for a class, walking forward from today
  function upcomingSlots(branch, semester, section, limit) {
    const slots = Store.all('timetable')
      .filter(t => t.branch === branch && t.semester === semester && t.section === section);
    if (!slots.length) return [];
    const todayName = dayNameOffset(0), tomorrowName = dayNameOffset(1);
    let start = DAYS.indexOf(todayName);
    if (start < 0) start = 0;                       // today is not a working day (e.g. Sunday)
    const out = [];
    for (let i = 0; i < DAYS.length && out.length < limit; i++) {
      const day = DAYS[(start + i) % DAYS.length];
      const label = day === todayName ? 'Today' : day === tomorrowName ? 'Tomorrow' : day;
      slots.filter(t => t.day === day)
        .sort((a, b) => slotTimes(a)[0] - slotTimes(b)[0])
        .forEach(t => { if (out.length < limit) out.push({ slot: t, label }); });
    }
    return out;
  }

  function studentDashboard() {
    const s = Store.find('students', user.refId) || {};
    const att = studentAttendancePct(s.id);

    // subjects the student is actually enrolled in this semester (branch + sem + section)
    const mySubjects = Store.all('courses')
      .filter(c => inCourseClass(s, c))
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''));

    const upcomingEvents = Store.all('events')
      .filter(e => (e.date || '') >= today())
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
      .slice(0, 4);

    const nextClasses = upcomingSlots(s.branch, s.semester, s.section, 5);

    const myLoans = Store.all('issues')
      .filter(i => i.studentId === s.id && !i.returnDate)
      .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    const overdueCount = myLoans.filter(i => i.dueDate < today()).length;
    const booksAvailable = Store.all('books').reduce((n, b) => n + (b.available || 0), 0);

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(s.name))} 👋</h2>
        <p>${esc(s.branch)} · Semester ${s.semester} · Section ${esc(s.section)} · Reg No ${esc(s.roll)}</p>
        <div class="wb-chips"><span>📅 ${prettyDate()}</span></div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;
    html += `<div class="stat-grid">
      ${statCard('✅', (att ?? '—') + '%', 'Attendance', att !== null && att < 75 ? 'c4' : 'c3')}
      ${statCard('📚', mySubjects.length, 'Subjects This Sem', 'c2')}
      ${statCard('🗓️', nextClasses.length, 'Upcoming Classes')}
      ${statCard('📖', myLoans.length, 'Books on Loan', overdueCount ? 'c4' : 'c3')}
    </div>`;
    html += `<div class="dash-2col">
      <div class="panel">
        <div class="panel-head"><h3>My Attendance</h3></div>
        <div class="donut-wrap">
          ${donutSVG(att ?? 0, 'present')}
          <div class="donut-legend">
            <div><span class="dot green"></span> Attendance <b>${att ?? '—'}%</b></div>
            <div style="color:var(--muted);font-size:12.5px;margin-top:4px">${att !== null && att < 75 ? 'Below the 75% requirement' : 'Meeting the 75% requirement'}</div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Upcoming Classes</h3>
          <span style="font-size:12px;color:var(--muted)">Sem ${s.semester} · Sec ${esc(s.section)}</span></div>
        ${nextClasses.length ? nextClasses.map(({ slot, label }) => {
          const c = Store.find('courses', slot.courseId);
          return `<div class="rank-row">
            <span class="rank">🕒</span>
            <div class="rank-info"><strong>${c ? esc(c.code + ' — ' + c.name) : 'Unknown course'}</strong>
              <small>${esc(label)} · ${slotTimeLabel(slot)}${slot.room ? ' · Room No.' + esc(slot.room) : ''}${c ? ' · ' + esc(facultyName(c.facultyId)) : ''}</small></div>
          </div>`;
        }).join('') : '<p class="empty">No classes scheduled in your timetable yet.</p>'}
      </div>
    </div>`;

    html += `<div class="lib-row3">
      <div class="panel">
        <div class="panel-head"><h3>Subjects — Semester ${s.semester}</h3></div>
        <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Subject</th><th>Faculty</th><th>Credits</th></tr></thead>
          <tbody>${mySubjects.length ? mySubjects.map(c => `<tr>
            <td>${esc(c.code)}</td><td>${esc(c.name)}</td>
            <td>${esc(facultyName(c.facultyId))}</td><td>${c.credits ?? '—'}</td></tr>`).join('')
            : `<tr><td colspan="4" class="empty">No subjects assigned for this semester.</td></tr>`}</tbody></table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Upcoming Events</h3></div>
        <div class="lib-events-list">${upcomingEvents.length ? upcomingEvents.map(e => {
          const d = new Date(e.date + 'T00:00:00');
          const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
          return `<div class="lib-event">
            <div class="lib-event-badge"><span class="mon">${mon}</span><span class="day">${d.getDate()}</span></div>
            <div><div class="lib-event-title">${esc(e.title)}</div>
            <div class="lib-event-meta">${esc((e.description || '').slice(0, 60))}</div></div>
          </div>`;
        }).join('') : '<p class="empty">No upcoming events.</p>'}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Library Updates</h3></div>
        ${myLoans.length ? myLoans.map(i => {
          const b = Store.find('books', i.bookId) || {};
          const left = Math.round((new Date(i.dueDate + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
          const st = left < 0 ? ['red', `Overdue by ${-left} day(s)`]
                   : left === 0 ? ['amber', 'Due today']
                   : ['green', `Due in ${left} day(s)`];
          return `<div class="rank-row"><span class="rank">📖</span>
            <div class="rank-info"><strong>${esc(b.title || 'Unknown book')}</strong>
              <small>Issued ${esc(i.issueDate)} · <span class="pill ${st[0]}">${st[1]}</span></small></div>
          </div>`;
        }).join('') : '<p class="empty">No books currently on loan.</p>'}
        <div style="margin-top:10px;font-size:12.5px;color:var(--muted)">📚 ${booksAvailable} copies available in the catalogue</div>
      </div>
    </div>`;

    if (overdueCount)
      html += `<div class="panel" style="border-left:4px solid var(--red)"><strong style="color:var(--red)">⚠ Overdue Book${overdueCount > 1 ? 's' : ''}.</strong> You have ${overdueCount} book(s) past the due date. Please return them to the library.</div>`;
    if (att !== null && att < 75)
      html += `<div class="panel" style="border-left:4px solid var(--red)"><strong style="color:var(--red)">⚠ Low Attendance.</strong> Your attendance is below 75%. Attend classes regularly to avoid detention.</div>`;
    return html;
  }

  function attBar(pct) {
    if (pct === null) return '—';
    const cls = pct < 75 ? 'low' : pct < 85 ? 'mid' : '';
    return `<span class="bar ${cls}"><i style="width:${pct}%"></i></span> ${pct}%`;
  }

  // ---- STUDENTS ----
  /* What the Advanced Filter can narrow on, in the order the panel lists it.
     The text fields match anywhere in the value; the dropdowns are built from
     the values the roll actually holds, so neither offers a batch nobody is
     in nor a name nobody has. */
  const ADV_TEXT = [['roll', 'Student ID'], ['firstName', 'First Name'],
                    ['middleName', 'Middle Name'], ['lastName', 'Last Name'],
                    ['phone', 'Phone No.']];
  const ADV_SELECT = [['branch', 'Department'], ['specialisation', 'Specialisation'],
                      ['section', 'Section'], ['batch', 'Batch'], ['course', 'Course'],
                      ['status', 'Status']];
  /* Each range reads one number off the record. Four of them live on the
     Academic tab as the marks for that qualification; the fifth is the CGPA
     column the roll already prints. */
  const ADV_RANGES = [['q10', '10th Percentage', '10th'], ['q12', '12th Percentage', '12th'],
                      ['dip', 'Diploma Percentage', 'Diploma'], ['p3', '+3 Percentage', '+3'],
                      ['cgpa', 'CGPA', null]];

  /* A percentage as the office typed it — "88.4", "88.4 %", "88.4/100" — so
     only the number at the front of it can be compared. A level nobody filled
     in returns null, which is not the same as a zero. */
  function qualPct(stu, level) {
    const rows = stuPart(stu, 'academicInfo').qualifications;
    const row = (Array.isArray(rows) ? rows : []).find(q => q && q.level === level);
    const n = parseFloat(String((row && row.marks) || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  /** the number a range filter compares against, or null when unrecorded */
  function advValue(stu, key, level) {
    if (key === 'cgpa') {
      const n = parseFloat(String(stu.cgpa ?? '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return qualPct(stu, level);
  }
  /** an empty advanced filter — every field blank, every range open */
  function emptyAdv() {
    return { fields: {}, ranges: Object.fromEntries(ADV_RANGES.map(([k]) => [k, { min: '', max: '' }])) };
  }
  /** how many of its filters are actually set */
  function advCount(adv) {
    return Object.keys(adv.fields).length
      + ADV_RANGES.filter(([k]) => adv.ranges[k].min !== '' || adv.ranges[k].max !== '').length;
  }

  /* Options for a column filter, built from the values actually present so
     the dropdown never offers a branch or a batch nobody is in. */
  function colFilterOptions(rows, key, label) {
    const seen = [...new Set(rows.map(r => String(r[key] ?? '').trim()).filter(Boolean))].sort();
    return `<option value="">${label}</option>` +
      seen.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  }

  function viewStudents() {
    // the admissions desk enrols and corrects; only the admin removes a record
    const canEdit = ['admin', 'admission'].includes(user.role);
    const canDelete = user.role === 'admin';
    // librarians and the center head can't edit students, but they do need each
    // student's book history
    const canSeeBooks = ['admin', 'librarian', 'center_head'].includes(user.role);
    // printing an ID card / marksheet reads data, so a monitoring role may do it
    const canPrintDocs = canEdit || readOnly();
    const deptBranch = user.role === 'faculty' ? facultyDeptBranch() : null;
    // only for the dropdowns in the filter row — the list itself reads the
    // roll again on every redraw, or a deleted student would sit there until
    // the page was reloaded
    const all = rosterStudents();

    const html = `<div class="panel"><div class="panel-head">
      <h3>${deptBranch ? deptBranch + ' Department Students' : 'All Students'}</h3>
      <div class="panel-tools">
        <input class="search-box" id="stuSearch" placeholder="Search name / student id..." />
        <button class="btn-outline btn-sm" id="stuFilter">🔎 Filter</button>
        <button class="btn-outline btn-sm" id="stuPrint">🖨 PDF</button>
        <button class="btn-outline btn-sm" id="stuCsv">📑 CSV</button>
        <button class="btn-outline btn-sm" id="stuXls">⬇ Excel</button>
        ${canEdit ? `<button class="btn-outline" id="impStu">⬆ Bulk Upload</button>
        <button class="btn-primary" id="addStu">+ Add Student</button>` : ''}
      </div></div>
      <div class="filter-bar hidden" id="stuFilterBar">
        <span class="fb-count" id="stuFilterCount"></span>
        <span class="fb-note" id="stuFilterNote"></span>
        <button type="button" class="btn-outline btn-sm" id="stuFilterClear">Reset Filter</button>
      </div>
      <div class="tbl-wrap tbl-sticky"><table class="tbl-filter"><thead>
        <tr>
          <th>#</th><th>Student ID</th><th>First Name</th><th>Middle Name</th><th>Last Name</th>
          <th>Department</th><th>Specialisation</th><th>Section</th><th>Batch</th><th>Course</th>
          <th>Phone No.</th><th>Status</th><th></th>
        </tr>
        <tr class="filter-row">
          <td></td>
          <td><input data-f="roll"></td>
          <td><input data-f="firstName"></td>
          <td><input data-f="middleName"></td>
          <td><input data-f="lastName"></td>
          <td><select data-f="branch">${colFilterOptions(all, 'branch', '')}</select></td>
          <td><select data-f="specialisation">${colFilterOptions(all, 'specialisation', '')}</select></td>
          <td><select data-f="section">${colFilterOptions(all, 'section', '')}</select></td>
          <td><select data-f="batch">${colFilterOptions(all, 'batch', '')}</select></td>
          <td><select data-f="course">${colFilterOptions(all, 'course', '')}</select></td>
          <td><input data-f="phone"></td>
          <td><select data-f="status">${colFilterOptions(all, 'status', '')}</select></td>
          <td></td>
        </tr>
      </thead><tbody id="stuBody"></tbody></table></div><div id="stuPager"></div></div>`;

    viewStudents.after = () => {
      let page = 1;
      // survives redraws and paging, because the list redraws without this
      // function running again
      let adv = emptyAdv();
      const filters = () => {
        const out = {};
        $('#view').querySelectorAll('[data-f]').forEach(el => {
          const v = (el.value || '').trim();
          if (v) out[el.dataset.f] = v.toLowerCase();
        });
        return out;
      };
      // a text filter matches anywhere in the cell; a dropdown is exact
      const EXACT = ADV_SELECT.map(([k]) => k);
      const passes = (s, f) => Object.entries(f).every(([k, v]) => {
        const cell = String(s[k] ?? '').toLowerCase();
        return EXACT.includes(k) ? cell === v : cell.includes(v);
      });
      /* An open end is no bound at all. A student with nothing recorded is out
         of every range that has one — the office cannot say a blank is between
         70 and 90. */
      const inRange = (v, r) => {
        if (r.min === '' && r.max === '') return true;
        if (v === null) return false;
        if (r.min !== '' && v < +r.min) return false;
        if (r.max !== '' && v > +r.max) return false;
        return true;
      };
      const matching = () => {
        const q = ($('#stuSearch').value || '').toLowerCase();
        const f = filters();
        return rosterStudents().filter(s => {
          if (q && !(String(s.name || '').toLowerCase().includes(q)
                  || String(s.roll || '').toLowerCase().includes(q))) return false;
          // the search box, the column row and the panel all have to agree
          if (!passes(s, f) || !passes(s, adv.fields)) return false;
          return ADV_RANGES.every(([k, , level]) => inRange(advValue(s, k, level), adv.ranges[k]));
        });
      };

      const paintBar = (total) => {
        const n = advCount(adv);
        $('#stuFilterBar').classList.toggle('hidden', !n);
        $('#stuFilterCount').textContent = `${total} ${total === 1 ? 'Student' : 'Students'} Found`;
        $('#stuFilterNote').textContent = `${n} advanced ${n === 1 ? 'filter' : 'filters'} applied`;
        $('#stuFilter').classList.toggle('btn-primary', !!n);
        $('#stuFilter').classList.toggle('btn-outline', !n);
        $('#stuFilter').textContent = n ? `🔎 Filter · ${n}` : '🔎 Filter';
      };
      const draw = () => {
        const rows = matching();
        paintBar(rows.length);
        page = Math.min(page, pageCount(rows.length));
        const pageRows = pageSlice(rows, page);
        const from = (page - 1) * PAGE_SIZE;
        $('#stuBody').innerHTML = pageRows.length ? pageRows.map((s, i) => `<tr>
          <td>${from + i + 1}</td>
          <td>${esc(s.roll)}</td>
          <td>${esc(s.firstName || s.name || '')}</td>
          <td>${esc(s.middleName || '')}</td>
          <td>${esc(s.lastName || '')}</td>
          <td>${esc(s.branch || '')}</td>
          <td>${esc(s.specialisation || '—')}</td>
          <td>${esc(s.section || '')}</td>
          <td>${esc(s.batch || '—')}</td>
          <td>${esc(s.course || '—')}</td>
          <td>${esc(s.phone || '')}</td>
          <td><span class="pill ${String(s.status || 'Active') === 'Active' ? 'green' : 'red'}">${
            esc(s.status || 'Active')}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-profile="${s.id}" title="Full student profile">🔍</button>
            ${canSeeBooks ? `<button class="btn-sm btn-outline" data-books="${s.id}" title="Book issue / return history">📖</button>` : ''}
            ${canPrintDocs ? `<button class="btn-sm btn-outline" data-id="${s.id}" title="Print ID card">🪪</button>
            <button class="btn-sm btn-outline" data-sheet="${s.id}" title="Print marksheet">📄</button>` : ''}
            ${canEdit ? `<button class="btn-sm btn-edit" data-edit="${s.id}">Edit</button>` : ''}
            ${canDelete ? `<button class="btn-sm btn-del" data-del="${s.id}">Delete</button>` : ''}
          </div></td>
        </tr>`).join('') : `<tr><td colspan="13" class="empty">No students found.</td></tr>`;

        $('#stuBody').querySelectorAll('[data-profile]').forEach(b =>
          b.onclick = () => openStudentProfile(b.dataset.profile));
        if (canSeeBooks) {
          $('#stuBody').querySelectorAll('[data-books]').forEach(b => b.onclick = () => studentBooksModal(b.dataset.books));
        }
        if (canPrintDocs) {
          $('#stuBody').querySelectorAll('[data-id]').forEach(b => b.onclick = () => printIdCard(b.dataset.id));
          $('#stuBody').querySelectorAll('[data-sheet]').forEach(b => b.onclick = () => printMarksheet(b.dataset.sheet));
        }
        if (canEdit) {
          $('#stuBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => studentForm(b.dataset.edit));
        }
        if (canDelete) {
          $('#stuBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => delConfirm('students', b.dataset.del, 'student', draw));
        }
        $('#stuPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#stuPager'), rows.length, page, (p) => page = p, draw);
      };

      $('#stuSearch').oninput = () => { page = 1; draw(); };
      $('#stuFilter').onclick = () => advFilterModal(rosterStudents(), adv, (next) => {
        adv = next; page = 1; draw();
      });
      $('#stuFilterClear').onclick = () => { adv = emptyAdv(); page = 1; draw(); };
      $('#view').querySelectorAll('[data-f]').forEach(el => {
        const ev = el.tagName === 'SELECT' ? 'onchange' : 'oninput';
        el[ev] = () => { page = 1; draw(); };
      });
      if (canEdit) {
        $('#addStu').onclick = () => studentForm();
        $('#impStu').onclick = () => bulkImportModal('students');
      }
      const report = () => studentReport(matching());
      $('#stuPrint').onclick = () => printReport(report());
      $('#stuCsv').onclick = () => downloadCsv(report());
      $('#stuXls').onclick = () => downloadXlsx(report());
      draw();
    };
    return html;
  }

  /* Tick nothing and it changes nothing: the panel opens on whatever is
     already applied, and Apply hands back a new filter rather than editing the
     one the list is using — so Cancel really does cancel. */
  function advFilterModal(rows, current, onApply) {
    const adv = current;
    const val = (k) => esc(adv.fields[k] || '');
    const textField = ([k, label]) =>
      `<div class="field"><label>${esc(label)}</label>
        <input data-a="${k}" value="${val(k)}" placeholder="Any"></div>`;
    /* Built from the roll itself, so a dropdown never offers a batch or a
       section nobody is in. The applied value is held folded to lower case,
       which is what it is compared against. */
    const selectField = ([k, label]) => {
      const cur = adv.fields[k] || '';
      const vals = [...new Set(rows.map(r => String(r[k] ?? '').trim()).filter(Boolean))].sort();
      return `<div class="field"><label>${esc(label)}</label><select data-a="${k}">
        <option value="">Any</option>
        ${vals.map(v => `<option ${v.toLowerCase() === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select></div>`;
    };
    const rangeRow = ([k, label]) => `<div class="adv-range">
      <label>${esc(label)}</label>
      <input type="number" step="0.01" data-a-min="${k}" value="${esc(adv.ranges[k].min)}" placeholder="Min">
      <span class="adv-to">to</span>
      <input type="number" step="0.01" data-a-max="${k}" value="${esc(adv.ranges[k].max)}" placeholder="Max">
    </div>`;

    openModal('Advanced Filter', `
      <h4 class="ro-sub">Personal / Academic Details</h4>
      <div class="form-grid">
        ${ADV_TEXT.map(textField).join('')}
        ${ADV_SELECT.map(selectField).join('')}
      </div>
      <h4 class="ro-sub" style="margin-top:18px">Academic Performance</h4>
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 10px">
        Leave both boxes empty to ignore a row. A student with nothing recorded for
        a qualification is left out of that range.</p>
      <div class="adv-ranges">${ADV_RANGES.map(rangeRow).join('')}</div>
      <div class="form-actions">
        <button type="button" class="btn-outline" id="advReset">Reset Filter</button>
        <button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="button" class="btn-primary" id="advGo">Apply Filter</button>
      </div>`, true);

    const read = () => {
      const next = emptyAdv();
      document.querySelectorAll('#modalBody [data-a]').forEach(el => {
        const v = (el.value || '').trim();
        if (v) next.fields[el.dataset.a] = v.toLowerCase();
      });
      ADV_RANGES.forEach(([k]) => {
        const lo = document.querySelector(`[data-a-min="${k}"]`).value.trim();
        const hi = document.querySelector(`[data-a-max="${k}"]`).value.trim();
        next.ranges[k] = { min: lo, max: hi };
      });
      return next;
    };
    $('#cx').onclick = closeModal;
    $('#advReset').onclick = () => {
      document.querySelectorAll('#modalBody [data-a]').forEach(el => { el.value = ''; });
      ADV_RANGES.forEach(([k]) => {
        document.querySelector(`[data-a-min="${k}"]`).value = '';
        document.querySelector(`[data-a-max="${k}"]`).value = '';
      });
      onApply(emptyAdv());
      closeModal();
      toast('Filter cleared.');
    };
    $('#advGo').onclick = () => {
      const next = read();
      const backwards = ADV_RANGES.find(([k, label]) => {
        const r = next.ranges[k];
        return r.min !== '' && r.max !== '' && +r.min > +r.max;
      });
      if (backwards) { toast(`${backwards[1]}: the minimum is above the maximum.`, 'err'); return; }
      onApply(next);
      closeModal();
    };
  }

  /* ---------- read-only student profile (center head) ----------
     Everything the admin can see about a student, on one screen, with no
     control that could change any of it. */
  /* The six JSON columns arrive as objects, but a record written before they
     existed has none, and a bulk upload can leave a string behind. */
  function stuPart(s, key) {
    /* A column nobody has written yet comes back as {} whatever it will
       eventually hold, so the shape is decided here rather than trusted. */
    const wantsList = key === 'guardians' || key === 'documents';
    let v = s && s[key];
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { v = null; }
    }
    if (wantsList) return Array.isArray(v) ? v : [];
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }

  const STU_TABS = [
    ['personal', '👤 Personal'], ['academic', '🎓 Academic'], ['guardians', '👪 Guardians'],
    ['address', '🏠 Address'], ['documents', '📄 Documents'], ['fees', '₹ Fees'],
    ['attendance', '📅 Attendance'], ['health', '🩺 Health'], ['idcard', '🪪 ID Card'],
  ];
  /* The student sees the same tabs, less the ones that are not theirs to
     read: fees only when the admin has fees switched on for students. */
  function stuTabsFor(own) {
    return STU_TABS.filter(([k]) => !(own && k === 'fees' && !studentFeesVisible()));
  }
  let profileStudentId = null;
  let stuTab = 'personal';
  let stuAttSubjectWise = false;

  function openStudentProfile(sid) {
    profileStudentId = sid;
    stuTab = 'personal';
    stuAttSubjectWise = false;
    navigate('stuprofile');
  }

  /** one label/value line inside a tab */
  /* The value spans the remaining three cells, so a table that mixes single
     and paired rows still lines up on one grid. */
  function infoRow(k, v) {
    return `<tr><th style="width:22%">${esc(k)}</th>
      <td colspan="3">${v == null || v === '' ? '—' : v}</td></tr>`;
  }
  /** two label/value pairs on one line, the way the reference lays them out */
  function infoRow2(k1, v1, k2, v2) {
    return `<tr><th style="width:22%">${esc(k1)}</th><td style="width:28%">${v1 || '—'}</td>
      <th style="width:22%">${esc(k2)}</th><td>${v2 || '—'}</td></tr>`;
  }
  const infoTable = (rows) => `<div class="tbl-wrap"><table class="info-tbl"><tbody>${rows}</tbody></table></div>`;

  /* attendance the way a student is asked about it: per semester, and then
     per paper inside the semester they are standing in */
  function studentSemesterAttendance(sid) {
    const rows = new Map();
    Store.all('attendance').forEach(a => {
      const mark = (a.records || {})[sid];
      if (!mark) return;
      /* A session recorded before the class-context fields existed carries no
         semester of its own — it belongs to the one its paper is taught in. */
      const sem = +a.semester || +((Store.find('courses', a.courseId) || {}).semester) || 0;
      if (!rows.has(sem)) rows.set(sem, { sem, held: 0, present: 0 });
      const r = rows.get(sem);
      r.held++;
      if (mark === 'P') r.present++;
    });
    return [...rows.values()].sort((a, b) => a.sem - b.sem);
  }
  function studentPaperAttendance(sid) {
    const rows = new Map();
    Store.all('attendance').forEach(a => {
      const mark = (a.records || {})[sid];
      if (!mark) return;
      const c = Store.find('courses', a.courseId) || {};
      const key = a.paperCode || c.code || a.paperName || c.name || '—';
      if (!rows.has(key)) {
        rows.set(key, { code: key, name: a.paperName || c.name || '—',
                        sem: a.semester || c.semester || '—', held: 0, present: 0 });
      }
      const r = rows.get(key);
      r.held++;
      if (mark === 'P') r.present++;
    });
    return [...rows.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }
  /** the last day this student was marked, present or absent */
  function lastAttendanceDate(sid) {
    const dates = Store.all('attendance')
      .filter(a => (a.records || {})[sid]).map(a => a.date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  function viewStudentProfile() {
    /* A student opening "My Profile" lands here too. It is the same file — the
       only difference is that it is their own, so there is no roster to go back
       to and nothing on it for them to edit. */
    const own = user.role === 'student';
    const s = Store.find('students', own ? user.refId : profileStudentId);
    if (!s) return `<div class="panel"><p class="empty">That student is no longer on the roll.</p></div>`;
    const canEdit = !own && (!viewsMasterOnly() || user.role === 'admission');
    const tabs = stuTabsFor(own);
    if (!tabs.some(([k]) => k === stuTab)) stuTab = 'personal';
    const per = stuPart(s, 'personal');
    const last = lastAttendanceDate(s.id);

    const side = `<div class="panel stu-side">
      <div class="stu-photo">${s.photo
        ? `<img src="${esc(s.photo)}" alt="${esc(s.name || '')}">`
        : `<span>${esc((s.name || '?').trim()[0] || '?')}</span>`}</div>
      <div class="stu-lastatt"><span>Last Date of Class Attendance</span><strong>${esc(last || '—')}</strong></div>
      <div class="tbl-wrap"><table class="info-tbl"><tbody>
        ${infoRow('Registration No', `<span class="mono">${esc(s.roll || '—')}</span>`)}
        ${infoRow('Serial No.', esc(s.serialNo || '—'))}
        ${infoRow('Name', esc(s.name || '—'))}
        ${infoRow('Mentor', esc(s.mentor || '—'))}
        ${infoRow('Course', esc(s.course || '—'))}
        ${infoRow('Batch', esc(s.batch || '—'))}
        ${infoRow('Specialisation I', esc(specOf(s) || '—'))}
        ${infoRow('Specialisation II', esc(s.specialisation2 || '—'))}
        ${infoRow('Section', esc(s.section || '—'))}
        ${infoRow('Domain Email ID', esc(s.domainEmail || '—'))}
        ${infoRow('Email ID', esc(s.email || '—'))}
        ${infoRow('Mobile No', esc(s.phone || '—'))}
        ${infoRow('WhatsApp No', esc(s.whatsapp || '—'))}
        ${infoRow('Aadhaar No.', esc(s.aadhaar || '—'))}
        ${infoRow('Voter ID', esc(per.voterId || '—'))}
        ${infoRow('PAN No.', esc(per.pan || '—'))}
        ${infoRow('Driving License No.', esc(per.drivingLicense || '—'))}
        ${infoRow('Passport No.', esc(per.passport || '—'))}
        ${infoRow('Status', `<span class="pill ${(s.status || 'Active') === 'Active' ? 'green' : 'red'}">${
          esc(s.status || 'Active')}</span>`)}
      </tbody></table></div>
    </div>`;

    const html = `<div class="panel-tools" style="margin-bottom:14px">
        ${own ? '' : `<button class="btn-outline btn-sm" id="spBack">← All Students</button>`}
        ${canEdit ? `<button class="btn-primary btn-sm" id="spEdit">✎ Edit Student</button>` : ''}
        <button class="btn-outline btn-sm" id="spCard">🪪 Print ID Card</button>
        <button class="btn-outline btn-sm" id="spSheet">📄 Marksheet</button>
      </div>
      <div class="stu-profile">
        ${side}
        <div class="panel stu-main">
          <div class="fin-tabs" id="spTabs">${tabs.map(([k, label]) =>
            `<button class="fin-tab ${k === stuTab ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
          <div id="spBody">${studentTabHtml(s, stuTab)}</div>
        </div>
      </div>`;

    viewStudentProfile.after = () => {
      const back = $('#spBack');
      if (back) back.onclick = () => navigate('students');
      const edit = $('#spEdit');
      if (edit) edit.onclick = () => studentForm(s.id);
      $('#spCard').onclick = () => printIdCard(s.id);
      $('#spSheet').onclick = () => printMarksheet(s.id);
      const draw = () => {
        $('#spBody').innerHTML = studentTabHtml(s, stuTab);
        const t = $('#spAttToggle');
        if (t) t.onclick = () => { stuAttSubjectWise = !stuAttSubjectWise; draw(); };
      };
      $('#spTabs').querySelectorAll('[data-tab]').forEach(b => {
        b.onclick = () => {
          stuTab = b.dataset.tab;
          $('#spTabs').querySelectorAll('.fin-tab').forEach(x => x.classList.toggle('active', x === b));
          draw();
        };
      });
      draw();
    };
    return html;
  }

  function studentTabHtml(s, tab) {
    const per = stuPart(s, 'personal');
    const aca = stuPart(s, 'academicInfo');
    const addr = stuPart(s, 'addressInfo');
    const health = stuPart(s, 'health');
    const guardians = stuPart(s, 'guardians');
    const docs = stuPart(s, 'documents');

    if (tab === 'personal') {
      return `<h4 class="ro-sub">Personal Details</h4>` + infoTable(`
        <tr><th style="width:22%">Admission Category</th><td colspan="3" style="background:var(--warn-soft, #fdf6e3)">${
          esc(per.admissionCategory || '—')}</td></tr>
        ${infoRow2('Title', esc(per.title || '—'), 'Gender', esc(s.gender || '—'))}
        ${infoRow2('First Name', esc(s.firstName || '—'), 'Last Name', esc(s.lastName || '—'))}
        ${infoRow2('Middle Name', esc(s.middleName || '—'), 'Date of Birth', esc(s.dob || '—'))}
        ${infoRow2('Nationality', esc(per.nationality || '—'), 'Religion', esc(per.religion || '—'))}
        ${infoRow2('Blood Group', esc(s.bloodGroup || '—'), 'Birthplace', esc(per.birthplace || '—'))}
        ${infoRow2('Identification Mark', esc(per.identificationMark || '—'), 'Biometric Scan', esc(per.thumbId || '—'))}
        ${infoRow2('Hostel', esc(per.hostel || '—'), 'Transport', esc(per.transport || '—'))}
        ${infoRow2('Lunch', esc(per.lunch || '—'), 'NSS', esc(per.nss || '—'))}
        ${infoRow2('Languages Known', esc(per.languages || '—'), 'Hobbies', esc(per.hobbies || '—'))}`);
    }

    if (tab === 'academic') {
      const quals = Array.isArray(aca.qualifications) ? aca.qualifications : [];
      const qualRows = quals.length ? quals.map(q => `<tr>
          <td><strong>${esc(q.level || '—')}</strong></td><td>${esc(q.institute || '—')}</td>
          <td>${esc(q.year || '—')}</td><td style="text-align:right">${esc(q.marks || '—')}</td>
        </tr>`).join('')
        : `<tr><td colspan="4" class="empty">No previous qualifications on record.</td></tr>`;
      return `<h4 class="ro-sub">Academic Details</h4>` + infoTable(`
        ${infoRow2('Course', esc(s.course || '—'), 'Batch', esc(s.batch || '—'))}
        ${infoRow2('Specialisation I', esc(specOf(s) || '—'), 'Specialisation II', esc(s.specialisation2 || '—'))}
        ${infoRow2('Section', esc(s.section || '—'), 'Academic Year', esc(s.academicYear || '—'))}
        ${infoRow2('House', esc(s.house || '—'), 'Batch', esc(s.batch || '—'))}
        ${infoRow2('Year', esc(String(s.year || '—')), 'Semester', esc(String(s.semester || '—')))}
        ${infoRow2('Admission Date', esc(s.admissionDate || '—'), 'Entrance Examination', esc(aca.entranceExam || '—'))}
        ${infoRow2('Entrance Rank', esc(aca.entranceRank || '—'), 'CGPA', esc(String(s.cgpa ?? '—')))}
        ${infoRow2('Active Backlogs', esc(String(s.backlogs ?? 0)), 'Status', esc(s.status || 'Active'))}`)
        + `<h4 class="ro-sub">Previous Qualifications</h4>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Qualification</th><th>Institute Name</th><th>Passout Year</th>
          <th style="text-align:right">% Marks</th></tr></thead><tbody>${qualRows}</tbody></table></div>`;
    }

    if (tab === 'guardians') {
      if (!guardians.length) return `<h4 class="ro-sub">Guardians</h4><p class="empty">No guardian recorded.</p>`;
      return `<h4 class="ro-sub">Guardians Details</h4>` + guardians.map((g, i) => `
        <h4 class="ro-sub" style="margin-top:${i ? 22 : 10}px">${esc(g.relation || 'Guardian')}</h4>
        ${infoTable(`
          ${infoRow('Name', esc(g.name || '—'))}
          ${infoRow('Occupation', esc(g.occupation || '—'))}
          ${infoRow2('Mobile No', esc(g.mobile || '—'), 'Phone No', esc(g.phone || '—'))}
          ${infoRow2('Annual Income', g.income ? '₹' + esc(g.income) : '—', 'Email', esc(g.email || '—'))}
          ${infoRow('Qualification', esc(g.qualification || '—'))}
          ${infoRow('Home Address', esc(g.homeAddress || '—'))}`)}`).join('');
    }

    if (tab === 'address') {
      const block = (title, a) => `<h4 class="ro-sub">${title}</h4>` + infoTable(`
        ${infoRow('Address', esc(a.address || '—'))}
        ${infoRow2('City', esc(a.city || '—'), 'State', esc(a.state || '—'))}
        ${infoRow2('Country', esc(a.country || '—'), 'Pincode', esc(a.pincode || '—'))}`);
      return `<h4 class="ro-sub">Address Info</h4>`
        + block('Current Address', addr.current || {})
        + block('Permanent Address', addr.permanent || {});
    }

    if (tab === 'documents') {
      const rows = docs.length ? docs.map(d => `<tr>
          <td>${esc(d.type || '—')}</td><td>${esc(d.name || '—')}</td><td>${esc(d.copy || '—')}</td>
        </tr>`).join('')
        : `<tr><td colspan="3" class="empty">No documents on record.</td></tr>`;
      return `<h4 class="ro-sub">Original Docs</h4>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Document Type</th><th>Document Name</th><th>Original / Photo Copy</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    if (tab === 'fees') {
      const fin = financeRows().find(x => x.sid === s.id) || { total: 0, paid: 0, pending: 0, rows: [] };
      const payments = paymentsOf(s.id);
      const feeRows = fin.rows.length ? fin.rows.map(f => {
        const st = feeStatusOf(f.total, f.paid);
        return `<tr><td>Semester ${esc(f.semester || '—')}</td><td>${esc(f.academicYear || '—')}</td>
          <td style="text-align:right">${money(f.total)}</td><td style="text-align:right">${money(f.paid)}</td>
          <td style="text-align:right">${money(Math.max(0, (+f.total || 0) - (+f.paid || 0)))}</td>
          <td><span class="pill ${st.pill}">${st.label}</span></td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">No fee record.</td></tr>`;
      const payRows = payments.length ? payments.map(p => `<tr>
        <td class="mono">${esc(p.receiptNo || '—')}</td><td>${esc(p.date || '—')}</td>
        <td style="text-align:right">${money(p.amount)}</td><td>${esc(p.mode || '—')}</td></tr>`).join('')
        : `<tr><td colspan="4" class="empty">No payments recorded.</td></tr>`;
      return `<div class="stat-grid" style="margin-bottom:16px">
          ${statCard('💰', money(fin.total), 'Total Fee')}
          ${statCard('✅', money(fin.paid), 'Paid', 'c3')}
          ${statCard('⏳', money(fin.pending), 'Pending', fin.pending ? 'c4' : 'c3')}
        </div>
        <h4 class="ro-sub">Semester-wise Fee</h4>
        <div class="tbl-wrap"><table><thead><tr><th>Semester</th><th>Academic Year</th>
          <th style="text-align:right">Total</th><th style="text-align:right">Paid</th>
          <th style="text-align:right">Pending</th><th>Status</th></tr></thead>
          <tbody>${feeRows}</tbody></table></div>
        <h4 class="ro-sub">Payment History</h4>
        <div class="tbl-wrap"><table><thead><tr><th>Receipt</th><th>Date</th>
          <th style="text-align:right">Amount</th><th>Mode</th></tr></thead>
          <tbody>${payRows}</tbody></table></div>`;
    }

    if (tab === 'attendance') {
      const pct = (r) => r.held ? Math.round(r.present / r.held * 1000) / 10 : null;
      if (stuAttSubjectWise) {
        const rows = studentPaperAttendance(s.id);
        const body = rows.length ? rows.map(r => `<tr>
            <td class="mono">${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(String(r.sem))}</td>
            <td>${r.held}</td><td>${r.present}</td>
            <td><strong class="${pct(r) < 75 ? 'att-low' : 'att-ok'}">${pct(r)}%</strong></td>
          </tr>`).join('') : `<tr><td colspan="6" class="empty">No sessions recorded.</td></tr>`;
        return `<div class="tbl-wrap"><table><thead><tr>
            <th>Paper Code</th><th>Paper</th><th>Semester</th>
            <th>Classes Held</th><th>Attended</th><th>% Attendance</th>
          </tr></thead><tbody>${body}</tbody></table></div>
          <div style="text-align:center;margin-top:16px">
            <button class="btn-primary btn-sm" id="spAttToggle">↩ Back to Semester-wise</button></div>`;
      }
      const sems = studentSemesterAttendance(s.id);
      const bySem = new Map(sems.map(r => [r.sem, r]));
      const all = SEMESTERS.map(n => bySem.get(n) || { sem: n, held: 0, present: 0 });
      const body = all.map(r => `<tr>
        <td><strong style="color:var(--primary-dark)">${ordinalSem(r.sem)} Semester</strong></td>
        <td>${r.held}</td><td>${r.present}</td>
        <td>${r.held ? `<strong class="${pct(r) < 75 ? 'att-low' : 'att-ok'}">${pct(r)}%</strong>` : '—'}</td>
      </tr>`).join('');
      return `<div class="tbl-wrap"><table><thead><tr>
          <th>Semester</th><th>Total Classes Held</th><th>Total Classes Attended</th><th>% Attendance</th>
        </tr></thead><tbody>${body}</tbody></table></div>
        <div style="text-align:center;margin-top:16px">
          <button class="btn-primary btn-sm" id="spAttToggle">📄 View Subject Wise Detail Attendance</button></div>`;
    }

    if (tab === 'health') {
      return `<h4 class="ro-sub">Health Record</h4>` + infoTable(`
        ${infoRow2('Blood Group', esc(s.bloodGroup || '—'), 'Height', health.height ? esc(health.height) + ' cm' : '—')}
        ${infoRow2('Weight', health.weight ? esc(health.weight) + ' kg' : '—', 'Last Check-up', esc(health.lastCheckup || '—'))}
        ${infoRow('Allergies', esc(health.allergies || '—'))}
        ${infoRow('Medical Conditions', esc(health.conditions || '—'))}
        ${infoRow('Regular Medication', esc(health.medication || '—'))}
        ${infoRow2('Emergency Contact', esc(health.emergencyName || '—'), 'Emergency Phone', esc(health.emergencyPhone || '—'))}
        ${infoRow('Notes', esc(health.notes || '—'))}`);
    }

    // ID card
    const gpa = studentGPA(s.id);
    return `<h4 class="ro-sub">ID Card</h4>
      <div class="idcard-preview">
        <div class="idc-head"><img src="assets/nmiet-logo.png" alt=""><div>
          <strong>NMIET B-SCHOOL</strong><span>Bhubaneswar</span></div></div>
        <div class="idc-body">
          <div class="idc-photo">${s.photo ? `<img src="${esc(s.photo)}" alt="">` : '<span>No photo</span>'}</div>
          <div class="idc-fields">
            <div><label>Name</label><strong>${esc(s.name || '—')}</strong></div>
            <div><label>Reg No</label><strong class="mono">${esc(s.roll || '—')}</strong></div>
            <div><label>Course</label><strong>${esc(s.course || '—')} · ${esc(specOf(s) || '—')}</strong></div>
            <div><label>Batch</label><strong>${esc(s.batch || '—')}</strong></div>
            <div><label>Blood Group</label><strong>${esc(s.bloodGroup || '—')}</strong></div>
            <div><label>Phone</label><strong>${esc(s.phone || '—')}</strong></div>
          </div>
        </div>
      </div>
      <p style="font-size:12.5px;color:var(--muted);margin-top:10px">
        GPA on record: ${gpa ?? '—'}. Use "Print ID Card" above for the printable version.</p>`;
  }

  function ordinalSem(n) {
    return ({ 1: '1ST', 2: '2ND', 3: '3RD' })[n] || (n + 'TH');
  }

  function studentProfileModal(sid) {
    const s = Store.find('students', sid);
    if (!s) return;
    const fin = financeRows().find(x => x.sid === sid) || { total: 0, paid: 0, pending: 0, rows: [] };
    const att = studentAttendancePct(sid);
    const gpa = studentGPA(sid);
    const marks = Store.all('marks').filter(m => m.studentId === sid);
    const payments = paymentsOf(sid);
    const loans = Store.all('issues').filter(i => i.studentId === sid);

    const row = (k, v) => `<tr><td style="font-weight:600;width:180px">${esc(k)}</td><td>${v}</td></tr>`;
    const academic = marks.length ? marks.map(m => {
      const c = Store.find('courses', m.courseId) || {};
      const pct = markPercent(m);
      return `<tr><td>${esc(c.code || '—')}</td><td>${esc(c.name || '—')}</td>
        <td style="text-align:right">${m.internal ?? '—'}</td>
        <td style="text-align:right">${pct === null ? '—' : pct + '%'}</td>
        <td><span class="pill ${pct !== null && pct >= 40 ? 'green' : 'red'}">${pct === null ? '—' : gradeFor(pct).g}</span></td></tr>`;
    }).join('') : `<tr><td colspan="5" class="empty">No marks recorded yet.</td></tr>`;

    const feeRows = fin.rows.length ? fin.rows.map(f => {
      const st = feeStatusOf(f.total, f.paid);
      return `<tr><td>Semester ${esc(f.semester || '—')}</td><td>${esc(f.academicYear || '—')}</td>
        <td style="text-align:right">${money(f.total)}</td><td style="text-align:right">${money(f.paid)}</td>
        <td style="text-align:right">${money(Math.max(0, (+f.total || 0) - (+f.paid || 0)))}</td>
        <td><span class="pill ${st.pill}">${st.label}</span></td></tr>`;
    }).join('') : `<tr><td colspan="6" class="empty">No fee record.</td></tr>`;

    const payRows = payments.length ? payments.slice(0, 10).map(p => `<tr>
      <td class="mono">${esc(p.receiptNo || '—')}</td><td>${esc(p.date || '—')}</td>
      <td style="text-align:right">${money(p.amount)}</td><td>${esc(p.mode || '—')}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">No payments recorded.</td></tr>`;

    openModal('Student Profile — ' + s.name, `
      <div style="display:flex;gap:18px;align-items:center;margin-bottom:18px">
        <div class="logo-circle">${s.photo ? `<img src="${esc(s.photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((s.name || '?')[0])}</div>
        <div><h3 style="color:var(--primary-dark)">${esc(s.name)}</h3>
        <p style="color:var(--muted);font-size:13px">${esc(s.roll)} · ${esc(s.course || '—')} · ${esc(s.branch || '—')} · Sem ${esc(s.semester || '—')}</p></div>
      </div>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('📈', att === null ? '—' : att + '%', 'Attendance', att !== null && att < 75 ? 'c4' : 'c3')}
        ${statCard('🎯', gpa ?? '—', 'GPA', 'c2')}
        ${statCard('💰', money(fin.paid), 'Fees Paid', 'c3')}
        ${statCard('⏳', money(fin.pending), 'Fees Pending', fin.pending ? 'c4' : 'c3')}
      </div>
      <h4 class="ro-sub">Academic Details</h4>
      <div class="tbl-wrap"><table><tbody>
        ${row('Student ID', esc(s.roll))}
        ${row('Course', esc(s.course || '—'))}
        ${row('Specialisation', esc(s.branch || '—'))}
        ${row('Year / Semester', `${esc(s.year || '—')} / ${esc(s.semester || '—')}`)}
        ${row('Section', esc(s.section || '—'))}
        ${row('Academic Year', esc(s.academicYear || '—'))}
        ${row('Email', esc(s.email || '—'))}
        ${row('Phone', esc(s.phone || '—'))}
        ${row('Books on loan', loans.filter(i => !i.returnDate).length + ' of ' + loans.length + ' ever issued')}
      </tbody></table></div>
      <h4 class="ro-sub">Marks &amp; Results</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Course</th>
        <th style="text-align:right">Internal</th><th style="text-align:right">%</th><th>Grade</th>
      </tr></thead><tbody>${academic}</tbody></table></div>
      <h4 class="ro-sub">Fee Details</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Semester</th><th>Academic Year</th>
        <th style="text-align:right">Total</th><th style="text-align:right">Paid</th>
        <th style="text-align:right">Pending</th><th>Status</th>
      </tr></thead><tbody>${feeRows}</tbody></table></div>
      <h4 class="ro-sub">Payment History</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Receipt</th><th>Date</th>
        <th style="text-align:right">Amount</th><th>Mode</th></tr></thead><tbody>${payRows}</tbody></table></div>
      <div class="form-actions">
        <button class="btn-outline" id="cx">Close</button>
        <button class="btn-outline" id="pid">🪪 ID Card</button>
        <button class="btn-primary" id="psheet">📄 Marksheet</button></div>`, true);
    $('#cx').onclick = closeModal;
    $('#pid').onclick = () => printIdCard(sid);
    $('#psheet').onclick = () => printMarksheet(sid);
  }

  /* the Students page as an exportable report */
  function studentReport(rows) {
    return {
      title: 'Student Report', sheetName: 'Students', subtitle: reportStamp(),
      columns: [
        { header: 'Student ID', key: 'roll', width: 14 },
        { header: 'First Name', key: 'firstName', width: 16 },
        { header: 'Middle Name', key: 'middleName', width: 14 },
        { header: 'Last Name', key: 'lastName', width: 16 },
        { header: 'Batch', key: 'batch', width: 14 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Course', key: 'course', width: 12 },
        { header: 'Department', key: 'branch', width: 12 },
        { header: 'Specialisation', key: 'specialisation', width: 18 },
        { header: 'Year', key: 'year', width: 8, type: 'number' },
        { header: 'Semester', key: 'semester', width: 10, type: 'number' },
        { header: 'Section', key: 'section', width: 9 },
        { header: 'Academic Year', key: 'academicYear', width: 15 },
        { header: 'Email', key: 'email', width: 26 },
        { header: 'Phone', key: 'phone', width: 14 },
        { header: 'Attendance %', key: 'attendance', width: 14 },
        { header: 'GPA', key: 'gpa', width: 9 },
      ],
      rows: rows.map(s => Object.assign({}, s, {
        attendance: studentAttendancePct(s.id) ?? '—',
        gpa: studentGPA(s.id) ?? '—',
      })),
      totals: { roll: 'TOTAL', name: rows.length + ' students' },
    };
  }

  // full book issue/return history for one student (admin + librarian)
  function studentBooksModal(sid) {
    const s = Store.find('students', sid); if (!s) return;
    const history = Store.all('issues').filter(i => i.studentId === sid)
      .sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || ''));
    const onLoan = history.filter(i => !i.returnDate);
    const overdue = onLoan.filter(i => i.dueDate < today());

    const rows = history.map(i => {
      const b = Store.find('books', i.bookId) || {};
      const isOverdue = !i.returnDate && i.dueDate < today();
      const status = i.returnDate ? 'Returned' : (isOverdue ? 'Overdue' : 'Issued');
      const cls = i.returnDate ? 'blue' : (isOverdue ? 'red' : 'green');
      return `<tr>
        <td>${esc(b.title || '?')}</td>
        <td>${esc(i.issueDate || '—')}</td>
        <td${isOverdue ? ' style="color:var(--red)"' : ''}>${esc(i.dueDate || '—')}</td>
        <td>${i.returnDate ? esc(i.returnDate) : '—'}</td>
        <td><span class="pill ${cls}">${status}</span></td>
      </tr>`;
    }).join('') || `<tr><td colspan="5" class="empty">This student has not issued any book yet.</td></tr>`;

    openModal('Book History — ' + s.name, `
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
        ${esc(s.roll)} · ${esc(s.branch)} · Sem ${esc(s.semester)} · Sec ${esc(s.section || 'A')}</p>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('📚', history.length, 'Total Issued')}
        ${statCard('🔖', onLoan.length, 'Currently On Loan', 'c2')}
        ${statCard('⚠️', overdue.length, 'Overdue', overdue.length ? 'c4' : 'c3')}
      </div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Book</th><th>Issued On</th><th>Due Date</th><th>Returned On</th><th>Status</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="form-actions"><button type="button" class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
  }

  /* ---------- phone: digits only, exactly 10 (blank allowed — optional field) ---------- */
  function bindPhoneInput(el) {
    if (!el) return;
    el.maxLength = 10;
    el.oninput = () => { el.value = el.value.replace(/\D/g, '').slice(0, 10); };
  }
  function phoneValid(v) {
    const p = String(v || '').trim();
    return p === '' || /^\d{10}$/.test(p);
  }

  /* ---------- the student form ---------- */
  const TITLES_LIST = ['Mr.', 'Ms.', 'Mrs.', 'Dr.'];
  const GENDERS = ['Male', 'Female', 'Other'];
  const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  const YES_NO = ['No', 'Yes'];
  const ADMISSION_CATEGORIES = ['General', 'OBC', 'SEBC', 'SC', 'ST', 'EWS', 'TFW',
                               'Physically Handicapped', 'Management', 'NRI'];
  const QUAL_LEVELS = ['10th', '12th', 'ITI', 'Diploma', '+3', 'BCA', 'BBA', 'B.Tech', 'Other'];
  /* A club is the specialisation's own society — Marketing has the Marketing
     Club — so the list is built from the specialisations rather than typed
     again and left to drift. */
  const clubList = () => specialisationList().map(v => v + ' Club');
  const DOC_TYPES = ['Aadhaar', 'PAN', 'Marksheet', 'Physically Handicapped Certificate',
                     'CLC', 'Migration Certificate', 'Caste Certificate',
                     'Income Certificate', 'Photograph', 'Other'];
  /* Which of the two the college is holding. A date of issue is printed on the
     document itself; what the desk needs to know later is whether the original
     is in the cabinet or only a copy of it. */
  const DOC_COPIES = ['Original', 'Photo Copy'];

  const fText = (name, label, val, extra) =>
    `<div class="field"><label>${label}</label>
      <input name="${name}" value="${esc(val ?? '')}" ${extra || ''}></div>`;
  const fDate = (name, label, val) =>
    `<div class="field"><label>${label}</label>
      <input type="date" name="${name}" value="${esc(val || '')}"></div>`;
  const fSel = (name, label, val, list, blank) =>
    `<div class="field"><label>${label}</label><select name="${name}">
      ${blank === false ? '' : '<option value=""></option>'}
      ${list.map(o => `<option ${String(o) === String(val ?? '') ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select></div>`;
  const fArea = (name, label, val, rows) =>
    `<div class="field full"><label>${label}</label>
      <textarea name="${name}" rows="${rows || 2}">${esc(val || '')}</textarea></div>`;

  /** one guardian card in the form — rendered for existing rows and for new ones */
  /* The three a student's file always has. Named here, so the form does not
     ask who each one is. */
  const GUARDIAN_ROLES = ['Father', 'Mother', 'Local Guardian'];
  /* An employee's file keeps the two the college asks for. No local guardian:
     that is an admission question, asked of somebody who has moved cities to
     study, not of the staff member who is already here. */
  const EMP_GUARDIAN_ROLES = ['Father', 'Mother'];

  /** one of the three fixed blocks on the admission form */
  function fixedGuardianCard(g, role) {
    g = g || {};
    return `<div class="sub-card" data-guardian data-role="${esc(role)}">
      <div class="sub-card-head"><strong>${esc(role)}</strong></div>
      <div class="form-grid">
        ${fText('g_name', 'Name', g.name)}
        ${fText('g_occupation', 'Occupation', g.occupation)}
        ${fText('g_mobile', 'Mobile No', g.mobile, 'inputmode="numeric" maxlength="10"')}
        ${fText('g_phone', 'Phone No', g.phone)}
        ${fText('g_income', 'Annual Income (₹)', g.income, 'inputmode="numeric"')}
        ${fText('g_email', 'Email', g.email, 'type="email"')}
        ${fText('g_qualification', 'Qualification', g.qualification)}
        ${fArea('g_homeAddress', 'Home Address', g.homeAddress)}
      </div></div>`;
  }

  /* What the office took in at admission: the originals themselves, not scans
     of them. The number lives on the document, and the document is in the file
     cabinet — the form records that it was handed over. */
  function originalDocRow(d) {
    d = d || {};
    return `<div class="sub-card" data-document>
      <div class="form-grid">
        ${fSel('d_type', 'Document Type', d.type, DOC_TYPES)}
        ${fText('d_name', 'Document Name', d.name)}
        ${fSel('d_copy', 'Original / Photo Copy', d.copy, DOC_COPIES)}
      </div></div>`;
  }

  /** the employee version: a staff file keeps the number and the scan */
  function documentRow(d, i) {
    d = d || {};
    return `<div class="sub-card" data-document>
      <div class="sub-card-head"><strong>Document ${i + 1}</strong>
        <button type="button" class="btn-outline btn-sm" data-remove-document>Remove</button></div>
      <div class="form-grid">
        ${fText('d_name', 'Document Name', d.name)}
        ${fSel('d_type', 'Type', d.type, DOC_TYPES)}
        ${fText('d_number', 'Number', d.number)}
        ${fDate('d_issued', 'Issued On', d.issued)}
        <div class="field full"><label>File (optional, max 1 MB)</label>
          <input type="file" data-doc-file accept="image/*,application/pdf">
          <input type="hidden" data-doc-value value="${esc(d.file || '')}">
          <small style="color:var(--muted);font-size:11.5px" data-doc-note>${
            d.file ? 'A file is attached — choosing another replaces it.' : ''}</small>
        </div>
      </div></div>`;
  }

  function studentForm(id) {
    const s = id ? Store.find('students', id) : {};
    const per = stuPart(s, 'personal');
    const aca = stuPart(s, 'academicInfo');
    const addr = stuPart(s, 'addressInfo');
    const health = stuPart(s, 'health');
    const guardians = stuPart(s, 'guardians');
    const docs = stuPart(s, 'documents');
    const cur = addr.current || {};
    const perm = addr.permanent || {};
    const quals = Array.isArray(aca.qualifications) ? aca.qualifications : [];
    const qualOf = (level) => quals.find(q => q.level === level) || {};

    const TABS = [['basic', 'Basic'], ['personal', 'Personal'], ['academic', 'Academic'],
                  ['guardians', 'Guardians'], ['address', 'Address'],
                  ['health', 'Health'], ['docs', 'Documents']];

    const addressBlock = (prefix, a) => `<div class="form-grid">
      ${fArea(prefix + '_address', 'Address', a.address)}
      ${fText(prefix + '_city', 'City', a.city)}
      ${fText(prefix + '_state', 'State', a.state)}
      ${fText(prefix + '_country', 'Country', a.country || 'India')}
      ${fText(prefix + '_pincode', 'Pincode', a.pincode, 'inputmode="numeric" maxlength="6"')}
    </div>`;

    openModal((id ? 'Edit' : 'Add') + ' Student', `<form id="f">
      <div class="fin-tabs" id="sfTabs">${TABS.map(([k, label], i) =>
        `<button type="button" class="fin-tab ${i ? '' : 'active'}" data-pane="${k}">${label}</button>`).join('')}</div>

      <div class="sf-pane" data-pane="basic">
        <div class="form-grid">
          <div class="field"><label>Registration Number</label>
            <input name="roll" id="rollInput" inputmode="numeric" maxlength="${regNoLength()}"
                   placeholder="${regNoLength()} digits" value="${esc(s.roll || '')}" required></div>
          ${fText('serialNo', 'Roll No.', s.serialNo)}
          ${fSel('per_title', 'Title', per.title, TITLES_LIST)}
          <div class="field"><label>First Name</label>
            <input name="firstName" value="${esc(s.firstName || s.name || '')}" required></div>
          ${fText('middleName', 'Middle Name', s.middleName)}
          ${fText('lastName', 'Last Name', s.lastName)}
          ${fText('email', 'Email ID', s.email, 'type="email" placeholder="name@example.com"')}
          ${fText('domainEmail', 'Domain Email ID', s.domainEmail, 'type="email"')}
          <div class="field"><label>Mobile No</label>
            <input name="phone" id="phoneInput" inputmode="numeric" placeholder="10-digit number"
                   value="${esc(s.phone || '')}"></div>
          ${fText('whatsapp', 'WhatsApp No', s.whatsapp, 'inputmode="numeric" maxlength="10"')}
          <div class="field"><label>Course</label>
            <select name="course" id="stuFormCourse">${courseOptions(s.course, true)}</select></div>
          <div class="field"><label>Branch</label>
            <select name="branchName" id="stuFormBranch"><option value=""></option>${
              listOptions('branchName', s.branchName || '', true)}</select></div>
          <div class="field"><label>Specialisation I</label>
            <select name="specialisation" id="stuFormSpec">${specialisationOptions(s.specialisation, true)}</select></div>
          <div class="field"><label>Specialisation II</label>
            <select name="specialisation2" id="stuFormSpec2">
              <option value="">— None —</option>${specialisationOptions(s.specialisation2, true)}</select></div>
          <div class="field"><label>Semester</label>
            <input name="semester" type="number" min="1" max="4" value="${s.semester || 1}"></div>
          ${fText('section', 'Section', s.section || 'A')}
          ${fText('batch', 'Batch', s.batch, 'placeholder="e.g. 2025-2027"')}
          <div class="field"><label>Club</label><select name="house">
            <option value="">— None —</option>
            ${clubList().map(c => `<option ${c === s.house ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select></div>
          ${fDate('admissionDate', 'Admission Date', s.admissionDate)}
          ${fText('mentor', 'Mentor', s.mentor)}
          ${fText('aadhaar', 'Aadhaar No.', s.aadhaar, 'inputmode="numeric" maxlength="12"')}
          <div class="field"><label>Status</label><select name="status">${
            ['Active', 'Inactive'].map(v =>
              `<option ${((s.status || 'Active') === v) ? 'selected' : ''}>${v}</option>`).join('')
          }</select></div>
          ${fText('h_emergencyPhone', 'Emergency Contact No', health.emergencyPhone, 'inputmode="numeric" maxlength="10"')}
          ${fText('h_emergencyName', 'Emergency Contact Name', health.emergencyName)}
          ${photoField(s.photo)}
        </div>
        ${id ? `<h4 class="ro-sub">Placement Eligibility</h4>
        <p style="font-size:12px;color:var(--muted);margin:-4px 0 10px">
          Used by the placement cell to work out which drives this student qualifies for.
          Leave the CGPA blank to fall back to the average of their internal marks.</p>
        <div class="form-grid">
          <div class="field"><label>CGPA</label>
            <input name="cgpa" type="number" step="0.01" min="0" max="10" value="${esc(s.cgpa ?? '')}"></div>
          <div class="field"><label>Active Backlogs</label>
            <input name="backlogs" type="number" min="0" value="${esc(s.backlogs ?? 0)}"></div>
        </div>` : ''}
      </div>

      <div class="sf-pane hidden" data-pane="personal">
        <div class="form-grid">
          ${fSel('per_admissionCategory', 'Admission Category', per.admissionCategory, ADMISSION_CATEGORIES)}
          ${fSel('gender', 'Gender', s.gender, GENDERS)}
          ${fDate('dob', 'Date of Birth', s.dob)}
          ${fSel('bloodGroup', 'Blood Group', s.bloodGroup, BLOOD_GROUPS)}
          ${fText('per_nationality', 'Nationality', per.nationality || 'Indian')}
          ${fText('per_religion', 'Religion', per.religion)}
          ${fText('per_birthplace', 'Birthplace', per.birthplace)}
          ${fText('per_identificationMark', 'Identification Mark', per.identificationMark)}
          ${fText('per_thumbId', 'Biometric Scan', per.thumbId)}
          ${fSel('per_hostel', 'Hostel', per.hostel || 'No', YES_NO, false)}
          ${fSel('per_transport', 'Transport', per.transport || 'No', YES_NO, false)}
          ${fSel('per_lunch', 'Lunch', per.lunch || 'No', YES_NO, false)}
          ${fSel('per_nss', 'NSS', per.nss || 'No', YES_NO, false)}
          ${fText('per_voterId', 'Voter ID', per.voterId)}
          ${fText('per_pan', 'PAN No.', per.pan)}
          ${fText('per_drivingLicense', 'Driving License No.', per.drivingLicense)}
          ${fText('per_passport', 'Passport No.', per.passport)}
          ${fText('per_languages', 'Languages Known', per.languages, 'placeholder="Odia, Hindi, English"')}
          ${fText('per_hobbies', 'Hobbies', per.hobbies, 'placeholder="Cricket, Reading"')}
        </div>
      </div>

      <div class="sf-pane hidden" data-pane="academic">
        <div class="form-grid">
          ${fText('aca_entranceExam', 'Entrance Examination', aca.entranceExam, 'placeholder="e.g. CAT, OJEE"')}
          ${fText('aca_entranceRank', 'Entrance Rank', aca.entranceRank, 'inputmode="numeric"')}
        </div>
        <h4 class="ro-sub">Previous Qualifications</h4>
        <div class="tbl-wrap"><table><thead><tr>
          <th style="width:16%">Qualification</th><th>Institute Name</th>
          <th style="width:18%">Passout Year</th><th style="width:16%">% Marks</th>
        </tr></thead><tbody>${QUAL_LEVELS.map(level => {
          const q = qualOf(level);
          return `<tr data-qual="${esc(level)}">
            <td><strong>${esc(level)}</strong></td>
            <td><input data-q="institute" value="${esc(q.institute || '')}"></td>
            <td><input data-q="year" inputmode="numeric" maxlength="4" value="${esc(q.year || '')}"></td>
            <td><input data-q="marks" value="${esc(q.marks || '')}"></td></tr>`;
        }).join('')}</tbody></table></div>
      </div>

      <div class="sf-pane hidden" data-pane="guardians">
        <div id="sfGuardians">${GUARDIAN_ROLES.map(role =>
          fixedGuardianCard(guardians.find(g => g.relation === role), role)).join('')}</div>
      </div>

      <div class="sf-pane hidden" data-pane="address">
        <h4 class="ro-sub">Current Address</h4>
        ${addressBlock('cur', cur)}
        <h4 class="ro-sub">Permanent Address
          <button type="button" class="btn-outline btn-sm" id="sfSameAddr" style="float:right">
            Copy from current</button></h4>
        ${addressBlock('perm', perm)}
      </div>

      <div class="sf-pane hidden" data-pane="health">
        <div class="form-grid">
          ${fText('h_height', 'Height (cm)', health.height, 'inputmode="numeric"')}
          ${fText('h_weight', 'Weight (kg)', health.weight, 'inputmode="numeric"')}
          ${fDate('h_lastCheckup', 'Last Check-up', health.lastCheckup)}
          ${fArea('h_allergies', 'Allergies', health.allergies)}
          ${fArea('h_conditions', 'Medical Conditions', health.conditions)}
          ${fArea('h_medication', 'Regular Medication', health.medication)}
          ${fArea('h_notes', 'Notes', health.notes)}
        </div>
      </div>

      <div class="sf-pane hidden" data-pane="docs">
        <div id="sfDocs">${(docs.length ? docs : [{}]).map(originalDocRow).join('')}</div>
        <button type="button" class="btn-outline btn-sm" id="sfAddDoc">+ Add Document</button>
      </div>

      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);

    /* ---- wiring ---- */
    $('#cx').onclick = closeModal;
    $('#rollInput').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, ''); };
    bindPhoneInput($('#phoneInput'));
    bindCustomList($('#stuFormBranch'), 'branchName');
    bindCustomList($('#stuFormSpec'), 'specialisation');
    bindCustomList($('#stuFormSpec2'), 'specialisation');
    bindCustomList($('#stuFormCourse'), 'course');
    bindPhotoField();

    const panes = () => document.querySelectorAll('.sf-pane');
    $('#sfTabs').querySelectorAll('[data-pane]').forEach(btn => {
      btn.onclick = () => {
        $('#sfTabs').querySelectorAll('.fin-tab').forEach(b => b.classList.toggle('active', b === btn));
        panes().forEach(p => p.classList.toggle('hidden', p.dataset.pane !== btn.dataset.pane));
      };
    });

    const renumber = (sel, word) => {
      document.querySelectorAll(sel).forEach((card, i) => {
        const h = card.querySelector('.sub-card-head strong');
        if (h) h.textContent = `${word} ${i + 1}`;
      });
    };
    const bindDocRemovals = () => {
      document.querySelectorAll('[data-remove-document]').forEach(b => {
        b.onclick = () => { b.closest('[data-document]').remove(); renumber('[data-document]', 'Document'); };
      });
    };
    /* a document file is kept with the record, so it has to be small — a
       scanned certificate at full resolution would bloat every bootstrap */
    const bindDocFiles = () => {
      document.querySelectorAll('[data-doc-file]').forEach(input => {
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return;
          if (file.size > 1024 * 1024) {
            toast('That file is over 1 MB — attach a smaller scan.', 'err');
            input.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const card = input.closest('[data-document]');
            card.querySelector('[data-doc-value]').value = reader.result;
            card.querySelector('[data-doc-note]').textContent = 'Attached: ' + file.name;
          };
          reader.readAsDataURL(file);
        };
      });
    };
    bindDocRemovals(); bindDocFiles();

    $('#sfAddDoc').onclick = () => {
      $('#sfDocs').insertAdjacentHTML('beforeend', originalDocRow({}));
    };
    $('#sfSameAddr').onclick = () => {
      ['address', 'city', 'state', 'country', 'pincode'].forEach(k => {
        const from = document.querySelector(`[name="cur_${k}"]`);
        const to = document.querySelector(`[name="perm_${k}"]`);
        if (from && to) to.value = from.value;
      });
      toast('Copied from the current address.');
    };

    /* ---- save ---- */
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      const d = formData(f);

      // A record enrolled under an older scheme keeps its number: the digits
      // rule applies to what is being written now, not retrospectively, or
      // correcting a phone number on a 2019 student would be impossible.
      const regChanged = !id || String(d.roll || '') !== String(s.roll || '');
      const regBad = regChanged ? regNoProblem(d.roll, id) : regNoDuplicate(d.roll, id);
      if (regBad) { toast(regBad, 'err'); return; }
      if (!phoneValid(d.phone)) { toast('Mobile number must be exactly 10 digits.', 'err'); return; }
      if (d.whatsapp && !/^\d{10}$/.test(d.whatsapp)) {
        toast('WhatsApp number must be exactly 10 digits.', 'err'); return;
      }
      if (d.h_emergencyPhone && !/^\d{10}$/.test(d.h_emergencyPhone)) {
        toast('Emergency contact number must be exactly 10 digits.', 'err'); return;
      }
      if (d.aadhaar && !/^\d{12}$/.test(d.aadhaar)) {
        toast('Aadhaar number must be exactly 12 digits.', 'err'); return;
      }
      /* A number nobody else holds. Two students sharing a mobile is the same
         mistake as two sharing a registration number — the office rings one and
         reaches the other. */
      const clash = takenBy('students', 'phone', d.phone, id)
        || takenBy('students', 'whatsapp', d.whatsapp, id)
        || takenBy('students', 'aadhaar', d.aadhaar, id);
      if (clash) { toast(clash, 'err'); return; }
      // the placement fields are only on the form when editing — a student
      // being admitted today has neither a CGPA nor a backlog yet
      if (d.cgpa != null && d.cgpa !== '' && (isNaN(+d.cgpa) || +d.cgpa < 0 || +d.cgpa > 10)) {
        toast('CGPA must be between 0 and 10.', 'err'); return;
      }

      // pull the prefixed fields out into the blob each tab is stored as
      const take = (prefix) => {
        const out = {};
        Object.keys(d).forEach(k => {
          if (k.startsWith(prefix)) { out[k.slice(prefix.length)] = d[k]; delete d[k]; }
        });
        return out;
      };
      const personal = take('per_');
      const academicInfo = take('aca_');
      const health = take('h_');
      const current = take('cur_');
      const permanent = take('perm_');
      Object.keys(d).forEach(k => { if (k.startsWith('g_') || k.startsWith('d_')) delete d[k]; });

      academicInfo.qualifications = [...f.querySelectorAll('[data-qual]')].map(tr => ({
        level: tr.dataset.qual,
        institute: (tr.querySelector('[data-q="institute"]').value || '').trim(),
        year: (tr.querySelector('[data-q="year"]').value || '').trim(),
        marks: (tr.querySelector('[data-q="marks"]').value || '').trim(),
      })).filter(q => q.institute || q.year || q.marks);

      // the relation is the block's own name, so nobody has to say it twice
      const guardianRows = [...f.querySelectorAll('[data-guardian]')].map(card => {
        const val = (n) => (card.querySelector(`[name="g_${n}"]`).value || '').trim();
        return { relation: card.dataset.role, name: val('name'), occupation: val('occupation'),
                 mobile: val('mobile'), phone: val('phone'), income: val('income'),
                 email: val('email'), qualification: val('qualification'),
                 homeAddress: val('homeAddress') };
      }).filter(g => g.name || g.mobile);
      const badGuardian = guardianRows.find(g => g.mobile && !/^\d{10}$/.test(g.mobile));
      if (badGuardian) {
        toast(`The ${badGuardian.relation.toLowerCase()}'s mobile number must be exactly 10 digits.`, 'err');
        return;
      }

      const documents = [...f.querySelectorAll('[data-document]')].map(card => {
        const val = (n) => (card.querySelector(`[name="d_${n}"]`).value || '').trim();
        return { type: val('type'), name: val('name'), copy: val('copy') };
      }).filter(x => x.name || x.type);

      d.personal = personal;
      d.academicInfo = academicInfo;
      d.addressInfo = { current, permanent };
      d.health = health;
      d.guardians = guardianRows;
      d.documents = documents;

      // every other screen — ID card, marksheet, fee receipt, placement list —
      // prints `name`, so it is composed here rather than taught to each of them
      d.name = [d.firstName, d.middleName, d.lastName]
        .map(x => (x || '').trim()).filter(Boolean).join(' ');
      d.semester = +d.semester;
      d.year = yearForSemester(d.semester);
      // one programme, asked for once: the department is the course
      d.branch = d.course;
      /* The form no longer asks for the session — the fee structure is looked
         up per course and year, the Semester Update page filters by it and the
         profile prints it, so a blank would surface later as a fee that does
         not resolve. An existing student keeps whatever they were admitted
         under; a new one gets the session running now. */
      if (!id) d.academicYear = currentAcademicYear();
      d.backlogs = (d.backlogs == null || d.backlogs === '') ? 0 : +d.backlogs;
      if (d.cgpa == null) delete d.cgpa;
      if (id) Store.update('students', id, d);
      else { Store.add('students', d); ensureStudentLogin(d); }
      closeModal(); toast('Student saved.'); render();
    };
  }

  /* The registration number identifies a student for their whole time here —
     it prints on the ID card, it is their login, and every fee and placement
     record hangs off it. Two students sharing one, or one being a digit short,
     is the kind of mistake that is found months later. */
  /* Whoever else already holds this value in this column, as a message, or
     null. Blank is not a clash — plenty of records have no WhatsApp number. */
  const FIELD_LABEL = { phone: 'Mobile number', whatsapp: 'WhatsApp number',
                        aadhaar: 'Aadhaar number', email: 'Email' };
  function takenBy(col, field, value, excludeId) {
    const v = String(value || '').trim();
    if (!v) return null;
    const clash = Store.all(col).find(x =>
      String(x[field] || '').trim() === v && x.id !== excludeId);
    return clash
      ? `${FIELD_LABEL[field] || field} ${v} already belongs to ${clash.name || clash.roll || 'another record'}.`
      : null;
  }

  /* Staff sit in one table per kind, but an employee id is printed on one
     card and typed into one attendance machine — it has to be unique across all
     of them, not merely within the table the form happens to write to. The same
     goes for a university registration number and an Aadhaar: one number, one
     person. Blank is never a clash; plenty of records carry none of these. */
  const STAFF_TABLES = ['faculty', 'accountants', 'centerheads', 'placementofficers',
                        'coordinators', 'admissions'];
  const STAFF_FIELD_LABEL = { empId: 'Employee ID', bputRegdNo: 'BPUT Regd No.',
                              aadhaar: 'Aadhaar number', attendanceCardId: 'Attendance Card ID' };
  function staffFieldTaken(field, value, excludeId) {
    const v = String(value || '').trim().toLowerCase();
    if (!v) return null;
    for (const col of STAFF_TABLES) {
      const clash = Store.all(col).find(x =>
        String(x[field] || '').trim().toLowerCase() === v && x.id !== excludeId);
      if (clash) {
        return `${STAFF_FIELD_LABEL[field] || field} "${String(value).trim()}" already belongs to ${
          clash.name || 'another employee'}.`;
      }
    }
    return null;
  }
  /** the first of these that somebody else already holds, as a message */
  function staffClash(d, excludeId) {
    return ['empId', 'bputRegdNo', 'aadhaar', 'attendanceCardId']
      .map(f => staffFieldTaken(f, d[f], excludeId)).find(Boolean) || null;
  }

  const DEFAULT_REG_LENGTH = 10;
  function regNoLength() {
    const row = settingRow('regNoLength');
    const n = parseInt(row && row.value, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_REG_LENGTH;
  }
  /** Whoever else already holds this number, or null. Checked on every save,
      old scheme or new — two students with one number is never acceptable. */
  function regNoDuplicate(roll, excludeId) {
    const v = String(roll || '').trim();
    const clash = Store.all('students').find(x => String(x.roll || '') === v && x.id !== excludeId);
    return clash ? `Registration number ${v} already belongs to ${clash.name}.` : null;
  }
  /** A message naming what is wrong with this registration number, or null. */
  function regNoProblem(roll, excludeId) {
    const v = String(roll || '').trim();
    const len = regNoLength();
    if (!/^\d+$/.test(v)) return 'Registration number must be digits only.';
    if (v.length !== len) return `Registration number must be exactly ${len} digits (this one has ${v.length}).`;
    return regNoDuplicate(v, excludeId);
  }

  function ensureStudentLogin(s) {
    Store.add('users', { username: s.roll, password: 'pass123', role: 'student', refId: s.id, name: s.name });
  }

  /* ==================== BULK UPLOAD (Excel / CSV) ====================
     Adding a whole intake one modal at a time is the slowest thing in this
     app. The spreadsheet the office already keeps is uploaded instead, and
     nothing is written until the admin has seen, row by row, what will be
     created and what will be skipped and why. */
  const DEFAULT_IMPORT_PASSWORD = 'pass123';

  /* Columns marked `into` are collected into one of the record's JSON blobs —
     `into:'personal', as:'title'` writes personal.title. `into:'father'` and
     the rest build the named family blocks the forms ask for. `into:'current'`
     / `'permanent'` build the two addresses. */
  const IMPORT_SPECS = {
    students: {
      title: 'Students',
      collection: 'students',
      keyField: 'roll',
      fileBase: 'NMIET-BSCHOOL-Students-Template',
      columns: [
        { key:'roll', header:'Registration No', required:true,
          aliases:['reg no','regno','reg. no','registration',
                   'registration no','registration number','student id'] },
        { key:'firstName', header:'First Name', required:true, aliases:['name','full name','student name'] },
        { key:'middleName', header:'Middle Name' },
        { key:'lastName', header:'Last Name', aliases:['surname'] },
        { key:'serialNo', header:'Roll No', aliases:['serial no','serial'] },
        { key:'email', header:'Email', aliases:['e-mail','email id'] },
        { key:'domainEmail', header:'Domain Email', aliases:['college email','institute email'] },
        { key:'phone', header:'Phone', aliases:['mobile','mobile no','phone number','contact'] },
        { key:'whatsapp', header:'WhatsApp No', aliases:['whatsapp'] },
        { key:'course', header:'Course' },
        { key:'branchName', header:'Branch', aliases:['branch name','mba branch'] },
        { key:'specialisation', header:'Specialisation I', aliases:['stream','spec','specialisation'] },
        { key:'specialisation2', header:'Specialisation II', aliases:['second specialisation','spec 2'] },
        { key:'semester', header:'Semester', number:true, def:1, aliases:['sem'] },
        { key:'section', header:'Section', def:'A', aliases:['sec'] },
        { key:'house', header:'Clubs', aliases:['house','club'] },
        { key:'batch', header:'Batch' },
        { key:'academicYear', header:'Academic Year', aliases:['session'] },
        { key:'admissionDate', header:'Admission Date', aliases:['doa','date of admission'] },
        { key:'mentor', header:'Mentor' },
        { key:'cgpa', header:'CGPA', aliases:['gpa'] },
        { key:'backlogs', header:'Backlogs', number:true, def:0, aliases:['active backlogs'] },
        { key:'status', header:'Status', def:'Active' },

        // ---- personal ----
        { key:'title', header:'Title', into:'personal', as:'title' },
        { key:'gender', header:'Gender' },
        { key:'dob', header:'Date of Birth', aliases:['dob'] },
        { key:'bloodGroup', header:'Blood Group', aliases:['blood'] },
        { key:'admissionCategory', header:'Admission Category', into:'personal', as:'admissionCategory',
          aliases:['category','quota'] },
        { key:'religion', header:'Religion', into:'personal', as:'religion' },
        { key:'nationality', header:'Nationality', into:'personal', as:'nationality' },
        { key:'birthplace', header:'Birthplace', into:'personal', as:'birthplace', aliases:['birth place'] },
        { key:'aadhaar', header:'Aadhaar No', aliases:['aadhar','aadhaar','adhaar'] },
        { key:'identificationMark', header:'Identification Mark', into:'personal', as:'identificationMark' },
        { key:'thumbId', header:'Biometric Scan', into:'personal', as:'thumbId', aliases:['thumb id'] },
        { key:'voterId', header:'Voter ID', into:'personal', as:'voterId' },
        { key:'pan', header:'PAN No', into:'personal', as:'pan' },
        { key:'drivingLicense', header:'Driving License No', into:'personal', as:'drivingLicense' },
        { key:'passport', header:'Passport No', into:'personal', as:'passport' },
        { key:'hostel', header:'Hostel', into:'personal', as:'hostel' },
        { key:'transport', header:'Transport', into:'personal', as:'transport' },
        { key:'lunch', header:'Lunch', into:'personal', as:'lunch' },
        { key:'nss', header:'NSS', into:'personal', as:'nss' },
        { key:'languages', header:'Languages Known', into:'personal', as:'languages', aliases:['languages'] },
        { key:'hobbies', header:'Hobbies', into:'personal', as:'hobbies' },

        // ---- schooling ----
        { key:'q10Institute', header:'Class 10 School', into:'qual10', as:'institute' },
        { key:'q10Year', header:'Class 10 Year', into:'qual10', as:'year' },
        { key:'q10Marks', header:'Class 10 Marks', into:'qual10', as:'marks' },
        { key:'q12Institute', header:'Class 12 School', into:'qual12', as:'institute' },
        { key:'q12Year', header:'Class 12 Year', into:'qual12', as:'year' },
        { key:'q12Marks', header:'Class 12 Marks', into:'qual12', as:'marks' },
        { key:'qDipInstitute', header:'Diploma Institute', into:'qualDip', as:'institute' },
        { key:'qDipYear', header:'Diploma Year', into:'qualDip', as:'year' },
        { key:'qDipMarks', header:'Diploma Marks', into:'qualDip', as:'marks', aliases:['diploma percentage'] },
        { key:'q3Institute', header:'+3 Institute', into:'qual3', as:'institute' },
        { key:'q3Year', header:'+3 Year', into:'qual3', as:'year' },
        { key:'q3Marks', header:'+3 Marks', into:'qual3', as:'marks', aliases:['+3 percentage'] },
        { key:'entranceExam', header:'Entrance Exam', into:'academicInfo', as:'entranceExam' },
        { key:'entranceRank', header:'Entrance Rank', into:'academicInfo', as:'entranceRank' },

        // ---- guardian ----
        { key:'fName', header:'Father Name', into:'father', as:'name', aliases:['father'] },
        { key:'fOccupation', header:'Father Occupation', into:'father', as:'occupation' },
        { key:'fMobile', header:'Father Mobile', into:'father', as:'mobile' },
        { key:'fIncome', header:'Father Income', into:'father', as:'income', aliases:['annual income','income'] },
        { key:'mName', header:'Mother Name', into:'mother', as:'name', aliases:['mother'] },
        { key:'mOccupation', header:'Mother Occupation', into:'mother', as:'occupation' },
        { key:'mMobile', header:'Mother Mobile', into:'mother', as:'mobile' },
        { key:'lgName', header:'Local Guardian Name', into:'localGuardian', as:'name' },
        { key:'lgMobile', header:'Local Guardian Mobile', into:'localGuardian', as:'mobile' },

        // ---- address ----
        { key:'address', header:'Address', into:'current', as:'address' },
        { key:'city', header:'City', into:'current', as:'city' },
        { key:'state', header:'State', into:'current', as:'state' },
        { key:'country', header:'Country', into:'current', as:'country' },
        { key:'pincode', header:'Pincode', into:'current', as:'pincode', aliases:['pin','pin code'] },
        { key:'permAddress', header:'Permanent Address', into:'permanent', as:'address' },
        { key:'permCity', header:'Permanent City', into:'permanent', as:'city' },
        { key:'permState', header:'Permanent State', into:'permanent', as:'state' },
        { key:'permPincode', header:'Permanent Pincode', into:'permanent', as:'pincode' },

        // ---- health: the two contact columns are on the Basic tab of the form ----
        { key:'emergencyName', header:'Emergency Contact Name', into:'health', as:'emergencyName',
          aliases:['emergency contact'] },
        { key:'emergencyPhone', header:'Emergency Contact No', into:'health', as:'emergencyPhone',
          aliases:['emergency phone'] },
        { key:'allergies', header:'Allergies', into:'health', as:'allergies' },
      ],
      sample: {
        roll:'2025180010', firstName:'Rahul', middleName:'Kumar', lastName:'Das', serialNo:'10',
        email:'rahul@nmiet.in', domainEmail:'rahul@nmiet.edu.in',
        phone:'9810000010', whatsapp:'9810000010',
        course:'MBA', branchName:'General Management',
        specialisation:'Marketing', specialisation2:'Finance',
        semester:2, section:'A', house:'Marketing Club', batch:'2025-2027', academicYear:'2026-27',
        admissionDate:'2025-08-17', mentor:'Dr. Rajesh Mehta', cgpa:'8.2', backlogs:0, status:'Active',
        title:'Mr.', gender:'Male', dob:'2003-05-14', bloodGroup:'B+',
        admissionCategory:'General', religion:'Hindu', nationality:'Indian', birthplace:'Cuttack',
        aadhaar:'123456789012', identificationMark:'Mole on left cheek', thumbId:'BIO-10',
        voterId:'', pan:'', drivingLicense:'', passport:'',
        hostel:'No', transport:'Yes', lunch:'Yes', nss:'No',
        languages:'Odia, Hindi, English', hobbies:'Cricket, Reading',
        q10Institute:'Saraswati Vidya Mandir', q10Year:'2019', q10Marks:'88.4',
        q12Institute:'Kendriya Vidyalaya', q12Year:'2021', q12Marks:'79.2',
        qDipInstitute:'', qDipYear:'', qDipMarks:'',
        q3Institute:'Ravenshaw University', q3Year:'2024', q3Marks:'72.5',
        entranceExam:'CAT', entranceRank:'4521',
        fName:'Bhikari Das', fOccupation:'Farmer', fMobile:'7978851886', fIncome:'240000',
        mName:'Sunita Das', mOccupation:'Homemaker', mMobile:'7978851887',
        lgName:'Ramesh Das', lgMobile:'7978851888',
        address:'AT- Harekrushnapur, PO- Chhatabar', city:'Khordha', state:'Odisha',
        country:'India', pincode:'752054',
        permAddress:'AT- Harekrushnapur, PO- Chhatabar', permCity:'Khordha',
        permState:'Odisha', permPincode:'752054',
        emergencyName:'Bhikari Das', emergencyPhone:'7978851886', allergies:'None',
      },
      // students sign in with their registration number, same as the form does
      login: (row) => ({ username: row.roll, password: DEFAULT_IMPORT_PASSWORD, role: 'student', name: row.name }),
    },
    faculty: {
      title: 'Employees',
      collection: 'faculty',
      keyField: 'empId',
      fileBase: 'NMIET-BSCHOOL-Employees-Template',
      columns: [
        { key:'empId', header:'Employee ID', required:true, aliases:['emp id','employee no','staff id'] },
        { key:'name', header:'Full Name', required:true, aliases:['name','faculty name','employee name'] },
        { key:'role', header:'Employee Role', def:'Faculty', store:false,
          aliases:['role','user role','staff role','employee type'] },
        { key:'bputRegdNo', header:'BPUT Regd No', aliases:['bput'] },
        { key:'department', header:'Department', aliases:['dept'] },
        { key:'designation', header:'Designation' },
        { key:'category', header:'Category', def:'Teaching', aliases:['staff category'] },
        { key:'email', header:'Email', aliases:['e-mail','email id'] },
        { key:'phone', header:'Phone', aliases:['mobile','mobile no','phone number','contact'] },
        { key:'joiningDate', header:'Joining Date', aliases:['doj','date of joining'] },
        { key:'status', header:'Status', def:'Active' },
        { key:'qualification', header:'Qualification' },
        { key:'expertise', header:'Specialization', aliases:['expertise','areas of expertise'] },
        { key:'publications', header:'Papers Published', aliases:['publications'] },
        { key:'reportingTo', header:'Reporting To', store:false,
          aliases:['reports to','reporting','manager','hod','supervisor'] },

        // ---- personal ----
        { key:'title', header:'Title', into:'personal', as:'title' },
        { key:'gender', header:'Gender' },
        { key:'dob', header:'Date of Birth', aliases:['dob'] },
        { key:'bloodGroup', header:'Blood Group', aliases:['blood'] },
        { key:'maritalStatus', header:'Marital Status' },
        { key:'birthplace', header:'Birth Place', into:'personal', as:'birthplace' },
        { key:'experience', header:'Total Experience', into:'personal', as:'experience' },
        { key:'caste', header:'Caste', into:'personal', as:'caste' },
        { key:'religion', header:'Religion', into:'personal', as:'religion' },
        { key:'nationality', header:'Nationality', into:'personal', as:'nationality' },

        // ---- other info ----
        { key:'attendanceCardId', header:'Attendance Card ID' },
        { key:'aadhaar', header:'Aadhaar No', aliases:['aadhar','aadhaar','adhaar'] },
        { key:'pan', header:'PAN No', into:'otherInfo', as:'pan' },
        { key:'voterId', header:'Voter ID', into:'otherInfo', as:'voterId' },
        { key:'bankAccount', header:'Bank Account No', into:'otherInfo', as:'bankAccount' },
        { key:'bankName', header:'Bank Name', into:'otherInfo', as:'bankName' },
        { key:'ifsc', header:'IFSC Code', into:'otherInfo', as:'ifsc' },
        { key:'languages', header:'Languages', into:'otherInfo', as:'languages' },
        { key:'hobbies', header:'Hobbies', into:'otherInfo', as:'hobbies' },

        // ---- guardian: the same two the form asks for ----
        { key:'fName', header:'Father Name', into:'father', as:'name', aliases:['father'] },
        { key:'fOccupation', header:'Father Occupation', into:'father', as:'occupation' },
        { key:'fMobile', header:'Father Mobile', into:'father', as:'mobile' },
        { key:'mName', header:'Mother Name', into:'mother', as:'name', aliases:['mother'] },
        { key:'mOccupation', header:'Mother Occupation', into:'mother', as:'occupation' },
        { key:'mMobile', header:'Mother Mobile', into:'mother', as:'mobile' },

        // ---- address ----
        { key:'address', header:'Address', into:'current', as:'address' },
        { key:'city', header:'City', into:'current', as:'city' },
        { key:'state', header:'State', into:'current', as:'state' },
        { key:'country', header:'Country', into:'current', as:'country' },
        { key:'pincode', header:'Pincode', into:'current', as:'pincode', aliases:['pin','pin code'] },
        { key:'permAddress', header:'Permanent Address', into:'permanent', as:'address' },
        { key:'permCity', header:'Permanent City', into:'permanent', as:'city' },
        { key:'permState', header:'Permanent State', into:'permanent', as:'state' },
        { key:'permPincode', header:'Permanent Pincode', into:'permanent', as:'pincode' },

        // ---- health ----
        { key:'emergencyName', header:'Emergency Contact', into:'health', as:'emergencyName' },
        { key:'emergencyPhone', header:'Emergency Phone', into:'health', as:'emergencyPhone' },

        // ---- login ----
        { key:'username', header:'Username', store:false },
        { key:'password', header:'Password', store:false },
      ],
      sample: {
        empId:'NM-F-1010', name:'Dr. Meena Sahu', role:'Faculty', bputRegdNo:'BPUT-2015-1010',
        department:'MBA', designation:'Assistant Professor', category:'Teaching',
        email:'meena@nmiet.edu', phone:'9876500010', joiningDate:'2019-07-01', status:'Active',
        qualification:'Ph.D. (Management)', expertise:'Marketing Analytics',
        publications:'4 journal papers', reportingTo:'NM-F-1001',
        title:'Dr.', gender:'Female', dob:'1985-02-11', bloodGroup:'O+', maritalStatus:'Married',
        birthplace:'Cuttack', experience:'9 years', caste:'General', religion:'Hindu',
        nationality:'Indian',
        attendanceCardId:'1010', aadhaar:'559343140635', pan:'PSUPS3169H', voterId:'',
        bankAccount:'34986453071', bankName:'SBI', ifsc:'SBIN0008214',
        languages:'Odia, English', hobbies:'Gardening',
        fName:'Gopal Sahu', fOccupation:'Teacher', fMobile:'7978851885',
        mName:'Prativa Sahu', mOccupation:'Homemaker', mMobile:'7978851886',
        address:'Plot 45, Patia', city:'Bhubaneswar', state:'Odisha',
        country:'India', pincode:'751024',
        permAddress:'Plot 45, Patia', permCity:'Bhubaneswar',
        permState:'Odisha', permPincode:'751024',
        emergencyName:'Prativa Sahu', emergencyPhone:'7978851886',
        username:'meena', password:'pass123',
      },
      login: (row) => ({ username: row.username || row.empId, password: row.password || DEFAULT_IMPORT_PASSWORD,
                         role: roleKeyFromLabel(row.role) || 'faculty', name: row.name }),
    },
  };

  const normHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /** Find a faculty member by employee id or by name, for "Reporting To". */
  function facultyIdByRef(ref) {
    const r = String(ref || '').trim().toLowerCase();
    if (!r) return '';
    const match = Store.all('faculty').find(f =>
      String(f.empId || '').toLowerCase() === r || String(f.name || '').toLowerCase() === r);
    return match ? match.id : '';
  }

  /** Match the sheet's header row to our columns, by header text or alias. */
  function mapColumns(spec, headerRow) {
    const map = {};
    headerRow.forEach((cell, i) => {
      const h = normHeader(cell);
      if (!h) return;
      const col = spec.columns.find((c) =>
        normHeader(c.header) === h || (c.aliases || []).some((a) => normHeader(a) === h));
      if (col && map[col.key] === undefined) map[col.key] = i;
    });
    return map;
  }

  /** Turn sheet rows into { data, login, error } — one entry per input row. */
  function validateRows(spec, rows, map) {
    const seen = new Set();
    // a second identifier the sheet must not repeat: staff carry one each
    const seenIds = new Set();
    const existingKeys = new Set(Store.all(spec.collection)
      .map((x) => String(x[spec.keyField] || '').toLowerCase()));
    const existingUsers = new Set(Store.all('users').map((u) => String(u.username || '').toLowerCase()));
    const usedUsers = new Set();

    return rows.map((cells) => {
      const raw = {};
      spec.columns.forEach((c) => {
        const i = map[c.key];
        raw[c.key] = i === undefined ? '' : String(cells[i] ?? '').trim();
      });

      const missing = spec.columns.filter((c) => c.required && !raw[c.key]).map((c) => c.header);
      if (missing.length) return { raw, error: 'Missing ' + missing.join(', ') };

      /* A sheet carries the three name parts, but the ID card, the marksheet,
         the fee receipt and the placement list all print `name` — and so does
         the login this row creates, which is why it is composed before it. */
      if (spec.collection === 'students') {
        raw.name = [raw.firstName, raw.middleName, raw.lastName]
          .map((x) => (x || '').trim()).filter(Boolean).join(' ');
      }

      const key = raw[spec.keyField].toLowerCase();
      if (existingKeys.has(key)) return { raw, error: 'Already exists' };
      if (seen.has(key)) return { raw, error: 'Duplicate in this file' };
      if (spec.collection === 'students') {
        const regBad = regNoProblem(raw.roll, null);
        // "already belongs to" is covered by the two checks above
        if (regBad && !/already belongs/.test(regBad)) return { raw, error: regBad };
      }

      if (raw.phone && !phoneValid(raw.phone)) return { raw, error: 'Phone must be 10 digits' };
      if (raw.whatsapp && !phoneValid(raw.whatsapp)) return { raw, error: 'WhatsApp must be 10 digits' };
      for (const [field, who] of [['fMobile', "Father's"], ['mMobile', "Mother's"],
                                  ['lgMobile', "Local guardian's"]]) {
        if (raw[field] && !phoneValid(raw[field])) return { raw, error: `${who} mobile must be 10 digits` };
      }
      if (raw.aadhaar && !/^\d{12}$/.test(raw.aadhaar)) return { raw, error: 'Aadhaar must be 12 digits' };
      /* An id unique within this sheet can still belong to somebody already on
         another staff table, so the check spans all of them — and the sheet
         itself must not repeat a registration or Aadhaar number either. */
      if (spec.collection === 'faculty') {
        const idBad = staffClash(raw, null);
        if (idBad) return { raw, error: idBad };
        for (const f of ['bputRegdNo', 'aadhaar']) {
          const v = (raw[f] || '').trim().toLowerCase();
          if (!v) continue;
          if (seenIds.has(f + ':' + v)) {
            return { raw, error: `Duplicate ${STAFF_FIELD_LABEL[f]} in this file` };
          }
          seenIds.add(f + ':' + v);
        }
      }
      if (raw.cgpa && (isNaN(+raw.cgpa) || +raw.cgpa < 0 || +raw.cgpa > 10)) {
        return { raw, error: 'CGPA must be 0-10' };
      }

      const login = spec.login(raw);
      const uname = String(login.username || '').toLowerCase();
      if (existingUsers.has(uname) || usedUsers.has(uname)) {
        return { raw, error: `Username "${login.username}" already taken` };
      }

      const data = {};
      if (spec.collection === 'faculty') {
        const role = roleKeyFromLabel(raw.role || 'Faculty');
        if (!role) {
          return { raw, error: `"${raw.role}" is not one of: `
            + employeeRoles().map(roleLabel).join(', ') };
        }
        data.role = role;
      }
      // "Reporting To" names a person, not an id — accept either their
      // employee id or their name. A manager listed further down the same
      // sheet does not exist yet, so those are linked after the import.
      if (spec.collection === 'faculty' && raw.reportingTo) {
        // a name that is nobody in the faculty table is kept as text — plenty
        // of people report to a director or a registrar who is not on it
        data.reportingTo = facultyIdByRef(raw.reportingTo) || raw.reportingTo;
      }
      /* Flat columns on one side, the record's shape on the other: anything
         carrying `into` is collected here rather than written as a column. */
      const parts = {};
      spec.columns.forEach((c) => {
        if (c.store === false || data[c.key] !== undefined) return;
        let v = raw[c.key];
        if (c.number) v = v === '' ? (c.def ?? 0) : +v;
        else if (v === '' && c.def !== undefined) v = c.def;
        if (c.into) {
          if (v === '' || v == null) return;
          (parts[c.into] = parts[c.into] || {})[c.as || c.key] = v;
          return;
        }
        data[c.key] = v;
      });

      // the sheet does not ask for the year; it is the semester, halved and
      // rounded up, exactly as the admission form works it out
      /* Neither is asked for on the sheet: the year is the semester halved and
         the department is the course, exactly as the admission form works them
         out when somebody is enrolled one at a time. */
      if (spec.collection === 'students') {
        data.year = yearForSemester(data.semester);
        data.branch = data.course;
        // the form fills this in and no longer asks; a sheet that leaves the
        // column blank gets the same answer rather than a student with no session
        if (!String(data.academicYear || '').trim()) data.academicYear = currentAcademicYear();
      }
      if (parts.personal) data.personal = parts.personal;
      if (parts.otherInfo) data.otherInfo = parts.otherInfo;
      if (parts.health) data.health = parts.health;
      if (parts.academicInfo) data.academicInfo = parts.academicInfo;
      if (parts.current || parts.permanent) {
        data.addressInfo = { current: parts.current || {}, permanent: parts.permanent || {} };
      }
      // each family block is filed under the name the form gives it
      const family = [['father', 'Father'], ['mother', 'Mother'], ['localGuardian', 'Local Guardian']]
        .filter(([key]) => parts[key])
        .map(([key, relation]) => Object.assign({ relation }, parts[key]));
      if (family.length) data.guardians = family;
      if (raw.name && !data.name) data.name = raw.name;
      // schooling arrives as two sets of three columns and is filed as the
      // qualification rows the profile page prints
      const quals = [];
      [['qual10', '10th'], ['qual12', '12th'], ['qualDip', 'Diploma'], ['qual3', '+3']]
        .forEach(([key, level]) => {
          if (parts[key]) quals.push(Object.assign({ level }, parts[key]));
        });
      if (quals.length) {
        data.academicInfo = Object.assign({}, data.academicInfo, { qualifications: quals });
      }

      seen.add(key);
      usedUsers.add(uname);
      return { raw, data, login };
    });
  }

  function downloadImportTemplate(spec) {
    XLSXLite.download(spec.fileBase, [{
      name: spec.title,
      columns: spec.columns.map((c) => ({ header: c.header, key: c.key, width: 20 })),
      // by key, not by position: a column added in the middle used to shift
      // every example value after it one place down the row
      rows: [Object.fromEntries(spec.columns.map((c) => [c.key, spec.sample[c.key] ?? '']))],
    }]);
    toast('Template downloaded — fill it in and upload it back.');
  }

  function bulkImportModal(kind) {
    const spec = IMPORT_SPECS[kind];
    let checked = [];

    openModal(`Bulk Upload · ${spec.title}`, `
      <div class="imp-intro">
        <p>Upload an <b>.xlsx</b> or <b>.csv</b> file. The first row must be the column
           headings — order does not matter, and extra columns are ignored.</p>
        <p class="imp-cols"><b>Columns:</b> ${spec.columns.map((c) =>
            c.required ? `<b>${c.header} *</b>` : c.header).join(' · ')}</p>
        <p class="imp-note">Every new account gets the password
           <code>${DEFAULT_IMPORT_PASSWORD}</code>${kind === 'faculty'
             ? ' unless a Password column says otherwise' : ''}.</p>
      </div>
      <div class="imp-actions">
        <button type="button" class="btn-outline" id="impTpl">⬇ Download template</button>
        <label class="btn-primary imp-pick">📂 Choose file
          <input type="file" id="impFile" accept=".xlsx,.csv,.txt" hidden></label>
        <span id="impName" class="imp-file"></span>
      </div>
      <div id="impResult"></div>
      <div class="form-actions">
        <button type="button" class="btn-outline" id="cx">Close</button>
        <button type="button" class="btn-primary" id="impGo" disabled>Import</button>
      </div>`, true);

    $('#cx').onclick = closeModal;
    $('#impTpl').onclick = () => downloadImportTemplate(spec);

    $('#impFile').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $('#impName').textContent = file.name;
      $('#impResult').innerHTML = '<p class="imp-note">Reading…</p>';
      let rows;
      try {
        rows = await XLSXLite.read(file);
      } catch (err) {
        $('#impResult').innerHTML = `<p class="imp-bad">${esc(err.message || 'Could not read that file.')}</p>`;
        return;
      }
      if (rows.length < 2) {
        $('#impResult').innerHTML = '<p class="imp-bad">That file has no data rows under the headings.</p>';
        return;
      }

      const map = mapColumns(spec, rows[0]);
      const unmatched = spec.columns.filter((c) => c.required && map[c.key] === undefined);
      if (unmatched.length) {
        $('#impResult').innerHTML = `<p class="imp-bad">Could not find the
          ${unmatched.map((c) => `<b>${c.header}</b>`).join(' and ')} column in the heading row.
          Download the template to see the expected headings.</p>`;
        $('#impGo').disabled = true;
        return;
      }

      checked = validateRows(spec, rows.slice(1).filter((r) => r.some((c) => c)), map);
      const ok = checked.filter((r) => !r.error);
      const bad = checked.filter((r) => r.error);
      const shown = checked.slice(0, 60);

      $('#impResult').innerHTML = `
        <div class="imp-summary">
          <span class="imp-ok">${ok.length} ready</span>
          ${bad.length ? `<span class="imp-bad">${bad.length} skipped</span>` : ''}
        </div>
        <div class="tbl-wrap imp-table"><table><thead><tr>
          <th>#</th><th>${spec.columns[0].header}</th><th>${spec.columns[1].header}</th><th>Status</th>
        </tr></thead><tbody>
          ${shown.map((r, i) => `<tr>
            <td>${i + 2}</td>
            <td>${esc(r.raw[spec.columns[0].key] || '—')}</td>
            <td>${esc(r.raw[spec.columns[1].key] || '—')}</td>
            <td>${r.error ? `<span class="imp-bad">✗ ${esc(r.error)}</span>`
                           : '<span class="imp-ok">✓ Ready</span>'}</td>
          </tr>`).join('')}
        </tbody></table></div>
        ${checked.length > shown.length
          ? `<p class="imp-note">Showing first ${shown.length} of ${checked.length} rows.</p>` : ''}`;
      $('#impGo').disabled = ok.length === 0;
    };

    $('#impGo').onclick = async () => {
      const ok = checked.filter((r) => !r.error);
      if (!ok.length) return;
      const btn = $('#impGo');
      btn.disabled = true; btn.textContent = `Importing ${ok.length}…`;

      const created = await Store.addMany(spec.collection, ok.map((r) => r.data));
      if (created.error) {
        toast(created.error, 'err');
        btn.disabled = false; btn.textContent = 'Import';
        return;
      }
      // A sheet often lists a head of department and the people under them
      // together. Those managers only exist now, so link them on a second pass.
      if (spec.collection === 'faculty') {
        created.forEach((row, i) => {
          const ref = ok[i].raw.reportingTo;
          if (!ref || Store.find('faculty', row.reportingTo)) return;   // already linked
          const bossId = facultyIdByRef(ref);
          if (bossId && bossId !== row.id) {
            row.reportingTo = bossId;
            Store.update('faculty', row.id, { reportingTo: bossId });
          }
        });
      }

      // logins carry the id the rows were actually written with
      const logins = created.map((row, i) => Object.assign(ok[i].login, { refId: row.id }));
      const users = await Store.addMany('users', logins);

      closeModal();
      toast(users.error
        ? `${created.length} ${spec.title.toLowerCase()} imported, but their logins could not be created.`
        : `${created.length} ${spec.title.toLowerCase()} imported.`, users.error ? 'err' : '');
      render();
    };
  }

  /* ---------- BATCH SEMESTER UPDATE (admin) ----------
     Move a whole batch up (or back) a semester in one go, instead of opening
     every student record. Nothing is written until the admin sees exactly which
     students will change and confirms. */
  const MAX_SEMESTER = 4;
  // year follows the semester: sem 1-2 -> year 1, 3-4 -> year 2, and so on
  const yearForSemester = (sem) => Math.max(1, Math.ceil((+sem || 1) / 2));

  function newSemesterFor(student, mode, target) {
    const cur = +student.semester || 0;
    if (mode === 'promote') return cur + 1;
    if (mode === 'demote') return cur - 1;
    return +target || 0;
  }

  function viewBatchSemester() {
    const skipped = new Set();   // students the admin unticked, kept while the page is open
    const html = `<div class="panel"><div class="panel-head"><h3>1 · Choose the Batch</h3>
        <span style="font-size:12px;color:var(--muted)">Filter down to the students you want to move</span></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="bsQ" placeholder="Search name / reg no...">
        <select class="filter-sel" id="bsCourse"><option value="">All Courses</option>${listOptions('course')}</select>
        <select class="filter-sel" id="bsBranch"><option value="">All Specialisations</option>${specialisationOptions()}</select>
        <select class="filter-sel" id="bsSem"><option value="">All Semesters</option>${semesterOptions()}</select>
        <select class="filter-sel" id="bsSection"><option value="">All Sections</option></select>
        <select class="filter-sel" id="bsYear"><option value="">All Academic Years</option>${optionsFrom(academicYearList())}</select>
        <button class="btn-outline btn-sm" id="bsClear">Clear</button>
      </div></div>

      <div class="panel"><div class="panel-head"><h3>2 · Choose the Change</h3></div>
      <div class="form-grid">
        <div class="field"><label>Action</label><select id="bsMode">
          <option value="promote">Promote — next semester (+1)</option>
          <option value="demote">Demote — previous semester (−1)</option>
          <option value="set">Set to a specific semester</option>
        </select></div>
        <div class="field" id="bsTargetWrap" style="display:none"><label>New Semester</label>
          <select id="bsTarget">${semesterOptions(1)}</select></div>
        <div class="field"><label>Also set Academic Year</label>
          <select id="bsNewYear"><option value="">Leave unchanged</option>${optionsFrom(academicYearList())}</select></div>
        <div class="field full">
          <label class="switch-label"><input type="checkbox" id="bsAutoYear" checked>
            <span>Update the study Year automatically (Sem 1–2 → Year 1, 3–4 → Year 2, …)</span></label></div>
      </div></div>

      <div class="panel"><div class="panel-head"><h3>3 · Review &amp; Apply</h3>
        <div class="panel-tools">
          <button class="btn-outline btn-sm" id="bsAll">Select All</button>
          <button class="btn-outline btn-sm" id="bsNone">Clear Selection</button>
          <button class="btn-primary" id="bsApply">✔ Apply Update</button>
        </div></div>
      <div id="bsStats" class="stat-grid" style="margin-bottom:18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th style="width:34px"></th><th>Reg No</th><th>Name</th><th>Course</th><th>Specialisation</th>
        <th>Sec</th><th>Academic Year</th><th>Year</th><th>Current Sem</th><th>→</th><th>New Sem</th><th>New Year</th>
      </tr></thead><tbody id="bsBody"></tbody></table></div><div id="bsPager"></div></div>`;

    viewBatchSemester.after = () => {
      let page = 1;
      const ids = ['bsQ', 'bsCourse', 'bsBranch', 'bsSem', 'bsSection', 'bsYear'];

      // section list comes from the students on record
      const sections = [...new Set(Store.all('students').map(s => s.section).filter(Boolean))].sort();
      $('#bsSection').innerHTML = `<option value="">All Sections</option>` +
        sections.map(s => `<option>${esc(s)}</option>`).join('');

      const matched = () => {
        const q = ($('#bsQ').value || '').trim().toLowerCase();
        const course = $('#bsCourse').value, branch = $('#bsBranch').value;
        const sem = $('#bsSem').value, sec = $('#bsSection').value, yr = $('#bsYear').value;
        return Store.all('students').filter(s =>
          (!q || [s.name, s.roll].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!course || s.course === course) &&
          (!branch || specOf(s) === branch) &&
          (!sem || String(s.semester) === sem) &&
          (!sec || s.section === sec) &&
          (!yr || s.academicYear === yr))
          .sort((a, b) => String(a.roll || '').localeCompare(String(b.roll || '')));
      };

      // a student is "changeable" when the new semester is valid and actually different
      const planFor = (s) => {
        const mode = $('#bsMode').value;
        const next = newSemesterFor(s, mode, $('#bsTarget').value);
        const cur = +s.semester || 0;
        let problem = null;
        if (next > MAX_SEMESTER) problem = `Already in Sem ${cur} — final semester`;
        else if (next < 1) problem = 'Already in Semester 1';
        else if (next === cur) problem = 'No change';
        return { next, problem, ok: !problem && !skipped.has(s.id) };
      };

      const draw = () => {
        const rows = matched();
        page = Math.min(page, pageCount(rows.length));
        const plans = rows.map(s => ({ s, ...planFor(s) }));
        const willChange = plans.filter(p => p.ok);
        const blocked = plans.filter(p => p.problem);
        const newYearVal = $('#bsNewYear').value;

        $('#bsStats').innerHTML = `${statCard('🎓', rows.length, 'Students Matched')}
          ${statCard('✔', willChange.length, 'Will Be Updated', willChange.length ? 'c3' : '')}
          ${statCard('⏭', plans.length - willChange.length - blocked.length, 'Unticked', 'c2')}
          ${statCard('⚠️', blocked.length, 'Cannot Change', blocked.length ? 'c4' : 'c3')}`;

        $('#bsBody').innerHTML = rows.length ? pageSlice(plans, page).map(p => {
          const s = p.s;
          const newYr = $('#bsAutoYear').checked ? yearForSemester(p.next) : (s.year ?? '—');
          return `<tr${p.problem ? ' style="opacity:.55"' : ''}>
            <td>${p.problem ? '—' :
              `<input type="checkbox" data-pick="${s.id}" ${skipped.has(s.id) ? '' : 'checked'}>`}</td>
            <td class="mono">${esc(s.roll)}</td><td>${esc(s.name)}</td>
            <td>${esc(s.course || '—')}</td><td>${esc(s.branch || '—')}</td>
            <td>${esc(s.section || '—')}</td>
            <td>${esc(newYearVal && !p.problem
              ? `${s.academicYear || '—'} → ${newYearVal}`
              : (s.academicYear || '—'))}</td>
            <td>${s.year ?? '—'}</td><td><b>${s.semester ?? '—'}</b></td>
            <td>${p.problem ? '' : '→'}</td>
            <td>${p.problem
              ? `<span class="pill amber">${esc(p.problem)}</span>`
              : `<b style="color:var(--primary-dark)">${p.next}</b>`}</td>
            <td>${p.problem ? '—' : newYr}</td>
          </tr>`;
        }).join('') : `<tr><td colspan="12" class="empty">No students match these filters.</td></tr>`;

        $('#bsBody').querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => {
          if (cb.checked) skipped.delete(cb.dataset.pick); else skipped.add(cb.dataset.pick);
          draw();
        });
        $('#bsPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#bsPager'), rows.length, page, (p) => page = p, draw);
      };

      ids.forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#bsClear').onclick = () => { ids.forEach(id => $('#' + id).value = ''); page = 1; draw(); };
      $('#bsMode').onchange = () => {
        $('#bsTargetWrap').style.display = $('#bsMode').value === 'set' ? '' : 'none';
        draw();
      };
      ['#bsTarget', '#bsNewYear', '#bsAutoYear'].forEach(sel => $(sel).onchange = draw);
      $('#bsAll').onclick = () => { skipped.clear(); draw(); };
      $('#bsNone').onclick = () => { matched().forEach(s => skipped.add(s.id)); draw(); };

      $('#bsApply').onclick = () => {
        const plans = matched().map(s => ({ s, ...planFor(s) })).filter(p => p.ok);
        if (!plans.length) { toast('Nothing to update — no student is ticked and eligible.', 'err'); return; }
        const autoYear = $('#bsAutoYear').checked;
        const newAcademicYear = $('#bsNewYear').value;
        const modeLabel = { promote: 'promoted', demote: 'moved back', set: 'set' }[$('#bsMode').value];
        const sample = plans.slice(0, 4).map(p => `${p.s.roll} (Sem ${p.s.semester} → ${p.next})`).join('<br>');
        confirmAction('Apply Semester Update',
          `<b>${plans.length}</b> student(s) will be ${modeLabel}:<br><br>${sample}` +
          (plans.length > 4 ? `<br>…and ${plans.length - 4} more` : '') +
          (autoYear ? '<br><br>Study <b>Year</b> will be recalculated from the new semester.' : '') +
          (newAcademicYear ? `<br>Academic year will be set to <b>${esc(newAcademicYear)}</b>.` : '') +
          '<br><br>This writes to every one of those student records.',
          `Update ${plans.length} Student(s)`, () => {
            plans.forEach(p => {
              const patch = { semester: p.next };
              if (autoYear) patch.year = yearForSemester(p.next);
              if (newAcademicYear) patch.academicYear = newAcademicYear;
              Store.update('students', p.s.id, patch);
            });
            toast(`${plans.length} student(s) updated.`);
            skipped.clear();
            render();
          });
      };

      draw();
    };
    return html;
  }

  // ---- FACULTY ----
  function viewFaculty() {
    const canEdit = !readOnly();
    let html = `<div class="panel"><div class="panel-head">
      <h3>Employees</h3>
      <div class="panel-tools">
        <input class="search-box" id="facSearch" placeholder="Search name / id / role / dept...">
        <select class="filter-sel" id="facRole"><option value="">All Roles</option>
          ${employeeRoles().map(r =>
            `<option value="${r}">${esc(roleLabel(r))}</option>`).join('')}</select>
        <select class="filter-sel" id="facDept"><option value="">All Departments</option>
          ${employeeValues('department').map(d => `<option>${esc(d)}</option>`).join('')}</select>
        <select class="filter-sel" id="facDesig"><option value="">All Designations</option>
          ${employeeValues('designation').map(d => `<option>${esc(d)}</option>`).join('')}</select>
        ${canEdit ? `<button class="btn-outline" id="impFac">⬆ Bulk Upload</button>
          <button class="btn-primary" id="addFac">+ Add Employee</button>` : `
          <button class="btn-outline btn-sm" id="facPrint">🖨 Print</button>
          <button class="btn-outline btn-sm" id="facCsv">📑 CSV</button>
          <button class="btn-primary btn-sm" id="facXls">⬇ Excel</button>`}
      </div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th></th><th>Emp ID</th><th>Name</th><th>Role</th><th>Department</th><th>Designation</th><th>Reporting To</th><th>Email</th><th>Phone</th><th>Actions</th>
      </tr></thead><tbody id="facBody"></tbody></table></div><div id="facPager"></div></div>`;
    viewFaculty.after = () => {
      let page = 1;
      /* Every filter narrows, none of them hides: a role, a department or a
         designation left on "All" is not a condition. */
      const filtered = () => {
        const q = ($('#facSearch').value || '').toLowerCase();
        const role = $('#facRole').value, dept = $('#facDept').value, desig = $('#facDesig').value;
        return employeeRows().filter(f =>
          (!role || f.role === role) &&
          (!dept || String(f.department || '') === dept) &&
          (!desig || String(f.designation || '') === desig) &&
          (!q || [f.name, f.empId, f.department, f.designation, f.email, f.phone, roleLabel(f.role)]
            .some(v => String(v || '').toLowerCase().includes(q))));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const pageRows = pageSlice(rows, page);
        /* Every row opens a profile and prints an ID card, whichever table it
           came from. Classes is the one action that does not travel: a class is
           taken by a teacher. Edit and Delete route to the form that owns the
           row. */
        $('#facBody').innerHTML = pageRows.length ? pageRows.map(f => {
          const own = f.col === 'faculty';   // only a teacher takes a class
          const key = f.col + ':' + f.id;
          return `<tr>
          <td>${avatarHtml(f.photo, f.name)}</td>
          <td>${esc(f.empId || '—')}</td>
          <td><button class="linkish" data-profile="${f.id}">${esc(f.name || '—')}</button></td>
          <td><span class="pill ${ROLE_PILL[f.role] || 'blue'}">${esc(roleLabel(f.role))}</span></td>
          <td>${esc(f.department || '—')}</td>
          <td>${esc(f.designation || '—')}</td>
          <td>${esc((own && reportingToName(f)) || '—')}</td>
          <td>${esc(f.email || '—')}</td><td>${esc(f.phone || '—')}</td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-profile="${f.id}" title="Full employee profile">👁 View</button>
            ${canEdit && own && f.role === 'faculty' ? `<button class="btn-sm btn-edit" data-classes="${f.id}" title="Assign classes">📚 Classes</button>` : ''}
            <button class="btn-sm btn-outline" data-id="${f.id}" title="Print ID card">🪪 ID</button>
            ${canEdit ? `<button class="btn-sm btn-edit" data-edit="${key}">Edit</button>
            <button class="btn-sm btn-del" data-del="${key}">Delete</button>` : ''}</div></td></tr>`;
        }).join('')
          : `<tr><td colspan="10" class="empty">No employees found.</td></tr>`;
        $('#facBody').querySelectorAll('[data-id]').forEach(b => b.onclick = () => printFacultyIdCard(b.dataset.id));
        $('#facBody').querySelectorAll('[data-profile]').forEach(b => b.onclick = () => openFacultyProfile(b.dataset.profile));
        if (canEdit) {
          $('#facBody').querySelectorAll('[data-classes]').forEach(b => b.onclick = () => facultyClassesModal(b.dataset.classes, draw));
          $('#facBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEmployeeForm(b.dataset.edit, draw));
          $('#facBody').querySelectorAll('[data-del]').forEach(b => {
            const i = b.dataset.del.indexOf(':');
            b.onclick = () => delConfirm(b.dataset.del.slice(0, i), b.dataset.del.slice(i + 1), 'employee', draw);
          });
        }
        $('#facPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#facPager'), rows.length, page, (p) => page = p, draw);
      };
      $('#facSearch').oninput = () => { page = 1; draw(); };
      ['facRole', 'facDept', 'facDesig'].forEach(id => {
        $('#' + id).onchange = () => { page = 1; draw(); };
      });
      if (canEdit) {
        $('#addFac').onclick = () => facultyForm(null, draw);
        $('#impFac').onclick = () => bulkImportModal('faculty');
      }
      else {
        const report = () => facultyReport(filtered());
        $('#facPrint').onclick = () => printReport(report());
        $('#facCsv').onclick = () => downloadCsv(report());
        $('#facXls').onclick = () => downloadXlsx(report());
      }
      draw();
    };
    return html;
  }

  /* Which role a staff table implies. Only a default: the record's own `role`
     wins, because the Employees form may be told otherwise and the login has to
     agree with whatever it was told. */
  const STAFF_TABLE_ROLE = {
    faculty: 'faculty', accountants: 'accountant', centerheads: 'center_head',
    placementofficers: 'placement_officer', coordinators: 'course_coordinator',
    admissions: 'admission',
  };

  /* What role a row in this table implies. The register carries whatever it
     was given; the others carry the role their own module exists to serve. */
  function tableRole(col, rec) {
    return (rec && rec.role) || STAFF_TABLE_ROLE[col] || 'faculty';
  }
  /** the same row shape the employees list uses, from any staff table */
  function employeeRow(rec, col) {
    const role = tableRole(col, rec);
    return Object.assign({}, rec, { col, role, roleName: roleLabel(role) });
  }
  /* One row per person the college employs. The register carries whatever role
     it was given; the other tables carry the role their own module implies. Both
     are listed, so nobody is invisible on the page that claims to list everyone. */
  function employeeRows() {
    const rows = [];
    STAFF_TABLES.forEach(col => Store.all(col).forEach(x => rows.push(employeeRow(x, col))));
    return rows.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
      || String(a.name || '').localeCompare(String(b.name || '')));
  }
  /* An employee id is unique across the staff tables — each one stamps its own
     prefix — so the record can be found without being told which holds it. The
     profile, the ID card and the printed PDF all go through here, which is what
     lets them work for a center head as readily as for a professor. */
  function findEmployee(id) {
    for (const col of STAFF_TABLES) {
      const rec = Store.find(col, id);
      if (rec) return employeeRow(rec, col);
    }
    return null;
  }
  /** the distinct values one field holds across every employee, for a filter */
  function employeeValues(field) {
    return [...new Set(employeeRows().map(r => String(r[field] || '').trim()).filter(Boolean))].sort();
  }
  /** the one employee form, against whichever table holds the row — "<table>:<id>" */
  function openEmployeeForm(key, after) {
    const i = String(key).indexOf(':');
    return facultyForm(String(key).slice(i + 1), after, String(key).slice(0, i));
  }

  /* ---------- read-only faculty profile (center head) ---------- */
  /* Faculty (stored by id) plus any non-faculty names the admin has added
     (stored as the name itself). The person being edited is left out — nobody
     reports to themselves, and a chain that loops has no top. */
  function reportingToOptions(selected, excludeId) {
    const faculty = Store.all('faculty')
      .filter(f => f.id !== excludeId)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const others = listValues('reportingTo');
    return `<option value="">— None —</option>`
      + (faculty.length ? `<optgroup label="Faculty">` + faculty.map(f =>
          `<option value="${esc(f.id)}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}${
            f.designation ? ' · ' + esc(f.designation) : ''}</option>`).join('') + `</optgroup>` : '')
      + (others.length ? `<optgroup label="Other">` + others.map(n =>
          `<option value="${esc(n)}" ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('')
          + `</optgroup>` : '')
      + listExtraOpts('Add someone not in the faculty list...');
  }

  /**
   * Add and remove entries on the Reporting To dropdown. Removal only ever
   * touches the added names — a faculty member is deleted from the Faculty
   * page, never as a side effect of editing somebody else's record.
   */
  function bindReportingTo(select, excludeId) {
    if (!select) return;
    let prev = select.value;
    const rebuild = (val) => { select.innerHTML = reportingToOptions(val, excludeId); select.value = val; prev = val; };

    select.onchange = () => {
      const v = select.value;
      if (v === ADD_NEW) {
        const name = (window.prompt(LIST_DEFS.reportingTo.prompt) || '').trim();
        if (!name) { select.value = prev; return; }
        if (Store.all('faculty').some(f => (f.name || '').toLowerCase() === name.toLowerCase())) {
          toast(`"${name}" is already in the faculty list.`, 'err');
          select.value = prev; return;
        }
        const list = listValues('reportingTo');
        if (!list.includes(name)) { list.push(name); saveList('reportingTo'); }
        rebuild(name);
        return;
      }
      if (v === REMOVE_OPT) {
        const list = listValues('reportingTo');
        if (!list.length) {
          toast('Nothing to remove — employees are removed from the Employees page.', 'err');
          select.value = prev; return;
        }
        const raw = (window.prompt('Remove which name?\n(' + list.join(', ') + ')') || '').trim();
        if (!raw) { select.value = prev; return; }
        const idx = list.findIndex(n => n.toLowerCase() === raw.toLowerCase());
        if (idx === -1) { toast(`"${raw}" is not one of the added names.`, 'err'); select.value = prev; return; }
        const inUse = Store.all('faculty').filter(f => f.reportingTo === list[idx]).length;
        if (inUse) {
          toast(`"${list[idx]}" is used by ${inUse} record(s) — change those first.`, 'err');
          select.value = prev; return;
        }
        const removed = list.splice(idx, 1)[0];
        saveList('reportingTo');
        rebuild(prev === removed ? '' : prev);
        toast(`"${removed}" removed.`);
        return;
      }
      prev = v;
    };
  }

  /* Who can be put in front of a class. The register holds every kind of
     employee now, and the accountant is not one of them. */
  function teachingStaff() { return Store.all('faculty').filter(f => employeeRole(f) === 'faculty'); }

  /** Who a faculty member reports to: a linked faculty name, or a plain name. */
  function reportingToName(f) {
    if (!f || !f.reportingTo) return '';
    const boss = Store.find('faculty', f.reportingTo);
    return boss ? boss.name : f.reportingTo;
  }

  const FAC_TABS = [
    ['personal', '👤 Personal'], ['guardians', '👪 Guardians'], ['address', '🏠 Address'],
    ['other', '⚙️ Other Info'], ['documents', '📄 Documents'], ['health', '🩺 Health'],
  ];
  let profileFacultyId = null;
  let facTab = 'personal';

  function openFacultyProfile(fid) {
    profileFacultyId = fid;
    facTab = 'personal';
    navigate('facprofile');
  }

  function viewFacultyProfile() {
    const f = findEmployee(profileFacultyId);
    if (!f) return `<div class="panel"><p class="empty">That employee is no longer on the staff list.</p></div>`;
    const canEdit = !viewsMasterOnly();

    const side = `<div class="panel stu-side">
      <div class="stu-photo">${f.photo
        ? `<img src="${esc(f.photo)}" alt="${esc(f.name || '')}">`
        : `<span>${esc((f.name || '?').trim()[0] || '?')}</span>`}</div>
      <div class="tbl-wrap"><table class="info-tbl"><tbody>
        ${infoRow('Employee ID', `<span class="mono">${esc(f.empId || '—')}</span>`)}
        ${infoRow('BPUT Regd No.', esc(f.bputRegdNo || '—'))}
        ${infoRow('Name', esc(f.name || '—'))}
        ${infoRow('Employee Role', `<span class="pill ${ROLE_PILL[f.role] || 'blue'}">${
          esc(f.roleName)}</span>`)}
        ${infoRow('Department', esc(f.department || '—'))}
        ${infoRow('Designation', esc(f.designation || '—'))}
        ${infoRow('Category', esc(f.category || '—'))}
        ${infoRow('Reporting To', esc(f.reportingTo ? facultyName(f.reportingTo) : '—'))}
        ${infoRow('Mobile No', esc(f.phone || '—'))}
        ${infoRow('Email ID', esc(f.email || '—'))}
        ${infoRow('Status', `<span class="pill ${(f.status || 'Active') === 'Active' ? 'green' : 'red'}">${
          esc(f.status || 'Active')}</span>`)}
      </tbody></table></div>
    </div>`;

    const html = `<div class="panel-tools" style="margin-bottom:14px">
        <button class="btn-outline btn-sm" id="fpBack">← Employees</button>
        ${canEdit ? `<button class="btn-primary btn-sm" id="fpEdit">✎ Edit Employee</button>` : ''}
        <button class="btn-outline btn-sm" id="fpCard">🪪 ID Card</button>
        <button class="btn-outline btn-sm" id="fpPdf">📄 Generate PDF</button>
      </div>
      <div class="stu-profile">
        ${side}
        <div class="panel stu-main">
          <div class="fin-tabs" id="fpTabs">${FAC_TABS.map(([k, label]) =>
            `<button class="fin-tab ${k === facTab ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
          <div id="fpBody">${facultyTabHtml(f, facTab)}</div>
        </div>
      </div>`;

    viewFacultyProfile.after = () => {
      $('#fpBack').onclick = () => navigate('faculty');
      const edit = $('#fpEdit');
      if (edit) edit.onclick = () => openEmployeeForm(f.col + ':' + f.id);
      $('#fpCard').onclick = () => printFacultyIdCard(f.id);
      $('#fpPdf').onclick = () => printFacultyProfile(f.id);
      const tabs = $('#fpTabs');
      if (tabs) tabs.querySelectorAll('[data-tab]').forEach(b => {
        b.onclick = () => {
          facTab = b.dataset.tab;
          tabs.querySelectorAll('.fin-tab').forEach(x => x.classList.toggle('active', x === b));
          $('#fpBody').innerHTML = facultyTabHtml(f, facTab);
        };
      });
    };
    return html;
  }

  function facultyTabHtml(f, tab) {
    const per = stuPart(f, 'personal');
    const other = stuPart(f, 'otherInfo');
    const addr = stuPart(f, 'addressInfo');
    const health = stuPart(f, 'health');
    const guardians = stuPart(f, 'guardians');
    const docs = stuPart(f, 'documents');

    if (tab === 'personal') {
      return `<h4 class="ro-sub">Personal Details</h4>` + infoTable(`
        ${infoRow('Title', esc(per.title || '—'))}
        ${infoRow2('First Name', esc(per.firstName || (f.name || '').split(' ')[0] || '—'),
                   'Last Name', esc(per.lastName || '—'))}
        ${infoRow('Middle Name', esc(per.middleName || '—'))}
        ${infoRow2('Joining Date', esc(f.joiningDate || '—'), 'Date of Birth', esc(f.dob || '—'))}
        ${infoRow2('Gender', esc(f.gender || '—'), 'Birth Place', esc(per.birthplace || '—'))}
        ${infoRow2('Department', esc(f.department || '—'), 'Designation', esc(f.designation || '—'))}
        ${infoRow2('Category', esc(f.category || '—'), 'Total Experience', esc(per.experience || '—'))}
        ${infoRow2('Blood Group', esc(f.bloodGroup || '—'), 'Marital Status', esc(f.maritalStatus || '—'))}
        ${infoRow2('Caste', esc(per.caste || '—'), 'Nationality', esc(per.nationality || '—'))}
        ${infoRow2('Religion', esc(per.religion || '—'), 'Thumb', esc(per.thumb || '—'))}
        ${infoRow2('Lunch', esc(per.lunch || '—'), 'Transport', esc(per.transport || '—'))}
        ${infoRow2('Breakfast', esc(per.breakfast || '—'), 'Dinner', esc(per.dinner || '—'))}`);
    }

    if (tab === 'guardians') {
      if (!guardians.length) return `<h4 class="ro-sub">Guardian Info</h4><p class="empty">No guardian recorded.</p>`;
      return `<h4 class="ro-sub">Guardian Info</h4>` + guardians.map((g, i) => `
        <h4 class="ro-sub" style="margin-top:${i ? 22 : 10}px">${esc(g.relation || 'Guardian')}</h4>
        ${infoTable(`
          ${infoRow('Name', esc(g.name || '—'))}
          ${infoRow('Qualification', esc(g.qualification || '—'))}
          ${infoRow('Occupation', esc(g.occupation || '—'))}
          ${infoRow2('Total Income', g.income ? '₹' + esc(g.income) : '—', 'Mobile No', esc(g.mobile || '—'))}
          ${infoRow2('Phone No', esc(g.phone || '—'), 'Email ID', esc(g.email || '—'))}
          ${infoRow('Home Address', esc(g.homeAddress || '—'))}`)}`).join('');
    }

    if (tab === 'address') {
      const block = (title, a) => `<h4 class="ro-sub">${title}</h4>` + infoTable(`
        ${infoRow('Address', esc(a.address || '—'))}
        ${infoRow2('City/Town', esc(a.city || '—'), 'State/Province', esc(a.state || '—'))}
        ${infoRow2('Country', esc(a.country || '—'), 'House No', esc(a.houseNo || '—'))}
        ${infoRow2('Pincode', esc(a.pincode || '—'), 'Phone No', esc(a.phone || '—'))}`);
      return `<h4 class="ro-sub">Address Info</h4>`
        + block('Current Address', addr.current || {})
        + block('Permanent Address', addr.permanent || {});
    }

    if (tab === 'other') {
      return `<h4 class="ro-sub">Other Info</h4>` + infoTable(`
        ${infoRow('Attendance Card ID', esc(f.attendanceCardId || '—'))}
        ${infoRow('BPUT Regd No.', esc(f.bputRegdNo || '—'))}
        ${infoRow('AADHAAR No.', esc(f.aadhaar || '—'))}
        ${infoRow('PAN No.', esc(other.pan || '—'))}
        ${infoRow('Voter ID', esc(other.voterId || '—'))}
        ${infoRow('Driving License No.', esc(other.drivingLicense || '—'))}
        ${infoRow('Bank Account No', esc(other.bankAccount || '—'))}
        ${infoRow2('Bank Name', esc(other.bankName || '—'), 'IFSC Code', esc(other.ifsc || '—'))}
        ${infoRow('Reference', esc(other.reference || '—'))}
        ${infoRow2('Qualification', esc(f.qualification || '—'), 'Specialization', esc(f.expertise || '—'))}
        ${infoRow('Papers Published', esc(f.publications || '—'))}
        ${infoRow('Books Written', esc(other.books || '—'))}
        ${infoRow('R & D Project Undertaken', esc(other.rndProjects || '—'))}
        ${infoRow('Membership of any Professional Society', esc(other.memberships || '—'))}
        ${infoRow('Workshops Attended', esc(other.workshops || '—'))}
        ${infoRow2('National Conferences Attended', esc(other.nationalConferences || '—'),
                   'International Conferences Attended', esc(other.internationalConferences || '—'))}
        ${infoRow2('Languages', esc(other.languages || '—'), 'Hobbies', esc(other.hobbies || '—'))}`);
    }

    if (tab === 'documents') {
      const rows = docs.length ? docs.map(d => `<tr>
          <td>${esc(d.name || '—')}</td><td>${esc(d.type || '—')}</td>
          <td class="mono">${esc(d.number || '—')}</td><td>${esc(d.issued || '—')}</td>
          <td>${d.file ? `<a href="${esc(d.file)}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
        </tr>`).join('')
        : `<tr><td colspan="5" class="empty">No documents on record.</td></tr>`;
      return `<h4 class="ro-sub">Documents</h4>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Document</th><th>Type</th><th>Number</th><th>Issued On</th><th>File</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    return `<h4 class="ro-sub">Health Record</h4>` + infoTable(`
      ${infoRow2('Blood Group', esc(f.bloodGroup || '—'), 'Height', health.height ? esc(health.height) + ' cm' : '—')}
      ${infoRow2('Weight', health.weight ? esc(health.weight) + ' kg' : '—', 'Last Check-up', esc(health.lastCheckup || '—'))}
      ${infoRow('Allergies', esc(health.allergies || '—'))}
      ${infoRow('Medical Conditions', esc(health.conditions || '—'))}
      ${infoRow('Regular Medication', esc(health.medication || '—'))}
      ${infoRow2('Emergency Contact', esc(health.emergencyName || '—'), 'Emergency Phone', esc(health.emergencyPhone || '—'))}
      ${infoRow('Notes', esc(health.notes || '—'))}`);
  }

  /* "Generate PDF" is the browser's own print dialog — every tab on one sheet,
     which is what an office actually files. */
  function printFacultyProfile(fid) {
    const f = findEmployee(fid);
    if (!f) return;
    const section = (title, body) => `<h3 style="margin:18px 0 6px;color:#123f8c">${title}</h3>${body}`;
    const inner = `<h2 style="margin:0 0 4px">${esc(f.name || '')}</h2>
      <p style="margin:0 0 14px;color:#555">${esc(f.roleName)} · ${esc(f.designation || '')}
        · ${esc(f.department || '')} · ${esc(f.empId || '')}</p>
      ${FAC_TABS.map(([key, label]) =>
        section(label.replace(/^[^ ]+ /, ''), facultyTabHtml(f, key))).join('')}`;
    printDoc('Employee Profile - ' + (f.empId || f.name), inner);
  }

  function facultyProfileModal(fid) {
    const f = Store.find('faculty', fid);
    if (!f) return;
    const mine = Store.all('courses').filter(c => c.facultyId === fid);
    const load = facultyTeachingLoad(fid);
    const slots = Store.all('timetable')
      .filter(t => mine.some(c => c.id === t.courseId))
      .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) ||
        String(a.startTime || '').localeCompare(String(b.startTime || '')));

    const row = (k, v) => `<tr><td style="font-weight:600;width:180px">${esc(k)}</td><td>${esc(v ?? '—')}</td></tr>`;
    const courseRows = mine.length ? mine.map(c => {
      const studs = studentsOfCourse(c);
      const sessions = Store.all('attendance').filter(a => a.courseId === c.id);
      return `<tr><td>${esc(c.code)}</td><td>${esc(c.name)}</td>
        <td>${esc(c.branch)} · Sem ${esc(c.semester)} · Sec ${esc(c.section || 'A')}</td>
        <td style="text-align:right">${studs.length}</td>
        <td style="text-align:right">${sessions.length}</td></tr>`;
    }).join('') : `<tr><td colspan="5" class="empty">No classes assigned.</td></tr>`;

    const ttRows = slots.length ? slots.map(t => {
      const c = Store.find('courses', t.courseId) || {};
      return `<tr><td>${esc(DAY_FULL[t.day] || t.day)}</td><td>${esc(slotTimeLabel(t))}</td>
        <td>${esc(c.code || '—')} — ${esc(c.name || '—')}</td><td>${esc(t.room || '—')}</td></tr>`;
    }).join('') : `<tr><td colspan="4" class="empty">No periods scheduled.</td></tr>`;

    openModal('Employee Profile — ' + f.name, `
      <div style="display:flex;gap:18px;align-items:center;margin-bottom:18px">
        <div class="logo-circle">${f.photo ? `<img src="${esc(f.photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((f.name || '?')[0])}</div>
        <div><h3 style="color:var(--primary-dark)">${esc(f.name)}</h3>
        <p style="color:var(--muted);font-size:13px">${esc(f.empId || '—')} · ${esc(f.department || '—')} · ${esc(f.designation || '—')}</p></div>
      </div>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('📚', mine.length, 'Classes Assigned')}
        ${statCard('🎓', load.students, 'Students Taught', 'c2')}
        ${statCard('🗓️', slots.length, 'Weekly Periods', 'c2')}
        ${statCard('✅', load.sessions, 'Sessions Recorded', 'c3')}
      </div>
      <h4 class="ro-sub">Profile</h4>
      <div class="tbl-wrap"><table><tbody>
        ${row('Employee ID', f.empId)}
        ${row('Department', f.department)}
        ${row('Designation', f.designation)}
        ${row('Reporting To', reportingToName(f))}
        ${row('Qualification', f.qualification)}
        ${row('Areas of Expertise', f.expertise)}
        ${row('Publications', f.publications)}
        ${row('Email', f.email)}
        ${row('Phone', f.phone)}
      </tbody></table></div>
      <h4 class="ro-sub">Subjects &amp; Classes</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Subject</th><th>Class</th>
        <th style="text-align:right">Students</th><th style="text-align:right">Sessions</th>
      </tr></thead><tbody>${courseRows}</tbody></table></div>
      <h4 class="ro-sub">Timetable</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Day</th><th>Time</th><th>Subject</th><th>Room</th>
      </tr></thead><tbody>${ttRows}</tbody></table></div>
      <h4 class="ro-sub">Class Attendance Record</h4>
      <p style="font-size:12.5px;color:var(--muted);line-height:1.7">
        ${load.sessions} session(s) recorded across ${mine.length} class(es);
        average student attendance in those sessions is
        <b>${load.avgAttendance === null ? '—' : load.avgAttendance + '%'}</b>.
        Last session: <b>${esc(load.lastSession || '—')}</b>.</p>
      <div class="form-actions"><button class="btn-outline" id="cx">Close</button>
        <button class="btn-primary" id="pid">🪪 Print ID Card</button></div>`, true);
    $('#cx').onclick = closeModal;
    $('#pid').onclick = () => printFacultyIdCard(fid);
  }

  /* the Employees page as an exportable report */
  function facultyReport(rows) {
    return {
      title: 'Employee Report', sheetName: 'Employees', subtitle: reportStamp(),
      columns: [
        { header: 'Emp ID', key: 'empId', width: 14 },
        { header: 'Name', key: 'name', width: 26 },
        { header: 'Role', key: 'roleName', width: 18 },
        { header: 'Department', key: 'department', width: 20 },
        { header: 'Designation', key: 'designation', width: 20 },
        { header: 'Reporting To', key: 'reportingToName', width: 22 },
        { header: 'Qualification', key: 'qualification', width: 24 },
        { header: 'Expertise', key: 'expertise', width: 28 },
        { header: 'Email', key: 'email', width: 26 },
        { header: 'Phone', key: 'phone', width: 14 },
        { header: 'Classes', key: 'classes', width: 10, type: 'number' },
        { header: 'Students', key: 'students', width: 10, type: 'number' },
        { header: 'Sessions Held', key: 'sessions', width: 14, type: 'number' },
      ],
      rows: rows.map(f => {
        const load = facultyTeachingLoad(f.id);
        return Object.assign({}, f, {
          reportingToName: reportingToName(f) || '—',
          classes: load.classes, students: load.students, sessions: load.sessions,
        });
      }),
      totals: { empId: 'TOTAL', name: rows.length + ' faculty' },
    };
  }

  /* how much teaching a faculty member actually carries, derived from the
     courses assigned to them and the attendance sessions they have recorded */
  function facultyTeachingLoad(fid) {
    const mine = Store.all('courses').filter(c => c.facultyId === fid);
    const ids = mine.map(c => c.id);
    const sessions = Store.all('attendance').filter(a => ids.includes(a.courseId));
    const students = new Set();
    mine.forEach(c => studentsOfCourse(c).forEach(s => students.add(s.id)));
    let present = 0, marks = 0;
    sessions.forEach(a => {
      const vals = Object.values(a.records || {});
      marks += vals.length;
      present += vals.filter(v => v === 'P').length;
    });
    const dates = sessions.map(a => a.date).filter(Boolean).sort();
    return {
      classes: mine.length, students: students.size, sessions: sessions.length,
      avgAttendance: marks ? Math.round(present / marks * 100) : null,
      lastSession: dates[dates.length - 1] || '',
    };
  }
  const STAFF_CATEGORIES = ['Teaching', 'Non-Teaching', 'Administrative', 'Support'];
  /* Starting points for the two master lists every staff form reads. Neither is
     the whole truth and neither has to be: listValues() folds in every value
     already sitting on a record, so a designation typed years before this list
     existed stays selectable and nobody's record is quietly orphaned. */
  const DESIGNATIONS = ['Professor', 'Associate Professor', 'Assistant Professor',
    'Lecturer', 'Visiting Faculty', 'Head of Department', 'Dean', 'Principal',
    'Director', 'Registrar', 'Librarian', 'Lab Assistant', 'Accountant',
    'Senior Accountant', 'Center Head', 'Placement Officer',
    'Training & Placement Head', 'Course Coordinator', 'Admission Officer',
    'Office Assistant', 'System Administrator', 'Support Staff'];
  const DEPARTMENTS = ['MBA', 'Management', 'Computer Applications', 'Finance',
    'Marketing', 'Human Resources', 'Administration', 'Accounts', 'Library',
    'Training & Placement', 'Examination Cell', 'IT & Systems', 'Maintenance'];
  const MARITAL_STATUS = ['Unmarried', 'Married', 'Widowed', 'Divorced'];

  /* One form for every employee. `col` is the table the record is filed in —
     the register by default, or the table whose own page opened it. All six
     hold the same columns, so the only thing that changes is where it is
     written. */
  function facultyForm(id, after, col) {
    col = col || 'faculty';
    const f = id ? (Store.find(col, id) || {}) : {};
    // existing login account linked to this employee (for edit)
    const acct = id ? Store.all('users').find(u => u.refId === id) : null;
    /* Logins are the admin's to set. An accountant opening their own record
       from the accounts page sees the same fields they always saw — everything
       except the block that would let them change their own password. */
    const withLogin = user.role === 'admin';
    const per = stuPart(f, 'personal');
    const other = stuPart(f, 'otherInfo');
    const addr = stuPart(f, 'addressInfo');
    const health = stuPart(f, 'health');
    const guardians = stuPart(f, 'guardians');
    const docs = stuPart(f, 'documents');
    const cur = addr.current || {};
    const perm = addr.permanent || {};

    const TABS = [['basic', 'Basic'], ['personal', 'Personal'], ['guardians', 'Guardians'],
                  ['address', 'Address'], ['other', 'Other Info'],
                  ['health', 'Health'], ['docs', 'Documents']];

    const addressBlock = (prefix, a) => `<div class="form-grid">
      ${fArea(prefix + '_address', 'Address', a.address)}
      ${fText(prefix + '_houseNo', 'House No', a.houseNo)}
      ${fText(prefix + '_city', 'City/Town', a.city)}
      ${fText(prefix + '_state', 'State/Province', a.state)}
      ${fText(prefix + '_country', 'Country', a.country || 'India')}
      ${fText(prefix + '_pincode', 'Pincode', a.pincode, 'inputmode="numeric" maxlength="6"')}
      ${fText(prefix + '_phone', 'Phone No', a.phone, 'inputmode="numeric"')}
    </div>`;

    openModal((id ? 'Edit' : 'Add') + ' Employee', `<form id="f">
      <div class="fin-tabs" id="ffTabs">${TABS.map(([k, label], i) =>
        `<button type="button" class="fin-tab ${i ? '' : 'active'}" data-pane="${k}">${label}</button>`).join('')}</div>

      <div class="sf-pane" data-pane="basic">
        <div class="form-grid">
          <div class="field"><label>Employee ID</label>
            <input name="empId" value="${esc(f.empId || '')}" required></div>
          ${fText('bputRegdNo', 'BPUT Regd No.', f.bputRegdNo)}
          <div class="field"><label>Full Name</label>
            <input name="name" value="${esc(f.name || '')}" required></div>
          <div class="field"><label>Employee Role</label>
            <select name="role">${employeeRoles().map(r =>
              `<option value="${r}" ${r === tableRole(col, f) ? 'selected' : ''}>${esc(roleLabel(r))}</option>`
            ).join('')}</select></div>
          <div class="field"><label>Department</label>
            <select name="department"><option value=""></option>${
              listOptions('department', f.department || '', true)}</select></div>
          <div class="field"><label>Designation</label>
            <select name="designation"><option value=""></option>${
              listOptions('designation', f.designation || '', true)}</select></div>
          ${fSel('category', 'Category', f.category || 'Teaching', STAFF_CATEGORIES, false)}
          <div class="field"><label>Reporting To</label>
            <select name="reportingTo">${reportingToOptions(f.reportingTo, id)}</select></div>
          ${fText('email', 'Email ID', f.email, 'type="email" placeholder="name@example.com"')}
          <div class="field"><label>Mobile No</label>
            <input name="phone" id="facPhoneInput" inputmode="numeric" placeholder="10-digit number"
                   value="${esc(f.phone || '')}"></div>
          ${fDate('joiningDate', 'Joining Date', f.joiningDate)}
          ${fSel('status', 'Status', f.status || 'Active', ['Active', 'Inactive'], false)}
          ${photoField(f.photo)}
        </div>
        ${withLogin ? `<h4 class="ro-sub">Login Account</h4>
        <div class="form-grid">
          <div class="field"><label>Username</label>
            <input name="username" value="${esc(acct ? acct.username : '')}"
                   placeholder="auto from employee id"></div>
          <div class="field"><label>Password</label>
            <input name="password" type="text" value=""
                   placeholder="${id ? 'leave blank to keep current' : DEFAULT_PASSWORD}"></div>
        </div>` : ''}
      </div>

      <div class="sf-pane hidden" data-pane="personal">
        <div class="form-grid">
          ${fSel('per_title', 'Title', per.title, TITLES_LIST)}
          ${fText('per_firstName', 'First Name', per.firstName)}
          ${fText('per_middleName', 'Middle Name', per.middleName)}
          ${fText('per_lastName', 'Last Name', per.lastName)}
          ${fDate('dob', 'Date of Birth', f.dob)}
          ${fSel('gender', 'Gender', f.gender, GENDERS)}
          ${fText('per_birthplace', 'Birth Place', per.birthplace)}
          ${fText('per_experience', 'Total Experience', per.experience, 'placeholder="e.g. 6 years"')}
          ${fSel('bloodGroup', 'Blood Group', f.bloodGroup, BLOOD_GROUPS)}
          ${fSel('maritalStatus', 'Marital Status', f.maritalStatus, MARITAL_STATUS)}
          ${fText('per_caste', 'Caste', per.caste)}
          ${fText('per_nationality', 'Nationality', per.nationality || 'Indian')}
          ${fText('per_religion', 'Religion', per.religion)}
          ${fText('per_thumb', 'Thumb', per.thumb)}
          ${fSel('per_lunch', 'Lunch', per.lunch || 'No', YES_NO, false)}
          ${fSel('per_transport', 'Transport', per.transport || 'No', YES_NO, false)}
          ${fSel('per_breakfast', 'Breakfast', per.breakfast || 'No', YES_NO, false)}
          ${fSel('per_dinner', 'Dinner', per.dinner || 'No', YES_NO, false)}
        </div>
      </div>

      <div class="sf-pane hidden" data-pane="guardians">
        <div id="ffGuardians">${EMP_GUARDIAN_ROLES.map(role =>
          fixedGuardianCard(guardians.find(g => g.relation === role), role)).join('')}</div>
      </div>

      <div class="sf-pane hidden" data-pane="address">
        <h4 class="ro-sub">Current Address</h4>
        ${addressBlock('cur', cur)}
        <h4 class="ro-sub">Permanent Address
          <button type="button" class="btn-outline btn-sm" id="ffSameAddr" style="float:right">
            Copy from current</button></h4>
        ${addressBlock('perm', perm)}
      </div>

      <div class="sf-pane hidden" data-pane="other">
        <div class="form-grid">
          ${fText('attendanceCardId', 'Attendance Card ID', f.attendanceCardId)}
          ${fText('aadhaar', 'AADHAAR No.', f.aadhaar, 'inputmode="numeric" maxlength="12"')}
          ${fText('oth_pan', 'PAN No.', other.pan)}
          ${fText('oth_voterId', 'Voter ID', other.voterId)}
          ${fText('oth_drivingLicense', 'Driving License No.', other.drivingLicense)}
          ${fText('oth_bankAccount', 'Bank Account No', other.bankAccount)}
          ${fText('oth_bankName', 'Bank Name', other.bankName)}
          ${fText('oth_ifsc', 'IFSC Code', other.ifsc)}
          ${fText('oth_reference', 'Reference', other.reference)}
          ${fText('qualification', 'Qualification', f.qualification, 'placeholder="e.g. Ph.D. (Management)"')}
          ${fText('expertise', 'Specialization', f.expertise, 'placeholder="e.g. Marketing, Consumer Research"')}
          ${fText('oth_languages', 'Languages', other.languages)}
          ${fText('oth_hobbies', 'Hobbies', other.hobbies)}
          ${fArea('publications', 'Papers Published', f.publications, 3)}
          ${fArea('oth_books', 'Books Written', other.books)}
          ${fArea('oth_rndProjects', 'R & D Project Undertaken', other.rndProjects)}
          ${fArea('oth_memberships', 'Membership of any Professional Society', other.memberships)}
          ${fArea('oth_workshops', 'Workshops Attended', other.workshops)}
          ${fArea('oth_nationalConferences', 'National Conferences Attended', other.nationalConferences)}
          ${fArea('oth_internationalConferences', 'International Conferences Attended', other.internationalConferences)}
        </div>
      </div>

      <div class="sf-pane hidden" data-pane="health">
        <div class="form-grid">
          ${fText('h_height', 'Height (cm)', health.height, 'inputmode="numeric"')}
          ${fText('h_weight', 'Weight (kg)', health.weight, 'inputmode="numeric"')}
          ${fDate('h_lastCheckup', 'Last Check-up', health.lastCheckup)}
          ${fText('h_emergencyName', 'Emergency Contact Name', health.emergencyName)}
          ${fText('h_emergencyPhone', 'Emergency Contact Phone', health.emergencyPhone, 'inputmode="numeric" maxlength="10"')}
          ${fArea('h_allergies', 'Allergies', health.allergies)}
          ${fArea('h_conditions', 'Medical Conditions', health.conditions)}
          ${fArea('h_medication', 'Regular Medication', health.medication)}
          ${fArea('h_notes', 'Notes', health.notes)}
        </div>
      </div>

      <div class="sf-pane hidden" data-pane="docs">
        <div id="ffDocs">${docs.map(documentRow).join('')}</div>
        <button type="button" class="btn-outline btn-sm" id="ffAddDoc">+ Add Document</button>
      </div>

      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);

    /* ---- wiring ---- */
    $('#cx').onclick = closeModal;
    bindPhoneInput($('#facPhoneInput'));
    bindReportingTo($('select[name="reportingTo"]'), id);
    bindCustomList($('select[name="department"]'), 'department');
    bindCustomList($('select[name="designation"]'), 'designation');
    bindPhotoField();

    $('#ffTabs').querySelectorAll('[data-pane]').forEach(btn => {
      btn.onclick = () => {
        $('#ffTabs').querySelectorAll('.fin-tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.sf-pane').forEach(pane =>
          pane.classList.toggle('hidden', pane.dataset.pane !== btn.dataset.pane));
      };
    });

    const renumber = (sel, word) => {
      document.querySelectorAll(sel).forEach((card, i) => {
        const h = card.querySelector('.sub-card-head strong');
        if (h) h.textContent = `${word} ${i + 1}`;
      });
    };
    const bindDocRemovals = () => {
      document.querySelectorAll('[data-remove-document]').forEach(b => {
        b.onclick = () => { b.closest('[data-document]').remove(); renumber('[data-document]', 'Document'); };
      });
    };
    const bindDocFiles = () => {
      document.querySelectorAll('[data-doc-file]').forEach(input => {
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return;
          if (file.size > 1024 * 1024) {
            toast('That file is over 1 MB — attach a smaller scan.', 'err');
            input.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const card = input.closest('[data-document]');
            card.querySelector('[data-doc-value]').value = reader.result;
            card.querySelector('[data-doc-note]').textContent = 'Attached: ' + file.name;
          };
          reader.readAsDataURL(file);
        };
      });
    };
    bindDocRemovals(); bindDocFiles();

    $('#ffAddDoc').onclick = () => {
      const wrap = $('#ffDocs');
      wrap.insertAdjacentHTML('beforeend', documentRow({}, wrap.children.length));
      bindDocRemovals(); bindDocFiles();
    };
    $('#ffSameAddr').onclick = () => {
      ['address', 'houseNo', 'city', 'state', 'country', 'pincode', 'phone'].forEach(k => {
        const from = document.querySelector(`[name="cur_${k}"]`);
        const to = document.querySelector(`[name="perm_${k}"]`);
        if (from && to) to.value = from.value;
      });
      toast('Copied from the current address.');
    };

    /* ---- save ---- */
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const form = e.target;
      const d = formData(form);
      if (!phoneValid(d.phone)) { toast('Mobile number must be exactly 10 digits.', 'err'); return; }
      if (d.aadhaar && !/^\d{12}$/.test(d.aadhaar)) {
        toast('AADHAAR number must be exactly 12 digits.', 'err'); return;
      }
      const idClash = staffClash(d, id);
      if (idClash) { toast(idClash, 'err'); return; }
      const username = (d.username || '').trim();
      const password = (d.password || '').trim();
      delete d.username; delete d.password;

      // username must be unique across all login accounts
      if (username) {
        const clash = Store.all('users').find(u =>
          (u.username || '').toLowerCase() === username.toLowerCase() && !(acct && u.id === acct.id));
        if (clash) { toast('Username "' + username + '" already taken.', 'err'); return; }
      }

      const take = (prefix) => {
        const out = {};
        Object.keys(d).forEach(k => {
          if (k.startsWith(prefix)) { out[k.slice(prefix.length)] = d[k]; delete d[k]; }
        });
        return out;
      };
      const personal = take('per_');
      const otherInfo = take('oth_');
      const health = take('h_');
      const current = take('cur_');
      const permanent = take('perm_');
      Object.keys(d).forEach(k => { if (k.startsWith('g_') || k.startsWith('d_')) delete d[k]; });

      // the relation is the block's own name, so nobody has to say it twice
      const guardianRows = [...form.querySelectorAll('[data-guardian]')].map(card => {
        const val = (n) => (card.querySelector(`[name="g_${n}"]`).value || '').trim();
        return { relation: card.dataset.role, name: val('name'), occupation: val('occupation'),
                 mobile: val('mobile'), phone: val('phone'), income: val('income'),
                 email: val('email'), qualification: val('qualification'),
                 homeAddress: val('homeAddress') };
      }).filter(g => g.name || g.mobile);
      const badGuardian = guardianRows.find(g => g.mobile && !/^\d{10}$/.test(g.mobile));
      if (badGuardian) {
        toast(`The ${badGuardian.relation.toLowerCase()}'s mobile number must be exactly 10 digits.`, 'err');
        return;
      }

      const documents = [...form.querySelectorAll('[data-document]')].map(card => {
        const val = (n) => (card.querySelector(`[name="d_${n}"]`).value || '').trim();
        return { name: val('name'), type: val('type'), number: val('number'), issued: val('issued'),
                 file: card.querySelector('[data-doc-value]').value || '' };
      }).filter(x => x.name || x.number || x.file);

      d.personal = personal;
      d.otherInfo = otherInfo;
      d.addressInfo = { current, permanent };
      d.health = health;
      d.guardians = guardianRows;
      d.documents = documents;

      /* One answer, in two places: the register records what the person is and
         the login records what they may do, and the form is the only thing that
         sets either — so they cannot disagree. */
      const role = employeeRoles().includes(d.role) ? d.role : tableRole(col, f);
      d.role = role;
      // a user id nobody else holds, from the employee id, unless one was typed
      const uid = username || freeUsername(
        String(d.empId || d.name || role).replace(/\s+/g, '').toLowerCase(), acct && acct.id);
      let newId = id;
      if (id) {
        Store.update(col, id, d);
        const patch = { role, refId: id, name: d.name };
        if (withLogin) { patch.username = uid; if (password) patch.password = password; }
        if (acct) Store.update('users', acct.id, patch);
        else if (withLogin) {
          Store.add('users', { username: uid, password: password || DEFAULT_PASSWORD,
                               role, refId: id, name: d.name });
        }
        if (acct && acct.id === user.id) { user.name = d.name; paintUser(); }
      } else {
        const rec = Store.add(col, d);
        newId = rec.id;
        Store.add('users', { username: uid, password: password || DEFAULT_PASSWORD,
                             role, refId: rec.id, name: rec.name });
      }
      closeModal(); toast('Employee saved.');
      if (after) after(newId); else render();
    };
  }

  // assign / unassign classes to a faculty (admin)
  function facultyClassesModal(fid, after) {
    const f = Store.find('faculty', fid); if (!f) return;
    const assigned = Store.all('courses').filter(c => c.facultyId === fid);
    const others = Store.all('courses').filter(c => c.facultyId !== fid);
    openModal('Classes — ' + f.name, `
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">${esc(f.designation || 'Faculty')} · ${esc(f.department || '')}</p>
      <h4 style="font-size:13px;color:var(--primary-dark);margin-bottom:8px">ASSIGNED CLASSES (${assigned.length})</h4>
      ${assigned.length ? `<div class="att-list">${assigned.map(c => `
        <div class="att-row"><div class="who"><strong>${esc(c.code)} — ${esc(c.name)}</strong>
          <small>${esc(c.branch)} · Sem ${c.semester} · Sec ${esc(c.section || 'A')} · ${studentsOfCourse(c).length} students</small></div>
          <button class="btn-sm btn-del" data-unassign="${c.id}">Unassign</button></div>`).join('')}</div>`
        : `<p class="empty" style="padding:14px">No classes assigned yet.</p>`}
      <h4 style="font-size:13px;color:var(--primary-dark);margin:18px 0 8px">ASSIGN CLASSES
        <span style="font-weight:400;color:var(--muted)">— tick as many as you want</span></h4>
      ${others.length ? `<div class="chk-list" id="asgList">${others.map(c => `
        <label class="chk-row"><input type="checkbox" value="${c.id}">
          <span class="chk-text"><strong>${esc(c.code)} — ${esc(c.name)}</strong>
            <small>${esc(c.branch)} · Sem ${c.semester} · Sec ${esc(c.section || 'A')} ·
              ${c.facultyId ? 'currently ' + esc(facultyName(c.facultyId)) : 'unassigned'}</small></span>
        </label>`).join('')}</div>
        <div class="chk-bar">
          <label class="chk-row" style="border:none;padding:0">
            <input type="checkbox" id="asgAll"><span class="chk-text"><strong>Select all</strong></span></label>
          <span id="asgCount" style="color:var(--muted);font-size:13px">0 selected</span>
        </div>`
        : `<p class="empty" style="padding:14px">No other classes available — create one below.</p>`}
      <div class="form-actions" style="justify-content:space-between">
        <button class="btn-outline" id="newClassBtn">+ Create New Class</button>
        <div style="display:flex;gap:10px">
          ${others.length ? `<button class="btn-primary" id="asgBtn">Assign Selected</button>` : ''}
          <button class="btn-outline" id="cxDone">Done</button>
        </div>
      </div>`);

    const refresh = () => { if (after) after(); facultyClassesModal(fid, after); };
    $('#cxDone').onclick = () => { closeModal(); if (after) after(); };

    const boxes = () => [...$('#modalBody').querySelectorAll('#asgList input[type=checkbox]')];
    if (others.length) {
      const syncCount = () => {
        const n = boxes().filter(b => b.checked).length;
        $('#asgCount').textContent = n + ' selected';
        $('#asgAll').checked = n > 0 && n === boxes().length;
      };
      boxes().forEach(b => b.onchange = syncCount);
      $('#asgAll').onchange = (e) => { boxes().forEach(b => b.checked = e.target.checked); syncCount(); };
      $('#asgBtn').onclick = () => {
        const picked = boxes().filter(b => b.checked).map(b => b.value);
        if (!picked.length) { toast('Please tick at least one class.', 'err'); return; }
        picked.forEach(cid => Store.update('courses', cid, { facultyId: fid }));
        toast(picked.length + ' class(es) assigned to ' + f.name + '.'); refresh();
      };
    }
    $('#newClassBtn').onclick = () => { closeModal(); courseForm(null, { presetFaculty: fid }); };
    $('#modalBody').querySelectorAll('[data-unassign]').forEach(b => b.onclick = () => {
      const c = Store.find('courses', b.dataset.unassign) || {};
      confirmAction('Unassign Class',
        `Take <b>${esc(c.code || '')} ${esc(c.name || '')}</b> away from
         <b>${esc(f.name)}</b>? The class stays on the roll, with nobody teaching it.`,
        'Unassign', () => {
          Store.update('courses', b.dataset.unassign, { facultyId: '' });
          toast('Class unassigned.', 'err'); refresh();
        });
    });
  }

  // ---- ASSIGNMENTS overview (admin) ----
  function viewAssignments() {
    const courses = Store.all('courses');
    const faculty = Store.all('faculty');
    const unassigned = courses.filter(c => !c.facultyId || !Store.find('faculty', c.facultyId));
    const assignedCount = courses.length - unassigned.length;

    let html = `<div class="stat-grid">
      ${statCard('🗂️', courses.length, 'Total Classes')}
      ${statCard('✅', assignedCount, 'Assigned', 'c3')}
      ${statCard('⚠️', unassigned.length, 'Unassigned', unassigned.length ? 'c4' : 'c3')}
      ${statCard('👨‍🏫', faculty.length, 'Faculty', 'c2')}
    </div>`;

    // unassigned classes — quick assign
    html += `<div class="panel" ${unassigned.length ? 'style="border-left:4px solid var(--red)"' : ''}>
      <div class="panel-head"><h3>⚠ Unassigned Classes</h3></div>
      ${unassigned.length ? `<div class="att-list">${unassigned.map(c => `
        <div class="att-row"><div class="who"><strong>${esc(c.code)} — ${esc(c.name)}</strong>
          <small>${esc(c.branch)} · Sem ${c.semester} · Sec ${esc(c.section || 'A')}</small></div>
          <div style="display:flex;gap:8px">
            <select class="filter-sel qa-sel" data-cid="${c.id}" style="min-width:170px">
              <option value="">Assign to...</option>${facultyOptions('')}</select>
            <button class="btn-sm btn-edit qa-btn" data-cid="${c.id}">Assign</button>
          </div></div>`).join('')}</div>`
        : `<p class="empty" style="padding:14px">✓ All classes are assigned — nothing pending.</p>`}
    </div>`;

    // by-faculty breakdown
    html += `<div class="panel"><div class="panel-head"><h3>Assignments by Faculty</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Faculty</th><th>Department</th><th>Assigned Classes</th><th># Classes</th><th>Manage</th>
      </tr></thead><tbody>${faculty.map(f => {
        const mine = courses.filter(c => c.facultyId === f.id);
        const chips = mine.length ? mine.map(c => `<span class="pill blue" style="margin:2px">${esc(c.code)} · Sec ${esc(c.section || 'A')}</span>`).join('')
                                  : `<span style="color:var(--muted);font-size:13px">— none —</span>`;
        return `<tr><td><strong>${esc(f.name)}</strong></td><td>${esc(f.department || '')}</td>
          <td>${chips}</td><td><span class="pill ${mine.length ? 'green' : 'amber'}">${mine.length}</span></td>
          <td><button class="btn-sm btn-edit" data-manage="${f.id}">📚 Manage</button></td></tr>`;
      }).join('')}</tbody></table></div></div>`;

    viewAssignments.after = () => {
      $('#view').querySelectorAll('.qa-btn').forEach(b => b.onclick = () => {
        const cid = b.dataset.cid;
        const fid = $('#view').querySelector(`.qa-sel[data-cid="${cid}"]`).value;
        if (!fid) { toast('Please select a faculty member.', 'err'); return; }
        Store.update('courses', cid, { facultyId: fid });
        toast('Class assigned.'); render();
      });
      $('#view').querySelectorAll('[data-manage]').forEach(b => b.onclick = () => facultyClassesModal(b.dataset.manage, () => render()));
    };
    return html;
  }

  // ---- COURSES ----
  function viewCourses() {
    const canEdit = !viewsMasterOnly();
    let html = `<div class="panel"><div class="panel-head">
      <h3>Courses</h3><div class="panel-tools">
        <input class="search-box" id="couSearch" placeholder="Search code / name...">
        ${canEdit ? `<button class="btn-primary" id="addCou">+ Add Course</button>` : `
          <select class="filter-sel" id="couBranch"><option value="">All Courses</option>${branchOptions()}</select>
          <select class="filter-sel" id="couSem"><option value="">All Semesters</option>${semesterOptions()}</select>
          <button class="btn-outline btn-sm" id="couPrint">🖨 Print</button>
          <button class="btn-outline btn-sm" id="couCsv">📑 CSV</button>
          <button class="btn-primary btn-sm" id="couXls">⬇ Excel</button>`}</div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Code</th><th>Course Name</th><th>Type</th><th>Course</th><th>Sem</th><th>Section</th><th>Credits</th><th>Assigned Faculty</th>
        ${canEdit ? '<th>Actions</th>' : '<th style="text-align:right">Students</th>'}
      </tr></thead><tbody id="couBody"></tbody></table></div><div id="couPager"></div></div>`;
    viewCourses.after = () => {
      let page = 1;
      const filtered = () => {
        const q = ($('#couSearch').value||'').toLowerCase();
        const b = $('#couBranch') ? $('#couBranch').value : '';
        const sem = $('#couSem') ? $('#couSem').value : '';
        return Store.all('courses').filter(c =>
          (!q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) &&
          (!b || c.branch === b) && (!sem || String(c.semester) === String(sem)));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const pageRows = pageSlice(rows, page);
        $('#couBody').innerHTML = pageRows.length ? pageRows.map(c => `<tr>
          <td>${esc(c.code)}${c.shortName ? ` <small style="color:var(--muted)">(${esc(c.shortName)})</small>` : ''}</td>
          <td>${esc(c.name)}</td>
          <td><span class="pill ${c.type === 'Lab' ? 'amber' : c.type === 'Elective' ? 'blue' : 'green'}">${esc(c.type || 'Core')}</span></td>
          <td>${esc(c.branch)}</td><td>${c.semester}</td>
          <td><span class="pill blue">Sec ${esc(c.section||'A')}</span></td>
          <td>${c.credits}</td><td>${esc(facultyName(c.facultyId))}</td>
          ${canEdit ? `<td><div class="row-actions">
            <button class="btn-sm btn-edit" data-edit="${c.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${c.id}">Delete</button></div></td>`
            : `<td style="text-align:right">${studentsOfCourse(c).length}</td>`}</tr>`).join('')
          : `<tr><td colspan="9" class="empty">No courses found.</td></tr>`;
        if (canEdit) {
          $('#couBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => courseForm(b.dataset.edit));
          $('#couBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => delConfirm('courses', b.dataset.del, 'course', draw));
        }
        $('#couPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#couPager'), rows.length, page, (p) => page = p, draw);
      };
      ['couSearch', 'couBranch', 'couSem'].forEach(id => {
        const el = $('#' + id);
        if (el) el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      if (canEdit) $('#addCou').onclick = () => courseForm();
      else {
        const report = () => courseReport(filtered());
        $('#couPrint').onclick = () => printReport(report());
        $('#couCsv').onclick = () => downloadCsv(report());
        $('#couXls').onclick = () => downloadXlsx(report());
      }
      draw();
    };
    return html;
  }

  /* the Courses page as an exportable report — the same rows the table shows */
  function courseReport(rows) {
    return {
      title: 'Course Report', sheetName: 'Courses', subtitle: reportStamp(),
      columns: [
        { header: 'Code', key: 'code', width: 12 },
        { header: 'Course Name', key: 'name', width: 32 },
        { header: 'Type', key: 'type', width: 12 },
        { header: 'Course', key: 'branch', width: 12 },
        { header: 'Semester', key: 'semester', width: 10, type: 'number' },
        { header: 'Section', key: 'section', width: 9 },
        { header: 'Credits', key: 'credits', width: 9, type: 'number' },
        { header: 'Assigned Faculty', key: 'faculty', width: 26 },
        { header: 'Students', key: 'students', width: 10, type: 'number' },
        { header: 'Sessions Held', key: 'sessions', width: 14, type: 'number' },
        { header: 'Attendance %', key: 'attendance', width: 14 },
      ],
      rows: rows.map(c => {
        const att = courseAttendance(c.id);
        return Object.assign({}, c, {
          type: c.type || 'Core', section: c.section || 'A',
          faculty: facultyName(c.facultyId),
          students: studentsOfCourse(c).length,
          sessions: att.sessions, attendance: att.pct === null ? '—' : att.pct,
        });
      }),
      totals: { code: 'TOTAL', name: rows.length + ' courses' },
    };
  }
  /* =================== SUBJECTS BY SEMESTER ===================
     The curriculum: what each branch studies in each semester.

     Backed by its own `syllabus` collection, not by `courses`. A course is one
     taught offering with a section, a teacher, attendance and marks behind it;
     this is the prospectus. Keeping them apart is what lets the admin correct a
     syllabus line without disturbing anybody's attendance, and keeps two
     hundred catalogue entries out of the attendance/marks course pickers.

     Every role reaches this page except the accounts office, and only the
     admin can change it — enforced in api/index.php, not just hidden here. */
  const SYLLABUS_TYPES = ['Theory', 'Lab', 'Elective', 'Project'];
  function canEditSyllabus() { return !!user && user.role === 'admin'; }

  function syllabusRows(branch, sem, q) {
    const needle = (q || '').trim().toLowerCase();
    return Store.all('syllabus')
      .filter(r => (!branch || r.branch === branch)
        && (!sem || String(r.semester) === String(sem))
        && (!needle || (r.name || '').toLowerCase().includes(needle)
          || (r.code || '').toLowerCase().includes(needle)))
      .map(r => Object.assign({}, r, {
        code: r.code || '', name: r.name || '', type: r.type || 'Theory',
        semester: +r.semester || 0,
      }))
      .sort((a, b) => String(a.branch).localeCompare(String(b.branch))
        || a.semester - b.semester
        || String(a.code).localeCompare(String(b.code))
        || String(a.name).localeCompare(String(b.name)));
  }

  // the branch list comes from the syllabus itself, so a branch that only
  // exists in the curriculum (AI & ML, CE) still appears in the filter
  function syllabusBranches() {
    return [...new Set(Store.all('syllabus').map(r => r.branch).filter(Boolean))].sort();
  }

  function viewSyllabus() {
    const canEdit = canEditSyllabus();
    // a student lands on their own branch and semester
    const me = user.role === 'student' ? (Store.find('students', user.refId) || {}) : {};
    const mySem = +me.semester || 0;
    const myBranch = syllabusBranches().includes(me.branch) ? me.branch : '';

    const html = `<div class="panel"><div class="panel-head">
      <h3>Subjects — Semester wise</h3>
      <div class="panel-tools">
        <input class="search-box" id="sylQ" placeholder="Search subject / code...">
        <select class="filter-sel" id="sylBranch"><option value="">All Courses</option>
          ${syllabusBranches().map(b =>
            `<option ${b === myBranch ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
        <select class="filter-sel" id="sylSem"><option value="">All Semesters</option>${semesterOptions(mySem)}</select>
        ${exportButtons('syl')}
        ${canEdit ? '<button class="btn-primary btn-sm" id="sylAdd">+ Add Subject</button>' : ''}
      </div></div>
      <div id="sylStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div id="sylBody"></div></div>
      <div class="panel"><div class="panel-head"><h3>Specialisation × Semester — Paper Count</h3></div>
        <div id="sylMatrix"></div></div>`;

    viewSyllabus.after = () => {
      const rowsNow = () => syllabusRows($('#sylBranch').value, $('#sylSem').value, $('#sylQ').value);
      const report = () => {
        const rows = rowsNow();
        return {
          title: 'Curriculum — Subjects by Semester', sheetName: 'Syllabus', subtitle: reportStamp(),
          columns: [
            { header: 'Course', key: 'branch', width: 12 },
            { header: 'Semester', key: 'semester', width: 10, type: 'number' },
            { header: 'Code', key: 'code', width: 12 },
            { header: 'Subject Name', key: 'name', width: 40 },
            { header: 'Type', key: 'type', width: 11 },
            { header: 'Credits', key: 'credits', width: 9, type: 'number' },
          ],
          rows,
          totals: { branch: 'TOTAL', name: plural(rows.length, 'subject') },
        };
      };

      const draw = () => {
        const rows = rowsNow();
        const branches = new Set(rows.map(r => r.branch));
        const sems = new Set(rows.map(r => r.semester));
        $('#sylStats').innerHTML = `${statCard('🌿', branches.size, 'Specialisations')}
          ${statCard('🎯', sems.size, 'Semesters', 'c2')}
          ${statCard('📘', rows.length, 'No. of Papers', 'c3')}`;

        // one block per branch, and inside it one table per semester
        const byBranch = new Map();
        rows.forEach(r => {
          if (!byBranch.has(r.branch)) byBranch.set(r.branch, new Map());
          const sm = byBranch.get(r.branch);
          if (!sm.has(r.semester)) sm.set(r.semester, []);
          sm.get(r.semester).push(r);
        });

        $('#sylBody').innerHTML = rows.length ? [...byBranch.entries()].map(([br, sm]) => `
          <div class="syl-branch">
            <h4 class="syl-branch-head">🌿 ${esc(br)}
              <small>${plural([...sm.values()].reduce((a, v) => a + v.length, 0), 'subject')} ·
                ${plural(sm.size, 'semester')}</small></h4>
            ${[...sm.entries()].sort((a, b) => a[0] - b[0]).map(([sem, list]) => {
              const credits = list.reduce((a, r) => a + (+r.credits || 0), 0);
              return `<div class="syl-sem${mySem && sem === mySem && myBranch === br ? ' syl-sem-mine' : ''}">
                <div class="syl-sem-head">
                  <strong>Semester ${sem}</strong>
                  ${mySem && sem === mySem && myBranch === br
                    ? '<span class="pill green">Your semester</span>' : ''}
                  <span class="syl-sem-meta">${plural(list.length, 'subject')}${credits ? ` · ${plural(credits, 'credit')}` : ''}
                    ${canEdit ? `<button class="btn-sm btn-edit syl-add-here"
                      data-branch="${esc(br)}" data-sem="${sem}">+ Subject</button>` : ''}</span>
                </div>
                <div class="tbl-wrap"><table><thead><tr>
                  <th style="width:110px">Code</th><th>Subject Name</th><th style="width:110px">Type</th>
                  <th style="width:80px;text-align:right">Credits</th>
                  ${canEdit ? '<th style="width:140px">Actions</th>' : ''}
                </tr></thead><tbody>${list.map(r => `<tr>
                  <td class="mono">${esc(r.code || '—')}</td>
                  <td>${esc(r.name)}</td>
                  <td><span class="pill ${r.type === 'Lab' ? 'amber' : r.type === 'Elective' ? 'blue'
                      : r.type === 'Project' ? 'red' : 'green'}">${esc(r.type)}</span></td>
                  <td style="text-align:right">${r.credits || '—'}</td>
                  ${canEdit ? `<td><div class="row-actions">
                    <button class="btn-sm btn-edit" data-edit="${r.id}">Edit</button>
                    <button class="btn-sm btn-del" data-del="${r.id}">Delete</button></div></td>` : ''}
                  </tr>`).join('')}</tbody></table></div>
              </div>`;
            }).join('')}
          </div>`).join('')
          : `<p class="empty">No subjects match these filters.${canEdit ? ' Use “+ Add Subject” to create one.' : ''}</p>`;

        if (canEdit) {
          $('#sylBody').querySelectorAll('[data-edit]').forEach(b =>
            b.onclick = () => syllabusForm(b.dataset.edit, null, null, draw));
          $('#sylBody').querySelectorAll('[data-del]').forEach(b =>
            b.onclick = () => delConfirm('syllabus', b.dataset.del, 'subject', draw));
          $('#sylBody').querySelectorAll('.syl-add-here').forEach(b =>
            b.onclick = () => syllabusForm(null, b.dataset.branch, +b.dataset.sem, draw));
        }

        // overview grid: how many subjects each branch runs per semester
        const all = syllabusRows('', '', '');
        const brs = [...new Set(all.map(r => r.branch))].sort();
        const allSems = [...new Set(all.map(r => r.semester))].sort((a, b) => a - b);
        $('#sylMatrix').innerHTML = brs.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>Specialisation</th>${allSems.map(s => `<th style="text-align:right">Sem ${s}</th>`).join('')}
            <th style="text-align:right">Total</th></tr></thead>
          <tbody>${brs.map(b => {
            const cells = allSems.map(s => all.filter(r => r.branch === b && r.semester === s).length);
            return `<tr><td>${esc(b)}</td>${cells.map(n =>
              `<td style="text-align:right">${n || '—'}</td>`).join('')}
              <td style="text-align:right;font-weight:600">${cells.reduce((a, n) => a + n, 0)}</td></tr>`;
          }).join('')}</tbody></table></div>`
          : '<p class="empty">No curriculum has been entered yet.</p>';
      };

      $('#sylQ').oninput = draw;
      $('#sylBranch').onchange = draw;
      $('#sylSem').onchange = draw;
      if (canEdit) $('#sylAdd').onclick = () => syllabusForm(null, $('#sylBranch').value, $('#sylSem').value, draw);
      bindExports('syl', report);
      draw();
    };
    return html;
  }

  function syllabusForm(id, presetBranch, presetSem, after) {
    const r = id ? (Store.find('syllabus', id) || {}) : {};
    const branch = r.branch || presetBranch || syllabusBranches()[0] || '';
    const sem = +r.semester || +presetSem || 1;
    openModal((id ? 'Edit' : 'Add') + ' Subject', `<form id="f">
      <div class="form-grid">
        <!-- the shared master-list select: it carries "+ Add New..." and
             "🗑 Remove...", and the list is saved so every page sees it -->
        <div class="field"><label>Specialisation</label>
          <select name="branch" id="sylFormBranch">${branchOptions(branch, true)}</select></div>
        <div class="field"><label>Semester</label>
          <select name="semester">${semesterOptions(sem)}</select></div>
        <div class="field"><label>Subject Code</label>
          <input name="code" value="${esc(r.code || '')}" placeholder="e.g. CS201 — optional">
          <small style="color:var(--muted);font-size:11.5px">Leave blank if the scheme has no code</small></div>
        <div class="field"><label>Subject Name</label>
          <input name="name" value="${esc(r.name || '')}" required placeholder="e.g. Operating Systems"></div>
        <div class="field"><label>Type</label><select name="type">
          ${SYLLABUS_TYPES.map(t => `<option ${t === (r.type || 'Theory') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>Credits</label>
          <input name="credits" type="number" min="0" max="12" value="${r.credits ?? ''}" placeholder="optional"></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindBranchSelect($('#sylFormBranch'));
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.branch = (d.branch || '').trim();
      d.code = (d.code || '').trim().toUpperCase();
      d.name = (d.name || '').trim();
      d.semester = +d.semester;
      d.credits = d.credits === '' ? null : +d.credits;
      if (!d.branch || !d.name) { toast('Branch and subject name are required.', 'err'); return; }
      // the same subject twice in one semester is always a mistake
      const clash = Store.all('syllabus').find(x => x.id !== id && x.branch === d.branch
        && String(x.semester) === String(d.semester)
        && (d.code ? (x.code || '').toUpperCase() === d.code
                   : (x.name || '').toLowerCase() === d.name.toLowerCase()));
      if (clash) {
        toast(`“${d.code || d.name}” is already in ${d.branch} semester ${d.semester}.`, 'err');
        return;
      }
      if (id) Store.update('syllabus', id, d); else Store.add('syllabus', d);
      closeModal();
      toast('Subject saved.');
      if (after) after(); else render();
    };
  }

  function courseForm(id, opts) {
    opts = opts || {};
    const c = opts.draft ? Object.assign({}, opts.draft) :
      (id ? Store.find('courses', id) : (opts.presetFaculty ? { facultyId: opts.presetFaculty } : {}));
    openModal((id?'Edit':'Add')+' Course', `<form id="f">
      <div class="form-grid">
        <div class="field"><label>Course Code</label><input name="code" value="${esc(c.code||'')}" required></div>
        <div class="field"><label>Course Name</label><input name="name" value="${esc(c.name||'')}" required></div>
        <div class="field"><label>Course</label><select name="branch" id="courseFormBranch">${branchOptions(c.branch, true)}</select></div>
        <div class="field"><label>Semester</label><input name="semester" type="number" min="1" max="4" value="${c.semester||1}"></div>
        <div class="field"><label>Section</label><input name="section" value="${esc(c.section||'A')}" placeholder="e.g. A"></div>
        <div class="field"><label>Credits</label><input name="credits" type="number" min="1" max="6" value="${c.credits||3}"></div>
        <div class="field"><label>Short Name</label>
          <input name="shortName" value="${esc(c.shortName||'')}" placeholder="e.g. DBMS" maxlength="10">
          <small style="color:var(--muted);font-size:11.5px">Shown in the timetable — blank = auto</small></div>
        <div class="field"><label>Course Type</label><select name="type">
          ${COURSE_TYPES.map(t => `<option ${t === (c.type || 'Core') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <p style="color:var(--muted);font-size:12.5px;margin-top:6px">
        Faculty is assigned from the <strong>Assignments</strong> page, where one teacher can take several classes at once.</p>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindBranchSelect($('#courseFormBranch'));
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.semester = +d.semester; d.credits = +d.credits;
      d.section = (d.section || 'A').toUpperCase();
      d.shortName = (d.shortName || '').trim().toUpperCase();
      // the form no longer carries facultyId — keep whatever the course already has
      if (!id) d.facultyId = opts.presetFaculty || c.facultyId || '';
      let saved;
      if (id) { Store.update('courses', id, d); saved = { id, ...d }; }
      else saved = Store.add('courses', d);
      closeModal(); toast('Course saved.');
      if (opts.after) opts.after(saved.id); else render();
    };
  }

  // ---- ATTENDANCE (mark) ----
  function teacherCourses() {
    if (collegeWide()) return Store.all('courses');
    if (user.role === 'course_coordinator') {
      const dept = attendanceScopeDept();
      return dept ? Store.all('courses').filter(c => c.branch === dept) : Store.all('courses');
    }
    return Store.all('courses').filter(c => c.facultyId === user.refId);
  }
  // does a student belong to this course's class (branch + sem + assigned section)?
  function inCourseClass(s, c) {
    return s.branch === c.branch && s.semester === c.semester &&
           (!c.section || s.section === c.section);
  }
  function studentsOfCourse(c) {
    return Store.all('students').filter(s => inCourseClass(s, c));
  }
  function courseLabel(c) {
    return `${c.code} — ${c.name} (Sec ${c.section || 'A'})`;
  }
  // students that fall under THIS faculty's assigned classes (admin -> all)
  function visibleStudents() {
    if (collegeWide()) return Store.all('students');
    const classes = teacherCourses();
    return Store.all('students').filter(s => classes.some(c => inCourseClass(s, c)));
  }
  // faculty's own department, normalized to a programme code so it can be
  // matched against student.branch — falls back to null if unknown
  function facultyDeptBranch() {
    const f = Store.find('faculty', user.refId);
    if (!f || !f.department) return null;
    const dep = f.department.trim();
    if (!dep) return null;
    if (BRANCHES.includes(dep.toUpperCase())) return dep.toUpperCase();
    const map = {
      'management': 'MBA', 'business administration': 'MBA',
      'master of business administration': 'MBA', 'mba': 'MBA',
    };
    return map[dep.toLowerCase()] || null;
  }
  // students shown on the Students page: admin -> all, faculty -> own department only
  function rosterStudents() {
    // The offices that read the roll without owning it — accounts, the
    // placement cell, the library — see every student, the same list the
    // admin does. What they cannot do is change it, which the server enforces.
    if (collegeWide() || ['librarian', 'accountant', 'placement_officer', 'admission'].includes(user.role)) {
      return Store.all('students');
    }
    /* A coordinator calls the register for their department, so the roll they
       read is the same set — without this they fell through to the
       taught-classes rule below, which is a faculty idea, and saw nobody. */
    if (user.role === 'course_coordinator') {
      const dept = attendanceScopeDept();
      return dept ? Store.all('students').filter(s => s.branch === dept) : Store.all('students');
    }
    if (user.role === 'faculty') {
      const branch = facultyDeptBranch();
      if (branch) return Store.all('students').filter(s => s.branch === branch);
    }
    return visibleStudents();
  }
  // every saved session for the classes this user is responsible for (admin -> all)
  function myAttendanceSessions() {
    const ids = teacherCourses().map(c => c.id);
    return Store.all('attendance').filter(a => ids.includes(a.courseId))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }
  function sessionCounts(a) {
    const vals = Object.values(a.records || {});
    const present = vals.filter(v => v === 'P').length;
    return { total: vals.length, present, absent: vals.length - present,
             pct: vals.length ? Math.round(present / vals.length * 100) : 0 };
  }

  /* ==================== ATTENDANCE ====================
     A class is identified by the whole chain the institute already keeps:
     course, batch, semester, department, specialisation, paper, faculty, date
     and time. Every one of those is chosen from existing master data — nothing
     about a class or a student is typed in twice — and the student list is
     whoever matches, not a list anybody maintains by hand. */
  const ATT_TYPES = ['Academic', 'Placement'];

  /** Students matching a class, in the order a register is called. */
  function studentsForClass(f) {
    return Store.all('students').filter(s =>
      (!f.course || s.course === f.course) &&
      (!f.batch || s.batch === f.batch) &&
      (!f.semester || String(s.semester) === String(f.semester)) &&
      (!f.department || s.branch === f.department) &&
      (!f.specialisation || s.specialisation === f.specialisation) &&
      (s.status || 'Active') === 'Active')
      .sort((a, b) => String(a.roll || '').localeCompare(String(b.roll || '')));
  }

  /** Papers on the scheme for a department and semester. */
  function papersFor(department, semester) {
    return Store.all('syllabus').filter(r =>
      (!department || r.branch === department) &&
      (!semester || String(r.semester) === String(semester)))
      .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
  }

  /* Options built from the students actually on the roll, so a combination
     that would return nobody is never offered. */
  function attOptions(rows, key, label) {
    const seen = [...new Set(rows.map(r => String(r[key] ?? '').trim()).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    return `<option value="">${label}</option>` +
      seen.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  }

  /** A coordinator runs their own department; everyone else who can mark, marks. */
  function attendanceScopeDept() {
    if (!user || user.role !== 'course_coordinator') return null;
    const me = Store.find('coordinators', user.refId);
    return me && me.department ? me.department : null;
  }

  function viewAttendance() {
    // a monitoring role never gets the marking panel — it gets the overview
    if (readOnly()) return viewAttendanceOverview();
    if (!canMarkAttendance()) {
      return `<div class="panel"><p class="empty">Attendance entry is currently handled by
        the course coordinator. Ask the System Admin if you need it back.</p></div>`;
    }
    const scopeDept = attendanceScopeDept();
    const roster = Store.all('students').filter(s => !scopeDept || s.branch === scopeDept);

    let html = `<div class="panel"><div class="panel-head"><h3>Register Attendance</h3>
        ${scopeDept ? `<span class="pill blue">${esc(scopeDept)} department</span>` : ''}
        ${user.role === 'admin' ? `<div class="panel-tools">
          <label class="switch-label" title="Turn off to leave attendance entry to the course coordinator">
            <input type="checkbox" id="facAttToggle" ${facultyAttendanceOn() ? 'checked' : ''}>
            <span>Faculty can mark attendance</span>
          </label></div>` : ''}</div>
      <div class="att-form">
        <label class="att-field"><span>Type</span>
          <select id="atType">${ATT_TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
        <label class="att-field"><span>Course</span>
          <select id="atCourse">${attOptions(roster, 'course', 'Select course...')}</select></label>
        <label class="att-field"><span>Batch</span>
          <select id="atBatch"><option value="">Select batch...</option></select></label>
        <label class="att-field"><span>Semester</span>
          <select id="atSem"><option value="">Select semester...</option></select></label>
        <label class="att-field"><span>Department</span>
          <select id="atDept"><option value="">Select department...</option></select></label>
        <label class="att-field"><span>Specialisation</span>
          <select id="atSpec"><option value="">Select specialisation...</option></select></label>
        <label class="att-field"><span>Paper Code</span>
          <select id="atPaper"><option value="">Select paper...</option></select></label>
        <label class="att-field"><span>Paper Name</span>
          <input id="atPaperName" readonly placeholder="fills from the paper code"></label>
        <label class="att-field"><span>Faculty</span>
          <select id="atFaculty"><option value="">Select faculty...</option>
            ${teachingStaff().slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
              .map(f => `<option value="${f.id}">${esc(f.name)}${f.department ? ' · ' + esc(f.department) : ''}</option>`).join('')}
          </select></label>
        <label class="att-field"><span>Date of Class</span>
          <input type="date" id="atDate" value="${today()}"></label>
        <label class="att-field"><span>Start Time</span>
          <input type="time" id="atTime" value="09:30"></label>
        <label class="att-field"><span>End Time</span>
          <input type="time" id="atEnd" value="10:30"></label>
      </div>
      <div id="attArea"><p class="empty">Choose the class above — the students on it load by themselves.</p></div>
    </div>`;

    viewAttendance.after = () => {
      const val = (id) => ($('#' + id).value || '');
      const current = () => ({
        type: val('atType'), course: val('atCourse'), batch: val('atBatch'),
        semester: val('atSem'), department: val('atDept'), specialisation: val('atSpec'),
        paperCode: val('atPaper'), facultyId: val('atFaculty'),
        date: val('atDate'), classTime: val('atTime'), endTime: val('atEnd'),
      });

      /* Each dropdown narrows the ones after it. Rebuilding from the roster
         each time is what keeps a stale choice from surviving a change
         further up the chain. */
      const refill = (from) => {
        const f = current();
        const after = (key) => {
          const partial = Object.assign({}, f);
          ['course', 'batch', 'semester', 'department', 'specialisation']
            .slice(['course', 'batch', 'semester', 'department', 'specialisation'].indexOf(key))
            .forEach(k => { partial[k] = ''; });
          return studentsForClass(Object.assign({}, partial, { specialisation: '' }))
            .filter(s => !scopeDept || s.branch === scopeDept);
        };
        const keep = (id, options) => {
          const prev = $('#' + id).value;
          $('#' + id).innerHTML = options;
          $('#' + id).value = [...$('#' + id).options].some(o => o.value === prev) ? prev : '';
        };
        if (from === 'course') keep('atBatch', attOptions(after('batch'), 'batch', 'Select batch...'));
        if (['course', 'batch'].includes(from)) keep('atSem', attOptions(after('semester'), 'semester', 'Select semester...'));
        if (['course', 'batch', 'semester'].includes(from)) {
          keep('atDept', attOptions(after('department'), 'branch', 'Select department...'));
        }
        keep('atSpec', attOptions(studentsForClass(Object.assign({}, current(), { specialisation: '' })),
                                  'specialisation', 'Select specialisation...'));
        const dept = val('atDept'), sem = val('atSem');
        const papers = papersFor(dept, sem);
        keep('atPaper', `<option value="">Select paper...</option>` + papers.map(r =>
          `<option value="${esc(r.code || r.name)}">${esc(r.code || '—')}</option>`).join(''));
        showPaperName();
      };

      const showPaperName = () => {
        const code = val('atPaper');
        const paper = papersFor(val('atDept'), val('atSem')).find(r => (r.code || r.name) === code);
        $('#atPaperName').value = paper ? (paper.name || '') : '';
      };

      const renderArea = () => {
        const f = current();
        const area = $('#attArea');
        const missing = [];
        if (!f.course) missing.push('course');
        if (!f.semester) missing.push('semester');
        if (!f.department) missing.push('department');
        if (!f.date) missing.push('date');
        if (missing.length) {
          area.innerHTML = `<p class="empty">Choose the ${missing.join(', ')} to load the students.</p>`;
          return;
        }
        const studs = studentsForClass(f).filter(s => !scopeDept || s.branch === scopeDept);
        if (!studs.length) {
          area.innerHTML = `<p class="empty">No active student matches this class.</p>`;
          return;
        }
        // an existing register for the same class and date is reopened, not duplicated
        const session = existingSession(f);
        const rec = session ? (session.records || {}) : {};
        area.innerHTML = `<div class="att-head-row">
            <strong>${studs.length} student(s)</strong>
            <button type="button" class="btn-outline btn-sm" id="markAll">✅ Mark All Present</button>
            ${session ? `<span class="pill amber">Editing the register saved for this class</span>` : ''}
          </div>
          <div class="tbl-wrap"><table><thead><tr>
            <th>#</th><th>Student Name</th><th>Roll No.</th><th>Attendance</th>
          </tr></thead><tbody>${studs.map((st, i) => {
            const v = rec[st.id] || 'P';
            return `<tr><td>${i + 1}</td><td>${esc(st.name)}</td><td>${esc(st.roll)}</td>
              <td><div class="att-toggle" data-sid="${st.id}">
                <button type="button" class="toggle-btn p ${v === 'P' ? 'on' : ''}" data-v="P">Present</button>
                <button type="button" class="toggle-btn a ${v === 'A' ? 'on' : ''}" data-v="A">Absent</button>
              </div></td></tr>`;
          }).join('')}</tbody></table></div>
          <div class="form-actions"><button class="btn-primary" id="saveAtt">Save Attendance</button></div>`;

        area.querySelectorAll('.att-toggle').forEach(grp => {
          grp.querySelectorAll('.toggle-btn').forEach(btn => btn.onclick = () => {
            grp.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
          });
        });
        $('#markAll').onclick = () => {
          area.querySelectorAll('.att-toggle').forEach(grp => {
            grp.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('on', b.dataset.v === 'P'));
          });
        };
        $('#saveAtt').onclick = () => saveSession(f, session, area);
      };

      const inputs = ['atType', 'atCourse', 'atBatch', 'atSem', 'atDept', 'atSpec',
                      'atPaper', 'atFaculty', 'atDate', 'atTime', 'atEnd'];
      inputs.forEach(id => {
        $('#' + id).onchange = () => {
          const key = { atCourse: 'course', atBatch: 'batch', atSem: 'semester', atDept: 'department' }[id];
          if (key) refill(key);
          if (id === 'atPaper') showPaperName();
          renderArea();
        };
      });
      if (user.role === 'admin') {
        $('#facAttToggle').onchange = (e) => {
          setSetting('facultyAttendance', e.target.checked);
          toast(e.target.checked
            ? 'Faculty can now mark attendance.'
            : 'Attendance entry is now with the course coordinator only.');
        };
      }
      refill('course');
      renderArea();
    };
    return html;
  }

  /** The register already saved for this exact class and date, if any. */
  function existingSession(f) {
    return Store.all('attendance').find(a =>
      a.date === f.date &&
      String(a.course || '') === String(f.course || '') &&
      String(a.batch || '') === String(f.batch || '') &&
      String(a.semester || '') === String(f.semester || '') &&
      String(a.department || '') === String(f.department || '') &&
      String(a.specialisation || '') === String(f.specialisation || '') &&
      String(a.paperCode || '') === String(f.paperCode || '') &&
      String(a.classTime || '') === String(f.classTime || ''));
  }

  function saveSession(f, session, area) {
    if (f.classTime && f.endTime && f.endTime <= f.classTime) {
      toast('The class cannot end before it starts.', 'err');
      return;
    }
    const records = {};
    area.querySelectorAll('.att-toggle').forEach(grp => {
      const on = grp.querySelector('.toggle-btn.on');
      records[grp.dataset.sid] = on ? on.dataset.v : 'P';
    });
    const paper = papersFor(f.department, f.semester).find(r => (r.code || r.name) === f.paperCode);
    /* The taught offering, when there is one — marks and the course-wise
       reports hang off courseId, so a register that matches a course keeps
       feeding them. */
    const course = Store.all('courses').find(c =>
      c.branch === f.department && String(c.semester) === String(f.semester) &&
      (c.code === f.paperCode || c.name === (paper && paper.name)));
    const row = Object.assign({}, f, {
      paperName: paper ? (paper.name || '') : '',
      courseId: course ? course.id : (session ? session.courseId : ''),
      markedBy: user.id, records,
    });
    if (session) Store.update('attendance', session.id, row);
    else Store.add('attendance', row);
    toast('Attendance saved.');
    render();
  }

  /* ---------- the register, one row per student ---------- */
  function attendanceRows() {
    const scopeDept = attendanceScopeDept();
    const out = [];
    Store.all('attendance').forEach(a => {
      const fac = a.facultyId ? Store.find('faculty', a.facultyId) : null;
      const course = a.courseId ? Store.find('courses', a.courseId) : null;
      Object.entries(a.records || {}).forEach(([sid, status]) => {
        const st = Store.find('students', sid);
        if (!st) return;
        const department = a.department || (course && course.branch) || st.branch || '—';
        if (scopeDept && department !== scopeDept) return;
        out.push({
          sessionId: a.id, date: a.date || '—',
          classTime: [a.classTime, a.endTime].filter(Boolean).join(' – ') || '—',
          type: a.type || 'Academic',
          course: a.course || st.course || '—', batch: a.batch || st.batch || '—',
          semester: a.semester || (course && course.semester) || st.semester || '—',
          department,
          specialisation: a.specialisation || st.specialisation || '—',
          paperCode: a.paperCode || (course && course.code) || '—',
          paperName: a.paperName || (course && course.name) || '—',
          faculty: fac ? fac.name : (course && Store.find('faculty', course.facultyId)
            ? Store.find('faculty', course.facultyId).name : '—'),
          studentName: st.name || '—', roll: st.roll || '—',
          status: status === 'A' ? 'Absent' : 'Present',
        });
      });
    });
    return out.sort((a, b) => String(b.date).localeCompare(String(a.date)) ||
                              String(a.roll).localeCompare(String(b.roll)));
  }

  function attendanceRecordsReport(rows) {
    return {
      title: 'Attendance Records', sheetName: 'Attendance', subtitle: reportStamp(),
      columns: [
        { header: 'Course', key: 'course', width: 10 },
        { header: 'Batch', key: 'batch', width: 14 },
        { header: 'Semester', key: 'semester', width: 10 },
        { header: 'Department', key: 'department', width: 12 },
        { header: 'Specialisation', key: 'specialisation', width: 20 },
        { header: 'Paper Code', key: 'paperCode', width: 12 },
        { header: 'Paper Name', key: 'paperName', width: 30 },
        { header: 'Faculty', key: 'faculty', width: 22 },
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Time', key: 'classTime', width: 16 },
        { header: 'Student Name', key: 'studentName', width: 24 },
        { header: 'Roll No.', key: 'roll', width: 14 },
        { header: 'Status', key: 'status', width: 10 },
      ],
      rows,
      totals: { course: 'TOTAL', batch: rows.length + ' entries' },
    };
  }

  function viewAttendanceRecords() {
    const all = attendanceRows();
    const html = `<div class="panel"><div class="panel-head"><h3>Attendance Records</h3>
        <div class="panel-tools">${exportButtons('ar')}</div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="arQ" placeholder="Search student / roll / paper...">
        <select class="filter-sel" id="arType"><option value="">All Types</option>
          ${ATT_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
        <select class="filter-sel" id="arDept">${attOptions(all, 'department', 'All Departments')}</select>
        <select class="filter-sel" id="arSpec">${attOptions(all, 'specialisation', 'All Specialisations')}</select>
        <select class="filter-sel" id="arPaper">${attOptions(all, 'paperCode', 'All Papers')}</select>
        <select class="filter-sel" id="arStatus"><option value="">Present & Absent</option>
          <option>Present</option><option>Absent</option></select>
        <label class="days-field">From <input class="filter-sel" id="arFrom" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="arTo" type="date"></label>
        <button class="btn-outline btn-sm" id="arClear">Clear</button>
      </div>
      <div id="arStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Course</th><th>Batch</th><th>Semester</th><th>Department</th><th>Specialisation</th>
        <th>Paper Code</th><th>Paper Name</th><th>Faculty</th><th>Date</th><th>Time</th>
        <th>Student Name</th><th>Roll No.</th><th>Status</th>
      </tr></thead><tbody id="arBody"></tbody></table></div><div id="arPager"></div></div>`;

    viewAttendanceRecords.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#arQ').value || '').trim().toLowerCase();
        const type = $('#arType').value, dept = $('#arDept').value, spec = $('#arSpec').value;
        const paper = $('#arPaper').value, status = $('#arStatus').value;
        const from = $('#arFrom').value, to = $('#arTo').value;
        return all.filter(r =>
          (!q || [r.studentName, r.roll, r.paperCode, r.paperName, r.faculty]
            .some(v => String(v).toLowerCase().includes(q))) &&
          (!type || r.type === type) && (!dept || r.department === dept) &&
          (!spec || r.specialisation === spec) && (!paper || r.paperCode === paper) &&
          (!status || r.status === status) &&
          (!from || (r.date !== '—' && r.date >= from)) &&
          (!to || (r.date !== '—' && r.date <= to)));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        const present = rows.filter(r => r.status === 'Present').length;
        $('#arStats').innerHTML = `${statCard('🗂️', rows.length, 'Entries')}
          ${statCard('✅', present, 'Present', 'c3')}
          ${statCard('❌', rows.length - present, 'Absent', 'c4')}
          ${statCard('📈', rows.length ? Math.round(present / rows.length * 100) + '%' : '—', 'Attendance', 'c2')}`;
        $('#arBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td>${esc(r.course)}</td><td>${esc(r.batch)}</td><td>${esc(String(r.semester))}</td>
          <td>${esc(r.department)}</td><td>${esc(r.specialisation)}</td>
          <td class="mono">${esc(r.paperCode)}</td><td>${esc(r.paperName)}</td>
          <td>${esc(r.faculty)}</td><td>${esc(r.date)}</td><td>${esc(r.classTime)}</td>
          <td>${esc(r.studentName)}</td><td class="mono">${esc(r.roll)}</td>
          <td><span class="pill ${r.status === 'Present' ? 'green' : 'red'}">${r.status}</span></td>
        </tr>`).join('') : `<tr><td colspan="13" class="empty">No attendance has been registered yet.</td></tr>`;
        $('#arPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#arPager'), rows.length, page, (p) => page = p, draw);
      };
      ['arQ', 'arType', 'arDept', 'arSpec', 'arPaper', 'arStatus', 'arFrom', 'arTo'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#arClear').onclick = () => {
        ['arQ', 'arType', 'arDept', 'arSpec', 'arPaper', 'arStatus', 'arFrom', 'arTo']
          .forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      bindExports('ar', () => attendanceRecordsReport(rowsFor()));
      draw();
    };
    return html;
  }


  // printable student-wise attendance report for one class, or all of them
  function attendanceReport(courseId) {
    const courses = teacherCourses().filter(c => !courseId || c.id === courseId);
    if (!courses.length) { toast('No classes to report on.', 'err'); return; }

    const blocks = courses.map(c => {
      const sessions = Store.all('attendance').filter(a => a.courseId === c.id);
      const rows = studentsOfCourse(c).map(s => {
        const held = sessions.filter(a => s.id in (a.records || {}));
        const present = held.filter(a => a.records[s.id] === 'P').length;
        const pct = held.length ? Math.round(present / held.length * 100) : null;
        const low = pct !== null && pct < 75;
        return `<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${held.length}</td>
          <td>${present}</td><td>${held.length - present}</td>
          <td${low ? ' style="color:#e0414f;font-weight:700"' : ''}>${pct === null ? '—' : pct + '%'}</td></tr>`;
      }).join('') || `<tr><td colspan="6" style="text-align:center">No students in this class.</td></tr>`;
      return `<h2 style="font-size:16px;color:#0d2f6b;margin:22px 0 4px">${esc(c.code)} — ${esc(c.name)}</h2>
        <p style="font-size:13px;color:#555">${esc(c.branch)} · Semester ${c.semester} · Section ${esc(c.section || 'A')}
          · ${sessions.length} session(s) held · Faculty: ${esc(facultyName(c.facultyId))}</p>
        <table><thead><tr><th>Reg No</th><th>Name</th><th>Classes Held</th><th>Present</th><th>Absent</th><th>Attendance %</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }).join('');

    printDoc('Attendance Report', `${docHeader()}
      <h2 style="font-size:17px;color:#0d2f6b">Attendance Report</h2>
      <p style="font-size:13px;color:#555">Generated on ${prettyDate()} · Minimum requirement 75%</p>
      ${blocks}
      <div class="sign"><span>Faculty Signature</span><span>HOD Signature</span></div>`);
  }

  // ---- MARKS (admin/faculty) ----
  // keep a marks box inside 0..max — the browser's own min/max only blocks the
  // spinner arrows, typed and pasted values still get through
  function clampMark(inp) {
    if (!inp || inp.value === '') return;
    const max = +inp.max, min = +inp.min || 0;
    let v = Math.floor(Math.abs(+inp.value || 0));
    if (v > max) { v = max; toast(`Maximum is ${max} marks.`, 'err'); }
    if (v < min) v = min;
    inp.value = v;
  }

  function viewMarks() {
    const courses = teacherCourses();
    let html = `<div class="panel"><div class="panel-head"><h3>Enter / Edit Marks</h3>
      <div class="panel-tools">
        <select class="filter-sel" id="mkCourse"><option value="">Select class...</option>
          ${courses.map(c => `<option value="${c.id}">${esc(courseLabel(c))}</option>`).join('')}</select>
      </div></div>
      ${courses.length ? '' : `<p class="empty" style="padding:0 0 14px">No classes have been assigned to you yet. Ask the System Admin to assign one.</p>`}
      <div id="mkArea"><p class="empty">Select a class to enter marks. (Internal assessment only, out of ${INTERNAL_MAX})</p></div></div>`;
    viewMarks.after = () => {
      $('#mkCourse').onchange = () => {
        const cid = $('#mkCourse').value, area = $('#mkArea');
        if (!cid) { area.innerHTML = `<p class="empty">Please select a class.</p>`; return; }
        const c = Store.find('courses', cid);
        const studs = studentsOfCourse(c);
        area.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
          <th>Reg No</th><th>Name</th><th>Internal /${INTERNAL_MAX}</th><th>Percentage</th><th>Grade</th>
        </tr></thead><tbody>${studs.map(s => {
          const m = Store.all('marks').find(x => x.studentId === s.id && x.courseId === cid) || {};
          const pct = markPercent(m);
          const g = gradeFor(pct || 0);
          return `<tr data-sid="${s.id}"><td>${esc(s.roll)}</td><td>${esc(s.name)}</td>
            <td><input class="filter-sel mk-int" style="width:80px" type="number" min="0" max="${INTERNAL_MAX}" value="${m.internal??''}"></td>
            <td class="mk-pct">${pct === null ? '—' : pct + '%'}</td>
            <td class="mk-grd"><span class="pill ${g.p?'blue':'red'}">${pct === null ? '—' : g.g}</span></td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="form-actions"><button class="btn-primary" id="saveMk">Save Marks</button></div>`;

        area.querySelectorAll('tr[data-sid]').forEach(tr => {
          const inp = tr.querySelector('.mk-int');
          const upd = () => {
            const pct = markPercent({ internal: inp.value });
            const g = gradeFor(pct || 0);
            tr.querySelector('.mk-pct').textContent = pct === null ? '—' : pct + '%';
            tr.querySelector('.mk-grd').innerHTML = `<span class="pill ${g.p?'blue':'red'}">${pct === null ? '—' : g.g}</span>`;
          };
          // typing (or pasting) more than the maximum is clamped straight away
          inp.oninput = () => { clampMark(inp); upd(); };
        });
        $('#saveMk').onclick = () => {
          area.querySelectorAll('tr[data-sid]').forEach(tr => {
            const sid = tr.dataset.sid;
            const intEl = tr.querySelector('.mk-int');
            clampMark(intEl);
            const iv = intEl.value;
            if (iv === '') return;
            const internal = +iv||0;
            const existing = Store.all('marks').find(x => x.studentId === sid && x.courseId === cid);
            if (existing) Store.update('marks', existing.id, { internal });
            else Store.add('marks', { studentId: sid, courseId: cid, internal });
          });
          toast('Marks saved.');
        };
      };
    };
    return html;
  }

  // ---- TIMETABLE ----
  let DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat'];
  const DAY_FULL = { Mon:'Monday', Tue:'Tuesday', Wed:'Wednesday', Thu:'Thursday', Fri:'Friday', Sat:'Saturday', Sun:'Sunday' };
  const SEM_ORDINAL = ['','1ST','2ND','3RD','4TH','5TH','6TH','7TH','8TH'];

  /* ---------- timetable time grid: 30-minute rows, 07:30 AM -> 04:00 PM ---------- */
  const TT_START = '07:30', TT_END = '16:00', TT_STEP = 30;
  const toMin = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const toHHMM = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  function pretty12(min) {
    let h = Math.floor(min / 60); const m = min % 60; const ap = h < 12 ? 'AM' : 'PM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
  }
  function timeRows() {
    const rows = [];
    for (let m = toMin(TT_START); m < toMin(TT_END); m += TT_STEP)
      rows.push({ from: m, to: m + TT_STEP, label: `${pretty12(m)} - ${pretty12(m + TT_STEP)}` });
    return rows;
  }
  function timeOptions(selected) {
    let out = '';
    for (let m = toMin(TT_START); m <= toMin(TT_END); m += TT_STEP) {
      const v = toHHMM(m);
      out += `<option value="${v}" ${v === selected ? 'selected' : ''}>${pretty12(m)}</option>`;
    }
    return out;
  }
  // slots saved before startTime/endTime existed still land on the grid
  const LEGACY_PERIOD_TIMES = { 1:['08:30','09:30'], 2:['09:30','10:30'], 3:['10:30','11:30'], 4:['11:30','12:30'], 5:['14:00','15:00'] };
  function slotTimes(t) {
    if (t.startTime && t.endTime) return [toMin(t.startTime), toMin(t.endTime)];
    const legacy = LEGACY_PERIOD_TIMES[t.period];
    if (legacy) return [toMin(legacy[0]), toMin(legacy[1])];
    return [toMin(TT_START), toMin(TT_START) + 60];
  }
  function slotTimeLabel(t) {
    const [a, b] = slotTimes(t);
    return `${pretty12(a)} - ${pretty12(b)}`;
  }
  // "Database Management Systems" -> "DBMS", so a cell stays readable at column width
  const SHORT_SKIP = new Set(['and','of','the','for','in','to','with','a','an','on']);
  function shortSubject(name) {
    const raw = String(name || '').trim();
    if (!raw) return '?';
    const words = raw.split(/[\s\-/&,.]+/).filter(w => w && !SHORT_SKIP.has(w.toLowerCase()));
    if (words.length >= 2) return words.map(w => w[0].toUpperCase()).join('');
    return raw.slice(0, 6).toUpperCase();
  }

  // one entry inside a timetable cell: subject / class / faculty / room
  function ttCard(t, showDelete) {
    const c = Store.find('courses', t.courseId);
    const isLab = !!c && (c.type === 'Lab' || /lab/i.test(c.code + ' ' + c.name));
    const sem = SEM_ORDINAL[t.semester] || (t.semester + 'TH');
    return `<div class="tt-cell${isLab ? ' lab' : ''}">
      <b title="${c ? esc(c.name) : ''}">${c ? esc(c.shortName || shortSubject(c.name)) : '?'}</b>
      <small>${sem} Sem ${esc(t.branch)} · Sec ${esc(t.section || 'ALL')}</small>
      <small>👨‍🏫 ${c ? esc(facultyName(c.facultyId)) : '—'}</small>
      <small>🏫 Room No.${esc(t.room || '—')}</small>
      ${showDelete ? `<button class="btn-sm btn-del" data-del="${t.id}" style="margin-top:4px">✕</button>` : ''}
    </div>`;
  }
  // lay slots onto the grid: which row each starts at, how many rows it spans
  function buildTimetableGrid(slots, rows) {
    const grid = {};
    DAYS.forEach(d => grid[d] = { start: {}, covered: new Set() });
    slots.forEach(t => {
      const day = grid[t.day];
      if (!day) return;
      const [a, b] = slotTimes(t);
      const i = rows.findIndex(r => r.from <= a && a < r.to);
      if (i < 0) return;                                   // outside the visible day
      // does an earlier slot already occupy this cell? then stack them together
      for (let k = i; k >= 0; k--) {
        if (day.start[k] && k + day.start[k].span > i) { day.start[k].list.push(t); return; }
      }
      const span = Math.min(Math.max(1, Math.round((b - a) / TT_STEP)), rows.length - i);
      day.start[i] = { list: [t], span };
      for (let k = i + 1; k < i + span; k++) day.covered.add(k);
    });
    return grid;
  }
  function viewTimetable() {
    const isAdmin = user.role === 'admin';
    const isFaculty = user.role === 'faculty';
    // the center head and the coordinator pick any class the admin can, and
    // edit none of it
    const canPickClass = isAdmin || viewsMasterOnly();
    // determine scope
    let branch, semester, section;
    if (user.role === 'student') {
      const s = Store.find('students', user.refId);
      branch = s.branch; semester = s.semester; section = s.section;
    }
    const myCourses = isFaculty ? teacherCourses() : [];

    let html = `<div class="panel"><div class="panel-head"><h3>${isFaculty ? 'My Timetable' : 'Class Timetable'}</h3>
      <div class="panel-tools">`;
    if (canPickClass) {
      html += `<select class="filter-sel" id="ttBranch">${branchOptions('MBA')}</select>
        <select class="filter-sel" id="ttSem">${SEMESTERS.map(n=>`<option value="${n}" ${n===2?'selected':''}>Sem ${n}</option>`).join('')}</select>
        <input class="filter-sel" id="ttSec" value="A" style="width:60px">
        ${isAdmin ? `<button class="btn-primary" id="addSlot">+ Add Slot</button>`
          : `<select class="filter-sel" id="ttView">
               <option value="class">Class Timetable</option>
               <option value="faculty">Faculty Timetable</option>
               <option value="room">Room / Section Timetable</option>
               <option value="dept">Department Timetable</option>
             </select>
             <button class="btn-outline btn-sm" id="ttPrint">🖨 Print</button>
             <button class="btn-primary btn-sm" id="ttXls">⬇ Excel</button>`}`;
    } else if (isFaculty) {
      // faculty only ever see their own department, subjects and classes
      const f = Store.find('faculty', user.refId) || {};
      const subjects = [...new Set(myCourses.map(c => c.code))];
      const klasses = [...new Set(myCourses.map(c => `${c.branch} S${c.semester}-${c.section || 'A'}`))];
      html += `${f.department ? `<span class="pill green">🏛 ${esc(f.department)}</span>` : ''}
        <span class="pill blue">📚 ${subjects.length ? esc(subjects.join(', ')) : 'No subjects'}</span>
        <span class="pill amber">🎓 ${klasses.length ? esc(klasses.join(' · ')) : 'No classes'}</span>`;
    } else {
      html += `<span class="pill blue">${esc(branch)} · Sem ${semester} · Sec ${section}</span>`;
    }
    html += `</div></div><div id="ttArea" class="tt-grid"></div></div>`;

    viewTimetable.after = () => {
      // the slots currently on screen — also what Print/Excel export
      const currentSlots = () => {
        if (isFaculty) {
          const mine = teacherCourses().map(c => c.id);
          return Store.all('timetable').filter(t => mine.includes(t.courseId));
        }
        if (!canPickClass) {
          return Store.all('timetable').filter(t =>
            t.branch === branch && t.semester === semester && t.section === section);
        }
        const b = $('#ttBranch').value;
        const sem = +$('#ttSem').value;
        const sec = $('#ttSec').value;
        const mode = $('#ttView') ? $('#ttView').value : 'class';
        const all = Store.all('timetable');
        // the center head can widen the same grid from one class to a whole
        // section, room block or department without changing a single record
        if (mode === 'faculty') {
          const ids = Store.all('courses').filter(c => c.branch === b).map(c => c.id);
          return all.filter(t => ids.includes(t.courseId));
        }
        if (mode === 'room') return all.filter(t => t.branch === b && t.section === sec);
        if (mode === 'dept') return all.filter(t => t.branch === b);
        return all.filter(t => t.branch === b && t.semester === sem && t.section === sec);
      };
      const draw = () => {
        const slots = currentSlots();
        const rows = timeRows();
        const grid = buildTimetableGrid(slots, rows);

        $('#ttArea').innerHTML = `<table class="tt-table">
          <thead><tr><th>Time</th>${DAYS.map(d => `<th>${DAY_FULL[d] || d}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r, i) => `<tr><th class="tt-time">${r.label}</th>${DAYS.map(d => {
            const day = grid[d];
            const cell = day.start[i];
            if (cell) return `<td class="tt-busy" rowspan="${cell.span}">${cell.list.map(t => ttCard(t, isAdmin)).join('')}</td>`;
            if (day.covered.has(i)) return '';
            return `<td></td>`;
          }).join('')}</tr>`).join('')}</tbody></table>`;

        if (!slots.length)
          $('#ttArea').insertAdjacentHTML('beforeend',
            `<p class="empty">${isFaculty ? 'No periods scheduled for your classes yet.'
              : 'No periods scheduled for this selection.'}</p>`);
        if (isAdmin) $('#ttArea').querySelectorAll('[data-del]').forEach(btn =>
          btn.onclick = () => {
            const t = Store.find('timetable', btn.dataset.del) || {};
            const c = t.courseId ? Store.find('courses', t.courseId) : null;
            confirmDelete('Delete Period',
              `Remove the <b>${esc(DAY_FULL[t.day] || t.day || '—')}</b> period at
               <b>${esc(slotTimeLabel(t))}</b>${c ? ` — ${esc(c.code || '')} ${esc(c.name || '')}` : ''}
               from the timetable?`,
              'Delete Period', () => {
                Store.remove('timetable', btn.dataset.del);
                toast('Period removed.', 'err');
                draw();
              });
          });
      };
      if (canPickClass) {
        $('#ttBranch').onchange = draw; $('#ttSem').onchange = draw; $('#ttSec').oninput = draw;
        if (isAdmin) $('#addSlot').onclick = () => slotForm(draw);
        else {
          $('#ttView').onchange = draw;
          const report = () => timetableReport(currentSlots());
          $('#ttPrint').onclick = () => printReport(report());
          $('#ttXls').onclick = () => downloadXlsx(report());
        }
      }
      draw();
    };
    return html;
  }

  /* the timetable as a flat, exportable list of periods */
  function timetableReport(slots) {
    const rows = slots.slice().sort((a, b) =>
      DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || slotTimes(a)[0] - slotTimes(b)[0])
      .map(t => {
        const c = Store.find('courses', t.courseId) || {};
        return {
          day: DAY_FULL[t.day] || t.day, time: slotTimeLabel(t),
          code: c.code || '—', subject: c.name || '—',
          branch: t.branch || '—', semester: t.semester || '—', section: t.section || 'A',
          faculty: facultyName(c.facultyId), room: t.room || '—',
        };
      });
    return {
      title: 'Timetable Report', sheetName: 'Timetable', subtitle: reportStamp(),
      columns: [
        { header: 'Day', key: 'day', width: 12 },
        { header: 'Time', key: 'time', width: 20 },
        { header: 'Code', key: 'code', width: 12 },
        { header: 'Subject', key: 'subject', width: 32 },
        { header: 'Course', key: 'branch', width: 10 },
        { header: 'Semester', key: 'semester', width: 10, type: 'number' },
        { header: 'Section', key: 'section', width: 9 },
        { header: 'Faculty', key: 'faculty', width: 24 },
        { header: 'Room', key: 'room', width: 10 },
      ],
      rows,
      totals: { day: 'TOTAL', time: rows.length + ' periods' },
    };
  }
  function slotForm(after, opts) {
    opts = opts || {};
    const draft = opts.draft || {};
    const selBranch = draft.branch || 'MBA';
    const selDay = draft.day || DAYS[0];
    const selStart = draft.startTime || '08:30';
    const selEnd = draft.endTime || '09:30';
    const selCourse = opts.presetCourse || draft.courseId || '';
    openModal('Add Timetable Slot', `<form id="f"><div class="form-grid">
      <div class="field"><label>Course</label><select name="branch" id="slotBranch">${branchOptions(selBranch, true)}</select></div>
      <div class="field"><label>Semester</label><input name="semester" type="number" min="1" max="4" value="${draft.semester||2}"></div>
      <div class="field"><label>Section</label><input name="section" value="${esc(draft.section||'A')}"></div>
      <div class="field"><label>Day</label><select name="day" id="slotDay">${DAYS.map(d=>`<option ${d===selDay?'selected':''}>${d}</option>`).join('')}${listExtraOpts()}</select></div>
      <div class="field"><label>Start Time</label><select name="startTime">${timeOptions(selStart)}</select></div>
      <div class="field"><label>End Time</label><select name="endTime">${timeOptions(selEnd)}</select></div>
      <div class="field"><label>Room No.</label><input name="room" value="${esc(draft.room||'')}" placeholder="e.g. 403"></div>
      <div class="field"><label>Course</label><select name="courseId" id="slotCourse" required><option value="">Select course...</option>${Store.all('courses').map(c=>`<option value="${c.id}" ${c.id===selCourse?'selected':''}>${esc(c.code)} — ${esc(c.name)}</option>`).join('')}${addNewOpt('Add New Course...')}</select></div>
    </div><div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
      <button type="submit" class="btn-primary">Add</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindBranchSelect($('#slotBranch'));
    bindListAddNew($('#slotDay'), DAYS, 'New day (e.g. Sun):', (v) => DAYS.map(d=>`<option ${d===v?'selected':''}>${d}</option>`).join('') + listExtraOpts());
    bindEntityAddNew($('#slotCourse'), () => {
      const d = formData($('#f')); delete d.courseId;
      closeModal();
      courseForm(null, { after: (newCourseId) => {
        slotForm(after, { draft: d, presetCourse: newCourseId });
      }});
    });
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      d.semester = +d.semester;
      d.section = (d.section || 'A').toUpperCase();
      if (toMin(d.endTime) <= toMin(d.startTime)) { toast('End time must be after the start time.', 'err'); return; }
      Store.add('timetable', d); closeModal(); toast('Slot added.'); after();
    };
  }

  // ---- FEES (admin) ----
  function viewFees() {
    let html = `<div class="panel"><div class="panel-head"><h3>Fee Records</h3>
      <div class="panel-tools">
        <label class="switch-label" title="Turn off to hide the My Fees page from every student">
          <input type="checkbox" id="feeVisToggle" ${studentFeesVisible() ? 'checked' : ''}>
          <span>Show fees to students</span>
        </label>
        <input class="search-box" id="feeSearch" placeholder="Search student..."></div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Reg No</th><th>Student</th><th>Total</th><th>Paid</th><th>Due</th><th>Status</th><th>Due Date</th><th>Action</th>
      </tr></thead><tbody id="feeBody"></tbody></table></div><div id="feePager"></div></div>`;
    viewFees.after = () => {
      let page = 1;
      const draw = () => {
        const q = ($('#feeSearch').value||'').toLowerCase();
        const rows = Store.all('fees').filter(f => {
          const s = Store.find('students', f.studentId);
          return s && (!q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q));
        });
        page = Math.min(page, pageCount(rows.length));
        const pageRows = pageSlice(rows, page);
        $('#feeBody').innerHTML = pageRows.length ? pageRows.map(f => {
          const s = Store.find('students', f.studentId) || {};
          const due = Math.max(0, f.total - f.paid);
          const st = due===0 ? ['green','Paid'] : f.paid===0 ? ['red','Unpaid'] : ['amber','Partial'];
          return `<tr><td>${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${money(f.total)}</td>
            <td>${money(f.paid)}</td><td>${money(due)}</td><td><span class="pill ${st[0]}">${st[1]}</span></td>
            <td>${esc(f.dueDate)}</td>
            <td><button class="btn-sm btn-edit" data-pay="${f.id}">Record Payment</button></td></tr>`;
        }).join('') : `<tr><td colspan="8" class="empty">No fee records.</td></tr>`;
        $('#feeBody').querySelectorAll('[data-pay]').forEach(b => b.onclick = () => payForm(b.dataset.pay, draw));
        $('#feePager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#feePager'), rows.length, page, (p) => page = p, draw);
      };
      $('#feeSearch').oninput = () => { page = 1; draw(); };
      $('#feeVisToggle').onchange = (e) => {
        setSetting(SET_STUDENT_FEES, e.target.checked);
        toast(e.target.checked ? 'Students can now see their fees.' : 'Fees are now hidden from students.');
      };
      draw();
    };
    return html;
  }
  function payForm(id, after) {
    const f = Store.find('fees', id); const s = Store.find('students', f.studentId)||{};
    const due = Math.max(0, f.total - f.paid);
    openModal('Record Payment', `<form id="f">
      <p style="margin-bottom:14px;color:var(--muted)">${esc(s.name)} (${esc(s.roll)}) · Due: <strong>${money(due)}</strong></p>
      <div class="field full"><label>Payment Amount (₹)</label><input name="amt" type="number" min="1" max="${due}" value="${due}" required></div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Confirm Payment</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const amt = +formData(e.target).amt;
      Store.update('fees', id, { paid: Math.min(f.total, f.paid + amt) });
      closeModal(); toast('Payment of '+money(amt)+' recorded.'); after();
    };
  }

  /* ---------- STUDENT self-service views ---------- */
  function viewMyAttendance() {
    const sid = user.refId;
    const sessions = Store.all('attendance').filter(a => sid in a.records)
      .sort((a,b) => b.date.localeCompare(a.date));
    const pct = studentAttendancePct(sid);
    let html = `<div class="panel"><div class="panel-head"><h3>Overall Attendance</h3></div>
      <p style="font-size:15px">Total: <strong>${attBar(pct)}</strong> across ${sessions.length} sessions.</p>
      ${pct!==null && pct<75 ? `<p style="color:var(--red);margin-top:8px">⚠ Below 75% — please attend classes regularly.</p>`:''}</div>`;
    html += `<div class="panel"><div class="panel-head"><h3>Session History</h3></div><div class="tbl-wrap"><table>
      <thead><tr><th>Date</th><th>Course</th><th>Status</th></tr></thead><tbody>
      ${sessions.length? sessions.map(a => `<tr><td>${esc(a.date)}</td><td>${esc(courseName(a.courseId))}</td>
        <td><span class="pill ${a.records[sid]==='P'?'green':'red'}">${a.records[sid]==='P'?'Present':'Absent'}</span></td></tr>`).join('')
        : `<tr><td colspan="3" class="empty">No records.</td></tr>`}</tbody></table></div></div>`;
    return html;
  }

  function viewMyResults() {
    const sid = user.refId;
    const ms = Store.all('marks').filter(m => m.studentId === sid);
    const gpa = studentGPA(sid);
    let html = `<div class="panel"><div class="report-head">
      <div><h3 style="color:var(--primary-dark)">Academic Report Card</h3>
      <p style="color:var(--muted);font-size:14px">${esc(studentName(sid))} · ${esc((Store.find('students',sid)||{}).roll||'')}</p></div>
      <div class="gpa-box"><div class="v">${gpa ?? '—'}</div><div class="l">GPA</div></div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Code</th><th>Course</th><th>Credits</th><th>Internal /${INTERNAL_MAX}</th><th>Percentage</th><th>Grade</th>
      </tr></thead><tbody>${ms.length? ms.map(m => {
        const c = Store.find('courses', m.courseId)||{};
        const pct = markPercent(m); const g = gradeFor(pct || 0);
        return `<tr><td>${esc(c.code||'')}</td><td>${esc(c.name||'')}</td><td>${c.credits||'—'}</td>
          <td>${m.internal??'—'}</td><td>${pct === null ? '—' : pct + '%'}</td>
          <td><span class="pill ${g.p?'blue':'red'}">${pct === null ? '—' : g.g}</span></td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">No results published yet.</td></tr>`}</tbody></table></div>
      ${ms.length ? `<div class="form-actions" style="justify-content:flex-start"><button class="btn-primary" id="dlSheet">📄 Download Marksheet (PDF)</button></div>` : ''}</div>`;
    viewMyResults.after = () => { const b = $('#dlSheet'); if (b) b.onclick = () => printMarksheet(sid); };
    return html;
  }

  function viewMyFees() {
    if (!studentFeesVisible())
      return `<div class="panel"><p class="empty">Fee details are currently not available. Please contact the accounts office.</p></div>`;
    const sid = user.refId;
    // a student can have one fee record per semester — show every one, and the total
    const rows = Store.all('fees').filter(x => x.studentId === sid)
      .sort((a, b) => (+a.semester || 0) - (+b.semester || 0));
    if (!rows.length) return `<div class="panel"><p class="empty">No fee record found.</p></div>`;
    const total = rows.reduce((a, f) => a + (+f.total || 0), 0);
    const paid = rows.reduce((a, f) => a + Math.min(+f.total || 0, +f.paid || 0), 0);
    const due = Math.max(0, total - paid);
    const st = due === 0 ? ['green','Fully Paid'] : paid === 0 ? ['red','Unpaid'] : ['amber','Partially Paid'];
    const nextDue = rows.filter(f => (+f.total || 0) > (+f.paid || 0))
      .map(f => f.dueDate).filter(Boolean).sort()[0] || '—';
    return `<div class="stat-grid">
      ${statCard('💰', money(total), 'Total Fees')}
      ${statCard('✅', money(paid), 'Paid', 'c3')}
      ${statCard('⏳', money(due), 'Balance Due', due>0?'c4':'c3')}
    </div>
    <div class="panel"><div class="panel-head"><h3>Fee Details</h3></div>
      <p>Status: <span class="pill ${st[0]}">${st[1]}</span></p>
      <p style="margin-top:10px">Next due date: <strong>${esc(nextDue)}</strong></p>
      <div class="tbl-wrap" style="margin-top:16px"><table><thead><tr>
        <th>Semester</th><th>Academic Year</th><th style="text-align:right">Total</th>
        <th style="text-align:right">Paid</th><th style="text-align:right">Balance</th><th>Due Date</th><th>Status</th>
      </tr></thead><tbody>${rows.map(f => {
        const bal = Math.max(0, (+f.total || 0) - (+f.paid || 0));
        const s2 = bal === 0 ? ['green','Paid'] : (+f.paid || 0) === 0 ? ['red','Unpaid'] : ['amber','Partial'];
        return `<tr><td>${esc(f.semester || '—')}</td><td>${esc(f.academicYear || '—')}</td>
          <td style="text-align:right">${money(f.total)}</td><td style="text-align:right">${money(f.paid)}</td>
          <td style="text-align:right">${money(bal)}</td><td>${esc(f.dueDate || '—')}</td>
          <td><span class="pill ${s2[0]}">${s2[1]}</span></td></tr>`;
      }).join('')}</tbody></table></div>
      ${due>0?`<p style="margin-top:12px;color:var(--muted)">Please use the accounts office or the payment portal to pay.</p>`:''}</div>`;
  }

  function viewProfile() {
    viewProfile.after = null;
    /* One page for one record: the student reads their own file in the same
       layout the office uses, rather than a short summary that quietly leaves
       out half of what was recorded at admission. */
    if (user.role === 'student') {
      const html = viewStudentProfile();
      viewProfile.after = viewStudentProfile.after;
      return html;
    }
    if (user.role === 'faculty') {
      const f = Store.find('faculty', user.refId)||{};
      const mine = Store.all('courses').filter(c => c.facultyId === f.id);
      viewProfile.after = () => {
        const b = $('#printFacId'); if (b) b.onclick = () => printFacultyIdCard(f.id);
        const e = $('#editAcademic'); if (e) e.onclick = () => academicForm(f.id);
      };
      return profileCard([['Employee ID',f.empId],['Name',f.name],['Department',f.department],
        ['Designation',f.designation],['Email',f.email],['Phone',f.phone],
        ['Qualification',f.qualification],['Areas of Expertise',f.expertise],['Publications',f.publications],
        ['Courses Teaching', mine.map(c=>c.code).join(', ')||'—']],
        `<button class="btn-primary" id="printFacId">🪪 Print ID Card</button>
         <button class="btn-outline" id="editAcademic">✏️ Edit Academic Details</button>`, f.photo);
    }
    /* Nobody edits their own staff record from here — an employee id, a
       designation or a department is the admin's to set, the way the centre
       head's record already worked. Changing your own password stays. */
    if (user.role === 'accountant') {
      const a = Store.find('accountants', user.refId) || {};
      viewProfile.after = () => {
        $('#changePw').onclick = () => changePasswordForm();
        $('#profLogout').onclick = logout;
      };
      return profileCard([['Employee ID',a.empId],['Name',a.name],['Designation',a.designation],
        ['Email',a.email],['Phone',a.phone],['User ID',user.username]],
        `<button class="btn-outline" id="changePw">🔒 Change Password</button>
         <button class="btn-outline" id="profLogout">⎋ Logout</button>`, a.photo);
    }
    if (user.role === 'admission') {
      const a = Store.find('admissions', user.refId) || {};
      viewProfile.after = () => {
        $('#changePw').onclick = () => changePasswordForm();
        $('#profLogout').onclick = logout;
      };
      return profileCard([['Employee ID',a.empId],['Name',a.name],
        ['Designation',a.designation||'Admission Officer'],['Email',a.email],['Phone',a.phone],
        ['User ID',user.username],
        ['Access','Add and edit student records · view courses and the scheme']],
        `<button class="btn-outline" id="changePw">🔒 Change Password</button>
         <button class="btn-outline" id="profLogout">⎋ Logout</button>`, a.photo);
    }
    if (user.role === 'center_head') {
      const c = Store.find('centerheads', user.refId) || {};
      viewProfile.after = () => { $('#profLogout').onclick = logout; };
      // no "edit profile" and no "change password": the role writes nothing at
      // all, so the admin maintains this record and this login from the
      // Login Accounts page. Keeping the rule absolute keeps it enforceable.
      return profileCard([['Employee ID',c.empId],['Name',c.name],['Designation',c.designation||'Center Head'],
        ['Email',c.email],['Phone',c.phone],['User ID',user.username],
        ['Access Level','View · Search · Filter · Reports · Print · Export'],
        ['Restrictions','No create, edit, delete, approve, settings or role changes']],
        `<button class="btn-outline" id="profLogout">⎋ Logout</button>`, c.photo);
    }
    if (user.role === 'placement_officer') {
      const p = Store.find('placementofficers', user.refId) || {};
      const st = placementStats();
      viewProfile.after = () => { $('#profLogout').onclick = logout; };
      return profileCard([['Employee ID',p.empId],['Name',p.name],['Designation',p.designation||'Placement Officer'],
        ['Department',p.department||'Training & Placement Cell'],['Email',p.email],['Phone',p.phone],
        ['User ID',user.username],
        ['Modules','Companies · Drives · Applications · Interviews · Selections · Offers · Calendar · Reports'],
        ['This session',`${st.companies} companies · ${st.drives} drives · ${st.placed} students placed`]],
        `<button class="btn-outline" id="profLogout">⎋ Logout</button>`, p.photo);
    }
    return profileCard([['Username',user.username],['Role',roleLabel(user.role)]]);
  }

  /* There were two of these. This one checked the typed password against a
     copy the browser was holding — which no longer exists, and could never have
     checked a hash anyway. The other asks the server, which is the only thing
     that can. */
  function changePasswordForm() { return changePasswordModal(); }
  // faculty can maintain their own academic details without going through the admin
  function academicForm(id) {
    const f = Store.find('faculty', id) || {};
    openModal('Edit Academic Details', `<form id="f"><div class="form-grid">
      <div class="field full"><label>Qualification</label><input name="qualification" placeholder="e.g. Ph.D. (Computer Science)" value="${esc(f.qualification||'')}"></div>
      <div class="field full"><label>Areas of Expertise</label><input name="expertise" placeholder="e.g. Algorithms, Machine Learning" value="${esc(f.expertise||'')}"></div>
      <div class="field full"><label>Publications</label><textarea name="publications" rows="4" placeholder="Papers, books, patents...">${esc(f.publications||'')}</textarea></div>
    </div><div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
      <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      Store.update('faculty', id, formData(e.target));
      closeModal(); toast('Academic details saved.'); render();
    };
  }

  function profileCard(rows, actions, photo) {
    return `<div class="panel" style="max-width:560px">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        <div class="logo-circle">${photo ?
          `<img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((user.name||'U')[0])}</div>
        <div><h3 style="color:var(--primary-dark)">${esc(user.name)}</h3>
        <span class="role-badge">${esc(user.role)}</span></div></div>
      <table><tbody>${rows.map(([k,v]) => `<tr><td style="font-weight:600;width:180px">${esc(k)}</td>
        <td style="white-space:pre-line">${esc((v ?? '') === '' ? '—' : v)}</td></tr>`).join('')}</tbody></table>
      ${actions ? `<div class="form-actions" style="justify-content:flex-start">${actions}</div>` : ''}</div>`;
  }

  /* ========================================================= */
  /*  EVENTS                                                    */
  /* ========================================================= */
  function viewEvents() {
    const canEdit = user.role === 'admin';
    const html = `<div class="panel"><div class="panel-head"><h3>College Events</h3>
      ${canEdit ? `<button class="btn-primary" id="addEvent">+ Add Event</button>` : ''}</div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Date</th><th>Title</th><th>Description</th>${canEdit ? '<th>Actions</th>' : ''}
      </tr></thead><tbody id="evBody"></tbody></table></div><div id="evPager"></div></div>`;
    let page = 1;
    viewEvents.after = () => {
      const draw = () => {
        const events = [...Store.all('events')].sort((a, b) => (a.date||'').localeCompare(b.date||''));
        page = Math.min(page, pageCount(events.length));
        const pageRows = pageSlice(events, page);
        $('#evBody').innerHTML = pageRows.length ? pageRows.map(ev => `<tr>
          <td>${esc(ev.date)}</td><td>${esc(ev.title)}</td><td>${esc(ev.description||'')}</td>
          ${canEdit ? `<td><div class="row-actions">
            <button class="btn-sm btn-edit" data-edit="${ev.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${ev.id}">Delete</button></div></td>` : ''}
        </tr>`).join('') : `<tr><td colspan="${canEdit?4:3}" class="empty">No events scheduled.</td></tr>`;
        if (canEdit) {
          $('#evBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => eventForm(b.dataset.edit));
          $('#evBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => delConfirm('events', b.dataset.del, 'event', draw));
        }
        $('#evPager').innerHTML = pagerHtml(events.length, page);
        bindPager($('#evPager'), events.length, page, (p) => page = p, draw);
      };
      if (canEdit) $('#addEvent').onclick = () => eventForm(null);
      draw();
    };
    return html;
  }
  function eventForm(id) {
    const ev = id ? Store.find('events', id) : {};
    // new events must be today or later; an old event keeps its own date so it
    // can still be edited (title/description) without being forced forward
    const minDate = (id && ev.date && ev.date < today()) ? ev.date : today();
    openModal((id?'Edit':'Add')+' Event', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Title</label><input name="title" value="${esc(ev.title||'')}" required></div>
        <div class="field"><label>Date</label>
          <input name="date" type="date" value="${esc(ev.date||today())}" min="${minDate}" required>
          <small style="color:var(--muted);font-size:11.5px">Cannot be earlier than today</small></div>
        <div class="field full"><label>Description</label><textarea name="description" rows="3">${esc(ev.description||'')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      // the date picker's min can be bypassed by typing, so re-check on save
      if (d.date < minDate) { toast('Event date cannot be in the past.', 'err'); return; }
      if (id) Store.update('events', id, d);
      else Store.add('events', Object.assign({}, d, { createdBy: user.id }));
      closeModal(); toast('Event saved.'); render();
    };
  }

  /* ========================================================= */
  /*  LIBRARY                                                   */
  /* ========================================================= */
  // catalogue-only for librarians (they have dedicated Issue/Return pages);
  // admin keeps the combined catalogue + issue + currently-issued view
  function viewLibrary() {
    const full = user.role === 'admin';
    const canEdit = !readOnly();
    let html = full ? libraryAccountsPanel() : '';
    if (readOnly()) {
      const lib = libraryTotals();
      html += readOnlyBanner('The library is run by the librarian. This is a monitoring view.') +
        `<div class="stat-grid">
          ${statCard('📚', lib.copies, `Total Books (${lib.titles} titles)`)}
          ${statCard('🔖', lib.issued, 'Issued Books', 'c2')}
          ${statCard('🔁', lib.returned, 'Returned Books', 'c3')}
          ${statCard('⚠️', lib.overdue, 'Overdue Books', lib.overdue ? 'c4' : 'c3')}
          ${statCard('📗', lib.available, 'Available Now', 'c3')}
          ${statCard('🧾', lib.transactions, 'Library Activity', 'c2')}
        </div>`;
    }
    html += `<div class="panel"><div class="panel-head"><h3>Books Catalogue</h3>
      <div class="panel-tools">
        <input class="search-box" id="bkSearch" placeholder="Search title / author / category...">
        ${canEdit ? `<button class="btn-primary" id="addBook">+ Add Book</button>` : `
          <button class="btn-outline btn-sm" id="bkPrint">🖨 Print</button>
          <button class="btn-primary btn-sm" id="bkXls">⬇ Excel</button>`}</div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ISBN</th><th>Title</th><th>Author</th><th>Category</th><th>Total</th><th>Available</th>
        ${canEdit ? '<th>Actions</th>' : '<th style="text-align:right">On Loan</th>'}
      </tr></thead><tbody id="bkBody"></tbody></table></div><div id="bkPager"></div></div>`;
    if (readOnly()) {
      html += `<div class="panel"><div class="panel-head"><h3>Issued &amp; Overdue Books</h3>
        <div class="panel-tools">
          <select class="filter-sel" id="bkStatus">
            <option value="">All statuses</option><option value="Issued">Issued</option>
            <option value="Overdue">Overdue</option><option value="Returned">Returned</option>
            <option value="Returned Late">Returned late</option></select>
        </div></div>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Book</th><th>Student</th><th>Specialisation / Sem</th><th>Issued On</th><th>Due Date</th>
          <th>Returned On</th><th>Late Days</th><th>Status</th>
        </tr></thead><tbody id="bkTxnBody"></tbody></table></div><div id="bkTxnPager"></div></div>`;
    }

    if (full) {
      html += `<div class="panel"><div class="panel-head"><h3>Issue a Book</h3></div>
        <div class="panel-tools">
          <select class="filter-sel" id="issBook" style="min-width:240px"><option value="">Select book...</option></select>
          <select class="filter-sel" id="issStudent" style="min-width:220px"><option value="">Select student...</option>
            ${Store.all('students').map(s => `<option value="${s.id}">${esc(s.roll)} — ${esc(s.name)}</option>`).join('')}</select>
          <label class="days-field">Loan days
            <input class="filter-sel" id="issDays" type="number" min="1" max="180" value="${DEFAULT_LOAN_DAYS}"></label>
          <button class="btn-primary" id="doIssue">Issue</button>
        </div></div>`;

      html += `<div class="panel"><div class="panel-head"><h3>Currently Issued</h3></div>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Book</th><th>Student</th><th>Issued On</th><th>Due Date</th><th>Status</th><th>Action</th>
        </tr></thead><tbody id="issBody"></tbody></table></div><div id="issPager"></div></div>`;
    }

    let bkPage = 1, issPage = 1, txnPage = 1;
    viewLibrary.after = () => {
      const filteredBooks = () => {
        const q = ($('#bkSearch').value||'').toLowerCase();
        return Store.all('books').filter(b =>
          !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) || (b.category||'').toLowerCase().includes(q));
      };
      const drawBooks = () => {
        const rows = filteredBooks();
        bkPage = Math.min(bkPage, pageCount(rows.length));
        const pageRows = pageSlice(rows, bkPage);
        $('#bkBody').innerHTML = pageRows.length ? pageRows.map(b => `<tr>
          <td>${esc(b.isbn)}</td><td>${esc(b.title)}</td><td>${esc(b.author)}</td><td>${esc(b.category)}</td>
          <td>${b.total}</td><td><span class="pill ${b.available>0?'green':'red'}">${b.available}</span></td>
          ${canEdit ? `<td><div class="row-actions">
            <button class="btn-sm btn-edit" data-edit="${b.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${b.id}">Delete</button></div></td>`
            : `<td style="text-align:right">${Math.max(0, (+b.total || 0) - (+b.available || 0))}</td>`}</tr>`).join('')
          : `<tr><td colspan="7" class="empty">No books found.</td></tr>`;
        if (canEdit) {
          $('#bkBody').querySelectorAll('[data-edit]').forEach(x => x.onclick = () => bookForm(x.dataset.edit, refresh));
          $('#bkBody').querySelectorAll('[data-del]').forEach(x => x.onclick = () => delConfirm('books', x.dataset.del, 'book', refresh));
        }
        $('#bkPager').innerHTML = pagerHtml(rows.length, bkPage);
        bindPager($('#bkPager'), rows.length, bkPage, (p) => bkPage = p, drawBooks);
      };
      // the read-only loan ledger shown to a monitoring role
      const drawTxns = () => {
        if (!$('#bkTxnBody')) return;
        const st = $('#bkStatus').value;
        const rows = libraryTransactions().filter(t => !st || t.status === st);
        txnPage = Math.min(txnPage, pageCount(rows.length));
        $('#bkTxnBody').innerHTML = rows.length ? pageSlice(rows, txnPage).map(t => `<tr>
          <td>${esc(t.title)}</td><td>${esc(t.student)} <small style="color:var(--muted)">${esc(t.roll)}</small></td>
          <td>${esc(t.branch || '—')} / ${esc(String(t.semester || '—'))}</td>
          <td>${esc(t.issueDate || '—')}</td><td>${esc(t.dueDate || '—')}</td>
          <td>${esc(t.returnDate || '—')}</td>
          <td${t.lateDays ? ' style="color:var(--red);font-weight:600"' : ''}>${t.lateDays || '—'}</td>
          <td><span class="pill ${STATUS_TONE[t.status] || 'blue'}">${esc(t.status)}</span></td></tr>`).join('')
          : `<tr><td colspan="8" class="empty">No library transactions for this filter.</td></tr>`;
        $('#bkTxnPager').innerHTML = pagerHtml(rows.length, txnPage);
        bindPager($('#bkTxnPager'), rows.length, txnPage, (p) => txnPage = p, drawTxns);
      };
      const drawIssueOptions = () => {
        if (!$('#issBook')) return;
        $('#issBook').innerHTML = `<option value="">Select book...</option>` +
          Store.all('books').filter(b => b.available > 0)
            .map(b => `<option value="${b.id}">${esc(b.title)} (${b.available} left)</option>`).join('');
      };
      const drawIssued = () => {
        if (!$('#issBody')) return;
        const active = Store.all('issues').filter(i => !i.returnDate);
        issPage = Math.min(issPage, pageCount(active.length));
        const pageRows = pageSlice(active, issPage);
        $('#issBody').innerHTML = pageRows.length ? pageRows.map(i => {
          const b = Store.find('books', i.bookId)||{}; const s = Store.find('students', i.studentId)||{};
          const overdue = i.dueDate < today();
          return `<tr><td>${esc(b.title||'?')}</td><td>${esc(s.name||'?')} (${esc(s.roll||'')})</td>
            <td>${esc(i.issueDate)}</td><td>${esc(i.dueDate)}</td>
            <td><span class="pill ${overdue?'red':'green'}">${overdue?'Overdue':'Issued'}</span></td>
            <td><button class="btn-sm btn-edit" data-ret="${i.id}">Return</button></td></tr>`;
        }).join('') : `<tr><td colspan="6" class="empty">No books currently issued.</td></tr>`;
        $('#issBody').querySelectorAll('[data-ret]').forEach(x => x.onclick = () => { returnBook(x.dataset.ret); refresh(); });
        $('#issPager').innerHTML = pagerHtml(active.length, issPage);
        bindPager($('#issPager'), active.length, issPage, (p) => issPage = p, drawIssued);
      };
      const refresh = () => { drawBooks(); drawIssueOptions(); drawIssued(); drawTxns(); };

      $('#bkSearch').oninput = () => { bkPage = 1; drawBooks(); };
      if (canEdit) $('#addBook').onclick = () => bookForm(null, refresh);
      else {
        $('#bkStatus').onchange = () => { txnPage = 1; drawTxns(); };
        const report = () => bookCatalogueReport(filteredBooks());
        $('#bkPrint').onclick = () => printReport(report());
        $('#bkXls').onclick = () => downloadXlsx(report());
      }
      if (full) {
        $('#doIssue').onclick = () => {
          const bookId = $('#issBook').value, studentId = $('#issStudent').value;
          if (!bookId || !studentId) { toast('Please select both a book and a student.','err'); return; }
          issueBook(bookId, studentId, $('#issDays').value); refresh();
        };
      }
      if (user.role === 'admin') {
        $('#addLibrarian').onclick = () => librarianForm();
        $('#libBody').querySelectorAll('[data-edit-lib]').forEach(x => x.onclick = () => librarianForm(x.dataset.editLib));
        $('#libBody').querySelectorAll('[data-del-lib]').forEach(x => x.onclick = () => delConfirm('users', x.dataset.delLib, 'librarian account'));
      }
      refresh();
    };
    return html;
  }

  /* the books catalogue as an exportable report */
  function bookCatalogueReport(books) {
    const txns = libraryTransactions();
    const rows = books.map(b => {
      const mine = txns.filter(t => t.bookId === b.id);
      return {
        isbn: b.isbn || '—', title: b.title || '—', author: b.author || '—',
        category: b.category || '—', total: +b.total || 0, available: +b.available || 0,
        onLoan: Math.max(0, (+b.total || 0) - (+b.available || 0)),
        issued: mine.length, returned: mine.filter(t => t.returned).length,
        overdue: mine.filter(t => t.overdue).length,
      };
    });
    return {
      title: 'Library Book Report', sheetName: 'Books', subtitle: reportStamp(),
      columns: [
        { header: 'ISBN', key: 'isbn', width: 16 }, { header: 'Title', key: 'title', width: 32 },
        { header: 'Author', key: 'author', width: 24 }, { header: 'Category', key: 'category', width: 18 },
        { header: 'Total Copies', key: 'total', width: 13, type: 'number' },
        { header: 'Available', key: 'available', width: 11, type: 'number' },
        { header: 'On Loan', key: 'onLoan', width: 11, type: 'number' },
        { header: 'Times Issued', key: 'issued', width: 13, type: 'number' },
        { header: 'Times Returned', key: 'returned', width: 15, type: 'number' },
        { header: 'Overdue Now', key: 'overdue', width: 13, type: 'number' },
      ],
      rows,
      totals: {
        isbn: 'TOTAL', title: rows.length + ' titles',
        total: rows.reduce((a, r) => a + r.total, 0),
        available: rows.reduce((a, r) => a + r.available, 0),
        onLoan: rows.reduce((a, r) => a + r.onLoan, 0),
      },
    };
  }

  // ---- ISSUE A BOOK (dedicated page for librarians) ----
  function viewIssueBook() {
    const html = `<div class="panel"><div class="panel-head"><h3>Issue a Book</h3></div>
      <div class="panel-tools">
        <select class="filter-sel" id="issBook2" style="min-width:240px"><option value="">Select book...</option></select>
        <select class="filter-sel" id="issStudent2" style="min-width:220px"><option value="">Select student...</option>
          ${Store.all('students').map(s => `<option value="${s.id}">${esc(s.roll)} — ${esc(s.name)}</option>`).join('')}</select>
        <label class="days-field">Loan days
          <input class="filter-sel" id="issDays2" type="number" min="1" max="180" value="${DEFAULT_LOAN_DAYS}"></label>
        <button class="btn-primary" id="doIssue2">Issue</button>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>Recently Issued</h3></div>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Book</th><th>Student</th><th>Issued On</th><th>Due Date</th><th>Status</th>
        </tr></thead><tbody id="recIssBody"></tbody></table></div><div id="recIssPager"></div></div>`;
    viewIssueBook.after = () => {
      let page = 1;
      const drawOptions = () => {
        $('#issBook2').innerHTML = `<option value="">Select book...</option>` +
          Store.all('books').filter(b => b.available > 0)
            .map(b => `<option value="${b.id}">${esc(b.title)} (${b.available} left)</option>`).join('');
      };
      const drawRecent = () => {
        const all = [...Store.all('issues')].sort((a,b) => (b.issueDate||'').localeCompare(a.issueDate||''));
        page = Math.min(page, pageCount(all.length));
        const pageRows = pageSlice(all, page);
        $('#recIssBody').innerHTML = pageRows.length ? pageRows.map(i => {
          const b = Store.find('books', i.bookId)||{}; const s = Store.find('students', i.studentId)||{};
          const overdue = !i.returnDate && i.dueDate < today();
          const status = i.returnDate ? 'Returned' : (overdue ? 'Overdue' : 'Issued');
          const cls = i.returnDate ? 'blue' : (overdue ? 'red' : 'green');
          return `<tr><td>${esc(b.title||'?')}</td><td>${esc(s.name||'?')}</td><td>${esc(i.issueDate)}</td>
            <td>${esc(i.dueDate)}</td><td><span class="pill ${cls}">${status}</span></td></tr>`;
        }).join('') : `<tr><td colspan="5" class="empty">No books issued yet.</td></tr>`;
        $('#recIssPager').innerHTML = pagerHtml(all.length, page);
        bindPager($('#recIssPager'), all.length, page, (p) => page = p, drawRecent);
      };
      $('#doIssue2').onclick = () => {
        const bookId = $('#issBook2').value, studentId = $('#issStudent2').value;
        if (!bookId || !studentId) { toast('Please select both a book and a student.','err'); return; }
        issueBook(bookId, studentId, $('#issDays2').value); drawOptions(); drawRecent();
      };
      drawOptions(); drawRecent();
    };
    return html;
  }

  // ---- RETURN A BOOK (dedicated page for librarians) ----
  function viewReturnBook() {
    const html = `<div class="panel"><div class="panel-head"><h3>Return a Book</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Book</th><th>Student</th><th>Issued On</th><th>Due Date</th><th>Status</th><th>Action</th>
      </tr></thead><tbody id="retBody"></tbody></table></div><div id="retPager"></div></div>`;
    viewReturnBook.after = () => {
      let page = 1;
      const draw = () => {
        const active = Store.all('issues').filter(i => !i.returnDate);
        page = Math.min(page, pageCount(active.length));
        const pageRows = pageSlice(active, page);
        $('#retBody').innerHTML = pageRows.length ? pageRows.map(i => {
          const b = Store.find('books', i.bookId)||{}; const s = Store.find('students', i.studentId)||{};
          const overdue = i.dueDate < today();
          return `<tr><td>${esc(b.title||'?')}</td><td>${esc(s.name||'?')} (${esc(s.roll||'')})</td>
            <td>${esc(i.issueDate)}</td><td>${esc(i.dueDate)}</td>
            <td><span class="pill ${overdue?'red':'green'}">${overdue?'Overdue':'Issued'}</span></td>
            <td><button class="btn-sm btn-edit" data-ret="${i.id}">Return</button></td></tr>`;
        }).join('') : `<tr><td colspan="6" class="empty">No books currently issued.</td></tr>`;
        $('#retBody').querySelectorAll('[data-ret]').forEach(x => x.onclick = () => { returnBook(x.dataset.ret); draw(); });
        $('#retPager').innerHTML = pagerHtml(active.length, page);
        bindPager($('#retPager'), active.length, page, (p) => page = p, draw);
      };
      draw();
    };
    return html;
  }

  // ---- LIBRARY REPORTS ----
  // number of days between two yyyy-mm-dd strings (b - a)
  function dayDiff(a, b) {
    if (!a || !b) return 0;
    return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  }

  // Every issue row, joined with its book + student, with derived status fields.
  // This single list feeds the on-screen tables *and* the Excel export.
  function libraryTransactions() {
    const td = today();
    return Store.all('issues').map(i => {
      const b = Store.find('books', i.bookId) || {};
      const s = Store.find('students', i.studentId) || {};
      const returned = !!i.returnDate;
      const overdue = !returned && i.dueDate && i.dueDate < td;
      const lateDays = returned
        ? Math.max(0, dayDiff(i.dueDate, i.returnDate))
        : Math.max(0, dayDiff(i.dueDate, td));
      return {
        id: i.id,
        bookId: i.bookId, studentId: i.studentId,
        title: b.title || '(deleted book)', author: b.author || '', isbn: b.isbn || '',
        category: b.category || 'Others',
        roll: s.roll || '', student: s.name || '(deleted student)',
        branch: specOf(s), year: s.year || '', semester: s.semester || '',
        section: s.section || '', phone: s.phone || '', email: s.email || '',
        issueDate: i.issueDate || '', dueDate: i.dueDate || '', returnDate: i.returnDate || '',
        daysKept: returned ? Math.max(0, dayDiff(i.issueDate, i.returnDate)) : Math.max(0, dayDiff(i.issueDate, td)),
        loanDays: Math.max(0, dayDiff(i.issueDate, i.dueDate)),
        returned, overdue, lateDays,
        status: returned ? (lateDays > 0 ? 'Returned Late' : 'Returned') : (overdue ? 'Overdue' : 'Issued'),
      };
    }).sort((a, b) => (b.issueDate || '').localeCompare(a.issueDate || '') || (b.id > a.id ? 1 : -1));
  }
  const STATUS_TONE = { 'Returned': 'blue', 'Returned Late': 'amber', 'Overdue': 'red', 'Issued': 'green' };

  function viewLibraryReports() {
    const books = Store.all('books');
    const all = libraryTransactions();
    const totalCopies = books.reduce((s,b) => s + (+b.total||0), 0);
    const availableBooks = books.reduce((s,b) => s + (+b.available||0), 0);
    const issuedNow = all.filter(t => !t.returned).length;
    const overdue = all.filter(t => t.overdue);
    const returnedTotal = all.filter(t => t.returned).length;

    let html = `<div class="stat-grid">
      ${statCard('📚', totalCopies, 'Total Copies')}
      ${statCard('📗', availableBooks, 'Available Now', 'c3')}
      ${statCard('🔖', issuedNow, 'Currently Issued', 'c2')}
      ${statCard('⚠️', overdue.length, 'Overdue', overdue.length ? 'c4' : 'c3')}
      ${statCard('🔁', returnedTotal, 'Returned (all time)', 'c3')}
      ${statCard('🧾', all.length, 'Total Transactions', 'c2')}
    </div>`;

    // ---- filter bar + full transaction ledger ----
    html += `<div class="panel"><div class="panel-head"><h3>Complete Library Records</h3>
      <div class="panel-tools">
        <button class="btn-primary" id="expExcel">⬇ Download Excel</button>
      </div></div>
      <div class="panel-tools">
        <input class="search-box" id="rpSearch" placeholder="Search student / roll / book / ISBN / author...">
        <select class="filter-sel" id="rpStatus">
          <option value="">All statuses</option>
          <option value="Issued">Issued (on loan)</option>
          <option value="Overdue">Overdue</option>
          <option value="Returned">Returned (on time)</option>
          <option value="Returned Late">Returned late</option>
          <option value="active">Not returned yet</option>
        </select>
        <select class="filter-sel" id="rpCat"><option value="">All categories</option>
          ${[...new Set(all.map(t => t.category))].sort().map(c => `<option>${esc(c)}</option>`).join('')}</select>
        <label class="days-field">From <input class="filter-sel" id="rpFrom" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="rpTo" type="date"></label>
        <button class="btn-outline btn-sm" id="rpClear">Clear</button>
      </div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>#</th><th>Roll No</th><th>Student</th><th>Specialisation / Sem</th><th>Book Title</th><th>Author</th>
        <th>ISBN</th><th>Category</th><th>Issued On</th><th>Due Date</th><th>Returned On</th>
        <th>Days Kept</th><th>Late Days</th><th>Status</th>
      </tr></thead><tbody id="rpBody"></tbody></table></div>
      <div id="rpPager"></div></div>`;

    // ---- student-wise summary ----
    html += `<div class="panel"><div class="panel-head"><h3>Student-wise Summary</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Roll No</th><th>Student</th><th>Specialisation</th><th>Total Borrowed</th><th>Returned</th>
        <th>On Loan</th><th>Overdue</th><th>Books Taken</th>
      </tr></thead><tbody id="rpStuBody"></tbody></table></div><div id="rpStuPager"></div></div>`;

    // ---- book-wise summary ----
    html += `<div class="panel"><div class="panel-head"><h3>Book-wise Summary</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Title</th><th>Author</th><th>ISBN</th><th>Category</th><th>Total</th><th>Available</th>
        <th>On Loan</th><th>Times Issued</th><th>Times Returned</th>
      </tr></thead><tbody id="rpBookBody"></tbody></table></div><div id="rpBookPager"></div></div>`;

    // ---- category + overdue (unchanged classics) ----
    const byCat = {};
    books.forEach(b => { const c = b.category || 'Others'; byCat[c] = (byCat[c]||0) + (+b.total||0); });
    html += `<div class="panel"><div class="panel-head"><h3>Books by Category</h3></div>
      <div class="tbl-wrap"><table><thead><tr><th>Category</th><th>Total Copies</th></tr></thead>
      <tbody>${Object.entries(byCat).sort((a,b) => b[1]-a[1]).map(([c,n]) => `<tr><td>${esc(c)}</td><td>${n}</td></tr>`).join('')
        || `<tr><td colspan="2" class="empty">No books yet.</td></tr>`}</tbody></table></div></div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Overdue Books</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Book</th><th>Student</th><th>Roll No</th><th>Phone</th><th>Issued On</th><th>Due Date</th><th>Days Overdue</th>
      </tr></thead><tbody>${overdue.length ? overdue.map(t =>
        `<tr><td>${esc(t.title)}</td><td>${esc(t.student)}</td><td>${esc(t.roll)}</td><td>${esc(t.phone)}</td>
         <td>${esc(t.issueDate)}</td><td>${esc(t.dueDate)}</td>
         <td style="color:var(--red);font-weight:600">${t.lateDays}</td></tr>`).join('')
        : `<tr><td colspan="7" class="empty">No overdue books. 🎉</td></tr>`}</tbody></table></div></div>`;

    viewLibraryReports.after = () => {
      let page = 1, stuPage = 1, bookPage = 1;

      const filtered = () => {
        const q = ($('#rpSearch').value || '').trim().toLowerCase();
        const st = $('#rpStatus').value, cat = $('#rpCat').value;
        const from = $('#rpFrom').value, to = $('#rpTo').value;
        return all.filter(t => {
          if (q && ![t.roll, t.student, t.title, t.author, t.isbn, t.category, t.branch]
            .some(v => String(v||'').toLowerCase().includes(q))) return false;
          if (st === 'active' ? t.returned : (st && t.status !== st)) return false;
          if (cat && t.category !== cat) return false;
          if (from && t.issueDate < from) return false;
          if (to && t.issueDate > to) return false;
          return true;
        });
      };

      const drawLedger = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const start = (page - 1) * PAGE_SIZE;
        $('#rpBody').innerHTML = rows.length ? pageSlice(rows, page).map((t, n) => `<tr>
          <td>${start + n + 1}</td><td>${esc(t.roll)}</td><td>${esc(t.student)}</td>
          <td>${esc(t.branch)}${t.semester ? ' / Sem ' + esc(t.semester) : ''}</td>
          <td>${esc(t.title)}</td><td>${esc(t.author)}</td><td>${esc(t.isbn)}</td><td>${esc(t.category)}</td>
          <td>${esc(t.issueDate)}</td><td>${esc(t.dueDate)}</td><td>${esc(t.returnDate || '—')}</td>
          <td>${t.daysKept}</td>
          <td${t.lateDays ? ' style="color:var(--red);font-weight:600"' : ''}>${t.lateDays || '—'}</td>
          <td><span class="pill ${{Overdue:'red', Issued:'green', 'Returned Late':'amber', Returned:'blue'}[t.status]}">${t.status}</span></td>
        </tr>`).join('') : `<tr><td colspan="14" class="empty">No records match these filters.</td></tr>`;
        $('#rpPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#rpPager'), rows.length, page, (p) => page = p, drawLedger);
      };

      const drawStudents = () => {
        const rows = studentSummary(all);
        stuPage = Math.min(stuPage, pageCount(rows.length));
        $('#rpStuBody').innerHTML = rows.length ? pageSlice(rows, stuPage).map(r => `<tr>
          <td>${esc(r.roll)}</td><td>${esc(r.student)}</td><td>${esc(r.branch)}</td>
          <td>${r.total}</td><td>${r.returned}</td>
          <td>${r.onLoan}</td><td${r.overdue ? ' style="color:var(--red);font-weight:600"' : ''}>${r.overdue}</td>
          <td style="max-width:320px">${esc(r.titles)}</td></tr>`).join('')
          : `<tr><td colspan="8" class="empty">No borrowing records yet.</td></tr>`;
        $('#rpStuPager').innerHTML = pagerHtml(rows.length, stuPage);
        bindPager($('#rpStuPager'), rows.length, stuPage, (p) => stuPage = p, drawStudents);
      };

      const drawBooks = () => {
        const rows = bookSummary(all);
        bookPage = Math.min(bookPage, pageCount(rows.length));
        $('#rpBookBody').innerHTML = rows.length ? pageSlice(rows, bookPage).map(r => `<tr>
          <td>${esc(r.title)}</td><td>${esc(r.author)}</td><td>${esc(r.isbn)}</td><td>${esc(r.category)}</td>
          <td>${r.total}</td><td><span class="pill ${r.available>0?'green':'red'}">${r.available}</span></td>
          <td>${r.onLoan}</td><td>${r.issued}</td><td>${r.returned}</td></tr>`).join('')
          : `<tr><td colspan="9" class="empty">No books yet.</td></tr>`;
        $('#rpBookPager').innerHTML = pagerHtml(rows.length, bookPage);
        bindPager($('#rpBookPager'), rows.length, bookPage, (p) => bookPage = p, drawBooks);
      };

      ['#rpSearch','#rpStatus','#rpCat','#rpFrom','#rpTo'].forEach(sel => {
        const el = $(sel);
        el[sel === '#rpSearch' ? 'oninput' : 'onchange'] = () => { page = 1; drawLedger(); };
      });
      $('#rpClear').onclick = () => {
        $('#rpSearch').value = ''; $('#rpStatus').value = ''; $('#rpCat').value = '';
        $('#rpFrom').value = ''; $('#rpTo').value = '';
        page = 1; drawLedger();
      };
      $('#expExcel').onclick = () => exportLibraryExcel(filtered(), all);

      drawLedger(); drawStudents(); drawBooks();
    };
    return html;
  }

  // roll-up of every transaction per student
  function studentSummary(txns) {
    const map = new Map();
    txns.forEach(t => {
      const key = t.studentId || t.roll || t.student;
      if (!map.has(key)) map.set(key, {
        roll: t.roll, student: t.student, branch: t.branch, semester: t.semester,
        phone: t.phone, email: t.email,
        total: 0, returned: 0, onLoan: 0, overdue: 0, lateDays: 0, _titles: [],
      });
      const r = map.get(key);
      r.total++;
      if (t.returned) r.returned++; else r.onLoan++;
      if (t.overdue) r.overdue++;
      r.lateDays += t.lateDays;
      r._titles.push(t.title + (t.returned ? '' : ' (on loan)'));
    });
    return [...map.values()]
      .map(r => ({ ...r, titles: r._titles.join(', ') }))
      .sort((a, b) => b.total - a.total || String(a.roll).localeCompare(String(b.roll)));
  }

  // roll-up per book — every catalogue book, plus its issue history
  function bookSummary(txns) {
    return Store.all('books').map(b => {
      const mine = txns.filter(t => t.bookId === b.id);
      return {
        title: b.title || '', author: b.author || '', isbn: b.isbn || '',
        category: b.category || 'Others',
        total: +b.total || 0, available: +b.available || 0,
        onLoan: mine.filter(t => !t.returned).length,
        issued: mine.length,
        returned: mine.filter(t => t.returned).length,
        overdue: mine.filter(t => t.overdue).length,
      };
    }).sort((a, b) => b.issued - a.issued || a.title.localeCompare(b.title));
  }

  // ---- EXCEL EXPORT (multi-sheet .xlsx) ----
  function exportLibraryExcel(rows, all) {
    if (!window.XLSXLite) { toast('Excel module failed to load.', 'err'); return; }
    const stamp = new Date().toLocaleString('en-IN');
    const sub = `NMIET B-SCHOOL · Library Management System · Generated on ${stamp}` +
      (rows.length !== all.length ? ` · Filtered view (${rows.length} of ${all.length} records)` : '');
    const books = Store.all('books');
    const tone = (t) => ({ v: t.status, tone: STATUS_TONE[t.status] });

    const txnCols = [
      { header:'#', key:'sn', width:6, type:'number' },
      { header:'Issue ID', key:'id', width:10, align:'center' },
      { header:'Roll No', key:'roll', width:14 },
      { header:'Student Name', key:'student', width:24 },
      { header:'Specialisation', key:'branch', width:14 },
      { header:'Year', key:'year', width:7, type:'number' },
      { header:'Sem', key:'semester', width:7, type:'number' },
      { header:'Section', key:'section', width:9, align:'center' },
      { header:'Phone', key:'phone', width:15, align:'center' },
      { header:'Email', key:'email', width:26 },
      { header:'Book Title', key:'title', width:34 },
      { header:'Author', key:'author', width:22 },
      { header:'ISBN', key:'isbn', width:18, align:'center' },
      { header:'Category', key:'category', width:16 },
      { header:'Issued On', key:'issueDate', width:13, type:'date' },
      { header:'Due Date', key:'dueDate', width:13, type:'date' },
      { header:'Returned On', key:'returnDate', width:13, type:'date' },
      { header:'Loan Days', key:'loanDays', width:11, type:'number' },
      { header:'Days Kept', key:'daysKept', width:11, type:'number' },
      { header:'Late Days', key:'lateDays', width:11, type:'number' },
      { header:'Status', key:'status', width:15 },
    ];

    const sheets = [
      {
        name: 'Summary',
        title: 'Library Report — Summary',
        subtitle: sub,
        columns: [{ header:'Metric', key:'k', width:34 }, { header:'Value', key:'v', width:18, type:'number' }],
        rows: [
          { k:'Books in catalogue (titles)', v: books.length },
          { k:'Total copies', v: books.reduce((s,b) => s + (+b.total||0), 0) },
          { k:'Copies available now', v: books.reduce((s,b) => s + (+b.available||0), 0) },
          { k:'Total transactions (all time)', v: all.length },
          { k:'Currently on loan', v: all.filter(t => !t.returned).length },
          { k:'Returned (all time)', v: all.filter(t => t.returned).length },
          { k:'Returned late', v: all.filter(t => t.status === 'Returned Late').length },
          { k:'Overdue right now', v: { v: all.filter(t => t.overdue).length, tone:'red' } },
          { k:'Distinct borrowers', v: new Set(all.map(t => t.studentId)).size },
          { k:'Records in this export', v: rows.length },
        ],
      },
      {
        name: 'All Transactions',
        title: 'Complete Issue / Return Records',
        subtitle: sub,
        columns: txnCols,
        rows: rows.map((t, i) => ({ ...t, sn: i + 1, status: tone(t) })),
        totals: {
          sn: 'TOTAL', student: rows.length + ' records',
          loanDays: rows.reduce((s,t) => s + t.loanDays, 0),
          daysKept: rows.reduce((s,t) => s + t.daysKept, 0),
          lateDays: rows.reduce((s,t) => s + t.lateDays, 0),
        },
      },
      {
        name: 'Currently Issued',
        title: 'Books Currently On Loan (not returned)',
        subtitle: sub,
        columns: txnCols.filter(c => c.key !== 'returnDate'),
        rows: all.filter(t => !t.returned).map((t, i) => ({ ...t, sn: i + 1, status: tone(t) })),
      },
      {
        name: 'Returned',
        title: 'Returned Books History',
        subtitle: sub,
        columns: txnCols,
        rows: all.filter(t => t.returned).map((t, i) => ({ ...t, sn: i + 1, status: tone(t) })),
      },
      {
        name: 'Overdue',
        title: 'Overdue Books — follow-up list',
        subtitle: sub,
        columns: [
          { header:'#', key:'sn', width:6, type:'number' },
          { header:'Roll No', key:'roll', width:14 },
          { header:'Student Name', key:'student', width:24 },
          { header:'Specialisation', key:'branch', width:14 },
          { header:'Phone', key:'phone', width:15, align:'center' },
          { header:'Email', key:'email', width:26 },
          { header:'Book Title', key:'title', width:34 },
          { header:'Issued On', key:'issueDate', width:13, type:'date' },
          { header:'Due Date', key:'dueDate', width:13, type:'date' },
          { header:'Days Overdue', key:'lateDays', width:14, type:'number' },
        ],
        rows: all.filter(t => t.overdue)
          .sort((a,b) => b.lateDays - a.lateDays)
          .map((t, i) => ({ ...t, sn: i + 1, lateDays: { v: t.lateDays, tone:'red' } })),
      },
      {
        name: 'Student-wise',
        title: 'Student-wise Borrowing Summary',
        subtitle: sub,
        columns: [
          { header:'Roll No', key:'roll', width:14 },
          { header:'Student Name', key:'student', width:24 },
          { header:'Specialisation', key:'branch', width:14 },
          { header:'Sem', key:'semester', width:7, type:'number' },
          { header:'Phone', key:'phone', width:15, align:'center' },
          { header:'Total Borrowed', key:'total', width:15, type:'number' },
          { header:'Returned', key:'returned', width:11, type:'number' },
          { header:'On Loan', key:'onLoan', width:11, type:'number' },
          { header:'Overdue', key:'overdue', width:11, type:'number' },
          { header:'Total Late Days', key:'lateDays', width:16, type:'number' },
          { header:'Books Taken', key:'titles', width:60 },
        ],
        rows: studentSummary(all),
      },
      {
        name: 'Book-wise',
        title: 'Book-wise Circulation Summary',
        subtitle: sub,
        columns: [
          { header:'Book Title', key:'title', width:34 },
          { header:'Author', key:'author', width:22 },
          { header:'ISBN', key:'isbn', width:18, align:'center' },
          { header:'Category', key:'category', width:16 },
          { header:'Total Copies', key:'total', width:13, type:'number' },
          { header:'Available', key:'available', width:12, type:'number' },
          { header:'On Loan', key:'onLoan', width:11, type:'number' },
          { header:'Times Issued', key:'issued', width:14, type:'number' },
          { header:'Times Returned', key:'returned', width:15, type:'number' },
          { header:'Overdue Now', key:'overdue', width:13, type:'number' },
        ],
        rows: bookSummary(all),
      },
    ];

    XLSXLite.download(`NMIET-BSCHOOL-Library-Report-${today()}.xlsx`, sheets);
    toast('Excel report downloaded.');
  }

  // ---- LIBRARIAN LOGIN ACCOUNTS (admin only) ----
  function libraryAccountsPanel() {
    const accts = Store.all('users').filter(u => u.role === 'librarian');
    return `<div class="panel"><div class="panel-head"><h3>Librarian Logins</h3>
      <button class="btn-primary" id="addLibrarian">+ Add Librarian</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Actions</th></tr></thead>
      <tbody id="libBody">${accts.length ? accts.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td>
        <td><div class="row-actions">
          <button class="btn-sm btn-edit" data-edit-lib="${u.id}">Edit</button>
          <button class="btn-sm btn-del" data-del-lib="${u.id}">Delete</button></div></td></tr>`).join('')
        : `<tr><td colspan="3" class="empty">No librarian accounts yet.</td></tr>`}</tbody></table></div></div>`;
  }
  function librarianForm(id) {
    const u = id ? Store.find('users', id) : {};
    openModal((id?'Edit':'Add')+' Librarian', `<form id="f">
      <div class="form-grid">
        <div class="field"><label>Full Name</label><input name="name" value="${esc(u.name||'')}" required></div>
        <div class="field"><label>Username</label><input name="username" value="${esc(u.username||'')}" required></div>
        <div class="field"><label>Password</label><input name="password" type="text" value="" placeholder="${id?'leave blank to keep current':'set a password'}" ${id?'':'required'}></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const username = (d.username||'').trim();
      const clash = Store.all('users').find(x =>
        (x.username||'').toLowerCase() === username.toLowerCase() && x.id !== id);
      if (clash) { toast('Username "'+username+'" already taken.','err'); return; }
      if (id) {
        const patch = { name: d.name, username };
        if (d.password) patch.password = d.password;
        Store.update('users', id, patch);
      } else {
        if (!d.password) { toast('Please set a password.','err'); return; }
        Store.add('users', { name: d.name, username, password: d.password, role: 'librarian', refId: null });
      }
      closeModal(); toast('Librarian saved.'); render();
    };
  }

  /* ========================================================= */
  /*  LOGIN ACCOUNTS — every user id + password in one place    */
  /* ========================================================= */
  const ROLE_PILL = { admin: 'red', center_head: 'amber', placement_officer: 'green',
                      faculty: 'blue', student: 'green', librarian: 'amber', accountant: 'blue',
                      course_coordinator: 'green', admission: 'amber' };
  const ROLE_ORDER = { admin: 0, center_head: 1, accountant: 2, placement_officer: 3,
                       course_coordinator: 4, admission: 5, faculty: 6, librarian: 7, student: 8 };
  const DEFAULT_PASSWORD = 'pass123';

  // who the account belongs to, in human terms
  function accountOwner(u) {
    if (u.role === 'student') {
      const s = Store.find('students', u.refId);
      return s ? `Roll ${s.roll} · ${s.branch} · Sem ${s.semester}` : 'Student record missing';
    }
    if (u.role === 'faculty') {
      const f = Store.find('faculty', u.refId);
      return f ? `${f.empId} · ${f.department}` : 'Faculty record missing';
    }
    if (u.role === 'accountant') {
      const a = Store.find('accountants', u.refId);
      return a ? `${a.empId} · ${a.designation || 'Accounts Office'}` : 'Accounts office';
    }
    if (u.role === 'center_head') {
      const c = Store.find('centerheads', u.refId);
      return c ? `${c.empId} · ${c.designation || 'Center Head'} · view only`
        : 'Center head · view only';
    }
    if (u.role === 'placement_officer') {
      const p = Store.find('placementofficers', u.refId);
      return p ? `${p.empId} · ${p.department || 'Training & Placement Cell'}`
        : 'Training & Placement Cell';
    }
    return u.role === 'admin' ? 'System administrator' : 'Library staff';
  }
  function accountsSorted() {
    return Store.all('users').slice().sort((a, b) =>
      (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
      (a.name || '').localeCompare(b.name || ''));
  }
  // a username nobody else is using — appends 1, 2, 3... if the base is taken
  function freeUsername(base, exceptId) {
    const taken = (v) => Store.all('users').some(u =>
      (u.username || '').toLowerCase() === v.toLowerCase() && u.id !== exceptId);
    let name = String(base || 'user').trim() || 'user';
    for (let n = 1; taken(name); n++) name = base + n;
    return name;
  }

  function viewAccounts() {
    if (user.role !== 'admin') return `<div class="panel"><p class="empty">Only the administrator can view login accounts.</p></div>`;
    const html = `<div class="panel"><div class="panel-head">
      <h3>All Login Accounts</h3>
      <div class="panel-tools">
        <input class="search-box" id="accSearch" placeholder="Search name / user id...">
        <select id="accRole" class="search-box" style="min-width:130px">
          <option value="">All roles</option>
          <option value="admin">Admin</option>
          <option value="center_head">Center Head</option>
          <option value="placement_officer">Placement Officer</option>
          <option value="accountant">Accountant</option>
          <option value="faculty">Faculty</option>
          <option value="librarian">Librarian</option>
          <option value="student">Student</option>
        </select>
        <button class="btn-outline" id="accPrint">🖨 Print List</button>
      </div></div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 10px">
        Every login in the system — admin, faculty, librarian and student. Passwords are stored
        hashed and cannot be read back by anyone, including you — use <b>↺ Reset</b> to set a known
        one and hand it over.</p>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Role</th><th>Name</th><th>User ID</th><th>Password</th><th>Linked To</th><th>Actions</th>
      </tr></thead><tbody id="accBody"></tbody></table></div><div id="accPager"></div></div>
      <div id="accMissing"></div>`;

    viewAccounts.after = () => {
      let page = 1;
      const draw = () => {
        const q = ($('#accSearch').value || '').toLowerCase();
        const role = $('#accRole').value;
        const rows = accountsSorted().filter(u =>
          (!role || u.role === role) &&
          (!q || (u.name || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q)));
        page = Math.min(page, pageCount(rows.length));
        const pageRows = pageSlice(rows, page);
        $('#accBody').innerHTML = pageRows.length ? pageRows.map(u => {
          const self = u.id === user.id;
          return `<tr>
          <td><span class="pill ${ROLE_PILL[u.role] || 'blue'}">${esc(u.role)}</span></td>
          <td>${esc(u.name || '—')}${self ? ' <small style="color:var(--muted)">(you)</small>' : ''}</td>
          <td class="mono">${esc(u.username || '—')}</td>
          <td class="mono">••••••••</td>
          <td><small>${esc(accountOwner(u))}</small></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-edit" data-edit-acc="${u.id}">Edit</button>
            <button class="btn-sm btn-outline" data-reset-acc="${u.id}" title="Set password back to ${DEFAULT_PASSWORD}">↺ Reset</button>
            ${self ? '' : `<button class="btn-sm btn-del" data-del-acc="${u.id}">Delete</button>`}
          </div></td></tr>`;
        }).join('') : `<tr><td colspan="6" class="empty">No accounts found.</td></tr>`;

        $('#accBody').querySelectorAll('[data-edit-acc]').forEach(b => b.onclick = () => accountForm(b.dataset.editAcc, draw));
        $('#accBody').querySelectorAll('[data-reset-acc]').forEach(b => b.onclick = () => resetPassword(b.dataset.resetAcc, draw));
        $('#accBody').querySelectorAll('[data-del-acc]').forEach(b => b.onclick = () => delConfirm('users', b.dataset.delAcc, 'login account', draw));
        $('#accPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#accPager'), rows.length, page, (p) => page = p, draw);
        drawMissing();
      };

      // students / faculty on record who still have no way to log in
      const drawMissing = () => {
        const users = Store.all('users');
        const has = (role, refId) => users.some(u => u.role === role && u.refId === refId);
        const rows = [
          ...Store.all('students').filter(s => !has('student', s.id))
            .map(s => ({ role: 'student', refId: s.id, name: s.name, uid: s.roll })),
          ...Store.all('faculty').filter(f => !has('faculty', f.id))
            .map(f => ({ role: 'faculty', refId: f.id, name: f.name, uid: f.empId })),
          ...Store.all('accountants').filter(a => !has('accountant', a.id))
            .map(a => ({ role: 'accountant', refId: a.id, name: a.name, uid: a.empId })),
          ...Store.all('centerheads').filter(c => !has('center_head', c.id))
            .map(c => ({ role: 'center_head', refId: c.id, name: c.name, uid: c.empId })),
          ...Store.all('placementofficers').filter(p => !has('placement_officer', p.id))
            .map(p => ({ role: 'placement_officer', refId: p.id, name: p.name, uid: p.empId })),
        ];
        $('#accMissing').innerHTML = !rows.length ? '' :
          `<div class="panel"><div class="panel-head"><h3>⚠ Without a Login (${rows.length})</h3>
            <button class="btn-primary" id="accMakeAll">Create All Logins</button></div>
          <div class="tbl-wrap"><table><thead><tr><th>Role</th><th>Name</th><th>Suggested User ID</th><th>Actions</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>
            <td><span class="pill ${ROLE_PILL[r.role]}">${r.role}</span></td>
            <td>${esc(r.name)}</td><td class="mono">${esc(r.uid || '—')}</td>
            <td><button class="btn-sm btn-edit" data-mk="${i}">+ Create Login</button></td></tr>`).join('')}
          </tbody></table></div></div>`;
        const make = (r) => Store.add('users', {
          username: freeUsername(r.uid || r.name.replace(/\s+/g, '').toLowerCase()),
          password: DEFAULT_PASSWORD, role: r.role, refId: r.refId, name: r.name,
        });
        $('#accMissing').querySelectorAll('[data-mk]').forEach(b => b.onclick = () => {
          make(rows[+b.dataset.mk]); toast('Login created — password is ' + DEFAULT_PASSWORD + '.'); draw();
        });
        const all = $('#accMakeAll');
        if (all) all.onclick = () => { rows.forEach(make); toast(rows.length + ' logins created.'); draw(); };
      };

      $('#accSearch').oninput = () => { page = 1; draw(); };
      $('#accRole').onchange = () => { page = 1; draw(); };
      $('#accPrint').onclick = printAccounts;
      draw();
    };
    return html;
  }

  function accountForm(id, after) {
    const u = Store.find('users', id);
    if (!u) return;
    openModal('Edit Login — ' + (u.name || u.username), `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Display Name</label><input name="name" value="${esc(u.name || '')}" required></div>
        <div class="field"><label>User ID</label><input name="username" value="${esc(u.username || '')}" required></div>
        <div class="field"><label>New Password</label><input name="password" type="text" value=""
               placeholder="leave blank to keep the current one"></div>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:10px">Role: <b>${esc(u.role)}</b> · ${esc(accountOwner(u))}</p>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const username = (d.username || '').trim();
      if (!username) { toast('User id cannot be blank.', 'err'); return; }
      const clash = Store.all('users').find(x =>
        (x.username || '').toLowerCase() === username.toLowerCase() && x.id !== id);
      if (clash) { toast('User id "' + username + '" is already taken.', 'err'); return; }
      const patch = { name: d.name, username };
      if (d.password) patch.password = d.password;   // blank means "leave it alone"
      Store.update('users', id, patch);
      // the top bar shows the logged-in user's name — keep it in sync
      if (id === user.id) { user.name = d.name; user.username = username; paintUser(); }
      closeModal(); toast('Login updated.'); after ? after() : render();
    };
  }

  function resetPassword(id, after) {
    const u = Store.find('users', id);
    if (!u) return;
    openModal('Reset Password', `<p>Reset the password for <b>${esc(u.name || u.username)}</b>
      (user id <b>${esc(u.username)}</b>) back to <b>${DEFAULT_PASSWORD}</b>?</p>
      <div class="form-actions"><button class="btn-outline" id="cx">Cancel</button>
        <button class="btn-primary" id="ok">Reset</button></div>`);
    $('#cx').onclick = closeModal;
    $('#ok').onclick = () => {
      Store.update('users', id, { password: DEFAULT_PASSWORD });
      closeModal(); toast('Password reset to ' + DEFAULT_PASSWORD + '.'); after ? after() : render();
    };
  }

  /* The user ids, not the passwords. A password cannot be read back any more,
     and a sheet listing every one of them was never something that should have
     been left on a printer in the first place. */
  function printAccounts() {
    const rows = accountsSorted();
    printDoc('Login Accounts', `<h2>LOGIN ACCOUNTS</h2>
      <p>Generated on ${today()} — user ids only. Passwords are stored hashed and cannot be
         printed; use <b>Reset</b> on the Login Accounts page to set one.</p>
      <table><thead><tr><th>Role</th><th>Name</th><th>User ID</th><th>Status</th><th>Linked To</th></tr></thead>
      <tbody>${rows.map(u => `<tr><td>${esc(u.role)}</td><td>${esc(u.name || '')}</td>
        <td>${esc(u.username || '')}</td><td>${userActive(u) ? 'Active' : 'Inactive'}</td>
        <td>${esc(accountOwner(u))}</td></tr>`).join('')}</tbody></table>`);
  }

  function bookForm(id, after) {
    const b = id ? Store.find('books', id) : {};
    openModal((id?'Edit':'Add')+' Book', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Title</label><input name="title" value="${esc(b.title||'')}" required></div>
        <div class="field"><label>Author</label><input name="author" value="${esc(b.author||'')}"></div>
        <div class="field"><label>ISBN</label><input name="isbn" value="${esc(b.isbn||'')}"></div>
        <div class="field"><label>Category</label><input name="category" value="${esc(b.category||'')}"></div>
        <div class="field"><label>Total Copies</label><input name="total" type="number" min="1" value="${b.total||1}"></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target); const total = +d.total||1;
      if (id) {
        const issuedOut = b.total - b.available;            // keep availability consistent
        Store.update('books', id, { title:d.title, author:d.author, isbn:d.isbn, category:d.category,
          total, available: Math.max(0, total - issuedOut) });
      } else {
        Store.add('books', { title:d.title, author:d.author, isbn:d.isbn, category:d.category, total, available: total });
      }
      closeModal(); toast('Book saved.'); after();
    };
  }

  const DEFAULT_LOAN_DAYS = 14;
  function issueBook(bookId, studentId, days) {
    const b = Store.find('books', bookId);
    if (!b || b.available <= 0) { toast('This book is not available.','err'); return; }
    const loanDays = Math.max(1, parseInt(days, 10) || DEFAULT_LOAN_DAYS);
    Store.add('issues', { bookId, studentId, issueDate: today(), dueDate: addDays(today(), loanDays), returnDate: '' });
    Store.update('books', bookId, { available: b.available - 1 });
    toast(`Book issued for ${loanDays} days.`);
  }
  function returnBook(issueId) {
    const i = Store.find('issues', issueId);
    if (!i || i.returnDate) return;
    Store.update('issues', issueId, { returnDate: today() });
    const b = Store.find('books', i.bookId);
    if (b) Store.update('books', i.bookId, { available: Math.min(b.total, b.available + 1) });
    toast('Book returned.');
  }

  // student's library view
  function viewMyBooks() {
    const sid = user.refId;
    const mine = Store.all('issues').filter(i => i.studentId === sid)
      .sort((a,b) => (b.issueDate||'').localeCompare(a.issueDate||''));
    const active = mine.filter(i => !i.returnDate);
    let html = `<div class="stat-grid">
      ${statCard('📖', active.length, 'Books on Loan')}
      ${statCard('⏰', active.filter(i=>i.dueDate<today()).length, 'Overdue', 'c4')}
      ${statCard('📚', mine.length, 'Total Borrowed', 'c3')}
    </div>`;
    html += `<div class="panel"><div class="panel-head"><h3>My Borrowed Books</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Title</th><th>Author</th><th>Issued On</th><th>Due Date</th><th>Status</th>
      </tr></thead><tbody>${mine.length ? mine.map(i => {
        const b = Store.find('books', i.bookId)||{};
        let st;
        if (i.returnDate) st = `<span class="pill blue">Returned ${esc(i.returnDate)}</span>`;
        else st = i.dueDate < today() ? `<span class="pill red">Overdue</span>` : `<span class="pill green">Issued</span>`;
        return `<tr><td>${esc(b.title||'?')}</td><td>${esc(b.author||'')}</td>
          <td>${esc(i.issueDate)}</td><td>${esc(i.dueDate)}</td><td>${st}</td></tr>`;
      }).join('') : `<tr><td colspan="5" class="empty">You have not issued any book yet.</td></tr>`}</tbody></table></div></div>`;
    return html;
  }

  /* ========================================================= */
  /*  PRINTABLE DOCUMENTS (ID card / Marksheet -> PDF)          */
  /* ========================================================= */
  function printDoc(title, inner) {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { toast('Popup blocked — allow popups to print.','err'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;
        -webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
      body{padding:28px;color:#1f2a37}
      .doc-head{display:flex;align-items:center;gap:16px;border-bottom:3px solid #123f8c;padding-bottom:14px;margin-bottom:20px}
      .doc-head img{width:104px;height:60px;object-fit:contain}
      .doc-head h1{font-size:22px;color:#0d2f6b}
      .doc-head p{font-size:13px;color:#555}
      table{width:100%;border-collapse:collapse;margin-top:10px;font-size:14px}
      th,td{border:1px solid #cfd8dc;padding:9px 11px;text-align:left}
      th{background:#e8eefb;color:#0d2f6b}
      .gpa{margin-top:16px;font-size:16px}
      .gpa b{color:#0d2f6b;font-size:20px}
      /* fee receipt */
      .receipt-title{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      .receipt-title h2{font-size:19px;color:#0d2f6b;letter-spacing:2px}
      .receipt-no{text-align:right;font-size:13px;font-weight:700;color:#0d2f6b}
      .receipt-no span{display:block;font-weight:400;color:#666;font-size:12px}
      .receipt-amount{margin-top:16px;background:#e8eefb;border:1px solid #123f8c;border-radius:8px;
        padding:12px 16px;font-size:15px;color:#0d2f6b}
      .receipt-amount b{font-size:20px}
      .sign{margin-top:60px;display:flex;justify-content:space-between;font-size:13px;color:#555}
      .sign span{border-top:1px solid #888;padding-top:6px}
      /* ID card */
      .idcard{width:700px;max-width:100%;border:2px solid #123f8c;border-radius:22px;overflow:hidden;
        margin:0 auto;display:flex;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.08)}
      .idcard-left{width:230px;flex-shrink:0;background:linear-gradient(160deg,#229350,#0f5c2a);
        clip-path:polygon(0 0,100% 0,78% 100%,0 100%);color:#fff;padding:28px 18px 20px;
        display:flex;flex-direction:column;align-items:center;text-align:center}
      .idcard-left .photo-ring{width:150px;height:150px;border-radius:50%;background:#fff;padding:5px;
        margin-bottom:14px;box-shadow:0 0 0 3px rgba(255,255,255,.35)}
      .idcard-left .photo-inner{width:100%;height:100%;border-radius:50%;overflow:hidden;background:#e8eefb;
        display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:700;color:#123f8c}
      .idcard-left .photo-inner img{width:100%;height:100%;object-fit:cover;border-radius:50%}
      .idcard-left h3{font-size:19px;margin-bottom:8px;line-height:1.25}
      .idcard-left .badge{background:rgba(255,255,255,.92);color:#0f5c2a;font-weight:700;font-size:12.5px;
        padding:5px 16px;border-radius:20px;margin-bottom:8px}
      .idcard-left .dept{font-size:13px;opacity:.95;margin-bottom:20px}
      .idcard-left .tagline{font-size:10.5px;opacity:.85;border-top:1px solid rgba(255,255,255,.3);
        padding-top:10px;margin-top:auto;align-self:flex-start}
      .idcard-right{flex:1;padding:24px 26px;min-width:0}
      .idcard-right .hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:10px}
      .idcard-right .hd-brand{display:flex;align-items:center;gap:10px;min-width:0}
      .idcard-right .hd-brand img{width:60px;height:35px;object-fit:contain;flex-shrink:0}
      .idcard-right .hd-brand strong{font-size:16px;color:#0f5c2a;display:block;line-height:1.15}
      .idcard-right .hd-brand small{font-size:10.5px;color:#666;letter-spacing:.3px}
      .idcard-right .hd-pill{background:#123f8c;color:#fff;font-size:11px;font-weight:700;
        padding:7px 14px;border-radius:18px;white-space:nowrap;flex-shrink:0}
      .idcard-right .row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #eef1ee;font-size:13px}
      .idcard-right .row .ic{width:26px;height:26px;border-radius:50%;background:#123f8c;color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:12.5px;flex-shrink:0}
      .idcard-right .row b{width:120px;color:#222;flex-shrink:0}
      .idcard-right .row span{color:#333}
      .idcard-right .sign{margin-top:24px;text-align:right;font-size:11px;color:#555}
      .idcard-right .sign .line{width:150px;margin-left:auto;border-bottom:1px solid #999;height:30px}
      @media print{
        *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}
        body{padding:0}.noprint{display:none}
      }
    </style></head><body>${inner}
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  }
  function docHeader() {
    const logo = location.origin + '/assets/nmiet-logo.png';
    return `<div class="doc-head"><img src="${logo}" alt="NMIET B-SCHOOL">
      <div><h1>NMIET B-SCHOOL</h1>
      <p>Bhubaneswar</p></div></div>`;
  }
  // shared card template used by both student and faculty ID cards
  function idCardHtml({ badgeText, name, roleLine, subLine, photo, rows }) {
    const logo = location.origin + '/assets/nmiet-logo.png';
    return `<div class="idcard">
      <div class="idcard-left">
        <div class="photo-ring"><div class="photo-inner">${photo ?
          `<img src="${esc(photo)}">` : esc((name||'?')[0])}</div></div>
        <h3>${esc(name)}</h3>
        ${roleLine ? `<div class="badge">${esc(roleLine)}</div>` : ''}
        ${subLine ? `<div class="dept">${esc(subLine)}</div>` : ''}
        <div class="tagline">Excellence Our Essence</div>
      </div>
      <div class="idcard-right">
        <div class="hd">
          <div class="hd-brand"><img src="${logo}"><div><strong>NMIET B-SCHOOL</strong><small>CMS · BHUBANESWAR</small></div></div>
          <div class="hd-pill">${esc(badgeText)}</div>
        </div>
        ${rows.map(([ic,label,val]) => `<div class="row"><span class="ic">${ic}</span><b>${esc(label)}</b><span>: ${esc(val ?? '—')}</span></div>`).join('')}
        <div class="sign"><div class="line">&nbsp;</div>Authorized Signature</div>
      </div>
    </div>`;
  }
  function printIdCard(sid) {
    const s = Store.find('students', sid); if (!s) return;
    const inner = idCardHtml({
      badgeText: 'STUDENT ID CARD',
      name: s.name,
      roleLine: 'Section ' + (s.section || 'A'),
      subLine: s.branch,
      photo: s.photo,
      rows: [
        ['🎓','Reg No', s.roll],
        ['🏫','Specialisation', s.branch],
        ['📘','Year / Sem', `${s.year} / ${s.semester}`],
        ['🔤','Section', s.section],
        ['📞','Phone', s.phone || '—'],
      ],
    });
    printDoc('ID Card - ' + s.roll, inner);
  }
  function printFacultyIdCard(fid) {
    const f = findEmployee(fid); if (!f) return;
    const inner = idCardHtml({
      // the card says what the holder is — an accountant's does not read FACULTY
      badgeText: f.roleName.toUpperCase() + ' ID CARD',
      name: f.name,
      roleLine: f.designation,
      subLine: f.department,
      photo: f.photo,
      rows: [
        ['👤','Employee ID', f.empId],
        ['🧑‍💼','Role', f.roleName],
        ['🏫','Department', f.department || '—'],
        ['🎓','Designation', f.designation || '—'],
        ['✉️','Email', f.email || '—'],
        ['📞','Phone', f.phone || '—'],
      ],
    });
    printDoc('ID Card - ' + f.empId, inner);
  }
  function printMarksheet(sid) {
    const s = Store.find('students', sid); if (!s) return;
    const ms = Store.all('marks').filter(m => m.studentId === sid);
    const gpa = studentGPA(sid);
    const rows = ms.map(m => {
      const c = Store.find('courses', m.courseId)||{};
      const pct = markPercent(m); const g = gradeFor(pct || 0);
      return `<tr><td>${esc(c.code||'')}</td><td>${esc(c.name||'')}</td><td>${c.credits||'—'}</td>
        <td>${m.internal??'—'}</td><td>${pct === null ? '—' : pct + '%'}</td><td>${pct === null ? '—' : g.g}</td></tr>`;
    }).join('') || `<tr><td colspan="6" style="text-align:center">No results published.</td></tr>`;
    const inner = `${docHeader()}
      <h2 style="font-size:17px;color:#0d2f6b;margin-bottom:10px">Statement of Grades</h2>
      <table style="margin-bottom:6px"><tbody>
        <tr><th style="width:120px">Name</th><td>${esc(s.name)}</td><th style="width:120px">Reg No</th><td>${esc(s.roll)}</td></tr>
        <tr><th>Specialisation</th><td>${esc(s.branch)}</td><th>Semester</th><td>${esc(s.semester)}</td></tr>
      </tbody></table>
      <table><thead><tr><th>Code</th><th>Course</th><th>Credits</th><th>Internal /${INTERNAL_MAX}</th><th>Percentage</th><th>Grade</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <p style="font-size:12px;color:#666;margin-top:8px">Internal assessment only — university/external examination results are published by the affiliating university.</p>
      <div class="gpa">GPA: <b>${gpa ?? '—'}</b> / 10</div>
      <div class="sign"><span>Controller of Examinations</span><span>Registrar</span></div>`;
    printDoc('Marksheet - ' + s.roll, inner);
  }

  /* =========================================================
     FINANCE — the accounts-office modules.
     Used by BOTH the admin and the accountant role: same collections,
     same helpers, same figures. Nothing here keeps a second copy of a
     number that already lives somewhere else — `fees` is the per-student
     ledger, `payments` is the receipt trail behind fees.paid.
     ========================================================= */

  // NMIET B-SCHOOL runs two programmes, both two-year and four-semester
  const ACADEMIC_COURSES = ['MBA'];
  const FEE_TYPES = ['Tuition Fee', 'Admission Fee', 'Examination Fee', 'Library Fee',
                     'Laboratory Fee', 'Development Fee', 'Other Fee'];
  const PAY_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'];
  const ASSET_CATEGORIES = ['Computer', 'Laptop', 'Furniture', 'Laboratory Equipment', 'Projector',
                            'Printer', 'Networking Equipment', 'Library Equipment', 'Other'];
  const ASSET_STATUS = ['In Use', 'In Store', 'Under Maintenance', 'Damaged', 'Disposed'];
  const STRUCT_STATUS = ['Active', 'Inactive'];
  const SEMESTERS = [1, 2, 3, 4];

  /* ---------- option lists ---------- */
  function optionsFrom(list, sel) {
    return list.map(v => `<option ${String(v) === String(sel) ? 'selected' : ''}>${esc(v)}</option>`).join('');
  }
  // the editable course list (see LIST_DEFS) — standard courses, whatever the
  // admin added, plus every course already referenced by a student or fee head
  function courseList() { return listValues('course'); }
  function specialisationList() { return listValues('specialisation'); }
  function specialisationOptions(sel, withExtras) { return listOptions('specialisation', sel, withExtras); }
  /* One programme is run, so what tells students apart is the specialisation.
     `branch` still holds the programme code on older rows, so it is the
     fallback rather than the source. */
  function specOf(x) { return String((x && (x.specialisation || x.branch)) || '').trim(); }
  function courseOptions(sel, withExtras) { return listOptions('course', sel, withExtras); }
  // rolling window around the current session, plus anything already on record
  function academicYearList() {
    const y = new Date().getFullYear();
    const set = new Set([-2, -1, 0, 1].map(d => `${y + d}-${String((y + d + 1) % 100).padStart(2, '0')}`));
    ['students', 'fees', 'fixedfees'].forEach(col =>
      Store.all(col).forEach(r => { if (r.academicYear) set.add(String(r.academicYear).trim()); }));
    return [...set].filter(Boolean).sort().reverse();
  }
  /** the session running now, in the form the rest of the app writes it */
  function currentAcademicYear() {
    const y = new Date().getFullYear();
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  }
  function academicYearOptions(sel) {
    const list = academicYearList();
    const current = sel || list.find(v => v.startsWith(String(new Date().getFullYear()))) || list[0];
    return optionsFrom(list, current);
  }
  function semesterOptions(sel) {
    return SEMESTERS.map(n => `<option value="${n}" ${String(n) === String(sel) ? 'selected' : ''}>Semester ${n}</option>`).join('');
  }
  function studentOptions(sel) {
    return Store.all('students').slice()
      .sort((a, b) => String(a.roll || '').localeCompare(String(b.roll || '')))
      .map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.roll)} — ${esc(s.name)}</option>`).join('');
  }

  /* ---------- fee maths (one place, so every page agrees) ---------- */
  function feeStatusOf(total, paid) {
    const t = +total || 0, p = Math.min(t, +paid || 0);
    if (t <= 0) return { key: 'No Fee', pill: 'blue', label: 'No Fee Set' };
    if (t - p <= 0) return { key: 'Paid', pill: 'green', label: 'Paid' };
    if (p <= 0) return { key: 'Unpaid', pill: 'red', label: 'Unpaid' };
    return { key: 'Partial', pill: 'amber', label: 'Partial' };
  }
  function feeRowsOf(sid) {
    return Store.all('fees').filter(f => f.studentId === sid)
      .sort((a, b) => (+a.semester || 0) - (+b.semester || 0) || String(a.id).localeCompare(String(b.id)));
  }
  function paymentsOf(sid) {
    return Store.all('payments').filter(p => p.studentId === sid)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  // one row per student: their identity plus the roll-up of every fee record
  function financeRows() {
    const fees = Store.all('fees');
    return Store.all('students').map(s => {
      const rows = fees.filter(f => f.studentId === s.id);
      const total = rows.reduce((a, f) => a + (+f.total || 0), 0);
      const paid = rows.reduce((a, f) => a + Math.min(+f.total || 0, +f.paid || 0), 0);
      const openDues = rows.filter(f => (+f.total || 0) > (+f.paid || 0))
        .map(f => f.dueDate).filter(Boolean).sort();
      return {
        sid: s.id, roll: s.roll || '', name: s.name || '', course: s.course || '—',
        branch: specOf(s) || '—', semester: s.semester || '', academicYear: s.academicYear || '—',
        total, paid, pending: Math.max(0, total - paid),
        dueDate: openDues[0] || '—', status: feeStatusOf(total, paid).label,
        pill: feeStatusOf(total, paid).pill, student: s, rows,
      };
    }).sort((a, b) => String(a.roll).localeCompare(String(b.roll)));
  }
  function collectionTotals() {
    const rows = financeRows();
    const total = rows.reduce((a, r) => a + r.total, 0);
    const collected = rows.reduce((a, r) => a + r.paid, 0);
    return { total, collected, pending: Math.max(0, total - collected), rows };
  }
  function fixedFeeTotal() {
    return Store.all('fixedfees').filter(f => (f.status || 'Active') === 'Active')
      .reduce((a, f) => a + (+f.amount || 0), 0);
  }
  function assetValueTotal() {
    return Store.all('assets').filter(a => a.status !== 'Disposed')
      .reduce((a, x) => a + (+x.currentValue || 0), 0);
  }
  function collectionOn(date) {
    return Store.all('payments').filter(p => p.date === date)
      .reduce((a, p) => a + (+p.amount || 0), 0);
  }
  // the fee structure that applies to a student — used to pre-fill a new fee record
  function structureTotalFor(course, branch, academicYear) {
    const wholeIntake = (v) => !v || String(v).trim().toUpperCase() === 'MBA';
    return Store.all('fixedfees').filter(f =>
      (f.status || 'Active') === 'Active' &&
      (!course || f.course === course) &&
      (!branch || wholeIntake(f.branch) || f.branch === branch) &&
      (!academicYear || f.academicYear === academicYear))
      .reduce((a, f) => a + (+f.amount || 0), 0);
  }

  /* ---------- money input validation ---------- */
  // returns a whole number of rupees, or null when the value is not usable
  function parseAmount(raw, { min = 1, max = null } = {}) {
    const n = Number(String(raw ?? '').replace(/[, ₹]/g, ''));
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (n < min) return null;
    if (max !== null && n > max) return null;
    return n;
  }
  function bindAmountInput(el) {
    if (!el) return;
    el.oninput = () => { el.value = el.value.replace(/[^\d]/g, ''); };
  }
  // a yes/no dialog for anything that changes money or deletes a record
  function confirmAction(title, message, okLabel, onOk) {
    openModal(title, `<p style="line-height:1.7">${message}</p>
      <div class="form-actions"><button class="btn-outline" id="cx">Cancel</button>
        <button class="btn-primary" id="ok">${esc(okLabel)}</button></div>`);
    $('#cx').onclick = closeModal;
    $('#ok').onclick = () => { closeModal(); onOk(); };
  }

  /* Every delete in the project goes through here, so they all read and look
     the same: what is about to go, the same warning under it, and a red button
     that is not where Cancel is. Deliberately not the same function as
     confirmAction — a dialog that cries irreversible over a saved payment
     teaches people to click through the one that means it. */
  function confirmDelete(title, message, okLabel, onOk) {
    openModal(title, `<p style="line-height:1.7">${message}</p>
      <p style="color:var(--muted);font-size:13px;margin:8px 0 0">This action cannot be undone.</p>
      <div class="form-actions"><button class="btn-outline" id="cx">Cancel</button>
        <button class="btn-primary" style="background:var(--red)" id="ok">${esc(okLabel)}</button></div>`);
    $('#cx').onclick = closeModal;
    $('#ok').onclick = () => { closeModal(); onOk(); };
  }

  /* ---------- shared filter bar ---------- */
  function finFilterBar(p, opts) {
    const o = opts || {};
    return `<div class="panel-tools fin-filters">
      <input class="search-box" id="${p}Q" placeholder="${esc(o.placeholder || 'Search student / reg no...')}">
      ${o.noCourse ? '' : `<select class="filter-sel" id="${p}Course"><option value="">All Courses</option>${optionsFrom(courseList())}</select>`}
      ${o.noBranch ? '' : `<select class="filter-sel" id="${p}Branch"><option value="">All Specialisations</option>${specialisationOptions()}</select>`}
      ${o.noSem ? '' : `<select class="filter-sel" id="${p}Sem"><option value="">All Semesters</option>${semesterOptions()}</select>`}
      ${o.noYear ? '' : `<select class="filter-sel" id="${p}Year"><option value="">All Academic Years</option>${optionsFrom(academicYearList())}</select>`}
      ${o.dates ? `<label class="days-field">From <input class="filter-sel" id="${p}From" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="${p}To" type="date"></label>` : ''}
      ${o.extra || ''}
      <button class="btn-outline btn-sm" id="${p}Clear">Clear</button>
    </div>`;
  }
  const FIN_FILTER_IDS = ['Q', 'Course', 'Branch', 'Sem', 'Year', 'From', 'To'];
  function finFilterValues(p, extraIds) {
    const val = (suffix) => { const el = $('#' + p + suffix); return el ? el.value : ''; };
    const out = {
      q: (val('Q') || '').trim().toLowerCase(), course: val('Course'), branch: val('Branch'),
      semester: val('Sem'), year: val('Year'), from: val('From'), to: val('To'),
    };
    (extraIds || []).forEach(s => { out[s.toLowerCase()] = val(s); });
    return out;
  }
  function bindFinFilters(p, extraIds, onChange) {
    const ids = FIN_FILTER_IDS.concat(extraIds || []);
    ids.forEach(suffix => {
      const el = $('#' + p + suffix);
      if (!el) return;
      el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = onChange;
    });
    const clear = $('#' + p + 'Clear');
    if (clear) clear.onclick = () => {
      ids.forEach(suffix => {
        const el = $('#' + p + suffix);
        if (!el) return;
        el.value = '';
        // a select without a blank option (e.g. the sort order) falls back to its first
        if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.selectedIndex = 0;
      });
      onChange();
    };
  }
  // the student-shaped filters every finance list uses
  function matchesFinFilters(r, f) {
    if (f.q && ![r.roll, r.name, r.sid, r.course, r.branch, r.receiptNo, r.txnId]
      .some(v => String(v || '').toLowerCase().includes(f.q))) return false;
    if (f.course && r.course !== f.course) return false;
    if (f.branch && r.branch !== f.branch) return false;
    if (f.semester && String(r.semester) !== String(f.semester)) return false;
    if (f.year && r.academicYear !== f.year) return false;
    return true;
  }

  /* ---------- report rendering + export (print / PDF / CSV / Excel) ---------- */
  function cellText(col, row) {
    const v = row[col.key];
    if (v === null || v === undefined || v === '') return '—';
    return col.money ? money(v) : String(v);
  }
  function reportTableHtml(columns, rows, emptyMsg) {
    if (!rows.length) return `<div class="tbl-wrap"><table><thead><tr>${columns.map(c =>
      `<th>${esc(c.header)}</th>`).join('')}</tr></thead><tbody><tr>
      <td colspan="${columns.length}" class="empty">${esc(emptyMsg || 'Nothing to show for these filters.')}</td>
      </tr></tbody></table></div>`;
    return `<div class="tbl-wrap"><table><thead><tr>${columns.map(c =>
      `<th${c.money ? ' style="text-align:right"' : ''}>${esc(c.header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${columns.map(c =>
        `<td${c.money ? ' style="text-align:right"' : ''}>${esc(cellText(c, r))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  }
  function exportButtons(p) {
    return `<button class="btn-outline btn-sm" id="${p}Print">🖨 Print</button>
      <button class="btn-outline btn-sm" id="${p}Pdf">📄 PDF</button>
      <button class="btn-outline btn-sm" id="${p}Csv">📑 CSV</button>
      <button class="btn-primary btn-sm" id="${p}Xls">⬇ Excel</button>`;
  }
  // `get()` returns { title, subtitle, columns, rows, totals }
  function bindExports(p, get) {
    const on = (suffix, fn) => { const el = $('#' + p + suffix); if (el) el.onclick = fn; };
    on('Print', () => printReport(get()));
    on('Pdf', () => { printReport(get()); toast('Choose "Save as PDF" in the print dialog.'); });
    on('Csv', () => downloadCsv(get()));
    on('Xls', () => downloadXlsx(get()));
  }
  function reportStamp() {
    return `NMIET B-SCHOOL · ${reportOffice()} · Generated on ${new Date().toLocaleString('en-IN')}`;
  }
  // whose report this is — the same builders serve the accounts office and the
  // center head, so the letterhead follows the signed-in role
  function reportOffice() { return readOnly() ? "Center Head's Office" : 'Accounts Office'; }
  function reportSignatory() { return readOnly() ? 'Center Head' : 'Accounts Officer'; }
  function printReport(r) {
    if (!r.rows.length) { toast('Nothing to print for these filters.', 'err'); return; }
    const totalsRow = r.totals ? `<tfoot><tr>${r.columns.map(c =>
      `<td style="font-weight:700${c.money ? ';text-align:right' : ''}">${esc(
        r.totals[c.key] === undefined ? '' : (c.money ? money(r.totals[c.key]) : r.totals[c.key]))}</td>`).join('')}</tr></tfoot>` : '';
    printDoc(r.title, `${docHeader()}
      <h2 style="font-size:17px;color:#0d2f6b;margin-bottom:4px">${esc(r.title)}</h2>
      <p style="font-size:12px;color:#666;margin-bottom:10px">${esc(r.subtitle || reportStamp())}</p>
      <table><thead><tr>${r.columns.map(c =>
        `<th${c.money ? ' style="text-align:right"' : ''}>${esc(c.header)}</th>`).join('')}</tr></thead>
        <tbody>${r.rows.map(row => `<tr>${r.columns.map(c =>
          `<td${c.money ? ' style="text-align:right"' : ''}>${esc(cellText(c, row))}</td>`).join('')}</tr>`).join('')}</tbody>
        ${totalsRow}</table>
      <p style="font-size:11px;color:#777;margin-top:10px">${r.rows.length} record(s)</p>
      <div class="sign"><span>${esc(reportSignatory())}</span><span>Principal / Director</span></div>`);
  }
  function downloadCsv(r) {
    if (!r.rows.length) { toast('Nothing to export for these filters.', 'err'); return; }
    const q = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [r.columns.map(c => q(c.header)).join(',')];
    r.rows.forEach(row => lines.push(r.columns.map(c => q(row[c.key] ?? '')).join(',')));
    if (r.totals) lines.push(r.columns.map(c => q(r.totals[c.key] ?? '')).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.title.replace(/[^\w]+/g, '-')}-${today()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('CSV downloaded.');
  }
  function downloadXlsx(r) {
    if (!window.XLSXLite) { toast('Excel module failed to load.', 'err'); return; }
    if (!r.rows.length) { toast('Nothing to export for these filters.', 'err'); return; }
    XLSXLite.download(`${r.title.replace(/[^\w]+/g, '-')}-${today()}.xlsx`, [{
      name: (r.sheetName || r.title).slice(0, 28),
      title: r.title,
      subtitle: r.subtitle || reportStamp(),
      columns: r.columns.map(c => ({
        header: c.header, key: c.key, width: c.width || 18,
        type: c.money || c.type === 'number' ? 'number' : c.type,
        align: c.align,
      })),
      rows: r.rows,
      totals: r.totals,
    }]);
    toast('Excel report downloaded.');
  }

  /* =========================== DASHBOARD =========================== */
  function accountantDashboard() {
    const t = collectionTotals();
    const students = Store.all('students');
    const assets = Store.all('assets');
    const payments = Store.all('payments');
    const collPct = t.total ? Math.round((t.collected / t.total) * 100) : 0;

    const statusCounts = { Paid: 0, Partial: 0, Unpaid: 0, 'No Fee Set': 0 };
    t.rows.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
    const segments = [
      { label: 'Fully Paid', value: statusCounts.Paid, color: 'var(--primary)' },
      { label: 'Partially Paid', value: statusCounts.Partial, color: 'var(--amber)' },
      { label: 'Unpaid', value: statusCounts.Unpaid, color: 'var(--red)' },
      { label: 'No Fee Set', value: statusCounts['No Fee Set'], color: 'var(--line)' },
    ].filter(s => s.value > 0);

    const days = [...Array(7)].map((_, i) => addDays(today(), i - 6));
    const daily = days.map(d => collectionOn(d));
    const receiptsPerDay = days.map(d => payments.filter(p => p.date === d).length);

    const recent = [...payments].sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) ||
      String(b.id || '').localeCompare(String(a.id || ''))).slice(0, 8);

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(user.name) || 'Accounts')} 👋</h2>
        <p>Accounts &amp; Finance Office · ${prettyDate()}</p>
        <div class="wb-chips">
          <span>Collection ${collPct}%</span>
          <span>Today ${money(collectionOn(today()))}</span>
          <span>${payments.length} receipts on record</span>
        </div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    html += `<div class="stat-grid">
      ${statCard('🎓', students.length, 'Total Students')}
      ${statCard('💰', money(t.collected), 'Total Fee Collection', 'c3')}
      ${statCard('⏳', money(t.pending), 'Pending Fees', t.pending > 0 ? 'c4' : 'c3')}
      ${statCard('📋', money(fixedFeeTotal()), 'Total Fixed Fee', 'c2')}
      ${statCard('🏢', money(assetValueTotal()), `Total Assets (${assets.length} items)`, 'c2')}
      ${statCard('🧾', money(collectionOn(today())), "Today's Collection", 'c3')}
    </div>`;

    html += `<div class="dash-2col">
      <div class="panel"><div class="panel-head"><h3>Collection — Last 7 Days</h3>
        <span style="font-size:12px;color:var(--muted)">Amount vs. receipts</span></div>
        ${lineChartSvg(days, daily, receiptsPerDay.map(n => n * (Math.max(1, ...daily) / Math.max(1, ...receiptsPerDay, 1))),
          'var(--primary)', 'var(--blue)')}
        <div style="display:flex;gap:18px;margin-top:8px;font-size:12.5px;color:var(--muted)">
          <span><span class="dot" style="background:var(--primary)"></span>Amount collected</span>
          <span><span class="dot" style="background:var(--blue)"></span>Receipts issued</span>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Fee Status of Students</h3></div>
        <div class="lib-donut-wrap">
          <div class="lib-donut" style="background:${segments.length ? donutGradient(segments) : 'var(--primary-light)'}">
            <div class="lib-donut-center"><strong>${collPct}%</strong><span>Collected</span></div>
          </div>
          <div class="lib-legend">
            <div class="lib-legend-head"><span>Status</span><span>Students</span></div>
            ${segments.length ? segments.map(s => `<div class="lib-legend-row">
              <span class="dotlbl"><span class="ldot" style="background:${s.color}"></span>${esc(s.label)}</span>
              <span>${s.value}</span></div>`).join('') : '<p class="empty">No fee records yet.</p>'}
          </div>
        </div>
      </div>
    </div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Recent Fee Payments</h3>
      <div class="panel-tools">
        <input class="search-box" id="dashSearch" placeholder="Search receipt / student...">
        <button class="btn-primary btn-sm" id="dashCollect">💰 Collect Fee</button>
      </div></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Receipt No</th><th>Student</th><th>Reg No</th><th>Amount</th><th>Mode</th><th>Date</th><th></th>
      </tr></thead><tbody id="dashPayBody"></tbody></table></div></div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Recent Transactions</h3>
      <span style="font-size:12px;color:var(--muted)">Fee receipts, fee-structure changes and asset purchases</span></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Date</th><th>Type</th><th>Particulars</th><th style="text-align:right">Amount</th><th>Reference</th>
      </tr></thead><tbody>${recentTransactionRows()}</tbody></table></div></div>`;

    viewDashboard.after = () => {
      const drawPayments = () => {
        const q = ($('#dashSearch').value || '').trim().toLowerCase();
        const rows = recent.filter(p => {
          if (!q) return true;
          const s = Store.find('students', p.studentId) || {};
          return [p.receiptNo, s.name, s.roll, p.txnId].some(v => String(v || '').toLowerCase().includes(q));
        });
        $('#dashPayBody').innerHTML = rows.length ? rows.map(p => {
          const s = Store.find('students', p.studentId) || {};
          return `<tr><td class="mono">${esc(p.receiptNo)}</td><td>${esc(s.name || '—')}</td>
            <td>${esc(s.roll || '—')}</td><td style="text-align:right;font-weight:600">${money(p.amount)}</td>
            <td><span class="pill blue">${esc(p.mode || '—')}</span></td><td>${esc(p.date)}</td>
            <td><button class="btn-sm btn-outline" data-rcpt="${p.id}">🧾 Receipt</button></td></tr>`;
        }).join('') : `<tr><td colspan="7" class="empty">No fee payments recorded yet.</td></tr>`;
        $('#dashPayBody').querySelectorAll('[data-rcpt]').forEach(b =>
          b.onclick = () => printReceipt(b.dataset.rcpt));
      };
      $('#dashSearch').oninput = drawPayments;
      $('#dashCollect').onclick = () => navigate('feecollect');
      drawPayments();
    };
    return html;
  }

  // a single activity feed across the finance collections
  function recentTransactionRows() {
    const txns = [];
    Store.all('payments').forEach(p => {
      const s = Store.find('students', p.studentId) || {};
      txns.push({
        date: p.date || '', type: 'Fee Receipt', pill: 'green',
        what: `${s.name || 'Unknown student'} — ${p.mode || 'payment'}`,
        amount: +p.amount || 0, ref: p.receiptNo || p.id,
      });
    });
    Store.all('assets').forEach(a => txns.push({
      date: a.purchaseDate || '', type: 'Asset Purchase', pill: 'amber',
      what: `${a.name} × ${a.quantity || 1} (${a.category || 'Other'})`,
      amount: +a.purchaseCost || 0, ref: a.id,
    }));
    Store.all('fixedfees').forEach(f => txns.push({
      date: f.effectiveFrom || '', type: 'Fee Structure', pill: 'blue',
      what: `${f.feeType} — ${f.course} / ${f.branch} / ${f.academicYear}`,
      amount: +f.amount || 0, ref: f.id,
    }));
    const rows = txns.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10);
    if (!rows.length) return `<tr><td colspan="5" class="empty">No transactions yet.</td></tr>`;
    return rows.map(t => `<tr><td>${esc(t.date || '—')}</td>
      <td><span class="pill ${t.pill}">${esc(t.type)}</span></td>
      <td>${esc(t.what)}</td><td style="text-align:right;font-weight:600">${money(t.amount)}</td>
      <td class="mono">${esc(t.ref)}</td></tr>`).join('');
  }

  /* =========================== STUDENT LIST =========================== */
  function viewFinStudents() {
    const html = `<div class="panel"><div class="panel-head"><h3>Students — Fee Overview</h3>
      <div class="panel-tools">${exportButtons('fs')}</div></div>
      ${finFilterBar('fs', { extra: `<select class="filter-sel" id="fsStatus">
        <option value="">All Fee Statuses</option><option>Paid</option><option>Partial</option>
        <option>Unpaid</option><option>No Fee Set</option></select>` })}
      <div id="fsStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Student ID</th><th>Student Name</th><th>Course</th><th>Specialisation</th><th>Sem</th>
        <th>Academic Year</th><th style="text-align:right">Total Fee</th><th style="text-align:right">Paid Fee</th>
        <th style="text-align:right">Pending Fee</th><th>Fee Status</th><th>Actions</th>
      </tr></thead><tbody id="fsBody"></tbody></table></div><div id="fsPager"></div></div>`;

    viewFinStudents.after = () => {
      let page = 1;
      const filtered = () => {
        const f = finFilterValues('fs', ['Status']);
        return financeRows().filter(r => matchesFinFilters(r, f) && (!f.status || r.status === f.status));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const sum = rows.reduce((a, r) => ({
          total: a.total + r.total, paid: a.paid + r.paid, pending: a.pending + r.pending,
        }), { total: 0, paid: 0, pending: 0 });
        $('#fsStats').innerHTML = `${statCard('🎓', rows.length, 'Students Listed')}
          ${statCard('💰', money(sum.total), 'Total Fee')}
          ${statCard('✅', money(sum.paid), 'Collected', 'c3')}
          ${statCard('⏳', money(sum.pending), 'Pending', sum.pending ? 'c4' : 'c3')}`;
        $('#fsBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td class="mono">${esc(r.roll || r.sid)}</td><td>${esc(r.name)}</td><td>${esc(r.course)}</td>
          <td>${esc(r.branch)}</td><td>${esc(r.semester || '—')}</td><td>${esc(r.academicYear)}</td>
          <td style="text-align:right">${money(r.total)}</td>
          <td style="text-align:right;color:var(--green)">${money(r.paid)}</td>
          <td style="text-align:right;${r.pending ? 'color:var(--red);font-weight:600' : ''}">${money(r.pending)}</td>
          <td><span class="pill ${r.pill}">${esc(r.status)}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${r.sid}" title="Student details">👁 View</button>
            <button class="btn-sm btn-edit" data-fee="${r.sid}" title="Fee details">💳 Fees</button>
            <button class="btn-sm btn-outline" data-hist="${r.sid}" title="Payment history">🧾 History</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="11" class="empty">No students match these filters.</td></tr>`;
        $('#fsBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => studentDetailsModal(b.dataset.view));
        $('#fsBody').querySelectorAll('[data-fee]').forEach(b => b.onclick = () => studentFeeModal(b.dataset.fee));
        $('#fsBody').querySelectorAll('[data-hist]').forEach(b => b.onclick = () => studentHistoryModal(b.dataset.hist));
        $('#fsPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#fsPager'), rows.length, page, (p) => page = p, draw);
      };
      bindFinFilters('fs', ['Status'], () => { page = 1; draw(); });
      bindExports('fs', () => {
        const rows = filtered();
        return {
          title: 'Student Fee Report', sheetName: 'Students', subtitle: reportStamp(),
          columns: [
            { header: 'Student ID', key: 'roll', width: 14 },
            { header: 'Student Name', key: 'name', width: 26 },
            { header: 'Course', key: 'course', width: 12 },
            { header: 'Specialisation', key: 'branch', width: 12 },
            { header: 'Semester', key: 'semester', width: 10, type: 'number' },
            { header: 'Academic Year', key: 'academicYear', width: 15 },
            { header: 'Total Fee', key: 'total', width: 14, money: true },
            { header: 'Paid Fee', key: 'paid', width: 14, money: true },
            { header: 'Pending Fee', key: 'pending', width: 14, money: true },
            { header: 'Due Date', key: 'dueDate', width: 13 },
            { header: 'Fee Status', key: 'status', width: 13 },
          ],
          rows,
          totals: {
            roll: 'TOTAL', name: rows.length + ' students',
            total: rows.reduce((a, r) => a + r.total, 0),
            paid: rows.reduce((a, r) => a + r.paid, 0),
            pending: rows.reduce((a, r) => a + r.pending, 0),
          },
        };
      });
      draw();
    };
    return html;
  }

  function studentDetailsModal(sid) {
    const s = Store.find('students', sid);
    if (!s) return;
    const r = financeRows().find(x => x.sid === sid) || { total: 0, paid: 0, pending: 0 };
    openModal('Student Details — ' + s.name, `
      <div style="display:flex;gap:18px;align-items:center;margin-bottom:18px">
        <div class="logo-circle">${s.photo ? `<img src="${esc(s.photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((s.name || '?')[0])}</div>
        <div><h3 style="color:var(--primary-dark)">${esc(s.name)}</h3>
        <p style="color:var(--muted);font-size:13px">${esc(s.roll)} · ${esc(s.course || '—')} · ${esc(s.branch || '—')}</p></div>
      </div>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('💰', money(r.total), 'Total Fee')}
        ${statCard('✅', money(r.paid), 'Paid', 'c3')}
        ${statCard('⏳', money(r.pending), 'Pending', r.pending ? 'c4' : 'c3')}
      </div>
      <div class="tbl-wrap"><table><tbody>
        <tr><td style="font-weight:600;width:170px">Student ID</td><td>${esc(s.roll)}</td></tr>
        <tr><td style="font-weight:600">Course</td><td>${esc(s.course || '—')}</td></tr>
        <tr><td style="font-weight:600">Specialisation</td><td>${esc(s.branch || '—')}</td></tr>
        <tr><td style="font-weight:600">Year / Semester</td><td>${esc(s.year || '—')} / ${esc(s.semester || '—')}</td></tr>
        <tr><td style="font-weight:600">Section</td><td>${esc(s.section || '—')}</td></tr>
        <tr><td style="font-weight:600">Academic Year</td><td>${esc(s.academicYear || '—')}</td></tr>
        <tr><td style="font-weight:600">Email</td><td>${esc(s.email || '—')}</td></tr>
        <tr><td style="font-weight:600">Phone</td><td>${esc(s.phone || '—')}</td></tr>
      </tbody></table></div>
      <div class="form-actions"><button class="btn-outline" id="cx">Close</button>
        <button class="btn-primary" id="goFees">💳 Fee Details</button></div>`, true);
    $('#cx').onclick = closeModal;
    $('#goFees').onclick = () => studentFeeModal(sid);
  }

  function studentFeeModal(sid) {
    const s = Store.find('students', sid);
    if (!s) return;
    const rows = feeRowsOf(sid);
    const total = rows.reduce((a, f) => a + (+f.total || 0), 0);
    const paid = rows.reduce((a, f) => a + Math.min(+f.total || 0, +f.paid || 0), 0);
    openModal('Fee Details — ' + s.name, `
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
        ${esc(s.roll)} · ${esc(s.course || '—')} · ${esc(s.branch || '—')} · ${esc(s.academicYear || '—')}</p>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('💰', money(total), 'Total Fee')}
        ${statCard('✅', money(paid), 'Paid', 'c3')}
        ${statCard('⏳', money(Math.max(0, total - paid)), 'Pending', total - paid > 0 ? 'c4' : 'c3')}
      </div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Semester</th><th>Academic Year</th><th style="text-align:right">Total</th>
        <th style="text-align:right">Paid</th><th style="text-align:right">Pending</th>
        <th>Due Date</th><th>Status</th>
      </tr></thead><tbody>${rows.length ? rows.map(f => {
        const pend = Math.max(0, (+f.total || 0) - (+f.paid || 0));
        const st = feeStatusOf(f.total, f.paid);
        return `<tr><td>${esc(f.semester || '—')}</td><td>${esc(f.academicYear || '—')}</td>
          <td style="text-align:right">${money(f.total)}</td><td style="text-align:right">${money(f.paid)}</td>
          <td style="text-align:right${pend ? ';color:var(--red);font-weight:600' : ''}">${money(pend)}</td>
          <td>${esc(f.dueDate || '—')}</td><td><span class="pill ${st.pill}">${st.label}</span></td></tr>`;
      }).join('') : `<tr><td colspan="7" class="empty">No fee record for this student yet.</td></tr>`}
      </tbody></table></div>
      <div class="form-actions"><button class="btn-outline" id="cx">Close</button>
        ${readOnly() ? `<button class="btn-primary" id="goHistory">🧾 Payment History</button>`
          : `<button class="btn-primary" id="goCollect">💰 Collect Fee</button>`}</div>`, true);
    $('#cx').onclick = closeModal;
    if (readOnly()) $('#goHistory').onclick = () => studentHistoryModal(sid);
    else $('#goCollect').onclick = () => collectFeeForm(sid);
  }

  function studentHistoryModal(sid) {
    const s = Store.find('students', sid);
    if (!s) return;
    const rows = paymentsOf(sid);
    const paidSum = rows.reduce((a, p) => a + (+p.amount || 0), 0);
    openModal('Payment History — ' + s.name, `
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
        ${esc(s.roll)} · ${rows.length} receipt(s) · ${money(paidSum)} received</p>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Receipt No</th><th>Date</th><th style="text-align:right">Amount</th>
        <th>Mode</th><th>Transaction ID</th><th>Status</th><th></th>
      </tr></thead><tbody>${rows.length ? rows.map(p => `<tr>
        <td class="mono">${esc(p.receiptNo)}</td><td>${esc(p.date)}</td>
        <td style="text-align:right;font-weight:600">${money(p.amount)}</td>
        <td>${esc(p.mode || '—')}</td><td class="mono">${esc(p.txnId || '—')}</td>
        <td><span class="pill green">${esc(p.status || 'Success')}</span></td>
        <td><button class="btn-sm btn-outline" data-rc="${p.id}">🧾 Receipt</button></td></tr>`).join('')
        : `<tr><td colspan="7" class="empty">No payments recorded for this student.</td></tr>`}
      </tbody></table></div>
      <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
    $('#modalBody').querySelectorAll('[data-rc]').forEach(b => b.onclick = () => printReceipt(b.dataset.rc));
  }

  /* =========================== ASSET LIST =========================== */
  function viewAssets() {
    const canEdit = !readOnly();
    const html = (readOnly() ? readOnlyBanner('Assets are maintained by the accounts office. '
      + 'You can search, filter, view, print and export them.') : '') +
      `<div class="panel"><div class="panel-head"><h3>Asset Register</h3>
      <div class="panel-tools">${exportButtons('as')}
        ${canEdit ? `<button class="btn-primary" id="asAdd">+ Add Asset</button>` : ''}</div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="asQ" placeholder="Search asset / vendor / location...">
        <select class="filter-sel" id="asCat"><option value="">All Categories</option>${listOptions('assetCategory')}</select>
        <select class="filter-sel" id="asStatus"><option value="">All Statuses</option>${optionsFrom(ASSET_STATUS)}</select>
        <button class="btn-outline btn-sm" id="asClear">Clear</button>
      </div>
      <div id="asStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Asset ID</th><th>Asset Name</th><th>Category</th><th style="text-align:right">Qty</th>
        <th>Purchase Date</th><th style="text-align:right">Purchase Cost</th><th style="text-align:right">Current Value</th>
        <th>Vendor</th><th>Location</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="asBody"></tbody></table></div><div id="asPager"></div></div>`;

    viewAssets.after = () => {
      let page = 1;
      const filtered = () => {
        const q = ($('#asQ').value || '').trim().toLowerCase();
        const cat = $('#asCat').value, st = $('#asStatus').value;
        return Store.all('assets').filter(a =>
          (!q || [a.id, a.name, a.vendor, a.location, a.category].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!cat || a.category === cat) && (!st || a.status === st))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const qty = rows.reduce((a, x) => a + (+x.quantity || 0), 0);
        const cost = rows.reduce((a, x) => a + (+x.purchaseCost || 0), 0);
        const value = rows.reduce((a, x) => a + (+x.currentValue || 0), 0);
        $('#asStats').innerHTML = `${statCard('🏢', rows.length, 'Asset Entries')}
          ${statCard('🔢', qty, 'Total Units', 'c2')}
          ${statCard('💵', money(cost), 'Purchase Cost')}
          ${statCard('📉', money(value), 'Current Value', 'c3')}`;
        $('#asBody').innerHTML = rows.length ? pageSlice(rows, page).map(a => {
          const pill = { 'In Use': 'green', 'In Store': 'blue', 'Under Maintenance': 'amber',
                         Damaged: 'red', Disposed: 'red' }[a.status] || 'blue';
          return `<tr><td class="mono">${esc(a.id)}</td><td>${esc(a.name)}</td><td>${esc(a.category || '—')}</td>
            <td style="text-align:right">${a.quantity ?? '—'}</td><td>${esc(a.purchaseDate || '—')}</td>
            <td style="text-align:right">${money(a.purchaseCost)}</td>
            <td style="text-align:right">${money(a.currentValue)}</td>
            <td>${esc(a.vendor || '—')}</td><td>${esc(a.location || '—')}</td>
            <td><span class="pill ${pill}">${esc(a.status || '—')}</span></td>
            <td><div class="row-actions">
              <button class="btn-sm btn-outline" data-view="${a.id}">👁 View</button>
              ${canEdit ? `<button class="btn-sm btn-edit" data-edit="${a.id}">Edit</button>
              <button class="btn-sm btn-del" data-del="${a.id}">Delete</button>` : ''}
            </div></td></tr>`;
        }).join('') : `<tr><td colspan="11" class="empty">No assets match these filters.</td></tr>`;
        $('#asBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => assetViewModal(b.dataset.view));
        if (canEdit) {
          $('#asBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => assetForm(b.dataset.edit, draw));
          $('#asBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
            const a = Store.find('assets', b.dataset.del) || {};
            confirmDelete('Delete Asset', `Delete <b>${esc(a.name)}</b> (${esc(a.id)}) worth
              <b>${money(a.currentValue)}</b> from the asset register? This cannot be undone.`,
              'Delete Asset', () => { Store.remove('assets', a.id); toast('Asset deleted.', 'err'); draw(); });
          });
        }
        $('#asPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#asPager'), rows.length, page, (p) => page = p, draw);
      };
      ['asQ', 'asCat', 'asStatus'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#asClear').onclick = () => {
        $('#asQ').value = ''; $('#asCat').value = ''; $('#asStatus').value = '';
        page = 1; draw();
      };
      if (canEdit) $('#asAdd').onclick = () => assetForm(null, draw);
      bindExports('as', () => {
        const rows = filtered();
        return {
          title: 'Asset Report', sheetName: 'Assets', subtitle: reportStamp(),
          columns: [
            { header: 'Asset ID', key: 'id', width: 10, align: 'center' },
            { header: 'Asset Name', key: 'name', width: 30 },
            { header: 'Category', key: 'category', width: 20 },
            { header: 'Quantity', key: 'quantity', width: 10, type: 'number' },
            { header: 'Purchase Date', key: 'purchaseDate', width: 14 },
            { header: 'Purchase Cost', key: 'purchaseCost', width: 16, money: true },
            { header: 'Current Value', key: 'currentValue', width: 16, money: true },
            { header: 'Vendor', key: 'vendor', width: 22 },
            { header: 'Location', key: 'location', width: 20 },
            { header: 'Status', key: 'status', width: 16 },
          ],
          rows,
          totals: {
            id: 'TOTAL', name: rows.length + ' entries',
            quantity: rows.reduce((a, x) => a + (+x.quantity || 0), 0),
            purchaseCost: rows.reduce((a, x) => a + (+x.purchaseCost || 0), 0),
            currentValue: rows.reduce((a, x) => a + (+x.currentValue || 0), 0),
          },
        };
      });
      draw();
    };
    return html;
  }

  function assetViewModal(id) {
    const a = Store.find('assets', id);
    if (!a) return;
    const dep = (+a.purchaseCost || 0) - (+a.currentValue || 0);
    openModal('Asset — ' + a.name, `<div class="tbl-wrap"><table><tbody>
      <tr><td style="font-weight:600;width:180px">Asset ID</td><td class="mono">${esc(a.id)}</td></tr>
      <tr><td style="font-weight:600">Asset Name</td><td>${esc(a.name)}</td></tr>
      <tr><td style="font-weight:600">Category</td><td>${esc(a.category || '—')}</td></tr>
      <tr><td style="font-weight:600">Quantity</td><td>${a.quantity ?? '—'}</td></tr>
      <tr><td style="font-weight:600">Purchase Date</td><td>${esc(a.purchaseDate || '—')}</td></tr>
      <tr><td style="font-weight:600">Purchase Cost</td><td>${money(a.purchaseCost)}</td></tr>
      <tr><td style="font-weight:600">Current Value</td><td>${money(a.currentValue)}</td></tr>
      <tr><td style="font-weight:600">Depreciation</td><td>${money(Math.max(0, dep))}</td></tr>
      <tr><td style="font-weight:600">Vendor</td><td>${esc(a.vendor || '—')}</td></tr>
      <tr><td style="font-weight:600">Location</td><td>${esc(a.location || '—')}</td></tr>
      <tr><td style="font-weight:600">Status</td><td>${esc(a.status || '—')}</td></tr>
    </tbody></table></div>
    <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`);
    $('#cx').onclick = closeModal;
  }

  function assetForm(id, after) {
    const a = id ? (Store.find('assets', id) || {}) : {};
    openModal((id ? 'Edit' : 'Add') + ' Asset', `<form id="f"><div class="form-grid">
      <div class="field full"><label>Asset Name</label><input name="name" value="${esc(a.name || '')}" required></div>
      <div class="field"><label>Asset Category</label>
        <select name="category" id="asFormCat">${listOptions('assetCategory', a.category, true)}</select></div>
      <div class="field"><label>Quantity</label><input name="quantity" type="number" min="1" step="1" value="${a.quantity || 1}" required></div>
      <div class="field"><label>Purchase Date</label><input name="purchaseDate" type="date" value="${esc(a.purchaseDate || today())}" required></div>
      <div class="field"><label>Purchase Cost (₹)</label><input name="purchaseCost" id="asCost" inputmode="numeric" value="${a.purchaseCost || ''}" required></div>
      <div class="field"><label>Current Value (₹)</label><input name="currentValue" id="asVal" inputmode="numeric" value="${a.currentValue ?? ''}" required></div>
      <div class="field"><label>Vendor</label><input name="vendor" value="${esc(a.vendor || '')}"></div>
      <div class="field"><label>Location</label><input name="location" value="${esc(a.location || '')}"></div>
      <div class="field"><label>Asset Status</label><select name="status">${optionsFrom(ASSET_STATUS, a.status || 'In Use')}</select></div>
    </div>
    <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
      <button type="submit" class="btn-primary">Save Asset</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindAmountInput($('#asCost'));
    bindAmountInput($('#asVal'));
    bindCustomList($('#asFormCat'), 'assetCategory');
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const qty = parseAmount(d.quantity, { min: 1 });
      const cost = parseAmount(d.purchaseCost, { min: 0 });
      const value = parseAmount(d.currentValue, { min: 0 });
      if (qty === null) { toast('Quantity must be a whole number of at least 1.', 'err'); return; }
      if (cost === null) { toast('Purchase cost must be a whole rupee amount.', 'err'); return; }
      if (value === null) { toast('Current value must be a whole rupee amount.', 'err'); return; }
      if (value > cost) { toast('Current value cannot be more than the purchase cost.', 'err'); return; }
      if (d.purchaseDate > today()) { toast('Purchase date cannot be in the future.', 'err'); return; }
      const record = { ...d, quantity: qty, purchaseCost: cost, currentValue: value };
      const save = () => {
        if (id) Store.update('assets', id, record); else Store.add('assets', record);
        closeModal(); toast('Asset saved.'); after ? after() : render();
      };
      if (id) confirmAction('Update Asset', `Save the changes to <b>${esc(record.name)}</b>?
        Current value will be recorded as <b>${money(value)}</b>.`, 'Save Changes', save);
      else save();
    };
  }

  /* =========================== FIXED FEE =========================== */
  function viewFixedFee() {
    const canEdit = !readOnly();
    const html = (readOnly() ? readOnlyBanner('The fee structure is set by the accounts office. '
      + 'You can view, filter, print and export it.') : '') +
      `<div class="panel"><div class="panel-head"><h3>Fixed Fee Structure</h3>
      <div class="panel-tools">${exportButtons('ff')}
        ${canEdit ? `<button class="btn-primary" id="ffAdd">+ Add Fixed Fee</button>` : ''}</div></div>
      ${finFilterBar('ff', {
        placeholder: 'Search course / branch / fee type...', noSem: true,
        extra: `<select class="filter-sel" id="ffType"><option value="">All Fee Types</option>${listOptions('feeType')}</select>
          <select class="filter-sel" id="ffStatus"><option value="">All Statuses</option>${optionsFrom(STRUCT_STATUS)}</select>`,
      })}
      <div id="ffStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ID</th><th>Course</th><th>Specialisation</th><th>Academic Year</th><th>Fee Type</th>
        <th style="text-align:right">Fixed Amount</th><th>Effective From</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="ffBody"></tbody></table></div><div id="ffPager"></div></div>
      <div class="panel"><div class="panel-head"><h3>Structure Totals</h3>
        <span style="font-size:12px;color:var(--muted)">Active fee heads added up per course, branch and year</span></div>
        <div id="ffSummary"></div></div>`;

    viewFixedFee.after = () => {
      let page = 1;
      const filtered = () => {
        const f = finFilterValues('ff', ['Type', 'Status']);
        return Store.all('fixedfees').filter(r =>
          (!f.q || [r.id, r.course, r.branch, r.feeType, r.academicYear].some(v => String(v || '').toLowerCase().includes(f.q))) &&
          (!f.course || r.course === f.course) &&
          (!f.branch || r.branch === f.branch) &&
          (!f.year || r.academicYear === f.year) &&
          (!f.type || r.feeType === f.type) &&
          (!f.status || (r.status || 'Active') === f.status))
          .sort((a, b) => String(a.course).localeCompare(String(b.course)) ||
            String(a.branch).localeCompare(String(b.branch)) ||
            listValues('feeType').indexOf(a.feeType) - listValues('feeType').indexOf(b.feeType));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const active = rows.filter(r => (r.status || 'Active') === 'Active');
        $('#ffStats').innerHTML = `${statCard('📋', rows.length, 'Fee Heads Listed')}
          ${statCard('✅', active.length, 'Active', 'c3')}
          ${statCard('💰', money(active.reduce((a, r) => a + (+r.amount || 0), 0)), 'Total Fixed Fee', 'c2')}`;
        $('#ffBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td class="mono">${esc(r.id)}</td><td>${esc(r.course || '—')}</td><td>${esc(r.branch || '—')}</td>
          <td>${esc(r.academicYear || '—')}</td><td>${esc(r.feeType || '—')}</td>
          <td style="text-align:right;font-weight:600">${money(r.amount)}</td>
          <td>${esc(r.effectiveFrom || '—')}</td>
          <td><span class="pill ${(r.status || 'Active') === 'Active' ? 'green' : 'red'}">${esc(r.status || 'Active')}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${r.id}">👁 View</button>
            ${canEdit ? `<button class="btn-sm btn-edit" data-edit="${r.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${r.id}">Delete</button>` : ''}
          </div></td></tr>`).join('')
          : `<tr><td colspan="9" class="empty">No fee structure matches these filters.</td></tr>`;
        $('#ffBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => fixedFeeViewModal(b.dataset.view));
        if (canEdit) {
          $('#ffBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => fixedFeeForm(b.dataset.edit, draw));
          $('#ffBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
            const r = Store.find('fixedfees', b.dataset.del) || {};
            confirmDelete('Delete Fixed Fee', `Remove <b>${esc(r.feeType)}</b> of <b>${money(r.amount)}</b>
              for ${esc(r.course)} / ${esc(r.branch)} / ${esc(r.academicYear)} from the fee structure?`,
              'Delete', () => { Store.remove('fixedfees', r.id); toast('Fixed fee deleted.', 'err'); draw(); });
          });
        }
        $('#ffPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#ffPager'), rows.length, page, (p) => page = p, draw);

        // per course/branch/year roll-up of the active heads
        const groups = {};
        rows.filter(r => (r.status || 'Active') === 'Active').forEach(r => {
          const key = `${r.course || '—'}|${r.branch || '—'}|${r.academicYear || '—'}`;
          groups[key] = groups[key] || { course: r.course, branch: r.branch, academicYear: r.academicYear, heads: 0, amount: 0 };
          groups[key].heads++; groups[key].amount += +r.amount || 0;
        });
        const summary = Object.values(groups).sort((a, b) => b.amount - a.amount);
        $('#ffSummary').innerHTML = reportTableHtml([
          { header: 'Course', key: 'course' }, { header: 'Specialisation', key: 'branch' },
          { header: 'Academic Year', key: 'academicYear' }, { header: 'Fee Heads', key: 'heads' },
          { header: 'Total Fixed Fee', key: 'amount', money: true },
        ], summary, 'No active fee heads for these filters.');
      };
      bindFinFilters('ff', ['Type', 'Status'], () => { page = 1; draw(); });
      if (canEdit) $('#ffAdd').onclick = () => fixedFeeForm(null, draw);
      bindExports('ff', () => {
        const rows = filtered();
        return {
          title: 'Fixed Fee Report', sheetName: 'Fixed Fee', subtitle: reportStamp(),
          columns: [
            { header: 'ID', key: 'id', width: 10, align: 'center' },
            { header: 'Course', key: 'course', width: 14 },
            { header: 'Specialisation', key: 'branch', width: 14 },
            { header: 'Academic Year', key: 'academicYear', width: 15 },
            { header: 'Fee Type', key: 'feeType', width: 20 },
            { header: 'Fixed Amount', key: 'amount', width: 16, money: true },
            { header: 'Effective From', key: 'effectiveFrom', width: 15 },
            { header: 'Status', key: 'status', width: 12 },
          ],
          rows,
          totals: { id: 'TOTAL', course: rows.length + ' heads', amount: rows.reduce((a, r) => a + (+r.amount || 0), 0) },
        };
      });
      draw();
    };
    return html;
  }

  function fixedFeeViewModal(id) {
    const r = Store.find('fixedfees', id);
    if (!r) return;
    const siblings = Store.all('fixedfees').filter(x =>
      x.course === r.course && x.branch === r.branch && x.academicYear === r.academicYear &&
      (x.status || 'Active') === 'Active');
    openModal('Fixed Fee — ' + (r.feeType || ''), `<div class="tbl-wrap"><table><tbody>
      <tr><td style="font-weight:600;width:180px">ID</td><td class="mono">${esc(r.id)}</td></tr>
      <tr><td style="font-weight:600">Course</td><td>${esc(r.course || '—')}</td></tr>
      <tr><td style="font-weight:600">Specialisation</td><td>${esc(r.branch || '—')}</td></tr>
      <tr><td style="font-weight:600">Academic Year</td><td>${esc(r.academicYear || '—')}</td></tr>
      <tr><td style="font-weight:600">Fee Type</td><td>${esc(r.feeType || '—')}</td></tr>
      <tr><td style="font-weight:600">Fixed Amount</td><td><b>${money(r.amount)}</b></td></tr>
      <tr><td style="font-weight:600">Effective From</td><td>${esc(r.effectiveFrom || '—')}</td></tr>
      <tr><td style="font-weight:600">Status</td><td>${esc(r.status || 'Active')}</td></tr>
    </tbody></table></div>
    <p style="margin-top:14px;font-size:13px;color:var(--muted)">Total active fee for this course, branch and
      academic year across ${siblings.length} head(s):
      <b style="color:var(--primary-dark)">${money(siblings.reduce((a, x) => a + (+x.amount || 0), 0))}</b></p>
    <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`);
    $('#cx').onclick = closeModal;
  }

  function fixedFeeForm(id, after) {
    const r = id ? (Store.find('fixedfees', id) || {}) : {};
    openModal((id ? 'Edit' : 'Add') + ' Fixed Fee', `<form id="f"><div class="form-grid">
      <div class="field"><label>Course</label><select name="course" id="ffFormCourse">${listOptions('course', r.course, true)}</select></div>
      <div class="field"><label>Specialisation</label><select name="branch" id="ffFormBranch">
        <option value="">All specialisations</option>${specialisationOptions(r.branch, true)}</select></div>
      <div class="field"><label>Academic Year</label><select name="academicYear">${academicYearOptions(r.academicYear)}</select></div>
      <div class="field"><label>Fee Type</label><select name="feeType" id="ffFormType">${listOptions('feeType', r.feeType, true)}</select></div>
      <div class="field"><label>Fixed Amount (₹)</label><input name="amount" id="ffAmt" inputmode="numeric" value="${r.amount || ''}" required></div>
      <div class="field"><label>Effective From</label><input name="effectiveFrom" type="date" value="${esc(r.effectiveFrom || today())}" required></div>
      <div class="field"><label>Status</label><select name="status">${optionsFrom(STRUCT_STATUS, r.status || 'Active')}</select></div>
    </div>
    <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
      <button type="submit" class="btn-primary">Save Fixed Fee</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindAmountInput($('#ffAmt'));
    bindCustomList($('#ffFormBranch'), 'specialisation');
    bindCustomList($('#ffFormCourse'), 'course');
    bindCustomList($('#ffFormType'), 'feeType');
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const amount = parseAmount(d.amount, { min: 1 });
      if (amount === null) { toast('Amount must be a whole rupee value of at least ₹1.', 'err'); return; }
      const clash = Store.all('fixedfees').find(x => x.id !== id &&
        x.course === d.course && x.branch === d.branch &&
        x.academicYear === d.academicYear && x.feeType === d.feeType);
      if (clash) { toast(`${d.feeType} already exists for ${d.course} / ${d.branch} / ${d.academicYear}.`, 'err'); return; }
      const record = { ...d, amount };
      const save = () => {
        if (id) Store.update('fixedfees', id, record); else Store.add('fixedfees', record);
        closeModal(); toast('Fixed fee saved.'); after ? after() : render();
      };
      confirmAction(id ? 'Update Fixed Fee' : 'Add Fixed Fee',
        `Set <b>${esc(d.feeType)}</b> to <b>${money(amount)}</b> for
         ${esc(d.course)} / ${esc(d.branch)} / ${esc(d.academicYear)}, effective ${esc(d.effectiveFrom)}?`,
        id ? 'Save Changes' : 'Add Fee', save);
    };
  }

  /* =========================== SEMESTER-WISE FEE =========================== */
  function viewSemFee() {
    const canEdit = !readOnly();
    const html = (readOnly() ? readOnlyBanner('Semester fee records are maintained by the accounts office.') : '') +
      `<div class="panel"><div class="panel-head"><h3>Semester-wise Fee Records</h3>
      <div class="panel-tools">${exportButtons('sf')}
        ${canEdit ? `<button class="btn-primary" id="sfAdd">+ Add Semester Fee</button>` : ''}</div></div>
      ${finFilterBar('sf')}
      <div id="sfStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Student</th><th>Reg No</th><th>Course</th><th>Specialisation</th><th>Semester</th><th>Academic Year</th>
        <th style="text-align:right">Total Fee</th><th style="text-align:right">Paid</th>
        <th style="text-align:right">Pending</th><th>Due Date</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="sfBody"></tbody></table></div><div id="sfPager"></div></div>
      <div class="panel"><div class="panel-head"><h3>Semester Summary</h3></div><div id="sfSummary"></div></div>`;

    viewSemFee.after = () => {
      let page = 1;
      // one row per fee record, carrying its student's identity for filtering
      const allRows = () => Store.all('fees').map(f => {
        const s = Store.find('students', f.studentId) || {};
        const pending = Math.max(0, (+f.total || 0) - (+f.paid || 0));
        const st = feeStatusOf(f.total, f.paid);
        return {
          id: f.id, sid: f.studentId, name: s.name || 'Unknown student', roll: s.roll || '—',
          course: s.course || '—', branch: specOf(s) || '—',
          semester: f.semester || s.semester || '', academicYear: f.academicYear || s.academicYear || '—',
          total: +f.total || 0, paid: Math.min(+f.total || 0, +f.paid || 0), pending,
          dueDate: f.dueDate || '—', status: st.label, pill: st.pill,
        };
      }).sort((a, b) => String(a.roll).localeCompare(String(b.roll)) || (+a.semester || 0) - (+b.semester || 0));
      const filtered = () => {
        const f = finFilterValues('sf');
        return allRows().filter(r => matchesFinFilters(r, f));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const sum = rows.reduce((a, r) => ({
          total: a.total + r.total, paid: a.paid + r.paid, pending: a.pending + r.pending,
        }), { total: 0, paid: 0, pending: 0 });
        $('#sfStats').innerHTML = `${statCard('📆', rows.length, 'Fee Records')}
          ${statCard('💰', money(sum.total), 'Total Fee')}
          ${statCard('✅', money(sum.paid), 'Collected', 'c3')}
          ${statCard('⏳', money(sum.pending), 'Pending', sum.pending ? 'c4' : 'c3')}`;
        $('#sfBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td>${esc(r.name)}</td><td class="mono">${esc(r.roll)}</td><td>${esc(r.course)}</td>
          <td>${esc(r.branch)}</td><td>${esc(r.semester || '—')}</td><td>${esc(r.academicYear)}</td>
          <td style="text-align:right">${money(r.total)}</td>
          <td style="text-align:right;color:var(--green)">${money(r.paid)}</td>
          <td style="text-align:right;${r.pending ? 'color:var(--red);font-weight:600' : ''}">${money(r.pending)}</td>
          <td>${esc(r.dueDate)}</td><td><span class="pill ${r.pill}">${esc(r.status)}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${r.id}">👁 View</button>
            ${canEdit ? `<button class="btn-sm btn-edit" data-edit="${r.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${r.id}">Delete</button>` : ''}
          </div></td></tr>`).join('')
          : `<tr><td colspan="12" class="empty">No semester fee records match these filters.</td></tr>`;
        $('#sfBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
          const f = Store.find('fees', b.dataset.view);
          if (f) studentFeeModal(f.studentId);
        });
        if (canEdit) {
          $('#sfBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => semFeeForm(b.dataset.edit, draw));
          $('#sfBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
            const f = Store.find('fees', b.dataset.del) || {};
            const s = Store.find('students', f.studentId) || {};
            confirmDelete('Delete Fee Record', `Delete the Semester ${esc(f.semester || '—')} fee record of
              <b>${esc(s.name || '—')}</b> (${money(f.total)}, ${money(f.paid)} already paid)?
              Receipts already issued will stay in the payment history.`,
              'Delete Record', () => { Store.remove('fees', f.id); toast('Fee record deleted.', 'err'); draw(); });
          });
        }
        $('#sfPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#sfPager'), rows.length, page, (p) => page = p, draw);

        const bySem = {};
        rows.forEach(r => {
          const key = r.semester || '—';
          bySem[key] = bySem[key] || { semester: 'Semester ' + key, students: 0, total: 0, paid: 0, pending: 0 };
          bySem[key].students++; bySem[key].total += r.total;
          bySem[key].paid += r.paid; bySem[key].pending += r.pending;
        });
        $('#sfSummary').innerHTML = reportTableHtml([
          { header: 'Semester', key: 'semester' }, { header: 'Records', key: 'students' },
          { header: 'Total Fee', key: 'total', money: true }, { header: 'Collected', key: 'paid', money: true },
          { header: 'Pending', key: 'pending', money: true },
        ], Object.values(bySem), 'No records for these filters.');
      };
      bindFinFilters('sf', [], () => { page = 1; draw(); });
      if (canEdit) $('#sfAdd').onclick = () => semFeeForm(null, draw);
      bindExports('sf', () => {
        const rows = filtered();
        return {
          title: 'Semester-wise Fee Report', sheetName: 'Semester Fee', subtitle: reportStamp(),
          columns: [
            { header: 'Reg No', key: 'roll', width: 14 },
            { header: 'Student Name', key: 'name', width: 26 },
            { header: 'Course', key: 'course', width: 12 },
            { header: 'Specialisation', key: 'branch', width: 12 },
            { header: 'Semester', key: 'semester', width: 10, type: 'number' },
            { header: 'Academic Year', key: 'academicYear', width: 15 },
            { header: 'Total Fee', key: 'total', width: 14, money: true },
            { header: 'Paid Amount', key: 'paid', width: 14, money: true },
            { header: 'Pending Amount', key: 'pending', width: 15, money: true },
            { header: 'Due Date', key: 'dueDate', width: 13 },
            { header: 'Status', key: 'status', width: 12 },
          ],
          rows,
          totals: {
            roll: 'TOTAL', name: rows.length + ' records',
            total: rows.reduce((a, r) => a + r.total, 0),
            paid: rows.reduce((a, r) => a + r.paid, 0),
            pending: rows.reduce((a, r) => a + r.pending, 0),
          },
        };
      });
      draw();
    };
    return html;
  }

  function semFeeForm(id, after) {
    const f = id ? (Store.find('fees', id) || {}) : {};
    const s = f.studentId ? (Store.find('students', f.studentId) || {}) : {};
    openModal((id ? 'Edit' : 'Add') + ' Semester Fee', `<form id="f"><div class="form-grid">
      <div class="field full"><label>Student</label>
        <select name="studentId" id="sffStudent" ${id ? 'disabled' : ''} required>
          ${id ? '' : '<option value="">Select a student…</option>'}${studentOptions(f.studentId)}
        </select>
        ${id ? `<input type="hidden" name="studentId" value="${esc(f.studentId)}">` : ''}</div>
      <div class="field"><label>Course</label><input id="sffCourse" value="${esc(s.course || '—')}" disabled></div>
      <div class="field"><label>Specialisation</label><input id="sffBranch" value="${esc(s.branch || '—')}" disabled></div>
      <div class="field"><label>Semester</label><select name="semester" id="sffSem">${semesterOptions(f.semester || s.semester)}</select></div>
      <div class="field"><label>Academic Year</label><select name="academicYear" id="sffYear">${academicYearOptions(f.academicYear || s.academicYear)}</select></div>
      <div class="field"><label>Total Fee (₹)</label><input name="total" id="sffTotal" inputmode="numeric" value="${f.total || ''}" required></div>
      <div class="field"><label>Paid Amount (₹)</label><input name="paid" id="sffPaid" inputmode="numeric" value="${f.paid || 0}" required></div>
      <div class="field"><label>Due Date</label><input name="dueDate" type="date" value="${esc(f.dueDate || '')}" required></div>
      <div class="field full"><p id="sffHint" style="font-size:12.5px;color:var(--muted)"></p></div>
    </div>
    <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
      <button type="submit" class="btn-primary">Save Fee Record</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindAmountInput($('#sffTotal'));
    bindAmountInput($('#sffPaid'));

    // reflect the chosen student and offer the amount from the fixed fee structure
    const syncStudent = () => {
      const st = Store.find('students', $('#sffStudent').value) || {};
      $('#sffCourse').value = st.course || '—';
      $('#sffBranch').value = st.branch || '—';
      if (!id && st.semester) $('#sffSem').value = st.semester;
      if (!id && st.academicYear) $('#sffYear').value = st.academicYear;
      const suggested = structureTotalFor(st.course, st.branch, $('#sffYear').value);
      $('#sffHint').innerHTML = suggested
        ? `Fee structure for ${esc(st.course || '—')} / ${esc(st.branch || '—')} / ${esc($('#sffYear').value)}
           totals <b>${money(suggested)}</b>. <a href="#" id="sffUse">Use this amount</a>.`
        : 'No matching fixed fee structure — enter the total manually.';
      const use = $('#sffUse');
      if (use) use.onclick = (ev) => { ev.preventDefault(); $('#sffTotal').value = suggested; };
    };
    $('#sffStudent').onchange = syncStudent;
    $('#sffYear').onchange = syncStudent;
    if (f.studentId || !id) syncStudent();

    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const sid = d.studentId || f.studentId;
      if (!sid) { toast('Please select a student.', 'err'); return; }
      const total = parseAmount(d.total, { min: 1 });
      const paid = parseAmount(d.paid, { min: 0 });
      if (total === null) { toast('Total fee must be a whole rupee value of at least ₹1.', 'err'); return; }
      if (paid === null) { toast('Paid amount must be a whole rupee value.', 'err'); return; }
      if (paid > total) { toast('Paid amount cannot be more than the total fee.', 'err'); return; }
      const dup = Store.all('fees').find(x => x.id !== id && x.studentId === sid &&
        String(x.semester) === String(d.semester) && x.academicYear === d.academicYear);
      if (dup) { toast('This student already has a fee record for that semester and year.', 'err'); return; }
      const record = {
        studentId: sid, semester: +d.semester, academicYear: d.academicYear,
        total, paid, dueDate: d.dueDate,
      };
      const st = Store.find('students', sid) || {};
      const save = () => {
        if (id) Store.update('fees', id, record); else Store.add('fees', record);
        closeModal(); toast('Semester fee saved.'); after ? after() : render();
      };
      confirmAction(id ? 'Update Fee Record' : 'Add Fee Record',
        `${id ? 'Update' : 'Create'} the Semester ${esc(d.semester)} (${esc(d.academicYear)}) fee record for
         <b>${esc(st.name || '—')}</b> — total <b>${money(total)}</b>, paid <b>${money(paid)}</b>,
         pending <b>${money(total - paid)}</b>?`,
        id ? 'Save Changes' : 'Create Record', save);
    };
  }

  /* =========================== FEE COLLECTION =========================== */
  function nextReceiptNo() {
    const year = new Date().getFullYear();
    const highest = Store.all('payments').reduce((max, p) => {
      const m = String(p.receiptNo || '').match(/(\d+)\s*$/);
      return Math.max(max, m ? +m[1] : 0);
    }, 0);
    return `GIT/${year}/${String(highest + 1).padStart(4, '0')}`;
  }

  function viewFeeCollection() {
    const html = `<div class="stat-grid" id="fcStats"></div>
      <div class="panel"><div class="panel-head"><h3>Collect Fee</h3>
        <div class="panel-tools">
          <button class="btn-outline btn-sm" id="fcGoHistory">🧾 Payment History</button>
          <button class="btn-outline btn-sm" id="fcGoPending">⏳ Pending Fees</button>
        </div></div>
      ${finFilterBar('fc', { extra: `<label class="switch-label">
        <input type="checkbox" id="fcOnlyDue" checked><span>Only students with dues</span></label>` })}
      <div class="tbl-wrap"><table><thead><tr>
        <th>Reg No</th><th>Student Name</th><th>Course</th><th>Specialisation</th><th>Sem</th>
        <th style="text-align:right">Total Fee</th><th style="text-align:right">Paid</th>
        <th style="text-align:right">Pending</th><th>Status</th><th>Action</th>
      </tr></thead><tbody id="fcBody"></tbody></table></div><div id="fcPager"></div></div>
      <div class="panel"><div class="panel-head"><h3>Today's Receipts</h3>
        <span style="font-size:12px;color:var(--muted)">${esc(today())}</span></div>
        <div id="fcToday"></div></div>`;

    viewFeeCollection.after = () => {
      let page = 1;
      const filtered = () => {
        const f = finFilterValues('fc');
        const onlyDue = $('#fcOnlyDue').checked;
        return financeRows().filter(r => matchesFinFilters(r, f) && (!onlyDue || r.pending > 0));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const t = collectionTotals();
        $('#fcStats').innerHTML = `${statCard('🧾', money(collectionOn(today())), "Today's Collection", 'c3')}
          ${statCard('📄', Store.all('payments').filter(p => p.date === today()).length, "Today's Receipts", 'c2')}
          ${statCard('💰', money(t.collected), 'Collected (all time)')}
          ${statCard('⏳', money(t.pending), 'Outstanding', t.pending ? 'c4' : 'c3')}`;
        $('#fcBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td class="mono">${esc(r.roll)}</td><td>${esc(r.name)}</td><td>${esc(r.course)}</td>
          <td>${esc(r.branch)}</td><td>${esc(r.semester || '—')}</td>
          <td style="text-align:right">${money(r.total)}</td>
          <td style="text-align:right;color:var(--green)">${money(r.paid)}</td>
          <td style="text-align:right;${r.pending ? 'color:var(--red);font-weight:600' : ''}">${money(r.pending)}</td>
          <td><span class="pill ${r.pill}">${esc(r.status)}</span></td>
          <td><button class="btn-sm ${r.pending ? 'btn-edit' : 'btn-outline'}" data-collect="${r.sid}"
            ${r.pending ? '' : 'disabled title="Nothing pending"'}>💰 Collect</button></td></tr>`).join('')
          : `<tr><td colspan="10" class="empty">No students match these filters.</td></tr>`;
        $('#fcBody').querySelectorAll('[data-collect]').forEach(b =>
          b.onclick = () => collectFeeForm(b.dataset.collect, draw));
        $('#fcPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#fcPager'), rows.length, page, (p) => page = p, draw);

        const todays = Store.all('payments').filter(p => p.date === today());
        $('#fcToday').innerHTML = todays.length ? `<div class="tbl-wrap"><table><thead><tr>
          <th>Receipt No</th><th>Student</th><th style="text-align:right">Amount</th><th>Mode</th>
          <th>Transaction ID</th><th></th></tr></thead><tbody>${todays.map(p => {
            const s = Store.find('students', p.studentId) || {};
            return `<tr><td class="mono">${esc(p.receiptNo)}</td><td>${esc(s.name || '—')} (${esc(s.roll || '—')})</td>
              <td style="text-align:right;font-weight:600">${money(p.amount)}</td>
              <td><span class="pill blue">${esc(p.mode)}</span></td><td class="mono">${esc(p.txnId || '—')}</td>
              <td><button class="btn-sm btn-outline" data-rc="${p.id}">🧾 Receipt</button></td></tr>`;
          }).join('')}</tbody></table></div>`
          : `<p class="empty">No fee collected today yet.</p>`;
        $('#fcToday').querySelectorAll('[data-rc]').forEach(b => b.onclick = () => printReceipt(b.dataset.rc));
      };
      bindFinFilters('fc', [], () => { page = 1; draw(); });
      $('#fcOnlyDue').onchange = () => { page = 1; draw(); };
      $('#fcGoHistory').onclick = () => navigate('payments');
      $('#fcGoPending').onclick = () => navigate('pendingfees');
      draw();
    };
    return html;
  }

  function collectFeeForm(sid, after) {
    const s = Store.find('students', sid);
    if (!s) { toast('Student not found.', 'err'); return; }
    const due = feeRowsOf(sid).filter(f => (+f.total || 0) > (+f.paid || 0));
    if (!due.length) {
      openModal('Collect Fee — ' + s.name,
        `<p class="empty">This student has no pending fee. Add a semester fee record first.</p>
         <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`);
      $('#cx').onclick = closeModal;
      return;
    }
    const first = due[0];
    const pendingOf = (f) => Math.max(0, (+f.total || 0) - (+f.paid || 0));

    openModal('Collect Fee — ' + s.name, `<form id="f">
      <div class="form-grid">
        <div class="field"><label>Student ID</label><input value="${esc(s.roll)}" disabled></div>
        <div class="field"><label>Student Name</label><input value="${esc(s.name)}" disabled></div>
        <div class="field"><label>Course</label><input value="${esc(s.course || '—')}" disabled></div>
        <div class="field"><label>Specialisation</label><input value="${esc(s.branch || '—')}" disabled></div>
        <div class="field full"><label>Fee Record (Semester)</label>
          <select name="feeId" id="cfFee">${due.map(f =>
            `<option value="${f.id}">Semester ${esc(f.semester || '—')} · ${esc(f.academicYear || '—')} · pending ${money(pendingOf(f))}</option>`).join('')}</select></div>
        <div class="field"><label>Total Fee (₹)</label><input id="cfTotal" value="${first.total || 0}" disabled></div>
        <div class="field"><label>Already Paid (₹)</label><input id="cfPaid" value="${first.paid || 0}" disabled></div>
        <div class="field"><label>Pending Amount (₹)</label><input id="cfPending" value="${pendingOf(first)}" disabled></div>
        <div class="field"><label>Paying Now (₹)</label><input name="amount" id="cfAmount" inputmode="numeric" value="${pendingOf(first)}" required></div>
        <div class="field"><label>Payment Mode</label><select name="mode" id="cfMode">${optionsFrom(PAY_MODES)}</select></div>
        <div class="field"><label>Transaction / Reference ID</label><input name="txnId" id="cfTxn" placeholder="UPI ref, cheque no, …"></div>
        <div class="field"><label>Payment Date</label><input name="date" type="date" value="${today()}" max="${today()}" required></div>
        <div class="field"><label>Receipt Number</label><input id="cfReceipt" value="${esc(nextReceiptNo())}" disabled></div>
        <div class="field full"><label>Remarks</label><textarea name="remarks" rows="2" placeholder="Optional note for the receipt"></textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Collect &amp; Generate Receipt</button></div></form>`, true);

    $('#cx').onclick = closeModal;
    bindAmountInput($('#cfAmount'));
    const syncFee = () => {
      const f = Store.find('fees', $('#cfFee').value) || {};
      $('#cfTotal').value = f.total || 0;
      $('#cfPaid').value = f.paid || 0;
      $('#cfPending').value = pendingOf(f);
      $('#cfAmount').value = pendingOf(f);
    };
    $('#cfFee').onchange = syncFee;

    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const fee = Store.find('fees', d.feeId);
      if (!fee) { toast('That fee record no longer exists.', 'err'); return; }
      const pending = pendingOf(fee);
      const amount = parseAmount(d.amount, { min: 1, max: pending });
      if (amount === null) {
        toast(`Enter a whole rupee amount between ₹1 and ${money(pending)}.`, 'err');
        return;
      }
      if (d.mode !== 'Cash' && !String(d.txnId || '').trim()) {
        toast(`A transaction / reference ID is required for ${d.mode} payments.`, 'err');
        return;
      }
      if (d.date > today()) { toast('Payment date cannot be in the future.', 'err'); return; }
      const receiptNo = nextReceiptNo();

      confirmAction('Confirm Payment',
        `Record <b>${money(amount)}</b> from <b>${esc(s.name)}</b> (${esc(s.roll)}) by
         <b>${esc(d.mode)}</b> against Semester ${esc(fee.semester || '—')}?<br><br>
         Pending after this payment: <b>${money(pending - amount)}</b>.<br>
         Receipt <b>${esc(receiptNo)}</b> will be generated.`,
        'Confirm Payment', () => {
          Store.update('fees', fee.id, { paid: Math.min(+fee.total || 0, (+fee.paid || 0) + amount) });
          const payment = Store.add('payments', {
            receiptNo, studentId: sid, feeId: fee.id, amount, mode: d.mode,
            txnId: String(d.txnId || '').trim(), date: d.date,
            remarks: String(d.remarks || '').trim(), status: 'Success',
            collectedBy: user.name || user.username,
          });
          closeModal();
          toast(`Payment of ${money(amount)} recorded — receipt ${receiptNo}.`);
          printReceipt(payment.id);
          if (after) after(); else render();
        });
    };
  }

  function printReceipt(paymentId) {
    const p = Store.find('payments', paymentId);
    if (!p) { toast('Receipt not found.', 'err'); return; }
    const s = Store.find('students', p.studentId) || {};
    const fee = Store.find('fees', p.feeId) || {};
    const pending = Math.max(0, (+fee.total || 0) - (+fee.paid || 0));
    const row = (k, v) => `<tr><th style="width:170px">${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`;
    printDoc('Fee Receipt ' + p.receiptNo, `${docHeader()}
      <div class="receipt-title">
        <h2>FEE RECEIPT</h2>
        <div class="receipt-no">No. ${esc(p.receiptNo)}<br><span>${esc(p.date)}</span></div>
      </div>
      <table><tbody>
        ${row('Student ID', s.roll)}
        ${row('Student Name', s.name)}
        ${row('Course', s.course)}
        ${row('Specialisation', s.branch)}
        ${row('Semester', fee.semester || s.semester)}
        ${row('Academic Year', fee.academicYear || s.academicYear)}
      </tbody></table>
      <table style="margin-top:14px"><tbody>
        ${row('Total Fee', money(fee.total))}
        ${row('Paid Amount (this receipt)', money(p.amount))}
        ${row('Total Paid Till Date', money(fee.paid))}
        ${row('Pending Amount', money(pending))}
        ${row('Payment Mode', p.mode)}
        ${row('Transaction ID', p.txnId || '—')}
        ${row('Payment Date', p.date)}
        ${row('Remarks', p.remarks || '—')}
      </tbody></table>
      <div class="receipt-amount">Amount Received: <b>${money(p.amount)}</b></div>
      <p style="font-size:11.5px;color:#666;margin-top:10px">
        Received with thanks from ${esc(s.name || '—')}. Collected by ${esc(p.collectedBy || 'Accounts Office')}.
        This is a computer-generated receipt.</p>
      <div class="sign"><span>Student / Parent</span><span>Accounts Officer</span></div>`);
  }

  /* =========================== PAYMENT HISTORY =========================== */
  function paymentLedger() {
    return Store.all('payments').map(p => {
      const s = Store.find('students', p.studentId) || {};
      const fee = Store.find('fees', p.feeId) || {};
      return {
        id: p.id, receiptNo: p.receiptNo || '—', sid: p.studentId, roll: s.roll || '—',
        name: s.name || 'Unknown student', course: s.course || '—', branch: specOf(s) || '—',
        semester: fee.semester || s.semester || '', academicYear: fee.academicYear || s.academicYear || '—',
        amount: +p.amount || 0, mode: p.mode || '—', txnId: p.txnId || '—',
        date: p.date || '', status: p.status || 'Success',
        collectedBy: p.collectedBy || '—', remarks: p.remarks || '',
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  }

  function viewPayments() {
    const html = `<div class="panel"><div class="panel-head"><h3>All Transactions</h3>
      <div class="panel-tools">${exportButtons('ph')}</div></div>
      ${finFilterBar('ph', {
        placeholder: 'Search receipt / student / transaction id...', dates: true,
        extra: `<select class="filter-sel" id="phMode"><option value="">All Payment Modes</option>${optionsFrom(PAY_MODES)}</select>`,
      })}
      <div id="phStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Receipt Number</th><th>Student ID</th><th>Student Name</th><th style="text-align:right">Amount</th>
        <th>Payment Mode</th><th>Transaction ID</th><th>Date</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="phBody"></tbody></table></div><div id="phPager"></div></div>`;

    viewPayments.after = () => {
      let page = 1;
      const filtered = () => {
        const f = finFilterValues('ph', ['Mode']);
        return paymentLedger().filter(r =>
          matchesFinFilters(r, f) &&
          (!f.mode || r.mode === f.mode) &&
          (!f.from || r.date >= f.from) &&
          (!f.to || r.date <= f.to));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const sum = rows.reduce((a, r) => a + r.amount, 0);
        $('#phStats').innerHTML = `${statCard('🧾', rows.length, 'Receipts Listed')}
          ${statCard('💰', money(sum), 'Amount in View', 'c3')}
          ${statCard('👥', new Set(rows.map(r => r.sid)).size, 'Distinct Students', 'c2')}`;
        $('#phBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td class="mono">${esc(r.receiptNo)}</td><td class="mono">${esc(r.roll)}</td><td>${esc(r.name)}</td>
          <td style="text-align:right;font-weight:600">${money(r.amount)}</td>
          <td><span class="pill blue">${esc(r.mode)}</span></td><td class="mono">${esc(r.txnId)}</td>
          <td>${esc(r.date)}</td><td><span class="pill green">${esc(r.status)}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${r.id}">👁 View</button>
            <button class="btn-sm btn-edit" data-print="${r.id}">🖨 Receipt</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="9" class="empty">No transactions match these filters.</td></tr>`;
        $('#phBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => receiptModal(b.dataset.view));
        $('#phBody').querySelectorAll('[data-print]').forEach(b => b.onclick = () => printReceipt(b.dataset.print));
        $('#phPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#phPager'), rows.length, page, (p) => page = p, draw);
      };
      bindFinFilters('ph', ['Mode'], () => { page = 1; draw(); });
      bindExports('ph', () => {
        const rows = filtered();
        return {
          title: 'Payment History', sheetName: 'Payments', subtitle: reportStamp(),
          columns: paymentColumns(),
          rows,
          totals: { receiptNo: 'TOTAL', name: rows.length + ' receipts', amount: rows.reduce((a, r) => a + r.amount, 0) },
        };
      });
      draw();
    };
    return html;
  }

  function paymentColumns() {
    return [
      { header: 'Receipt Number', key: 'receiptNo', width: 18 },
      { header: 'Student ID', key: 'roll', width: 14 },
      { header: 'Student Name', key: 'name', width: 26 },
      { header: 'Course', key: 'course', width: 12 },
      { header: 'Specialisation', key: 'branch', width: 12 },
      { header: 'Semester', key: 'semester', width: 10, type: 'number' },
      { header: 'Amount', key: 'amount', width: 14, money: true },
      { header: 'Payment Mode', key: 'mode', width: 15 },
      { header: 'Transaction ID', key: 'txnId', width: 20 },
      { header: 'Date', key: 'date', width: 13 },
      { header: 'Status', key: 'status', width: 11 },
      { header: 'Collected By', key: 'collectedBy', width: 20 },
    ];
  }

  function receiptModal(paymentId) {
    const p = Store.find('payments', paymentId);
    if (!p) return;
    const s = Store.find('students', p.studentId) || {};
    const fee = Store.find('fees', p.feeId) || {};
    const row = (k, v) => `<tr><td style="font-weight:600;width:190px">${esc(k)}</td><td>${esc(v ?? '—')}</td></tr>`;
    openModal('Receipt ' + p.receiptNo, `<div class="tbl-wrap"><table><tbody>
      ${row('Receipt Number', p.receiptNo)}
      ${row('Student ID', s.roll)}
      ${row('Student Name', s.name)}
      ${row('Course / Branch', `${s.course || '—'} / ${s.branch || '—'}`)}
      ${row('Semester', fee.semester || s.semester)}
      ${row('Total Fee', money(fee.total))}
      ${row('Paid Amount (this receipt)', money(p.amount))}
      ${row('Total Paid Till Date', money(fee.paid))}
      ${row('Pending Amount', money(Math.max(0, (+fee.total || 0) - (+fee.paid || 0))))}
      ${row('Payment Mode', p.mode)}
      ${row('Transaction ID', p.txnId || '—')}
      ${row('Payment Date', p.date)}
      ${row('Remarks', p.remarks || '—')}
      ${row('Collected By', p.collectedBy)}
    </tbody></table></div>
    <div class="form-actions"><button class="btn-outline" id="cx">Close</button>
      <button class="btn-outline" id="dl">⬇ Download</button>
      <button class="btn-primary" id="pr">🖨 Print Receipt</button></div>`, true);
    $('#cx').onclick = closeModal;
    $('#pr').onclick = () => printReceipt(paymentId);
    $('#dl').onclick = () => { printReceipt(paymentId); toast('Choose "Save as PDF" in the print dialog.'); };
  }

  /* =========================== PENDING FEES =========================== */
  function viewPendingFees() {
    const canCollect = !readOnly();
    const html = (readOnly() ? readOnlyBanner('Fee collection is done by the accounts office. '
      + 'This page reports what is outstanding.') : '') +
      `<div class="panel"><div class="panel-head"><h3>Outstanding Fees</h3>
      <div class="panel-tools">${exportButtons('pf')}</div></div>
      ${finFilterBar('pf', {
        extra: `<select class="filter-sel" id="pfStatus"><option value="">Unpaid &amp; Partial</option>
          <option>Partial</option><option>Unpaid</option></select>
          <select class="filter-sel" id="pfSort">
            <option value="pending-desc">Highest pending first</option>
            <option value="pending-asc">Lowest pending first</option>
            <option value="due-asc">Earliest due date first</option>
            <option value="name-asc">Student name (A–Z)</option>
          </select>`,
      })}
      <div id="pfStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Student ID</th><th>Student Name</th><th>Course</th><th>Specialisation</th><th>Semester</th>
        <th style="text-align:right">Total Fee</th><th style="text-align:right">Paid Fee</th>
        <th style="text-align:right">Pending Fee</th><th>Due Date</th><th>Status</th><th>Action</th>
      </tr></thead><tbody id="pfBody"></tbody></table></div><div id="pfPager"></div></div>`;

    viewPendingFees.after = () => {
      let page = 1;
      const filtered = () => {
        const f = finFilterValues('pf', ['Status', 'Sort']);
        const rows = financeRows().filter(r =>
          r.pending > 0 && matchesFinFilters(r, f) && (!f.status || r.status === f.status));
        const cmp = {
          'pending-desc': (a, b) => b.pending - a.pending,
          'pending-asc': (a, b) => a.pending - b.pending,
          'due-asc': (a, b) => String(a.dueDate).localeCompare(String(b.dueDate)),
          'name-asc': (a, b) => String(a.name).localeCompare(String(b.name)),
        }[f.sort || 'pending-desc'];
        return rows.sort(cmp);
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const sum = rows.reduce((a, r) => a + r.pending, 0);
        const overdue = rows.filter(r => r.dueDate !== '—' && r.dueDate < today());
        $('#pfStats').innerHTML = `${statCard('👥', rows.length, 'Students with Dues', 'c4')}
          ${statCard('⏳', money(sum), 'Total Pending', 'c4')}
          ${statCard('⚠️', overdue.length, 'Past Due Date', overdue.length ? 'c4' : 'c3')}
          ${statCard('📉', money(rows.length ? Math.round(sum / rows.length) : 0), 'Average Pending', 'c2')}`;
        $('#pfBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => {
          const late = r.dueDate !== '—' && r.dueDate < today();
          return `<tr><td class="mono">${esc(r.roll)}</td><td>${esc(r.name)}</td><td>${esc(r.course)}</td>
            <td>${esc(r.branch)}</td><td>${esc(r.semester || '—')}</td>
            <td style="text-align:right">${money(r.total)}</td>
            <td style="text-align:right;color:var(--green)">${money(r.paid)}</td>
            <td style="text-align:right;color:var(--red);font-weight:600">${money(r.pending)}</td>
            <td${late ? ' style="color:var(--red);font-weight:600"' : ''}>${esc(r.dueDate)}${late ? ' ⚠' : ''}</td>
            <td><span class="pill ${r.pill}">${esc(r.status)}</span></td>
            <td>${canCollect
              ? `<button class="btn-sm btn-edit" data-collect="${r.sid}">💰 Collect</button>`
              : `<button class="btn-sm btn-outline" data-detail="${r.sid}">👁 View</button>`}</td></tr>`;
        }).join('') : `<tr><td colspan="11" class="empty">No pending fees for these filters. 🎉</td></tr>`;
        if (canCollect) {
          $('#pfBody').querySelectorAll('[data-collect]').forEach(b =>
            b.onclick = () => collectFeeForm(b.dataset.collect, draw));
        } else {
          $('#pfBody').querySelectorAll('[data-detail]').forEach(b =>
            b.onclick = () => studentFeeModal(b.dataset.detail));
        }
        $('#pfPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#pfPager'), rows.length, page, (p) => page = p, draw);
      };
      bindFinFilters('pf', ['Status', 'Sort'], () => { page = 1; draw(); });
      bindExports('pf', () => {
        const rows = filtered();
        return {
          title: 'Pending Fee Report', sheetName: 'Pending Fees', subtitle: reportStamp(),
          columns: [
            { header: 'Student ID', key: 'roll', width: 14 },
            { header: 'Student Name', key: 'name', width: 26 },
            { header: 'Course', key: 'course', width: 12 },
            { header: 'Specialisation', key: 'branch', width: 12 },
            { header: 'Semester', key: 'semester', width: 10, type: 'number' },
            { header: 'Academic Year', key: 'academicYear', width: 15 },
            { header: 'Total Fee', key: 'total', width: 14, money: true },
            { header: 'Paid Fee', key: 'paid', width: 14, money: true },
            { header: 'Pending Fee', key: 'pending', width: 14, money: true },
            { header: 'Due Date', key: 'dueDate', width: 13 },
            { header: 'Status', key: 'status', width: 12 },
          ],
          rows,
          totals: {
            roll: 'TOTAL', name: rows.length + ' students',
            total: rows.reduce((a, r) => a + r.total, 0),
            paid: rows.reduce((a, r) => a + r.paid, 0),
            pending: rows.reduce((a, r) => a + r.pending, 0),
          },
        };
      });
      draw();
    };
    return html;
  }

  /* =========================== REPORTS =========================== */
  const FIN_REPORTS = [
    ['studentFee', '🎓 Student Fee Report'],
    ['collection', '💰 Fee Collection Report'],
    ['pending', '⏳ Pending Fee Report'],
    ['fixed', '📋 Fixed Fee Report'],
    ['semester', '📆 Semester-wise Fee Report'],
    ['asset', '🏢 Asset Report'],
  ];
  let finReport = 'studentFee';

  function viewFinReports() {
    const html = `<div class="panel"><div class="panel-head"><h3>Financial Reports</h3>
      <div class="panel-tools">${exportButtons('fr')}</div></div>
      <div class="fin-tabs" id="frTabs">${FIN_REPORTS.map(([key, label]) =>
        `<button class="fin-tab ${key === finReport ? 'active' : ''}" data-rep="${key}">${label}</button>`).join('')}</div>
      ${finFilterBar('fr', { placeholder: 'Search...', dates: true })}
      <p style="font-size:12px;color:var(--muted);margin:0 0 14px" id="frNote"></p>
      <div id="frStats" class="stat-grid" style="margin-bottom:18px"></div>
      <div id="frTable"></div>
      <div id="frPager"></div></div>`;

    viewFinReports.after = () => {
      let page = 1;
      const build = () => buildFinReport(finReport, finFilterValues('fr'));
      const draw = () => {
        const r = build();
        page = Math.min(page, pageCount(r.rows.length));
        $('#frNote').textContent = r.note || '';
        $('#frStats').innerHTML = (r.stats || []).join('');
        $('#frTable').innerHTML = reportTableHtml(r.columns, pageSlice(r.rows, page), 'No data for these filters.');
        $('#frPager').innerHTML = pagerHtml(r.rows.length, page);
        bindPager($('#frPager'), r.rows.length, page, (p) => page = p, draw);
      };
      $('#frTabs').querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
        finReport = b.dataset.rep;
        $('#frTabs').querySelectorAll('.fin-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.rep === finReport));
        page = 1; draw();
      });
      bindFinFilters('fr', [], () => { page = 1; draw(); });
      bindExports('fr', build);
      draw();
    };
    return html;
  }

  // every report shares the same shape: { title, columns, rows, totals, stats, note }
  function buildFinReport(kind, f) {
    const stamp = reportStamp();
    const inRange = (d) => (!f.from || (d && d >= f.from)) && (!f.to || (d && d <= f.to));

    if (kind === 'studentFee') {
      const rows = financeRows().filter(r => matchesFinFilters(r, f));
      return {
        title: 'Student Fee Report', sheetName: 'Student Fee', subtitle: stamp,
        note: 'Student-wise fee details — total, paid and pending across every semester on record.',
        columns: [
          { header: 'Student ID', key: 'roll', width: 14 }, { header: 'Student Name', key: 'name', width: 26 },
          { header: 'Course', key: 'course', width: 12 }, { header: 'Specialisation', key: 'branch', width: 12 },
          { header: 'Semester', key: 'semester', width: 10, type: 'number' },
          { header: 'Academic Year', key: 'academicYear', width: 15 },
          { header: 'Total Fee', key: 'total', width: 14, money: true },
          { header: 'Paid Amount', key: 'paid', width: 14, money: true },
          { header: 'Pending Amount', key: 'pending', width: 15, money: true },
          { header: 'Status', key: 'status', width: 12 },
        ],
        rows,
        totals: {
          roll: 'TOTAL', name: rows.length + ' students',
          total: rows.reduce((a, r) => a + r.total, 0), paid: rows.reduce((a, r) => a + r.paid, 0),
          pending: rows.reduce((a, r) => a + r.pending, 0),
        },
        stats: [
          statCard('🎓', rows.length, 'Students'),
          statCard('💰', money(rows.reduce((a, r) => a + r.total, 0)), 'Total Fee'),
          statCard('✅', money(rows.reduce((a, r) => a + r.paid, 0)), 'Collected', 'c3'),
          statCard('⏳', money(rows.reduce((a, r) => a + r.pending, 0)), 'Pending', 'c4'),
        ],
      };
    }

    if (kind === 'collection') {
      const pays = paymentLedger().filter(r => matchesFinFilters(r, f) && inRange(r.date));
      // daily, monthly, semester and academic-year buckets in one table
      const buckets = [];
      const push = (group, label, list) => buckets.push({
        group, label, receipts: list.length,
        students: new Set(list.map(p => p.sid)).size,
        amount: list.reduce((a, p) => a + p.amount, 0),
      });
      const groupBy = (keyFn) => {
        const m = new Map();
        pays.forEach(p => {
          const k = keyFn(p) || '—';
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(p);
        });
        return [...m.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));
      };
      groupBy(p => p.date).forEach(([k, list]) => push('Daily', k, list));
      groupBy(p => String(p.date).slice(0, 7)).forEach(([k, list]) => push('Monthly', k, list));
      groupBy(p => p.semester ? 'Semester ' + p.semester : '—').forEach(([k, list]) => push('Semester', k, list));
      groupBy(p => p.academicYear).forEach(([k, list]) => push('Academic Year', k, list));
      const total = pays.reduce((a, p) => a + p.amount, 0);
      return {
        title: 'Fee Collection Report', sheetName: 'Collection', subtitle: stamp,
        note: 'Collection grouped by day, month, semester and academic year. Each group repeats the same receipts from a different angle.',
        columns: [
          { header: 'Grouping', key: 'group', width: 16 }, { header: 'Period', key: 'label', width: 20 },
          { header: 'Receipts', key: 'receipts', width: 11, type: 'number' },
          { header: 'Students', key: 'students', width: 11, type: 'number' },
          { header: 'Amount Collected', key: 'amount', width: 18, money: true },
        ],
        rows: buckets,
        stats: [
          statCard('🧾', pays.length, 'Receipts'),
          statCard('💰', money(total), 'Collected', 'c3'),
          statCard('📅', money(collectionOn(today())), "Today's Collection", 'c2'),
          statCard('👥', new Set(pays.map(p => p.sid)).size, 'Students Paid'),
        ],
      };
    }

    if (kind === 'pending') {
      const base = financeRows().filter(r => r.pending > 0 && matchesFinFilters(r, f));
      const rows = [];
      base.forEach(r => rows.push({
        scope: 'Student', label: `${r.name} (${r.roll})`, detail: `${r.course} / ${r.branch} / Sem ${r.semester || '—'}`,
        count: 1, total: r.total, paid: r.paid, pending: r.pending,
      }));
      const roll = (keyFn, scope) => {
        const m = new Map();
        base.forEach(r => {
          const k = keyFn(r) || '—';
          if (!m.has(k)) m.set(k, { scope, label: k, detail: '', count: 0, total: 0, paid: 0, pending: 0 });
          const g = m.get(k);
          g.count++; g.total += r.total; g.paid += r.paid; g.pending += r.pending;
        });
        [...m.values()].sort((a, b) => b.pending - a.pending)
          .forEach(g => rows.push({ ...g, detail: g.count + ' student(s)' }));
      };
      roll(r => r.course, 'Course-wise');
      roll(r => r.semester ? 'Semester ' + r.semester : '—', 'Semester-wise');
      const pending = base.reduce((a, r) => a + r.pending, 0);
      return {
        title: 'Pending Fee Report', sheetName: 'Pending', subtitle: stamp,
        note: 'Student-wise dues first, then the same dues rolled up by course and by semester.',
        columns: [
          { header: 'Scope', key: 'scope', width: 14 }, { header: 'Name / Group', key: 'label', width: 30 },
          { header: 'Details', key: 'detail', width: 28 },
          { header: 'Total Fee', key: 'total', width: 14, money: true },
          { header: 'Paid', key: 'paid', width: 14, money: true },
          { header: 'Pending', key: 'pending', width: 14, money: true },
        ],
        rows,
        stats: [
          statCard('👥', base.length, 'Students with Dues', 'c4'),
          statCard('⏳', money(pending), 'Total Pending', 'c4'),
          statCard('💰', money(base.reduce((a, r) => a + r.total, 0)), 'Fee Charged'),
          statCard('✅', money(base.reduce((a, r) => a + r.paid, 0)), 'Already Paid', 'c3'),
        ],
      };
    }

    if (kind === 'fixed') {
      const rows = Store.all('fixedfees').filter(r =>
        (!f.q || [r.id, r.course, r.branch, r.feeType].some(v => String(v || '').toLowerCase().includes(f.q))) &&
        (!f.course || r.course === f.course) && (!f.branch || r.branch === f.branch) &&
        (!f.year || r.academicYear === f.year) && inRange(r.effectiveFrom))
        .sort((a, b) => String(a.course).localeCompare(String(b.course)) || String(a.branch).localeCompare(String(b.branch)));
      const active = rows.filter(r => (r.status || 'Active') === 'Active');
      return {
        title: 'Fixed Fee Report', sheetName: 'Fixed Fee', subtitle: stamp,
        note: 'The published fee structure. The date range filters on "effective from".',
        columns: [
          { header: 'ID', key: 'id', width: 10 }, { header: 'Course', key: 'course', width: 14 },
          { header: 'Specialisation', key: 'branch', width: 14 }, { header: 'Academic Year', key: 'academicYear', width: 15 },
          { header: 'Fee Type', key: 'feeType', width: 20 },
          { header: 'Fixed Amount', key: 'amount', width: 16, money: true },
          { header: 'Effective From', key: 'effectiveFrom', width: 15 }, { header: 'Status', key: 'status', width: 11 },
        ],
        rows,
        totals: { id: 'TOTAL', course: rows.length + ' heads', amount: rows.reduce((a, r) => a + (+r.amount || 0), 0) },
        stats: [
          statCard('📋', rows.length, 'Fee Heads'),
          statCard('✅', active.length, 'Active', 'c3'),
          statCard('💰', money(active.reduce((a, r) => a + (+r.amount || 0), 0)), 'Total Fixed Fee', 'c2'),
        ],
      };
    }

    if (kind === 'semester') {
      const rows = Store.all('fees').map(fee => {
        const s = Store.find('students', fee.studentId) || {};
        const paid = Math.min(+fee.total || 0, +fee.paid || 0);
        return {
          roll: s.roll || '—', name: s.name || 'Unknown student', course: s.course || '—',
          branch: specOf(s) || '—', semester: fee.semester || s.semester || '',
          academicYear: fee.academicYear || s.academicYear || '—',
          total: +fee.total || 0, paid, pending: Math.max(0, (+fee.total || 0) - paid),
          dueDate: fee.dueDate || '—', status: feeStatusOf(fee.total, fee.paid).label,
        };
      }).filter(r => matchesFinFilters(r, f))
        .sort((a, b) => (+a.semester || 0) - (+b.semester || 0) || String(a.roll).localeCompare(String(b.roll)));
      return {
        title: 'Semester-wise Fee Report', sheetName: 'Semester Fee', subtitle: stamp,
        note: 'Every semester fee record, one row per student per semester.',
        columns: [
          { header: 'Semester', key: 'semester', width: 10, type: 'number' },
          { header: 'Student ID', key: 'roll', width: 14 }, { header: 'Student Name', key: 'name', width: 26 },
          { header: 'Course', key: 'course', width: 12 }, { header: 'Specialisation', key: 'branch', width: 12 },
          { header: 'Academic Year', key: 'academicYear', width: 15 },
          { header: 'Total Fee', key: 'total', width: 14, money: true },
          { header: 'Paid Amount', key: 'paid', width: 14, money: true },
          { header: 'Pending Amount', key: 'pending', width: 15, money: true },
          { header: 'Due Date', key: 'dueDate', width: 13 }, { header: 'Status', key: 'status', width: 12 },
        ],
        rows,
        totals: {
          semester: 'TOTAL', roll: rows.length + ' records',
          total: rows.reduce((a, r) => a + r.total, 0), paid: rows.reduce((a, r) => a + r.paid, 0),
          pending: rows.reduce((a, r) => a + r.pending, 0),
        },
        stats: [
          statCard('📆', rows.length, 'Fee Records'),
          statCard('💰', money(rows.reduce((a, r) => a + r.total, 0)), 'Total Fee'),
          statCard('✅', money(rows.reduce((a, r) => a + r.paid, 0)), 'Collected', 'c3'),
          statCard('⏳', money(rows.reduce((a, r) => a + r.pending, 0)), 'Pending', 'c4'),
        ],
      };
    }

    // asset report
    const rows = Store.all('assets').filter(a =>
      (!f.q || [a.id, a.name, a.vendor, a.location, a.category].some(v => String(v || '').toLowerCase().includes(f.q))) &&
      inRange(a.purchaseDate))
      .map(a => ({ ...a, depreciation: Math.max(0, (+a.purchaseCost || 0) - (+a.currentValue || 0)) }))
      .sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.id).localeCompare(String(b.id)));
    return {
      title: 'Asset Report', sheetName: 'Assets', subtitle: stamp,
      note: 'The asset register. The date range filters on the purchase date; course/branch/semester filters do not apply here.',
      columns: [
        { header: 'Asset ID', key: 'id', width: 10 }, { header: 'Asset Name', key: 'name', width: 30 },
        { header: 'Category', key: 'category', width: 20 },
        { header: 'Quantity', key: 'quantity', width: 10, type: 'number' },
        { header: 'Purchase Date', key: 'purchaseDate', width: 14 },
        { header: 'Purchase Cost', key: 'purchaseCost', width: 16, money: true },
        { header: 'Current Value', key: 'currentValue', width: 16, money: true },
        { header: 'Depreciation', key: 'depreciation', width: 16, money: true },
        { header: 'Vendor', key: 'vendor', width: 22 }, { header: 'Location', key: 'location', width: 20 },
        { header: 'Status', key: 'status', width: 16 },
      ],
      rows,
      totals: {
        id: 'TOTAL', name: rows.length + ' entries',
        quantity: rows.reduce((a, r) => a + (+r.quantity || 0), 0),
        purchaseCost: rows.reduce((a, r) => a + (+r.purchaseCost || 0), 0),
        currentValue: rows.reduce((a, r) => a + (+r.currentValue || 0), 0),
        depreciation: rows.reduce((a, r) => a + r.depreciation, 0),
      },
      stats: [
        statCard('🏢', rows.length, 'Asset Entries'),
        statCard('🔢', rows.reduce((a, r) => a + (+r.quantity || 0), 0), 'Total Units', 'c2'),
        statCard('💵', money(rows.reduce((a, r) => a + (+r.purchaseCost || 0), 0)), 'Purchase Cost'),
        statCard('📉', money(rows.reduce((a, r) => a + (+r.currentValue || 0), 0)), 'Current Value', 'c3'),
      ],
    };
  }

  /* =========================== ACCOUNTANT STAFF (admin) =========================== */
  function viewAccountants() {
    const html = `<div class="panel"><div class="panel-head"><h3>Accounts Office Staff</h3>
      <div class="panel-tools">
        <input class="search-box" id="acQ" placeholder="Search name / employee id...">
        <button class="btn-primary" id="acAdd">+ Add Accountant</button></div></div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 12px">
        Adding an accountant also creates their login (password <b>${DEFAULT_PASSWORD}</b>).
        Manage every login from <b>Login Accounts</b>.</p>
      <div class="tbl-wrap"><table><thead><tr>
        <th></th><th>Employee ID</th><th>Name</th><th>Designation</th><th>Email</th><th>Phone</th>
        <th>Login</th><th>Actions</th>
      </tr></thead><tbody id="acBody"></tbody></table></div><div id="acPager"></div></div>`;

    viewAccountants.after = () => {
      let page = 1;
      const draw = () => {
        const q = ($('#acQ').value || '').trim().toLowerCase();
        const rows = Store.all('accountants').filter(a =>
          !q || [a.name, a.empId, a.email, a.designation].some(v => String(v || '').toLowerCase().includes(q)));
        page = Math.min(page, pageCount(rows.length));
        $('#acBody').innerHTML = rows.length ? pageSlice(rows, page).map(a => {
          const login = Store.all('users').find(u => u.role === 'accountant' && u.refId === a.id);
          return `<tr><td>${avatarHtml(a.photo, a.name)}</td><td class="mono">${esc(a.empId || '—')}</td>
            <td>${esc(a.name)}</td><td>${esc(a.designation || '—')}</td><td>${esc(a.email || '—')}</td>
            <td>${esc(a.phone || '—')}</td>
            <td>${login ? `<span class="pill green">@${esc(login.username)}</span>`
              : `<span class="pill red">No login</span>`}</td>
            <td><div class="row-actions">
              <button class="btn-sm btn-edit" data-edit="${a.id}">Edit</button>
              <button class="btn-sm btn-del" data-del="${a.id}">Delete</button>
            </div></td></tr>`;
        }).join('') : `<tr><td colspan="8" class="empty">No accountants on record.</td></tr>`;
        $('#acBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => accountantForm(b.dataset.edit, draw));
        $('#acBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const a = Store.find('accountants', b.dataset.del) || {};
          const login = Store.all('users').find(u => u.role === 'accountant' && u.refId === a.id);
          confirmDelete('Delete Accountant', `Delete <b>${esc(a.name)}</b> from the accounts office
            ${login ? `and remove their login <b>@${esc(login.username)}</b>` : ''}?
            Receipts they collected stay in the payment history.`,
            'Delete', () => {
              if (login) Store.remove('users', login.id);
              Store.remove('accountants', a.id);
              toast('Accountant deleted.', 'err'); draw();
            });
        });
        $('#acPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#acPager'), rows.length, page, (p) => page = p, draw);
      };
      $('#acQ').oninput = () => { page = 1; draw(); };
      $('#acAdd').onclick = () => accountantForm(null, draw);
      draw();
    };
    return html;
  }

  /* Their own pages still open these; all three are the Employees form against
     a different table, so a person's record holds the same things wherever the
     office happened to add them. */
  function accountantForm(id, after) { return facultyForm(id, after, 'accountants'); }
  function centerHeadForm(id, after) { return facultyForm(id, after, 'centerheads'); }
  function placementOfficerForm(id, after) { return facultyForm(id, after, 'placementofficers'); }

  /* =========================================================
     REQUISITIONS — purchase requests raised by staff.
     Faculty raise "Goods", the librarian raises "Book"; admin and
     accountant review them in one place and can turn an approved
     request straight into an asset or a library book.
     ========================================================= */

  const REQ_GOODS_CATEGORIES = ASSET_CATEGORIES.slice(0, -1)
    .concat(['Stationery', 'Consumables', 'Other']);
  const BOOK_CATEGORIES = ['Management', 'Computer Applications', 'Finance', 'Marketing',
                           'Human Resources', 'Economics', 'Mathematics & Statistics',
                           'Reference', 'General'];
  const REQ_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
  const REQ_STATUS = ['Pending', 'Approved', 'Rejected', 'Ordered', 'Received'];

  /* ---------- two-stage approval ----------
     A request is raised as Pending and sits with the CENTER HEAD. Only once it
     is Approved does the accounts office see it and carry it forward to
     Ordered / Received. The admin can act at either stage.
     Mirrored server-side in api/index.php — an accountant PUT on a Pending row
     is refused there too, not just hidden here. */
  const REQ_STAGE1 = ['Approved', 'Rejected'];              // the center head's decision
  const REQ_STAGE2 = ['Approved', 'Ordered', 'Received'];   // what accounts does next
  function isReqPending(r) { return (r.status || 'Pending') === 'Pending'; }
  /** does this role sign requests off, rather than process them? */
  function reviewsRequisitions() { return !!user && (user.role === 'admin' || user.role === 'center_head'); }
  /** the statuses this role may choose on the review form */
  function reqStatusChoices() {
    if (user.role === 'center_head') return ['Pending'].concat(REQ_STAGE1);
    if (user.role === 'accountant') return REQ_STAGE2;
    return REQ_STATUS;                                       // admin
  }
  /** the requests this role is allowed to work on */
  function visibleRequisitions() {
    const all = Store.all('requisitions');
    if (user.role === 'accountant') return all.filter(r => !isReqPending(r));
    return all;                                              // admin + center head see everything
  }
  const REQ_PILL = { Pending: 'amber', Approved: 'green', Rejected: 'red', Ordered: 'blue', Received: 'green' };
  const PRIORITY_PILL = { Low: 'blue', Normal: 'blue', High: 'amber', Urgent: 'red' };

  function myRequisitions(type) {
    return Store.all('requisitions')
      .filter(r => r.type === type && r.requestedBy === user.id)
      .sort((a, b) => String(b.requestDate || '').localeCompare(String(a.requestDate || '')) ||
        String(b.id).localeCompare(String(a.id)));
  }
  // the department shown on a new request, taken from the staff member's own record
  function myDepartment() {
    if (user.role === 'faculty') return (Store.find('faculty', user.refId) || {}).department || '';
    if (user.role === 'librarian') return 'Library';
    if (user.role === 'accountant') return 'Accounts Office';
    return 'Administration';
  }

  /* ---------- the requester's own page (faculty / librarian) ---------- */
  function viewGoodsRequisition() { return requisitionPage('Goods', viewGoodsRequisition); }
  function viewBookRequisition() { return requisitionPage('Book', viewBookRequisition); }

  function requisitionPage(type, owner) {
    const isBook = type === 'Book';
    const noun = isBook ? 'Book Requisition' : 'Goods Requisition';
    const html = `<div id="rqStats" class="stat-grid"></div>
      <div class="panel"><div class="panel-head"><h3>My ${esc(noun)}s</h3>
        <div class="panel-tools">
          <input class="search-box" id="rqQ" placeholder="Search ${isBook ? 'title / author' : 'item'}...">
          <select class="filter-sel" id="rqStatus"><option value="">All Statuses</option>${optionsFrom(REQ_STATUS)}</select>
          <button class="btn-primary" id="rqAdd">+ New Request</button>
        </div></div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 12px">
        Raise a request for what you need. The accounts office reviews it — you can edit or withdraw
        a request while it is still <b>Pending</b>.</p>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Req ID</th>${isBook
          ? '<th>Book Title</th><th>Author</th><th>ISBN</th>'
          : '<th>Item</th><th>Category</th>'}
        <th style="text-align:right">Qty</th><th style="text-align:right">Est. Cost</th>
        <th>Priority</th><th>Needed By</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="rqBody"></tbody></table></div><div id="rqPager"></div></div>`;

    owner.after = () => {
      let page = 1;
      const cols = isBook ? 10 : 9;
      const draw = () => {
        const q = ($('#rqQ').value || '').trim().toLowerCase();
        const st = $('#rqStatus').value;
        const all = myRequisitions(type);
        const rows = all.filter(r =>
          (!q || [r.id, r.title, r.author, r.isbn, r.category, r.vendor].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!st || (r.status || 'Pending') === st));
        page = Math.min(page, pageCount(rows.length));
        const count = (s) => all.filter(r => (r.status || 'Pending') === s).length;
        $('#rqStats').innerHTML = `${statCard('📦', all.length, 'My Requests')}
          ${statCard('⏳', count('Pending'), 'Pending', count('Pending') ? 'c2' : 'c3')}
          ${statCard('✅', count('Approved') + count('Ordered') + count('Received'), 'Approved', 'c3')}
          ${statCard('❌', count('Rejected'), 'Rejected', count('Rejected') ? 'c4' : 'c3')}`;
        $('#rqBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => {
          const status = r.status || 'Pending';
          const editable = status === 'Pending';
          return `<tr><td class="mono">${esc(r.id)}</td>
            ${isBook
              ? `<td>${esc(r.title)}</td><td>${esc(r.author || '—')}</td><td class="mono">${esc(r.isbn || '—')}</td>`
              : `<td>${esc(r.title)}</td><td>${esc(r.category || '—')}</td>`}
            <td style="text-align:right">${r.quantity ?? '—'}</td>
            <td style="text-align:right">${money(r.estimatedCost)}</td>
            <td><span class="pill ${PRIORITY_PILL[r.priority] || 'blue'}">${esc(r.priority || 'Normal')}</span></td>
            <td>${esc(r.neededBy || '—')}</td>
            <td><span class="pill ${REQ_PILL[status]}">${esc(status)}</span></td>
            <td><div class="row-actions">
              <button class="btn-sm btn-outline" data-view="${r.id}">👁 View</button>
              ${editable ? `<button class="btn-sm btn-edit" data-edit="${r.id}">Edit</button>
                <button class="btn-sm btn-del" data-del="${r.id}">Withdraw</button>` : ''}
            </div></td></tr>`;
        }).join('') : `<tr><td colspan="${cols}" class="empty">No requests yet — use “+ New Request” to raise one.</td></tr>`;
        $('#rqBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => requisitionViewModal(b.dataset.view));
        $('#rqBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => requisitionForm(type, b.dataset.edit, draw));
        $('#rqBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const r = Store.find('requisitions', b.dataset.del) || {};
          confirmDelete('Withdraw Request', `Withdraw request <b>${esc(r.id)}</b> for
            <b>${esc(r.title)}</b> (${r.quantity} × ${money(r.estimatedCost)})?`,
            'Withdraw', () => { Store.remove('requisitions', r.id); toast('Request withdrawn.', 'err'); draw(); });
        });
        $('#rqPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#rqPager'), rows.length, page, (p) => page = p, draw);
      };
      $('#rqQ').oninput = () => { page = 1; draw(); };
      $('#rqStatus').onchange = () => { page = 1; draw(); };
      $('#rqAdd').onclick = () => requisitionForm(type, null, draw);
      draw();
    };
    return html;
  }

  function requisitionForm(type, id, after) {
    const isBook = type === 'Book';
    const r = id ? (Store.find('requisitions', id) || {}) : {};
    const listName = isBook ? 'bookCategory' : 'goodsCategory';
    openModal(`${id ? 'Edit' : 'New'} ${isBook ? 'Book' : 'Goods'} Request`, `<form id="f"><div class="form-grid">
      <div class="field full"><label>${isBook ? 'Book Title' : 'Item Name'}</label>
        <input name="title" value="${esc(r.title || '')}" required></div>
      ${isBook ? `<div class="field"><label>Author</label><input name="author" value="${esc(r.author || '')}"></div>
        <div class="field"><label>ISBN</label><input name="isbn" value="${esc(r.isbn || '')}"></div>` : ''}
      <div class="field"><label>Category</label>
        <select name="category" id="rqCat">${listOptions(listName, r.category, true)}</select></div>
      <div class="field"><label>Quantity</label>
        <input name="quantity" type="number" min="1" step="1" value="${r.quantity || 1}" required></div>
      <div class="field"><label>Estimated Cost (₹, total)</label>
        <input name="estimatedCost" id="rqCost" inputmode="numeric" value="${r.estimatedCost || ''}" required></div>
      <div class="field"><label>Suggested Vendor</label><input name="vendor" value="${esc(r.vendor || '')}"></div>
      <div class="field"><label>Priority</label><select name="priority">${optionsFrom(REQ_PRIORITIES, r.priority || 'Normal')}</select></div>
      <div class="field"><label>Needed By</label>
        <input name="neededBy" type="date" min="${today()}" value="${esc(r.neededBy || '')}" required></div>
      <div class="field full"><label>Purpose / Justification</label>
        <textarea name="purpose" rows="3" placeholder="Why is this needed?">${esc(r.purpose || '')}</textarea></div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:10px">
      Raised by <b>${esc(user.name)}</b> · ${esc(myDepartment() || '—')}</p>
    <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
      <button type="submit" class="btn-primary">${id ? 'Save Changes' : 'Submit Request'}</button></div></form>`);
    $('#cx').onclick = closeModal;
    bindAmountInput($('#rqCost'));
    bindCustomList($('#rqCat'), listName);
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const qty = parseAmount(d.quantity, { min: 1 });
      const cost = parseAmount(d.estimatedCost, { min: 0 });
      if (qty === null) { toast('Quantity must be a whole number of at least 1.', 'err'); return; }
      if (cost === null) { toast('Estimated cost must be a whole rupee amount.', 'err'); return; }
      if (d.neededBy < today()) { toast('“Needed by” cannot be in the past.', 'err'); return; }
      const record = {
        ...d, type, quantity: qty, estimatedCost: cost,
        status: r.status || 'Pending',
        requestedBy: r.requestedBy || user.id,
        requesterName: r.requesterName || user.name,
        requesterRole: r.requesterRole || user.role,
        department: r.department || myDepartment(),
        requestDate: r.requestDate || today(),
      };
      const save = () => {
        if (id) Store.update('requisitions', id, record); else Store.add('requisitions', record);
        closeModal();
        toast(id ? 'Request updated.' : 'Request submitted for approval.');
        after ? after() : render();
      };
      confirmAction(id ? 'Update Request' : 'Submit Request',
        `${id ? 'Save changes to' : 'Send'} this request — <b>${esc(d.title)}</b>, ${qty} unit(s),
         estimated <b>${money(cost)}</b>${id ? '' : ' — to the accounts office for approval'}?`,
        id ? 'Save Changes' : 'Submit', save);
    };
  }

  function requisitionViewModal(id) {
    const r = Store.find('requisitions', id);
    if (!r) return;
    const row = (k, v) => `<tr><td style="font-weight:600;width:190px">${esc(k)}</td><td>${esc(v ?? '—')}</td></tr>`;
    const status = r.status || 'Pending';
    openModal(`Requisition ${r.id}`, `<div class="tbl-wrap"><table><tbody>
      ${row('Request ID', r.id)}
      ${row('Type', r.type + ' Requisition')}
      ${row(r.type === 'Book' ? 'Book Title' : 'Item Name', r.title)}
      ${r.type === 'Book' ? row('Author', r.author) + row('ISBN', r.isbn) : ''}
      ${row('Category', r.category)}
      ${row('Quantity', r.quantity)}
      ${row('Estimated Cost (total)', money(r.estimatedCost))}
      ${row('Suggested Vendor', r.vendor)}
      ${row('Priority', r.priority)}
      ${row('Purpose', r.purpose)}
      ${row('Raised By', `${r.requesterName || '—'} (${r.requesterRole || '—'})`)}
      ${row('Department', r.department)}
      ${row('Request Date', r.requestDate)}
      ${row('Needed By', r.neededBy)}
    </tbody></table></div>
    <p style="margin:14px 0 6px;font-weight:600;color:var(--primary-dark)">Review</p>
    <div class="tbl-wrap"><table><tbody>
      <tr><td style="font-weight:600;width:190px">Status</td>
        <td><span class="pill ${REQ_PILL[status]}">${esc(status)}</span></td></tr>
      ${row('Reviewed By', r.reviewedBy)}
      ${row('Reviewed On', r.reviewedOn)}
      ${row('Review Remarks', r.reviewRemarks)}
      ${r.linkedId ? row(r.type === 'Book' ? 'Added to Library as' : 'Added to Assets as', r.linkedId) : ''}
    </tbody></table></div>
    <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
  }

  /* ---------- the review page (admin / accountant) ---------- */
  function viewRequisitions() {
    const isCH = user.role === 'center_head';
    const isAcct = user.role === 'accountant';
    const note = isCH
      ? 'Every request lands here first. Nothing reaches the accounts office until you approve it.'
      : isAcct
        ? 'Only requests the center head has already approved appear here. Pending ones are still with them.'
        : 'Requests clear the center head first, then the accounts office orders and receives them.';
    const html = `<div class="ro-banner"><span class="ro-badge">APPROVAL CHAIN</span>
        <span>${esc(note)}</span></div>
      <div id="rvStats" class="stat-grid"></div>
      <div class="panel"><div class="panel-head"><h3>Requisition Requests</h3>
        <div class="panel-tools">${exportButtons('rv')}</div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="rvQ" placeholder="Search item / requester / vendor...">
        <select class="filter-sel" id="rvType"><option value="">All Types</option>
          <option value="Goods">Goods (Faculty)</option><option value="Book">Books (Librarian)</option></select>
        <select class="filter-sel" id="rvStatus"><option value="">All Statuses</option>${optionsFrom(REQ_STATUS)}</select>
        <select class="filter-sel" id="rvPriority"><option value="">All Priorities</option>${optionsFrom(REQ_PRIORITIES)}</select>
        <label class="days-field">From <input class="filter-sel" id="rvFrom" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="rvTo" type="date"></label>
        <button class="btn-outline btn-sm" id="rvClear">Clear</button>
      </div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Req ID</th><th>Type</th><th>Item / Title</th><th>Raised By</th><th>Department</th>
        <th style="text-align:right">Qty</th><th style="text-align:right">Est. Cost</th>
        <th>Priority</th><th>Needed By</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="rvBody"></tbody></table></div><div id="rvPager"></div></div>`;

    viewRequisitions.after = () => {
      let page = 1;
      const ids = ['rvQ', 'rvType', 'rvStatus', 'rvPriority', 'rvFrom', 'rvTo'];
      const rowsOf = () => visibleRequisitions().map(r => ({
        ...r,
        status: r.status || 'Pending',
        priority: r.priority || 'Normal',
        totalEstimate: (+r.estimatedCost || 0),
      }));
      const filtered = () => {
        const q = ($('#rvQ').value || '').trim().toLowerCase();
        const type = $('#rvType').value, st = $('#rvStatus').value, pr = $('#rvPriority').value;
        const from = $('#rvFrom').value, to = $('#rvTo').value;
        return rowsOf().filter(r =>
          (!q || [r.id, r.title, r.author, r.requesterName, r.vendor, r.category, r.department]
            .some(v => String(v || '').toLowerCase().includes(q))) &&
          (!type || r.type === type) && (!st || r.status === st) && (!pr || r.priority === pr) &&
          (!from || (r.requestDate || '') >= from) && (!to || (r.requestDate || '') <= to))
          .sort((a, b) => (a.status === 'Pending' ? 0 : 1) - (b.status === 'Pending' ? 0 : 1) ||
            REQ_PRIORITIES.indexOf(b.priority) - REQ_PRIORITIES.indexOf(a.priority) ||
            String(b.requestDate || '').localeCompare(String(a.requestDate || '')));
      };
      const draw = () => {
        const rows = filtered();
        page = Math.min(page, pageCount(rows.length));
        const all = rowsOf();
        const count = (s) => all.filter(r => r.status === s).length;
        const pendingValue = all.filter(r => r.status === 'Pending').reduce((a, r) => a + r.totalEstimate, 0);
        $('#rvStats').innerHTML = `${statCard('📦', all.length, isAcct ? 'Cleared for Accounts' : 'Total Requests')}
          ${isAcct
            ? statCard('✅', count('Approved'), 'Ready to Order', count('Approved') ? 'c2' : 'c3')
            : statCard('⏳', count('Pending'), 'Awaiting Center Head', count('Pending') ? 'c2' : 'c3')}
          ${statCard('💰', money(isAcct
              ? all.filter(r => r.status === 'Approved').reduce((a, r) => a + r.totalEstimate, 0)
              : pendingValue), isAcct ? 'Value to Order' : 'Pending Value', pendingValue ? 'c4' : 'c3')}
          ${statCard('📥', count('Ordered') + count('Received'), 'Ordered / Received', 'c3')}`;
        $('#rvBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td class="mono">${esc(r.id)}</td>
          <td><span class="pill ${r.type === 'Book' ? 'blue' : 'amber'}">${esc(r.type)}</span></td>
          <td>${esc(r.title)}${r.author ? `<br><small style="color:var(--muted)">${esc(r.author)}</small>` : ''}</td>
          <td>${esc(r.requesterName || '—')}<br><small style="color:var(--muted)">${esc(r.requesterRole || '')}</small></td>
          <td>${esc(r.department || '—')}</td>
          <td style="text-align:right">${r.quantity ?? '—'}</td>
          <td style="text-align:right">${money(r.estimatedCost)}</td>
          <td><span class="pill ${PRIORITY_PILL[r.priority]}">${esc(r.priority)}</span></td>
          <td>${esc(r.neededBy || '—')}</td>
          <td><span class="pill ${REQ_PILL[r.status]}">${esc(r.status)}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${r.id}">👁 View</button>
            <button class="btn-sm btn-edit" data-review="${r.id}">${isCH ? '✅ Approve' : '📝 Review'}</button>
            ${isCH ? '' : `<button class="btn-sm btn-del" data-del="${r.id}">Delete</button>`}
          </div></td></tr>`).join('')
          : `<tr><td colspan="11" class="empty">${isAcct
              ? 'Nothing approved yet — requests are still with the center head.'
              : 'No requisitions match these filters.'}</td></tr>`;
        $('#rvBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => requisitionViewModal(b.dataset.view));
        $('#rvBody').querySelectorAll('[data-review]').forEach(b => b.onclick = () => reviewRequisitionForm(b.dataset.review, draw));
        $('#rvBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const r = Store.find('requisitions', b.dataset.del) || {};
          confirmDelete('Delete Requisition', `Delete request <b>${esc(r.id)}</b> for <b>${esc(r.title)}</b>
            raised by ${esc(r.requesterName || '—')}? The requester will no longer see it.`,
            'Delete', () => { Store.remove('requisitions', r.id); toast('Requisition deleted.', 'err'); draw(); });
        });
        $('#rvPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#rvPager'), rows.length, page, (p) => page = p, draw);
      };
      ids.forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#rvClear').onclick = () => { ids.forEach(id => $('#' + id).value = ''); page = 1; draw(); };
      bindExports('rv', () => {
        const rows = filtered();
        return {
          title: 'Requisition Report', sheetName: 'Requisitions', subtitle: reportStamp(),
          columns: [
            { header: 'Req ID', key: 'id', width: 10 },
            { header: 'Type', key: 'type', width: 10 },
            { header: 'Item / Title', key: 'title', width: 30 },
            { header: 'Author', key: 'author', width: 20 },
            { header: 'Category', key: 'category', width: 18 },
            { header: 'Raised By', key: 'requesterName', width: 22 },
            { header: 'Role', key: 'requesterRole', width: 12 },
            { header: 'Department', key: 'department', width: 20 },
            { header: 'Quantity', key: 'quantity', width: 10, type: 'number' },
            { header: 'Estimated Cost', key: 'estimatedCost', width: 16, money: true },
            { header: 'Vendor', key: 'vendor', width: 20 },
            { header: 'Priority', key: 'priority', width: 11 },
            { header: 'Request Date', key: 'requestDate', width: 14 },
            { header: 'Needed By', key: 'neededBy', width: 13 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Reviewed By', key: 'reviewedBy', width: 20 },
            { header: 'Review Remarks', key: 'reviewRemarks', width: 34 },
          ],
          rows,
          totals: {
            id: 'TOTAL', type: rows.length + ' requests',
            quantity: rows.reduce((a, r) => a + (+r.quantity || 0), 0),
            estimatedCost: rows.reduce((a, r) => a + (+r.estimatedCost || 0), 0),
          },
        };
      });
      draw();
    };
    return html;
  }

  function reviewRequisitionForm(id, after) {
    const r = Store.find('requisitions', id);
    if (!r) return;
    const status = r.status || 'Pending';
    const isBook = r.type === 'Book';
    const isCH = user.role === 'center_head';
    // the accounts office cannot pick a request up while it is still pending
    if (user.role === 'accountant' && isReqPending(r)) {
      toast('This request is still with the center head for approval.', 'err');
      return;
    }
    // converting a request into an asset or a book writes to those tables, so
    // it belongs to whoever processes the request, not to the approver
    const canConvert = !isCH && ['Approved', 'Ordered', 'Received'].includes(status) && !r.linkedId;
    const choices = reqStatusChoices();
    openModal(`${isCH ? 'Approval' : 'Review'} ${r.id} — ${r.title}`, `<form id="f">
      <div class="tbl-wrap" style="margin-bottom:16px"><table><tbody>
        <tr><td style="font-weight:600;width:180px">Raised By</td>
          <td>${esc(r.requesterName || '—')} · ${esc(r.department || '—')} · ${esc(r.requestDate || '—')}</td></tr>
        <tr><td style="font-weight:600">${isBook ? 'Book' : 'Item'}</td>
          <td>${esc(r.title)}${r.author ? ' — ' + esc(r.author) : ''}</td></tr>
        <tr><td style="font-weight:600">Quantity × Est. Cost</td>
          <td>${r.quantity} × ${money(r.estimatedCost)}</td></tr>
        <tr><td style="font-weight:600">Priority / Needed By</td>
          <td><span class="pill ${PRIORITY_PILL[r.priority || 'Normal']}">${esc(r.priority || 'Normal')}</span>
            · ${esc(r.neededBy || '—')}</td></tr>
        <tr><td style="font-weight:600">Purpose</td><td style="white-space:pre-line">${esc(r.purpose || '—')}</td></tr>
      </tbody></table></div>
      <div class="form-grid">
        <div class="field"><label>${isCH ? 'Your Decision' : 'Decision / Status'}</label>
          <select name="status">${optionsFrom(choices, choices.includes(status) ? status : choices[0])}</select></div>
        <div class="field"><label>Reviewed On</label><input name="reviewedOn" type="date" value="${esc(r.reviewedOn || today())}"></div>
        <div class="field full"><label>Review Remarks</label>
          <textarea name="reviewRemarks" rows="3" placeholder="Reason for the decision, budget note, PO number…">${esc(r.reviewRemarks || '')}</textarea></div>
      </div>
      ${r.linkedId
        ? `<p style="font-size:12.5px;color:var(--green);margin-top:10px">✔ Already added to
             ${isBook ? 'the library catalogue' : 'the asset register'} as <b>${esc(r.linkedId)}</b>.</p>`
        : canConvert
          ? `<label class="switch-label" style="margin-top:12px">
               <input type="checkbox" id="rqConvert">
               <span>Also add this to ${isBook ? 'the Library catalogue' : 'the Asset register'} now</span></label>`
          : `<p style="font-size:12px;color:var(--muted);margin-top:10px">
               ${isCH
                 ? 'Once you approve this, the accounts office picks it up and orders it.'
                 : `Approve the request first to add it to ${isBook ? 'the library' : 'the asset register'}.`}</p>`}
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save Decision</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (d.status === 'Rejected' && !String(d.reviewRemarks || '').trim()) {
        toast('Please give a reason when rejecting a request.', 'err');
        return;
      }
      const convert = $('#rqConvert') && $('#rqConvert').checked;
      confirmAction('Save Decision',
        `Mark request <b>${esc(r.id)}</b> (${esc(r.title)}) as <b>${esc(d.status)}</b>` +
        (convert ? `, and add it to ${isBook ? 'the library catalogue' : 'the asset register'}` : '') + '?',
        'Confirm', () => {
          const patch = {
            status: d.status, reviewedOn: d.reviewedOn,
            reviewedBy: user.name || user.username,
            reviewRemarks: String(d.reviewRemarks || '').trim(),
          };
          if (convert) patch.linkedId = convertRequisition(r);
          Store.update('requisitions', id, patch);
          closeModal();
          toast(`Request ${d.status.toLowerCase()}.` + (convert ? ' Added to ' + (isBook ? 'library.' : 'assets.') : ''));
          after ? after() : render();
        });
    };
  }

  // an approved request becomes a real book or a real asset — returns the new id
  function convertRequisition(r) {
    const qty = +r.quantity || 1;
    if (r.type === 'Book') {
      const book = Store.add('books', {
        title: r.title, author: r.author || '', isbn: r.isbn || '',
        category: r.category || 'General', total: qty, available: qty,
      });
      return book.id;
    }
    const cost = +r.estimatedCost || 0;
    const asset = Store.add('assets', {
      name: r.title,
      category: listValues('assetCategory').includes(r.category) ? r.category : 'Other',
      quantity: qty, purchaseDate: today(),
      purchaseCost: cost, currentValue: cost,
      vendor: r.vendor || '', location: r.department || '', status: 'In Use',
    });
    return asset.id;
  }

  /* ---------- shared form utils ---------- */
  function formData(form) {
    const o = {};
    new FormData(form).forEach((v, k) => o[k] = typeof v === 'string' ? v.trim() : v);
    return o;
  }
  // profile photo field shared by studentForm / facultyForm — stores a base64
  // data URL in a hidden input so it rides along with the rest of formData()
  function photoField(photo) {
    return `<div class="field full">
      <label>Photo</label>
      <input type="file" accept="image/*" id="photoFileInput">
      <input type="hidden" name="photo" id="photoValueInput" value="${esc(photo||'')}">
      <div id="photoPreview" style="margin-top:8px">${photo ?
        `<img src="${esc(photo)}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">` : ''}</div>
    </div>`;
  }
  function bindPhotoField() {
    $('#photoFileInput').onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('Please select an image file.', 'err'); e.target.value = ''; return; }
      // phone/camera photos are often several MB — downscale + re-encode as JPEG
      // client-side so any original size works and the saved payload stays small
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 400;
          let { width, height } = img;
          if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
          else if (height >= width && height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
          $('#photoValueInput').value = dataUrl;
          $('#photoPreview').innerHTML = `<img src="${dataUrl}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:1px solid var(--line)">`;
        };
        img.onerror = () => toast('Could not load that photo — please try another file.', 'err');
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    };
  }
  /* ---------- branch list: saved by the admin + every branch actually in use ---------- */
  const COURSE_TYPES = ['Core', 'Elective', 'Lab', 'Project'];
  const DEFAULT_BRANCHES = ['MBA'];
  const SET_BRANCHES = 'branchList';
  let BRANCHES = DEFAULT_BRANCHES.slice();     // kept as one array — bindListAddNew holds a reference

  function savedBranchList() {
    const row = settingRow(SET_BRANCHES);
    if (!row || !row.value) return null;
    return String(row.value).split(',').map(s => s.trim()).filter(Boolean);
  }
  // rebuilt in place so the dropdowns never miss a branch that exists in the data
  function refreshBranches() {
    const set = new Set(savedBranchList() || DEFAULT_BRANCHES);
    // `syllabus` too: a branch can exist in the curriculum before anyone is
    // enrolled in it, and it still has to be offered in the branch dropdowns
    ['students', 'courses', 'timetable', 'syllabus'].forEach(col =>
      Store.all(col).forEach(r => { if (r.branch) set.add(String(r.branch).trim().toUpperCase()); }));
    const list = [...set].filter(Boolean).sort();
    BRANCHES.length = 0;
    list.forEach(b => BRANCHES.push(b));
    return BRANCHES;
  }
  function saveBranchList() {
    const row = settingRow(SET_BRANCHES);
    const value = BRANCHES.join(',');
    if (row) Store.update('settings', row.id, { value });
    else Store.add('settings', { name: SET_BRANCHES, value });
  }
  // a branch select that can add/remove branches, and remembers them across reloads
  function bindBranchSelect(select) {
    bindListAddNew(select, BRANCHES, 'New branch name (e.g. AGRIL):',
      (v) => branchOptions(v, true),
      (raw) => raw.trim().toUpperCase(),
      saveBranchList,
      branchInUse);
  }

  /* Why a branch cannot be removed, or null when it can.

     refreshBranches() rebuilds the list from the data on every redraw, so a
     branch that still has students, courses, timetable slots or syllabus rows
     reappears the moment it is dropped. Refusing with the counts is honest;
     letting it vanish and come back looks like the button is broken. */
  function branchInUse(branch) {
    const counts = [
      ['student', Store.all('students').filter(r => r.branch === branch).length],
      ['course', Store.all('courses').filter(r => r.branch === branch).length],
      ['timetable slot', Store.all('timetable').filter(r => r.branch === branch).length],
      ['syllabus subject', Store.all('syllabus').filter(r => r.branch === branch).length],
    ].filter(([, n]) => n > 0);
    if (!counts.length) return null;
    return `"${branch}" is still used by ${counts.map(([w, n]) => plural(n, w)).join(', ')}. `
      + 'Move or delete those first.';
  }

  function branchOptions(sel, withExtras) {
    refreshBranches();
    return BRANCHES.map(b =>
      `<option ${b===sel?'selected':''}>${b}</option>`).join('') + (withExtras ? listExtraOpts() : '');
  }

  /* ---------- other editable master lists ----------
     Same deal as the branch list: the dropdown carries "+ Add New..." and
     "🗑 Remove...", the list is remembered in `settings` so everyone sees it,
     and any value already present in the data is always included so an
     existing record can never end up with an option that isn't listed. */
  const LIST_DEFS = {
    assetCategory: {
      setting: 'assetCategoryList', defaults: ASSET_CATEGORIES,
      prompt: 'New asset category (e.g. Air Conditioner):',
      used: () => Store.all('assets').map(a => a.category),
    },
    feeType: {
      setting: 'feeTypeList', defaults: FEE_TYPES,
      prompt: 'New fee type (e.g. Hostel Fee):',
      used: () => Store.all('fixedfees').map(f => f.feeType),
    },
    course: {
      setting: 'courseList', defaults: ACADEMIC_COURSES,
      prompt: 'New course (e.g. B.Pharm):',
      used: () => Store.all('students').map(s => s.course)
        .concat(Store.all('fixedfees').map(f => f.course)),
    },
    goodsCategory: {
      setting: 'goodsCategoryList', defaults: REQ_GOODS_CATEGORIES,
      prompt: 'New item category:',
      used: () => Store.all('requisitions').filter(r => r.type === 'Goods').map(r => r.category),
    },
    bookCategory: {
      setting: 'bookCategoryList', defaults: BOOK_CATEGORIES,
      prompt: 'New book category (e.g. Biotechnology):',
      used: () => Store.all('books').map(b => b.category)
        .concat(Store.all('requisitions').filter(r => r.type === 'Book').map(r => r.category)),
    },
    /* The branch a student is admitted into. Held apart from `branch`, which
       is the programme, and from the specialisation, which is the stream taken
       inside it. Editable for the same reason as the rest. */
    branchName: {
      setting: 'branchNameList',
      defaults: ['General Management', 'Logistics and Supply Chain Management', 'Retail Management'],
      prompt: 'New branch (e.g. Business Analytics):',
      used: () => Store.all('students').map(s => s.branchName),
    },
    /* The stream a student takes inside the MBA — Marketing, Finance, HR and
       the rest. Editable, because no two institutes run the same set. */
    specialisation: {
      setting: 'specialisationList',
      defaults: ['Marketing', 'Finance', 'HR', 'Retail', 'Logistics'],
      prompt: 'New specialisation (e.g. Business Analytics):',
      // fee heads can be set per specialisation, so one in use there counts too
      used: () => Store.all('students').map(s => s.specialisation)
        .concat(Store.all('fixedfees').map(f => f.branch)
          .filter(v => String(v || '').trim().toUpperCase() !== 'MBA')),
    },
    // People a faculty member reports to who are not faculty themselves — a
    // director, a registrar, the HR head. Faculty come from the faculty table
    // and are stored by id; these are stored as the plain name.
    /* What an employee is called. Spans every staff table, so a designation
       entered on the Accountant form is offered on the Employees form too and
       neither list can drift from the other. */
    designation: {
      setting: 'designationList', defaults: DESIGNATIONS,
      prompt: 'New designation (e.g. Dean — Academics):',
      used: () => STAFF_TABLES.reduce((a, col) =>
        a.concat(Store.all(col).map(x => x.designation)), []),
    },
    /* Which part of the college they belong to. departmentList() stays what it
       always was — the departments actually in use, which is what the reports
       count; this is the wider list a form may offer. */
    department: {
      setting: 'departmentList', defaults: DEPARTMENTS,
      prompt: 'New department (e.g. Computer Applications):',
      used: () => STAFF_TABLES.reduce((a, col) =>
        a.concat(Store.all(col).map(x => x.department)), []),
    },
    reportingTo: {
      setting: 'reportingToList', defaults: [],
      prompt: 'Name of the person reported to (e.g. Director — Dr. S. Rath):',
      used: () => Store.all('faculty').map(f => f.reportingTo)
        .filter(v => v && !Store.find('faculty', v)),
    },
  };
  // one live array per list — bindListAddNew keeps a reference, so rebuild in place
  const LIST_CACHE = {};

  function listValues(name) {
    const def = LIST_DEFS[name];
    const row = settingRow(def.setting);
    const base = row && row.value
      ? String(row.value).split(',').map(s => s.trim()).filter(Boolean)
      : def.defaults.slice();
    const seen = new Set(base);
    const extras = [];
    def.used().forEach(v => {
      const s = String(v || '').trim();
      if (s && !seen.has(s)) { seen.add(s); extras.push(s); }
    });
    const arr = LIST_CACHE[name] || (LIST_CACHE[name] = []);
    arr.length = 0;
    base.concat(extras.sort()).forEach(v => arr.push(v));
    return arr;
  }
  function saveList(name) {
    const def = LIST_DEFS[name];
    const row = settingRow(def.setting);
    const value = (LIST_CACHE[name] || []).join(',');
    if (row) Store.update('settings', row.id, { value });
    else Store.add('settings', { name: def.setting, value });
  }
  function listOptions(name, sel, withExtras) {
    return optionsFrom(listValues(name), sel) + (withExtras ? listExtraOpts() : '');
  }
  // how many saved records still use this value — removing it would orphan them
  function listUsageCount(name, value) {
    return LIST_DEFS[name].used().filter(v => String(v || '').trim() === value).length;
  }
  function bindCustomList(select, name) {
    bindListAddNew(select, listValues(name), LIST_DEFS[name].prompt,
      (v) => listOptions(name, v, true),
      (raw) => raw.trim(),
      () => saveList(name),
      (val) => {
        const n = listUsageCount(name, val);
        return n ? `"${val}" is used by ${n} record(s) — change those first.` : null;
      },
      () => manageListModal(name, select));
  }

  /* Tick what should go. A value still on somebody's record cannot be removed —
     the row says so and how many records hold it, which the old prompt could
     not. The list rebuilds behind the modal, so the dropdown that opened it
     shows the result straight away. */
  function manageListModal(name, select) {
    const def = LIST_DEFS[name];
    const label = name === 'course' ? 'Courses' : name === 'specialisation' ? 'Specialisations' : 'Values';
    const draw = () => {
      const values = listValues(name).slice();
      const rows = values.map((v) => {
        const used = listUsageCount(name, v);
        return `<label class="chk-row ${used ? 'chk-locked' : ''}">
          <input type="checkbox" value="${esc(v)}" ${used ? 'disabled' : ''}>
          <span class="chk-text"><strong>${esc(v)}</strong>
            <small>${used ? `in use by ${plural(used, 'record')} — change those first` : 'not used by any record'}</small>
          </span></label>`;
      }).join('');
      openModal2('Manage ' + label, `
        <p style="font-size:13px;color:var(--muted);margin:0 0 12px">
          Tick what you want to remove. A value still on a record is locked.</p>
        <div class="chk-list" id="mlList">${rows || '<p class="empty">Nothing in this list yet.</p>'}</div>
        <div class="form-actions">
          <button type="button" class="btn-outline" id="cx">Close</button>
          <button type="button" class="btn-primary" style="background:var(--red)" id="mlGo">Remove selected</button>
        </div>`, true);
      $('#modal2Body').querySelector('#cx').onclick = closeModal2;
      const go = $('#modal2Body').querySelector('#mlGo');
      let armed = false;
      // un-arm the moment the selection changes, so the confirmed count is
      // always the count that was shown
      $('#modal2Body').querySelectorAll('#mlList input').forEach(box => box.onchange = () => {
        if (!armed) return;
        armed = false; go.textContent = 'Remove selected';
      });
      go.onclick = () => {
        const picked = [...document.querySelectorAll('#mlList input:checked')].map(i => i.value);
        if (!picked.length) { toast('Nothing ticked.', 'err'); return; }
        const list = listValues(name);
        if (list.length - picked.length < 1) {
          toast('At least one value has to remain.', 'err'); return;
        }
        if (!armed) {
          armed = true;
          go.textContent = `Confirm — remove ${plural(picked.length, 'value')}`;
          return;
        }
        picked.forEach(v => {
          const i = list.indexOf(v);
          if (i !== -1) list.splice(i, 1);
        });
        saveList(name);
        if (select) {
          const keep = list.includes(select.value) ? select.value : list[0];
          select.innerHTML = listOptions(name, keep, true);
          select.value = keep;
        }
        closeModal2();
        toast(`Removed ${plural(picked.length, 'value')}.`);
      };
    };
    draw();
  }
  function facultyOptions(sel, withAddNew) {
    return teachingStaff().map(f =>
      `<option value="${f.id}" ${f.id===sel?'selected':''}>${esc(f.name)}</option>`).join('') + (withAddNew ? addNewOpt() : '');
  }

  /* ---------- "Add New" / "Remove" options for list-backed form dropdowns ---------- */
  const ADD_NEW = '__addnew__';
  const REMOVE_OPT = '__removeopt__';
  function addNewOpt(label) { return `<option value="${ADD_NEW}">+ ${label || 'Add New...'}</option>`; }
  function removeOpt() { return `<option value="${REMOVE_OPT}">🗑 Remove...</option>`; }
  function listExtraOpts(label) { return addNewOpt(label) + removeOpt(); }

  // for selects backed by a plain string list (Branch, Day, Period): typing a
  // new value pushes it into the list and re-renders the select with it selected;
  // picking "Remove..." lets you take an existing value back out of the list.
  // `canRemove(value)` may return a message to block a removal (e.g. still in use)
  function bindListAddNew(select, list, promptText, rebuild, parse, onListChange, canRemove, onRemoveClick) {
    if (!select) return;
    let prevValue = select.value;
    select.onchange = () => {
      const v = select.value;
      if (v === ADD_NEW) {
        const raw = (window.prompt(promptText) || '').trim();
        if (!raw) { select.value = prevValue; return; }
        const val = parse ? parse(raw) : raw;
        if (val === null || val === '') { select.value = prevValue; return; }
        if (!list.includes(val)) list.push(val);
        if (onListChange) onListChange(list);
        select.innerHTML = rebuild(val);
        select.value = val; prevValue = val;
        return;
      }
      if (v === REMOVE_OPT) {
        select.value = prevValue;
        if (onRemoveClick) { onRemoveClick(); return; }
        if (list.length <= 1) { toast('At least one option must remain.', 'err'); return; }
        const raw = (window.prompt('Remove which value?\n(' + list.join(', ') + ')') || '').trim();
        if (!raw) { select.value = prevValue; return; }
        const target = parse ? parse(raw) : raw;
        const idx = list.indexOf(target);
        if (idx === -1) { toast('"' + raw + '" not found in list.', 'err'); select.value = prevValue; return; }
        const blocked = canRemove ? canRemove(target) : null;
        if (blocked) { toast(blocked, 'err'); select.value = prevValue; return; }
        list.splice(idx, 1);
        if (onListChange) onListChange(list);
        const next = list[0];
        select.innerHTML = rebuild(next);
        select.value = next; prevValue = next;
        return;
      }
      prevValue = v;
    };
  }

  // for selects backed by a real entity (Faculty, Course): "Add New" preserves
  // the current form's other fields, opens the entity's own Add form, then
  // reopens this form pre-filled with the newly created entity selected.
  function bindEntityAddNew(select, openCreate) {
    if (!select) return;
    select.onchange = () => {
      if (select.value !== ADD_NEW) return;
      openCreate();
    };
  }
  /* A person and the login that belongs to them go together. Left behind, the
     login still signs in — against a record that no longer exists — and it
     holds the registration number hostage, because a username is unique. */
  /* Which record a login belongs to. A login keeps its own copy of the name,
     and a copy goes stale the moment the office corrects a spelling — so the
     record is asked first, the copy second, and the user id last. That way the
     bar carries a name for every role and is never left blank. */
  const LOGIN_RECORD = {
    student: 'students', faculty: 'faculty', accountant: 'accountants',
    center_head: 'centerheads', placement_officer: 'placementofficers',
    course_coordinator: 'coordinators', admission: 'admissions',
  };
  function loginRecord(u) {
    if (!u || !u.refId) return null;
    const col = LOGIN_RECORD[u.role];
    const rec = col ? Store.find(col, u.refId) : null;
    /* The register can hold any role now, so an accountant added there has a
       login whose mapped table knows nothing about them. Ask the register
       second rather than leave the top bar without a name. */
    return rec || (u.role === 'student' ? null : Store.find('faculty', u.refId)) || null;
  }
  function displayName(u) {
    const rec = loginRecord(u) || {};
    return String(rec.name || (u && u.name) || (u && u.username) || 'User').trim();
  }

  const COLLECTIONS_WITH_LOGIN = ['students', 'faculty', 'accountants', 'centerheads',
                                  'placementofficers', 'coordinators', 'admissions'];
  function removeLinkedLogins(col, id) {
    if (!COLLECTIONS_WITH_LOGIN.includes(col)) return 0;
    const owned = Store.all('users').filter(u => u.refId === id);
    owned.forEach(u => Store.remove('users', u.id));
    return owned.length;
  }

  function delConfirm(col, id, label, after) {
    const logins = COLLECTIONS_WITH_LOGIN.includes(col)
      ? Store.all('users').filter(u => u.refId === id) : [];
    confirmDelete('Delete ' + label,
      `Are you sure you want to delete this ${esc(label)}?`
      + (logins.length ? `<br><span style="color:var(--muted);font-size:13px">Their login <b>${
          esc(logins[0].username || '')}</b> is removed with them.</span>` : ''),
      'Delete', () => {
        const removed = removeLinkedLogins(col, id);
        Store.remove(col, id);
        toast(label + (removed ? ' and their login deleted.' : ' deleted.'), 'err');
        after ? after() : render();
      });
  }
  function today() { const d = new Date(); return d.toISOString().slice(0,10); }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0,10);
  }

  /* =========================================================
     CENTER HEAD — read-only monitoring of the whole college.

     Nothing below keeps its own copy of anything: every number is derived
     from the same collections the admin, accountant, faculty and librarian
     write to, so the center head always sees the current state of the CMS.
     There is deliberately not one create/update/delete call in this section.
     ========================================================= */

  /* ---------- aggregations shared by the dashboard and the reports ---------- */

  /** every department name in use, from the faculty records */
  function departmentList() {
    return [...new Set(Store.all('faculty').map(f => (f.department || '').trim()).filter(Boolean))].sort();
  }

  /** attendance of one course: sessions held and the present/total percentage */
  function courseAttendance(courseId) {
    const sessions = Store.all('attendance').filter(a => a.courseId === courseId);
    let present = 0, marks = 0;
    sessions.forEach(a => {
      const vals = Object.values(a.records || {});
      marks += vals.length;
      present += vals.filter(v => v === 'P').length;
    });
    return { sessions: sessions.length, marks, present,
             pct: marks ? Math.round(present / marks * 100) : null };
  }

  /** attendance of a set of students, across every session they appear in */
  function attendanceOf(studentIds) {
    const ids = new Set(studentIds);
    let present = 0, marks = 0;
    Store.all('attendance').forEach(a => {
      Object.entries(a.records || {}).forEach(([sid, v]) => {
        if (!ids.has(sid)) return;
        marks++;
        if (v === 'P') present++;
      });
    });
    return { marks, present, pct: marks ? Math.round(present / marks * 100) : null };
  }

  /** college-wide attendance across every recorded session */
  function overallAttendance() {
    let present = 0, marks = 0;
    Store.all('attendance').forEach(a => {
      const vals = Object.values(a.records || {});
      marks += vals.length;
      present += vals.filter(v => v === 'P').length;
    });
    return { marks, present, pct: marks ? Math.round(present / marks * 100) : null };
  }

  /** the branch a department maps onto, so faculty and students can be joined */
  function branchOfDepartment(dept) {
    const d = String(dept || '').trim();
    if (!d) return null;
    if (BRANCHES.includes(d.toUpperCase())) return d.toUpperCase();
    const map = {
      'management': 'MBA', 'business administration': 'MBA',
      'master of business administration': 'MBA', 'mba': 'MBA',
    };
    return map[d.toLowerCase()] || null;
  }

  /** one row per department: staff, subjects, students, attendance */
  function departmentRows() {
    refreshBranches();
    // one pass over the fee ledger, indexed by student, instead of a rebuild per row
    const finBySid = new Map(financeRows().map(r => [r.sid, r]));
    return departmentList().map(dept => {
      const faculty = Store.all('faculty').filter(f => (f.department || '').trim() === dept);
      const branch = branchOfDepartment(dept);
      const students = branch ? Store.all('students').filter(s => s.branch === branch) : [];
      const courses = branch ? Store.all('courses').filter(c => c.branch === branch) : [];
      const att = attendanceOf(students.map(s => s.id));
      const fin = students.reduce((a, s) => {
        const r = finBySid.get(s.id);
        return r ? { total: a.total + r.total, paid: a.paid + r.paid, pending: a.pending + r.pending } : a;
      }, { total: 0, paid: 0, pending: 0 });
      return {
        department: dept, branch: branch || '—', faculty: faculty.length,
        professors: faculty.filter(f => /professor/i.test(f.designation || '')).length,
        courses: courses.length, students: students.length,
        attendance: att.pct === null ? '—' : att.pct,
        feeTotal: fin.total, feePaid: fin.paid, feePending: fin.pending,
      };
    }).sort((a, b) => b.students - a.students || a.department.localeCompare(b.department));
  }

  /** one row per branch: students, courses, faculty, attendance, fees */
  /* Subjects and staff belong to the programme, not to a stream inside it,
     so this counts what a specialisation actually has of its own: students,
     the semesters they sit in, their attendance and their fees. */
  function branchSummaryRows() {
    const students = Store.all('students');
    const used = [...new Set(specialisationList().concat(students.map(specOf)).filter(Boolean))].sort();
    const fin = financeRows();
    return used.map(b => {
      const mine = students.filter(s => specOf(s) === b);
      const att = attendanceOf(mine.map(s => s.id));
      const rows = fin.filter(r => r.branch === b);
      return {
        branch: b, students: mine.length,
        semesters: [...new Set(mine.map(s => s.semester))].filter(v => v !== '' && v != null).sort((x, y) => x - y).join(', ') || '—',
        attendance: att.pct === null ? '—' : att.pct,
        feeTotal: rows.reduce((a, r) => a + r.total, 0),
        feePaid: rows.reduce((a, r) => a + r.paid, 0),
        feePending: rows.reduce((a, r) => a + r.pending, 0),
      };
    }).filter(r => r.students);
  }

  /** one row per semester: headcount, attendance and the fee roll-up */
  function semesterSummaryRows() {
    const students = Store.all('students');
    const fin = financeRows();
    const sems = [...new Set(students.map(s => +s.semester || 0))].filter(Boolean).sort((a, b) => a - b);
    return sems.map(sem => {
      const mine = students.filter(s => +s.semester === sem);
      const att = attendanceOf(mine.map(s => s.id));
      const rows = fin.filter(r => +r.semester === sem);
      return {
        semester: 'Semester ' + sem, students: mine.length,
        branches: [...new Set(mine.map(s => s.branch))].filter(Boolean).join(', ') || '—',
        attendance: att.pct === null ? '—' : att.pct,
        feeTotal: rows.reduce((a, r) => a + r.total, 0),
        feePaid: rows.reduce((a, r) => a + r.paid, 0),
        feePending: rows.reduce((a, r) => a + r.pending, 0),
      };
    });
  }

  /** one row per course: class, faculty, headcount, sessions and attendance */
  function courseAttendanceRows() {
    return Store.all('courses').map(c => {
      const att = courseAttendance(c.id);
      return {
        code: c.code || '—', name: c.name || '—',
        branch: c.branch || '—', semester: c.semester || '—', section: c.section || 'A',
        faculty: facultyName(c.facultyId), students: studentsOfCourse(c).length,
        sessions: att.sessions, present: att.present, marks: att.marks,
        attendance: att.pct === null ? '—' : att.pct,
      };
    }).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  }

  /** one row per student: identity plus attendance and result standing */
  function studentAttendanceRows() {
    return Store.all('students').map(s => {
      const sessions = Store.all('attendance').filter(a => s.id in (a.records || {}));
      const present = sessions.filter(a => a.records[s.id] === 'P').length;
      return {
        roll: s.roll || '', name: s.name || '', course: s.course || '—', branch: specOf(s) || '—',
        semester: s.semester || '', section: s.section || 'A',
        held: sessions.length, present, absent: sessions.length - present,
        attendance: sessions.length ? Math.round(present / sessions.length * 100) : '—',
        gpa: studentGPA(s.id) ?? '—',
      };
    }).sort((a, b) => String(a.roll).localeCompare(String(b.roll)));
  }

  /** one row per faculty member: teaching load and the sessions they recorded */
  function facultyAttendanceRows() {
    return Store.all('faculty').map(f => {
      const load = facultyTeachingLoad(f.id);
      return {
        empId: f.empId || '—', name: f.name || '', department: f.department || '—',
        designation: f.designation || '—', classes: load.classes, students: load.students,
        sessions: load.sessions,
        avgAttendance: load.avgAttendance === null ? '—' : load.avgAttendance,
        lastSession: load.lastSession || '—',
      };
    }).sort((a, b) => b.sessions - a.sessions || String(a.name).localeCompare(String(b.name)));
  }

  /** every recorded class session, newest first */
  function attendanceSessionRows() {
    return Store.all('attendance').map(a => {
      const c = Store.find('courses', a.courseId) || {};
      const n = sessionCounts(a);
      return {
        date: a.date || '', code: c.code || '—', name: c.name || '—',
        branch: a.specialisation || c.branch || '—',
        semester: a.semester || c.semester || '—', section: c.section || 'A',
        faculty: facultyName(c.facultyId),
        present: n.present, absent: n.absent, total: n.total, attendance: n.pct,
      };
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  /** library figures in one object */
  function libraryTotals() {
    const books = Store.all('books');
    const txns = libraryTransactions();
    return {
      titles: books.length,
      copies: books.reduce((s, b) => s + (+b.total || 0), 0),
      available: books.reduce((s, b) => s + (+b.available || 0), 0),
      issued: txns.filter(t => !t.returned).length,
      returned: txns.filter(t => t.returned).length,
      overdue: txns.filter(t => t.overdue).length,
      transactions: txns.length, txns, books,
    };
  }

  /** asset figures in one object */
  function assetTotals() {
    const assets = Store.all('assets');
    const live = assets.filter(a => a.status !== 'Disposed');
    const by = (pred) => assets.filter(pred);
    return {
      entries: assets.length,
      units: assets.reduce((a, x) => a + (+x.quantity || 0), 0),
      cost: assets.reduce((a, x) => a + (+x.purchaseCost || 0), 0),
      value: live.reduce((a, x) => a + (+x.currentValue || 0), 0),
      categories: [...new Set(assets.map(a => a.category).filter(Boolean))].length,
      available: by(a => a.status === 'In Store').reduce((a, x) => a + (+x.quantity || 0), 0),
      assigned: by(a => a.status === 'In Use').reduce((a, x) => a + (+x.quantity || 0), 0),
      damaged: by(a => a.status === 'Damaged' || a.status === 'Under Maintenance')
        .reduce((a, x) => a + (+x.quantity || 0), 0),
      assets,
    };
  }

  /* ---------- the read-only banner every center-head page carries ---------- */
  function readOnlyBanner(text) {
    return `<div class="ro-banner">
      <span class="ro-badge">👁 READ ONLY</span>
      <span>${esc(text || 'You can view, search, filter, print and export. No data on this page can be changed.')}</span>
    </div>`;
  }

  /* =========================== DASHBOARD =========================== */
  function centerHeadDashboard() {
    const students = Store.all('students');
    const faculty = Store.all('faculty');
    const staff = Store.all('accountants').length + Store.all('centerheads').length +
      Store.all('users').filter(u => u.role === 'librarian').length;
    const courses = Store.all('courses');
    const depts = departmentRows();
    const branches = branchSummaryRows();
    const sems = semesterSummaryRows();
    const fin = collectionTotals();
    const att = overallAttendance();
    const lib = libraryTotals();
    const ast = assetTotals();
    const collPct = fin.total ? Math.round((fin.collected / fin.total) * 100) : 0;
    const slots = Store.all('timetable');

    const bar = (label, value, max, extra) => `<div class="dist-row">
      <span class="dist-label">${esc(label)}</span>
      <span class="dist-bar"><i style="width:${max ? Math.round(value / max * 100) : 0}%"></i></span>
      <span class="dist-val">${esc(String(value))}${extra ? `<small>${esc(extra)}</small>` : ''}</span>
    </div>`;

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(user.name))} 👋</h2>
        <p>Center Head · College-wide monitoring · ${prettyDate()}</p>
        <div class="wb-chips">
          <span>🎓 ${students.length} students</span><span>👨‍🏫 ${faculty.length} faculty</span>
          <span>📈 ${att.pct === null ? '—' : att.pct + '%'} attendance</span>
          <span>💳 ${collPct}% fees collected</span>
        </div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    html += readOnlyBanner('This dashboard is a monitoring view of the live CMS. '
      + 'Every figure comes from the same records the admin, accounts office, faculty and library maintain.');

    // the one queue this role acts on — requests waiting for its sign-off
    const pendingReqs = Store.all('requisitions').filter(isReqPending)
      .sort((a, b) => REQ_PRIORITIES.indexOf(b.priority || 'Normal') - REQ_PRIORITIES.indexOf(a.priority || 'Normal') ||
        String(a.requestDate || '').localeCompare(String(b.requestDate || '')));
    if (pendingReqs.length) {
      html += `<div class="panel" style="border-left:4px solid var(--amber)">
        <div class="panel-head"><h3>📦 Waiting for Your Approval (${pendingReqs.length})</h3>
          <button class="btn-primary btn-sm" id="chGoReqs">Open Approvals</button></div>
        <p style="font-size:12.5px;color:var(--muted);margin:0 0 12px">
          Requests raised by faculty and the library. The accounts office cannot order any of
          these until you approve them.</p>
        <div class="tbl-wrap"><table><thead><tr>
          <th>Req ID</th><th>Item</th><th>Raised By</th><th style="text-align:right">Qty</th>
          <th style="text-align:right">Est. Cost</th><th>Priority</th><th>Needed By</th>
        </tr></thead><tbody>${pendingReqs.slice(0, 6).map(r => `<tr>
          <td class="mono">${esc(r.id)}</td><td>${esc(r.title)}</td>
          <td>${esc(r.requesterName || '—')}<br><small style="color:var(--muted)">${esc(r.department || '')}</small></td>
          <td style="text-align:right">${r.quantity ?? '—'}</td>
          <td style="text-align:right">${money(r.estimatedCost)}</td>
          <td><span class="pill ${PRIORITY_PILL[r.priority || 'Normal']}">${esc(r.priority || 'Normal')}</span></td>
          <td>${esc(r.neededBy || '—')}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }

    /* ---- OVERVIEW ---- */
    html += `<h3 class="ro-section">Overview</h3>
      <div class="stat-grid">
        ${statCard('🎓', students.length, 'Total Students')}
        ${statCard('👨‍🏫', faculty.length, 'Total Faculty', 'c2')}
        ${statCard('🧑‍💼', staff, 'Total Staff', 'c2')}
        ${statCard('📚', courses.length, 'Total Courses', 'c3')}
        ${statCard('🏛️', depts.length, 'Total Departments', 'c3')}
        ${statCard('🌿', branches.length, 'Total Branches', 'c2')}
        ${statCard('🏢', ast.units, `Total Assets (${ast.entries} entries)`, 'c2')}
      </div>`;

    /* ---- ACADEMIC ---- */
    const maxBranch = Math.max(1, ...branches.map(b => b.students));
    const maxSem = Math.max(1, ...sems.map(s => s.students));
    const topCourses = courseAttendanceRows().slice()
      .sort((a, b) => b.students - a.students).slice(0, 8);
    const maxCourse = Math.max(1, ...topCourses.map(c => c.students));

    html += `<h3 class="ro-section">Academic Overview</h3>
      <div class="stat-grid">
        ${statCard('📝', students.length, 'Enrolled This Session')}
        ${statCard('🗓️', slots.length, 'Timetable Periods', 'c2')}
        ${statCard('✅', Store.all('attendance').length, 'Sessions Recorded', 'c3')}
        ${statCard('🎯', Store.all('marks').length, 'Result Entries', 'c2')}
      </div>
      <div class="dash-2col">
        <div class="panel"><div class="panel-head"><h3>Specialisation-wise Student Count</h3></div>
          ${branches.length ? branches.map(b => bar(b.branch, b.students, maxBranch,
            b.attendance === '—' ? '' : b.attendance + '% att')).join('') : '<p class="empty">No data.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><h3>Semester-wise Student Count</h3></div>
          ${sems.length ? sems.map(s => bar(s.semester, s.students, maxSem,
            s.attendance === '—' ? '' : s.attendance + '% att')).join('') : '<p class="empty">No data.</p>'}
        </div>
      </div>
      <div class="dash-2col">
        <div class="panel"><div class="panel-head"><h3>Course-wise Student Count</h3>
          <span style="font-size:12px;color:var(--muted)">Largest ${topCourses.length} classes</span></div>
          ${topCourses.length ? topCourses.map(c => bar(`${c.code} · Sec ${c.section}`, c.students, maxCourse,
            c.attendance === '—' ? '' : c.attendance + '% att')).join('') : '<p class="empty">No courses yet.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><h3>Department Summary</h3></div>
          <div class="tbl-wrap"><table><thead><tr><th>Department</th>
            <th style="text-align:right">Faculty</th><th style="text-align:right">Courses</th>
            <th style="text-align:right">Students</th><th style="text-align:right">Att %</th>
          </tr></thead><tbody>${depts.length ? depts.map(d => `<tr>
            <td>${esc(d.department)}</td><td style="text-align:right">${d.faculty}</td>
            <td style="text-align:right">${d.courses}</td><td style="text-align:right">${d.students}</td>
            <td style="text-align:right">${d.attendance === '—' ? '—' : d.attendance + '%'}</td></tr>`).join('')
            : `<tr><td colspan="5" class="empty">No departments on record.</td></tr>`}
          </tbody></table></div>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Faculty Summary</h3>
        <span style="font-size:12px;color:var(--muted)">Teaching load from the assigned classes</span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Department</th><th>Designation</th>
          <th style="text-align:right">Classes</th><th style="text-align:right">Students</th>
          <th style="text-align:right">Sessions</th><th style="text-align:right">Avg Att %</th>
        </tr></thead><tbody>${facultyAttendanceRows().slice(0, 8).map(f => `<tr>
          <td>${esc(f.name)}</td><td>${esc(f.department)}</td><td>${esc(f.designation)}</td>
          <td style="text-align:right">${f.classes}</td><td style="text-align:right">${f.students}</td>
          <td style="text-align:right">${f.sessions}</td>
          <td style="text-align:right">${f.avgAttendance === '—' ? '—' : f.avgAttendance + '%'}</td></tr>`).join('')
          || `<tr><td colspan="7" class="empty">No faculty on record.</td></tr>`}
        </tbody></table></div></div>`;

    /* ---- ATTENDANCE ---- */
    const lowAttendance = studentAttendanceRows()
      .filter(r => r.attendance !== '—' && r.attendance < 75)
      .sort((a, b) => a.attendance - b.attendance).slice(0, 8);

    html += `<h3 class="ro-section">Attendance Overview</h3>
      <div class="dash-2col">
        <div class="panel"><div class="panel-head"><h3>Overall Attendance</h3></div>
          <div class="donut-wrap">
            ${donutSVG(att.pct === null ? 0 : att.pct, 'present')}
            <div class="donut-legend">
              <div><span class="dot green"></span> Present marks <b>${att.present}</b></div>
              <div><span class="dot line"></span> Absent marks <b>${att.marks - att.present}</b></div>
              <div style="margin-top:6px;color:var(--muted);font-size:12.5px">
                ${Store.all('attendance').length} session(s) recorded</div>
            </div>
          </div>
        </div>
        <div class="panel"><div class="panel-head"><h3>Department-wise Attendance</h3></div>
          ${depts.length ? depts.map(d => `<div class="dist-row">
            <span class="dist-label">${esc(d.department)}</span>
            <span class="dist-bar"><i style="width:${d.attendance === '—' ? 0 : d.attendance}%"></i></span>
            <span class="dist-val">${d.attendance === '—' ? '—' : d.attendance + '%'}</span></div>`).join('')
            : '<p class="empty">No attendance recorded.</p>'}
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>⚠ Students Below 75% Attendance</h3>
        <span style="font-size:12px;color:var(--muted)">${lowAttendance.length ? 'Lowest ' + lowAttendance.length : 'None'}</span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Reg No</th><th>Name</th><th>Specialisation</th><th>Sem</th>
          <th style="text-align:right">Held</th><th style="text-align:right">Present</th><th>Attendance</th>
        </tr></thead><tbody>${lowAttendance.length ? lowAttendance.map(r => `<tr>
          <td class="mono">${esc(r.roll)}</td><td>${esc(r.name)}</td><td>${esc(r.branch)}</td>
          <td>${esc(String(r.semester))}</td><td style="text-align:right">${r.held}</td>
          <td style="text-align:right">${r.present}</td><td>${attBar(r.attendance)}</td></tr>`).join('')
          : `<tr><td colspan="7" class="empty">Every student is at or above 75%. 🎉</td></tr>`}
        </tbody></table></div></div>`;

    /* ---- FINANCIAL ---- */
    const recentPayments = [...Store.all('payments')].sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) ||
      String(b.id || '').localeCompare(String(a.id || ''))).slice(0, 8);
    const maxSemFee = Math.max(1, ...sems.map(s => s.feeTotal));

    html += `<h3 class="ro-section">Financial Overview</h3>
      <div class="stat-grid">
        ${statCard('💰', money(fin.collected), 'Total Fee Collection', 'c3')}
        ${statCard('⏳', money(fin.pending), 'Total Pending Fees', fin.pending ? 'c4' : 'c3')}
        ${statCard('📋', money(fixedFeeTotal()), 'Fixed Fee Structure', 'c2')}
        ${statCard('🧾', money(collectionOn(today())), "Today's Collection", 'c3')}
      </div>
      <div class="dash-2col">
        <div class="panel"><div class="panel-head"><h3>Semester-wise Fee Collection</h3></div>
          ${sems.length ? sems.map(s => `<div class="dist-row">
            <span class="dist-label">${esc(s.semester)}</span>
            <span class="dist-bar"><i style="width:${Math.round(s.feePaid / maxSemFee * 100)}%"></i></span>
            <span class="dist-val">${money(s.feePaid)}<small>of ${money(s.feeTotal)}</small></span>
          </div>`).join('') : '<p class="empty">No fee records.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><h3>Course-wise Fee Collection</h3></div>
          <div class="tbl-wrap"><table><thead><tr><th>Course</th>
            <th style="text-align:right">Students</th><th style="text-align:right">Total</th>
            <th style="text-align:right">Collected</th><th style="text-align:right">Pending</th>
          </tr></thead><tbody>${courseFeeRows().map(r => `<tr>
            <td>${esc(r.course)}</td><td style="text-align:right">${r.students}</td>
            <td style="text-align:right">${money(r.feeTotal)}</td>
            <td style="text-align:right;color:var(--green)">${money(r.feePaid)}</td>
            <td style="text-align:right;${r.feePending ? 'color:var(--red);font-weight:600' : ''}">${money(r.feePending)}</td>
          </tr>`).join('') || `<tr><td colspan="5" class="empty">No fee records.</td></tr>`}
          </tbody></table></div>
        </div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Recent Payments</h3>
        <span style="font-size:12px;color:var(--muted)">Latest ${recentPayments.length} receipts</span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Receipt No</th><th>Student</th><th>Reg No</th>
          <th style="text-align:right">Amount</th><th>Mode</th><th>Date</th>
        </tr></thead><tbody>${recentPayments.length ? recentPayments.map(p => {
          const s = Store.find('students', p.studentId) || {};
          return `<tr><td class="mono">${esc(p.receiptNo || '—')}</td><td>${esc(s.name || '—')}</td>
            <td class="mono">${esc(s.roll || '—')}</td>
            <td style="text-align:right;font-weight:600">${money(p.amount)}</td>
            <td><span class="pill blue">${esc(p.mode || '—')}</span></td><td>${esc(p.date || '—')}</td></tr>`;
        }).join('') : `<tr><td colspan="6" class="empty">No payments recorded yet.</td></tr>`}
        </tbody></table></div></div>`;

    /* ---- ASSETS ---- */
    const byCategory = {};
    ast.assets.forEach(a => {
      const k = a.category || 'Other';
      byCategory[k] = byCategory[k] || { category: k, units: 0, value: 0 };
      byCategory[k].units += +a.quantity || 0;
      byCategory[k].value += +a.currentValue || 0;
    });
    const catRows = Object.values(byCategory).sort((a, b) => b.value - a.value);

    html += `<h3 class="ro-section">Asset Overview</h3>
      <div class="stat-grid">
        ${statCard('🏢', ast.units, 'Total Asset Units')}
        ${statCard('🗂️', ast.categories, 'Asset Categories', 'c2')}
        ${statCard('💵', money(ast.value), 'Current Asset Value', 'c3')}
        ${statCard('📦', ast.available, 'Available (In Store)', 'c2')}
        ${statCard('✅', ast.assigned, 'Assigned (In Use)', 'c3')}
        ${statCard('🛠️', ast.damaged, 'Damaged / Maintenance', ast.damaged ? 'c4' : 'c3')}
      </div>
      <div class="panel"><div class="panel-head"><h3>Assets by Category</h3></div>
        <div class="tbl-wrap"><table><thead><tr><th>Category</th>
          <th style="text-align:right">Units</th><th style="text-align:right">Current Value</th>
        </tr></thead><tbody>${catRows.length ? catRows.map(c => `<tr><td>${esc(c.category)}</td>
          <td style="text-align:right">${c.units}</td>
          <td style="text-align:right">${money(c.value)}</td></tr>`).join('')
          : `<tr><td colspan="3" class="empty">No assets on record.</td></tr>`}
        </tbody></table></div></div>`;

    /* ---- LIBRARY ---- */
    const recentLib = lib.txns.slice(0, 8);
    html += `<h3 class="ro-section">Library Overview</h3>
      <div class="stat-grid">
        ${statCard('📚', lib.copies, `Total Books (${lib.titles} titles)`)}
        ${statCard('🔖', lib.issued, 'Currently Issued', 'c2')}
        ${statCard('🔁', lib.returned, 'Returned (all time)', 'c3')}
        ${statCard('⚠️', lib.overdue, 'Overdue', lib.overdue ? 'c4' : 'c3')}
        ${statCard('📗', lib.available, 'Available Now', 'c3')}
        ${statCard('🧾', lib.transactions, 'Total Transactions', 'c2')}
      </div>
      <div class="panel"><div class="panel-head"><h3>Library Activity Summary</h3>
        <span style="font-size:12px;color:var(--muted)">Latest ${recentLib.length} transactions</span></div>
        <div class="tbl-wrap"><table><thead><tr><th>Book</th><th>Student</th><th>Issued</th>
          <th>Due</th><th>Returned</th><th>Status</th>
        </tr></thead><tbody>${recentLib.length ? recentLib.map(t => `<tr>
          <td>${esc(t.title)}</td><td>${esc(t.student)} <small style="color:var(--muted)">${esc(t.roll)}</small></td>
          <td>${esc(t.issueDate || '—')}</td><td>${esc(t.dueDate || '—')}</td>
          <td>${esc(t.returnDate || '—')}</td>
          <td><span class="pill ${STATUS_TONE[t.status] || 'blue'}">${esc(t.status)}</span></td></tr>`).join('')
          : `<tr><td colspan="6" class="empty">No library transactions yet.</td></tr>`}
        </tbody></table></div></div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Reports</h3>
      <button class="btn-primary btn-sm" id="chGoReports">📈 Open Reports</button></div>
      <p style="font-size:13px;color:var(--muted);line-height:1.7;margin:0">
        Student, faculty, attendance, fee collection, pending fee, semester-wise fee, asset,
        library, department, course and overall college reports — each with search, filters,
        a date range, print, PDF, CSV and Excel export.</p></div>`;

    viewDashboard.after = () => {
      $('#chGoReports').onclick = () => navigate('chreports');
      const reqBtn = $('#chGoReqs');
      if (reqBtn) reqBtn.onclick = () => navigate('requisitions');
    };
    return html;
  }

  /** fee roll-up per academic programme */
  function courseFeeRows() {
    const groups = {};
    financeRows().forEach(r => {
      const k = r.course || '—';
      groups[k] = groups[k] || { course: k, students: 0, feeTotal: 0, feePaid: 0, feePending: 0 };
      groups[k].students++;
      groups[k].feeTotal += r.total;
      groups[k].feePaid += r.paid;
      groups[k].feePending += r.pending;
    });
    return Object.values(groups).sort((a, b) => b.feeTotal - a.feeTotal);
  }

  /* =========================== ATTENDANCE OVERVIEW =========================== */
  const CH_ATT_TABS = [
    ['sessions', '🗓 Attendance History'],
    ['students', '🎓 Student Attendance'],
    ['faculty', '👨‍🏫 Faculty Attendance'],
    ['courses', '📚 Course-wise'],
    ['departments', '🏛 Department-wise'],
    ['semesters', '📆 Semester-wise'],
  ];
  let chAttTab = 'sessions';

  function viewAttendanceOverview() {
    const att = overallAttendance();
    const sessions = Store.all('attendance');
    const low = studentAttendanceRows().filter(r => r.attendance !== '—' && r.attendance < 75).length;

    const html = readOnlyBanner('Attendance is recorded by the faculty. This page reports it — '
      + 'there is no editing option here.') +
      `<div class="stat-grid">
        ${statCard('📈', att.pct === null ? '—' : att.pct + '%', 'Overall Attendance', att.pct !== null && att.pct < 75 ? 'c4' : 'c3')}
        ${statCard('✅', sessions.length, 'Sessions Recorded', 'c2')}
        ${statCard('👥', att.present, 'Present Marks', 'c3')}
        ${statCard('🚫', att.marks - att.present, 'Absent Marks', 'c4')}
        ${statCard('⚠️', low, 'Students Below 75%', low ? 'c4' : 'c3')}
      </div>
      <div class="panel"><div class="panel-head"><h3>Attendance Reports</h3>
        <div class="panel-tools">${exportButtons('ca')}</div></div>
        <div class="fin-tabs" id="caTabs">${CH_ATT_TABS.map(([key, label]) =>
          `<button class="fin-tab ${key === chAttTab ? 'active' : ''}" data-att="${key}">${label}</button>`).join('')}</div>
        <div class="panel-tools fin-filters">
          <input class="search-box" id="caQ" placeholder="Search student / subject / faculty...">
          <select class="filter-sel" id="caBranch"><option value="">All Specialisations</option>${specialisationOptions()}</select>
          <select class="filter-sel" id="caSem"><option value="">All Semesters</option>${semesterOptions()}</select>
          <label class="days-field">From <input class="filter-sel" id="caFrom" type="date"></label>
          <label class="days-field">To <input class="filter-sel" id="caTo" type="date"></label>
          <button class="btn-outline btn-sm" id="caClear">Clear</button>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px" id="caNote"></p>
        <div id="caTable"></div><div id="caPager"></div></div>`;

    viewAttendance.after = () => {
      let page = 1;
      const values = () => ({
        q: ($('#caQ').value || '').trim().toLowerCase(),
        branch: $('#caBranch').value, semester: $('#caSem').value,
        from: $('#caFrom').value, to: $('#caTo').value,
      });
      const build = () => buildAttendanceReport(chAttTab, values());
      const draw = () => {
        const r = build();
        page = Math.min(page, pageCount(r.rows.length));
        $('#caNote').textContent = r.note || '';
        $('#caTable').innerHTML = reportTableHtml(r.columns, pageSlice(r.rows, page), 'No attendance data for these filters.');
        $('#caPager').innerHTML = pagerHtml(r.rows.length, page);
        bindPager($('#caPager'), r.rows.length, page, (p) => page = p, draw);
      };
      $('#caTabs').querySelectorAll('[data-att]').forEach(b => b.onclick = () => {
        chAttTab = b.dataset.att;
        $('#caTabs').querySelectorAll('.fin-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.att === chAttTab));
        page = 1; draw();
      });
      ['caQ', 'caBranch', 'caSem', 'caFrom', 'caTo'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#caClear').onclick = () => {
        ['caQ', 'caBranch', 'caSem', 'caFrom', 'caTo'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      bindExports('ca', build);
      draw();
    };
    return html;
  }

  /* every attendance report shares the { title, columns, rows, totals } shape */
  function buildAttendanceReport(kind, f) {
    const hit = (row, keys) => !f.q || keys.some(k => String(row[k] ?? '').toLowerCase().includes(f.q));
    const stamp = reportStamp();

    if (kind === 'sessions') {
      const rows = attendanceSessionRows().filter(r =>
        hit(r, ['code', 'name', 'faculty', 'branch', 'section']) &&
        (!f.branch || r.branch === f.branch) &&
        (!f.semester || String(r.semester) === String(f.semester)) &&
        (!f.from || (r.date && r.date >= f.from)) &&
        (!f.to || (r.date && r.date <= f.to)));
      return {
        title: 'Attendance History', sheetName: 'Sessions', subtitle: stamp,
        note: 'Every class session on record, newest first.',
        columns: [
          { header: 'Date', key: 'date', width: 13 }, { header: 'Code', key: 'code', width: 12 },
          { header: 'Subject', key: 'name', width: 30 }, { header: 'Specialisation', key: 'branch', width: 10 },
          { header: 'Semester', key: 'semester', width: 10, type: 'number' },
          { header: 'Section', key: 'section', width: 9 }, { header: 'Faculty', key: 'faculty', width: 24 },
          { header: 'Present', key: 'present', width: 10, type: 'number' },
          { header: 'Absent', key: 'absent', width: 10, type: 'number' },
          { header: 'Total', key: 'total', width: 10, type: 'number' },
          { header: 'Attendance %', key: 'attendance', width: 14, type: 'number' },
        ],
        rows,
        totals: { date: 'TOTAL', code: rows.length + ' sessions',
                  present: rows.reduce((a, r) => a + r.present, 0),
                  absent: rows.reduce((a, r) => a + r.absent, 0),
                  total: rows.reduce((a, r) => a + r.total, 0) },
      };
    }

    if (kind === 'students') {
      const rows = studentAttendanceRows().filter(r =>
        hit(r, ['roll', 'name', 'branch', 'course']) &&
        (!f.branch || r.branch === f.branch) &&
        (!f.semester || String(r.semester) === String(f.semester)));
      return {
        title: 'Student Attendance Report', sheetName: 'Student Attendance', subtitle: stamp,
        note: 'Attendance of every student across all the sessions they appear in.',
        columns: [
          { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student Name', key: 'name', width: 26 },
          { header: 'Course', key: 'course', width: 12 }, { header: 'Specialisation', key: 'branch', width: 10 },
          { header: 'Semester', key: 'semester', width: 10, type: 'number' },
          { header: 'Section', key: 'section', width: 9 },
          { header: 'Sessions Held', key: 'held', width: 14, type: 'number' },
          { header: 'Present', key: 'present', width: 10, type: 'number' },
          { header: 'Absent', key: 'absent', width: 10, type: 'number' },
          { header: 'Attendance %', key: 'attendance', width: 14 },
          { header: 'GPA', key: 'gpa', width: 9 },
        ],
        rows,
        totals: { roll: 'TOTAL', name: rows.length + ' students',
                  present: rows.reduce((a, r) => a + r.present, 0),
                  absent: rows.reduce((a, r) => a + r.absent, 0) },
      };
    }

    if (kind === 'faculty') {
      const rows = facultyAttendanceRows().filter(r => hit(r, ['empId', 'name', 'department', 'designation']));
      return {
        title: 'Faculty Attendance Report', sheetName: 'Faculty Attendance', subtitle: stamp,
        note: 'Class sessions each faculty member has recorded, with the average student '
          + 'attendance in those sessions. Derived from the attendance register — the CMS '
          + 'does not hold a separate staff biometric record.',
        columns: [
          { header: 'Emp ID', key: 'empId', width: 14 }, { header: 'Name', key: 'name', width: 26 },
          { header: 'Department', key: 'department', width: 20 },
          { header: 'Designation', key: 'designation', width: 20 },
          { header: 'Classes', key: 'classes', width: 10, type: 'number' },
          { header: 'Students', key: 'students', width: 10, type: 'number' },
          { header: 'Sessions Held', key: 'sessions', width: 14, type: 'number' },
          { header: 'Avg Attendance %', key: 'avgAttendance', width: 17 },
          { header: 'Last Session', key: 'lastSession', width: 14 },
        ],
        rows,
        totals: { empId: 'TOTAL', name: rows.length + ' faculty',
                  sessions: rows.reduce((a, r) => a + r.sessions, 0) },
      };
    }

    if (kind === 'courses') {
      const rows = courseAttendanceRows().filter(r =>
        hit(r, ['code', 'name', 'faculty', 'branch']) &&
        (!f.semester || String(r.semester) === String(f.semester)));
      return {
        title: 'Course-wise Attendance Report', sheetName: 'Course Attendance', subtitle: stamp,
        note: 'Attendance for every course, from the sessions recorded against it. '
          + 'Courses belong to the programme, so the specialisation filter does not apply here.',
        columns: [
          { header: 'Code', key: 'code', width: 12 }, { header: 'Course', key: 'name', width: 30 },
          { header: 'Programme', key: 'branch', width: 10 },
          { header: 'Semester', key: 'semester', width: 10, type: 'number' },
          { header: 'Section', key: 'section', width: 9 }, { header: 'Faculty', key: 'faculty', width: 24 },
          { header: 'Students', key: 'students', width: 10, type: 'number' },
          { header: 'Sessions', key: 'sessions', width: 10, type: 'number' },
          { header: 'Attendance %', key: 'attendance', width: 14 },
        ],
        rows,
        totals: { code: 'TOTAL', name: rows.length + ' courses',
                  sessions: rows.reduce((a, r) => a + r.sessions, 0) },
      };
    }

    if (kind === 'departments') {
      const rows = departmentRows().filter(r => hit(r, ['department', 'branch']));
      return {
        title: 'Department-wise Attendance Report', sheetName: 'Dept Attendance', subtitle: stamp,
        note: 'Attendance rolled up per department, through the programme each department teaches.',
        columns: [
          { header: 'Department', key: 'department', width: 24 },
          { header: 'Programme', key: 'branch', width: 10 },
          { header: 'Faculty', key: 'faculty', width: 10, type: 'number' },
          { header: 'Courses', key: 'courses', width: 10, type: 'number' },
          { header: 'Students', key: 'students', width: 10, type: 'number' },
          { header: 'Attendance %', key: 'attendance', width: 14 },
        ],
        rows,
        totals: { department: 'TOTAL', branch: rows.length + ' depts',
                  students: rows.reduce((a, r) => a + r.students, 0) },
      };
    }

    const rows = semesterSummaryRows().filter(r => hit(r, ['semester', 'branches']) &&
      (!f.semester || r.semester === 'Semester ' + f.semester));
    return {
      title: 'Semester-wise Attendance Report', sheetName: 'Sem Attendance', subtitle: stamp,
      note: 'Attendance and headcount per semester.',
      columns: [
        { header: 'Semester', key: 'semester', width: 14 },
        { header: 'Specialisations', key: 'branches', width: 24 },
        { header: 'Students', key: 'students', width: 10, type: 'number' },
        { header: 'Attendance %', key: 'attendance', width: 14 },
      ],
      rows,
      totals: { semester: 'TOTAL', branches: rows.length + ' semesters',
                students: rows.reduce((a, r) => a + r.students, 0) },
    };
  }

  /* =========================== DEPARTMENTS =========================== */
  function viewDepartments() {
    const html = readOnlyBanner('Departments are derived from the faculty records maintained by the admin.') +
      `<div class="panel"><div class="panel-head"><h3>Departments</h3>
        <div class="panel-tools">
          <input class="search-box" id="dpQ" placeholder="Search department...">
          ${exportButtons('dp')}
        </div></div>
        <div id="dpStats" class="stat-grid" style="margin:6px 0 18px"></div>
        <div id="dpTable"></div><div id="dpPager"></div></div>
      <div class="panel"><div class="panel-head"><h3>Faculty by Department</h3></div>
        <div id="dpFaculty"></div></div>`;

    viewDepartments.after = () => {
      let page = 1;
      const filtered = () => {
        const q = ($('#dpQ').value || '').trim().toLowerCase();
        return departmentRows().filter(r => !q || r.department.toLowerCase().includes(q));
      };
      const report = () => ({
        title: 'Department Report', sheetName: 'Departments', subtitle: reportStamp(),
        columns: [
          { header: 'Department', key: 'department', width: 26 },
          { header: 'Specialisation', key: 'branch', width: 10 },
          { header: 'Faculty', key: 'faculty', width: 10, type: 'number' },
          { header: 'Professors', key: 'professors', width: 12, type: 'number' },
          { header: 'Courses', key: 'courses', width: 10, type: 'number' },
          { header: 'Students', key: 'students', width: 10, type: 'number' },
          { header: 'Attendance %', key: 'attendance', width: 14 },
          { header: 'Total Fee', key: 'feeTotal', width: 15, money: true },
          { header: 'Collected', key: 'feePaid', width: 15, money: true },
          { header: 'Pending', key: 'feePending', width: 15, money: true },
        ],
        rows: filtered(),
        totals: {
          department: 'TOTAL', branch: filtered().length + ' depts',
          faculty: filtered().reduce((a, r) => a + r.faculty, 0),
          courses: filtered().reduce((a, r) => a + r.courses, 0),
          students: filtered().reduce((a, r) => a + r.students, 0),
          feeTotal: filtered().reduce((a, r) => a + r.feeTotal, 0),
          feePaid: filtered().reduce((a, r) => a + r.feePaid, 0),
          feePending: filtered().reduce((a, r) => a + r.feePending, 0),
        },
      });
      const draw = () => {
        const r = report();
        const rows = r.rows;
        page = Math.min(page, pageCount(rows.length));
        $('#dpStats').innerHTML = `${statCard('🏛️', rows.length, 'Departments')}
          ${statCard('👨‍🏫', rows.reduce((a, x) => a + x.faculty, 0), 'Faculty', 'c2')}
          ${statCard('📚', rows.reduce((a, x) => a + x.courses, 0), 'Courses', 'c3')}
          ${statCard('🎓', rows.reduce((a, x) => a + x.students, 0), 'Students', 'c2')}`;
        $('#dpTable').innerHTML = reportTableHtml(r.columns, pageSlice(rows, page), 'No departments found.');
        $('#dpPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#dpPager'), rows.length, page, (p) => page = p, draw);

        $('#dpFaculty').innerHTML = rows.length ? rows.map(d => {
          const staff = Store.all('faculty').filter(f => (f.department || '').trim() === d.department);
          return `<div style="margin-bottom:16px">
            <div style="font-weight:600;color:var(--primary-dark);margin-bottom:6px">
              ${esc(d.department)} <small style="color:var(--muted);font-weight:400">· ${staff.length} member(s)</small></div>
            <div class="tbl-wrap"><table><thead><tr><th>Emp ID</th><th>Name</th><th>Designation</th>
              <th>Qualification</th><th>Expertise</th></tr></thead>
              <tbody>${staff.map(f => `<tr><td class="mono">${esc(f.empId || '—')}</td><td>${esc(f.name)}</td>
                <td>${esc(f.designation || '—')}</td><td>${esc(f.qualification || '—')}</td>
                <td>${esc(f.expertise || '—')}</td></tr>`).join('')}
              </tbody></table></div></div>`;
        }).join('') : '<p class="empty">No departments on record.</p>';
      };
      $('#dpQ').oninput = () => { page = 1; draw(); };
      bindExports('dp', report);
      draw();
    };
    return html;
  }

  /* =========================== BRANCHES =========================== */
  function viewBranches() {
    const html = readOnlyBanner('Specialisations come from the master list the admin maintains, plus every one in use.') +
      `<div class="panel"><div class="panel-head"><h3>Specialisations</h3>
        <div class="panel-tools">
          <input class="search-box" id="brQ" placeholder="Search specialisation...">
          ${exportButtons('br')}
        </div></div>
        <div id="brStats" class="stat-grid" style="margin:6px 0 18px"></div>
        <div id="brTable"></div></div>
      <div class="panel"><div class="panel-head"><h3>Specialisation × Semester Distribution</h3></div>
        <div id="brMatrix"></div></div>`;

    viewBranches.after = () => {
      const filtered = () => {
        const q = ($('#brQ').value || '').trim().toLowerCase();
        return branchSummaryRows().filter(r => !q || r.branch.toLowerCase().includes(q));
      };
      const report = () => {
        const rows = filtered();
        return {
          title: 'Branch Report', sheetName: 'Specialisations', subtitle: reportStamp(),
          columns: [
            { header: 'Specialisation', key: 'branch', width: 12 },
            { header: 'Students', key: 'students', width: 10, type: 'number' },
            { header: 'Semesters Running', key: 'semesters', width: 20 },
            { header: 'Attendance %', key: 'attendance', width: 14 },
            { header: 'Total Fee', key: 'feeTotal', width: 15, money: true },
            { header: 'Collected', key: 'feePaid', width: 15, money: true },
            { header: 'Pending', key: 'feePending', width: 15, money: true },
          ],
          rows,
          totals: {
            branch: 'TOTAL', students: rows.reduce((a, r) => a + r.students, 0),
            feeTotal: rows.reduce((a, r) => a + r.feeTotal, 0),
            feePaid: rows.reduce((a, r) => a + r.feePaid, 0),
            feePending: rows.reduce((a, r) => a + r.feePending, 0),
          },
        };
      };
      const draw = () => {
        const r = report();
        $('#brStats').innerHTML = `${statCard('🌿', r.rows.length, 'Specialisations')}
          ${statCard('🎓', r.totals.students, 'Students', 'c2')}
          ${statCard('💰', money(r.totals.feePaid), 'Fees Collected', 'c3')}`;
        $('#brTable').innerHTML = reportTableHtml(r.columns, r.rows, 'No specialisations in use yet.');

        // branch × semester headcount grid
        const students = Store.all('students');
        const sems = [...new Set(students.map(s => +s.semester || 0))].filter(Boolean).sort((a, b) => a - b);
        $('#brMatrix').innerHTML = r.rows.length && sems.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>Specialisation</th>${sems.map(s => `<th style="text-align:right">Sem ${s}</th>`).join('')}
            <th style="text-align:right">Total</th></tr></thead>
          <tbody>${r.rows.map(b => {
            const cells = sems.map(s => students.filter(x => specOf(x) === b.branch && +x.semester === s).length);
            return `<tr><td>${esc(b.branch)}</td>${cells.map(n =>
              `<td style="text-align:right">${n || '—'}</td>`).join('')}
              <td style="text-align:right;font-weight:600">${b.students}</td></tr>`;
          }).join('')}</tbody></table></div>` : '<p class="empty">No students on record.</p>';
      };
      $('#brQ').oninput = draw;
      bindExports('br', report);
      draw();
    };
    return html;
  }

  /* =========================== REPORTS HUB =========================== */
  const CH_REPORTS = [
    ['student', '🎓 Student Report'],
    ['faculty', '👨‍🏫 Faculty Report'],
    ['attendance', '✅ Attendance Report'],
    ['collection', '💰 Fee Collection Report'],
    ['pending', '⏳ Pending Fee Report'],
    ['semester', '📆 Semester-wise Fee Report'],
    ['asset', '🏢 Asset Report'],
    ['library', '📖 Library Report'],
    ['department', '🏛 Department Report'],
    ['course', '📚 Course Report'],
    ['overall', '🏫 Overall College Report'],
  ];
  let chReport = 'student';

  function viewCenterReports() {
    const html = readOnlyBanner('View, print and export any report. Reports read the live records — '
      + 'nothing here writes back to the database.') +
      `<div class="panel"><div class="panel-head"><h3>Reports</h3>
        <div class="panel-tools">${exportButtons('cr')}</div></div>
        <div class="fin-tabs" id="crTabs">${CH_REPORTS.map(([key, label]) =>
          `<button class="fin-tab ${key === chReport ? 'active' : ''}" data-rep="${key}">${label}</button>`).join('')}</div>
        ${finFilterBar('cr', { placeholder: 'Search...', dates: true })}
        <p style="font-size:12px;color:var(--muted);margin:0 0 14px" id="crNote"></p>
        <div id="crStats" class="stat-grid" style="margin-bottom:18px"></div>
        <div id="crTable"></div><div id="crPager"></div></div>`;

    viewCenterReports.after = () => {
      let page = 1;
      const build = () => buildCenterReport(chReport, finFilterValues('cr'));
      const draw = () => {
        const r = build();
        page = Math.min(page, pageCount(r.rows.length));
        $('#crNote').textContent = r.note || '';
        $('#crStats').innerHTML = (r.stats || []).join('');
        $('#crTable').innerHTML = reportTableHtml(r.columns, pageSlice(r.rows, page), 'No data for these filters.');
        $('#crPager').innerHTML = pagerHtml(r.rows.length, page);
        bindPager($('#crPager'), r.rows.length, page, (p) => page = p, draw);
      };
      $('#crTabs').querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
        chReport = b.dataset.rep;
        $('#crTabs').querySelectorAll('.fin-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.rep === chReport));
        page = 1; draw();
      });
      bindFinFilters('cr', [], () => { page = 1; draw(); });
      bindExports('cr', build);
      draw();
    };
    return html;
  }

  /* Each report reuses an existing builder wherever one already exists, so the
     center head's numbers are the accounts office's numbers, by construction. */
  function buildCenterReport(kind, f) {
    const stamp = reportStamp();

    if (kind === 'student') {
      const rows = Store.all('students').filter(s =>
        (!f.q || [s.roll, s.name, s.email, s.branch, s.course].some(v =>
          String(v || '').toLowerCase().includes(f.q))) &&
        (!f.course || s.course === f.course) &&
        (!f.branch || s.branch === f.branch) &&
        (!f.semester || String(s.semester) === String(f.semester)) &&
        (!f.year || s.academicYear === f.year));
      const r = studentReport(rows);
      r.note = 'Every student on record with their attendance and result standing.';
      r.stats = [
        statCard('🎓', rows.length, 'Students Listed'),
        statCard('🌿', new Set(rows.map(s => s.branch)).size, 'Specialisations', 'c2'),
        statCard('📆', new Set(rows.map(s => s.semester)).size, 'Semesters', 'c3'),
      ];
      return r;
    }

    if (kind === 'faculty') {
      const rows = Store.all('faculty')
        .map(x => Object.assign({}, x, { roleName: roleLabel(employeeRole(x)) }))
        .filter(x => !f.q || [x.empId, x.name, x.department, x.designation, x.expertise, x.roleName]
          .some(v => String(v || '').toLowerCase().includes(f.q)));
      const r = facultyReport(rows);
      r.note = 'Faculty roster with department, qualification and teaching load.';
      r.stats = [
        statCard('👨‍🏫', rows.length, 'Faculty Listed'),
        statCard('🏛️', new Set(rows.map(x => x.department)).size, 'Departments', 'c2'),
        statCard('📚', rows.reduce((a, x) => a + facultyTeachingLoad(x.id).classes, 0), 'Classes Assigned', 'c3'),
      ];
      return r;
    }

    if (kind === 'attendance') {
      const r = buildAttendanceReport('students', {
        q: f.q, branch: f.branch, semester: f.semester, from: f.from, to: f.to,
      });
      const withPct = r.rows.filter(x => x.attendance !== '—');
      const avg = withPct.length
        ? Math.round(withPct.reduce((a, x) => a + x.attendance, 0) / withPct.length) : null;
      r.stats = [
        statCard('🎓', r.rows.length, 'Students Listed'),
        statCard('📈', avg === null ? '—' : avg + '%', 'Average Attendance', avg !== null && avg < 75 ? 'c4' : 'c3'),
        statCard('⚠️', withPct.filter(x => x.attendance < 75).length, 'Below 75%', 'c4'),
      ];
      return r;
    }

    if (kind === 'library') {
      const lib = libraryTotals();
      const rows = lib.txns.filter(t =>
        (!f.q || [t.roll, t.student, t.title, t.author, t.isbn, t.category].some(v =>
          String(v || '').toLowerCase().includes(f.q))) &&
        (!f.branch || t.branch === f.branch) &&
        (!f.semester || String(t.semester) === String(f.semester)) &&
        (!f.from || (t.issueDate && t.issueDate >= f.from)) &&
        (!f.to || (t.issueDate && t.issueDate <= f.to)));
      return {
        title: 'Library Report', sheetName: 'Library', subtitle: stamp,
        note: 'Every issue and return on record, with the derived loan status.',
        stats: [
          statCard('📚', lib.copies, 'Total Copies'),
          statCard('🔖', lib.issued, 'Currently Issued', 'c2'),
          statCard('⚠️', lib.overdue, 'Overdue', lib.overdue ? 'c4' : 'c3'),
          statCard('🧾', rows.length, 'Transactions Listed', 'c2'),
        ],
        columns: [
          { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'student', width: 24 },
          { header: 'Specialisation', key: 'branch', width: 10 },
          { header: 'Semester', key: 'semester', width: 10, type: 'number' },
          { header: 'Book Title', key: 'title', width: 32 }, { header: 'Author', key: 'author', width: 24 },
          { header: 'ISBN', key: 'isbn', width: 16 }, { header: 'Category', key: 'category', width: 18 },
          { header: 'Issued On', key: 'issueDate', width: 13 },
          { header: 'Due Date', key: 'dueDate', width: 13 },
          { header: 'Returned On', key: 'returnDate', width: 13 },
          { header: 'Days Kept', key: 'daysKept', width: 11, type: 'number' },
          { header: 'Late Days', key: 'lateDays', width: 11, type: 'number' },
          { header: 'Status', key: 'status', width: 15 },
        ],
        rows,
        totals: { roll: 'TOTAL', student: rows.length + ' transactions' },
      };
    }

    if (kind === 'department') {
      const rows = departmentRows().filter(r =>
        (!f.q || [r.department, r.branch].some(v => String(v || '').toLowerCase().includes(f.q))) &&
        (!f.branch || r.branch === f.branch));
      return {
        title: 'Department Report', sheetName: 'Departments', subtitle: stamp,
        note: 'Staff, subjects, students, attendance and fees per department.',
        stats: [
          statCard('🏛️', rows.length, 'Departments'),
          statCard('👨‍🏫', rows.reduce((a, r) => a + r.faculty, 0), 'Faculty', 'c2'),
          statCard('🎓', rows.reduce((a, r) => a + r.students, 0), 'Students', 'c3'),
        ],
        columns: [
          { header: 'Department', key: 'department', width: 26 },
          { header: 'Specialisation', key: 'branch', width: 10 },
          { header: 'Faculty', key: 'faculty', width: 10, type: 'number' },
          { header: 'Professors', key: 'professors', width: 12, type: 'number' },
          { header: 'Courses', key: 'courses', width: 10, type: 'number' },
          { header: 'Students', key: 'students', width: 10, type: 'number' },
          { header: 'Attendance %', key: 'attendance', width: 14 },
          { header: 'Total Fee', key: 'feeTotal', width: 15, money: true },
          { header: 'Collected', key: 'feePaid', width: 15, money: true },
          { header: 'Pending', key: 'feePending', width: 15, money: true },
        ],
        rows,
        totals: {
          department: 'TOTAL', branch: rows.length + ' depts',
          faculty: rows.reduce((a, r) => a + r.faculty, 0),
          courses: rows.reduce((a, r) => a + r.courses, 0),
          students: rows.reduce((a, r) => a + r.students, 0),
          feeTotal: rows.reduce((a, r) => a + r.feeTotal, 0),
          feePaid: rows.reduce((a, r) => a + r.feePaid, 0),
          feePending: rows.reduce((a, r) => a + r.feePending, 0),
        },
      };
    }

    if (kind === 'course') {
      const rows = Store.all('courses').filter(c =>
        (!f.q || [c.code, c.name, c.branch, facultyName(c.facultyId)].some(v =>
          String(v || '').toLowerCase().includes(f.q))) &&
        (!f.branch || c.branch === f.branch) &&
        (!f.semester || String(c.semester) === String(f.semester)));
      const r = courseReport(rows);
      r.note = 'Every course with its class, faculty, headcount and attendance.';
      r.stats = [
        statCard('📚', rows.length, 'Courses Listed'),
        statCard('🎓', rows.reduce((a, c) => a + studentsOfCourse(c).length, 0), 'Seats Filled', 'c2'),
        statCard('✅', rows.reduce((a, c) => a + courseAttendance(c.id).sessions, 0), 'Sessions Held', 'c3'),
      ];
      return r;
    }

    if (kind === 'overall') {
      const students = Store.all('students');
      const fin = collectionTotals();
      const att = overallAttendance();
      const lib = libraryTotals();
      const ast = assetTotals();
      const rows = [
        { metric: 'Total Students', value: students.length, detail: `${new Set(students.map(s => s.branch)).size} branches` },
        { metric: 'Total Faculty', value: Store.all('faculty').length, detail: `${departmentList().length} departments` },
        { metric: 'Total Courses', value: Store.all('courses').length, detail: `${Store.all('timetable').length} timetable periods` },
        { metric: 'Total Departments', value: departmentList().length, detail: '—' },
        { metric: 'Total Branches', value: branchSummaryRows().length, detail: '—' },
        { metric: 'Overall Attendance', value: att.pct === null ? '—' : att.pct + '%', detail: `${Store.all('attendance').length} sessions recorded` },
        { metric: 'Total Fee Charged', value: money(fin.total), detail: `${fin.rows.length} student ledgers` },
        { metric: 'Total Fee Collected', value: money(fin.collected), detail: `${Store.all('payments').length} receipts` },
        { metric: 'Total Fee Pending', value: money(fin.pending), detail: `${fin.rows.filter(r => r.pending > 0).length} students with dues` },
        { metric: 'Fixed Fee Structure', value: money(fixedFeeTotal()), detail: `${Store.all('fixedfees').length} fee heads` },
        { metric: 'Total Assets', value: ast.units + ' units', detail: `${ast.entries} entries · ${ast.categories} categories` },
        { metric: 'Current Asset Value', value: money(ast.value), detail: `purchased for ${money(ast.cost)}` },
        { metric: 'Library Books', value: lib.copies + ' copies', detail: `${lib.titles} titles` },
        { metric: 'Books Issued', value: lib.issued, detail: `${lib.overdue} overdue` },
        { metric: 'Books Returned', value: lib.returned, detail: `${lib.transactions} transactions all time` },
      ].filter(r => !f.q || [r.metric, String(r.value), r.detail].some(v =>
        String(v).toLowerCase().includes(f.q)));
      return {
        title: 'Overall College Report', sheetName: 'Overall', subtitle: stamp,
        note: 'One-page snapshot of the whole institution, as of this moment.',
        stats: [
          statCard('🎓', students.length, 'Students'),
          statCard('👨‍🏫', Store.all('faculty').length, 'Faculty', 'c2'),
          statCard('📈', att.pct === null ? '—' : att.pct + '%', 'Attendance', 'c3'),
          statCard('💰', money(fin.collected), 'Fees Collected', 'c3'),
        ],
        columns: [
          { header: 'Metric', key: 'metric', width: 30 },
          { header: 'Value', key: 'value', width: 22, align: 'right' },
          { header: 'Detail', key: 'detail', width: 34 },
        ],
        rows,
      };
    }

    // collection / pending / semester reuse the accounts-office builders verbatim
    const map = { collection: 'collection', pending: 'pending', semester: 'semester', asset: 'asset' };
    return buildFinReport(map[kind] || 'collection', f);
  }

  /* =========================================================
     PLACEMENT CELL — companies, drives, applications, interviews,
     selections, offers, calendar and reports.

     Shared verbatim by the admin (full access to everything) and the
     placement officer (full access here, read-only on the student records it
     recruits from). There is one copy of every fact: a drive points at a
     company by id, an application at a drive and a student, an offer at the
     application's drive. No student detail is ever duplicated into this
     section — it is always read back out of `students`.
     ========================================================= */

  const DRIVE_STATUS     = ['Draft', 'Published', 'Ongoing', 'Completed', 'Cancelled'];
  const APP_STATUS       = ['Applied', 'Shortlisted', 'Rejected', 'Selected', 'Withdrawn'];
  const INTERVIEW_STATUS = ['Scheduled', 'Completed', 'Cancelled', 'No Show'];
  /* An offer does not end at "Joined". A student can accept and never turn up,
     or join and leave within weeks — and the cell is asked for both numbers.
     Neither counts as placed. */
  const OFFER_STATUS     = ['Offered', 'Accepted', 'Declined', 'Joined', 'Not Joined', 'Left', 'Revoked'];
  const OFFER_ENDED_STATUS = ['Not Joined', 'Left'];
  const INTERVIEW_MODES  = ['Offline', 'Online', 'Telephonic'];
  const INTERVIEW_TYPES  = ['Final', 'Mock'];
  const ENGAGEMENT_TYPES = ['Final Placement', 'Summer Internship'];
  const PL_EVENT_TYPES   = ['Drive', 'Interview', 'Pre-Placement Talk', 'Test', 'Other'];
  const JOB_LOCATIONS    = ['Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Mumbai', 'Delhi NCR',
                            'Kolkata', 'Bhubaneswar', 'Remote'];
  /** a drive students can still be processed against */
  const OPEN_DRIVE_STATUS = ['Published', 'Ongoing'];
  /** an offer in one of these states means the student counts as placed */
  const PLACED_OFFER_STATUS = ['Accepted', 'Joined'];

  const DRIVE_PILL = { Draft:'blue', Published:'green', Ongoing:'amber', Completed:'blue', Cancelled:'red' };
  const APP_PILL   = { Applied:'blue', Shortlisted:'amber', Rejected:'red', Selected:'green', Withdrawn:'red' };
  const IV_PILL    = { Scheduled:'amber', Completed:'green', Cancelled:'red', 'No Show':'red' };
  const OFFER_PILL = { Offered:'amber', Accepted:'green', Declined:'red', Joined:'green',
                       'Not Joined':'red', Left:'red', Revoked:'red' };
  const PLEV_PILL  = { Drive:'green', Interview:'amber', 'Pre-Placement Talk':'blue', Test:'blue', Other:'blue' };

  /* ---------- lookups ---------- */
  const companyName = (id) => { const c = Store.find('companies', id); return c ? c.name : '—'; };
  const driveRole = (id) => { const d = Store.find('drives', id); return d ? d.jobRole : '—'; };
  function driveLabel(id) {
    const d = Store.find('drives', id);
    return d ? `${d.jobRole} — ${companyName(d.companyId)}` : '—';
  }
  function csvList(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }
  function companyOptions(sel) {
    return Store.all('companies').slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  function driveOptions(sel, onlyOpen) {
    const list = onlyOpen ? Store.all('drives').filter(d => OPEN_DRIVE_STATUS.includes(d.status || 'Draft'))
                          : Store.all('drives');
    return list.map(d => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>
      ${esc(d.jobRole || d.id)} — ${esc(companyName(d.companyId))}</option>`).join('');
  }

  /* ---------- eligibility ----------
     The drive carries the rule (minCgpa / maxBacklogs / branches / courses) and
     the student carries the facts. A student with no cgpa on record falls back
     to the GPA derived from their internal marks, so eligibility still works
     before the placement cell has entered CGPAs by hand. */
  function studentCgpa(s) {
    const raw = s && s.cgpa;
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
      const n = parseFloat(raw);
      if (!isNaN(n)) return n;
    }
    const gpa = studentGPA(s.id);
    return gpa === null ? null : parseFloat(gpa);
  }
  function driveEligibility(s, d) {
    const reasons = [];
    const min = parseFloat(d.minCgpa);
    if (!isNaN(min) && min > 0) {
      const cg = studentCgpa(s);
      if (cg === null) reasons.push('No CGPA on record');
      else if (cg < min) reasons.push(`CGPA ${cg} below ${min}`);
    }
    const maxB = d.maxBacklogs;
    if (maxB !== '' && maxB !== null && maxB !== undefined && !isNaN(+maxB)) {
      if ((+s.backlogs || 0) > +maxB) reasons.push(`${+s.backlogs || 0} backlogs (max ${maxB})`);
    }
    const branches = csvList(d.eligibleBranches);
    if (branches.length && !branches.includes(specOf(s))) reasons.push('Specialisation not eligible');
    const courses = csvList(d.eligibleCourses);
    if (courses.length && !courses.includes(s.course)) reasons.push('Course not eligible');
    return { ok: reasons.length === 0, reasons };
  }
  function openDrives() {
    return Store.all('drives').filter(d => OPEN_DRIVE_STATUS.includes(d.status || 'Draft'));
  }
  function eligibleStudentsFor(d) {
    return Store.all('students').filter(s => driveEligibility(s, d).ok);
  }
  /* Every open drive is open to every student — the criteria are shown, not
     enforced, so the cell decides who goes forward. */
  function drivesOpenToStudent() {
    return openDrives();
  }
  /** the ones whose criteria this student actually meets — for reporting */
  function drivesStudentMeets(s) {
    return openDrives().filter(d => driveEligibility(s, d).ok);
  }

  /* ---------- a student's placement position ---------- */
  function studentApplications(sid) {
    return Store.all('applications').filter(a => a.studentId === sid)
      .sort((a, b) => String(b.appliedOn || '').localeCompare(String(a.appliedOn || '')));
  }
  function studentOffers(sid) {
    return Store.all('offers').filter(o => o.studentId === sid)
      .sort((a, b) => String(b.offerDate || '').localeCompare(String(a.offerDate || '')));
  }
  function placedOffer(sid) {
    return studentOffers(sid).find(o => PLACED_OFFER_STATUS.includes(o.status));
  }
  function isPlaced(sid) { return !!placedOffer(sid); }
  /** the single label shown wherever a student's placement standing appears */
  function placementStatusOf(sid) {
    // an offer that ended badly outranks anything earlier in the pipeline —
    // "Applied" would be a misleading thing to show about such a student
    const ended = studentOffers(sid).find(o => OFFER_ENDED_STATUS.includes(o.status));
    if (ended) {
      return { label: ended.status, pill: 'red',
               detail: [companyName(ended.companyId), ended.exitReason].filter(Boolean).join(' · ')
                       || companyName(ended.companyId) };
    }
    const off = placedOffer(sid);
    if (off) return { label: off.status === 'Joined' ? 'Joined' : 'Placed', pill: 'green',
                      detail: `${companyName(off.companyId)} · ${money(off.package)}` };
    if (studentOffers(sid).some(o => o.status === 'Offered'))
      return { label: 'Offer Pending', pill: 'amber', detail: 'Offer released, awaiting response' };
    const apps = studentApplications(sid);
    if (apps.some(a => a.status === 'Selected')) return { label: 'Selected', pill: 'green', detail: 'Selected, offer not issued' };
    if (apps.some(a => a.status === 'Shortlisted')) return { label: 'In Process', pill: 'amber', detail: 'Shortlisted' };
    if (apps.length) return { label: 'Applied', pill: 'blue', detail: `${apps.length} application(s)` };
    const open = openDrives();
    if (open.length) return { label: 'Not Applied', pill: 'blue', detail: `${open.length} open drive(s)` };
    return { label: 'No Drives Open', pill: 'red', detail: 'No drive is open right now' };
  }

  /* ==================== MY PLACEMENT (student) ====================
     The placement cell already holds everything a student wants to know —
     which companies are coming, whether they qualify, and where their own
     applications stand — and until now none of it reached them. Read only:
     applying still goes through the cell. */
  function viewMyPlacement() {
    const s = Store.find('students', user.refId);
    if (!s) {
      return `<div class="panel"><p class="empty">Your login is not linked to a student record.
        Please contact the office.</p></div>`;
    }
    const st = placementStatusOf(s.id);
    const apps = studentApplications(s.id);
    const offers = studentOffers(s.id);
    const ivs = Store.all('interviews').filter(i => i.studentId === s.id)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const cg = studentCgpa(s);
    const open = openDrives().slice()
      .sort((a, b) => String(a.appEndDate || a.driveDate || '').localeCompare(String(b.appEndDate || b.driveDate || '')));

    const appliedTo = new Set(apps.map(a => a.driveId));
    const driveRows = open.length ? open.map(d => {
      const el = driveEligibility(s, d);
      const closed = d.appEndDate && d.appEndDate < today();
      let action;
      if (appliedTo.has(d.id)) {
        const mine = apps.find(a => a.driveId === d.id);
        action = `<span class="pill ${APP_PILL[mine.status] || 'blue'}">${esc(mine.status || 'Applied')}</span>`;
      } else if (closed) {
        action = `<span class="pl-why">Closed</span>`;
      } else {
        action = `<button class="btn-sm btn-primary" data-apply="${d.id}">Apply</button>`;
      }
      return `<tr>
        <td>${esc(companyName(d.companyId))}</td>
        <td>${esc(d.jobRole || '—')}</td>
        <td>${d.package ? money(d.package) : '—'}</td>
        <td>${esc(d.location || '—')}</td>
        <td>${esc(d.appEndDate || d.driveDate || '—')}</td>
        <td>${el.ok ? `<span class="pill green">Meets criteria</span>`
          : `<span class="pill amber">Below criteria</span>
             <div class="pl-why">${esc(el.reasons.join(' · '))}</div>`}</td>
        <td>${action}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="7" class="empty">No drives are open right now.</td></tr>`;

    const appRows = apps.length ? apps.map(a => `<tr>
      <td>${esc(driveLabel(a.driveId))}</td>
      <td>${esc(a.appliedOn || '—')}</td>
      <td><span class="pill ${APP_PILL[a.status] || 'blue'}">${esc(a.status || '—')}</span></td>
      <td>${esc(a.remarks || '—')}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">You have not been put forward for any drive yet.</td></tr>`;

    const ivRows = ivs.length ? ivs.map(i => `<tr>
      <td>${esc(driveLabel(i.driveId))}</td>
      <td>${esc(i.round || '—')}</td>
      <td>${esc(i.date || '—')}${i.time ? ' · ' + esc(i.time) : ''}</td>
      <td>${esc(i.mode || '—')}${i.venue ? ' · ' + esc(i.venue) : ''}</td>
      <td><span class="pill ${IV_PILL[i.status] || 'blue'}">${esc(i.status || '—')}</span></td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">No interviews scheduled.</td></tr>`;

    const offerRows = offers.length ? offers.map(o => `<tr>
      <td>${esc(companyName(o.companyId))}</td>
      <td>${esc(o.jobRole || '—')}</td>
      <td>${o.package ? money(o.package) : '—'}</td>
      <td>${esc(o.offerDate || '—')}</td>
      <td>${esc(o.joiningDate || '—')}</td>
      <td><span class="pill ${OFFER_PILL[o.status] || 'blue'}">${esc(o.status || '—')}</span></td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">No offers yet.</td></tr>`;

    return `<div class="panel">
      <div class="panel-head"><h3>Placement Status</h3>
        <span class="pill ${st.pill}">${esc(st.label)}</span></div>
      <p class="pl-detail">${esc(st.detail)}</p>
      <div class="stat-grid" style="margin-top:14px">
        ${statCard('📨', apps.length, 'Applications')}
        ${statCard('🎤', ivs.length, 'Interviews', 'c2')}
        ${statCard('📜', offers.length, 'Offers', 'c3')}
        ${statCard('🚀', openDrives().length, 'Open Drives', 'c2')}
      </div></div>

    <div class="panel"><div class="panel-head"><h3>Your Figures</h3></div>
      <p class="pl-detail">These are the figures a drive's criteria are read against. They do
        not stop you applying — the placement cell decides who goes forward. A wrong CGPA or
        backlog count is corrected by the office, not here.</p>
      <div class="tbl-wrap"><table><tbody>
        <tr><td style="font-weight:600;width:200px">CGPA</td><td>${cg === null ? '— (not on record)' : cg}</td></tr>
        <tr><td style="font-weight:600">Active Backlogs</td><td>${+s.backlogs || 0}</td></tr>
        <tr><td style="font-weight:600">Specialisation</td><td>${esc(s.branch || '—')}</td></tr>
        <tr><td style="font-weight:600">Course</td><td>${esc(s.course || '—')}</td></tr>
        <tr><td style="font-weight:600">Batch</td><td>${esc(s.batch || '—')}</td></tr>
      </tbody></table></div></div>

    <div class="panel"><div class="panel-head"><h3>Open Drives</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Company</th><th>Role</th><th>Package</th><th>Location</th><th>Apply By</th>
        <th>Eligibility</th><th>Apply</th>
      </tr></thead><tbody>${driveRows}</tbody></table></div></div>

    <div class="panel"><div class="panel-head"><h3>Your Applications</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Drive</th><th>Applied On</th><th>Status</th><th>Remarks</th>
      </tr></thead><tbody>${appRows}</tbody></table></div></div>

    <div class="panel"><div class="panel-head"><h3>Your Interviews</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Drive</th><th>Round</th><th>When</th><th>Mode</th><th>Status</th>
      </tr></thead><tbody>${ivRows}</tbody></table></div></div>

    <div class="panel"><div class="panel-head"><h3>Your Offers</h3></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Company</th><th>Role</th><th>Package</th><th>Offered On</th><th>Joining</th><th>Status</th>
      </tr></thead><tbody>${offerRows}</tbody></table></div></div>`;
  }

  /* Applying is a real write, so it is confirmed first and the server has the
     final say — the button only appears when the page thinks you qualify, but
     the refusal that matters comes back from api_create. */
  viewMyPlacement.after = () => {
    $('#view').querySelectorAll('[data-apply]').forEach(btn => {
      btn.onclick = () => {
        const d = Store.find('drives', btn.dataset.apply);
        if (!d) return;
        openModal('Apply to this drive', `
          <p>Apply to <b>${esc(d.jobRole || 'this role')}</b> at
             <b>${esc(companyName(d.companyId))}</b>?</p>
          <p class="pl-detail">The placement cell takes it from here — you cannot
             withdraw an application yourself.</p>
          <div class="form-actions">
            <button class="btn-outline" id="cx">Cancel</button>
            <button class="btn-primary" id="ok">Apply</button>
          </div>`);
        $('#cx').onclick = closeModal;
        $('#ok').onclick = async () => {
          const ok = $('#ok');
          ok.disabled = true; ok.textContent = 'Applying...';
          const res = await Store.createOne('applications', { driveId: d.id });
          closeModal();
          if (res && res.error) { toast(res.error, 'err'); return; }
          toast('Applied. The placement cell will be in touch.');
          render();
        };
      };
    });
  };

  /* ---------- one place every placement number comes from ---------- */
  function placementStats() {
    const students = Store.all('students');
    const eligible = students.filter(s => drivesStudentMeets(s).length > 0);
    const placedOffers = Store.all('offers').filter(o => PLACED_OFFER_STATUS.includes(o.status));
    const placedIds = new Set(placedOffers.map(o => o.studentId));
    const selectedIds = new Set(Store.all('applications').filter(a => a.status === 'Selected').map(a => a.studentId));
    const pkgs = placedOffers.map(o => +o.package || 0).filter(n => n > 0);
    /* Unplaced is everyone not placed, and the placement rate is out of the
       whole roll — not out of who happened to qualify for an open drive. The
       cell reports against its intake, and a student nobody has run a drive
       for is exactly the one worth counting. */
    const denom = students.length;
    // eligible for at least one drive and not placed — the number the cell is
    // actually chasing, which no screen showed
    const unplaced = students.length - placedIds.size;
    /* Counted per student rather than per offer: one person who did not turn
       up is one number, however many offers their file holds. */
    const endedIds = (which) => new Set(Store.all('offers')
      .filter(o => o.status === which).map(o => o.studentId));
    const notJoined = endedIds('Not Joined').size;
    const left = endedIds('Left').size;
    return {
      students: students.length, eligible: eligible.length, denom, unplaced,
      notJoined, left,
      companies: Store.all('companies').length,
      drives: Store.all('drives').length, activeDrives: openDrives().length,
      applications: Store.all('applications').length,
      shortlisted: Store.all('applications').filter(a => a.status === 'Shortlisted').length,
      selected: selectedIds.size, placed: placedIds.size,
      offers: Store.all('offers').length,
      interviews: Store.all('interviews').length,
      pct: denom ? Math.round(placedIds.size / denom * 100) : 0,
      highest: pkgs.length ? Math.max(...pkgs) : 0,
      lowest: pkgs.length ? Math.min(...pkgs) : 0,
      average: pkgs.length ? Math.round(pkgs.reduce((a, b) => a + b, 0) / pkgs.length) : 0,
      placedOffers,
    };
  }

  /** guard for every placement page — the server refuses these collections too */
  function placementGuard() {
    return canManagePlacement() ? null
      : `<div class="panel"><p class="empty">The placement modules are open to the
         administrator and the placement officer only.</p></div>`;
  }

  /* ---------- offer letter upload (PDF or image, stored as a data URL) ---------- */
  function offerLetterField(current, currentName) {
    return `<div class="field full">
      <label>Offer Letter <small style="color:var(--muted);font-weight:400">(PDF or image, up to 2 MB)</small></label>
      <input type="file" accept="application/pdf,image/*" id="olFileInput">
      <input type="hidden" name="offerLetter" id="olValueInput" value="${esc(current || '')}">
      <input type="hidden" name="offerLetterName" id="olNameInput" value="${esc(currentName || '')}">
      <div id="olPreview" style="margin-top:8px;font-size:12.5px;color:var(--muted)">
        ${current ? `📎 ${esc(currentName || 'offer-letter')}` : 'No file attached.'}</div>
    </div>`;
  }
  function bindOfferLetterField() {
    const input = $('#olFileInput');
    if (!input) return;
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        toast('That file is over 2 MB — please attach a smaller one.', 'err');
        e.target.value = ''; return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        $('#olValueInput').value = reader.result;
        $('#olNameInput').value = file.name;
        $('#olPreview').innerHTML = `📎 ${esc(file.name)}`;
      };
      reader.onerror = () => toast('Could not read that file.', 'err');
      reader.readAsDataURL(file);
    };
  }
  function openOfferLetter(offerId) {
    const o = Store.find('offers', offerId);
    if (!o || !o.offerLetter) { toast('No offer letter attached to this offer.', 'err'); return; }
    const w = window.open('', '_blank');
    if (!w) { toast('Please allow pop-ups to view the offer letter.', 'err'); return; }
    const isPdf = String(o.offerLetter).startsWith('data:application/pdf');
    w.document.write(`<!doctype html><title>${esc(o.offerLetterName || 'Offer Letter')}</title>
      <body style="margin:0;background:#333">${isPdf
        ? `<embed src="${o.offerLetter}" type="application/pdf" style="width:100vw;height:100vh">`
        : `<img src="${o.offerLetter}" style="max-width:100%;display:block;margin:0 auto">`}</body>`);
    w.document.close();
  }

  /* =========================== DASHBOARD =========================== */
  function placementDashboard() {
    const st = placementStats();
    const students = Store.all('students');
    const drives = Store.all('drives');
    const apps = Store.all('applications');

    // company-wise selection counts
    const byCompany = {};
    st.placedOffers.forEach(o => {
      const k = companyName(o.companyId);
      byCompany[k] = byCompany[k] || { company: k, placed: 0, total: 0 };
      byCompany[k].placed++; byCompany[k].total += +o.package || 0;
    });
    const companyRows = Object.values(byCompany).sort((a, b) => b.placed - a.placed);
    const maxCompany = Math.max(1, ...companyRows.map(c => c.placed));

    // branch-wise placement
    const byBranch = {};
    students.forEach(s => {
      const b = s.branch || '—';
      byBranch[b] = byBranch[b] || { branch: b, total: 0, placed: 0 };
      byBranch[b].total++;
      if (isPlaced(s.id)) byBranch[b].placed++;
    });
    const branchRows = Object.values(byBranch).sort((a, b) => b.placed - a.placed || b.total - a.total);
    const maxBranchTotal = Math.max(1, ...branchRows.map(b => b.total));

    const appStatusCounts = {};
    APP_STATUS.forEach(s => { appStatusCounts[s] = apps.filter(a => (a.status || 'Applied') === s).length; });
    const segments = APP_STATUS.map((s, i) => ({
      label: s, value: appStatusCounts[s],
      color: ['var(--blue)', 'var(--amber)', 'var(--red)', 'var(--primary)', 'var(--line)'][i],
    })).filter(x => x.value > 0);

    const upcoming = Store.all('placementevents')
      .filter(e => (e.date || '') >= today())
      .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 5);

    let html = `<div class="welcome-banner">
      <div class="wb-text">
        <h2>${greeting()}, ${esc(firstName(user.name))} 👋</h2>
        <p>Training &amp; Placement Cell · ${prettyDate()}</p>
        <div class="wb-chips">
          <span>🏢 ${st.companies} companies</span><span>🚀 ${st.activeDrives} active drives</span>
          <span>🏆 ${st.placed} placed</span><span>📈 ${st.pct}% placement</span>
        </div>
      </div>
      <div class="wb-logo"><img src="assets/nmiet-logo.png" alt="NMIET B-SCHOOL"></div>
    </div>`;

    // eligibility is computed from CGPA / backlogs / branch / course on the
    // student record — say so plainly when that data has not been entered yet,
    // rather than just reporting "0 eligible"
    const missingCgpa = students.filter(s => studentCgpa(s) === null).length;
    const needsCriteria = openDrives().some(d => d.minCgpa || csvList(d.eligibleCourses).length);
    if (st.eligible === 0 && st.activeDrives > 0 && needsCriteria && missingCgpa) {
      html += `<div class="ro-banner">
        <span class="ro-badge">ACTION NEEDED</span>
        <span>${missingCgpa} of ${students.length} students have no CGPA on record, so no one clears the
        eligibility criteria yet. ${user.role === 'admin'
          ? 'Add CGPA, backlogs and course on the Students page.'
          : 'Ask the administrator to fill in CGPA, backlogs and course on the student records.'}</span>
      </div>`;
    }

    html += `<h3 class="ro-section">Overview</h3>
      <div class="stat-grid">
        ${statCard('🎓', st.students, 'Total Students')}
        ${statCard('✅', st.eligible, 'Eligible Students', 'c3')}
        ${statCard('🏢', st.companies, 'Companies', 'c2')}
        ${statCard('🚀', st.activeDrives, `Active Drives (of ${st.drives})`, 'c2')}
        ${statCard('📨', st.applications, 'Applications')}
        ${statCard('🏆', st.placed, 'Placed Students', 'c3')}
        ${statCard('🔍', st.unplaced, 'Unplaced Students', 'c4')}
        ${statCard('🚫', st.notJoined, 'Not Joined', 'c4')}
        ${statCard('🚪', st.left, 'Left After Joining', 'c4')}
        ${statCard('📈', st.pct + '%', `Placement (of ${st.denom} students)`, st.pct >= 50 ? 'c3' : 'c4')}
        ${statCard('💰', money(st.highest), 'Highest Package', 'c3')}
        ${statCard('📊', money(st.average), 'Average Package', 'c2')}
      </div>`;

    html += `<div class="dash-2col">
      <div class="panel"><div class="panel-head"><h3>Company-wise Selections</h3></div>
        ${companyRows.length ? companyRows.map(c => `<div class="dist-row">
          <span class="dist-label">${esc(c.company)}</span>
          <span class="dist-bar"><i style="width:${Math.round(c.placed / maxCompany * 100)}%"></i></span>
          <span class="dist-val">${c.placed}<small>${money(Math.round(c.total / c.placed))} avg</small></span>
        </div>`).join('') : '<p class="empty">No students placed yet.</p>'}
      </div>
      <div class="panel"><div class="panel-head"><h3>Application Pipeline</h3></div>
        <div class="lib-donut-wrap">
          <div class="lib-donut" style="background:${segments.length ? donutGradient(segments) : 'var(--primary-light)'}">
            <div class="lib-donut-center"><strong>${st.applications}</strong><span>Applications</span></div>
          </div>
          <div class="lib-legend">
            <div class="lib-legend-head"><span>Status</span><span>Count</span></div>
            ${segments.length ? segments.map(s => `<div class="lib-legend-row">
              <span class="dotlbl"><span class="ldot" style="background:${s.color}"></span>${esc(s.label)}</span>
              <span>${s.value}</span></div>`).join('') : '<p class="empty">No applications yet.</p>'}
          </div>
        </div>
      </div>
    </div>`;

    html += `<div class="dash-2col">
      <div class="panel"><div class="panel-head"><h3>Specialisation-wise Placement</h3></div>
        <div class="tbl-wrap"><table><thead><tr><th>Specialisation</th>
          <th style="text-align:right">Students</th><th style="text-align:right">Placed</th><th>Rate</th>
        </tr></thead><tbody>${branchRows.length ? branchRows.map(b => `<tr>
          <td>${esc(b.branch)}</td><td style="text-align:right">${b.total}</td>
          <td style="text-align:right">${b.placed}</td>
          <td>${attBar(b.total ? Math.round(b.placed / b.total * 100) : 0)}</td></tr>`).join('')
          : `<tr><td colspan="4" class="empty">No students on record.</td></tr>`}
        </tbody></table></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>📅 Upcoming Placement Events</h3>
        <span style="font-size:12.5px;color:var(--muted)">Next ${upcoming.length}</span></div>
        <div class="lib-events-list">${upcoming.length ? upcoming.map(e => {
          const d = new Date(e.date + 'T00:00:00');
          const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
          const days = Math.round((d - new Date(today() + 'T00:00:00')) / 86400000);
          return `<div class="lib-event">
            <div class="lib-event-badge"><span class="mon">${mon}</span><span class="day">${d.getDate()}</span></div>
            <div><div class="lib-event-title">${esc(e.title)}</div>
            <div class="lib-event-meta">${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : 'in ' + days + ' days'}
              · ${esc(e.type || 'Event')}${e.venue ? ' · ' + esc(e.venue) : ''}</div></div>
          </div>`;
        }).join('') : '<p class="empty">Nothing scheduled. Add dates on the Placement Calendar.</p>'}</div>
      </div>
    </div>`;

    html += `<div class="panel"><div class="panel-head"><h3>Active Drives</h3>
      <button class="btn-primary btn-sm" id="pdGoDrives">🚀 Manage Drives</button></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Company</th><th>Role</th><th style="text-align:right">Package</th><th>Drive Date</th>
        <th style="text-align:right">Eligible</th><th style="text-align:right">Applied</th><th>Status</th>
      </tr></thead><tbody>${openDrives().length ? openDrives().map(d => `<tr>
        <td>${esc(companyName(d.companyId))}</td><td>${esc(d.jobRole || '—')}</td>
        <td style="text-align:right">${money(d.package)}</td><td>${esc(d.driveDate || '—')}</td>
        <td style="text-align:right">${eligibleStudentsFor(d).length}</td>
        <td style="text-align:right">${apps.filter(a => a.driveId === d.id).length}</td>
        <td><span class="pill ${DRIVE_PILL[d.status] || 'blue'}">${esc(d.status || 'Draft')}</span></td>
      </tr>`).join('') : `<tr><td colspan="7" class="empty">No active drives. Publish one from Placement Drives.</td></tr>`}
      </tbody></table></div></div>`;

    viewDashboard.after = () => { $('#pdGoDrives').onclick = () => navigate('drives'); };
    return html;
  }

  /* =========================== STUDENTS =========================== */
  function viewPlacementStudents() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Students — Placement</h3>
      <div class="panel-tools">${exportButtons('ps')}</div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="psQ" placeholder="Search name / reg no...">
        <select class="filter-sel" id="psBranch"><option value="">All Specialisations</option>${specialisationOptions()}</select>
        <select class="filter-sel" id="psDrive"><option value="">Eligibility: any drive</option>${driveOptions()}</select>
        <select class="filter-sel" id="psStatus"><option value="">All Placement Statuses</option>
          <option>Placed</option><option>Joined</option><option>Offer Pending</option>
          <option>Selected</option><option>In Process</option><option>Applied</option>
          <option>Not Joined</option><option>Left</option>
          <option>Not Applied</option><option>No Drives Open</option></select>
        <button class="btn-outline btn-sm" id="psClear">Clear</button>
      </div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Reg No</th><th>Name</th><th>Specialisation</th><th>Sem</th><th style="text-align:right">CGPA</th>
        <th style="text-align:right">Attendance</th><th>Meets Criteria</th><th>Placement Status</th>
        <th>Actions</th><th style="text-align:right">Backlogs</th>
      </tr></thead><tbody id="psBody"></tbody></table></div><div id="psPager"></div></div>`;

    viewPlacementStudents.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#psQ').value || '').trim().toLowerCase();
        const br = $('#psBranch').value, driveId = $('#psDrive').value, stFilter = $('#psStatus').value;
        const drive = driveId ? Store.find('drives', driveId) : null;
        return Store.all('students').map(s => {
          const status = placementStatusOf(s.id);
          const open = drivesStudentMeets(s);
          const el = drive ? driveEligibility(s, drive) : null;
          return {
            sid: s.id, roll: s.roll || '', name: s.name || '', branch: specOf(s) || '—',
            semester: s.semester || '', cgpa: studentCgpa(s) ?? '—', backlogs: +s.backlogs || 0,
            attendance: studentAttendancePct(s.id),
            eligibleDrives: open.length, status: status.label, pill: status.pill, detail: status.detail,
            driveEligible: el, student: s,
          };
        }).filter(r =>
          (!q || [r.roll, r.name, r.branch].some(v => String(v).toLowerCase().includes(q))) &&
          (!br || r.branch === br) &&
          (!drive || (r.driveEligible && r.driveEligible.ok)) &&
          (!stFilter || r.status === stFilter))
          .sort((a, b) => String(a.roll).localeCompare(String(b.roll)));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        /* The counts live on the placement dashboard. Repeating them above the
           list only pushed the list itself off the screen. */
        $('#psBody').innerHTML = rows.length ? pageSlice(rows, page).map(r => `<tr>
          <td class="mono">${esc(r.roll)}</td><td>${esc(r.name)}</td><td>${esc(r.branch)}</td>
          <td>${esc(String(r.semester))}</td>
          <td style="text-align:right">${esc(String(r.cgpa))}</td>
          <td style="text-align:right">${r.attendance === null ? '—' : r.attendance + '%'}</td>
          <td><span class="pill ${r.eligibleDrives ? 'green' : 'amber'}">${r.eligibleDrives} drive(s)</span></td>
          <td><span class="pill ${r.pill}">${esc(r.status)}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-hist="${r.sid}" title="Placement history">👁 History</button>
          </div></td>
          <td style="text-align:right${r.backlogs ? ';color:var(--red);font-weight:600' : ''}">${r.backlogs}</td>
        </tr>`).join('')
          : `<tr><td colspan="10" class="empty">No students match these filters.</td></tr>`;
        $('#psBody').querySelectorAll('[data-hist]').forEach(b =>
          b.onclick = () => studentPlacementModal(b.dataset.hist));
        $('#psPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#psPager'), rows.length, page, (p) => page = p, draw);
      };
      ['psQ', 'psBranch', 'psDrive', 'psStatus'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#psClear').onclick = () => {
        ['psQ', 'psBranch', 'psDrive', 'psStatus'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      bindExports('ps', () => {
        const rows = rowsFor();
        return {
          title: 'Student Placement Report', sheetName: 'Placement Students', subtitle: placementStamp(),
          columns: [
            { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student Name', key: 'name', width: 26 },
            { header: 'Specialisation', key: 'branch', width: 10 },
            { header: 'Semester', key: 'semester', width: 10, type: 'number' },
            { header: 'CGPA', key: 'cgpa', width: 9 },
            { header: 'Attendance %', key: 'attendance', width: 13 },
            { header: 'Eligible Drives', key: 'eligibleDrives', width: 15, type: 'number' },
            { header: 'Placement Status', key: 'status', width: 18 },
            { header: 'Detail', key: 'detail', width: 34 },
            { header: 'Backlogs', key: 'backlogs', width: 10, type: 'number' },
          ],
          rows,
          totals: { roll: 'TOTAL', name: rows.length + ' students' },
        };
      });
      draw();
    };
    return html;
  }

  /** full placement history of one student — applications, interviews, offers */
  function studentPlacementModal(sid) {
    const s = Store.find('students', sid);
    if (!s) return;
    const status = placementStatusOf(sid);
    const apps = studentApplications(sid);
    const offers = studentOffers(sid);
    const ivs = Store.all('interviews').filter(i => i.studentId === sid)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const open = drivesOpenToStudent(s);

    const appRows = apps.length ? apps.map(a => `<tr>
      <td>${esc(driveLabel(a.driveId))}</td><td>${esc(a.appliedOn || '—')}</td>
      <td><span class="pill ${APP_PILL[a.status] || 'blue'}">${esc(a.status || 'Applied')}</span></td>
      <td>${esc(a.remarks || '—')}</td></tr>`).join('')
      : `<tr><td colspan="4" class="empty">No applications yet.</td></tr>`;

    const ivRows = ivs.length ? ivs.map(i => `<tr>
      <td>${esc(driveLabel(i.driveId))}</td><td>Round ${esc(String(i.round || 1))}</td>
      <td>${esc(i.date || '—')} ${esc(i.time || '')}</td><td>${esc(i.mode || '—')}</td>
      <td><span class="pill ${IV_PILL[i.status] || 'blue'}">${esc(i.status || 'Scheduled')}</span></td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">No interviews scheduled.</td></tr>`;

    const offerRows = offers.length ? offers.map(o => `<tr>
      <td>${esc(companyName(o.companyId))}</td><td>${esc(o.jobRole || '—')}</td>
      <td style="text-align:right">${money(o.package)}</td><td>${esc(o.joiningDate || '—')}</td>
      <td><span class="pill ${OFFER_PILL[o.status] || 'blue'}">${esc(o.status || 'Offered')}</span></td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">No offers yet.</td></tr>`;

    const eligRows = open.length ? open.map(d => `<tr>
      <td>${esc(companyName(d.companyId))}</td><td>${esc(d.jobRole || '—')}</td>
      <td style="text-align:right">${money(d.package)}</td><td>${esc(d.driveDate || '—')}</td>
      <td>${apps.some(a => a.driveId === d.id)
        ? '<span class="pill green">Applied</span>' : '<span class="pill blue">Not applied</span>'}</td></tr>`).join('')
      : `<tr><td colspan="5" class="empty">No drive is open right now.</td></tr>`;

    openModal('Placement — ' + s.name, `
      <div style="display:flex;gap:18px;align-items:center;margin-bottom:18px">
        <div class="logo-circle">${s.photo ? `<img src="${esc(s.photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((s.name || '?')[0])}</div>
        <div><h3 style="color:var(--primary-dark)">${esc(s.name)}</h3>
        <p style="color:var(--muted);font-size:13px">${esc(s.roll)} · ${esc(s.branch || '—')} ·
          Sem ${esc(String(s.semester || '—'))} · Batch ${esc(s.batch || '—')}</p></div>
      </div>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('🎯', studentCgpa(s) ?? '—', 'CGPA')}
        ${statCard('⚠️', +s.backlogs || 0, 'Backlogs', (+s.backlogs || 0) ? 'c4' : 'c3')}
        ${statCard('📨', apps.length, 'Applications', 'c2')}
        ${statCard('🏆', status.label, 'Status', status.pill === 'green' ? 'c3' : status.pill === 'red' ? 'c4' : 'c2')}
      </div>
      <h4 class="ro-sub">Open Drives</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Company</th><th>Role</th>
        <th style="text-align:right">Package</th><th>Drive Date</th><th>Applied?</th>
      </tr></thead><tbody>${eligRows}</tbody></table></div>
      <h4 class="ro-sub">Applications</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Drive</th><th>Applied On</th><th>Status</th><th>Remarks</th>
      </tr></thead><tbody>${appRows}</tbody></table></div>
      <h4 class="ro-sub">Interviews</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Drive</th><th>Round</th><th>When</th><th>Mode</th><th>Status</th>
      </tr></thead><tbody>${ivRows}</tbody></table></div>
      <h4 class="ro-sub">Offers</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Company</th><th>Role</th>
        <th style="text-align:right">Package</th><th>Joining</th><th>Status</th>
      </tr></thead><tbody>${offerRows}</tbody></table></div>
      <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
  }

  /* ==================== USER SETTINGS (admin) ====================
     A role says what kind of account somebody has; this narrows one account
     inside it. Full access means everything the role allows. Restricted means
     the ticked modules and nothing else — enforced by the API too, so it is a
     permission rather than a tidier menu. */
  /* =========================================================
     THE PERMISSION GRID — one component, two callers.

     Against a role it edits the template every account with that role
     inherits. Against a user it edits the override that wins over the
     template. Both are drawn from MODULES × ACTIONS, so a module added to the
     CMS appears on both screens the same day and neither has to be touched.
     ========================================================= */

  /** the grid's markup for one subject, capped by what its role's code supports */
  function permGridHtml(ceiling, current, opts) {
    const o = opts || {};
    const rows = MODULES.filter(([key]) => ceiling[key]);
    if (!rows.length) {
      return `<p class="empty" style="padding:16px 2px">This role opens the dashboard and its
        own pages only — there is nothing to narrow.</p>`;
    }
    return `<div class="pg-tools">
        <input class="search-box" id="pgSearch" placeholder="Search modules...">
        <button type="button" class="btn-outline btn-sm" id="pgAll">Select all</button>
        <button type="button" class="btn-outline btn-sm" id="pgNone">Clear all</button>
        <button type="button" class="btn-outline btn-sm" id="pgReset">Reset</button>
      </div>
      <div class="tbl-wrap pg-wrap"><table class="pg-table"><thead><tr>
        <th class="pg-mod">Module</th>
        ${ACTIONS.map(([, label]) => `<th>${esc(label)}</th>`).join('')}
        <th class="pg-all">All</th>
      </tr></thead><tbody id="pgBody">
        ${rows.map(([key, label]) => `<tr data-mod="${key}" data-name="${esc(label.toLowerCase())}">
          <td class="pg-mod">${esc(label)}</td>
          ${ACTIONS.map(([a]) => {
            const supported = ceiling[key].includes(a);
            if (!supported) return `<td class="pg-na" title="Not available for this role">—</td>`;
            return `<td><input type="checkbox" data-p="${key}:${a}" ${
              (current[key] || []).includes(a) ? 'checked' : ''}></td>`;
          }).join('')}
          <td class="pg-all"><input type="checkbox" data-row="${key}"></td>
        </tr>`).join('')}
      </tbody></table></div>
      <p style="font-size:12.5px;color:var(--muted);margin:10px 0 0">
        A dash is an action this role's pages have never supported — it cannot be granted here,
        only in the code. ${o.note || ''}</p>`;
  }

  /** wire the grid up; returns read(), which hands back what is ticked */
  function bindPermGrid(ceiling, current) {
    const boxes = () => [...document.querySelectorAll('#pgBody [data-p]')];
    const rowBoxes = () => [...document.querySelectorAll('#pgBody [data-row]')];
    const visible = (tr) => !tr.classList.contains('hidden');
    const syncRows = () => rowBoxes().forEach(rb => {
      const tr = rb.closest('tr');
      const mine = [...tr.querySelectorAll('[data-p]')];
      rb.checked = mine.length > 0 && mine.every(b => b.checked);
    });
    /* Ticking an action nobody could reach is a permission that reads as
       granted and behaves as refused, so View comes along with every other
       action and clearing View clears the row. */
    const syncView = (key) => {
      const tr = document.querySelector(`#pgBody tr[data-mod="${key}"]`);
      const view = tr.querySelector('[data-p$=":view"]');
      if (!view) return;
      const others = [...tr.querySelectorAll('[data-p]')].filter(b => b !== view);
      if (others.some(b => b.checked)) view.checked = true;
    };
    boxes().forEach(b => b.onchange = () => {
      const [key, act] = b.dataset.p.split(':');
      if (act === 'view' && !b.checked) {
        // nothing is reachable in a module that cannot be opened
        document.querySelectorAll(`#pgBody tr[data-mod="${key}"] [data-p]`)
          .forEach(x => { x.checked = false; });
      } else {
        syncView(key);
      }
      syncRows();
    });
    rowBoxes().forEach(rb => rb.onchange = () => {
      rb.closest('tr').querySelectorAll('[data-p]').forEach(b => { b.checked = rb.checked; });
    });
    const setAll = (on) => {
      boxes().forEach(b => { if (visible(b.closest('tr'))) b.checked = on; });
      syncRows();
    };
    $('#pgAll').onclick = () => setAll(true);
    $('#pgNone').onclick = () => setAll(false);
    $('#pgReset').onclick = () => {
      boxes().forEach(b => {
        const [key, act] = b.dataset.p.split(':');
        b.checked = (current[key] || []).includes(act);
      });
      syncRows();
      toast('Back to what is saved.');
    };
    $('#pgSearch').oninput = () => {
      const q = ($('#pgSearch').value || '').trim().toLowerCase();
      document.querySelectorAll('#pgBody tr').forEach(tr =>
        tr.classList.toggle('hidden', !!q && !tr.dataset.name.includes(q)));
    };
    syncRows();
    return () => {
      const out = {};
      boxes().forEach(b => {
        if (!b.checked) return;
        const [key, act] = b.dataset.p.split(':');
        (out[key] = out[key] || []).push(act);
      });
      // capped again on the way out, so a stale ceiling can never widen a grant
      Object.keys(out).forEach(k => {
        out[k] = ACTION_KEYS.filter(a => out[k].includes(a) && (ceiling[k] || []).includes(a));
        if (!out[k].length) delete out[k];
      });
      return out;
    };
  }

  /** a one-line summary of a permission set, for a table cell */
  function permSummary(perms, ceiling) {
    if (perms === null) return 'Everything this role allows';
    const on = MODULES.filter(([k]) => (perms[k] || []).length);
    if (!on.length) return 'No modules — dashboard only';
    return on.map(([k, label]) => {
      const acts = perms[k];
      const full = (ceiling[k] || []).length && acts.length === ceiling[k].length;
      return `${label} (${full ? 'full' : acts.length === 1 && acts[0] === 'view' ? 'view'
        : acts.length + ' actions'})`;
    }).join(', ');
  }

  /* Written where the change is made, because only the code doing the saving
     knows what the value was a moment ago. One entry per module that moved,
     with the actions that came on and the ones that went off. */
  function auditPerms(kind, key, label, before, after) {
    const keys = [...new Set(Object.keys(before || {}).concat(Object.keys(after || {})))];
    const changes = [];
    keys.forEach(m => {
      const was = (before && before[m]) || [];
      const now = (after && after[m]) || [];
      const on = now.filter(a => !was.includes(a));
      const off = was.filter(a => !now.includes(a));
      if (on.length || off.length) {
        const mod = MODULES.find(([k]) => k === m);
        changes.push({ module: m, label: mod ? mod[1] : m, on, off });
      }
    });
    if (!changes.length) return;
    const summary = changes.slice(0, 3).map(c =>
      `${c.label}: ${c.on.map(a => a + ' ON').concat(c.off.map(a => a + ' OFF')).join(', ')}`)
      .join(' · ') + (changes.length > 3 ? ` · +${changes.length - 3} more` : '');
    Store.add('auditlog', {
      at: new Date().toISOString(),
      actorId: user.id, actorName: displayName(user),
      subjectType: kind, subjectKey: String(key), subjectName: label,
      summary, changes,
    });
  }

  /* =========================================================
     ROLES — the templates.
     ========================================================= */
  function viewRoles() {
    if (user.role !== 'admin') return accessDenied();
    const html = `<div class="panel"><div class="panel-head"><h3>Roles &amp; Permissions</h3>
      <div class="panel-tools">
        <input class="search-box" id="rlQ" placeholder="Search roles...">
        <button class="btn-primary" id="rlAdd">+ Create Role</button>
      </div></div>
      <p style="font-size:13px;color:var(--muted);margin:-6px 0 14px">
        A role is a permission set several people share. Change it here and everybody holding it
        follows, unless their own account has an override. A custom role borrows its menu from the
        built-in role it is based on — that is also the most it can ever be given.</p>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Role</th><th>Type</th><th>Based On</th><th>Users</th><th>Access</th><th>Actions</th>
      </tr></thead><tbody id="rlBody"></tbody></table></div></div>`;

    viewRoles.after = () => {
      const draw = () => {
        const q = ($('#rlQ').value || '').trim().toLowerCase();
        const rows = allRoleKeys()
          .filter(k => !q || roleLabel(k).toLowerCase().includes(q) || k.includes(q));
        $('#rlBody').innerHTML = rows.length ? rows.map(k => {
          const builtin = BUILTIN_ROLES.includes(k);
          const row = roleRow(k);
          const ceiling = roleCeiling(baseRoleOf(k));
          const users = Store.all('users').filter(u => u.role === k).length;
          return `<tr>
            <td><b>${esc(roleLabel(k))}</b><br><small class="mono" style="color:var(--muted)">${esc(k)}</small></td>
            <td><span class="pill ${builtin ? 'blue' : 'green'}">${builtin ? 'Built-in' : 'Custom'}</span></td>
            <td>${builtin ? '—' : esc(roleLabel(baseRoleOf(k)))}</td>
            <td>${users}</td>
            <td style="max-width:340px;white-space:normal;font-size:12.5px;color:var(--muted)">${
              esc(permSummary(rolePerms(k), ceiling))}</td>
            <td><div class="row-actions">
              <button class="btn-sm btn-edit" data-perm="${esc(k)}">Permissions</button>
              <button class="btn-sm btn-outline" data-copy="${esc(k)}">Duplicate</button>
              ${builtin ? '' : `<button class="btn-sm btn-outline" data-edit="${esc(k)}">Rename</button>
              <button class="btn-sm btn-del" data-del="${esc(k)}" ${users ? 'disabled title="In use"' : ''}>Delete</button>`}
            </div></td></tr>`;
        }).join('') : `<tr><td colspan="6" class="empty">No roles match.</td></tr>`;

        $('#rlBody').querySelectorAll('[data-perm]').forEach(b =>
          b.onclick = () => rolePermsModal(b.dataset.perm, draw));
        $('#rlBody').querySelectorAll('[data-copy]').forEach(b =>
          b.onclick = () => roleForm(null, draw, b.dataset.copy));
        $('#rlBody').querySelectorAll('[data-edit]').forEach(b =>
          b.onclick = () => roleForm(b.dataset.edit, draw));
        $('#rlBody').querySelectorAll('[data-del]:not([disabled])').forEach(b =>
          b.onclick = () => {
            const row = roleRow(b.dataset.del);
            confirmDelete('Delete Role', `Remove the role <b>${esc(roleLabel(b.dataset.del))}</b>?`,
              'Delete Role', () => {
                if (row) Store.remove('roles', row.id);
                toast('Role deleted.', 'err'); draw();
              });
          });
      };
      $('#rlQ').oninput = draw;
      $('#rlAdd').onclick = () => roleForm(null, draw);
      draw();
    };
    return html;
  }

  /* Create or rename a role. `copyOf` seeds a new one from an existing role's
     base and permissions, which is what makes "Duplicate" a starting point
     rather than a blank page. */
  function roleForm(key, after, copyOf) {
    const row = key ? roleRow(key) : null;
    const seed = copyOf || key;
    const base = seed ? baseRoleOf(seed) : 'faculty';
    openModal((key ? 'Rename' : 'Create') + ' Role', `<form id="f">
      <div class="form-grid">
        <div class="field"><label>Role Name</label>
          <input name="label" value="${esc(row ? row.label : (copyOf ? roleLabel(copyOf) + ' (copy)' : ''))}"
                 placeholder="e.g. Telecaller" required></div>
        <div class="field"><label>Based On</label>
          <select name="base" ${key ? 'disabled' : ''}>${BUILTIN_ROLES.filter(r => r !== 'student')
            .map(r => `<option value="${r}" ${r === base ? 'selected' : ''}>${esc(ROLE_LABEL[r])}</option>`).join('')}</select></div>
        ${fArea('description', 'What this role is for', row ? row.description : '')}
      </div>
      <p style="font-size:12.5px;color:var(--muted);margin:4px 0 0">
        The base decides which menu this role gets and the most it can ever be given — a permission
        narrows that, never widens it. It cannot be changed afterwards, because everybody already
        holding the role would move with it.</p>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const label = (d.label || '').trim();
      if (!label) { toast('The role needs a name.', 'err'); return; }
      if (row) {
        Store.update('roles', row.id, { label, description: d.description || '' });
        closeModal(); toast('Role renamed.'); if (after) after(); return;
      }
      // a key nobody else holds, from the name, so the login row can carry it
      let slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role';
      const taken = new Set(allRoleKeys());
      if (taken.has(slug)) { let n = 2; while (taken.has(slug + n)) n++; slug = slug + n; }
      Store.add('roles', {
        key: slug, label, base: d.base || 'faculty', builtin: '', status: 'Active',
        description: d.description || '',
        // duplicating copies the template; a fresh role starts with its ceiling
        permissions: copyOf ? (rolePerms(copyOf) || roleCeiling(baseRoleOf(copyOf)))
                            : roleCeiling(d.base || 'faculty'),
      });
      closeModal(); toast('Role created.'); if (after) after();
    };
  }

  function rolePermsModal(key, after) {
    const base = baseRoleOf(key);
    const ceiling = roleCeiling(base);
    const current = rolePerms(key) || ceiling;
    const row = roleRow(key);
    openModal('Permissions — ' + roleLabel(key), `<form id="f">
      <p style="font-size:13px;color:var(--muted);margin:0 0 14px">
        Everybody with this role gets what is ticked here, unless their own account overrides it.
        ${BUILTIN_ROLES.includes(key) ? '' : `Based on <b>${esc(ROLE_LABEL[base])}</b>.`}</p>
      ${permGridHtml(ceiling, current, {
        note: 'A user can be given less than this on their own account, never more.' })}
      <div class="form-actions">
        <button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save Permissions</button></div></form>`, true);
    const read = bindPermGrid(ceiling, current);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const perms = read();
      const before = rolePerms(key);
      if (row) Store.update('roles', row.id, { permissions: perms });
      else Store.add('roles', { key, label: roleLabel(key), base, builtin: '1',
                                status: 'Active', permissions: perms });
      auditPerms('role', key, roleLabel(key), before, perms);
      closeModal(); toast('Permissions saved.'); if (after) after(); else render();
    };
  }

  /* =========================================================
     USER MANAGEMENT — every login, what it is, and what it reaches.
     ========================================================= */

  /** the account is switched on unless somebody deliberately switched it off */
  function userActive(u) { return String((u && u.status) || 'Active') !== 'Inactive'; }

  function viewUserSettings() {
    if (user.role !== 'admin') return accessDenied();
    const html = `<div class="panel"><div class="panel-head"><h3>User Management</h3>
        <div class="panel-tools">
          <input class="search-box" id="usQ" placeholder="Search name / user id / email...">
          <select class="filter-sel" id="usRole"><option value="">All Roles</option>
            ${allRoleKeys().map(r => `<option value="${esc(r)}">${esc(roleLabel(r))}</option>`).join('')}</select>
          <select class="filter-sel" id="usStatus"><option value="">Any Status</option>
            <option value="Active">Active</option><option value="Inactive">Inactive</option></select>
          <button class="btn-outline btn-sm" id="usRoles">🛡 Roles</button>
          <button class="btn-outline btn-sm" id="usAudit">🕘 Audit Log</button>
          <button class="btn-primary" id="usAdd">+ Create User</button>
        </div></div>
      <p style="font-size:13px;color:var(--muted);margin:-6px 0 14px">
        Every login and what it may open. <b>Role Default</b> means the account follows its role —
        change the role once and everybody on it moves. <b>Custom</b> means this one account has
        its own answer, which wins over the role. The menu follows both, and so does the server.</p>
      <div id="usStats" class="stat-grid" style="margin:0 0 16px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Name</th><th>User ID</th><th>Role</th><th>Status</th><th>Access</th><th>Modules</th><th>Actions</th>
      </tr></thead><tbody id="usBody"></tbody></table></div><div id="usPager"></div></div>`;

    viewUserSettings.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#usQ').value || '').trim().toLowerCase();
        const role = $('#usRole').value, status = $('#usStatus').value;
        return Store.all('users').filter(u =>
          (!q || [u.name, u.username, u.email, u.empId].some(v => String(v || '').toLowerCase().includes(q)))
          && (!role || u.role === role)
          && (!status || (userActive(u) ? 'Active' : 'Inactive') === status))
          .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
            || String(a.name || '').localeCompare(String(b.name || '')));
      };
      const draw = () => {
        const rows = rowsFor();
        const all = Store.all('users');
        $('#usStats').innerHTML = `${statCard('👥', all.length, 'Logins')}
          ${statCard('✅', all.filter(userActive).length, 'Active', 'c2')}
          ${statCard('🚫', all.filter(u => !userActive(u)).length, 'Deactivated',
            all.some(u => !userActive(u)) ? 'c4' : 'c3')}
          ${statCard('🛡', allRoleKeys().length, 'Roles', 'c3')}`;
        page = Math.min(page, pageCount(rows.length));
        $('#usBody').innerHTML = rows.length ? pageSlice(rows, page).map(u => {
          const own = userPerms(u);
          const ceiling = roleCeiling(baseRoleOf(u.role));
          const isAdmin = u.role === 'admin';
          const active = userActive(u);
          return `<tr class="${active ? '' : 'row-off'}">
            <td><b>${esc(u.name || '—')}</b>${u.id === user.id
              ? ' <small style="color:var(--muted)">(you)</small>' : ''}
              ${u.email ? `<br><small style="color:var(--muted)">${esc(u.email)}</small>` : ''}</td>
            <td class="mono">${esc(u.username || '—')}</td>
            <td>${esc(roleLabel(u.role))}</td>
            <td><span class="pill ${active ? 'green' : 'red'}">${active ? 'Active' : 'Inactive'}</span></td>
            <td><span class="pill ${own ? 'amber' : 'blue'}">${own ? 'Custom' : 'Role Default'}</span></td>
            <td style="max-width:300px;white-space:normal;font-size:12.5px;color:var(--muted)">${
              isAdmin ? 'Everything — the administrator is never narrowed'
                      : esc(permSummary(own || rolePerms(u.role), ceiling))}</td>
            <td><div class="row-actions">
              <button class="btn-sm btn-outline" data-view="${u.id}">👁 Access</button>
              ${isAdmin ? '' : `<button class="btn-sm btn-edit" data-perm="${u.id}">Permissions</button>`}
              <button class="btn-sm btn-outline" data-edit="${u.id}">Edit</button>
              ${u.id === user.id ? '' : `<button class="btn-sm btn-outline" data-toggle="${u.id}">${
                active ? '🚫 Deactivate' : '✅ Activate'}</button>
              <button class="btn-sm btn-del" data-del="${u.id}">Delete</button>`}
            </div></td></tr>`;
        }).join('') : `<tr><td colspan="7" class="empty">No login accounts found.</td></tr>`;

        $('#usBody').querySelectorAll('[data-view]').forEach(b =>
          b.onclick = () => accessReportModal(b.dataset.view));
        $('#usBody').querySelectorAll('[data-perm]').forEach(b =>
          b.onclick = () => permissionsModal(b.dataset.perm, draw));
        $('#usBody').querySelectorAll('[data-edit]').forEach(b =>
          b.onclick = () => userForm(b.dataset.edit, draw));
        $('#usBody').querySelectorAll('[data-toggle]').forEach(b =>
          b.onclick = () => toggleUser(b.dataset.toggle, draw));
        $('#usBody').querySelectorAll('[data-del]').forEach(b =>
          b.onclick = () => delConfirm('users', b.dataset.del, 'login account', draw));
        $('#usPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#usPager'), rows.length, page, (p) => page = p, draw);
      };
      ['usQ', 'usRole', 'usStatus'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#usAdd').onclick = () => userForm(null, draw);
      $('#usRoles').onclick = () => navigate('roles');
      $('#usAudit').onclick = () => auditModal();
      draw();
    };
    return html;
  }

  /* An account switched off keeps everything it had — it simply cannot sign in.
     Deleting is the other button, and it says so. */
  function toggleUser(uid, after) {
    const u = Store.find('users', uid); if (!u) return;
    const active = userActive(u);
    const act = () => {
      Store.update('users', uid, { status: active ? 'Inactive' : 'Active' });
      toast(`${u.name || u.username} ${active ? 'deactivated' : 'activated'}.`, active ? 'err' : '');
      if (after) after();
    };
    if (!active) return act();
    confirmAction('Deactivate User',
      `Stop <b>${esc(u.name || u.username)}</b> from signing in? Their record and permissions are
       kept — switching them back on restores everything.`, 'Deactivate', act);
  }

  /* Create a login, or correct one. The role picker offers every role there is,
     built-in and custom, because that is the whole point of the roles page. */
  function userForm(uid, after) {
    const u = uid ? Store.find('users', uid) : null;
    const isSelf = u && u.id === user.id;
    const rec = u ? loginRecord(u) : null;
    openModal((uid ? 'Edit' : 'Create') + ' User', `<form id="f">
      <div class="form-grid">
        <div class="field"><label>Full Name</label>
          <input name="name" value="${esc(u ? (u.name || '') : '')}" required></div>
        ${fText('empId', 'Employee ID', u ? (u.empId || (rec && rec.empId) || '') : '')}
        <div class="field"><label>User ID</label>
          <input name="username" value="${esc(u ? (u.username || '') : '')}"
                 placeholder="what they sign in with" required></div>
        ${fText('email', 'Email', u ? (u.email || (rec && rec.email) || '') : '',
                'type="email" placeholder="name@example.com"')}
        ${fText('phone', 'Mobile', u ? (u.phone || (rec && rec.phone) || '') : '',
                'inputmode="numeric" maxlength="10"')}
        <div class="field"><label>Role</label>
          <select name="role" ${isSelf ? 'disabled' : ''}>${allRoleKeys().map(r =>
            `<option value="${esc(r)}" ${u && u.role === r ? 'selected' : ''}>${esc(roleLabel(r))}</option>`
          ).join('')}</select></div>
        <div class="field"><label>Status</label>
          <select name="status" ${isSelf ? 'disabled' : ''}>
            <option ${u && !userActive(u) ? '' : 'selected'}>Active</option>
            <option ${u && !userActive(u) ? 'selected' : ''}>Inactive</option></select></div>
        <div class="field"><label>Password</label>
          <input name="password" type="text" value=""
                 placeholder="${uid ? 'leave blank to keep current' : DEFAULT_PASSWORD}"></div>
      </div>
      ${isSelf ? `<p style="font-size:12.5px;color:var(--muted);margin:10px 0 0">
        This is the account you are signed in with, so its role and status are locked — nobody can
        lock themselves out or hand themselves a bigger role from here.</p>` : ''}
      <div class="form-actions">
        ${uid ? `<button type="button" class="btn-outline" id="uxReset">↺ Reset Password</button>` : ''}
        <button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    bindPhoneInput(document.querySelector('#modalBody [name="phone"]'));
    const reset = $('#uxReset');
    if (reset) reset.onclick = () => {
      confirmAction('Reset Password',
        `Set <b>${esc(u.name || u.username)}</b>'s password back to
         <b>${esc(DEFAULT_PASSWORD)}</b>? They can change it after signing in.`,
        'Reset Password', () => {
          Store.update('users', uid, { password: DEFAULT_PASSWORD });
          closeModal(); toast('Password reset.'); if (after) after();
        });
    };
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const username = (d.username || '').trim();
      if (!username) { toast('The account needs a user id.', 'err'); return; }
      const clash = Store.all('users').find(x =>
        (x.username || '').toLowerCase() === username.toLowerCase() && x.id !== uid);
      if (clash) { toast(`User id "${username}" is already taken.`, 'err'); return; }
      if (d.phone && !phoneValid(d.phone)) { toast('Mobile must be exactly 10 digits.', 'err'); return; }
      const patch = { name: (d.name || '').trim(), username, empId: d.empId || '',
                      email: d.email || '', phone: d.phone || '' };
      // the signed-in account cannot change its own role or switch itself off
      if (!isSelf) { patch.role = d.role; patch.status = d.status || 'Active'; }
      if (d.password) patch.password = d.password;
      if (uid) {
        Store.update('users', uid, patch);
        if (isSelf) { user.name = patch.name; paintUser(); }
      } else {
        Store.add('users', Object.assign({ password: d.password || DEFAULT_PASSWORD,
                                           access: 'full', permissions: {} }, patch));
      }
      closeModal(); toast('User saved.'); if (after) after(); else render();
    };
  }

  /* The override that wins over the role. "Role Default" clears it, which is
     how an account is put back on the template rather than pinned to a copy of
     whatever the template said the day it was pinned. */
  function permissionsModal(uid, after) {
    const u = Store.find('users', uid);
    if (!u) return;
    if (u.role === 'admin') {
      toast('The administrator is never narrowed.', 'err'); return;
    }
    const ceiling = roleCeiling(baseRoleOf(u.role));
    const fromRole = rolePerms(u.role) || ceiling;
    const own = userPerms(u);
    const current = own || fromRole;

    openModal('Permissions — ' + (u.name || u.username), `<form id="f">
      <p style="font-size:13px;color:var(--muted);margin:0 0 14px">
        <b>${esc(u.name || '—')}</b> · ${esc(roleLabel(u.role))} ·
        <span class="mono">${esc(u.username)}</span></p>
      <h4 class="ro-sub">Where this account's access comes from</h4>
      <div class="chk-grid">
        <label class="chk"><input type="radio" name="access" value="full" ${own ? '' : 'checked'}>
          <b>Role Default</b> — follows ${esc(roleLabel(u.role))}, and moves when that role does</label>
        <label class="chk"><input type="radio" name="access" value="restricted" ${own ? 'checked' : ''}>
          <b>Custom</b> — this account only, and it wins over the role</label>
      </div>
      <h4 class="ro-sub">Module Access</h4>
      ${permGridHtml(ceiling, current, {
        note: 'On <b>Role Default</b> the grid shows what the role gives and saving does not pin it.' })}
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save Permissions</button></div></form>`, true);

    const read = bindPermGrid(ceiling, current);
    const grid = $('#pgBody').closest('.pg-wrap');
    const syncMode = () => {
      const custom = document.querySelector('[name="access"][value="restricted"]').checked;
      grid.style.opacity = custom ? '1' : '.55';
      document.querySelectorAll('#pgBody input, .pg-tools button').forEach(el => { el.disabled = !custom; });
      $('#pgSearch').disabled = false;
    };
    document.querySelectorAll('[name="access"]').forEach(r => { r.onchange = syncMode; });
    syncMode();
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const custom = document.querySelector('[name="access"][value="restricted"]').checked;
      const before = userPerms(u);
      if (!custom) {
        Store.update('users', uid, { access: 'full', permissions: {} });
        auditPerms('user', u.username, u.name || u.username, before, fromRole);
        closeModal(); toast(`${u.name || u.username} follows ${roleLabel(u.role)}.`);
        if (after) after(); else render();
        return;
      }
      const perms = read();
      Store.update('users', uid, { access: 'restricted', permissions: perms });
      auditPerms('user', u.username, u.name || u.username, before || fromRole, perms);
      closeModal();
      toast(`${u.name || u.username}: ${plural(Object.keys(perms).length, 'module')}.`);
      if (after) after(); else render();
    };
  }

  /* Everything this account can actually do, worked out the same way the app
     works it out — so the answer on this screen is the answer in the app. */
  function accessReportModal(uid) {
    const u = Store.find('users', uid); if (!u) return;
    const perms = effectivePerms(u);
    const rows = MODULES.filter(([k]) => (perms[k] || []).length);
    const src = u.role === 'admin' ? 'Administrator — never narrowed'
      : userPerms(u) ? 'Custom permissions on this account (overrides the role)'
      : rolePerms(u.role) ? `The ${roleLabel(u.role)} role template`
      : `Everything the ${roleLabel(u.role)} role allows`;
    openModal('Access — ' + (u.name || u.username), `
      <p style="font-size:13px;color:var(--muted);margin:0 0 4px">
        <b>${esc(u.name || '—')}</b> · ${esc(roleLabel(u.role))} ·
        <span class="mono">${esc(u.username)}</span> ·
        <span class="pill ${userActive(u) ? 'green' : 'red'}">${userActive(u) ? 'Active' : 'Inactive'}</span></p>
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 14px">Source: ${esc(src)}</p>
      ${rows.length ? `<div class="tbl-wrap pg-wrap"><table class="pg-table"><thead><tr>
        <th class="pg-mod">Module</th>${ACTIONS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}
      </tr></thead><tbody>${rows.map(([k, label]) => `<tr>
        <td class="pg-mod">${esc(label)}</td>
        ${ACTIONS.map(([a]) => `<td>${perms[k].includes(a)
          ? '<span style="color:var(--green);font-weight:700">✓</span>'
          : '<span style="color:var(--border)">·</span>'}</td>`).join('')}
      </tr>`).join('')}</tbody></table></div>`
        : `<p class="empty" style="padding:18px 2px">No modules — this account opens the dashboard
           and its own pages only.</p>`}
      <div class="form-actions"><button type="button" class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
  }

  /* Who changed whose access, newest first. Read-only by design — the rows are
     never updated or deleted anywhere in the app. */
  function auditModal() {
    const rows = Store.all('auditlog').slice()
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, 200);
    const when = (iso) => { try { return new Date(iso).toLocaleString('en-IN'); } catch (e) { return iso; } };
    openModal('Permission Audit Log', `
      <p style="font-size:12.5px;color:var(--muted);margin:0 0 12px">
        Every permission change, newest first. ${rows.length >= 200 ? 'Showing the latest 200.' : ''}</p>
      ${rows.length ? `<div class="tbl-wrap"><table><thead><tr>
        <th>When</th><th>Who</th><th>Changed</th><th>What moved</th>
      </tr></thead><tbody>${rows.map(r => `<tr>
        <td style="white-space:nowrap">${esc(when(r.at))}</td>
        <td>${esc(r.actorName || '—')}</td>
        <td>${esc(r.subjectName || r.subjectKey || '—')}
          <br><small style="color:var(--muted)">${esc(r.subjectType === 'role' ? 'role' : 'user')}</small></td>
        <td style="white-space:normal;font-size:12.5px">${(Array.isArray(r.changes) ? r.changes : [])
          .map(c => `<div><b>${esc(c.label)}</b> ${
            (c.on || []).map(a => `<span style="color:var(--green)">${esc(a)} ON</span>`)
              .concat((c.off || []).map(a => `<span style="color:var(--red)">${esc(a)} OFF</span>`))
              .join(', ')}</div>`).join('') || esc(r.summary || '—')}</td>
      </tr>`).join('')}</tbody></table></div>`
        : `<p class="empty" style="padding:18px 2px">Nothing has been changed yet.</p>`}
      <div class="form-actions"><button type="button" class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
  }

  /* =========================== COMPANIES =========================== */
  function viewCompanies() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Companies</h3>
      <div class="panel-tools">${exportButtons('co')}
        <button class="btn-primary" id="coAdd">+ Add Company</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="coQ" placeholder="Search company / industry / HR...">
        <select class="filter-sel" id="coIndustry"><option value="">All Industries</option></select>
        <button class="btn-outline btn-sm" id="coClear">Clear</button>
      </div>
      <div id="coStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ID</th><th>Company</th><th>Industry</th><th>Recruits For</th><th>Location</th><th>HR Contact</th>
        <th style="text-align:right">Drives</th><th style="text-align:right">Placed</th><th>Actions</th>
      </tr></thead><tbody id="coBody"></tbody></table></div><div id="coPager"></div></div>`;

    viewCompanies.after = () => {
      let page = 1;
      const industries = [...new Set(Store.all('companies').map(c => c.industry).filter(Boolean))].sort();
      $('#coIndustry').innerHTML = `<option value="">All Industries</option>` +
        industries.map(i => `<option>${esc(i)}</option>`).join('');
      const rowsFor = () => {
        const q = ($('#coQ').value || '').trim().toLowerCase();
        const ind = $('#coIndustry').value;
        return Store.all('companies').map(c => {
          const drives = Store.all('drives').filter(d => d.companyId === c.id);
          const placed = Store.all('offers').filter(o =>
            o.companyId === c.id && PLACED_OFFER_STATUS.includes(o.status)).length;
          return Object.assign({}, c, { driveCount: drives.length, placed,
            hr: [c.hrName, c.hrEmail, c.hrPhone].filter(Boolean).join(' · ') || '—' });
        }).filter(c =>
          (!q || [c.id, c.name, c.industry, c.location, c.hrName, c.hrEmail].some(v =>
            String(v || '').toLowerCase().includes(q))) &&
          (!ind || c.industry === ind))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        $('#coStats').innerHTML = `${statCard('🏢', rows.length, 'Companies')}
          ${statCard('🚀', rows.reduce((a, c) => a + c.driveCount, 0), 'Drives Conducted', 'c2')}
          ${statCard('🏆', rows.reduce((a, c) => a + c.placed, 0), 'Students Placed', 'c3')}`;
        $('#coBody').innerHTML = rows.length ? pageSlice(rows, page).map(c => `<tr>
          <td class="mono">${esc(c.id)}</td>
          <td><strong>${esc(c.name)}</strong>${c.website ? `<br><small style="color:var(--muted)">${esc(c.website)}</small>` : ''}</td>
          <td>${esc(c.industry || '—')}</td>
          <td>${esc(c.engagementType || 'Final Placement')}</td>
          <td>${esc(c.location || '—')}</td>
          <td><small>${esc(c.hr)}</small></td>
          <td style="text-align:right">${c.driveCount}</td>
          <td style="text-align:right">${c.placed}</td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${c.id}">👁 View</button>
            <button class="btn-sm btn-edit" data-edit="${c.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${c.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="8" class="empty">No companies match these filters.</td></tr>`;
        $('#coBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => companyViewModal(b.dataset.view));
        $('#coBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => companyForm(b.dataset.edit, draw));
        $('#coBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const c = Store.find('companies', b.dataset.del) || {};
          const drives = Store.all('drives').filter(d => d.companyId === c.id).length;
          if (drives) {
            toast(`${c.name} has ${drives} drive(s) — delete or reassign those first.`, 'err');
            return;
          }
          confirmDelete('Delete Company', `Remove <b>${esc(c.name)}</b> from the company list?`,
            'Delete', () => { Store.remove('companies', c.id); toast('Company deleted.', 'err'); draw(); });
        });
        $('#coPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#coPager'), rows.length, page, (p) => page = p, draw);
      };
      ['coQ', 'coIndustry'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#coClear').onclick = () => { $('#coQ').value = ''; $('#coIndustry').value = ''; page = 1; draw(); };
      $('#coAdd').onclick = () => companyForm(null, draw);
      bindExports('co', () => {
        const rows = rowsFor();
        return {
          title: 'Company Report', sheetName: 'Companies', subtitle: placementStamp(),
          columns: [
            { header: 'ID', key: 'id', width: 10 }, { header: 'Company', key: 'name', width: 28 },
            { header: 'Industry', key: 'industry', width: 22 }, { header: 'Location', key: 'location', width: 16 },
            { header: 'HR Name', key: 'hrName', width: 20 }, { header: 'HR Email', key: 'hrEmail', width: 26 },
            { header: 'HR Phone', key: 'hrPhone', width: 14 },
            { header: 'College Coordinator', key: 'coordinatorName', width: 22 },
            { header: 'Coordinator Mobile', key: 'coordinatorPhone', width: 16 },
            { header: 'Drives', key: 'driveCount', width: 10, type: 'number' },
            { header: 'Students Placed', key: 'placed', width: 15, type: 'number' },
          ],
          rows,
          totals: { id: 'TOTAL', name: rows.length + ' companies',
                    driveCount: rows.reduce((a, c) => a + c.driveCount, 0),
                    placed: rows.reduce((a, c) => a + c.placed, 0) },
        };
      });
      draw();
    };
    return html;
  }

  function companyForm(id, after) {
    const c = id ? (Store.find('companies', id) || {}) : {};
    openModal((id ? 'Edit' : 'Add') + ' Company', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Company Name</label><input name="name" value="${esc(c.name || '')}" required></div>
        <div class="field"><label>Industry</label><input name="industry" placeholder="e.g. IT Services" value="${esc(c.industry || '')}"></div>
        <div class="field"><label>Recruits For</label>
          <select name="engagementType">${optionsFrom(ENGAGEMENT_TYPES, c.engagementType || ENGAGEMENT_TYPES[0])}</select></div>
        <div class="field"><label>Location</label><input name="location" list="coLocList" value="${esc(c.location || '')}">
          <datalist id="coLocList">${JOB_LOCATIONS.map(l => `<option>${esc(l)}</option>`).join('')}</datalist></div>
        <div class="field full"><label>Website</label><input name="website" type="url" placeholder="https://example.com" value="${esc(c.website || '')}"></div>
        <div class="field"><label>HR Name</label><input name="hrName" value="${esc(c.hrName || '')}"></div>
        <div class="field"><label>HR Email</label><input name="hrEmail" type="email" value="${esc(c.hrEmail || '')}"></div>
        <div class="field"><label>HR Phone</label><input name="hrPhone" id="coPhone" inputmode="numeric" placeholder="10-digit number" value="${esc(c.hrPhone || '')}"></div>
        <div class="field"><label>College Coordinator</label>
          <input name="coordinatorName" placeholder="who handles this company for us" value="${esc(c.coordinatorName || '')}"></div>
        <div class="field"><label>Coordinator Mobile</label>
          <input name="coordinatorPhone" id="coCoordPhone" inputmode="numeric" placeholder="10-digit number" value="${esc(c.coordinatorPhone || '')}"></div>
        <div class="field full"><label>About</label><textarea name="description" rows="3">${esc(c.description || '')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    bindPhoneInput($('#coPhone'));
    bindPhoneInput($('#coCoordPhone'));
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (!d.name) { toast('Company name is required.', 'err'); return; }
      if (!phoneValid(d.hrPhone)) { toast('HR phone must be exactly 10 digits.', 'err'); return; }
      if (!phoneValid(d.coordinatorPhone)) {
        toast('Coordinator mobile must be exactly 10 digits.', 'err'); return;
      }
      // one HR number belongs to one company — a repeat almost always means
      // the same company entered twice under a slightly different name
      const phoneClash = Store.all('companies').find(x =>
        x.id !== id && String(x.hrPhone || '') === String(d.hrPhone || '') && d.hrPhone);
      if (phoneClash) {
        toast(`That HR number is already saved against ${phoneClash.name}.`, 'err');
        return;
      }
      if (id) Store.update('companies', id, d); else Store.add('companies', d);
      closeModal(); toast('Company saved.'); after ? after() : render();
    };
  }

  function companyViewModal(id) {
    const c = Store.find('companies', id);
    if (!c) return;
    const drives = Store.all('drives').filter(d => d.companyId === id);
    const offers = Store.all('offers').filter(o => o.companyId === id);
    const placed = offers.filter(o => PLACED_OFFER_STATUS.includes(o.status));
    const row = (k, v) => `<tr><td style="font-weight:600;width:170px">${esc(k)}</td><td>${esc(v || '—')}</td></tr>`;
    openModal('Company — ' + c.name, `
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('🚀', drives.length, 'Drives')}
        ${statCard('📜', offers.length, 'Offers Issued', 'c2')}
        ${statCard('🏆', placed.length, 'Students Placed', 'c3')}
        ${statCard('💰', money(placed.length ? Math.round(placed.reduce((a, o) => a + (+o.package || 0), 0) / placed.length) : 0), 'Average Package', 'c2')}
      </div>
      <h4 class="ro-sub">Company Details</h4>
      <div class="tbl-wrap"><table><tbody>
        ${row('Company ID', c.id)}${row('Industry', c.industry)}${row('Location', c.location)}
        ${row('Website', c.website)}${row('HR Name', c.hrName)}${row('HR Email', c.hrEmail)}
        ${row('HR Phone', c.hrPhone)}
        ${row('College Coordinator', c.coordinatorName)}
        ${row('Coordinator Mobile', c.coordinatorPhone)}
        ${row('About', c.description)}
      </tbody></table></div>
      <h4 class="ro-sub">Drives by this Company</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Role</th><th style="text-align:right">Package</th>
        <th>Drive Date</th><th style="text-align:right">Openings</th><th>Status</th>
      </tr></thead><tbody>${drives.length ? drives.map(d => `<tr>
        <td>${esc(d.jobRole || '—')}</td><td style="text-align:right">${money(d.package)}</td>
        <td>${esc(d.driveDate || '—')}</td><td style="text-align:right">${d.openings || '—'}</td>
        <td><span class="pill ${DRIVE_PILL[d.status] || 'blue'}">${esc(d.status || 'Draft')}</span></td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">No drives yet.</td></tr>`}
      </tbody></table></div>
      <div class="form-actions"><button class="btn-primary" id="cx">Close</button></div>`, true);
    $('#cx').onclick = closeModal;
  }

  /* =========================== DRIVES =========================== */
  function viewDrives() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Placement Drives</h3>
      <div class="panel-tools">${exportButtons('dr')}
        <button class="btn-primary" id="drAdd">+ Create Drive</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="drQ" placeholder="Search role / company...">
        <select class="filter-sel" id="drCompany"><option value="">All Companies</option>${companyOptions()}</select>
        <select class="filter-sel" id="drType"><option value="">All Types</option>${
          DRIVE_TYPES.map(t => `<option ${t === viewPreset ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select class="filter-sel" id="drStatus"><option value="">All Statuses</option>${optionsFrom(DRIVE_STATUS)}</select>
        <label class="days-field">From <input class="filter-sel" id="drFrom" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="drTo" type="date"></label>
        <button class="btn-outline btn-sm" id="drClear">Clear</button>
      </div>
      <div id="drStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ID</th><th>Company</th><th>Role</th><th>Type</th><th style="text-align:right">Package</th>
        <th>Eligibility</th><th>Drive Date</th><th style="text-align:right">Eligible</th>
        <th style="text-align:right">Applied</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="drBody"></tbody></table></div><div id="drPager"></div></div>`;

    viewDrives.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#drQ').value || '').trim().toLowerCase();
        const co = $('#drCompany').value, st = $('#drStatus').value, ty = $('#drType').value;
        const from = $('#drFrom').value, to = $('#drTo').value;
        return Store.all('drives').map(d => {
          const eligible = eligibleStudentsFor(d).length;
          const applied = Store.all('applications').filter(a => a.driveId === d.id);
          return Object.assign({}, d, {
            company: companyName(d.companyId), eligible,
            applied: applied.length,
            selected: applied.filter(a => a.status === 'Selected').length,
            criteria: [
              d.minCgpa ? `CGPA ≥ ${d.minCgpa}` : null,
              (d.maxBacklogs !== '' && d.maxBacklogs !== null && d.maxBacklogs !== undefined)
                ? `≤ ${d.maxBacklogs} backlog(s)` : null,
              csvList(d.eligibleBranches).join('/') || null,
            ].filter(Boolean).join(' · ') || 'Open to all',
          });
        }).filter(d =>
          (!q || [d.id, d.jobRole, d.company, d.location].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!co || d.companyId === co) && (!st || (d.status || 'Draft') === st) &&
          (!ty || (d.driveType || 'On Campus') === ty) &&
          (!from || (d.driveDate && d.driveDate >= from)) &&
          (!to || (d.driveDate && d.driveDate <= to)))
          .sort((a, b) => String(b.driveDate || '').localeCompare(String(a.driveDate || '')));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        $('#drStats').innerHTML = `${statCard('🚀', rows.length, 'Drives Listed')}
          ${statCard('✅', rows.filter(d => OPEN_DRIVE_STATUS.includes(d.status || 'Draft')).length, 'Active', 'c3')}
          ${statCard('📨', rows.reduce((a, d) => a + d.applied, 0), 'Applications', 'c2')}
          ${statCard('🎯', rows.reduce((a, d) => a + d.selected, 0), 'Selections', 'c3')}`;
        $('#drBody').innerHTML = rows.length ? pageSlice(rows, page).map(d => `<tr>
          <td class="mono">${esc(d.id)}</td><td>${esc(d.company)}</td>
          <td><strong>${esc(d.jobRole || '—')}</strong>${d.location ? `<br><small style="color:var(--muted)">${esc(d.location)}</small>` : ''}</td>
          <td>${esc(d.driveType || 'On Campus')}</td>
          <td style="text-align:right">${money(d.package)}</td>
          <td><small>${esc(d.criteria)}</small></td>
          <td>${esc(d.driveDate || '—')}</td>
          <td style="text-align:right">${d.eligible}</td>
          <td style="text-align:right">${d.applied}</td>
          <td><span class="pill ${DRIVE_PILL[d.status] || 'blue'}">${esc(d.status || 'Draft')}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${d.id}">👁 View</button>
            <button class="btn-sm btn-edit" data-edit="${d.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${d.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="10" class="empty">No drives match these filters.</td></tr>`;
        $('#drBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => driveViewModal(b.dataset.view));
        $('#drBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => driveForm(b.dataset.edit, draw));
        $('#drBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const d = Store.find('drives', b.dataset.del) || {};
          const apps = Store.all('applications').filter(a => a.driveId === d.id).length;
          confirmDelete('Delete Drive', `Delete the <b>${esc(d.jobRole || d.id)}</b> drive by
            <b>${esc(companyName(d.companyId))}</b>?${apps ? ` Its ${apps} application(s) will also be removed.` : ''}`,
            'Delete Drive', () => {
              Store.all('applications').filter(a => a.driveId === d.id).forEach(a => Store.remove('applications', a.id));
              Store.all('interviews').filter(i => i.driveId === d.id).forEach(i => Store.remove('interviews', i.id));
              Store.remove('drives', d.id);
              toast('Drive deleted.', 'err'); draw();
            });
        });
        $('#drPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#drPager'), rows.length, page, (p) => page = p, draw);
      };
      ['drQ', 'drCompany', 'drType', 'drStatus', 'drFrom', 'drTo'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#drClear').onclick = () => {
        ['drQ', 'drCompany', 'drType', 'drStatus', 'drFrom', 'drTo'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      $('#drAdd').onclick = () => driveForm(null, draw);
      bindExports('dr', () => {
        const rows = rowsFor();
        return {
          title: 'Placement Drive Report', sheetName: 'Drives', subtitle: placementStamp(),
          columns: [
            { header: 'Drive ID', key: 'id', width: 10 }, { header: 'Company', key: 'company', width: 24 },
            { header: 'Job Role', key: 'jobRole', width: 24 },
            { header: 'Package', key: 'package', width: 14, money: true },
            { header: 'Location', key: 'location', width: 16 },
            { header: 'Openings', key: 'openings', width: 10, type: 'number' },
            { header: 'Eligibility', key: 'criteria', width: 30 },
            { header: 'Drive Date', key: 'driveDate', width: 13 },
            { header: 'Eligible', key: 'eligible', width: 10, type: 'number' },
            { header: 'Applied', key: 'applied', width: 10, type: 'number' },
            { header: 'Selected', key: 'selected', width: 10, type: 'number' },
            { header: 'Status', key: 'status', width: 12 },
          ],
          rows,
          totals: { id: 'TOTAL', company: rows.length + ' drives',
                    applied: rows.reduce((a, d) => a + d.applied, 0),
                    selected: rows.reduce((a, d) => a + d.selected, 0) },
        };
      });
      draw();
    };
    return html;
  }

  function driveForm(id, after) {
    const d = id ? (Store.find('drives', id) || {}) : {};
    if (!Store.all('companies').length) {
      toast('Add a company first — a drive belongs to one.', 'err');
      navigate('companies');
      return;
    }
    const selBranches = csvList(d.eligibleBranches);
    const selCourses = csvList(d.eligibleCourses);
    openModal((id ? 'Edit' : 'Create') + ' Placement Drive', `<form id="f">
      <div class="form-grid">
        <div class="field"><label>Company</label><select name="companyId" required>${companyOptions(d.companyId)}</select></div>
        <div class="field"><label>Job Role</label><input name="jobRole" placeholder="e.g. Systems Engineer" value="${esc(d.jobRole || '')}" required></div>
        <div class="field"><label>Drive Type</label>
          <select name="driveType">${optionsFrom(DRIVE_TYPES, d.driveType || DRIVE_TYPES[0])}</select></div>
        <div class="field"><label>Package (₹ per annum)</label><input name="package" id="drPkg" inputmode="numeric" value="${esc(d.package || '')}"></div>
        <div class="field"><label>Job Location</label><input name="location" list="drLocList" value="${esc(d.location || '')}">
          <datalist id="drLocList">${JOB_LOCATIONS.map(l => `<option>${esc(l)}</option>`).join('')}</datalist></div>
        <div class="field"><label>Openings</label><input name="openings" type="number" min="1" value="${esc(d.openings || '')}"></div>
        <div class="field"><label>Status</label><select name="status">${optionsFrom(DRIVE_STATUS, d.status || 'Draft')}</select></div>
        <div class="field full"><label>Job Description</label><textarea name="jobDescription" rows="3">${esc(d.jobDescription || '')}</textarea></div>
      </div>
      <h4 style="font-size:13px;color:var(--primary-dark);margin:18px 0 8px">ELIGIBILITY CRITERIA</h4>
      <div class="form-grid">
        <div class="field"><label>Minimum CGPA</label><input name="minCgpa" type="number" step="0.1" min="0" max="10" value="${esc(d.minCgpa || '')}"></div>
        <div class="field"><label>Maximum Backlogs</label><input name="maxBacklogs" type="number" min="0" value="${esc(d.maxBacklogs === '' || d.maxBacklogs === null || d.maxBacklogs === undefined ? '' : d.maxBacklogs)}"></div>
        <div class="field full"><label>Eligible Specialisations <small style="color:var(--muted);font-weight:400">(none ticked = open to all)</small></label>
          <div class="chk-grid">${specialisationList().map(b => `<label class="chk">
            <input type="checkbox" name="branch_${b}" ${selBranches.includes(b) ? 'checked' : ''}> ${esc(b)}</label>`).join('')}</div></div>
        <div class="field full"><label>Eligible Courses <small style="color:var(--muted);font-weight:400">(none ticked = open to all)</small></label>
          <div class="chk-grid">${courseList().map(c => `<label class="chk">
            <input type="checkbox" name="course_${c}" ${selCourses.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div></div>
      </div>
      <h4 style="font-size:13px;color:var(--primary-dark);margin:18px 0 8px">SCHEDULE</h4>
      <div class="form-grid">
        <div class="field"><label>Applications Open</label><input name="appStartDate" type="date" value="${esc(d.appStartDate || '')}"></div>
        <div class="field"><label>Applications Close</label><input name="appEndDate" type="date" value="${esc(d.appEndDate || '')}"></div>
        <div class="field"><label>Drive Date</label><input name="driveDate" type="date" value="${esc(d.driveDate || '')}"></div>
        <div class="field"><label>Interview Date</label><input name="interviewDate" type="date" value="${esc(d.interviewDate || '')}"></div>
        <div class="field full"><label>Selection Process</label><input name="selectionProcess" placeholder="e.g. Online Test -> Technical -> HR" value="${esc(d.selectionProcess || '')}"></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save Drive</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    bindAmountInput($('#drPkg'));
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const raw = formData(e.target);
      const branches = refreshBranches().filter(b => raw['branch_' + b]);
      const courses = courseList().filter(c => raw['course_' + c]);
      const rec = {
        companyId: raw.companyId, jobRole: raw.jobRole, jobDescription: raw.jobDescription,
        package: raw.package === '' ? '' : (parseAmount(raw.package, { min: 0 }) ?? ''),
        location: raw.location, openings: raw.openings,
        eligibleCourses: courses.join(','), eligibleBranches: branches.join(','),
        minCgpa: raw.minCgpa, maxBacklogs: raw.maxBacklogs,
        driveDate: raw.driveDate, appStartDate: raw.appStartDate, appEndDate: raw.appEndDate,
        interviewDate: raw.interviewDate, selectionProcess: raw.selectionProcess,
        status: raw.status,
      };
      if (raw.appStartDate && raw.appEndDate && raw.appEndDate < raw.appStartDate) {
        toast('Applications cannot close before they open.', 'err'); return;
      }
      // publishing stamps the date once, so a re-edit does not move it
      const wasPublished = d.status && d.status !== 'Draft';
      rec.publishedOn = rec.status === 'Draft' ? null : (wasPublished ? d.publishedOn : today());
      if (id) Store.update('drives', id, rec); else Store.add('drives', rec);
      closeModal(); toast('Drive saved.'); after ? after() : render();
    };
  }

  function driveViewModal(id) {
    const d = Store.find('drives', id);
    if (!d) return;
    const apps = Store.all('applications').filter(a => a.driveId === id);
    const eligible = eligibleStudentsFor(d);
    const row = (k, v) => `<tr><td style="font-weight:600;width:180px">${esc(k)}</td><td>${esc(v || '—')}</td></tr>`;
    const notApplied = eligible.filter(s => !apps.some(a => a.studentId === s.id));
    openModal('Drive — ' + (d.jobRole || d.id), `
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
        ${esc(companyName(d.companyId))} · ${esc(d.location || '—')} ·
        <span class="pill ${DRIVE_PILL[d.status] || 'blue'}">${esc(d.status || 'Draft')}</span></p>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('💰', money(d.package), 'Package')}
        ${statCard('✅', eligible.length, 'Eligible Students', 'c3')}
        ${statCard('📨', apps.length, 'Applications', 'c2')}
        ${statCard('🎯', apps.filter(a => a.status === 'Selected').length, 'Selected', 'c3')}
      </div>
      <h4 class="ro-sub">Drive Details</h4>
      <div class="tbl-wrap"><table><tbody>
        ${row('Drive ID', d.id)}${row('Company', companyName(d.companyId))}
        ${row('Job Role', d.jobRole)}${row('Openings', d.openings)}
        ${row('Job Description', d.jobDescription)}
        ${row('Selection Process', d.selectionProcess)}
        ${row('Applications Open', d.appStartDate)}${row('Applications Close', d.appEndDate)}
        ${row('Drive Date', d.driveDate)}${row('Interview Date', d.interviewDate)}
        ${row('Published On', d.publishedOn)}
      </tbody></table></div>
      <h4 class="ro-sub">Eligibility Criteria</h4>
      <div class="tbl-wrap"><table><tbody>
        ${row('Minimum CGPA', d.minCgpa || 'No minimum')}
        ${row('Maximum Backlogs', (d.maxBacklogs === '' || d.maxBacklogs === null || d.maxBacklogs === undefined) ? 'No limit' : d.maxBacklogs)}
        ${row('Eligible Specialisations', csvList(d.eligibleBranches).join(', ') || 'All specialisations')}
        ${row('Eligible Courses', csvList(d.eligibleCourses).join(', ') || 'All courses')}
      </tbody></table></div>
      <h4 class="ro-sub">Eligible Students Who Have Not Applied (${notApplied.length})</h4>
      <div class="tbl-wrap"><table><thead><tr><th>Reg No</th><th>Name</th><th>Specialisation</th>
        <th style="text-align:right">CGPA</th><th style="text-align:right">Backlogs</th>
      </tr></thead><tbody>${notApplied.length ? notApplied.slice(0, 25).map(s => `<tr>
        <td class="mono">${esc(s.roll)}</td><td>${esc(s.name)}</td><td>${esc(s.branch || '—')}</td>
        <td style="text-align:right">${studentCgpa(s) ?? '—'}</td>
        <td style="text-align:right">${+s.backlogs || 0}</td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">Every eligible student has applied.</td></tr>`}
      </tbody></table></div>
      <div class="form-actions"><button class="btn-outline" id="cx">Close</button>
        <button class="btn-primary" id="goApps">📨 Manage Applications</button></div>`, true);
    $('#cx').onclick = closeModal;
    $('#goApps').onclick = () => { closeModal(); appDriveFilter = id; navigate('applications'); };
  }

  /* =========================== APPLICATIONS =========================== */
  let appDriveFilter = '';   // set when arriving from a drive

  function viewApplications() {
    const guard = placementGuard(); if (guard) return guard;
    const preset = appDriveFilter; appDriveFilter = '';
    const html = `<div class="panel"><div class="panel-head"><h3>Student Applications</h3>
      <div class="panel-tools">${exportButtons('ap')}
        <button class="btn-primary" id="apAdd">+ Add Application</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="apQ" placeholder="Search student / reg no / role...">
        <select class="filter-sel" id="apDrive"><option value="">All Drives</option>${driveOptions(preset)}</select>
        <select class="filter-sel" id="apStatus"><option value="">All Statuses</option>${optionsFrom(APP_STATUS)}</select>
        <select class="filter-sel" id="apBranch"><option value="">All Specialisations</option>${specialisationOptions()}</select>
        <button class="btn-outline btn-sm" id="apClear">Clear</button>
      </div>
      <div id="apStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ID</th><th>Student</th><th>Reg No</th><th>Specialisation</th><th>Drive</th>
        <th>Applied On</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="apBody"></tbody></table></div><div id="apPager"></div></div>`;

    viewApplications.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#apQ').value || '').trim().toLowerCase();
        const dr = $('#apDrive').value, st = $('#apStatus').value, br = $('#apBranch').value;
        return Store.all('applications').map(a => {
          const s = Store.find('students', a.studentId) || {};
          const d = Store.find('drives', a.driveId) || {};
          return Object.assign({}, a, {
            name: s.name || 'Unknown student', roll: s.roll || '—', branch: specOf(s) || '—',
            cgpa: s.id ? (studentCgpa(s) ?? '—') : '—',
            drive: driveLabel(a.driveId), jobRole: d.jobRole || '—', company: companyName(d.companyId),
            package: +d.package || 0,
          });
        }).filter(a =>
          (!q || [a.id, a.name, a.roll, a.jobRole, a.company].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!dr || a.driveId === dr) && (!st || (a.status || 'Applied') === st) && (!br || a.branch === br))
          .sort((a, b) => String(b.appliedOn || '').localeCompare(String(a.appliedOn || '')));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        const c = (s) => rows.filter(r => (r.status || 'Applied') === s).length;
        $('#apStats').innerHTML = `${statCard('📨', rows.length, 'Applications')}
          ${statCard('⭐', c('Shortlisted'), 'Shortlisted', 'c2')}
          ${statCard('🎯', c('Selected'), 'Selected', 'c3')}
          ${statCard('❌', c('Rejected'), 'Rejected', c('Rejected') ? 'c4' : 'c3')}`;
        $('#apBody').innerHTML = rows.length ? pageSlice(rows, page).map(a => `<tr>
          <td class="mono">${esc(a.id)}</td><td>${esc(a.name)}</td><td class="mono">${esc(a.roll)}</td>
          <td>${esc(a.branch)}</td>
          <td>${esc(a.jobRole)}<br><small style="color:var(--muted)">${esc(a.company)}</small></td>
          <td>${esc(a.appliedOn || '—')}</td>
          <td><span class="pill ${APP_PILL[a.status] || 'blue'}">${esc(a.status || 'Applied')}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-edit" data-status="${a.id}">Status</button>
            ${a.status === 'Selected' && !Store.all('offers').some(o => o.studentId === a.studentId && o.driveId === a.driveId)
              ? `<button class="btn-sm btn-primary" data-offer="${a.id}" title="Create the offer">📜 Offer</button>` : ''}
            <button class="btn-sm btn-outline" data-edit="${a.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${a.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="8" class="empty">No applications match these filters.</td></tr>`;
        $('#apBody').querySelectorAll('[data-status]').forEach(b =>
          b.onclick = () => applicationStatusForm(b.dataset.status, draw));
        $('#apBody').querySelectorAll('[data-offer]').forEach(b => b.onclick = () => {
          const a = Store.find('applications', b.dataset.offer);
          offerForm(null, draw, { studentId: a.studentId, driveId: a.driveId });
        });
        $('#apBody').querySelectorAll('[data-edit]').forEach(b =>
          b.onclick = () => applicationForm(b.dataset.edit, draw));
        $('#apBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const a = Store.find('applications', b.dataset.del) || {};
          const s = Store.find('students', a.studentId) || {};
          confirmDelete('Delete Application', `Remove <b>${esc(s.name || '—')}</b>'s application for
            <b>${esc(driveLabel(a.driveId))}</b>?`, 'Delete',
            () => {
              Store.all('interviews').filter(i => i.applicationId === a.id).forEach(i => Store.remove('interviews', i.id));
              Store.remove('applications', a.id); toast('Application deleted.', 'err'); draw();
            });
        });
        $('#apPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#apPager'), rows.length, page, (p) => page = p, draw);
      };
      ['apQ', 'apDrive', 'apStatus', 'apBranch'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#apClear').onclick = () => {
        ['apQ', 'apDrive', 'apStatus', 'apBranch'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      $('#apAdd').onclick = () => applicationForm(null, draw);
      bindExports('ap', () => {
        const rows = rowsFor();
        return {
          title: 'Application Report', sheetName: 'Applications', subtitle: placementStamp(),
          columns: [
            { header: 'Application ID', key: 'id', width: 14 },
            { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
            { header: 'Specialisation', key: 'branch', width: 10 }, { header: 'CGPA', key: 'cgpa', width: 9 },
            { header: 'Company', key: 'company', width: 24 }, { header: 'Job Role', key: 'jobRole', width: 24 },
            { header: 'Package', key: 'package', width: 14, money: true },
            { header: 'Applied On', key: 'appliedOn', width: 13 },
            { header: 'Shortlisted On', key: 'shortlistedOn', width: 15 },
            { header: 'Status', key: 'status', width: 13 },
            { header: 'Remarks', key: 'remarks', width: 34 },
          ],
          rows,
          totals: { id: 'TOTAL', roll: rows.length + ' applications' },
        };
      });
      draw();
    };
    return html;
  }

  function applicationForm(id, after) {
    const a = id ? (Store.find('applications', id) || {}) : {};
    const drives = Store.all('drives');
    if (!drives.length) { toast('Create a drive first.', 'err'); navigate('drives'); return; }
    openModal((id ? 'Edit' : 'Add') + ' Application', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Drive</label>
          <select name="driveId" id="apfDrive" required>${driveOptions(a.driveId)}</select></div>
        <div class="field full"><label>Student</label>
          <select name="studentId" id="apfStudent" required></select>
          <small id="apfNote" style="color:var(--muted);font-size:12px"></small></div>
        <div class="field"><label>Applied On</label><input name="appliedOn" type="date" value="${esc(a.appliedOn || today())}"></div>
        <div class="field"><label>Status</label><select name="status">${optionsFrom(APP_STATUS, a.status || 'Applied')}</select></div>
        <div class="field full"><label>Remarks</label><textarea name="remarks" rows="2">${esc(a.remarks || '')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);
    $('#cx').onclick = closeModal;

    // the student list follows the selected drive: eligible students first, and
    // anyone who does not meet the criteria is labelled rather than hidden
    const fillStudents = () => {
      const d = Store.find('drives', $('#apfDrive').value);
      const all = Store.all('students').slice().sort((x, y) => String(x.roll).localeCompare(String(y.roll)));
      const taken = Store.all('applications').filter(x => x.driveId === (d || {}).id && x.id !== id)
        .map(x => x.studentId);
      const opts = all.filter(s => !taken.includes(s.id)).map(s => {
        const el = d ? driveEligibility(s, d) : { ok: true };
        return `<option value="${s.id}" ${s.id === a.studentId ? 'selected' : ''}>
          ${esc(s.roll)} — ${esc(s.name)}${el.ok ? '' : '  ⚠ not eligible'}</option>`;
      }).join('');
      $('#apfStudent').innerHTML = opts || `<option value="">No student left to add</option>`;
      const note = () => {
        const s = Store.find('students', $('#apfStudent').value);
        if (!s || !d) { $('#apfNote').textContent = ''; return; }
        const el = driveEligibility(s, d);
        $('#apfNote').textContent = el.ok
          ? '✓ Meets the eligibility criteria.'
          : '⚠ Does not meet: ' + el.reasons.join(', ');
        $('#apfNote').style.color = el.ok ? 'var(--green)' : 'var(--red)';
      };
      $('#apfStudent').onchange = note;
      note();
    };
    $('#apfDrive').onchange = fillStudents;
    fillStudents();

    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (!d.studentId) { toast('Please pick a student.', 'err'); return; }
      const clash = Store.all('applications').find(x =>
        x.studentId === d.studentId && x.driveId === d.driveId && x.id !== id);
      if (clash) { toast('That student has already applied to this drive.', 'err'); return; }
      d.updatedBy = user.id; d.updatedOn = today();
      if (d.status === 'Shortlisted' && !a.shortlistedOn) d.shortlistedOn = today();
      if (id) Store.update('applications', id, d); else Store.add('applications', d);
      closeModal(); toast('Application saved.'); after ? after() : render();
    };
  }

  /** the quick status change used from the list — shortlist, reject, select */
  function applicationStatusForm(id, after) {
    const a = Store.find('applications', id);
    if (!a) return;
    const s = Store.find('students', a.studentId) || {};
    openModal('Application Status — ' + (s.name || a.id), `<form id="f">
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
        ${esc(s.roll || '—')} · ${esc(driveLabel(a.driveId))}</p>
      <div class="form-grid">
        <div class="field full"><label>Status</label>
          <select name="status">${optionsFrom(APP_STATUS, a.status || 'Applied')}</select></div>
        <div class="field full"><label>Remarks</label>
          <textarea name="remarks" rows="3">${esc(a.remarks || '')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Update Status</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const patch = { status: d.status, remarks: d.remarks, updatedBy: user.id, updatedOn: today() };
      if (d.status === 'Shortlisted' && !a.shortlistedOn) patch.shortlistedOn = today();
      Store.update('applications', id, patch);
      closeModal();
      toast('Status updated to ' + d.status + '.');
      after ? after() : render();
    };
  }

  /* =========================== INTERVIEWS =========================== */
  function viewInterviews() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Interviews</h3>
      <div class="panel-tools">${exportButtons('iv')}
        <button class="btn-primary" id="ivAdd">+ Schedule Interview</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="ivQ" placeholder="Search student / company / venue...">
        <select class="filter-sel" id="ivDrive"><option value="">All Drives</option>${driveOptions()}</select>
        <select class="filter-sel" id="ivStatus"><option value="">All Statuses</option>${optionsFrom(INTERVIEW_STATUS)}</select>
        <label class="days-field">From <input class="filter-sel" id="ivFrom" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="ivTo" type="date"></label>
        <button class="btn-outline btn-sm" id="ivClear">Clear</button>
      </div>
      <div id="ivStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ID</th><th>Student</th><th>Drive</th><th>Type</th><th style="text-align:right">Round</th>
        <th>Date &amp; Time</th><th>Mode</th><th>Venue</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="ivBody"></tbody></table></div><div id="ivPager"></div></div>`;

    viewInterviews.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#ivQ').value || '').trim().toLowerCase();
        const dr = $('#ivDrive').value, st = $('#ivStatus').value;
        const from = $('#ivFrom').value, to = $('#ivTo').value;
        return Store.all('interviews').map(i => {
          const s = Store.find('students', i.studentId) || {};
          const d = Store.find('drives', i.driveId) || {};
          return Object.assign({}, i, {
            name: s.name || 'Unknown student', roll: s.roll || '—', branch: specOf(s) || '—',
            company: companyName(d.companyId), jobRole: d.jobRole || '—',
            when: `${i.date || '—'}${i.time ? ' ' + i.time : ''}`,
          });
        }).filter(i =>
          (!q || [i.id, i.name, i.roll, i.company, i.venue, i.jobRole].some(v =>
            String(v || '').toLowerCase().includes(q))) &&
          (!dr || i.driveId === dr) && (!st || (i.status || 'Scheduled') === st) &&
          (!from || (i.date && i.date >= from)) && (!to || (i.date && i.date <= to)))
          .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
                          String(a.time || '').localeCompare(String(b.time || '')));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        const c = (s) => rows.filter(r => (r.status || 'Scheduled') === s).length;
        $('#ivStats').innerHTML = `${statCard('🎤', rows.length, 'Interviews')}
          ${statCard('📅', c('Scheduled'), 'Scheduled', 'c2')}
          ${statCard('✅', c('Completed'), 'Completed', 'c3')}
          ${statCard('🚫', c('Cancelled') + c('No Show'), 'Cancelled / No Show', 'c4')}`;
        $('#ivBody').innerHTML = rows.length ? pageSlice(rows, page).map(i => `<tr>
          <td class="mono">${esc(i.id)}</td>
          <td>${esc(i.name)}<br><small style="color:var(--muted)">${esc(i.roll)}</small></td>
          <td>${esc(i.jobRole)}<br><small style="color:var(--muted)">${esc(i.company)}</small></td>
          <td>${esc(i.interviewType || 'Final')}</td>
          <td style="text-align:right">${esc(String(i.round || 1))}</td>
          <td>${esc(i.when)}</td><td>${esc(i.mode || '—')}</td><td>${esc(i.venue || '—')}</td>
          <td><span class="pill ${IV_PILL[i.status] || 'blue'}">${esc(i.status || 'Scheduled')}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-edit" data-edit="${i.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${i.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="9" class="empty">No interviews match these filters.</td></tr>`;
        $('#ivBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => interviewForm(b.dataset.edit, draw));
        $('#ivBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const i = Store.find('interviews', b.dataset.del) || {};
          const s = Store.find('students', i.studentId) || {};
          confirmDelete('Delete Interview', `Remove round ${esc(String(i.round || 1))} for
            <b>${esc(s.name || '—')}</b> on ${esc(i.date || '—')}?`, 'Delete',
            () => { Store.remove('interviews', i.id); toast('Interview deleted.', 'err'); draw(); });
        });
        $('#ivPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#ivPager'), rows.length, page, (p) => page = p, draw);
      };
      ['ivQ', 'ivDrive', 'ivStatus', 'ivFrom', 'ivTo'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#ivClear').onclick = () => {
        ['ivQ', 'ivDrive', 'ivStatus', 'ivFrom', 'ivTo'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      $('#ivAdd').onclick = () => interviewForm(null, draw);
      bindExports('iv', () => {
        const rows = rowsFor();
        return {
          title: 'Interview Report', sheetName: 'Interviews', subtitle: placementStamp(),
          columns: [
            { header: 'Interview ID', key: 'id', width: 13 },
            { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
            { header: 'Specialisation', key: 'branch', width: 10 },
            { header: 'Company', key: 'company', width: 24 }, { header: 'Job Role', key: 'jobRole', width: 22 },
            { header: 'Round', key: 'round', width: 8, type: 'number' },
            { header: 'Date', key: 'date', width: 13 }, { header: 'Time', key: 'time', width: 10 },
            { header: 'Mode', key: 'mode', width: 12 }, { header: 'Venue', key: 'venue', width: 24 },
            { header: 'Status', key: 'status', width: 13 },
            { header: 'Remarks', key: 'remarks', width: 30 },
          ],
          rows,
          totals: { id: 'TOTAL', roll: rows.length + ' interviews' },
        };
      });
      draw();
    };
    return html;
  }

  function interviewForm(id, after) {
    const iv = id ? (Store.find('interviews', id) || {}) : {};
    const apps = Store.all('applications').filter(a => ['Shortlisted', 'Selected', 'Applied'].includes(a.status || 'Applied'));
    if (!apps.length && !id) {
      toast('No live application to schedule against — shortlist a student first.', 'err');
      navigate('applications'); return;
    }
    const appOption = (a) => {
      const s = Store.find('students', a.studentId) || {};
      return `<option value="${a.id}" ${a.id === iv.applicationId ? 'selected' : ''}>
        ${esc(s.roll || '—')} — ${esc(s.name || '?')} · ${esc(driveLabel(a.driveId))}</option>`;
    };
    const list = id && !apps.some(a => a.id === iv.applicationId)
      ? apps.concat(Store.find('applications', iv.applicationId) || []) : apps;
    openModal((id ? 'Edit' : 'Schedule') + ' Interview', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Application</label>
          <select name="applicationId" id="ivfApp" required>${list.map(appOption).join('')}</select></div>
        <div class="field"><label>Interview Type</label>
          <select name="interviewType">${optionsFrom(INTERVIEW_TYPES, iv.interviewType || INTERVIEW_TYPES[0])}</select></div>
        <div class="field"><label>Round</label><input name="round" type="number" min="1" max="10" value="${esc(iv.round || 1)}"></div>
        <div class="field"><label>Mode</label><select name="mode">${optionsFrom(INTERVIEW_MODES, iv.mode || 'Offline')}</select></div>
        <div class="field"><label>Date</label><input name="date" type="date" value="${esc(iv.date || today())}" required></div>
        <div class="field"><label>Time</label><input name="time" type="time" value="${esc(iv.time || '10:00')}"></div>
        <div class="field full"><label>Venue / Link</label><input name="venue" placeholder="Room 201, or a meeting link" value="${esc(iv.venue || '')}"></div>
        <div class="field full"><label>Status</label><select name="status">${optionsFrom(INTERVIEW_STATUS, iv.status || 'Scheduled')}</select></div>
        <div class="field full"><label>Remarks</label><textarea name="remarks" rows="2">${esc(iv.remarks || '')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save Interview</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const app = Store.find('applications', d.applicationId);
      if (!app) { toast('Please pick an application.', 'err'); return; }
      // the interview inherits its student and drive from the application, so
      // the three can never disagree
      d.studentId = app.studentId; d.driveId = app.driveId;
      if (id) Store.update('interviews', id, d); else Store.add('interviews', d);
      closeModal(); toast('Interview saved.'); after ? after() : render();
    };
  }

  /* =========================== SELECTIONS & PLACEMENTS =========================== */
  function viewPlacements() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Selections &amp; Placements</h3>
      <div class="panel-tools">${exportButtons('pl')}
        <button class="btn-primary" id="plAdd">+ Record Placement</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="plQ" placeholder="Search student / company / role...">
        <select class="filter-sel" id="plCompany"><option value="">All Companies</option>${companyOptions()}</select>
        <select class="filter-sel" id="plBranch"><option value="">All Specialisations</option>${specialisationOptions()}</select>
        <select class="filter-sel" id="plStatus"><option value="">All Statuses</option>${optionsFrom(OFFER_STATUS)}</select>
        <button class="btn-outline btn-sm" id="plClear">Clear</button>
      </div>
      <div id="plStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Reg No</th><th>Student</th><th>Specialisation</th><th>Company</th><th>Designation</th>
        <th style="text-align:right">Package</th><th>Joining Date</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="plBody"></tbody></table></div><div id="plPager"></div></div>`;

    viewPlacements.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#plQ').value || '').trim().toLowerCase();
        const co = $('#plCompany').value, br = $('#plBranch').value, st = $('#plStatus').value;
        return offerRows().filter(o =>
          (!q || [o.roll, o.name, o.company, o.jobRole].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!co || o.companyId === co) && (!br || o.branch === br) && (!st || o.status === st));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        const placed = rows.filter(o => PLACED_OFFER_STATUS.includes(o.status));
        const pkgs = placed.map(o => +o.package || 0).filter(n => n > 0);
        $('#plStats').innerHTML = `${statCard('🎯', rows.length, 'Selections Listed')}
          ${statCard('🏆', placed.length, 'Placed', 'c3')}
          ${statCard('💰', money(pkgs.length ? Math.max(...pkgs) : 0), 'Highest Package', 'c3')}
          ${statCard('📊', money(pkgs.length ? Math.round(pkgs.reduce((a, b) => a + b, 0) / pkgs.length) : 0), 'Average Package', 'c2')}`;
        $('#plBody').innerHTML = rows.length ? pageSlice(rows, page).map(o => `<tr>
          <td class="mono">${esc(o.roll)}</td><td>${esc(o.name)}</td><td>${esc(o.branch)}</td>
          <td>${esc(o.company)}</td><td>${esc(o.jobRole || '—')}</td>
          <td style="text-align:right;font-weight:600">${money(o.package)}</td>
          <td>${esc(o.joiningDate || '—')}</td>
          <td><span class="pill ${OFFER_PILL[o.status] || 'blue'}">${esc(o.status || 'Offered')}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${o.id}">👁 View</button>
            <button class="btn-sm btn-edit" data-edit="${o.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${o.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="9" class="empty">No selections match these filters.</td></tr>`;
        bindOfferRowActions('#plBody', draw);
        $('#plPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#plPager'), rows.length, page, (p) => page = p, draw);
      };
      ['plQ', 'plCompany', 'plBranch', 'plStatus'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#plClear').onclick = () => {
        ['plQ', 'plCompany', 'plBranch', 'plStatus'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      $('#plAdd').onclick = () => offerForm(null, draw);
      bindExports('pl', () => ({
        title: 'Placement Report', sheetName: 'Placements', subtitle: placementStamp(),
        columns: placementColumns(), rows: rowsFor(),
        totals: { roll: 'TOTAL', name: rowsFor().length + ' selections',
                  package: rowsFor().reduce((a, o) => a + (+o.package || 0), 0) },
      }));
      draw();
    };
    return html;
  }

  /** every offer joined with its student, drive and company — the shared row shape */
  function offerRows() {
    return Store.all('offers').map(o => {
      const s = Store.find('students', o.studentId) || {};
      const d = Store.find('drives', o.driveId) || {};
      return Object.assign({}, o, {
        name: s.name || 'Unknown student', roll: s.roll || '—', branch: specOf(s) || '—',
        semester: s.semester || '', batch: s.batch || '—', email: s.email || '',
        company: companyName(o.companyId || d.companyId),
        companyId: o.companyId || d.companyId,
        package: +o.package || 0,
        status: o.status || 'Offered',
      });
    }).sort((a, b) => String(b.offerDate || '').localeCompare(String(a.offerDate || '')) ||
                      String(a.roll).localeCompare(String(b.roll)));
  }
  function placementColumns() {
    return [
      { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
      { header: 'Specialisation', key: 'branch', width: 10 }, { header: 'Batch', key: 'batch', width: 13 },
      { header: 'Company', key: 'company', width: 24 },
      { header: 'Designation', key: 'jobRole', width: 24 },
      { header: 'Package', key: 'package', width: 14, money: true },
      { header: 'CTC', key: 'ctc', width: 12 },
      { header: 'Location', key: 'location', width: 16 },
      { header: 'Offer Date', key: 'offerDate', width: 13 },
      { header: 'Joining Date', key: 'joiningDate', width: 13 },
      { header: 'Status', key: 'status', width: 12 },
    ];
  }
  /** View / Edit / Delete wiring shared by the Selections and Offers tables */
  function bindOfferRowActions(sel, draw) {
    const root = $(sel);
    if (!root) return;
    root.querySelectorAll('[data-view]').forEach(b => b.onclick = () => offerViewModal(b.dataset.view));
    root.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => offerForm(b.dataset.edit, draw));
    root.querySelectorAll('[data-letter]').forEach(b => b.onclick = () => openOfferLetter(b.dataset.letter));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const o = Store.find('offers', b.dataset.del) || {};
      const s = Store.find('students', o.studentId) || {};
      confirmDelete('Delete Offer', `Remove <b>${esc(s.name || '—')}</b>'s
        ${esc(money(o.package))} offer from <b>${esc(companyName(o.companyId))}</b>?
        The student will stop counting as placed.`, 'Delete',
        () => { Store.remove('offers', o.id); toast('Offer deleted.', 'err'); draw(); });
    });
  }

  /* =========================== OFFERS =========================== */
  function viewOffers() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Offers</h3>
      <div class="panel-tools">${exportButtons('of')}
        <button class="btn-primary" id="ofAdd">+ Add Offer</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="ofQ" placeholder="Search student / company...">
        <select class="filter-sel" id="ofCompany"><option value="">All Companies</option>${companyOptions()}</select>
        <select class="filter-sel" id="ofStatus"><option value="">All Offer Statuses</option>${optionsFrom(OFFER_STATUS)}</select>
        <select class="filter-sel" id="ofLetter"><option value="">Letter: any</option>
          <option value="yes">Attached</option><option value="no">Not attached</option></select>
        <button class="btn-outline btn-sm" id="ofClear">Clear</button>
      </div>
      <div id="ofStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>ID</th><th>Student</th><th>Company</th><th>Designation</th>
        <th style="text-align:right">Package</th><th>Offer Date</th><th>Joining</th>
        <th>Letter</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody id="ofBody"></tbody></table></div><div id="ofPager"></div></div>`;

    viewOffers.after = () => {
      let page = 1;
      const rowsFor = () => {
        const q = ($('#ofQ').value || '').trim().toLowerCase();
        const co = $('#ofCompany').value, st = $('#ofStatus').value, lt = $('#ofLetter').value;
        return offerRows().filter(o =>
          (!q || [o.id, o.roll, o.name, o.company, o.jobRole].some(v =>
            String(v || '').toLowerCase().includes(q))) &&
          (!co || o.companyId === co) && (!st || o.status === st) &&
          (!lt || (lt === 'yes' ? !!o.offerLetter : !o.offerLetter)));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        const c = (s) => rows.filter(r => r.status === s).length;
        $('#ofStats').innerHTML = `${statCard('📜', rows.length, 'Offers')}
          ${statCard('⏳', c('Offered'), 'Awaiting Response', 'c2')}
          ${statCard('✅', c('Accepted') + c('Joined'), 'Accepted / Joined', 'c3')}
          ${statCard('📎', rows.filter(r => r.offerLetter).length, 'Letters Attached', 'c2')}`;
        $('#ofBody').innerHTML = rows.length ? pageSlice(rows, page).map(o => `<tr>
          <td class="mono">${esc(o.id)}</td>
          <td>${esc(o.name)}<br><small style="color:var(--muted)">${esc(o.roll)} · ${esc(o.branch)}</small></td>
          <td>${esc(o.company)}</td><td>${esc(o.jobRole || '—')}</td>
          <td style="text-align:right;font-weight:600">${money(o.package)}</td>
          <td>${esc(o.offerDate || '—')}</td><td>${esc(o.joiningDate || '—')}</td>
          <td>${o.offerLetter
            ? `<button class="btn-sm btn-outline" data-letter="${o.id}">📎 Open</button>`
            : '<small style="color:var(--muted)">—</small>'}</td>
          <td><span class="pill ${OFFER_PILL[o.status] || 'blue'}">${esc(o.status)}</span></td>
          <td><div class="row-actions">
            <button class="btn-sm btn-outline" data-view="${o.id}">👁 View</button>
            <button class="btn-sm btn-edit" data-edit="${o.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${o.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="10" class="empty">No offers match these filters.</td></tr>`;
        bindOfferRowActions('#ofBody', draw);
        $('#ofPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#ofPager'), rows.length, page, (p) => page = p, draw);
      };
      ['ofQ', 'ofCompany', 'ofStatus', 'ofLetter'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#ofClear').onclick = () => {
        ['ofQ', 'ofCompany', 'ofStatus', 'ofLetter'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      $('#ofAdd').onclick = () => offerForm(null, draw);
      bindExports('of', () => ({
        title: 'Offer Report', sheetName: 'Offers', subtitle: placementStamp(),
        columns: placementColumns(), rows: rowsFor(),
        totals: { roll: 'TOTAL', name: rowsFor().length + ' offers',
                  package: rowsFor().reduce((a, o) => a + (+o.package || 0), 0) },
      }));
      draw();
    };
    return html;
  }

  function offerForm(id, after, preset) {
    const o = id ? (Store.find('offers', id) || {}) : (preset || {});
    const drives = Store.all('drives');
    if (!drives.length) { toast('Create a drive first.', 'err'); navigate('drives'); return; }
    const d0 = Store.find('drives', o.driveId) || {};
    openModal((id ? 'Edit' : 'Add') + ' Offer', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Drive</label>
          <select name="driveId" id="offDrive" required>${driveOptions(o.driveId)}</select></div>
        <div class="field full"><label>Student</label>
          <select name="studentId" id="offStudent" required></select></div>
        <div class="field"><label>Designation</label>
          <input name="jobRole" id="offRole" value="${esc(o.jobRole || d0.jobRole || '')}" required></div>
        <div class="field"><label>Package (₹ per annum)</label>
          <input name="package" id="offPkg" inputmode="numeric" value="${esc(o.package || d0.package || '')}"></div>
        <div class="field"><label>CTC (as written on the offer)</label>
          <input name="ctc" placeholder="e.g. 4.5 LPA" value="${esc(o.ctc || '')}"></div>
        <div class="field"><label>Job Location</label>
          <input name="location" list="offLocList" value="${esc(o.location || d0.location || '')}">
          <datalist id="offLocList">${JOB_LOCATIONS.map(l => `<option>${esc(l)}</option>`).join('')}</datalist></div>
        <div class="field"><label>Offer Date</label><input name="offerDate" type="date" value="${esc(o.offerDate || today())}"></div>
        <div class="field"><label>Joining Date</label><input name="joiningDate" type="date" value="${esc(o.joiningDate || '')}"></div>
        <div class="field full"><label>Offer Status</label>
          <select name="status" id="offStatus">${optionsFrom(OFFER_STATUS, o.status || 'Offered')}</select></div>
        <div class="field ${OFFER_ENDED_STATUS.includes(o.status) ? '' : 'hidden'}" id="offExitWrap">
          <label>Left On</label>
          <input name="exitDate" type="date" value="${esc(o.exitDate || '')}"></div>
        <div class="field full ${OFFER_ENDED_STATUS.includes(o.status) ? '' : 'hidden'}" id="offReasonWrap">
          <label>Reason</label>
          <input name="exitReason" id="offReason" value="${esc(o.exitReason || '')}"
                 placeholder="Why the student did not join, or left"></div>
        ${offerLetterField(o.offerLetter, o.offerLetterName)}
        <div class="field full"><label>Remarks</label><textarea name="remarks" rows="2">${esc(o.remarks || '')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save Offer</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    // the reason only makes sense for the two statuses that need explaining
    $('#offStatus').onchange = () => {
      const ended = OFFER_ENDED_STATUS.includes($('#offStatus').value);
      $('#offReasonWrap').classList.toggle('hidden', !ended);
      $('#offExitWrap').classList.toggle('hidden', !ended);
    };
    bindAmountInput($('#offPkg'));
    bindOfferLetterField();

    // an offer follows a selection, so the student list is the drive's selected
    // students first — anyone else on that drive is still selectable
    const fillStudents = () => {
      const driveId = $('#offDrive').value;
      const d = Store.find('drives', driveId) || {};
      const apps = Store.all('applications').filter(a => a.driveId === driveId);
      const ranked = apps.slice().sort((a, b) =>
        (b.status === 'Selected') - (a.status === 'Selected'));
      const taken = Store.all('offers').filter(x => x.driveId === driveId && x.id !== id).map(x => x.studentId);
      let opts = ranked.filter(a => !taken.includes(a.studentId)).map(a => {
        const s = Store.find('students', a.studentId) || {};
        return `<option value="${s.id}" ${s.id === o.studentId ? 'selected' : ''}>
          ${esc(s.roll || '—')} — ${esc(s.name || '?')} (${esc(a.status || 'Applied')})</option>`;
      }).join('');
      if (!opts) {
        opts = Store.all('students').filter(s => !taken.includes(s.id))
          .map(s => `<option value="${s.id}" ${s.id === o.studentId ? 'selected' : ''}>
            ${esc(s.roll)} — ${esc(s.name)}</option>`).join('');
      }
      $('#offStudent').innerHTML = opts || `<option value="">No student available</option>`;
      if (!id && d.jobRole && !$('#offRole').value) $('#offRole').value = d.jobRole;
    };
    $('#offDrive').onchange = fillStudents;
    fillStudents();

    $('#f').onsubmit = (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (!f.studentId) { toast('Please pick a student.', 'err'); return; }
      const clash = Store.all('offers').find(x =>
        x.studentId === f.studentId && x.driveId === f.driveId && x.id !== id);
      if (clash) { toast('That student already has an offer from this drive.', 'err'); return; }
      if (f.joiningDate && f.offerDate && f.joiningDate < f.offerDate) {
        toast('Joining date cannot be before the offer date.', 'err'); return;
      }
      const drive = Store.find('drives', f.driveId) || {};
      f.companyId = drive.companyId || '';
      f.package = f.package === '' ? '' : (parseAmount(f.package, { min: 0 }) ?? '');
      if (id) Store.update('offers', id, f); else Store.add('offers', f);
      // an offer means the application was a selection — keep the two in step
      const app = Store.all('applications').find(a => a.studentId === f.studentId && a.driveId === f.driveId);
      if (app && app.status !== 'Selected') {
        Store.update('applications', app.id, { status: 'Selected', updatedBy: user.id, updatedOn: today() });
      }
      closeModal(); toast('Offer saved.'); after ? after() : render();
    };
  }

  function offerViewModal(id) {
    const o = Store.find('offers', id);
    if (!o) return;
    const s = Store.find('students', o.studentId) || {};
    const d = Store.find('drives', o.driveId) || {};
    const row = (k, v) => `<tr><td style="font-weight:600;width:190px">${esc(k)}</td><td>${esc(v || '—')}</td></tr>`;
    openModal('Offer ' + o.id, `
      <div style="display:flex;gap:18px;align-items:center;margin-bottom:18px">
        <div class="logo-circle">${s.photo ? `<img src="${esc(s.photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : esc((s.name || '?')[0])}</div>
        <div><h3 style="color:var(--primary-dark)">${esc(s.name || '—')}</h3>
        <p style="color:var(--muted);font-size:13px">${esc(s.roll || '—')} · ${esc(s.branch || '—')} ·
          <span class="pill ${OFFER_PILL[o.status] || 'blue'}">${esc(o.status || 'Offered')}</span></p></div>
      </div>
      <div class="stat-grid" style="margin-bottom:18px">
        ${statCard('🏢', companyName(o.companyId), 'Company')}
        ${statCard('💰', money(o.package), 'Package', 'c3')}
        ${statCard('📅', o.joiningDate || '—', 'Joining Date', 'c2')}
      </div>
      <h4 class="ro-sub">Offer Details</h4>
      <div class="tbl-wrap"><table><tbody>
        ${row('Offer ID', o.id)}${row('Company', companyName(o.companyId))}
        ${row('Drive', driveLabel(o.driveId))}${row('Designation', o.jobRole)}
        ${row('Package (₹ p.a.)', money(o.package))}${row('CTC', o.ctc)}
        ${row('Job Location', o.location || d.location)}
        ${row('Offer Date', o.offerDate)}${row('Joining Date', o.joiningDate)}
        ${row('Offer Status', o.status)}
        ${row('Offer Letter', o.offerLetter ? (o.offerLetterName || 'attached') : 'Not attached')}
        ${row('Remarks', o.remarks)}
      </tbody></table></div>
      <div class="form-actions"><button class="btn-outline" id="cx">Close</button>
        ${o.offerLetter ? `<button class="btn-primary" id="ol">📎 View Offer Letter</button>` : ''}</div>`, true);
    $('#cx').onclick = closeModal;
    if (o.offerLetter) $('#ol').onclick = () => openOfferLetter(id);
  }

  /* =========================== PLACEMENT CALENDAR =========================== */
  function viewPlacementCalendar() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Placement Calendar</h3>
      <div class="panel-tools">${exportButtons('pc')}
        <button class="btn-primary" id="pcAdd">+ Add Date</button></div></div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="pcQ" placeholder="Search title / venue...">
        <select class="filter-sel" id="pcType"><option value="">All Types</option>${optionsFrom(PL_EVENT_TYPES)}</select>
        <select class="filter-sel" id="pcWhen">
          <option value="upcoming">Upcoming only</option>
          <option value="all">All dates</option>
          <option value="past">Past only</option>
        </select>
        <button class="btn-outline btn-sm" id="pcClear">Clear</button>
      </div>
      <div id="pcStats" class="stat-grid" style="margin:6px 0 18px"></div>
      <div id="pcTimeline"></div>
      <div class="tbl-wrap"><table><thead><tr>
        <th>Date</th><th>Time</th><th>Title</th><th>Type</th><th>Company</th><th>Venue</th><th>Actions</th>
      </tr></thead><tbody id="pcBody"></tbody></table></div><div id="pcPager"></div></div>`;

    viewPlacementCalendar.after = () => {
      let page = 1;
      // drives and interviews already carry dates — the calendar shows them
      // alongside the dates entered by hand, without copying either
      const rowsFor = () => {
        const q = ($('#pcQ').value || '').trim().toLowerCase();
        const type = $('#pcType').value, when = $('#pcWhen').value || 'upcoming';
        const manual = Store.all('placementevents').map(e => Object.assign({}, e, {
          source: 'calendar', company: companyName(e.companyId),
          time: [e.startTime, e.endTime].filter(Boolean).join(' – ') || '—',
        }));
        const fromDrives = Store.all('drives').filter(d => d.driveDate).map(d => ({
          id: 'drive:' + d.id, title: `${companyName(d.companyId)} — ${d.jobRole || 'Drive'}`,
          type: 'Drive', date: d.driveDate, time: '—', company: companyName(d.companyId),
          venue: d.location || '—', description: d.selectionProcess || '', source: 'drive', refId: d.id,
        }));
        const fromIvs = Store.all('interviews').filter(i => i.date).map(i => {
          const s = Store.find('students', i.studentId) || {};
          return {
            id: 'iv:' + i.id, title: `Interview — ${s.name || '?'} (Round ${i.round || 1})`,
            type: 'Interview', date: i.date, time: i.time || '—',
            company: companyName((Store.find('drives', i.driveId) || {}).companyId),
            venue: i.venue || '—', description: i.remarks || '', source: 'interview', refId: i.id,
          };
        });
        const td = today();
        return manual.concat(fromDrives, fromIvs).filter(e =>
          (!q || [e.title, e.venue, e.company].some(v => String(v || '').toLowerCase().includes(q))) &&
          (!type || e.type === type) &&
          (when === 'all' || (when === 'upcoming' ? (e.date || '') >= td : (e.date || '') < td)))
          .sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
                          String(a.time).localeCompare(String(b.time)));
      };
      const draw = () => {
        const rows = rowsFor();
        page = Math.min(page, pageCount(rows.length));
        const td = today();
        $('#pcStats').innerHTML = `${statCard('📅', rows.length, 'Dates Listed')}
          ${statCard('🚀', rows.filter(r => r.type === 'Drive').length, 'Drives', 'c3')}
          ${statCard('🎤', rows.filter(r => r.type === 'Interview').length, 'Interviews', 'c2')}
          ${statCard('⏰', rows.filter(r => r.date >= td).length, 'Still Upcoming', 'c2')}`;

        // a compact month-grouped timeline above the table
        const groups = {};
        rows.slice(0, 30).forEach(e => {
          const key = (e.date || '').slice(0, 7) || 'Undated';
          (groups[key] = groups[key] || []).push(e);
        });
        $('#pcTimeline').innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([m, list]) => {
          const label = m === 'Undated' ? 'Undated'
            : new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
          return `<div style="margin-bottom:16px">
            <div class="ro-sub" style="margin-top:0">${esc(label)}</div>
            <div class="lib-events-list">${list.map(e => {
              const d = e.date ? new Date(e.date + 'T00:00:00') : null;
              return `<div class="lib-event">
                <div class="lib-event-badge">
                  <span class="mon">${d ? d.toLocaleString('en-US', { month: 'short' }).toUpperCase() : '—'}</span>
                  <span class="day">${d ? d.getDate() : '?'}</span></div>
                <div><div class="lib-event-title">${esc(e.title)}
                  <span class="pill ${PLEV_PILL[e.type] || 'blue'}">${esc(e.type || 'Other')}</span></div>
                  <div class="lib-event-meta">${esc(e.time)}${e.venue && e.venue !== '—' ? ' · ' + esc(e.venue) : ''}
                    ${e.company && e.company !== '—' ? ' · ' + esc(e.company) : ''}</div></div>
              </div>`;
            }).join('')}</div></div>`;
        }).join('') : '<p class="empty">Nothing on the calendar for these filters.</p>';

        $('#pcBody').innerHTML = rows.length ? pageSlice(rows, page).map(e => `<tr>
          <td>${esc(e.date || '—')}</td><td>${esc(e.time)}</td><td>${esc(e.title)}</td>
          <td><span class="pill ${PLEV_PILL[e.type] || 'blue'}">${esc(e.type || 'Other')}</span></td>
          <td>${esc(e.company || '—')}</td><td>${esc(e.venue || '—')}</td>
          <td><div class="row-actions">${e.source === 'calendar'
            ? `<button class="btn-sm btn-edit" data-edit="${e.id}">Edit</button>
               <button class="btn-sm btn-del" data-del="${e.id}">Delete</button>`
            : `<small style="color:var(--muted)">from ${esc(e.source)}</small>`}</div></td></tr>`).join('')
          : `<tr><td colspan="7" class="empty">Nothing on the calendar for these filters.</td></tr>`;
        $('#pcBody').querySelectorAll('[data-edit]').forEach(b =>
          b.onclick = () => placementEventForm(b.dataset.edit, draw));
        $('#pcBody').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
          const e = Store.find('placementevents', b.dataset.del) || {};
          confirmDelete('Delete Date', `Remove <b>${esc(e.title)}</b> from the placement calendar?`,
            'Delete', () => { Store.remove('placementevents', e.id); toast('Date removed.', 'err'); draw(); });
        });
        $('#pcPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#pcPager'), rows.length, page, (p) => page = p, draw);
      };
      ['pcQ', 'pcType', 'pcWhen'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#pcClear').onclick = () => {
        $('#pcQ').value = ''; $('#pcType').value = ''; $('#pcWhen').value = 'upcoming';
        page = 1; draw();
      };
      $('#pcAdd').onclick = () => placementEventForm(null, draw);
      bindExports('pc', () => {
        const rows = rowsFor();
        return {
          title: 'Placement Calendar', sheetName: 'Calendar', subtitle: placementStamp(),
          columns: [
            { header: 'Date', key: 'date', width: 13 }, { header: 'Time', key: 'time', width: 14 },
            { header: 'Title', key: 'title', width: 36 }, { header: 'Type', key: 'type', width: 18 },
            { header: 'Company', key: 'company', width: 24 }, { header: 'Venue', key: 'venue', width: 24 },
            { header: 'Source', key: 'source', width: 12 },
          ],
          rows,
          totals: { date: 'TOTAL', title: rows.length + ' dates' },
        };
      });
      draw();
    };
    return html;
  }

  function placementEventForm(id, after) {
    const e = id ? (Store.find('placementevents', id) || {}) : {};
    openModal((id ? 'Edit' : 'Add') + ' Calendar Date', `<form id="f">
      <div class="form-grid">
        <div class="field full"><label>Title</label><input name="title" value="${esc(e.title || '')}" required></div>
        <div class="field"><label>Type</label><select name="type">${optionsFrom(PL_EVENT_TYPES, e.type || 'Other')}</select></div>
        <div class="field"><label>Date</label><input name="date" type="date" value="${esc(e.date || today())}" required></div>
        <div class="field"><label>Start Time</label><input name="startTime" type="time" value="${esc(e.startTime || '')}"></div>
        <div class="field"><label>End Time</label><input name="endTime" type="time" value="${esc(e.endTime || '')}"></div>
        <div class="field"><label>Company <small style="color:var(--muted);font-weight:400">(optional)</small></label>
          <select name="companyId"><option value="">—</option>${companyOptions(e.companyId)}</select></div>
        <div class="field"><label>Drive <small style="color:var(--muted);font-weight:400">(optional)</small></label>
          <select name="driveId"><option value="">—</option>${driveOptions(e.driveId)}</select></div>
        <div class="field full"><label>Venue</label><input name="venue" value="${esc(e.venue || '')}"></div>
        <div class="field full"><label>Description</label><textarea name="description" rows="2">${esc(e.description || '')}</textarea></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary">Save</button></div></form>`, true);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = (ev) => {
      ev.preventDefault();
      const d = formData(ev.target);
      if (d.startTime && d.endTime && d.endTime < d.startTime) {
        toast('End time cannot be before the start time.', 'err'); return;
      }
      if (id) Store.update('placementevents', id, d); else Store.add('placementevents', d);
      closeModal(); toast('Calendar date saved.'); after ? after() : render();
    };
  }

  /* =========================== PLACEMENT REPORTS =========================== */
  function placementStamp() {
    return `NMIET B-SCHOOL · Training & Placement Cell · Generated on ${new Date().toLocaleString('en-IN')}`;
  }
  const PL_REPORTS = [
    ['placement', '🏆 Placement Report'],
    ['company', '🏢 Company-wise Report'],
    ['branch', '🌿 Specialisation-wise Report'],
    ['package', '💰 Package Report'],
    ['drive', '🚀 Drive Report'],
    ['application', '📨 Application Report'],
    ['unplaced', '⏳ Unplaced Students'],
    ['left', '🚪 Not Joined / Left'],
  ];
  let plReport = 'placement';

  function viewPlacementReports() {
    const guard = placementGuard(); if (guard) return guard;
    const html = `<div class="panel"><div class="panel-head"><h3>Placement Reports</h3>
      <div class="panel-tools">${exportButtons('pr')}</div></div>
      <div class="fin-tabs" id="prTabs">${PL_REPORTS.map(([key, label]) =>
        `<button class="fin-tab ${key === plReport ? 'active' : ''}" data-rep="${key}">${label}</button>`).join('')}</div>
      <div class="panel-tools fin-filters">
        <input class="search-box" id="prQ" placeholder="Search...">
        <select class="filter-sel" id="prBranch"><option value="">All Specialisations</option>${specialisationOptions()}</select>
        <select class="filter-sel" id="prCompany"><option value="">All Companies</option>${companyOptions()}</select>
        <label class="days-field">From <input class="filter-sel" id="prFrom" type="date"></label>
        <label class="days-field">To <input class="filter-sel" id="prTo" type="date"></label>
        <button class="btn-outline btn-sm" id="prClear">Clear</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 14px" id="prNote"></p>
      <div id="prStats" class="stat-grid" style="margin-bottom:18px"></div>
      <div id="prTable"></div><div id="prPager"></div></div>`;

    viewPlacementReports.after = () => {
      let page = 1;
      const values = () => ({
        q: ($('#prQ').value || '').trim().toLowerCase(),
        branch: $('#prBranch').value, company: $('#prCompany').value,
        from: $('#prFrom').value, to: $('#prTo').value,
      });
      const build = () => buildPlacementReport(plReport, values());
      const draw = () => {
        const r = build();
        page = Math.min(page, pageCount(r.rows.length));
        $('#prNote').textContent = r.note || '';
        $('#prStats').innerHTML = (r.stats || []).join('');
        $('#prTable').innerHTML = reportTableHtml(r.columns, pageSlice(r.rows, page), 'No data for these filters.');
        $('#prPager').innerHTML = pagerHtml(r.rows.length, page);
        bindPager($('#prPager'), r.rows.length, page, (p) => page = p, draw);
      };
      $('#prTabs').querySelectorAll('[data-rep]').forEach(b => b.onclick = () => {
        plReport = b.dataset.rep;
        $('#prTabs').querySelectorAll('.fin-tab').forEach(t =>
          t.classList.toggle('active', t.dataset.rep === plReport));
        page = 1; draw();
      });
      ['prQ', 'prBranch', 'prCompany', 'prFrom', 'prTo'].forEach(id => {
        const el = $('#' + id);
        el[el.tagName === 'INPUT' && el.type !== 'date' ? 'oninput' : 'onchange'] = () => { page = 1; draw(); };
      });
      $('#prClear').onclick = () => {
        ['prQ', 'prBranch', 'prCompany', 'prFrom', 'prTo'].forEach(id => { $('#' + id).value = ''; });
        page = 1; draw();
      };
      bindExports('pr', build);
      draw();
    };
    return html;
  }

  function buildPlacementReport(kind, f) {
    const stamp = placementStamp();
    const inRange = (d) => (!f.from || (d && d >= f.from)) && (!f.to || (d && d <= f.to));
    const st = placementStats();

    if (kind === 'placement') {
      const rows = offerRows().filter(o =>
        (!f.q || [o.roll, o.name, o.company, o.jobRole].some(v => String(v || '').toLowerCase().includes(f.q))) &&
        (!f.branch || o.branch === f.branch) && (!f.company || o.companyId === f.company) &&
        inRange(o.offerDate));
      const placed = rows.filter(o => PLACED_OFFER_STATUS.includes(o.status));
      const pkgs = placed.map(o => +o.package || 0).filter(n => n > 0);
      return {
        title: 'Placement Report', sheetName: 'Placements', subtitle: stamp,
        note: 'Every offer on record, with the student, company, package and joining date.',
        stats: [
          statCard('📜', rows.length, 'Offers Listed'),
          statCard('🏆', placed.length, 'Placed', 'c3'),
          statCard('💰', money(pkgs.length ? Math.max(...pkgs) : 0), 'Highest', 'c3'),
          statCard('📊', money(pkgs.length ? Math.round(pkgs.reduce((a, b) => a + b, 0) / pkgs.length) : 0), 'Average', 'c2'),
        ],
        columns: placementColumns(), rows,
        totals: { roll: 'TOTAL', name: rows.length + ' offers',
                  package: rows.reduce((a, o) => a + (+o.package || 0), 0) },
      };
    }

    if (kind === 'company') {
      const groups = {};
      Store.all('companies').forEach(c => {
        groups[c.id] = { company: c.name, industry: c.industry || '—', location: c.location || '—',
                         drives: 0, applications: 0, selected: 0, placed: 0, total: 0, highest: 0 };
      });
      Store.all('drives').forEach(d => { if (groups[d.companyId]) groups[d.companyId].drives++; });
      Store.all('applications').forEach(a => {
        const d = Store.find('drives', a.driveId);
        if (d && groups[d.companyId]) {
          groups[d.companyId].applications++;
          if (a.status === 'Selected') groups[d.companyId].selected++;
        }
      });
      offerRows().filter(o => inRange(o.offerDate)).forEach(o => {
        const g = groups[o.companyId];
        if (!g) return;
        if (PLACED_OFFER_STATUS.includes(o.status)) {
          g.placed++; g.total += +o.package || 0;
          g.highest = Math.max(g.highest, +o.package || 0);
        }
      });
      const rows = Object.values(groups).map(g => Object.assign(g, {
        average: g.placed ? Math.round(g.total / g.placed) : 0,
      })).filter(g =>
        (!f.q || [g.company, g.industry].some(v => String(v).toLowerCase().includes(f.q))) &&
        (!f.company || g.company === companyName(f.company)))
        .sort((a, b) => b.placed - a.placed || b.average - a.average);
      return {
        title: 'Company-wise Placement Report', sheetName: 'By Company', subtitle: stamp,
        note: 'Recruitment activity and outcome for every company on record.',
        stats: [
          statCard('🏢', rows.length, 'Companies'),
          statCard('🚀', rows.reduce((a, g) => a + g.drives, 0), 'Drives', 'c2'),
          statCard('🏆', rows.reduce((a, g) => a + g.placed, 0), 'Placed', 'c3'),
        ],
        columns: [
          { header: 'Company', key: 'company', width: 26 }, { header: 'Industry', key: 'industry', width: 20 },
          { header: 'Location', key: 'location', width: 16 },
          { header: 'Drives', key: 'drives', width: 9, type: 'number' },
          { header: 'Applications', key: 'applications', width: 13, type: 'number' },
          { header: 'Selected', key: 'selected', width: 10, type: 'number' },
          { header: 'Placed', key: 'placed', width: 9, type: 'number' },
          { header: 'Highest Package', key: 'highest', width: 16, money: true },
          { header: 'Average Package', key: 'average', width: 16, money: true },
        ],
        rows,
        totals: { company: 'TOTAL', industry: rows.length + ' companies',
                  drives: rows.reduce((a, g) => a + g.drives, 0),
                  applications: rows.reduce((a, g) => a + g.applications, 0),
                  placed: rows.reduce((a, g) => a + g.placed, 0) },
      };
    }

    if (kind === 'branch') {
      const groups = {};
      Store.all('students').forEach(s => {
        const b = specOf(s) || '—';
        groups[b] = groups[b] || { branch: b, students: 0, eligible: 0, applied: 0, selected: 0,
                                   placed: 0, total: 0, highest: 0 };
        const g = groups[b];
        g.students++;
        if (drivesStudentMeets(s).length) g.eligible++;
        const apps = studentApplications(s.id);
        if (apps.length) g.applied++;
        if (apps.some(a => a.status === 'Selected')) g.selected++;
        const off = placedOffer(s.id);
        if (off && inRange(off.offerDate)) {
          g.placed++; g.total += +off.package || 0;
          g.highest = Math.max(g.highest, +off.package || 0);
        }
      });
      const rows = Object.values(groups).map(g => Object.assign(g, {
        average: g.placed ? Math.round(g.total / g.placed) : 0,
        rate: g.students ? Math.round(g.placed / g.students * 100) : 0,
      })).filter(g => (!f.q || g.branch.toLowerCase().includes(f.q)) && (!f.branch || g.branch === f.branch))
        .sort((a, b) => b.placed - a.placed);
      return {
        title: 'Specialisation-wise Placement Report', sheetName: 'By Branch', subtitle: stamp,
        note: 'Headcount, eligibility and placement outcome for each specialisation.',
        stats: [
          statCard('🌿', rows.length, 'Specialisations'),
          statCard('🎓', rows.reduce((a, g) => a + g.students, 0), 'Students', 'c2'),
          statCard('🏆', rows.reduce((a, g) => a + g.placed, 0), 'Placed', 'c3'),
        ],
        columns: [
          { header: 'Specialisation', key: 'branch', width: 12 },
          { header: 'Students', key: 'students', width: 10, type: 'number' },
          { header: 'Eligible', key: 'eligible', width: 10, type: 'number' },
          { header: 'Applied', key: 'applied', width: 10, type: 'number' },
          { header: 'Selected', key: 'selected', width: 10, type: 'number' },
          { header: 'Placed', key: 'placed', width: 9, type: 'number' },
          { header: 'Placement %', key: 'rate', width: 13, type: 'number' },
          { header: 'Highest Package', key: 'highest', width: 16, money: true },
          { header: 'Average Package', key: 'average', width: 16, money: true },
        ],
        rows,
        totals: { branch: 'TOTAL', students: rows.reduce((a, g) => a + g.students, 0),
                  eligible: rows.reduce((a, g) => a + g.eligible, 0),
                  placed: rows.reduce((a, g) => a + g.placed, 0) },
      };
    }

    if (kind === 'package') {
      const rows = offerRows().filter(o =>
        PLACED_OFFER_STATUS.includes(o.status) &&
        (!f.q || [o.roll, o.name, o.company].some(v => String(v || '').toLowerCase().includes(f.q))) &&
        (!f.branch || o.branch === f.branch) && (!f.company || o.companyId === f.company) &&
        inRange(o.offerDate))
        .sort((a, b) => (+b.package || 0) - (+a.package || 0));
      const pkgs = rows.map(o => +o.package || 0).filter(n => n > 0);
      const median = pkgs.length ? (() => {
        const sorted = pkgs.slice().sort((a, b) => a - b);
        const m = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
      })() : 0;
      return {
        title: 'Package Report', sheetName: 'Packages', subtitle: stamp,
        note: 'Accepted and joined offers ranked by package — the basis for the highest, average and median figures.',
        stats: [
          statCard('🏆', rows.length, 'Placed Students'),
          statCard('💰', money(pkgs.length ? Math.max(...pkgs) : 0), 'Highest', 'c3'),
          statCard('📊', money(pkgs.length ? Math.round(pkgs.reduce((a, b) => a + b, 0) / pkgs.length) : 0), 'Average', 'c2'),
          statCard('📉', money(median), 'Median', 'c2'),
          statCard('🔻', money(pkgs.length ? Math.min(...pkgs) : 0), 'Lowest', 'c2'),
        ],
        columns: [
          { header: 'Rank', key: 'rank', width: 8, type: 'number' },
          { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
          { header: 'Specialisation', key: 'branch', width: 10 }, { header: 'Company', key: 'company', width: 24 },
          { header: 'Designation', key: 'jobRole', width: 24 },
          { header: 'Package', key: 'package', width: 14, money: true },
          { header: 'CTC', key: 'ctc', width: 12 },
          { header: 'Status', key: 'status', width: 12 },
        ],
        rows: rows.map((o, i) => Object.assign({}, o, { rank: i + 1 })),
        totals: { rank: '', roll: 'TOTAL', name: rows.length + ' placed',
                  package: pkgs.reduce((a, b) => a + b, 0) },
      };
    }

    if (kind === 'drive') {
      const rows = Store.all('drives').map(d => {
        const apps = Store.all('applications').filter(a => a.driveId === d.id);
        const offers = Store.all('offers').filter(o => o.driveId === d.id);
        return {
          id: d.id, company: companyName(d.companyId), jobRole: d.jobRole || '—',
          package: +d.package || 0, driveDate: d.driveDate || '—', status: d.status || 'Draft',
          openings: d.openings || '—', eligible: eligibleStudentsFor(d).length,
          applied: apps.length,
          shortlisted: apps.filter(a => a.status === 'Shortlisted').length,
          selected: apps.filter(a => a.status === 'Selected').length,
          offered: offers.length,
          placed: offers.filter(o => PLACED_OFFER_STATUS.includes(o.status)).length,
        };
      }).filter(d =>
        (!f.q || [d.id, d.company, d.jobRole].some(v => String(v).toLowerCase().includes(f.q))) &&
        (!f.company || d.company === companyName(f.company)) &&
        (d.driveDate === '—' || inRange(d.driveDate)))
        .sort((a, b) => String(b.driveDate).localeCompare(String(a.driveDate)));
      return {
        title: 'Drive Report', sheetName: 'Drives', subtitle: stamp,
        note: 'The funnel for every drive: eligible → applied → shortlisted → selected → placed.',
        stats: [
          statCard('🚀', rows.length, 'Drives'),
          statCard('📨', rows.reduce((a, d) => a + d.applied, 0), 'Applications', 'c2'),
          statCard('🏆', rows.reduce((a, d) => a + d.placed, 0), 'Placed', 'c3'),
        ],
        columns: [
          { header: 'Drive ID', key: 'id', width: 10 }, { header: 'Company', key: 'company', width: 24 },
          { header: 'Job Role', key: 'jobRole', width: 24 },
          { header: 'Package', key: 'package', width: 14, money: true },
          { header: 'Drive Date', key: 'driveDate', width: 13 },
          { header: 'Openings', key: 'openings', width: 10 },
          { header: 'Eligible', key: 'eligible', width: 10, type: 'number' },
          { header: 'Applied', key: 'applied', width: 10, type: 'number' },
          { header: 'Shortlisted', key: 'shortlisted', width: 12, type: 'number' },
          { header: 'Selected', key: 'selected', width: 10, type: 'number' },
          { header: 'Placed', key: 'placed', width: 9, type: 'number' },
          { header: 'Status', key: 'status', width: 12 },
        ],
        rows,
        totals: { id: 'TOTAL', company: rows.length + ' drives',
                  applied: rows.reduce((a, d) => a + d.applied, 0),
                  selected: rows.reduce((a, d) => a + d.selected, 0),
                  placed: rows.reduce((a, d) => a + d.placed, 0) },
      };
    }

    if (kind === 'application') {
      const rows = Store.all('applications').map(a => {
        const s = Store.find('students', a.studentId) || {};
        const d = Store.find('drives', a.driveId) || {};
        return {
          id: a.id, roll: s.roll || '—', name: s.name || 'Unknown student', branch: specOf(s) || '—',
          cgpa: s.id ? (studentCgpa(s) ?? '—') : '—',
          company: companyName(d.companyId), jobRole: d.jobRole || '—',
          package: +d.package || 0, appliedOn: a.appliedOn || '—',
          shortlistedOn: a.shortlistedOn || '—', status: a.status || 'Applied',
          remarks: a.remarks || '',
        };
      }).filter(a =>
        (!f.q || [a.roll, a.name, a.company, a.jobRole].some(v => String(v).toLowerCase().includes(f.q))) &&
        (!f.branch || a.branch === f.branch) &&
        (!f.company || a.company === companyName(f.company)) &&
        (a.appliedOn === '—' || inRange(a.appliedOn)));
      return {
        title: 'Application Report', sheetName: 'Applications', subtitle: stamp,
        note: 'Every application with the student it belongs to and where it reached.',
        stats: [
          statCard('📨', rows.length, 'Applications'),
          statCard('⭐', rows.filter(a => a.status === 'Shortlisted').length, 'Shortlisted', 'c2'),
          statCard('🎯', rows.filter(a => a.status === 'Selected').length, 'Selected', 'c3'),
        ],
        columns: [
          { header: 'Application ID', key: 'id', width: 14 },
          { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
          { header: 'Specialisation', key: 'branch', width: 10 }, { header: 'CGPA', key: 'cgpa', width: 9 },
          { header: 'Company', key: 'company', width: 24 }, { header: 'Job Role', key: 'jobRole', width: 22 },
          { header: 'Package', key: 'package', width: 14, money: true },
          { header: 'Applied On', key: 'appliedOn', width: 13 },
          { header: 'Shortlisted On', key: 'shortlistedOn', width: 15 },
          { header: 'Status', key: 'status', width: 13 },
        ],
        rows,
        totals: { id: 'TOTAL', roll: rows.length + ' applications' },
      };
    }

    if (kind === 'left') {
      /* A student who took an offer and then did not turn up, or left within
         weeks, is a placement the cell has to explain and often refill. Neither
         shows up in the placed figures, so without this they show up nowhere. */
      const SHORT_STAY_DAYS = 31;
      const rows = Store.all('offers')
        .filter(o => OFFER_ENDED_STATUS.includes(o.status))
        .map(o => {
          const stu = Store.find('students', o.studentId) || {};
          // how long they lasted, when both dates are known
          const joined = o.joiningDate ? new Date(o.joiningDate) : null;
          const ended = o.exitDate ? new Date(o.exitDate) : null;
          const days = joined && ended ? Math.round((ended - joined) / 86400000) : null;
          return {
            roll: stu.roll || '—', name: stu.name || '—', branch: specOf(stu) || '—',
            company: companyName(o.companyId), jobRole: o.jobRole || '—',
            package: +o.package || 0, joiningDate: o.joiningDate || '—',
            status: o.status, days: days === null ? '—' : days,
            shortStay: days !== null && days <= SHORT_STAY_DAYS,
            reason: o.exitReason || '—',
          };
        })
        .filter(r =>
          (!f.q || [r.roll, r.name, r.company, r.reason].some(v => String(v).toLowerCase().includes(f.q))) &&
          (!f.branch || r.branch === f.branch))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
        title: 'Not Joined / Left Report', sheetName: 'Not Joined or Left', subtitle: stamp,
        note: `Students who accepted an offer and did not join, or joined and left. A stay of ${SHORT_STAY_DAYS} days or less counts as short.`,
        stats: [
          statCard('🚪', rows.length, 'Offers Ended', 'c4'),
          statCard('🚫', rows.filter(r => r.status === 'Not Joined').length, 'Never Joined', 'c4'),
          statCard('⏱️', rows.filter(r => r.status === 'Left').length, 'Left After Joining', 'c4'),
        ],
        columns: [
          { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
          { header: 'Specialisation', key: 'branch', width: 14 },
          { header: 'Company', key: 'company', width: 24 },
          { header: 'Designation', key: 'jobRole', width: 22 },
          { header: 'Package', key: 'package', width: 14, type: 'number' },
          { header: 'Joining Date', key: 'joiningDate', width: 14 },
          { header: 'Status', key: 'status', width: 14 },
          { header: 'Days Stayed', key: 'days', width: 12 },
          { header: 'Reason', key: 'reason', width: 34 },
        ],
        rows,
        totals: { roll: 'TOTAL', name: rows.length + ' student(s)' },
      };
    }

    // unplaced
    const rows = Store.all('students').filter(s => !isPlaced(s.id)).map(s => {
      const apps = studentApplications(s.id);
      const open = drivesStudentMeets(s);
      return {
        roll: s.roll || '—', name: s.name || '', branch: specOf(s) || '—',
        semester: s.semester || '', cgpa: studentCgpa(s) ?? '—', backlogs: +s.backlogs || 0,
        eligibleDrives: open.length, applications: apps.length,
        shortlisted: apps.filter(a => a.status === 'Shortlisted').length,
        status: placementStatusOf(s.id).label,
      };
    }).filter(r =>
      (!f.q || [r.roll, r.name, r.branch].some(v => String(v).toLowerCase().includes(f.q))) &&
      (!f.branch || r.branch === f.branch))
      .sort((a, b) => b.eligibleDrives - a.eligibleDrives || String(a.roll).localeCompare(String(b.roll)));
    return {
      title: 'Unplaced Students Report', sheetName: 'Unplaced', subtitle: stamp,
      note: 'Students without an accepted or joined offer, ranked by how many open drives they still qualify for.',
      stats: [
        statCard('⏳', rows.length, 'Unplaced'),
        statCard('✅', rows.filter(r => r.eligibleDrives > 0).length, 'Still Eligible', 'c2'),
        statCard('🚫', rows.filter(r => r.eligibleDrives === 0).length, 'No Open Drive', 'c4'),
      ],
      columns: [
        { header: 'Reg No', key: 'roll', width: 14 }, { header: 'Student', key: 'name', width: 26 },
        { header: 'Specialisation', key: 'branch', width: 10 },
        { header: 'Semester', key: 'semester', width: 10, type: 'number' },
        { header: 'CGPA', key: 'cgpa', width: 9 },
        { header: 'Backlogs', key: 'backlogs', width: 10, type: 'number' },
        { header: 'Open Drives', key: 'eligibleDrives', width: 13, type: 'number' },
        { header: 'Applications', key: 'applications', width: 13, type: 'number' },
        { header: 'Shortlisted', key: 'shortlisted', width: 12, type: 'number' },
        { header: 'Status', key: 'status', width: 16 },
      ],
      rows,
      totals: { roll: 'TOTAL', name: rows.length + ' students' },
    };
  }

  /* =========================== PLACEMENT OFFICERS (admin) =========================== */
  function viewPlacementOfficers() {
    if (user.role !== 'admin') {
      return `<div class="panel"><p class="empty">Only the administrator manages placement officer records.</p></div>`;
    }
    const html = `<div class="panel"><div class="panel-head"><h3>Placement Officers</h3>
      <div class="panel-tools">
        <input class="search-box" id="poSearch" placeholder="Search name / employee id...">
        <button class="btn-primary" id="poAdd">+ Add Placement Officer</button></div></div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 10px">
        Each officer here gets a login with the <b>placement_officer</b> role — full access to the
        placement modules, and nothing else.</p>
      <div class="tbl-wrap"><table><thead><tr>
        <th></th><th>Emp ID</th><th>Name</th><th>Designation</th><th>Department</th>
        <th>Email</th><th>Phone</th><th>Actions</th>
      </tr></thead><tbody id="poBody"></tbody></table></div><div id="poPager"></div></div>`;

    viewPlacementOfficers.after = () => {
      let page = 1;
      const draw = () => {
        const q = ($('#poSearch').value || '').toLowerCase();
        const rows = Store.all('placementofficers').filter(p =>
          !q || (p.name || '').toLowerCase().includes(q) || (p.empId || '').toLowerCase().includes(q));
        page = Math.min(page, pageCount(rows.length));
        $('#poBody').innerHTML = rows.length ? pageSlice(rows, page).map(p => `<tr>
          <td>${avatarHtml(p.photo, p.name)}</td>
          <td class="mono">${esc(p.empId || '—')}</td><td>${esc(p.name)}</td>
          <td>${esc(p.designation || '—')}</td><td>${esc(p.department || '—')}</td>
          <td>${esc(p.email || '—')}</td><td>${esc(p.phone || '—')}</td>
          <td><div class="row-actions">
            <button class="btn-sm btn-edit" data-edit="${p.id}">Edit</button>
            <button class="btn-sm btn-del" data-del="${p.id}">Delete</button>
          </div></td></tr>`).join('')
          : `<tr><td colspan="8" class="empty">No placement officers on record.</td></tr>`;
        $('#poBody').querySelectorAll('[data-edit]').forEach(b =>
          b.onclick = () => placementOfficerForm(b.dataset.edit, draw));
        $('#poBody').querySelectorAll('[data-del]').forEach(b =>
          b.onclick = () => delConfirm('placementofficers', b.dataset.del, 'placement officer', draw));
        $('#poPager').innerHTML = pagerHtml(rows.length, page);
        bindPager($('#poPager'), rows.length, page, (p) => page = p, draw);
      };
      $('#poSearch').oninput = () => { page = 1; draw(); };
      $('#poAdd').onclick = () => placementOfficerForm(null, draw);
      draw();
    };
    return html;
  }

  /* ========================================================= */
  /*  BOOT                                                      */
  /* ========================================================= */
  /* The bar carries the name only — the role is already obvious from the menu
     the person is looking at, and beside the name it reads as a job title. */
  function paintUser() {
    const name = displayName(user);
    const photo = (loginRecord(user) || {}).photo;
    $('#topUserName').innerHTML = `<span class="uc-avatar">${photo
        ? `<img src="${esc(photo)}" alt="">`
        : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.5-8 5.5V21a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-3-3.6-5.5-8-5.5Z"/></svg>`
      }</span><span class="uc-name">${esc(name)}</span>`;
    $('#sideUser').innerHTML = `<span class="side-avatar">${photo
        ? `<img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : esc(name[0] || 'U')}</span>
      <span class="su-meta"><strong>${esc(name)}</strong><small>${
        esc(roleLabel(user.role))} · @${esc(user.username)}</small></span>`;
  }

  function startApp() {
    $('#loginScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    refreshPerms();
    paintUser();
    // a read-only session is flagged on <body> so the whole app can style itself
    document.body.classList.toggle('read-only', roleReadOnly());
    applyReadOnly();
    currentView = 'dashboard';
    buildNav();
    render();
    startDashboardPolling();
  }

  /* Everybody signed in can change their own password — the office should not
     be handing out replacements, and a shared demo password is only a demo
     password until somebody's real record is behind it. The current password
     is checked on the server, so the form cannot be talked out of it. */
  function changePasswordModal() {
    openModal('Change Password', `<form id="f">
      <p style="font-size:13px;color:var(--muted);margin:0 0 14px">
        Signed in as <b>${esc(user.username)}</b>. The new password needs at least 6 characters.</p>
      <div class="form-grid">
        <div class="field full"><label>Current Password</label>
          <input name="current" type="password" autocomplete="current-password" required></div>
        <div class="field full"><label>New Password</label>
          <input name="next" type="password" autocomplete="new-password" minlength="6" required></div>
        <div class="field full"><label>Confirm New Password</label>
          <input name="confirm" type="password" autocomplete="new-password" minlength="6" required></div>
      </div>
      <div class="form-actions"><button type="button" class="btn-outline" id="cx">Cancel</button>
        <button type="submit" class="btn-primary" id="pwSave">Change Password</button></div></form>`);
    $('#cx').onclick = closeModal;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (d.next !== d.confirm) { toast('The two new passwords do not match.', 'err'); return; }
      if (d.next.length < 6) { toast('The new password must be at least 6 characters.', 'err'); return; }
      const btn = $('#pwSave');
      btn.disabled = true; btn.textContent = 'Saving…';
      const res = await Store.changePassword(d.current, d.next);
      btn.disabled = false; btn.textContent = 'Change Password';
      if (res.error) { toast(res.error, 'err'); return; }
      closeModal();
      toast('Password changed. Use the new one next time you sign in.');
    };
  }

  async function init() {
    $('#year').textContent = new Date().getFullYear();
    $('#appYear').textContent = new Date().getFullYear();
    $('#loginForm').onsubmit = doLogin;
    $('#logoutBtn').onclick = logout;
    $('#pwdBtn').onclick = changePasswordModal;
    $('#modalClose').onclick = closeModal;
    $('#modal2Close').onclick = closeModal2;
    /* Clicking the sheet behind a dialog does nothing. A half-filled admission
       form is twenty minutes of typing, and the mouse slipping past the edge of
       the box was throwing all of it away without asking. The × and the Cancel
       button close a dialog; nothing else does. */
    $('#menuToggle').onclick = toggleSidebar;
    // apply saved collapsed preference (desktop)
    if (localStorage.getItem(SIDEBAR_KEY) === '1') document.body.classList.add('sidebar-collapsed');

    // restore session (re-fetch fresh data from server)
    const uid = Store.userId;
    if (uid) {
      try {
        await Store.load();
        const u = Store.find('users', uid);
        if (u) { user = u; startApp(); }
        else Store.setUser(null, null);
      } catch (e) { /* server down — stay on login screen */ }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
