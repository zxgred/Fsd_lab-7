// backend/server.js - University API Access Management System
// Node.js + Express + MySQL (the database lives in XAMPP)
//
// Rules of this system:
//  - Admin endpoints (/api/admin/...) need the predefined ADMIN_API_KEY.
//  - Student / teacher endpoints need a key that the admin generated.
//    Those keys are random, stored (hashed) in MySQL, and checked in MySQL on every request.
//  - API keys are always sent in the "x-api-key" header.
//  - Every valid-key request is counted and logged in MySQL, and limits are enforced (429).

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = 3200;

// Predefined admin API key (used to open /admin and call /api/admin/...)
const ADMIN_API_KEY = "UNI-ADMIN-2026-KEY";

// ---------- MySQL connection (XAMPP defaults: user root, empty password) ----------
const DATABASE = "university_api_db";

const db = mysql.createPool({
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",            // <-- XAMPP root has no password by default
  database: DATABASE,
  waitForConnections: true,
  connectionLimit: 10
});

// ---------- Make sure the XAMPP database exists ----------
// The database is created in XAMPP (phpMyAdmin) by importing database.sql.
// The server only connects to it and checks that every table is there.
const TABLES = ["students", "teachers", "courses", "marks", "api_keys", "api_usage_log"];

async function checkDatabase() {
  try {
    for (const table of TABLES) {
      await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
    }
  } catch (err) {
    if (err.code === "ER_BAD_DB_ERROR" || err.code === "ER_NO_SUCH_TABLE") {
      throw new Error(
        `The database "${DATABASE}" (or one of its tables) was not found in XAMPP. ` +
        "Open phpMyAdmin, click Import, choose database.sql and click Go."
      );
    }
    throw err;
  }
  console.log("Connected to XAMPP MySQL, database ready:", DATABASE);
}

// ---------- Middleware ----------
// 1. Custom middleware: print the method and URL of every request
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});
app.use(cors({ exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining"] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

// The admin panel and the settings page are the same index.html (script.js shows the right view)
app.get(["/admin", "/settings"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// 2. Usage logging middleware: after the response is sent, save one row for every request made with a valid key
app.use("/api", (req, res, next) => {
  res.on("finish", async () => {
    if (!req.account) return;
    try {
      await db.query(
        "INSERT INTO api_usage_log (api_key_id, method, endpoint, status_code) VALUES (?, ?, ?, ?)",
        [req.account.keyId, req.method, req.originalUrl.slice(0, 255), res.statusCode]
      );
    } catch (err) {
      console.error("Could not save usage log:", err.message);
    }
  });
  next();
});

// ---------- Helpers ----------
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readKey(req) {
  return String(req.get("x-api-key") || "").trim();
}

function reply(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function serverProblem(res, err, message) {
  console.error(message, "-", err.message);
  return reply(res, 500, message);
}

function gradeFor(total) {
  if (total >= 85) return "A";
  if (total >= 70) return "B";
  if (total >= 60) return "C";
  if (total >= 50) return "D";
  return "F";
}

// Turns a marks row from MySQL into clean numbers with a total and a grade
function markRow(row) {
  const assignment = Number(row.assignment);
  const midterm = Number(row.midterm);
  const final_exam = Number(row.final_exam);
  const total = assignment + midterm + final_exam;
  return { ...row, assignment, midterm, final_exam, total, grade: gradeFor(total) };
}

const MARKS_SELECT = `
  SELECT m.id, m.student_id, s.roll_no, s.full_name AS student_name,
         c.code AS course_code, c.title AS course_title, c.credit_hours,
         t.full_name AS teacher_name, m.assignment, m.midterm, m.final_exam
  FROM marks m
  JOIN students s ON s.id = m.student_id
  JOIN courses c ON c.id = m.course_id
  JOIN teachers t ON t.id = m.teacher_id`;

// ---------- Middleware: admin key ----------
function requireAdminKey(req, res, next) {
  const key = readKey(req);
  if (!key) return reply(res, 401, "API key is missing. Send it in the x-api-key header.");

  const given = Buffer.from(key);
  const real = Buffer.from(ADMIN_API_KEY);
  if (given.length === real.length && crypto.timingSafeEqual(given, real)) return next();

  // Is it a student / teacher key? Then it is valid, but not allowed here (403)
  db.query("SELECT id FROM api_keys WHERE key_hash = ?", [sha256(key)])
    .then(([rows]) => {
      if (rows.length > 0) return reply(res, 403, "Student and teacher keys cannot use admin endpoints.");
      return reply(res, 401, "Invalid admin API key.");
    })
    .catch((err) => serverProblem(res, err, "Could not check the API key."));
}

// ---------- Middleware: student / teacher key (checked in MySQL) ----------
async function requireUserKey(req, res, next) {
  const key = readKey(req);
  if (!key) return reply(res, 401, "API key is missing. Send it in the x-api-key header.");

  try {
    // 1. Look the key up in the database (only the hash is stored)
    const [rows] = await db.query(
      `SELECT id, role, student_id, teacher_id, key_prefix, request_limit, requests_used, status
       FROM api_keys WHERE key_hash = ?`,
      [sha256(key)]
    );
    if (rows.length === 0) return reply(res, 401, "Invalid API key.");
    const found = rows[0];

    req.account = {
      keyId: found.id,
      role: found.role,
      studentId: found.student_id,
      teacherId: found.teacher_id,
      prefix: found.key_prefix,
      limit: found.request_limit,
      used: found.requests_used
    };
    res.set("X-RateLimit-Limit", String(found.request_limit));

    // 2. Revoked keys are blocked
    if (found.status !== "active") {
      res.set("X-RateLimit-Remaining", String(Math.max(found.request_limit - found.requests_used, 0)));
      return reply(res, 403, "This API key has been revoked. Ask the administrator for a new key.");
    }

    // 3. Count the request, but only if the limit is not reached yet (one atomic UPDATE)
    const [result] = await db.query(
      `UPDATE api_keys SET requests_used = requests_used + 1, last_used_at = NOW()
       WHERE id = ? AND status = 'active' AND requests_used < request_limit`,
      [found.id]
    );
    if (result.affectedRows === 0) {
      res.set("X-RateLimit-Remaining", "0");
      return reply(res, 429, "Request limit reached for this API key. Ask the administrator to increase the limit.");
    }

    req.account.used = found.requests_used + 1;
    res.set("X-RateLimit-Remaining", String(found.request_limit - req.account.used));
    next();
  } catch (err) {
    serverProblem(res, err, "Could not check the API key.");
  }
}

// ---------- Middleware: role permission ----------
function allowRoles(...roles) {
  return (req, res, next) => {
    if (roles.includes(req.account.role)) return next();
    return reply(res, 403, `This endpoint is only for ${roles.join(" / ")} API keys.`);
  };
}

// ---------- Middleware: students may only open their own record ----------
function ownRecordOrTeacher(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return reply(res, 400, "Student id must be a positive whole number.");
  if (req.account.role === "student" && id !== req.account.studentId) {
    return reply(res, 403, "Access denied. A student can only view their own records.");
  }
  next();
}

/* =====================================================
   ADMIN ENDPOINTS  (header: x-api-key = admin key)
===================================================== */
// GET /api/admin/students : all students, with API key information
app.get("/api/admin/students", requireAdminKey, async (req, res) => {
  try {
    const [students] = await db.query(
      `SELECT s.id, s.roll_no, s.full_name, s.email, s.department, s.semester,
              EXISTS(SELECT 1 FROM api_keys k WHERE k.student_id = s.id AND k.status = 'active') AS has_active_key
       FROM students s ORDER BY s.id`
    );
    res.json({ success: true, count: students.length, students: students.map((s) => ({ ...s, has_active_key: Boolean(s.has_active_key) })) });
  } catch (err) {
    serverProblem(res, err, "Could not read students.");
  }
});

// GET /api/admin/teachers : all teachers, with API key information
app.get("/api/admin/teachers", requireAdminKey, async (req, res) => {
  try {
    const [teachers] = await db.query(
      `SELECT t.id, t.employee_no, t.full_name, t.email, t.department,
              EXISTS(SELECT 1 FROM api_keys k WHERE k.teacher_id = t.id AND k.status = 'active') AS has_active_key
       FROM teachers t ORDER BY t.id`
    );
    res.json({ success: true, count: teachers.length, teachers: teachers.map((t) => ({ ...t, has_active_key: Boolean(t.has_active_key) })) });
  } catch (err) {
    serverProblem(res, err, "Could not read teachers.");
  }
});

// GET /api/admin/keys : every API key with its usage and status (the key itself is never shown)
app.get("/api/admin/keys", requireAdminKey, async (req, res) => {
  try {
    const [keys] = await db.query(
      `SELECT k.id, k.key_prefix, k.role, k.request_limit, k.requests_used, k.status,
              k.created_at, k.last_used_at, k.revoked_at,
              COALESCE(s.full_name, t.full_name) AS owner_name,
              COALESCE(s.roll_no, t.employee_no) AS owner_code
       FROM api_keys k
       LEFT JOIN students s ON s.id = k.student_id
       LEFT JOIN teachers t ON t.id = k.teacher_id
       ORDER BY k.id DESC`
    );
    res.json({ success: true, count: keys.length, keys });
  } catch (err) {
    serverProblem(res, err, "Could not read API keys.");
  }
});

// POST /api/admin/keys : generate a new random API key for a student or teacher
app.post("/api/admin/keys", requireAdminKey, async (req, res) => {
  const { role } = req.body || {};
  const userId = Number(req.body && req.body.user_id);
  const limit = Number(req.body && req.body.request_limit);

  if (role !== "student" && role !== "teacher") return reply(res, 400, "Role must be 'student' or 'teacher'.");
  if (!Number.isInteger(userId) || userId < 1) return reply(res, 400, "A valid user id is required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) return reply(res, 400, "Request limit must be a whole number from 1 to 100000.");

  const table = role === "student" ? "students" : "teachers";
  const column = role === "student" ? "student_id" : "teacher_id";

  try {
    const [users] = await db.query(`SELECT id, full_name FROM ${table} WHERE id = ?`, [userId]);
    if (users.length === 0) return reply(res, 404, `${role === "student" ? "Student" : "Teacher"} not found.`);

    const [existing] = await db.query(`SELECT id FROM api_keys WHERE ${column} = ? AND status = 'active'`, [userId]);
    if (existing.length > 0) return reply(res, 409, "This user already has an active key. Revoke it before generating a new one.");

    // Random key: prefix + 48 random hex characters. Only its hash goes into the database.
    const apiKey = (role === "student" ? "std_" : "tch_") + crypto.randomBytes(24).toString("hex");
    const [result] = await db.query(
      `INSERT INTO api_keys (key_hash, key_prefix, role, ${column}, request_limit) VALUES (?, ?, ?, ?, ?)`,
      [sha256(apiKey), apiKey.slice(0, 12), role, userId, limit]
    );

    res.status(201).json({
      success: true,
      message: `API key generated for ${users[0].full_name}. Copy it now: it will not be shown again.`,
      api_key: apiKey,
      key: { id: result.insertId, key_prefix: apiKey.slice(0, 12), role, request_limit: limit }
    });
  } catch (err) {
    serverProblem(res, err, "Could not generate the API key.");
  }
});

// PUT /api/admin/keys/:id : update the request limit of an active key
app.put("/api/admin/keys/:id", requireAdminKey, async (req, res) => {
  const id = Number(req.params.id);
  const limit = Number(req.body && req.body.request_limit);
  if (!Number.isInteger(id) || id < 1) return reply(res, 400, "Invalid key id.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) return reply(res, 400, "Request limit must be a whole number from 1 to 100000.");

  try {
    const [rows] = await db.query("SELECT status FROM api_keys WHERE id = ?", [id]);
    if (rows.length === 0) return reply(res, 404, "API key not found.");
    if (rows[0].status !== "active") return reply(res, 409, "A revoked key cannot be changed.");

    await db.query("UPDATE api_keys SET request_limit = ? WHERE id = ?", [limit, id]);
    res.json({ success: true, message: `Request limit updated to ${limit}.` });
  } catch (err) {
    serverProblem(res, err, "Could not update the request limit.");
  }
});

// POST /api/admin/keys/:id/reset-usage : set the used requests back to 0
app.post("/api/admin/keys/:id/reset-usage", requireAdminKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return reply(res, 400, "Invalid key id.");
  try {
    const [rows] = await db.query("SELECT status FROM api_keys WHERE id = ?", [id]);
    if (rows.length === 0) return reply(res, 404, "API key not found.");
    if (rows[0].status !== "active") return reply(res, 409, "A revoked key cannot be changed.");

    await db.query("UPDATE api_keys SET requests_used = 0 WHERE id = ?", [id]);
    res.json({ success: true, message: "Usage reset to 0." });
  } catch (err) {
    serverProblem(res, err, "Could not reset the usage.");
  }
});

// DELETE /api/admin/keys/:id : revoke a key (it stays in the table with status "revoked")
app.delete("/api/admin/keys/:id", requireAdminKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return reply(res, 400, "Invalid key id.");
  try {
    const [rows] = await db.query("SELECT status FROM api_keys WHERE id = ?", [id]);
    if (rows.length === 0) return reply(res, 404, "API key not found.");
    if (rows[0].status === "revoked") return reply(res, 409, "This key is already revoked.");

    await db.query("UPDATE api_keys SET status = 'revoked', revoked_at = NOW() WHERE id = ?", [id]);
    res.json({ success: true, message: "API key revoked." });
  } catch (err) {
    serverProblem(res, err, "Could not revoke the key.");
  }
});

// GET /api/admin/keys/:id/usage : the latest requests made with this key
app.get("/api/admin/keys/:id/usage", requireAdminKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return reply(res, 400, "Invalid key id.");
  try {
    const [rows] = await db.query("SELECT id FROM api_keys WHERE id = ?", [id]);
    if (rows.length === 0) return reply(res, 404, "API key not found.");

    const [usage] = await db.query(
      "SELECT id, method, endpoint, status_code, called_at FROM api_usage_log WHERE api_key_id = ? ORDER BY id DESC LIMIT 25",
      [id]
    );
    res.json({ success: true, count: usage.length, usage });
  } catch (err) {
    serverProblem(res, err, "Could not read the usage log.");
  }
});

/* =====================================================
   STUDENT + TEACHER ENDPOINTS  (header: x-api-key = issued key)
===================================================== */
// GET /api/me : who owns this key (student or teacher) + usage of the key
app.get("/api/me", requireUserKey, async (req, res) => {
  try {
    const isStudent = req.account.role === "student";
    const [rows] = isStudent
      ? await db.query("SELECT id, roll_no, full_name, email, department, semester FROM students WHERE id = ?", [req.account.studentId])
      : await db.query("SELECT id, employee_no, full_name, email, department FROM teachers WHERE id = ?", [req.account.teacherId]);
    if (rows.length === 0) return reply(res, 404, "The owner of this key no longer exists.");

    res.json({
      success: true,
      role: req.account.role,
      profile: rows[0],
      key: {
        prefix: req.account.prefix,
        request_limit: req.account.limit,
        requests_used: req.account.used,
        remaining: req.account.limit - req.account.used
      }
    });
  } catch (err) {
    serverProblem(res, err, "Could not read your profile.");
  }
});

// GET /api/students : all students (teachers only)
app.get("/api/students", requireUserKey, allowRoles("teacher"), async (req, res) => {
  try {
    const [students] = await db.query("SELECT id, roll_no, full_name, email, department, semester FROM students ORDER BY id");
    res.json({ success: true, count: students.length, students });
  } catch (err) {
    serverProblem(res, err, "Could not read students.");
  }
});

// GET /api/students/:id : one student (teacher: any, student: only their own)
app.get("/api/students/:id", requireUserKey, ownRecordOrTeacher, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, roll_no, full_name, email, department, semester FROM students WHERE id = ?",
      [Number(req.params.id)]
    );
    if (rows.length === 0) return reply(res, 404, "Student not found.");
    res.json({ success: true, student: rows[0] });
  } catch (err) {
    serverProblem(res, err, "Could not read the student.");
  }
});

// GET /api/students/:id/marks : marks of one student (teacher: any, student: only their own)
app.get("/api/students/:id/marks", requireUserKey, ownRecordOrTeacher, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [students] = await db.query("SELECT id, roll_no, full_name FROM students WHERE id = ?", [id]);
    if (students.length === 0) return reply(res, 404, "Student not found.");

    const [rows] = await db.query(`${MARKS_SELECT} WHERE m.student_id = ? ORDER BY c.code`, [id]);
    res.json({ success: true, student: students[0], count: rows.length, marks: rows.map(markRow) });
  } catch (err) {
    serverProblem(res, err, "Could not read the marks.");
  }
});

// GET /api/marks : marks of all students (teachers only). Optional filter: ?student_id=3
app.get("/api/marks", requireUserKey, allowRoles("teacher"), async (req, res) => {
  try {
    let rows;
    if (req.query.student_id !== undefined) {
      const sid = Number(req.query.student_id);
      if (!Number.isInteger(sid) || sid < 1) return reply(res, 400, "student_id must be a positive whole number.");
      [rows] = await db.query(`${MARKS_SELECT} WHERE m.student_id = ? ORDER BY c.code`, [sid]);
    } else {
      [rows] = await db.query(`${MARKS_SELECT} ORDER BY s.id, c.code`);
    }
    res.json({ success: true, count: rows.length, marks: rows.map(markRow) });
  } catch (err) {
    serverProblem(res, err, "Could not read the marks.");
  }
});

// ---------- Unknown routes and bad JSON ----------
app.use("/api", (req, res) => reply(res, 404, "API route not found."));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return reply(res, 400, "The request body is not valid JSON.");
  console.error(err.message);
  reply(res, 500, "Unexpected server error.");
});

// ---------- Start: check the XAMPP database first, then listen ----------
checkDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`University API running at http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin   (admin key: ${ADMIN_API_KEY})`);
    });
  })
  .catch((err) => {
    if (err.code === "ECONNREFUSED") {
      console.error("Could not connect to MySQL. Start MySQL in the XAMPP Control Panel, then run the server again.");
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
