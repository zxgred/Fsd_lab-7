# University API Access Management System
jQuery AJAX + Node.js + Express + MySQL (the database is created in XAMPP)

## 1. Create the database in XAMPP
1. Open the XAMPP Control Panel and click Start next to MySQL (Apache is not needed).
2. Click Admin next to MySQL (phpMyAdmin).
3. Click the Import tab > Choose File > select database.sql (project root) > Go.
   This creates the database university_api_db with 6 tables and the sample records:
   students, teachers, courses, marks, api_keys, api_usage_log.
   (Do this BEFORE the first start of the server.)

## 2. Run the Node.js / Express server (from inside the backend folder)
    cd backend
    npm install
    npm start

You will see:
    Connected to XAMPP MySQL, database ready: university_api_db
    University API running at http://localhost:3200

If the database is missing, the server tells you to import database.sql.
If MySQL is not running, it tells you to start MySQL in XAMPP.

## 3. Open the website (it is served by Express)
- http://localhost:3200/          Portal  (students and teachers)
- http://localhost:3200/settings  Settings (save your API key)
- http://localhost:3200/admin     Admin panel

Admin API key (predefined, set at the top of backend/server.js):
    UNI-ADMIN-2026-KEY

## How the keys work
- The admin generates a random key for a student or teacher (/admin).
- Only a SHA-256 hash of the key is stored in the api_keys table.
- Every request sends the key in the x-api-key header; the server looks the
  hash up in MySQL, checks the status and the request limit, then counts the
  request and writes it to api_usage_log.

## Status codes
200 OK | 201 Created | 400 Bad request | 401 Missing/invalid key
403 Forbidden (revoked key, wrong role, another student's record)
404 Not found | 409 Conflict (already has an active key) | 429 Limit reached
500 Server error

## Endpoints
Admin (admin key):
- GET    /api/admin/students
- GET    /api/admin/teachers
- GET    /api/admin/keys
- POST   /api/admin/keys                    generate a key
- PUT    /api/admin/keys/:id                update the request limit
- POST   /api/admin/keys/:id/reset-usage
- DELETE /api/admin/keys/:id                revoke
- GET    /api/admin/keys/:id/usage          usage log
Student / teacher (issued key):
- GET /api/me
- GET /api/students                         teachers only
- GET /api/students/:id                     teacher: any, student: own only
- GET /api/students/:id/marks               teacher: any, student: own only
- GET /api/marks[?student_id=]              teachers only

## Files
- database.sql        creates the database, tables and sample records in XAMPP
- backend/server.js   Express + mysql2: connection check, middleware, endpoints
- frontend/           index.html, style.css, script.js (jQuery AJAX)
