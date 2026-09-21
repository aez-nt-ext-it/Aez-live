import nodemailer from 'nodemailer';
import { reconcile, dateKey } from './domain.js';
import { report } from './reports.js';

export async function tick(db, now = new Date(), mailer = null) {
  await db.transaction(tx=>reconcile(tx,now));
  await db.query('DELETE FROM sessions WHERE expires_at<$1',[now]);
  const clock = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  if(clock >= '23:50')await db.query('INSERT INTO mail_jobs(day,next_attempt) VALUES($1,$2) ON CONFLICT DO NOTHING',[dateKey(now),now]);
  if(!mailer)return;
  // A locked job prevents two worker instances sending the same summary concurrently.
  await db.transaction(async tx=>{
    const {rows}=await tx.query("SELECT * FROM mail_jobs WHERE state='pending' AND next_attempt<=$1 ORDER BY day LIMIT 1 FOR UPDATE SKIP LOCKED",[now]);
    const job=rows[0];if(!job)return;
    const day=typeof job.day==='string'?job.day.slice(0,10):dateKey(job.day);
    try {
      const records=await report(tx,{from:day,to:day},now);
      const users=(await tx.query('SELECT u.email,u.name,p.role,p.state FROM profiles p JOIN users u USING(email) WHERE enabled=true')).rows;
      const lines=[`Daily Operations Summary - ${day}`];
      for(const role of ['emp','teach']){
        const group=users.filter(u=>u.role===role),r=records.filter(r=>r.role===role);
        lines.push('',role==='emp'?'Employees':'Educators',`Total: ${group.length}`);
        for(const status of ['Active','On Break','On Leave','Offline','Weekoff'])lines.push(`${status}: ${group.filter(u=>u.state.status===status).length}`);
        lines.push(`Working hours: ${(r.reduce((sum,r)=>sum+r.workingMinutes,0)/60).toFixed(2)}`);
        if(role==='teach')lines.push(`Classes completed: ${r.reduce((sum,r)=>sum+r.classes,0)}`);
      }
      const counts=(await tx.query("SELECT event_type,count(*) AS count FROM notifications n JOIN events e ON e.id=n.event_id WHERE NOT e.undone AND (n.at AT TIME ZONE 'Asia/Kolkata')::date=$1 GROUP BY event_type",[day])).rows;
      lines.push('',...counts.map(c=>`${c.event_type}: ${c.count}`),'','Currently on leave:',...users.filter(u=>u.state.status==='On Leave').map(u=>`${u.name} (${u.role})`),'','Generated automatically by AEZ Live');
      const admins=(await tx.query('SELECT email FROM users WHERE admin=true AND enabled=true')).rows.map(u=>u.email);
      const recipients=process.env.SUMMARY_RECIPIENTS?.split(',').map(s=>s.trim()).filter(Boolean)||admins;
      if(!recipients.length)throw new Error('No summary recipients configured');
      await mailer.sendMail({from:process.env.MAIL_FROM,to:recipients,subject:`AEZ Live Daily Summary - ${day}`,text:lines.join('\n'),messageId:`<aez-summary-${day}@aez-live.local>`});
      await tx.query("UPDATE mail_jobs SET state='sent',sent_at=$2,attempts=attempts+1,last_error=NULL WHERE day=$1",[day,now]);
    } catch(error){
      await tx.query("UPDATE mail_jobs SET attempts=attempts+1,last_error=$2,next_attempt=$3 WHERE day=$1",[day,String(error.message).slice(0,1000),new Date(+now+5*60000)]);
      console.error('Daily summary failed:',error.message);
    }
  });
}

export function startWorker(db) {
  const mailer=process.env.SMTP_HOST?nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_PORT==='465',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined,connectionTimeout:15000,socketTimeout:20000}):null;
  let running=false;
  const run=async()=>{if(running)return;running=true;try{await tick(db,new Date(),mailer);}catch(e){console.error('Worker failed:',e);}finally{running=false;}};
  const timer=setInterval(run,15000);run();
  return ()=>clearInterval(timer);
}
