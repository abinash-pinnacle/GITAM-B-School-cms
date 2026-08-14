/* ===== Storage layer — talks to the Python/SQLite backend =====
   Keeps a synchronous in-memory cache so the UI code stays simple,
   and persists every change to the server (permanent SQLite DB). */
const API = '/api';

const Store = {
  data: { users: [], students: [], faculty: [], accountants: [], centerheads: [], courses: [],
          attendance: [], marks: [], fees: [], fixedfees: [], payments: [],
          assets: [], requisitions: [], timetable: [], books: [], issues: [],
          events: [], settings: [], placementofficers: [], companies: [], drives: [],
          applications: [], interviews: [], offers: [], placementevents: [] },

  /* The backend restricts financial collections to admin/accountant. It works
     out who is calling from this header, so every request carries it. */
  userId: sessionStorage.getItem('nmiet_user') || null,
  setUser(id) {
    this.userId = id || null;
    if (id) sessionStorage.setItem('nmiet_user', id);
    else sessionStorage.removeItem('nmiet_user');
  },

  /* View-only roles (center head). The server is the real gate — it answers 403
     to every write from such a role — but blocking here too means a stray call
     never desyncs the local cache from the database. */
  readOnly: false,
  /* The narrow carve-outs a read-only role still has, as { collection: [ops] }.
     The center head signs requisitions off — that one update is allowed here
     and by the server; everything else it sends is refused in both places. */
  readOnlyWritable: {},
  setReadOnly(on, writable) {
    this.readOnly = !!on;
    this.readOnlyWritable = writable || {};
  },
  _blocked(col, op) {
    if (!this.readOnly) return false;
    const ops = this.readOnlyWritable[col];
    if (ops && ops.indexOf(op) !== -1) return false;
    this._fail('Read-only access — your role cannot change this record.');
    return true;
  },
  _headers(json) {
    const h = json ? { 'Content-Type': 'application/json' } : {};
    if (this.userId) h['X-User-Id'] = this.userId;
    return h;
  },

  // load everything from the server into the cache
  async load() {
    const res = await fetch(`${API}/bootstrap`, { headers: this._headers() });
    if (!res.ok) throw new Error('bootstrap failed');
    this.data = await res.json();
    return this.data;
  },

  // server-side login — the account decides the role, the caller does not pick
  // one. Resolves to the user row, or to { error } with a message to show.
  async login(username, password) {
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // Only 401 means the credentials were wrong. A 5xx is the server or its
      // database failing, and showing that as "invalid password" sends people
      // off retyping a password that was right all along.
      if (res.status >= 500) {
        const detail = data && data.detail ? ` (${data.detail})` : '';
        return { error: `Server error — the database is unreachable.${detail}` };
      }
      return { error: (data && data.message) || 'Invalid username or password.' };
    }
    return data;
  },

  // ---- read (sync, from cache) ----
  all(col) { return this.data[col] || []; },
  find(col, id) { return this.all(col).find(x => x.id === id); },

  // ---- write (update cache now, persist in background) ----
  add(col, obj) {
    if (this._blocked(col, 'add')) return null;
    obj.id = obj.id || this._uid(col);
    this.data[col].push(obj);
    this._post(col, obj);
    return obj;
  },

  // Bulk insert for spreadsheet imports. Ids are worked out here rather than
  // on the server: the server has to probe for a free id one query at a time,
  // which is fine for a single row and painfully slow for three hundred.
  // Resolves to the rows written, or { error } if the server refused.
  async addMany(col, objs) {
    if (this._blocked(col, 'add')) return { error: 'Not permitted.' };
    const rows = [];
    for (const obj of objs) {
      obj.id = obj.id || this._uid(col);
      this.data[col].push(obj);   // pushed first, so the next id skips it
      rows.push(obj);
    }
    try {
      const res = await fetch(`${API}/${col}`, {
        method: 'POST',
        headers: this._headers(true),
        body: JSON.stringify(rows),
      });
      if (!res.ok) {
        // roll the cache back so the screen matches what was actually saved
        const ids = new Set(rows.map((r) => r.id));
        this.data[col] = this.all(col).filter((x) => !ids.has(x.id));
        this._check(res);
        return { error: res.status === 403 ? 'Not permitted.' : 'Server refused the upload.' };
      }
    } catch (e) {
      const ids = new Set(rows.map((r) => r.id));
      this.data[col] = this.all(col).filter((x) => !ids.has(x.id));
      return { error: 'Could not reach the server.' };
    }
    return rows;
  },

  update(col, id, patch) {
    if (this._blocked(col, 'update')) return null;
    const item = this.find(col, id);
    if (item) {
      Object.assign(item, patch);
      this._put(col, id, patch);
    }
    return item;
  },

  remove(col, id) {
    if (this._blocked(col, 'remove')) return;
    this.data[col] = this.all(col).filter(x => x.id !== id);
    this._delete(col, id);
  },

  // ---- background persistence ----
  _post(col, obj) {
    fetch(`${API}/${col}`, {
      method: 'POST',
      headers: this._headers(true),
      body: JSON.stringify(obj),
    }).then(r => this._check(r)).catch(() => this._fail());
  },
  _put(col, id, patch) {
    fetch(`${API}/${col}/${id}`, {
      method: 'PUT',
      headers: this._headers(true),
      body: JSON.stringify(patch),
    }).then(r => this._check(r)).catch(() => this._fail());
  },
  _delete(col, id) {
    fetch(`${API}/${col}/${id}`, { method: 'DELETE', headers: this._headers() })
      .then(r => this._check(r)).catch(() => this._fail());
  },
  // the server rejects writes from a role that may not make them
  _check(res) {
    if (res.status === 403) this._fail('Not permitted — your role cannot change this record.');
    else if (!res.ok) this._fail();
  },
  _fail(msg) {
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = msg || 'Save failed — is the server running?';
      t.className = 'toast err';
      setTimeout(() => t.classList.add('hidden'), 3200);
    }
  },

  // must stay in step with ID_PREFIX in api/config.php — the id is generated
  // here, so a collection missing from this map would silently get "X01"
  _uid(col) {
    const p = { students:'S', faculty:'F', courses:'C', attendance:'A',
                marks:'M', fees:'FE', timetable:'T', users:'u',
                books:'B', issues:'IS', events:'EV', settings:'SET',
                accountants:'AC', assets:'AS', fixedfees:'FF', payments:'PY',
                requisitions:'RQ', centerheads:'CH', placementofficers:'PO',
                companies:'CO', drives:'DR', applications:'AP',
                interviews:'IV', offers:'OF', placementevents:'PE',
                syllabus:'SY' }[col] || 'X';
    let n = 1, id;
    do { id = p + String(n).padStart(2, '0'); n++; } while (this.find(col, id));
    return id;
  },
};
