import { reconcile } from './domain.js';

export async function runMaintenance(db, now = new Date()) {
  await db.transaction(tx => reconcile(tx, now));
  const sessions = await db.query('DELETE FROM sessions WHERE expires_at<$1 RETURNING token_hash', [now]);
  return { status: 'success', cleanedSessions: sessions.rows.length, ranAt: now.toISOString() };
}

export async function tick(db, now = new Date()) {
  return runMaintenance(db, now);
}

export function startWorker(db) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(db, new Date()); }
    catch (e) { console.error('Worker failed:', e.message); }
    finally { running = false; }
  };
  const timer = setInterval(run, Number(process.env.WORKER_INTERVAL_MS || 60000));
  run();
  return () => clearInterval(timer);
}
