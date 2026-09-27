import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDb,migrate} from '../server/db.js';
import {createApp} from '../server/app.js';
import {transition,reconcile,recordTransition,undo,dateKey} from '../server/domain.js';
import {summarize,report,csv} from '../server/reports.js';
import {tick} from '../server/worker.js';

let db,server,url;
const start=new Date('2026-09-16T04:30:00Z');
before(async()=>{
  db=await openDb('', 'memory://');await migrate(db);
  server=createApp(db,{origin:'http://localhost:3100',verifyToken:async credential=>({email:credential,email_verified:true})}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
async function user(admin=false,role='emp'){
  const email=`${randomUUID()}@example.com`;
  await db.query('INSERT INTO users(email,name,roles,admin) VALUES($1,$2,$3,$4)',[email,'Test User',[role],admin]);
  await db.query('INSERT INTO profiles(email,role) VALUES($1,$2)',[email,role]);
  const response=await fetch(url+'/api/auth/google',{method:'POST',headers:{Origin:'http://localhost:3100','Content-Type':'application/json'},body:JSON.stringify({credential:email})});
  assert.equal(response.status,200);
  return {email,cookie:response.headers.get('set-cookie').split(';')[0],role};
}
async function api(u,path='/api',body=null){
  const response=await fetch(url+path,{method:body?'POST':'GET',headers:{Cookie:u.cookie,Origin:'http://localhost:3100','Content-Type':'application/json'},body:body?JSON.stringify({role:u.role,requestId:randomUUID(),...body}):undefined});
  return {response,json:await response.json()};
}
async function actionAt(email,role,action,at,extras={}){
  return db.transaction(async tx=>{
    const p=(await tx.query('SELECT * FROM profiles WHERE email=$1 AND role=$2 FOR UPDATE',[email,role])).rows[0];
    return recordTransition(tx,p,{action,...extras},email,new Date(at),randomUUID());
  });
}
test('authentication refuses email impersonation and protects admin exports',async()=>{
  assert.equal((await fetch(url+'/api?email=someone@example.com')).status,401);
  const u=await user();
  assert.equal((await api(u,'/api/admin/reports')).response.status,403);
  const result=await api(u,'/api',{action:'Active',email:'different@example.com'});
  assert.equal(result.response.status,200);
  assert.equal((await db.query('SELECT state FROM profiles WHERE email=$1',[u.email])).rows[0].state.status,'Active');
  assert.equal((await api(u,'/api',{action:'Active',role:'teach'})).response.status,403);
  assert.equal((await fetch(url+'/api/auth/logout',{method:'POST',headers:{Cookie:u.cookie,Origin:'https://evil.example'}})).status,403);
});
test('employee work totals exclude breaks, preserve multiple sessions and split midnight',()=>{
  let s={status:'Offline'};
  s=transition(s,'emp',{action:'Active'},start).state;
  s=transition(s,'emp',{action:'On Break'},new Date(+start+30*60000)).state;
  s=transition(s,'emp',{action:'Active'},new Date(+start+45*60000)).state;
  const closed=transition(s,'emp',{action:'Offline'},new Date(+start+120*60000)).data.closedSession;
  const result=summarize([{...closed,email:'x',name:'X',role:'emp'}],'2026-09-16','2026-09-16');
  assert.equal(result[0].workingMinutes,105);assert.equal(result[0].breakMinutes,15);
  const overnight=summarize([{start:'2026-09-16T23:30:00+05:30',end:'2026-09-17T00:30:00+05:30',breaks:[],email:'x',name:'X',role:'emp'}],'2026-09-16','2026-09-17');
  assert.deepEqual(overnight.map(r=>r.workingMinutes),[30,30]);
});
test('closed-tab class auto-end uses 60-minute deadline and retains report data',async()=>{
  const u=await user(false,'teach');
  await actionAt(u.email,'teach','Active',start,{subject:'Maths',student:'Student'});
  await db.transaction(tx=>reconcile(tx,new Date(+start+62*60000)));
  assert.equal((await db.query('SELECT state FROM profiles WHERE email=$1',[u.email])).rows[0].state.status,'Active');
  await db.transaction(tx=>reconcile(tx,new Date(+start+64*60000)));
  assert.equal((await db.query('SELECT state FROM profiles WHERE email=$1',[u.email])).rows[0].state.status,'Offline');
  const rows=await report(db,{from:dateKey(start),to:dateKey(start),email:u.email},new Date(+start+65*60000));
  assert.equal(rows[0].workingMinutes,60);assert.equal(rows[0].classes,1);
  await db.transaction(tx=>reconcile(tx,new Date(+start+100*60000)));
  assert.equal((await report(db,{from:dateKey(start),to:dateKey(start),email:u.email}))[0].classes,1);
});
test('only one extension; exact 90-minute stop even if teacher is on break',()=>{
  let s=transition({status:'Offline'},'teach',{action:'Active',subject:'Maths',student:'Student'},start).state;
  assert.throws(()=>transition(s,'teach',{action:'Extend Class Session',classSessionId:s.classSession.id},new Date(+start+10*60000)));
  s=transition(s,'teach',{action:'Extend Class Session',classSessionId:s.classSession.id},new Date(+start+61*60000)).state;
  assert.throws(()=>transition(s,'teach',{action:'Extend Class Session',classSessionId:s.classSession.id},new Date(+start+62*60000)));
  assert.equal(+new Date(s.classSession.endTime)-+start,90*60000);
  s=transition(s,'teach',{action:'On Break'},new Date(+start+70*60000)).state;
  const result=transition(s,'teach',{action:'Auto End Class'},new Date(+start+100*60000));
  assert.equal(+new Date(result.data.closedSession.end)-+start,90*60000);
});
test('undo restores work state and excludes undone logout from reports',async()=>{
  const u=await user();
  await actionAt(u.email,'emp','Active',start);
  const end=new Date(+start+60000),result=await actionAt(u.email,'emp','Offline',end);
  await db.transaction(tx=>undo(tx,u.email,result.undoToken,new Date(+end+1000)));
  assert.equal((await db.query('SELECT state FROM profiles WHERE email=$1',[u.email])).rows[0].state.status,'Active');
  const rows=await report(db,{from:dateKey(start),to:dateKey(start),email:u.email},new Date(+start+120000));
  assert.equal(rows[0].workingMinutes,2);
  await assert.rejects(()=>db.transaction(tx=>undo(tx,u.email,result.undoToken,new Date(+end+2000))));
});
test('API idempotency and logout revoke persistent sessions',async()=>{
  const u=await user(),requestId=randomUUID();
  await api(u,'/api',{action:'Active',requestId});
  assert.equal((await api(u,'/api',{action:'Active',requestId})).response.status,200);
  assert.equal((await db.query('SELECT * FROM events WHERE request_id=$1',[requestId])).rows.length,1);
  await api(u,'/api/auth/logout',{});
  assert.equal((await api(u,'/api/auth/me')).response.status,401);
});
test('leave proof access, early resume approval, completed leave',async()=>{
  const u=await user(),other=await user(),admin=await user(true);
  const upload=await api(u,'/api',{action:'Upload Leave Proof',fileName:'medical.pdf',mimeType:'application/pdf',base64Data:Buffer.from('%PDF-1.4 test').toString('base64')});
  assert.equal(upload.response.status,200);
  assert.equal((await fetch(url+upload.json.url,{headers:{Cookie:other.cookie}})).status,404);
  assert.equal((await fetch(url+upload.json.url,{headers:{Cookie:admin.cookie}})).status,200);
  const today=dateKey(new Date()),tomorrow=dateKey(new Date(Date.now()+86400000));
  assert.equal((await api(u,'/api',{action:'On Leave',reason:'Medical',startDate:today,resumeDate:tomorrow,proofUrl:upload.json.url})).response.status,200);
  await api(u,'/api',{action:'Active'});
  const state=(await db.query('SELECT state FROM profiles WHERE email=$1',[u.email])).rows[0].state;
  assert.ok(state.pendingResume);
  assert.equal((await api(other,'/api',{action:'Admin Resume Decision',requestId:state.pendingResume,decision:'approve'})).response.status,403);
  assert.equal((await api(admin,'/api',{action:'Admin Resume Decision',requestId:state.pendingResume,decision:'approve'})).response.status,200);
  assert.equal((await db.query('SELECT state FROM profiles WHERE email=$1',[u.email])).rows[0].state.status,'Offline');
});
test('admin exports return real CSV and XLSX; formula cells are escaped',async()=>{
  const admin=await user(true);
  const csvRes=await fetch(url+'/api/admin/reports?format=csv',{headers:{Cookie:admin.cookie}});
  assert.equal(csvRes.status,200);assert.match(await csvRes.text(),/WORKING MINS \(TODAY\)/);
  const monthlyRes=await fetch(url+'/api/admin/reports?summary=monthly',{headers:{Cookie:admin.cookie}});
  assert.equal(monthlyRes.status,200);assert.ok(Array.isArray((await monthlyRes.json()).data));
  const xlsxRes=await fetch(url+'/api/admin/reports?format=xlsx',{headers:{Cookie:admin.cookie}});
  assert.equal(xlsxRes.status,200);assert.equal(Buffer.from(await xlsxRes.arrayBuffer()).subarray(0,2).toString(),'PK');
  assert.match(csv([{name:'=SUM(1,2)'}]),/'=SUM/);
});
test('cron maintenance clears expired sessions without sending email jobs',async()=>{
  const u=await user();
  await db.query("UPDATE sessions SET expires_at=$1 WHERE email=$2",[new Date('2026-09-18T00:00:00Z'),u.email]);
  const result=await tick(db,new Date('2026-09-19T00:00:00Z'));
  assert.equal(result.status,'success');
  assert.equal(result.cleanedSessions,1);
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM sessions WHERE email=$1',[u.email])).rows[0].count),0);
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM mail_jobs')).rows[0].count),0);
});
