import {openDb,migrate} from '../server/db.js';
const emails=(process.env.ADMIN_EMAILS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
if(!emails.length)throw new Error('Set ADMIN_EMAILS in .env first.');
const db=await openDb();await migrate(db);
try {
  for(const email of emails){
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Invalid admin email');
    await db.transaction(async tx=>{
      await tx.query("INSERT INTO users(email,name,roles,admin) VALUES($1,$2,ARRAY['emp'],true) ON CONFLICT(email) DO UPDATE SET admin=true",[email,email.split('@')[0]]);
      await tx.query("INSERT INTO profiles(email,role) VALUES($1,'emp') ON CONFLICT DO NOTHING",[email]);
    });
  }
  console.log(`Configured ${emails.length} administrator(s).`);
} finally {await db.close();}
