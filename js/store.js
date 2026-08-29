/* ===== Storage layer — talks to the Python/SQLite backend =====
   Keeps a synchronous in-memory cache so the UI code stays simple,
   and persists every change to the server (permanent SQLite DB). */
const API = '/api';

const Store = {
  data: { users: [], students: [], faculty: [], accountants: [], centerheads: [], courses: [],
          attendance: [], marks: [], fees: [], fixedfees: [], payments: [],
          assets: [], requisitions: [], timetable: [], books: [], issues: [],
          events: [], settings: [], placementofficers: [], companies: [], drives: [],
          applications: [], interviews: [], offers: [], placementevents: [],
          coordinators: [], admissions: [] },

  /* Who is calling. The token is what the server actually believes — it is
     minted at login, cannot be guessed, and is given up at logout. The id is
     kept alongside it only because the app reads it locally; the server no
     longer takes the id as proof of anything. */
  userId: sessionStorage.getItem('nmiet_user') || null,
  token: sessionStorage.getItem('nmiet_token') || null,
  setUser(id, token) {
    this.userId = id || null;
    if (id) sessionStorage.setItem('nmiet_user', id);
    else sessionStorage.removeItem('nmiet_user');
    if (token !== undefined) this.setToken(token);
  },
  setToken(token) {
    this.token = token || null;
    if (token) sessionStorage.setItem('nmiet_token', token);
    else sessionStorage.removeItem('nmiet_token');
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
    if (this.token) h['X-Auth-Token'] = this.token;
    if (this.userId) h['X-User-Id'] = this.userId;
    return h;
  },

  // load everything from the server into the cache
  async load() {
    const res = await fetch(`${API}/bootstrap`, { headers: this._headers() });
    /* The token was revoked, expired with a password change, or belongs to an
       account that has been switched off. Whatever the reason, this session is
       over — drop it so the app asks for a sign-in rather than showing a shell
       with no data in it. */
    if (res.status === 401) {
      this.setUser(null, null);
      throw new Error('unauthorised');
    }
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
      // 429: too many wrong passwords. The server's own message names the wait,
      // so it is shown rather than replaced with "invalid password" — which
      // would send somebody off retyping a password that was right.
      if (res.status === 429) {
        return { error: (data && data.message) || 'Too many attempts. Please wait a few minutes.' };
      }
      return { error: (data && data.message) || 'Invalid username or password.' };
    }
    // the one response that carries it; it is kept out of every other one
    if (data && data.token) this.setToken(data.token);
    return data;
  },

  /* Give the token up. The server forgets it, so anything still holding a copy
     — another tab, a stale phone — is a 401 from the next request on. */
  async logout() {
    try {
      if (this.token) {
        await fetch(`${API}/logout`, { method: 'POST', headers: this._headers() });
      }
    } catch (e) { /* signing out locally matters more than telling the server */ }
    this.setUser(null, null);
  },

  /* Changing your own password. The account is the one in the header, so this
     can only ever change the caller's own — and the current password is
     checked on the server, not here. Resolves to { ok } or { error }. */
  async changePassword(current, next) {
    try {
      const res = await fetch(`${API}/change-password`, {
        method: 'POST',
        headers: this._headers(true),
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { error: (data && data.message) || 'That could not be saved.' };
      // every other session is now signed out; this one carries on with the new token
      if (data && data.token) this.setToken(data.token);
      return { ok: true };
    } catch (e) {
      return { error: 'Could not reach the server.' };
    }
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
        const said = await res.json().catch(() => null);
        if (res.status === 403) this._fail('Not permitted — your role cannot change this record.');
        return { error: (said && said.message)
          || (res.status === 403 ? 'Not permitted.' : 'Server refused the upload.') };
      }
    } catch (e) {
      const ids = new Set(rows.map((r) => r.id));
      this.data[col] = this.all(col).filter((x) => !ids.has(x.id));
      return { error: 'Could not reach the server.' };
    }
    return rows;
  },

  // Create one row and wait for the server's answer, rather than the optimistic
  // add() above. Used where the server decides what the row actually contains
  // (a student applying to a drive) and where its refusal carries a message
  // the person needs to read.
  async createOne(col, obj) {
    try {
      const res = await fetch(`${API}/${col}`, {
        method: 'POST',
        headers: this._headers(true),
        body: JSON.stringify(obj),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        return { error: (data && data.message) || 'That could not be saved.' };
      }
      this.data[col].push(data);
      return data;
    } catch (e) {
      return { error: 'Could not reach the server.' };
    }
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
    if (res.status === 403) { this._fail('Not permitted — your role cannot change this record.'); return; }
    if (res.ok) return;
    /* A refusal usually says why — a duplicate registration number, a phone
       that is a digit short. Reading it beats "Save failed", which sends
       people looking for a network problem that isn't there. */
    res.json().then((d) => this._fail(d && d.message)).catch(() => this._fail());
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
