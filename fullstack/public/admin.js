async function openReports() {
    const day = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    let users = [];
    try {
        const userResponse = await fetch('/api/admin/users'), userJson = await userResponse.json();
        if (userResponse.ok) users = userJson.data || [];
    } catch {}
    const employeeOptions = users.map(u => `<option value="${escapeHtml(u.email)}">${escapeHtml(u.name)} - ${escapeHtml(u.email)}</option>`).join('');
    openModal(`<div class="report-header"><h3>Attendance Reports</h3><button id="closeReports" aria-label="Close">&times;</button></div>
        <form id="reportFilters" class="report-filters">
        <label>From<input type="date" name="from" value="${day.slice(0,8)}01" required></label>
        <label>To<input type="date" name="to" value="${day}" required></label>
        <label>Role<select name="role"><option value="all">All roles</option><option value="emp">Employee</option><option value="teach">Educator</option></select></label>
        <label class="employee-filter">Employee<select name="email"><option value="">All users</option>${employeeOptions}</select></label>
        <button type="submit">View</button></form>
        <div class="report-actions"><button id="quickSummary">Today / This Month</button><button id="monthlySummary">Monthly Summary</button><button id="exportCsv">Download CSV</button><button id="exportExcel">Download Excel</button><a href="/api/admin/records?format=csv">All action records</a><button id="systemStatus">System Status</button><button id="manageUsers">Manage Users</button></div>
        <p id="reportStatus" role="status"></p><div id="reportResults" class="report-table"></div>`);
    document.getElementById('modalCard').classList.remove('users-modal');
    document.getElementById('modalCard').classList.add('reports-modal');
    document.getElementById('closeReports').onclick = () => { document.getElementById('modalCard').classList.remove('reports-modal'); closeModal(); };
    const params = () => new URLSearchParams(new FormData(document.getElementById('reportFilters')));
    document.getElementById('exportCsv').onclick = () => download('csv');
    document.getElementById('exportExcel').onclick = () => download('xlsx');
    document.getElementById('quickSummary').onclick = showQuickSummary;
    document.getElementById('systemStatus').onclick = showSystemStatus;
    document.getElementById('monthlySummary').onclick = async () => {
        const status=document.getElementById('reportStatus');status.textContent='Loading monthly summary...';
        try {
            const q=params();q.set('summary','monthly');
            const response=await fetch('/api/admin/reports?'+q),json=await response.json();
            if(!response.ok)throw new Error(json.message);
            const rows=json.data;
            const selected=document.querySelector('#reportFilters [name="email"]').value;
            status.textContent=`${rows.length} monthly summary records${selected ? ` for ${selected}` : ' for all users'}`;
            document.getElementById('reportResults').innerHTML=rows.length?`<table><thead><tr><th>Month</th><th>Employee</th><th>Role</th><th>Present Days</th><th>Work Min</th><th>Work Hours</th><th>Break Min</th><th>Avg/Day</th><th>Classes</th></tr></thead><tbody>${rows.map(r=>`<tr>${[r.MONTH,r.EMPLOYEE,r.ROLE,r['PRESENT DAYS'],r['TOTAL WORKING MINS'],r['TOTAL WORKING HOURS'],r['TOTAL BREAK MINS'],r['AVG WORK MINS / DAY'],r.CLASSES].map(v=>`<td>${escapeHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'No monthly records for this range.';
        } catch(e){status.textContent=e.message;}
    };
    async function download(format) {
        const q=params();q.set('format',format);
        try {
            const response=await fetch('/api/admin/reports?'+q);
            if(!response.ok)throw new Error((await response.json()).message);
            const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');
            link.href=url;link.download=`aez-attendance.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        } catch(e){document.getElementById('reportStatus').textContent=e.message;}
    }
    async function showQuickSummary() {
        const status=document.getElementById('reportStatus');status.textContent='Loading quick summary...';
        try {
            const selected=document.querySelector('#reportFilters [name="email"]').value;
            const todayParams=new URLSearchParams(params());
            todayParams.set('from',day);todayParams.set('to',day);
            const monthParams=params();monthParams.set('summary','monthly');
            const [todayRes,monthRes]=await Promise.all([fetch('/api/admin/reports?'+todayParams),fetch('/api/admin/reports?'+monthParams)]);
            const todayJson=await todayRes.json(),monthJson=await monthRes.json();
            if(!todayRes.ok)throw new Error(todayJson.message);
            if(!monthRes.ok)throw new Error(monthJson.message);
            const todayRows=todayJson.data,monthRows=monthJson.data;
            const todayWork=todayRows.reduce((sum,r)=>sum+r.workingMinutes,0);
            const todayBreak=todayRows.reduce((sum,r)=>sum+r.breakMinutes,0);
            const monthWork=monthRows.reduce((sum,r)=>sum+r['TOTAL WORKING MINS'],0);
            const monthBreak=monthRows.reduce((sum,r)=>sum+r['TOTAL BREAK MINS'],0);
            status.textContent=selected?`Quick summary for ${selected}`:'Quick summary for all users';
            document.getElementById('reportResults').innerHTML=`<div class="quick-summary-grid">
                <div><span>Today Work</span><strong>${todayWork}</strong><small>minutes</small></div>
                <div><span>Today Break</span><strong>${todayBreak}</strong><small>minutes</small></div>
                <div><span>Month Work</span><strong>${monthWork}</strong><small>minutes</small></div>
                <div><span>Month Break</span><strong>${monthBreak}</strong><small>minutes</small></div>
            </div>${monthRows.length?`<div class="report-table"><table><thead><tr><th>Month</th><th>Employee</th><th>Present Days</th><th>Work Hours</th><th>Avg/Day</th></tr></thead><tbody>${monthRows.map(r=>`<tr>${[r.MONTH,r.EMPLOYEE,r['PRESENT DAYS'],r['TOTAL WORKING HOURS'],r['AVG WORK MINS / DAY']].map(v=>`<td>${escapeHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:''}`;
        } catch(e){status.textContent=e.message;}
    }
    async function showSystemStatus() {
        const status=document.getElementById('reportStatus');status.textContent='Checking system status...';
        try {
            const response=await fetch('/api/admin/status');
            const type=response.headers.get('content-type') || '';
            if(!type.includes('application/json'))throw new Error('System status needs the latest server. Restart AEZ Live and refresh the browser.');
            const json=await response.json();
            if(!response.ok)throw new Error(json.message || 'Could not load system status');
            const s=json.data;
            status.textContent='System status loaded';
            document.getElementById('reportResults').innerHTML=`<div class="quick-summary-grid">
                <div><span>Database</span><strong>${escapeHtml(s.database)}</strong><small>Supabase</small></div>
                <div><span>Cron</span><strong>${s.cronConfigured?'Ready':'Missing'}</strong><small>Maintenance</small></div>
                <div><span>Users</span><strong>${s.users}</strong><small>${s.admins} admin</small></div>
            </div>`;
        } catch(e){status.textContent=e.message;}
    }
    document.getElementById('manageUsers').onclick = openUsers;
    document.getElementById('reportFilters').onsubmit = async event => {
        event?.preventDefault();
        const status=document.getElementById('reportStatus');status.textContent='Loading...';
        try {
            const response=await fetch('/api/admin/reports?'+params()),json=await response.json();
            if(!response.ok)throw new Error(json.message);
            const rows=json.data;
            const selected=document.querySelector('#reportFilters [name="email"]').value;
            status.textContent=`${rows.length} records | ${(rows.reduce((sum,r)=>sum+r.workingMinutes,0)/60).toFixed(2)} working hours${selected ? ` for ${selected}` : ' for all users'}`;
            const time=value=>value?new Date(value).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}):'-';
            document.getElementById('reportResults').innerHTML=rows.length?`<table><thead><tr><th>Date</th><th>Name</th><th>Role</th><th>Login</th><th>Logout</th><th>Work (min)</th><th>Break (min)</th><th>Classes</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`<tr>${[r.date,r.name,r.role==='teach'?'Educator':'Employee',time(r.firstLogin),time(r.lastLogout),r.workingMinutes,r.breakMinutes,r.classes,r.status].map(v=>`<td>${escapeHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'No attendance records for this range.';
        } catch(e){status.textContent=e.message;}
    };
    document.getElementById('reportFilters').requestSubmit();
}

async function openUsers() {
    const response=await fetch('/api/admin/users'),json=await response.json();
    if(!response.ok){showToast(json.message,'error');return;}
    document.getElementById('modalCard').classList.add('reports-modal','users-modal');
    openModal(`<div class="report-header"><h3>Registered Users</h3><button onclick="openReports()">Back</button></div>
        <form id="userForm" class="user-form"><label>Name<input name="name" required maxlength="150"></label><label>Email<input name="email" type="email" required></label><label>Role<select name="role"><option value="emp">Employee</option><option value="teach">Educator</option><option value="both">Both</option></select></label><label class="enabled-field"><input name="enabled" type="checkbox" checked> Enabled</label><button>Save User</button></form>
        <p id="userStatus"></p><div class="report-table"><table><thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Enabled</th><th></th></tr></thead><tbody>${json.data.map((u,i)=>`<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.roles.join(', '))}</td><td>${u.enabled?'Yes':'No'}</td><td><button type="button" data-user="${i}">Edit</button></td></tr>`).join('')}</tbody></table></div>`);
    const form=document.getElementById('userForm');
    document.querySelectorAll('[data-user]').forEach(button=>button.onclick=()=>{
        const u=json.data[Number(button.dataset.user)];form.elements.name.value=u.name;form.elements.email.value=u.email;form.elements.role.value=u.roles.length===2?'both':u.roles[0];form.elements.enabled.checked=u.enabled;
    });
    form.onsubmit=async event=>{
        event.preventDefault();
        const v=Object.fromEntries(new FormData(form)),roles=v.role==='both'?['emp','teach']:[v.role];
        try {
            const response=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:v.name,email:v.email,roles,enabled:form.elements.enabled.checked})});
            const result=await response.json();if(!response.ok)throw new Error(result.message);
            showToast('User saved. They can now sign in with this Google email.', 'success', 4500);
            form.reset();form.elements.enabled.checked=true;
            await openUsers();
        } catch(e){document.getElementById('userStatus').textContent=e.message;}
    };
}
