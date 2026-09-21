import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { fail, recordTransition, saveChange, undo, reconcile } from './domain.js';
import { report, csv, safeCell, sheetRows, monthlySummary } from './reports.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');

export function createApp(db, config = {}) {
  const app = express();
  const origin = config.origin || process.env.APP_ORIGIN || 'http://localhost:3100';
  const clientId = process.env.GOOGLE_CLIENT_ID || '178807966999-j9p2ub2kimt46avtqsplm7jc20t9b5k4.apps.googleusercontent.com';
  const google = new OAuth2Client(clientId);
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set('X-Content-Type-Options','nosniff'); res.set('Referrer-Policy','same-origin');
    res.set('X-Frame-Options','DENY');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('origin') !== origin) return res.status(403).json({status:'error',message:'Untrusted request origin'});
    next();
  });
  app.use(express.json({limit:'8mb',type:['application/json','text/plain']}));
  app.get('/api/config', (req,res) => res.json({googleClientId:clientId}));
  app.get('/health', async (req,res) => { await db.query('SELECT 1'); res.json({status:'ok',service:'aez-live'}); });
  app.post('/api/auth/google', rateLimit({windowMs:60000,limit:20}), async (req,res) => {
    if (typeof req.body.credential !== 'string') fail('Google credential is required.');
    const payload = config.verifyToken ? await config.verifyToken(req.body.credential) : (await google.verifyIdToken({idToken:req.body.credential,audience:clientId})).getPayload();
    if (!payload?.email_verified || !payload.email) fail('Email verification failed.',401);
    const email = payload.email.toLowerCase();
    const {rows} = await db.query('SELECT * FROM users WHERE email=$1 AND enabled=true',[email]);
    if (!rows.length) fail('This email is not registered. Contact your admin.',403);
    const token = randomBytes(32).toString('hex');
    await db.query("INSERT INTO sessions(token_hash,email,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(token),email]);
    res.cookie('aez_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:30*86400000,path:'/'});
    res.json({status:'success'});
  });
  app.use('/api', async (req,res,next) => {
    res.set('Cache-Control','no-store');
    const token = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('aez_session='))?.slice(12);
    if (!token) fail('Please sign in.',401);
    const {rows} = await db.query('SELECT u.* FROM sessions s JOIN users u USING(email) WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled=true',[hash(token)]);
    if (!rows.length) fail('Please sign in again.',401);
    req.user=rows[0]; req.sessionHash=hash(token); next();
  });
  app.get('/api/auth/me',(req,res)=>res.json({status:'success',email:req.user.email,isEmp:req.user.roles.includes('emp'),isTeach:req.user.roles.includes('teach'),isAdmin:req.user.admin,authorized:true}));
  app.post('/api/auth/logout',async(req,res)=>{
    await db.query('DELETE FROM sessions WHERE token_hash=$1',[req.sessionHash]);
    res.clearCookie('aez_session',{path:'/'});res.json({status:'success'});
  });
  app.get('/api',async(req,res)=>{
    const {rows}=await db.query('SELECT p.*,u.name FROM profiles p JOIN users u USING(email) WHERE u.enabled=true ORDER BY u.name');
    const dashboard=rows.map(p=>({email:p.email,name:p.name,role:p.role,status:p.state.status,pendingResume:!!p.state.pendingResume,classSession:p.state.classSession,
      leaveStart:p.state.leave?.startDate,leaveResume:p.state.leave?.resumeDate,
      leaveEnd:p.state.leave ? new Date(+new Date(p.state.leave.resumeDate+'T00:00:00+05:30')-1).toISOString():null,
      leaveReason:req.user.admin||p.email===req.user.email?p.state.leave?.reason:'',proofUrl:req.user.admin||p.email===req.user.email?p.state.leave?.proofUrl:''}));
    const approvals=req.user.admin?rows.filter(p=>p.state.pendingResume).map(p=>({id:p.state.pendingResume,email:p.email,name:p.name,role:p.role})):[];
    let notifications=[],latestNotificationId=null;
    if(req.user.admin){
      latestNotificationId=Number((await db.query('SELECT COALESCE(MAX(id),0) AS id FROM notifications')).rows[0].id);
      const lastId=Number(req.query.lastId)||0;
      if(req.query.lastId!=='null')notifications=(await db.query('SELECT n.* FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.id>$1 AND NOT e.undone ORDER BY n.id LIMIT 100',[lastId])).rows.map(n=>({...n,id:Number(n.id),eventType:n.event_type,timestamp:new Date(n.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}));
    }
    res.json({status:'success',data:dashboard,dashboard,approvals,notifications,latestNotificationId});
  });
  app.post('/api', rateLimit({windowMs:60000,limit:90}),async(req,res)=>{
    const p=req.body || {}, email=req.user.email;
    if(p.action==='Upload Leave Proof'){
      if(!req.user.roles.includes(p.role)) fail('Role not authorized.',403);
      const types={'application/pdf':'25504446','image/png':'89504e470d0a1a0a','image/jpeg':'ffd8ff'};
      if(!types[p.mimeType]||typeof p.base64Data!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(p.base64Data)) fail('Invalid file.');
      const bytes=Buffer.from(p.base64Data,'base64');
      if(!bytes.length||bytes.length>5*1024*1024||!bytes.toString('hex',0,8).startsWith(types[p.mimeType])) fail('Use a valid PDF, JPEG or PNG, maximum 5 MB.');
      const id=randomUUID();
      await db.query('INSERT INTO proofs(id,email,name,mime,bytes) VALUES($1,$2,$3,$4,$5)',[id,email,String(p.fileName||'proof').slice(0,200),p.mimeType,bytes]);
      return res.json({status:'success',url:`/api/proofs/${id}`});
    }
    const result=await db.transaction(async tx=>{
      // All mutation paths acquire profile locks in a stable order.
      await reconcile(tx);
      if(p.action==='Undo Action'){
        if(!uuid(p.undoToken)) fail('Invalid undo token.');
        return undo(tx,email,p.undoToken,new Date());
      }
      if(p.action==='Admin Resume Decision'){
        if(!req.user.admin) fail('Admin access required.',403);
        if(!['approve','deny'].includes(p.decision)||!uuid(p.requestId)) fail('Invalid decision.');
        const {rows}=await tx.query("SELECT * FROM profiles WHERE state->>'pendingResume'=$1 FOR UPDATE",[p.requestId]);
        const profile=rows[0];if(!profile)fail('Request already handled.');
        const state={...profile.state,pendingResume:null};
        if(p.decision==='approve')state.status='Offline';
        const result=await saveChange(tx,profile,{state,data:{decision:p.decision},message:p.decision==='approve'?'Returned from leave (admin-approved early return)':'Resume request declined'},p.action,email,new Date());
        delete result.undoToken;return result;
      }
      if(!req.user.roles.includes(p.role)) fail('Role not authorized.',403);
      if(!uuid(p.requestId))fail('Request ID is required.');
      const previous=(await tx.query('SELECT * FROM events WHERE request_id=$1',[p.requestId])).rows[0];
      if(previous){if(previous.email!==email)fail('Request ID already used.');return {status:'success',message:previous.data.message};}
      if(p.proofUrl){
        const id=p.proofUrl.startsWith('/api/proofs/')?p.proofUrl.slice(12):'';
        if(!uuid(id)||(await tx.query('SELECT id FROM proofs WHERE id=$1 AND email=$2',[id,email])).rows.length===0)fail('Proof document is not yours.');
      }
      const {rows}=await tx.query('SELECT * FROM profiles WHERE email=$1 AND role=$2 FOR UPDATE',[email,p.role]);
      if(!rows[0])fail('Role not configured.',403);
      return recordTransition(tx,rows[0],p,email,new Date(),p.requestId);
    });
    res.json(result);
  });
  app.get('/api/proofs/:id',async(req,res)=>{
    if(!uuid(req.params.id))fail('Document not found.',404);
    const {rows}=await db.query('SELECT * FROM proofs WHERE id=$1',[req.params.id]);
    const file=rows[0];if(!file||(!req.user.admin&&file.email!==req.user.email))fail('Document not found.',404);
    res.set('Content-Type',file.mime).set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).send(Buffer.from(file.bytes));
  });
  app.use('/api/admin',(req,res,next)=>{if(!req.user.admin)fail('Admin access required.',403);next();});
  app.get('/api/admin/status',async(req,res)=>{
    const users=Number((await db.query('SELECT count(*) AS count FROM users WHERE enabled=true')).rows[0].count);
    const admins=Number((await db.query('SELECT count(*) AS count FROM users WHERE admin=true AND enabled=true')).rows[0].count);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const pendingMail=Number((await db.query("SELECT count(*) AS count FROM mail_jobs WHERE state='pending'")).rows[0].count);
    res.json({status:'success',data:{
      database:'ok',
      smtpConfigured:!!(process.env.SMTP_HOST&&process.env.MAIL_FROM),
      summaryRecipientsConfigured:!!(process.env.SUMMARY_RECIPIENTS||admins),
      admins,
      users,
      pendingMail,
      today
    }});
  });
  app.get('/api/admin/reports',async(req,res)=>{
    const rows=await report(db,req.query);
    if(req.query.summary==='monthly')return res.json({status:'success',data:monthlySummary(rows)});
    if(req.query.format==='csv')return res.type('text/csv').attachment('aez-attendance.csv').send(csv(sheetRows(rows)));
    if(req.query.format==='xlsx'){
      const workbook=new ExcelJS.Workbook(),detail=workbook.addWorksheet('Daily Tracker'),summary=workbook.addWorksheet('Monthly Summary');
      const addRows=(sheet,data,fallback)=>{const keys=Object.keys(data[0]||fallback);sheet.columns=keys.map(key=>({header:key,key,width:24}));data.forEach(r=>sheet.addRow(Object.fromEntries(Object.entries(r).map(([k,v])=>[k,safeCell(v)]))));sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];};
      addRows(detail,sheetRows(rows),{'DATE / DAY':'',EMPLOYEE:'','LOGGED IN':'','LOGGED OUT':'','WORKING MINS (TODAY)':'','BREAK MINS (TODAY)':'','BREAK TIMES (TODAY)':'',REMARKS:''});
      addRows(summary,monthlySummary(rows),{MONTH:'',EMPLOYEE:'',ROLE:'','PRESENT DAYS':'','TOTAL WORKING MINS':'','TOTAL WORKING HOURS':'','TOTAL BREAK MINS':'','AVG WORK MINS / DAY':'',CLASSES:'','FIRST DATE':'','LAST DATE':''});
      res.attachment('aez-attendance.xlsx').type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
    }
    res.json({status:'success',data:rows});
  });
  app.get('/api/admin/records',async(req,res)=>{
    const rows=(await db.query('SELECT e.id,e.email,e.role,e.action,e.at,e.data,e.undone FROM events e ORDER BY at DESC')).rows;
    if(req.query.format==='csv')return res.type('text/csv').attachment('aez-events.csv').send(csv(rows.map(r=>({...r,data:JSON.stringify(r.data)}))));
    res.json({status:'success',data:rows});
  });
  app.get('/api/admin/imported',async(req,res)=>{
    const rows=(await db.query('SELECT kind,data FROM imported_records ORDER BY kind,imported_at,id')).rows;
    const width=Math.max(0,...rows.map(r=>r.data.values.length));
    const exported=rows.map(r=>Object.fromEntries([['recordType',r.kind],['sourceRow',r.data.sourceRow],...Array.from({length:width},(_,i)=>[`column${i+1}`,r.data.values[i]??''])]));
    res.type('text/csv').attachment('aez-imported-history.csv').send(csv(exported));
  });
  app.get('/api/admin/users',async(req,res)=>res.json({status:'success',data:(await db.query('SELECT * FROM users ORDER BY name')).rows}));
  app.post('/api/admin/users',async(req,res)=>{
    const {email,name,roles,enabled=true}=req.body;
    if(typeof email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name?.trim()||!Array.isArray(roles)||!roles.length||roles.some(r=>!['emp','teach'].includes(r))||typeof enabled!=='boolean')fail('Enter a valid name, email and role.');
    const normalized=email.toLowerCase().trim();
    await db.transaction(async tx=>{
      const active=(await tx.query('SELECT * FROM profiles WHERE email=$1 FOR UPDATE',[normalized])).rows;
      if(active.some(p=>(!enabled||!roles.includes(p.role))&&(p.state.work||p.state.status==='On Leave')))fail('Close attendance and leave before disabling this user or role.');
      await tx.query('INSERT INTO users(email,name,roles,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET name=$2,roles=$3,enabled=$4',[normalized,name.trim(),roles,enabled]);
      for(const role of roles)await tx.query('INSERT INTO profiles(email,role) VALUES($1,$2) ON CONFLICT DO NOTHING',[normalized,role]);
      await tx.query('DELETE FROM profiles WHERE email=$1 AND NOT(role=ANY($2::text[]))',[normalized,roles]);
    });
    res.json({status:'success',message:'User saved'});
  });
  app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
  app.use((err,req,res,next)=>{
    if(!err.status)console.error(err);
    res.status(err.status||500).json({status:'error',message:err.status?err.message:'Server error. Please try again.'});
  });
  return app;
}
