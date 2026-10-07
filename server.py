#!/usr/bin/env python3
"""
GITAM B-School College Management System - Backend (API)

Dual database mode:
  * Local / single container  -> SQLite  (default, zero setup: `python server.py`)
  * Multi-container (Docker)   -> PostgreSQL when PGHOST / DB_BACKEND=postgres is set

The same code serves the REST API (/api/*) and, as a fallback, the static
frontend. In the 3-container setup Nginx serves the frontend and proxies /api
here, and PostgreSQL runs as its own container.
"""
import json
import os
import re
import time
import sqlite3
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("GITAM_DB") or os.path.join(BASE_DIR, "gitam.db")
PORT = int(os.environ.get("PORT", "5500"))

# Use PostgreSQL when running as a separate DB container, else SQLite.
USE_PG = os.environ.get("DB_BACKEND", "").lower() == "postgres" or bool(os.environ.get("PGHOST"))
PG = {
    "host": os.environ.get("PGHOST", "db"),
    "port": os.environ.get("PGPORT", "5432"),
    "dbname": os.environ.get("PGDATABASE", "gitam"),
    "user": os.environ.get("PGUSER", "gitam"),
    "password": os.environ.get("PGPASSWORD", "gitam"),
}
if USE_PG:
    import psycopg2
    import psycopg2.extras

# ---- collection -> table columns (id is always first / primary key) ----
COLLECTIONS = {
    "users":      ["id", "username", "password", "role", "refId", "name"],
    "students":   ["id", "roll", "name", "email", "phone", "branch", "year", "semester", "section", "photo"],
    "faculty":    ["id", "empId", "name", "email", "phone", "department", "designation", "photo"],
    "courses":    ["id", "code", "name", "branch", "semester", "credits", "facultyId", "section"],
    "attendance": ["id", "courseId", "date", "records"],   # records = JSON object
    "marks":      ["id", "studentId", "courseId", "internal", "external"],
    "fees":       ["id", "studentId", "total", "paid", "dueDate"],
    "timetable":  ["id", "branch", "semester", "section", "day", "period", "courseId"],
    "books":      ["id", "title", "author", "isbn", "category", "total", "available"],
    "issues":     ["id", "bookId", "studentId", "issueDate", "dueDate", "returnDate"],
    "events":     ["id", "title", "date", "description", "createdBy"],
}
JSON_FIELDS = {"attendance": ["records"]}
ID_PREFIX = {"students": "S", "faculty": "F", "courses": "C", "attendance": "A",
             "marks": "M", "fees": "FE", "timetable": "T", "users": "u",
             "books": "B", "issues": "IS", "events": "EV"}

# ---------------------------------------------------------------- seed data
SEED = {
    "users": [
        ["u1", "admin", "admin123", "admin", None, "System Admin"],
        ["u2", "rmehta", "pass123", "faculty", "F01", "Dr. Rajesh Mehta"],
        ["u3", "svenkat", "pass123", "faculty", "F02", "Prof. S. Venkat"],
        ["u4", "21CS001", "pass123", "student", "S01", "Aarav Sharma"],
        ["u5", "21CS002", "pass123", "student", "S02", "Diya Patel"],
    ],
    "faculty": [
        ["F01", "NM-F-1001", "Dr. Rajesh Mehta", "rmehta@gitambschool.edu", "9876500011", "Computer Science", "Professor"],
        ["F02", "NM-F-1002", "Prof. S. Venkat", "svenkat@gitambschool.edu", "9876500012", "Computer Science", "Associate Professor"],
        ["F03", "NM-F-1003", "Dr. Meera Krishnan", "meera@gitambschool.edu", "9876500013", "Electronics", "Assistant Professor"],
        ["F04", "NM-F-1004", "Dr. Anil Kapoor", "anil@gitambschool.edu", "9876500014", "Mechanical", "Professor"],
    ],
    "students": [
        ["S01", "21CS001", "Aarav Sharma", "aarav@gitambschool.in", "9810000001", "CSE", 3, 5, "A"],
        ["S02", "21CS002", "Diya Patel", "diya@gitambschool.in", "9810000002", "CSE", 3, 5, "A"],
        ["S03", "21CS003", "Rohan Verma", "rohan@gitambschool.in", "9810000003", "CSE", 3, 5, "A"],
        ["S04", "21CS004", "Ananya Iyer", "ananya@gitambschool.in", "9810000004", "CSE", 3, 5, "B"],
        ["S05", "21EC001", "Karan Singh", "karan@gitambschool.in", "9810000005", "ECE", 2, 3, "A"],
        ["S06", "21ME001", "Ishita Nair", "ishita@gitambschool.in", "9810000006", "ME", 2, 3, "A"],
    ],
    "courses": [
        ["C01", "CS501", "Data Structures & Algorithms", "CSE", 5, 4, "F01", "A"],
        ["C02", "CS502", "Database Management Systems", "CSE", 5, 4, "F02", "A"],
        ["C03", "CS503", "Operating Systems", "CSE", 5, 3, "F01", "A"],
        ["C04", "EC301", "Digital Electronics", "ECE", 3, 4, "F03", "A"],
        ["C05", "ME301", "Thermodynamics", "ME", 3, 4, "F04", "A"],
        ["C06", "CS501", "Data Structures & Algorithms", "CSE", 5, 4, "F02", "B"],
    ],
    "attendance": [
        ["A01", "C01", "2026-06-15", json.dumps({"S01": "P", "S02": "P", "S03": "A", "S04": "P"})],
        ["A02", "C01", "2026-06-16", json.dumps({"S01": "P", "S02": "A", "S03": "P", "S04": "P"})],
        ["A03", "C02", "2026-06-16", json.dumps({"S01": "P", "S02": "P", "S03": "P", "S04": "A"})],
    ],
    "marks": [
        ["M01", "S01", "C01", 34, 52],
        ["M02", "S01", "C02", 30, 48],
        ["M03", "S02", "C01", 28, 40],
        ["M04", "S03", "C01", 22, 33],
    ],
    "fees": [
        ["FE01", "S01", 185000, 185000, "2026-07-31"],
        ["FE02", "S02", 185000, 100000, "2026-07-31"],
        ["FE03", "S03", 185000, 0, "2026-07-31"],
        ["FE04", "S04", 185000, 185000, "2026-07-31"],
        ["FE05", "S05", 165000, 80000, "2026-07-31"],
        ["FE06", "S06", 165000, 165000, "2026-07-31"],
    ],
    "timetable": [
        ["T01", "CSE", 5, "A", "Mon", 1, "C01"],
        ["T02", "CSE", 5, "A", "Mon", 2, "C02"],
        ["T03", "CSE", 5, "A", "Tue", 1, "C03"],
        ["T04", "CSE", 5, "A", "Wed", 2, "C01"],
        ["T05", "CSE", 5, "A", "Thu", 1, "C02"],
        ["T06", "CSE", 5, "A", "Fri", 3, "C03"],
    ],
    "books": [
        ["B01", "Introduction to Algorithms", "Cormen, Leiserson, Rivest", "9780262033848", "Computer Science", 5, 4],
        ["B02", "Database System Concepts", "Silberschatz, Korth", "9780073523323", "Computer Science", 4, 4],
        ["B03", "Operating System Concepts", "Silberschatz, Galvin", "9781118063330", "Computer Science", 3, 2],
        ["B04", "Digital Design", "M. Morris Mano", "9780132774208", "Electronics", 4, 4],
        ["B05", "Engineering Thermodynamics", "P. K. Nag", "9780070151314", "Mechanical", 3, 3],
        ["B06", "The C Programming Language", "Kernighan & Ritchie", "9780131103627", "Computer Science", 6, 5],
    ],
    "issues": [
        ["IS01", "B01", "S01", "2026-06-10", "2026-06-24", ""],
        ["IS02", "B03", "S02", "2026-06-05", "2026-06-19", ""],
    ],
    "events": [
        ["EV01", "Annual Tech Fest", "2026-09-12", "Inter-college technical festival with coding, robotics and paper-presentation events.", "u1"],
        ["EV02", "Mid-Semester Exams Begin", "2026-08-18", "Mid-sem exams for all branches start from this date. Check timetable for schedule.", "u1"],
    ],
}


# ============================================================ DB abstraction
def connect():
    if USE_PG:
        return psycopg2.connect(**PG)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def q(sql):
    """Adapt '?' placeholders to '%s' for PostgreSQL."""
    return sql.replace("?", "%s") if USE_PG else sql


def fetch_all(conn, sql, params=()):
    if USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    else:
        cur = conn.cursor()
    cur.execute(q(sql), params)
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]


def fetch_one(conn, sql, params=()):
    rows = fetch_all(conn, sql, params)
    return rows[0] if rows else None


def run(conn, sql, params=()):
    cur = conn.cursor()
    cur.execute(q(sql), params)
    cur.close()


def init_db():
    if not USE_PG:
        parent = os.path.dirname(DB_PATH)
        if parent:
            os.makedirs(parent, exist_ok=True)

    # PostgreSQL container may take a moment to accept connections
    conn = None
    for attempt in range(30):
        try:
            conn = connect()
            break
        except Exception as e:
            if not USE_PG:
                raise
            print(f"Waiting for PostgreSQL... ({attempt + 1})")
            time.sleep(2)
    if conn is None:
        raise RuntimeError("Could not connect to the database.")

    for col, fields in COLLECTIONS.items():
        cols_sql = ", ".join(f'"{f}" TEXT' if i else f'"{f}" TEXT PRIMARY KEY'
                             for i, f in enumerate(fields))
        run(conn, f'CREATE TABLE IF NOT EXISTS {col} ({cols_sql})')
        # migrate: add any columns present in COLLECTIONS but missing in the table
        if USE_PG:
            existing = {r["column_name"] for r in fetch_all(
                conn, "SELECT column_name FROM information_schema.columns WHERE table_name=?", (col,))}
        else:
            existing = {r["name"] for r in fetch_all(conn, f'PRAGMA table_info({col})')}
        for f in fields:
            if f not in existing:
                run(conn, f'ALTER TABLE {col} ADD COLUMN "{f}" TEXT')
                print(f"Migrated: added '{col}.{f}'")
    conn.commit()

    # seed each table only if empty
    for col, rows in SEED.items():
        cnt = fetch_one(conn, f"SELECT COUNT(*) AS c FROM {col}")["c"]
        if cnt == 0:
            ph = ", ".join("?" * len(COLLECTIONS[col]))
            for row in rows:
                run(conn, f"INSERT INTO {col} VALUES ({ph})", row)
            print(f"Seeded '{col}' with demo data.")

    # course section assignment: backfill blanks + ensure the demo Sec-B class
    run(conn, "UPDATE courses SET section='A' WHERE section IS NULL OR section=''")
    c06 = ("C06", "CS501", "Data Structures & Algorithms", "CSE", 5, 4, "F02", "B")
    if USE_PG:
        run(conn, "INSERT INTO courses VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING", c06)
    else:
        run(conn, "INSERT OR IGNORE INTO courses VALUES (?,?,?,?,?,?,?,?)", c06)
    conn.commit()
    conn.close()
    print(f"Database ready ({'PostgreSQL' if USE_PG else 'SQLite'}).")


def row_to_dict(col, d):
    d = dict(d)
    for f in JSON_FIELDS.get(col, []):
        if d.get(f):
            try:
                d[f] = json.loads(d[f])
            except Exception:
                d[f] = {}
    for f in ("year", "semester", "credits", "internal", "external", "total", "paid", "period", "available"):
        if f in d and d[f] is not None and d[f] != "":
            try:
                d[f] = int(d[f])
            except (ValueError, TypeError):
                pass
    return d


def next_id(conn, col):
    prefix = ID_PREFIX.get(col, "X")
    n = 1
    while True:
        idv = f"{prefix}{n:02d}"
        if not fetch_one(conn, f"SELECT 1 AS x FROM {col} WHERE id=?", (idv,)):
            return idv
        n += 1


def serialize_value(col, field, value):
    if field in JSON_FIELDS.get(col, []) and not isinstance(value, str):
        return json.dumps(value)
    return value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    # ---------- routing ----------
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/bootstrap":
            return self.bootstrap()
        m = re.match(r"^/api/(\w+)$", path)
        if m and m.group(1) in COLLECTIONS:
            return self.list_collection(m.group(1))
        return self.serve_static(path)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/login":
            return self.login()
        m = re.match(r"^/api/(\w+)$", path)
        if m and m.group(1) in COLLECTIONS:
            return self.create(m.group(1))
        self.send_json({"error": "not found"}, 404)

    def do_PUT(self):
        m = re.match(r"^/api/(\w+)/([\w\-]+)$", self.path.split("?")[0])
        if m and m.group(1) in COLLECTIONS:
            return self.update(m.group(1), m.group(2))
        self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        m = re.match(r"^/api/(\w+)/([\w\-]+)$", self.path.split("?")[0])
        if m and m.group(1) in COLLECTIONS:
            return self.delete(m.group(1), m.group(2))
        self.send_json({"error": "not found"}, 404)

    # ---------- API actions ----------
    def bootstrap(self):
        conn = connect()
        try:
            out = {col: [row_to_dict(col, r) for r in fetch_all(conn, f"SELECT * FROM {col}")]
                   for col in COLLECTIONS}
        finally:
            conn.close()
        self.send_json(out)

    def list_collection(self, col):
        conn = connect()
        try:
            rows = [row_to_dict(col, r) for r in fetch_all(conn, f"SELECT * FROM {col}")]
        finally:
            conn.close()
        self.send_json(rows)

    def login(self):
        d = self.read_body()
        conn = connect()
        try:
            row = fetch_one(
                conn,
                "SELECT * FROM users WHERE LOWER(username)=LOWER(?) AND password=? AND role=?",
                (d.get("username", ""), d.get("password", ""), d.get("role", "")),
            )
        finally:
            conn.close()
        if not row:
            return self.send_json({"error": "invalid"}, 401)
        self.send_json(row_to_dict("users", row))

    def create(self, col):
        d = self.read_body()
        fields = COLLECTIONS[col]
        conn = connect()
        try:
            if not d.get("id"):
                d["id"] = next_id(conn, col)
            values = [serialize_value(col, f, d.get(f)) for f in fields]
            placeholders = ", ".join(["?"] * len(fields))
            if USE_PG:
                updates = ", ".join(f'"{f}"=EXCLUDED."{f}"' for f in fields if f != "id")
                sql = f'INSERT INTO {col} VALUES ({placeholders}) ON CONFLICT (id) DO UPDATE SET {updates}'
            else:
                sql = f'INSERT OR REPLACE INTO {col} VALUES ({placeholders})'
            run(conn, sql, values)
            conn.commit()
        finally:
            conn.close()
        self.send_json(d, 201)

    def update(self, col, idv):
        d = self.read_body()
        fields = [f for f in COLLECTIONS[col] if f != "id" and f in d]
        if not fields:
            return self.send_json({"error": "no fields"}, 400)
        sets = ", ".join(f'"{f}"=?' for f in fields)
        values = [serialize_value(col, f, d[f]) for f in fields] + [idv]
        conn = connect()
        try:
            run(conn, f"UPDATE {col} SET {sets} WHERE id=?", values)
            conn.commit()
        finally:
            conn.close()
        self.send_json({"ok": True, "id": idv})

    def delete(self, col, idv):
        conn = connect()
        try:
            run(conn, f"DELETE FROM {col} WHERE id=?", (idv,))
            conn.commit()
        finally:
            conn.close()
        self.send_json({"ok": True})

    # ---------- static files (fallback; Nginx serves these in multi-container) ----------
    def serve_static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        path = path.lstrip("/")
        full = os.path.normpath(os.path.join(BASE_DIR, path))
        if not full.startswith(BASE_DIR) or not os.path.isfile(full):
            self.send_json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.send_json({"error": "read error"}, 500)


if __name__ == "__main__":
    init_db()
    print(f"GITAM CMS backend on  http://localhost:{PORT}  (DB: {'PostgreSQL' if USE_PG else 'SQLite'})")
    print("Press Ctrl+C to stop.")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
