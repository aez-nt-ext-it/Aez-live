import { dateKey, midnight, validDate, fail } from './domain.js';

const mins = ms => Math.round(ms / 60000 * 100) / 100;
const istDate = value => new Date(`${value}T00:00:00+05:30`);
const dateDay = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(istDate(value));
const time = value => value ? new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
const monthName = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' }).format(istDate(value));

export function summarize(sessions, from, to, now = new Date()) {
  const buckets = new Map();
  const stop = +midnight(to) + 86400000;
  for (const s of sessions) {
    const start = Math.max(+new Date(s.start), +midnight(from));
    const end = Math.min(+new Date(s.end || now), stop);
    for (let cursor = start; cursor < end;) {
      const day = dateKey(cursor), next = Math.min(+midnight(day) + 86400000, end);
      const key = `${day}|${s.email}|${s.role}`;
      const r = buckets.get(key) || { date: day, email: s.email, name: s.name, role: s.role, firstLogin: null, lastLogout: null, workMs: 0, breakMs: 0, breakTimes: new Set(), classes: 0, status: 'Completed', subjects: new Set(), students: new Set() };
      const breaks = [...(s.breaks || [])];
      if (s.breakStart) breaks.push({ start: s.breakStart, end: s.end || now });
      const breakMs = breaks.reduce((sum, b) => {
        const start = Math.max(cursor, +new Date(b.start)), end = Math.min(next, +new Date(b.end));
        if (end > start) r.breakTimes.add(`${time(start)}-${time(end)}`);
        return sum + Math.max(0, end - start);
      }, 0);
      r.workMs += Math.max(0, next - cursor - breakMs); r.breakMs += breakMs;
      r.firstLogin = !r.firstLogin || cursor < +new Date(r.firstLogin) ? new Date(cursor).toISOString() : r.firstLogin;
      if (s.end && (!r.lastLogout || next > +new Date(r.lastLogout))) r.lastLogout = new Date(next).toISOString();
      if (!s.end) r.status = s.breakStart ? 'On Break' : 'Active';
      if (s.role === 'teach' && s.end && dateKey(s.end) === day) r.classes++;
      if (s.subject) r.subjects.add(s.subject);
      if (s.student) r.students.add(s.student);
      buckets.set(key, r); cursor = next;
    }
  }
  return [...buckets.values()].map(({ workMs, breakMs, breakTimes, subjects, students, ...r }) => ({ ...r, workingMinutes: mins(workMs), breakMinutes: mins(breakMs), breakTimes: [...breakTimes].join(', '), subjects: [...subjects].join(', '), students: [...students].join(', ') })).sort((a,b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

export async function report(db, query, now = new Date()) {
  const from = validDate(query.from || dateKey(now)), to = validDate(query.to || dateKey(now));
  if (to < from || +midnight(to) - +midnight(from) > 366 * 86400000) fail('Choose a date range of at most 367 days.');
  const { rows: events } = await db.query(`SELECT e.*,u.name FROM events e JOIN users u USING(email) WHERE NOT e.undone AND (e.data ? 'closedSession') AND e.data->'closedSession' <> 'null'::jsonb AND (e.data->'closedSession'->>'end')::timestamptz >= $1 AND (e.data->'closedSession'->>'start')::timestamptz < $2`, [midnight(from), new Date(+midnight(to) + 86400000)]);
  const { rows: profiles } = await db.query('SELECT p.*,u.name FROM profiles p JOIN users u USING(email)');
  const sessions = events.map(e => ({ ...e.data.closedSession, email: e.email, name: e.name, role: e.role }));
  profiles.forEach(p => { if (p.state.work) sessions.push({ ...p.state.work, email: p.email, name: p.name, role: p.role }); });
  return summarize(sessions.filter(s => (!query.role || query.role === 'all' || s.role === query.role) && (!query.email || s.email === query.email)), from, to, now);
}

export function sheetRows(rows) {
  return rows.slice().sort((a,b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)).map(r => ({
    'DATE / DAY': dateDay(r.date),
    EMPLOYEE: r.name,
    'LOGGED IN': time(r.firstLogin),
    'LOGGED OUT': time(r.lastLogout),
    'WORKING MINS (TODAY)': r.workingMinutes,
    'BREAK MINS (TODAY)': r.breakMinutes,
    'BREAK TIMES (TODAY)': r.breakTimes,
    REMARKS: [r.status !== 'Completed' ? r.status : '', r.role === 'teach' && r.classes ? `Classes: ${r.classes}` : '', r.subjects ? `Subject: ${r.subjects}` : '', r.students ? `Student: ${r.students}` : ''].filter(Boolean).join(' | ')
  }));
}

export function monthlySummary(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const month = r.date.slice(0, 7), key = `${month}|${r.email}|${r.role}`;
    const summary = buckets.get(key) || { month, email: r.email, employee: r.name, role: r.role, presentDays: new Set(), workingMinutes: 0, breakMinutes: 0, classes: 0, firstDate: r.date, lastDate: r.date };
    if (r.workingMinutes > 0 || r.breakMinutes > 0 || r.status !== 'Completed') summary.presentDays.add(r.date);
    summary.workingMinutes += r.workingMinutes;
    summary.breakMinutes += r.breakMinutes;
    summary.classes += r.classes;
    summary.firstDate = summary.firstDate < r.date ? summary.firstDate : r.date;
    summary.lastDate = summary.lastDate > r.date ? summary.lastDate : r.date;
    buckets.set(key, summary);
  }
  return [...buckets.values()].map(({ presentDays, workingMinutes, breakMinutes, ...r }) => ({
    MONTH: monthName(`${r.month}-01`),
    EMPLOYEE: r.employee,
    ROLE: r.role === 'teach' ? 'Educator' : 'Employee',
    'PRESENT DAYS': presentDays.size,
    'TOTAL WORKING MINS': mins(workingMinutes * 60000),
    'TOTAL WORKING HOURS': Math.round((workingMinutes / 60) * 100) / 100,
    'TOTAL BREAK MINS': mins(breakMinutes * 60000),
    'AVG WORK MINS / DAY': presentDays.size ? Math.round((workingMinutes / presentDays.size) * 100) / 100 : 0,
    CLASSES: r.classes,
    'FIRST DATE': r.firstDate,
    'LAST DATE': r.lastDate,
    email: r.email
  })).sort((a,b) => b.MONTH.localeCompare(a.MONTH) || a.EMPLOYEE.localeCompare(b.EMPLOYEE));
}

export const safeCell = value => typeof value === 'string' && /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
export function csv(rows) {
  if (!rows.length) return 'date,email,name,role,workingMinutes,breakMinutes\r\n';
  const keys = Object.keys(rows[0]);
  const cell = v => `"${String(safeCell(v ?? '')).replaceAll('"', '""')}"`;
  return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n');
}
