# AEZ Live full-stack migration

Existing HTML/CSS UI with an Express API, PostgreSQL storage, secure Google login and admin CSV/XLSX exports. Apps Script is not called by this version.

## Local setup (Node 22+)

1. `npm install`
   Run `npm run build:css` after installing dependencies or changing frontend utility classes.
2. Copy `.env.example` to `.env`, set `ADMIN_EMAILS` and Google client ID.
3. `npm run seed`
4. `npm start` then open http://localhost:3100.

Register http://localhost:3100 as an authorized JavaScript origin in the Google OAuth client. Production requires its own HTTPS origin. Google credentials are verified on the server. Only registered enabled users may sign in. Sessions expire after 30 days or explicit sign-out. Sign-out does not end attendance.

Open the app through http://localhost:3100, not VS Code Live Server or the HTML file directly. If `npm start` says AEZ is already running, use the existing URL instead of starting another database process. If Google reports that the origin is not allowed, add both `http://localhost` and `http://localhost:3100` to Authorized JavaScript origins on the OAuth client matching GOOGLE_CLIENT_ID. Keep existing production origins. Never delete a database lock while its owning process is running.

Without DATABASE_URL, development uses persistent PGlite (embedded PostgreSQL) in `data/postgres`. Production requires a managed PostgreSQL URL. No demo login or authentication bypass is exposed by the application. Test verification is injected only in automated tests.

For Supabase pooler connections, download the database root certificate from Supabase and set `PGSSLROOTCERT` to that file path. In deployment, either ship the certificate file with the app and set `PGSSLROOTCERT` to its deployed path, or paste the certificate text into `PGSSLROOTCERT_CONTENT`.

## Admin

Seeded administrators see Reports. Select dates/role/email, view working and break minutes, download CSV or Excel. Manage Users registers or disables employee/educator accounts. Admin grants are deliberately managed through ADMIN_EMAILS + seed, not through ordinary roster edits. All action records are downloadable separately, including leave, resume, extension and undo history. Proof files are private database blobs, limited to 5 MB each, accessible only to the owner or admins; include them in database backups.

Reports include quick Today / This Month cards, employee-specific monthly summaries, CSV/XLSX exports, and an admin System Status check for database, SMTP, users and pending mail jobs.

## Attendance rules

- Multiple work sessions are summed; break time is excluded. Sessions crossing midnight split at Asia/Kolkata midnight for reports.
- Teacher classes close at 60 minutes plus a three-minute response window, recording the scheduled 60-minute end time. One extension, requested during that window, changes the deadline to 90 minutes. Extended classes close at 90 minutes without another grace period. A worker checks periodically and catches up after restarts.
- Manual end during the grace window records the real end time. Employee sessions are never automatically shortened; missing logout stays open for review.
- Leave begins today and resumes on the selected date. Early return requires admin approval; approval restores Offline so the user can explicitly start work/class.
- Tomorrow's weekoff is scheduled without stopping today's work; it activates when the user is Offline on that date.
- Undo works for ten seconds and only for the latest unchanged profile version. Events remain auditable; undone sessions are excluded from reports.
- Database transactions serialize state changes. Mutation request IDs prevent replay of the same request.

## Cron maintenance

Configure `CRON_SECRET` in production and trigger `POST /api/cron/maintenance` from an external scheduler. This endpoint does not send email. It wakes the Render free service, runs attendance reconciliation such as class auto-close/leave return/weekoff transitions, and clears expired sessions. This is useful on Render free because the web service can sleep and in-process timers are not reliable while sleeping.

### External cron setup

Create a long random `CRON_SECRET` in Render. Then configure cron-job.org, GitHub Actions or another scheduler:

- Maintenance URL: `POST https://aez-live.onrender.com/api/cron/maintenance`
- Header: `Authorization: Bearer YOUR_CRON_SECRET`
- Schedule: every 10-15 minutes while the team is actively using the app, or at least during working hours

The public health check can also be used for a simple warm-up:

- Warm health check: `GET https://aez-live.onrender.com/health`

## Fresh start and old data

This deployment starts with a clean database. Do not import old Google Sheet attendance into the new production database. Seed the administrator with `ADMIN_EMAILS`, then use the admin-only Users screen to register employees and educators before they sign in with Google. The `npm run import` command is kept only as a legacy utility for separate experiments or archives; it is not part of the production start.

Production checklist: provision PostgreSQL and backups, configure Google authorized origin, SMTP, HTTPS APP_ORIGIN and NODE_ENV=production; seed the admin; register users from the dashboard; run tests; verify one real employee login, one educator class session, one report export, class expiry with the browser closed, and an actual summary delivery. Git pushes alone do not provision these services.

### What to do with the old code.gs

Keep the original code.gs, deployed Apps Script web app, Sheets and triggers only as a dated read-only archive. The new server never executes code.gs; do not paste Node.js files into Apps Script. At the agreed cutover, stop old writes and disable the old class/summary/reset triggers to avoid duplicate operations or emails. Do not resume old writes after new-system attendance has started.

## Verification

`npm test` runs database-backed tests using in-memory PostgreSQL and temporary HTTP servers. Browser tests use Playwright separately through `node scripts/browser-check.js`.
