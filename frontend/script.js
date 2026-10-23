// script.js - University API Access Management System (jQuery + AJAX only)
// One page file, three views chosen by the address: / (portal), /settings, /admin
// Every request sends the API key in the "x-api-key" header.

$(document).ready(function () {
  "use strict";

  /* =====================================================
     SETTINGS AND STATE
  ===================================================== */
  const API = location.port === "3200" ? "" : "http://localhost:3200";
  const USER_KEY_STORE = "uni_user_api_key";     // student / teacher key (saved in Settings)
  const ADMIN_KEY_STORE = "uni_admin_api_key";   // admin key (kept only while the tab is open)

  let adminKey = null;
  let adminData = { students: [], teachers: [], keys: [] };
  let teacherStudents = [];
  let toastTimer = null;

  const TESTER_PRESETS = [
    { label: "My profile  ·  GET /api/me", path: "/api/me" },
    { label: "All students  ·  GET /api/students", path: "/api/students" },
    { label: "One student  ·  GET /api/students/{id}", path: "/api/students/{id}" },
    { label: "Student marks  ·  GET /api/students/{id}/marks", path: "/api/students/{id}/marks" },
    { label: "All marks  ·  GET /api/marks", path: "/api/marks" },
    { label: "Marks of one student  ·  GET /api/marks?student_id={id}", path: "/api/marks?student_id={id}" }
  ];

  /* =====================================================
     REUSABLE HELPERS
  ===================================================== */
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showToast(text, isBad) {
    const $t = $("#toast");
    $t.text(text).toggleClass("bad", Boolean(isBad)).addClass("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $t.removeClass("show"); }, 3200);
  }

  // One function for every request: the key goes into the x-api-key header
  function callApi(key, method, path, body) {
    const options = { url: API + path, method: method, dataType: "json", headers: { "x-api-key": key } };
    if (body) {
      options.contentType = "application/json";
      options.data = JSON.stringify(body);            // JavaScript object -> JSON string
    }
    return $.ajax(options);
  }

  function readError(xhr) {
    if (xhr.status === 0) return "Cannot reach the server. Make sure Node.js is running (npm start) and MySQL is started in XAMPP.";
    if (xhr.responseJSON && xhr.responseJSON.message) return xhr.responseJSON.message;
    return "Something went wrong (HTTP " + xhr.status + ").";
  }

  function whenDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    return isNaN(d) ? "—" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function maskKey(key) {
    return key.length > 14 ? key.slice(0, 8) + "••••••••" + key.slice(-4) : "••••••••";
  }

  // Builds an HTML table. columns: [{ title, cell(row), cls }]
  function buildTable(columns, rows, emptyText) {
    if (rows.length === 0) return `<p class="empty-line">${esc(emptyText)}</p>`;
    const head = $.map(columns, function (c) { return `<th class="${c.cls || ""}">${esc(c.title)}</th>`; }).join("");
    const body = $.map(rows, function (row) {
      return "<tr>" + $.map(columns, function (c) { return `<td class="${c.cls || ""}">${c.cell(row)}</td>`; }).join("") + "</tr>";
    }).join("");
    return `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function statusBadge(status) {
    return status === "active"
      ? '<span class="badge badge-ok">Active</span>'
      : '<span class="badge badge-bad">Revoked</span>';
  }

  function codeBadge(code) {
    const cls = code < 300 ? "badge-ok" : code < 500 ? "badge-warn" : "badge-bad";
    return `<span class="badge ${cls}">${code}</span>`;
  }

  function gradeBadge(grade) {
    const cls = grade === "A" || grade === "B" ? "badge-ok" : grade === "F" ? "badge-bad" : "badge-warn";
    return `<span class="badge ${cls}">${grade}</span>`;
  }

  // Usage bar. kind "big" is used in the portal, "small" inside tables
  function meterHtml(used, limit) {
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const cls = percent >= 100 ? "full" : percent >= 80 ? "warn" : "";
    return `<div class="meter-box meter-sm"><div class="meter"><div class="meter-fill ${cls}" style="width:${percent}%"></div></div>
            <span class="cell-sub">${used} / ${limit} requests</span></div>`;
  }

  /* =====================================================
     REUSABLE MODAL WINDOW
  ===================================================== */
  function openModal(title, bodyHtml, buttons) {
    $("#modalTitle").text(title);
    $("#modalBody").html(bodyHtml);
    $("#modalError").text("");
    const $footer = $("#modalFooter").empty();
    $.each(buttons, function (i, b) {
      $('<button type="button" class="btn"></button>')
        .addClass(b.kind || "").text(b.label).on("click", b.onClick).appendTo($footer);
    });
    $("#modalLayer").prop("hidden", false);
    $("#modalBody input").first().trigger("focus");
  }

  function closeModal() {
    $("#modalLayer").prop("hidden", true);
    $("#modalBody").empty();
  }

  function modalProblem(text) { $("#modalError").text(text); }

  $("#modalLayer").on("click", function (e) { if (e.target === this) closeModal(); });
  $(document).on("keydown", function (e) { if (e.key === "Escape") closeModal(); });
  $(document).on("keydown", "#modalBody input", function (e) {
    if (e.key === "Enter") $("#modalFooter .btn-main, #modalFooter .btn-danger").first().trigger("click");
  });

  /* =====================================================
     PORTAL (students and teachers)
  ===================================================== */
  function startPortal() {
    $("#portalDash, #portalError, #portalNoKey").prop("hidden", true);
    if (!localStorage.getItem(USER_KEY_STORE)) {
      $("#portalNoKey").prop("hidden", false);
      return;
    }

    userCall("GET", "/api/me")
      .done(function (me) {
        console.log("GET /api/me response:", me);
        $("#portalDash").prop("hidden", false);
        $("#whoRole").text(me.role === "student" ? "Student" : "Teacher");
        $("#whoName").text(me.profile.full_name);
        $("#whoMeta").text(
          (me.role === "student" ? me.profile.roll_no + " · Semester " + me.profile.semester : me.profile.employee_no) +
          " · " + me.profile.department
        );
        $("#keyPrefix").text(me.key.prefix + "…");
        setMeter(me.key.requests_used, me.key.request_limit);
        fillTester(me);

        if (me.role === "student") showStudentArea(me.profile);
        else showTeacherArea();
      })
      .fail(function (xhr) {
        console.log("GET /api/me error:", xhr);
        $("#portalError").html(esc(readError(xhr)) + ' <a href="/settings">Open Settings</a>').prop("hidden", false);
      });
  }

  // A request made with the saved key. After it finishes, the usage bar is refreshed from the response headers.
  function userCall(method, path) {
    return callApi(localStorage.getItem(USER_KEY_STORE), method, path).always(function (a, b, c) {
      const xhr = a && a.getResponseHeader ? a : c;
      if (!xhr || !xhr.getResponseHeader) return;
      const limit = xhr.getResponseHeader("X-RateLimit-Limit");
      const left = xhr.getResponseHeader("X-RateLimit-Remaining");
      if (limit !== null && left !== null) setMeter(Number(limit) - Number(left), Number(limit));
    });
  }

  function setMeter(used, limit) {
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    $("#meterFill").css("width", percent + "%")
      .toggleClass("warn", percent >= 80 && percent < 100).toggleClass("full", percent >= 100);
    $("#meterText").text(used + " of " + limit + " requests used · " + Math.max(limit - used, 0) + " left");
  }

  function marksTable(marks, showStudent) {
    const columns = [];
    if (showStudent) {
      columns.push({ title: "Student", cell: function (m) { return `${esc(m.student_name)}<span class="cell-sub">${esc(m.roll_no)}</span>`; } });
    }
    columns.push(
      { title: "Course", cell: function (m) { return `${esc(m.course_title)}<span class="cell-sub">${esc(m.course_code)} · ${m.credit_hours} credit hours</span>`; } },
      { title: "Teacher", cell: function (m) { return esc(m.teacher_name); } },
      { title: "Assignment /20", cls: "num", cell: function (m) { return m.assignment; } },
      { title: "Midterm /30", cls: "num", cell: function (m) { return m.midterm; } },
      { title: "Final /50", cls: "num", cell: function (m) { return m.final_exam; } },
      { title: "Total /100", cls: "num", cell: function (m) { return "<strong>" + m.total + "</strong>"; } },
      { title: "Grade", cell: function (m) { return gradeBadge(m.grade); } }
    );
    return buildTable(columns, marks, "No marks found.");
  }

  function showStudentArea(profile) {
    $("#teacherArea").prop("hidden", true);
    $("#studentArea").prop("hidden", false);

    const items = [["Roll number", profile.roll_no], ["Full name", profile.full_name], ["Email", profile.email],
                   ["Department", profile.department], ["Semester", profile.semester]];
    $("#profileGrid").html($.map(items, function (i) {
      return `<div class="info-item"><span>${i[0]}</span><strong>${esc(i[1])}</strong></div>`;
    }).join(""));

    userCall("GET", "/api/students/" + profile.id + "/marks")
      .done(function (r) {
        console.log("GET marks response:", r);
        $("#myMarks").html(marksTable(r.marks, false));
        let sum = 0;
        $.each(r.marks, function (i, m) { sum += m.total; });
        $("#marksSummary").text(r.count + " courses · average " + (r.count ? (sum / r.count).toFixed(1) : 0));
      })
      .fail(function (xhr) { $("#myMarks").html(`<p class="empty-line">${esc(readError(xhr))}</p>`); });
  }

  function showTeacherArea() {
    $("#studentArea").prop("hidden", true);
    $("#teacherArea").prop("hidden", false);

    userCall("GET", "/api/students")
      .done(function (r) {
        console.log("GET /api/students response:", r);
        teacherStudents = r.students;
        drawStudentList("");
        $("#marksFilter").html('<option value="all">All students</option>' + $.map(r.students, function (s) {
          return `<option value="${s.id}">${esc(s.roll_no)} · ${esc(s.full_name)}</option>`;
        }).join(""));
      })
      .fail(function (xhr) { $("#studentsTable").html(`<p class="empty-line">${esc(readError(xhr))}</p>`); });

    loadMarks("all");
  }

  function drawStudentList(search) {
    const q = search.toLowerCase();
    const rows = $.grep(teacherStudents, function (s) {
      return s.full_name.toLowerCase().indexOf(q) !== -1 || s.roll_no.toLowerCase().indexOf(q) !== -1;
    });
    $("#studentsTable").html(buildTable([
      { title: "Roll no", cell: function (s) { return esc(s.roll_no); } },
      { title: "Name", cell: function (s) { return `<strong>${esc(s.full_name)}</strong><span class="cell-sub">${esc(s.email)}</span>`; } },
      { title: "Department", cell: function (s) { return esc(s.department); } },
      { title: "Semester", cls: "num", cell: function (s) { return s.semester; } },
      { title: "", cls: "actions", cell: function (s) { return `<button type="button" class="btn btn-soft btn-small" data-act="view-marks" data-id="${s.id}">View marks</button>`; } }
    ], rows, "No students match your search."));
  }

  function loadMarks(studentId) {
    const path = studentId === "all" ? "/api/marks" : "/api/students/" + studentId + "/marks";
    userCall("GET", path)
      .done(function (r) {
        console.log("GET " + path + " response:", r);
        $("#marksTitle").text(studentId === "all" ? "Marks of all students" : "Marks of " + r.student.full_name);
        $("#marksTable").html(marksTable(r.marks, studentId === "all"));
      })
      .fail(function (xhr) { $("#marksTable").html(`<p class="empty-line">${esc(readError(xhr))}</p>`); });
  }

  $("#studentSearch").on("input", function () { drawStudentList($(this).val()); });
  $("#marksFilter").on("change", function () { loadMarks($(this).val()); });
  $(document).on("click", "[data-act=view-marks]", function () {
    const id = String($(this).data("id"));
    $("#marksFilter").val(id);
    loadMarks(id);
    $("#marksCard")[0].scrollIntoView({ behavior: "smooth" });
  });

  /* ----- API tester ----- */
  function fillTester(me) {
    $("#testerPath").html($.map(TESTER_PRESETS, function (p, i) { return `<option value="${i}">${esc(p.label)}</option>`; }).join(""));
    $("#testerId").val(me.role === "student" ? me.profile.id : 1);
  }

  $("#testerSend").on("click", function () {
    const preset = TESTER_PRESETS[Number($("#testerPath").val())];
    const path = preset.path.replace("{id}", $("#testerId").val() || "1");
    const $btn = $(this).prop("disabled", true);

    callApi(localStorage.getItem(USER_KEY_STORE), "GET", path)
      .always(function (a, b, c) {
        const failed = a && a.getResponseHeader;
        const xhr = failed ? a : c;
        const body = failed ? (a.responseJSON || a.responseText) : a;

        $("#testerStatus").text(xhr.status + " " + (xhr.statusText || ""))
          .removeClass("c2 c4 c5").addClass(xhr.status < 300 ? "c2" : xhr.status < 500 ? "c4" : "c5");
        $("#testerUrl").text("GET " + path);
        $("#testerBody").text(JSON.stringify(body, null, 2));
        $("#testerResult").prop("hidden", false);

        const limit = xhr.getResponseHeader("X-RateLimit-Limit");
        const left = xhr.getResponseHeader("X-RateLimit-Remaining");
        if (limit !== null && left !== null) setMeter(Number(limit) - Number(left), Number(limit));
        $btn.prop("disabled", false);
      });
  });

  /* =====================================================
     SETTINGS (students and teachers save their key)
  ===================================================== */
  function showSavedKey() {
    const key = localStorage.getItem(USER_KEY_STORE);
    $("#savedBox").prop("hidden", !key);
    if (key) $("#savedMask").text(maskKey(key));
  }

  function settingsMessage(text, kind) {
    $("#settingsMessage").text(text).removeClass("good warn").addClass(kind || "");
  }

  $("#showKey").on("change", function () {
    $("#keyInput").attr("type", this.checked ? "text" : "password");
  });

  $("#settingsForm").on("submit", function (e) {
    e.preventDefault();
    const key = String($("#keyInput").val()).trim();
    if (!key) return settingsMessage("Please enter your API key.");

    const $btn = $("#settingsSave").prop("disabled", true).text("Checking...");
    settingsMessage("");

    // The key is checked in the database through the server before it is saved
    callApi(key, "GET", "/api/me")
      .done(function (me) {
        localStorage.setItem(USER_KEY_STORE, key);
        $("#keyInput").val("");
        settingsMessage("Key saved. Signed in as " + me.profile.full_name + " (" + me.role + ").", "good");
        showSavedKey();
        showToast("API key saved");
      })
      .fail(function (xhr) {
        if (xhr.status === 429) {
          // the key is real, its limit is just used up: keep it
          localStorage.setItem(USER_KEY_STORE, key);
          $("#keyInput").val("");
          settingsMessage("Key saved, but its request limit is used up. Ask the administrator to raise it.", "warn");
          showSavedKey();
        } else {
          settingsMessage(readError(xhr));
        }
      })
      .always(function () { $btn.prop("disabled", false).text("Check and save key"); });
  });

  $("#removeKey").on("click", function () {
    localStorage.removeItem(USER_KEY_STORE);
    settingsMessage("");
    showSavedKey();
    showToast("Saved key removed");
  });

  /* =====================================================
     ADMIN PANEL
  ===================================================== */
  function startAdmin() {
    const saved = sessionStorage.getItem(ADMIN_KEY_STORE);
    if (saved) unlockAdmin(saved, true);
  }

  function unlockAdmin(key, quiet) {
    callApi(key, "GET", "/api/admin/keys")
      .done(function () {
        adminKey = key;
        sessionStorage.setItem(ADMIN_KEY_STORE, key);
        $("#adminLock").prop("hidden", true);
        $("#adminDash").prop("hidden", false);
        $("#adminKeyInput").val("");
        refreshAdmin();
      })
      .fail(function (xhr) {
        sessionStorage.removeItem(ADMIN_KEY_STORE);
        $("#adminLock").prop("hidden", false);
        $("#adminDash").prop("hidden", true);
        if (!quiet) $("#adminLockError").text(readError(xhr));
      });
  }

  $("#adminLoginForm").on("submit", function (e) {
    e.preventDefault();
    const key = String($("#adminKeyInput").val()).trim();
    if (!key) return $("#adminLockError").text("Please enter the admin API key.");
    $("#adminLockError").text("");
    unlockAdmin(key, false);
  });

  $("#adminLockBtn").on("click", function () {
    sessionStorage.removeItem(ADMIN_KEY_STORE);
    adminKey = null;
    $("#adminDash").prop("hidden", true);
    $("#adminLock").prop("hidden", false);
  });

  // Load students, teachers and keys together, then paint everything
  function refreshAdmin() {
    $.when(
      callApi(adminKey, "GET", "/api/admin/students"),
      callApi(adminKey, "GET", "/api/admin/teachers"),
      callApi(adminKey, "GET", "/api/admin/keys")
    )
      .done(function (s, t, k) {
        console.log("Admin data:", s[0], t[0], k[0]);
        adminData = { students: s[0].students, teachers: t[0].teachers, keys: k[0].keys };
        paintAdmin();
      })
      .fail(function (xhr) { showToast(readError(xhr), true); });
  }

  function paintAdmin() {
    const keys = adminData.keys;
    let used = 0, active = 0;
    $.each(keys, function (i, k) { used += k.requests_used; if (k.status === "active") active++; });
    $("#adminStats").html(
      `<div class="stat"><strong>${adminData.students.length}</strong><span>Students</span></div>
       <div class="stat"><strong>${adminData.teachers.length}</strong><span>Teachers</span></div>
       <div class="stat"><strong>${active}</strong><span>Active keys (${keys.length - active} revoked)</span></div>
       <div class="stat"><strong>${used}</strong><span>Requests counted</span></div>`
    );

    $("#studentsAdmin").html(buildTable([
      { title: "Roll no", cell: function (s) { return esc(s.roll_no); } },
      { title: "Name", cell: function (s) { return `<strong>${esc(s.full_name)}</strong><span class="cell-sub">${esc(s.email)}</span>`; } },
      { title: "Department", cell: function (s) { return esc(s.department); } },
      { title: "Semester", cls: "num", cell: function (s) { return s.semester; } },
      { title: "API key", cell: function (s) { return keyState(s); } },
      { title: "", cls: "actions", cell: function (s) { return generateButton("student", s.id, s.full_name, s.has_active_key); } }
    ], adminData.students, "No students found."));

    $("#teachersAdmin").html(buildTable([
      { title: "Employee no", cell: function (t) { return esc(t.employee_no); } },
      { title: "Name", cell: function (t) { return `<strong>${esc(t.full_name)}</strong><span class="cell-sub">${esc(t.email)}</span>`; } },
      { title: "Department", cell: function (t) { return esc(t.department); } },
      { title: "API key", cell: function (t) { return keyState(t); } },
      { title: "", cls: "actions", cell: function (t) { return generateButton("teacher", t.id, t.full_name, t.has_active_key); } }
    ], adminData.teachers, "No teachers found."));

    $("#keysAdmin").html(buildTable([
      { title: "#", cell: function (k) { return k.id; } },
      { title: "Owner", cell: function (k) { return `<strong>${esc(k.owner_name)}</strong><span class="cell-sub">${esc(k.owner_code)} · ${esc(k.role)}</span>`; } },
      { title: "Key", cell: function (k) { return `<span class="mono">${esc(k.key_prefix)}…</span>`; } },
      { title: "Usage", cell: function (k) { return meterHtml(k.requests_used, k.request_limit); } },
      { title: "Status", cell: function (k) { return statusBadge(k.status); } },
      { title: "Last used", cell: function (k) { return `<span class="small">${esc(whenDate(k.last_used_at))}</span>`; } },
      { title: "", cls: "actions", cell: function (k) { return keyButtons(k); } }
    ], keys, "No API keys generated yet. Use the Students or Teachers tab."));
  }

  function keyState(user) {
    return user.has_active_key ? '<span class="badge badge-ok">Active key</span>' : '<span class="badge badge-grey">No active key</span>';
  }

  function generateButton(role, id, name, hasKey) {
    if (hasKey) return "";
    return `<button type="button" class="btn btn-main btn-small" data-act="generate" data-role="${role}" data-id="${id}" data-name="${esc(name)}">Generate key</button>`;
  }

  function keyButtons(k) {
    const log = `<button type="button" class="btn btn-soft btn-small" data-act="usage" data-id="${k.id}">Usage log</button>`;
    if (k.status !== "active") return log;
    return `<button type="button" class="btn btn-soft btn-small" data-act="edit-limit" data-id="${k.id}" data-limit="${k.request_limit}">Edit limit</button>
            <button type="button" class="btn btn-soft btn-small" data-act="reset" data-id="${k.id}">Reset usage</button>
            ${log}
            <button type="button" class="btn btn-danger btn-small" data-act="revoke" data-id="${k.id}" data-name="${esc(k.owner_name)}">Revoke</button>`;
  }

  // Tabs
  $("#adminTabs").on("click", "button", function () {
    $("#adminTabs button").removeClass("is-on");
    $(this).addClass("is-on");
    $.each(["Students", "Teachers", "Keys"], function (i, name) {
      $("#tab" + name).prop("hidden", name !== $("#adminTabs .is-on").data("tab"));
    });
  });

  /* ----- admin actions ----- */
  $(document).on("click", "[data-act=generate]", function () {
    const role = $(this).data("role");
    const id = $(this).data("id");
    const name = $(this).data("name");

    openModal("Generate API key",
      `<p>A random key will be generated for <strong>${esc(name)}</strong> (${esc(role)}).</p>
       <div class="field"><label for="genLimit">Request limit</label>
       <input type="number" id="genLimit" min="1" max="100000" value="50"></div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Generate key", kind: "btn-main", onClick: function () {
          callApi(adminKey, "POST", "/api/admin/keys", { role: role, user_id: id, request_limit: Number($("#genLimit").val()) })
            .done(function (r) {
              console.log("POST /api/admin/keys response:", r);
              showNewKey(r.api_key, name);
              refreshAdmin();
            })
            .fail(function (xhr) { modalProblem(readError(xhr)); });
        } }
      ]);
  });

  function showNewKey(apiKey, name) {
    openModal("API key for " + name,
      `<div class="notice-warn">Copy this key now. It is stored only as a hash and will not be shown again.</div>
       <div class="key-box" id="newKeyText">${esc(apiKey)}</div>`,
      [
        { label: "Copy key", kind: "btn-main", onClick: function () {
          if (navigator.clipboard) navigator.clipboard.writeText(apiKey).then(function () { showToast("Key copied"); });
          else showToast("Select the key and copy it", true);
        } },
        { label: "Done", onClick: closeModal }
      ]);
  }

  $(document).on("click", "[data-act=edit-limit]", function () {
    const id = $(this).data("id");
    openModal("Update request limit",
      `<p>The key stops working with a 429 error when the limit is reached.</p>
       <div class="field"><label for="newLimit">New request limit</label>
       <input type="number" id="newLimit" min="1" max="100000" value="${Number($(this).data("limit"))}"></div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Save limit", kind: "btn-main", onClick: function () {
          callApi(adminKey, "PUT", "/api/admin/keys/" + id, { request_limit: Number($("#newLimit").val()) })
            .done(function (r) { closeModal(); showToast(r.message); refreshAdmin(); })
            .fail(function (xhr) { modalProblem(readError(xhr)); });
        } }
      ]);
  });

  $(document).on("click", "[data-act=reset]", function () {
    callApi(adminKey, "POST", "/api/admin/keys/" + $(this).data("id") + "/reset-usage")
      .done(function (r) { showToast(r.message); refreshAdmin(); })
      .fail(function (xhr) { showToast(readError(xhr), true); });
  });

  $(document).on("click", "[data-act=revoke]", function () {
    const id = $(this).data("id");
    openModal("Revoke this key?",
      `<p>The key of <strong>${esc($(this).data("name"))}</strong> will stop working immediately. This cannot be undone.</p>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Revoke key", kind: "btn-danger", onClick: function () {
          callApi(adminKey, "DELETE", "/api/admin/keys/" + id)
            .done(function (r) { closeModal(); showToast(r.message); refreshAdmin(); })
            .fail(function (xhr) { modalProblem(readError(xhr)); });
        } }
      ]);
  });

  $(document).on("click", "[data-act=usage]", function () {
    callApi(adminKey, "GET", "/api/admin/keys/" + $(this).data("id") + "/usage")
      .done(function (r) {
        console.log("Usage log:", r);
        openModal("Latest requests",
          `<div class="table-wrap">${buildTable([
            { title: "Method", cell: function (u) { return esc(u.method); } },
            { title: "Endpoint", cell: function (u) { return `<span class="mono">${esc(u.endpoint)}</span>`; } },
            { title: "Status", cell: function (u) { return codeBadge(u.status_code); } },
            { title: "Time", cell: function (u) { return `<span class="small">${esc(whenDate(u.called_at))}</span>`; } }
          ], r.usage, "This key has not been used yet.")}</div>`,
          [{ label: "Close", kind: "btn-main", onClick: closeModal }]);
      })
      .fail(function (xhr) { showToast(readError(xhr), true); });
  });

  /* =====================================================
     START: choose the view from the address
  ===================================================== */
  const path = location.pathname.replace(/\/+$/, "");
  let page = "portal";
  if (path === "/admin") page = "admin";
  else if (path === "/settings") page = "settings";

  $("#view" + page.charAt(0).toUpperCase() + page.slice(1)).prop("hidden", false);
  $(".menu a").each(function () { $(this).toggleClass("is-here", $(this).data("page") === page); });

  if (page === "portal") startPortal();
  if (page === "settings") showSavedKey();
  if (page === "admin") startAdmin();
});
