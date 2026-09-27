import nodemailer from 'nodemailer';
import { reconcile, dateKey, validDate } from './domain.js';
import { report } from './reports.js';

const MAIL_RETRY_BASE_MS = 5 * 60000;
const MAIL_RETRY_MAX_MS = 60 * 60000;

export function createMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_PORT) === '465',
    requireTLS: String(process.env.SMTP_PORT || 587) === '587',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 30000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 30000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 45000)
  });
}

export function summaryRecipients(admins = []) {
  const configured = process.env.SUMMARY_RECIPIENTS?.split(',').map(s => s.trim()).filter(Boolean);
  return configured?.length ? configured : admins;
}

export async function ensureDailySummaryJob(db, day = dateKey(new Date()), now = new Date()) {
  validDate(day);
  const { rows } = await db.query(
    'INSERT INTO mail_jobs(day,next_attempt) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET next_attempt=LEAST(mail_jobs.next_attempt,$2) RETURNING day,state,attempts,last_error,sent_at',
    [day, now]
  );
  return rows[0];
}

async function claimSummaryJob(db, day = null, now = new Date(), force = false) {
  return db.transaction(async tx => {
    const params = [now];
    let where = "state='pending' AND next_attempt<=$1";
    if (day) { params.push(day); where += ` AND day=$${params.length}`; }
    if (force) where = day ? `day=$2 AND state<>'sending'` : "state<>'sending'";
    const { rows } = await tx.query(
      `SELECT * FROM mail_jobs WHERE ${where} ORDER BY day LIMIT 1 FOR UPDATE SKIP LOCKED`,
      params
    );
    const job = rows[0];
    if (!job) return null;
    if (job.state === 'sent' && !force) return null;
    await tx.query("UPDATE mail_jobs SET state='sending', last_error=NULL WHERE day=$1", [job.day]);
    return job;
  });
}

async function buildDailySummary(db, day, now = new Date()) {
  const records = await report(db, { from: day, to: day }, now);
  const users = (await db.query('SELECT u.email,u.name,p.role,p.state FROM profiles p JOIN users u USING(email) WHERE enabled=true')).rows;
  const lines = [`Daily Operations Summary - ${day}`];
  for (const role of ['emp', 'teach']) {
    const group = users.filter(u => u.role === role), r = records.filter(r => r.role === role);
    lines.push('', role === 'emp' ? 'Employees' : 'Educators', `Total: ${group.length}`);
    for (const status of ['Active', 'On Break', 'On Leave', 'Offline', 'Weekoff']) lines.push(`${status}: ${group.filter(u => u.state.status === status).length}`);
    lines.push(`Working hours: ${(r.reduce((sum, r) => sum + r.workingMinutes, 0) / 60).toFixed(2)}`);
    if (role === 'teach') lines.push(`Classes completed: ${r.reduce((sum, r) => sum + r.classes, 0)}`);
  }
  const counts = (await db.query("SELECT event_type,count(*) AS count FROM notifications n JOIN events e ON e.id=n.event_id WHERE NOT e.undone AND (n.at AT TIME ZONE 'Asia/Kolkata')::date=$1 GROUP BY event_type", [day])).rows;
  const onLeave = users.filter(u => u.state.status === 'On Leave').map(u => `${u.name} (${u.role})`);
  lines.push('', ...counts.map(c => `${c.event_type}: ${c.count}`), '', 'Currently on leave:', ...(onLeave.length ? onLeave : ['None']), '', 'Generated automatically by AEZ Live');
  const admins = (await db.query('SELECT email FROM users WHERE admin=true AND enabled=true')).rows.map(u => u.email);
  const recipients = summaryRecipients(admins);
  if (!recipients.length) throw new Error('No summary recipients configured');
  return { recipients, subject: `AEZ Live Daily Summary - ${day}`, text: lines.join('\n') };
}

function nextAttempt(now, attempts) {
  const delay = Math.min(MAIL_RETRY_MAX_MS, MAIL_RETRY_BASE_MS * Math.max(1, Math.min(attempts + 1, 12)));
  return new Date(+now + delay);
}

export async function sendDailySummary(db, { day = null, now = new Date(), force = false, mailer = createMailer() } = {}) {
  day = day || dateKey(now);
  validDate(day);
  if (!mailer) throw new Error('SMTP is not configured');
  await ensureDailySummaryJob(db, day, now);
  const job = await claimSummaryJob(db, day, now, force);
  if (!job) {
    const existing = (await db.query('SELECT day,state,attempts,last_error,sent_at,next_attempt FROM mail_jobs WHERE day=$1', [day])).rows[0];
    return { status: 'skipped', reason: existing?.state === 'sent' ? 'already_sent' : 'not_due', job: existing };
  }
  try {
    const payload = await buildDailySummary(db, day, now);
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: payload.recipients,
      subject: payload.subject,
      text: payload.text,
      messageId: `<aez-summary-${day}@aez-live.local>`
    });
    const { rows } = await db.query("UPDATE mail_jobs SET state='sent',sent_at=$2,attempts=attempts+1,last_error=NULL WHERE day=$1 RETURNING day,state,attempts,sent_at", [day, now]);
    return { status: 'sent', recipients: payload.recipients, job: rows[0] };
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    const { rows } = await db.query("UPDATE mail_jobs SET state='pending',attempts=attempts+1,last_error=$2,next_attempt=$3 WHERE day=$1 RETURNING day,state,attempts,last_error,next_attempt", [day, String(error.message).slice(0, 1000), nextAttempt(now, attempts)]);
    console.error('Daily summary failed:', error.message);
    return { status: 'error', error: error.message, job: rows[0] };
  }
}

export async function verifyMailer(mailer = createMailer()) {
  if (!mailer) return { ok: false, message: 'SMTP is not configured' };
  try {
    await mailer.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function tick(db, now = new Date(), mailer = null, sendSummaries = true) {
  await db.transaction(tx => reconcile(tx, now));
  await db.query('DELETE FROM sessions WHERE expires_at<$1', [now]);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  if (clock >= '23:50') await ensureDailySummaryJob(db, dateKey(now), now);
  if (mailer && sendSummaries) await sendDailySummary(db, { now, mailer });
}

export function startWorker(db) {
  const mailer = createMailer();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(db, new Date(), mailer, process.env.ENABLE_INTERNAL_SUMMARY_WORKER === 'true'); }
    catch (e) { console.error('Worker failed:', e.message); }
    finally { running = false; }
  };
  const timer = setInterval(run, Number(process.env.WORKER_INTERVAL_MS || 60000));
  run();
  return () => clearInterval(timer);
}
