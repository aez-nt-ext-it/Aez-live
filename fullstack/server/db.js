import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export async function openDb(url = process.env.DATABASE_URL, dir = process.env.LOCAL_DB_DIR || './data/postgres') {
  if (url) {
    const sslRootCert = process.env.PGSSLROOTCERT || process.env.DATABASE_SSL_ROOT_CERT;
    const sslRootCertContent = process.env.PGSSLROOTCERT_CONTENT || process.env.DATABASE_SSL_ROOT_CERT_CONTENT;
    const connection = new URL(url);
    const ca = sslRootCertContent || (sslRootCert ? await readFile(sslRootCert, 'utf8') : '');
    const ssl = ca ? { ca, rejectUnauthorized: true } : undefined;
    if (ssl) {
      connection.searchParams.delete('sslmode');
      connection.searchParams.delete('sslrootcert');
      connection.searchParams.delete('sslcert');
      connection.searchParams.delete('sslkey');
    }
    const pool = new pg.Pool({ connectionString: connection.toString(), ssl });
    return {
      query: (sql, args) => pool.query(sql, args),
      async transaction(fn) {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
        catch (error) { await c.query('ROLLBACK'); throw error; }
        finally { c.release(); }
      },
      close: () => pool.end()
    };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production');
  let lock;
  const lockPath = `${dir}.lock`;
  if (!dir.startsWith('memory://')) {
    await mkdir(dir, { recursive: true });
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Local database is already open or was not shut down cleanly. Stop the AEZ server before running database scripts.');
      throw error;
    }
    await lock.writeFile(String(process.pid));
  }
  let db;
  try {
    db = new PGlite(dir);
    await db.waitReady;
  } catch (error) {
    if (lock) { await lock.close(); await unlink(lockPath); }
    throw error;
  }
  if (lock) {
    const close = db.close.bind(db);
    db.close = async () => { await close(); await lock.close(); await unlink(lockPath); };
  }
  return db;
}

export async function migrate(db) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.transaction(async tx => {
    for (const statement of sql.split(';').filter(s => s.trim())) await tx.query(statement);
  });
}
