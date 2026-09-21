import { openDb, migrate } from './db.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { existingServer } from './startup.js';

const port = Number(process.env.PORT || 3100);
const url = process.env.APP_ORIGIN || `http://localhost:${port}`;
if (await existingServer(port)) {
  console.log(`AEZ Live is already running at ${url}. Open this URL in your browser. No second server was started.`);
  process.exit(0);
}
try {
const db=await openDb();
await migrate(db);
if(process.env.NODE_ENV==='production'&&!process.env.APP_ORIGIN?.startsWith('https://'))throw new Error('Production APP_ORIGIN must use HTTPS');
const server=createApp(db).listen(Number(process.env.PORT||3100),process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1',()=>console.log(`AEZ Live: ${process.env.APP_ORIGIN||'http://localhost:3100'}`));
const stopWorker=startWorker(db);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopWorker();server.close(async()=>{await db.close();process.exit(0);});});
server.on('error', async error => {
  stopWorker();
  await db.close();
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is occupied. Stop the other server or choose another PORT and APP_ORIGIN.` : error.message);
  process.exitCode = 1;
});
} catch (error) {
  console.error(`AEZ Live could not start: ${error.message}`);
  console.error('Do not delete database files or its lock. Check whether another AEZ server is running.');
  process.exitCode = 1;
}
