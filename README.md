# GITAM B-School College Management System

GITAM (Bhubaneswar) ka college management system — **real backend + permanent database** ke saath.

> Campus image (`assets/campus-building.webp`) GITAM B-School campus ki photo hai.

- **Frontend:** HTML + CSS + vanilla JavaScript (GITAM green + Pinnacle teal theme)
- **Backend:** PHP 8 (PDO — koi framework/composer package nahi)
- **Database:** SQLite (`gitam.db`) by default; MySQL ya PostgreSQL bhi support hai — data **permanently** save hota hai, browser clear karne pe bhi nahi jata

> Sirf PHP 8+ chahiye (XAMPP ke saath already aata hai). Koi composer install nahi.

## Kaise chalayein

**Option 1 — PHP ka built-in server (sabse aasaan):**

```bash
php -S localhost:5500 router.php
```

Browser me kholo **http://localhost:5500** — band karne ke liye `Ctrl + C`.

**Option 2 — Docker (PHP install kiye bina):**

```bash
docker run --rm -p 5503:5503 -v "D:/GITAM CLONE:/app" -w /app php:8.3-cli php -S 0.0.0.0:5503 router.php
```

Browser me kholo **http://localhost:5503**.

**Option 3 — XAMPP / Apache:**

Poore folder ko `C:\xampp\htdocs\gitam` me rakho, Apache start karo, aur kholo
**http://localhost/gitam/** . `api/.htaccess` khud `/api/...` requests ko
`api/index.php` pe bhej deta hai (`mod_rewrite` on hona chahiye).

Pehli baar chalane par `gitam.db` automatically ban jata hai aur demo data se bhar jata hai.

### MySQL use karna ho (XAMPP wala)

Environment variables set kar do — table aur database khud ban jaate hain:

```bash
DB_BACKEND=mysql DB_HOST=localhost DB_NAME=gitam DB_USER=root DB_PASS= php -S localhost:5500 router.php
```

Windows PowerShell me:

```powershell
$env:DB_BACKEND="mysql"; $env:DB_USER="root"; php -S localhost:5500 router.php
```

## Docker se chalana (4 containers + phpMyAdmin)

Docker me app **4 alag containers** me chalta hai:

| Container | Kaam | Tech |
|---|---|---|
| 🟦 `gitam-frontend` | UI serve + `/api` proxy | Nginx |
| 🟩 `gitam-backend` | REST API | PHP + Apache |
| 🟨 `gitam-db` | Database | MySQL 8 |
| 🟧 `gitam-phpmyadmin` | Database ka web UI | phpMyAdmin |

```
docker compose up -d --build      # sab build + start
```

- App: **http://localhost:5500**
- phpMyAdmin: **http://localhost:8091** (seedha khul jata hai — `gitam` database left sidebar me)

```
docker compose ps                 # saare containers dekho
docker compose logs -f backend    # kisi container ke logs
docker compose down               # sab band (database volume safe rehta hai)
```

**Docker Desktop me kahan dikhega:**
- **Containers** tab → `gitam-frontend`, `gitam-backend`, `gitam-db`, `gitam-phpmyadmin`
- **Volumes** tab → `gitam_gitam-mysqldata` (MySQL ka data — restart/rebuild pe bhi safe)

**Flow:** browser → `gitam-frontend` (Nginx) → `gitam-backend` (PHP API) → `gitam-db` (MySQL). phpMyAdmin seedha `gitam-db` se baat karta hai.

**DB credentials (demo):** database `gitam`, user `gitam` / password `gitam`, root password `root`.

- **Note:** Docker me **MySQL** use hota hai (apna data, volume me). Local `php -S` me **SQLite** (`gitam.db`) use hota hai — dono databases alag hote hain. Code khud detect karta hai (`DB_BACKEND` / `PGHOST` / `MYSQL_HOST` set ho to wahi driver, warna SQLite). PostgreSQL bhi supported hai (`DB_BACKEND=pgsql`) — backend image me `pdo_mysql` aur `pdo_pgsql` dono hote hain.

## Database ka data ek backend se doosre me le jaana

`tools/db-transfer.php` poora data JSON me export/import karta hai, to SQLite → MySQL → PostgreSQL kisi bhi taraf le ja sakte ho:

```bash
php tools/db-transfer.php export dump.json
```

Phir target database ke env ke saath import karo (yahan Docker wala MySQL):

```bash
docker run --rm --network gclone_default -v "%cd%:/app" -w /app -e DB_BACKEND=mysql -e DB_HOST=db -e DB_USER=gitam -e DB_PASS=gitam gclone-backend php tools/db-transfer.php import dump.json
```

Import same `id` wali rows ko replace karta hai, isliye dobara chalane se duplicate nahi bante.

## Demo Logins

| Role     | Username  | Password   |
|----------|-----------|------------|
| Admin    | `admin`   | `admin123` |
| Faculty  | `rmehta`  | `pass123`  |
| Student  | `2025180001` | `2025180001` (student ka password uska Student ID hi hai) |
| Accounts | `accounts` | `pass123` |

> Role chunne ki zaroorat nahi — login ke account se role apne aap tay hota hai.
> Live site par in demo passwords ko turant badal dein.

## Features (Modules)

| Module | Admin | Faculty | Student |
|--------|:---:|:---:|:---:|
| Dashboard (stats, overview)        | ✅ | ✅ | ✅ (personal) |
| Students (add/edit/delete, search) | ✅ | 👁 view | — |
| Faculty management                 | ✅ | — | — |
| Courses management                 | ✅ | — | — |
| Assignments overview (class→faculty)| ✅ | — | — |
| Attendance (mark + %)              | ✅ | ✅ | 👁 own |
| Marks & Results (auto grade/GPA)   | ✅ | ✅ | 👁 report card |
| Timetable (weekly grid)            | ✅ edit | 👁 | 👁 own class |
| Library (books, issue/return)      | ✅ | — | 👁 My Library |
| Fees (record payments, status)     | ✅ | — | 👁 own |
| ID Card + Marksheet (print/PDF)    | ✅ any student | — | ✅ own |
| Profile                            | — | ✅ | ✅ |

Saara data add/edit/delete turant SQLite database me save hota hai.

**Class Assignment (Admin → Faculty):** Courses module me admin har course ko **faculty + branch + semester + section** assign karta hai. Ya phir seedha **Faculty page** se kisi faculty ke saamne **📚 Classes** button dabao — ek modal me uski assigned classes dikhti hain jahan se **assign / unassign / nayi class create** kar sakte ho. Faculty ko sirf uski **assigned classes** dikhti hain — uska dashboard "My Assigned Classes" list dikhata hai, aur Attendance/Marks me sirf usi section ke students aate hain. (Demo: ek hi subject DSA — Sec A → Dr. Rajesh Mehta, Sec B → Prof. S. Venkat.)

**Library:** books ka catalogue, kisi student ko book issue karna (14 din ki due date auto), return karna, availability auto-track, overdue highlight. Student apni borrowed books "My Library" me dekh sakta hai.

**ID Card / Marksheet:** Student apne profile se ID card aur "My Results" se marksheet print/PDF kar sakta hai. Admin kisi bhi student ka ID card / marksheet Students table ke 🪪 ID / 📄 Sheet buttons se nikaal sakta hai. (Print dialog me "Save as PDF" choose karo. Popup allow karna zaroori hai.)

**Theme:** GITAM B-School logo (GITAM green + Pinnacle teal/maroon) se match karta hua theme.

## Grading Scale

| Total (/100) | Grade | Points |
|---|---|---|
| 90+ | O  | 10 |
| 80–89 | A+ | 9 |
| 70–79 | A  | 8 |
| 60–69 | B+ | 7 |
| 50–59 | B  | 6 |
| 40–49 | C  | 5 |
| <40   | F  | 0 |

GPA = Σ(grade points × credits) / Σ(credits). Attendance < 75% par warning aata hai.

## Project Structure

```
api/index.php      → PHP backend: REST API routes (login, bootstrap, CRUD)
api/db.php         → PDO layer: connect, create tables, migrate, seed
api/config.php     → schema (collections/columns), demo seed data, DB env config
api/.htaccess      → Apache rewrite: /api/... → api/index.php
router.php         → router for `php -S` (API + static files)
tools/db-transfer.php → data export/import (SQLite ↔ MySQL ↔ PostgreSQL)
gitam.db           → SQLite database (auto-created on first run)
index.html         → login + app shell
css/styles.css     → GITAM theme
js/store.js        → talks to the backend API (with in-memory cache)
js/app.js          → auth, navigation, all modules
assets/            → GITAM B-School logo, PWA icons + campus image
composer.json      → PHP requirements (PDO + JSON) — install ki zaroorat nahi
Dockerfile         → single container image (PHP 8.3 + Apache + SQLite)
docker-compose.yml → 4-container setup (Nginx + PHP API + MySQL + phpMyAdmin)
.dockerignore      → keeps the image small / DB out of the image
.claude/launch.json→ preview-server config (for Claude Code)
server.py          → purana Python backend (ab use nahi hota; delete kar sakte ho)
```

## REST API (backend)

| Method | Route | Kaam |
|---|---|---|
| GET  | `/api/health` | server zinda hai ya nahi |
| POST | `/api/login` | username + password + role verify |
| GET  | `/api/bootstrap` | saara data ek saath |
| GET  | `/api/<collection>` | list (students, faculty, courses, books, issues, ...) |
| POST | `/api/<collection>` | naya record |
| PUT  | `/api/<collection>/<id>` | record update |
| DELETE | `/api/<collection>/<id>` | record delete |

## Database reset

Demo data wapas laana ho to server band karke `gitam.db` file delete kar do, phir server dobara chalao — naya DB apne aap ban jayega. (MySQL/Postgres me `gitam` database drop kar do.)

Schema me naya column add karo (`api/config.php` ke `COLLECTIONS` me) to next request pe woh column automatically table me add ho jata hai — DB delete karne ki zaroorat nahi.

## Note (logo & images)

Logo (`assets/gitam-logo.png`) GITAM B-School ka hai — GITAM & Pinnacle HR ka joint venture. Campus image (`assets/campus-building.webp`) college building ki photo hai.
