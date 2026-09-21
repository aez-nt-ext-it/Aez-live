import { randomUUID } from 'node:crypto';

export const MINUTE = 60000;
export const dateKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
export const midnight = day => new Date(`${day}T00:00:00+05:30`);
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function validDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || Number.isNaN(+midnight(day)) || dateKey(midnight(day)) !== day) fail('Choose a valid date.');
  return day;
}
function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}
export function closeWork(state, at) {
  if (!state.work) return null;
  const work = structuredClone(state.work);
  if (work.breakStart) work.breaks.push({ start: work.breakStart, end: at });
  work.breakStart = null;
  work.end = at;
  state.work = null;
  state.classSession = null;
  return work;
}

// Pure transitions keep the browser, worker and reports on the same attendance rules.
export function transition(previous, role, payload, now = new Date()) {
  const state = structuredClone(previous);
  const at = now.toISOString();
  const data = {};
  let message = 'Status updated';
  const action = payload.action;
  if (action === 'Active') {
    if (state.status === 'On Leave') {
      if (state.pendingResume) fail('Resume request already sent.');
      state.pendingResume = randomUUID();
      message = 'Resume request sent to admin';
    } else if (state.status === 'On Break') {
      if (!state.work?.breakStart) fail('No active break.');
      state.work.breaks.push({ start: state.work.breakStart, end: at });
      state.work.breakStart = null;
      state.status = 'Active';
      message = 'Work resumed';
    } else {
      if (state.status === 'Active') fail('Already active.');
      const subject = role === 'teach' ? text(payload.subject, 'Subject', 150) : '';
      const student = role === 'teach' ? text(payload.student, 'Student', 150) : '';
      state.work = { id: randomUUID(), start: at, breaks: [], breakStart: null, subject, student };
      state.status = 'Active';
      if (role === 'teach') state.classSession = {
        id: state.work.id, startTime: at, endTime: new Date(+now + 60 * MINUTE).toISOString(),
        maxEndTime: new Date(+now + 90 * MINUTE).toISOString(), extended: false, status: 'ongoing'
      };
      message = role === 'teach' ? 'Class started' : 'Logged in';
    }
  } else if (action === 'On Break') {
    if (state.status !== 'Active' || !state.work) fail('Start work before taking a break.');
    state.work.breakStart = at;
    state.status = 'On Break';
    message = 'Break started';
  } else if (action === 'Offline' || action === 'Auto End Class') {
    if (!state.work) fail('No ongoing work session.');
    const end = action === 'Auto End Class' ? state.classSession.endTime : at;
    data.closedSession = closeWork(state, end);
    state.status = 'Offline';
    message = action === 'Auto End Class' ? 'Class ended automatically at its scheduled time' : 'Logged out';
  } else if (action === 'Extend Class Session') {
    const s = state.classSession;
    if (!s || s.id !== payload.classSessionId) fail('Class session not found.');
    if (s.extended) fail('This class has already been extended.');
    if (+now < +new Date(s.endTime) || +now >= +new Date(s.endTime) + 3 * MINUTE) fail('Extension is available during the three-minute end-of-class grace period.');
    s.extended = true;
    s.endTime = s.maxEndTime;
    state.work.extended = true;
    message = 'Class extended by 30 minutes';
  } else if (action === 'On Leave') {
    if (state.status === 'On Leave') fail('Already on leave.');
    const startDate = validDate(payload.startDate), resumeDate = validDate(payload.resumeDate);
    if (startDate !== dateKey(now)) fail('Mark leave on the day it starts.');
    if (resumeDate <= startDate) fail('Resume date must follow the start date.');
    data.closedSession = closeWork(state, at);
    state.leave = { id: randomUUID(), reason: text(payload.reason, 'Reason'), startDate, resumeDate, proofUrl: payload.proofUrl || '' };
    data.leave = state.leave;
    state.status = 'On Leave'; state.pendingResume = null;
    message = 'Leave marked';
  } else if (action === 'Weekoff') {
    if (role !== 'emp' || state.status === 'On Leave') fail('Weekoff is not available.');
    if (!['today', 'tomorrow'].includes(payload.day)) fail('Choose today or tomorrow.');
    state.weekoff = dateKey(new Date(+now + (payload.day === 'tomorrow' ? 86400000 : 0)));
    data.weekoff = state.weekoff;
    if (payload.day === 'today') { data.closedSession = closeWork(state, at); state.status = 'Weekoff'; }
    message = `Weekoff marked for ${state.weekoff}`;
  } else fail('Unknown action.');
  return { state, data, message };
}

export async function recordTransition(tx, profile, payload, actor, now = new Date(), requestId = null) {
  const result = transition(profile.state, profile.role, payload, now);
  return saveChange(tx, profile, result, payload.action, actor, now, requestId);
}

export async function saveChange(tx, profile, result, action, actor, now, requestId = null) {
  const id = randomUUID(), version = profile.version + 1;
  await tx.query('UPDATE profiles SET state=$1,version=$2 WHERE email=$3 AND role=$4', [JSON.stringify(result.state), version, profile.email, profile.role]);
  await tx.query('INSERT INTO events(id,email,role,action,at,data,before_state,after_version,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, profile.email, profile.role, action, now, JSON.stringify({ ...result.data, actor, message: result.message }), JSON.stringify(profile.state), version, requestId]);
  let eventType = result.state.pendingResume && !profile.state.pendingResume ? 'Resume Request' : '';
  if (!profile.state.work && result.state.work) eventType = 'Login';
  if (profile.state.work && !result.state.work) eventType = 'Logout';
  if (eventType) {
    const { rows } = await tx.query('SELECT name FROM users WHERE email=$1', [profile.email]);
    const message = eventType === 'Login' ? 'logged in.' : eventType === 'Logout' ? 'logged out.' : 'requested an early return.';
    await tx.query('INSERT INTO notifications(email,name,role,action,event_type,at,event_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [profile.email, rows[0].name, profile.role, message, eventType, now, id]);
  }
  return { status: 'success', message: result.message, undoToken: id };
}

export async function undo(tx, email, token, now) {
  const { rows: found } = await tx.query('SELECT * FROM events WHERE id=$1 AND email=$2', [token, email]);
  const e = found[0];
  if (!e || e.undone || +now - +new Date(e.at) > 10000 || e.action === 'Admin Resume Decision' || e.action.startsWith('Auto ')) fail('Undo window expired.');
  const { rows } = await tx.query('SELECT * FROM profiles WHERE email=$1 AND role=$2 FOR UPDATE', [email, e.role]);
  if (rows[0].version !== e.after_version) fail('A newer action has already changed this status.');
  await tx.query('UPDATE events SET undone=true WHERE id=$1', [token]);
  await tx.query('UPDATE profiles SET state=$1,version=version+1 WHERE email=$2 AND role=$3', [JSON.stringify(e.before_state), email, e.role]);
  return { status: 'success', message: 'Previous state restored' };
}

export async function reconcile(tx, now = new Date()) {
  const { rows } = await tx.query('SELECT * FROM profiles ORDER BY email,role FOR UPDATE');
  for (const p of rows) {
    const s = p.state, session = s.classSession;
    if (session && +now >= +new Date(session.endTime) + (session.extended ? 0 : 3 * MINUTE)) {
      await recordTransition(tx, p, { action: 'Auto End Class' }, 'system', now);
    } else if (s.status === 'On Leave' && s.leave.resumeDate <= dateKey(now)) {
      const state = { ...s, status: 'Offline', pendingResume: null };
      await saveChange(tx, p, { state, data: {}, message: 'Returned from leave (completed)' }, 'Auto Return', 'system', now);
    } else if (s.weekoff && s.weekoff < dateKey(now) && s.status === 'Weekoff') {
      await saveChange(tx, p, { state: { ...s, status: 'Offline' }, data: {}, message: 'Weekoff completed' }, 'Auto Weekoff', 'system', now);
    } else if (s.weekoff === dateKey(now) && s.status === 'Offline') {
      await saveChange(tx, p, { state: { ...s, status: 'Weekoff' }, data: {}, message: 'Weekoff started' }, 'Auto Weekoff', 'system', now);
    }
  }
}
