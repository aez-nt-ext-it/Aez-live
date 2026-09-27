// --- TOAST + MODAL ENGINE (replaces native confirm()/prompt()) ---

function showToast(text, type = "info", duration = 3500) {
    const stack = document.getElementById('toastStack');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerText = text;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 200);
    }, duration);
}

function openModal(html) {
    document.getElementById('modalCard').innerHTML = html;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
}

function closeModal() {
    document.getElementById('modalCard').classList.remove('reports-modal', 'users-modal');
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    document.getElementById('modalCard').innerHTML = '';
}

// Confirm dialog: title + message + two labeled buttons, resolves like window.confirm did.
function showConfirmModal({ title, message, okLabel = "OK", cancelLabel = "Cancel", onOk, onCancel }) {
    openModal(`
        <h3 class="font-bold text-base text-[#0b3d4f] mb-2">${title}</h3>
        <p class="text-sm text-slate-600 mb-6 leading-relaxed">${message}</p>
        <div class="flex gap-2 justify-end">
            <button id="modalCancelBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-100 text-[#0b3d4f] hover:bg-slate-200">${cancelLabel}</button>
            <button id="modalOkBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-[#0D9488] text-white hover:bg-[#0b7a70]">${okLabel}</button>
        </div>
    `);
    document.getElementById('modalOkBtn').onclick = () => { closeModal(); onOk && onOk(); };
    document.getElementById('modalCancelBtn').onclick = () => { closeModal(); onCancel && onCancel(); };
}

// Form dialog: title + arbitrary labeled inputs, resolves with a values object like prompt() chains did.
function showFormModal({ title, fields, submitLabel = "Submit", onSubmit }) {
    const fieldsHtml = fields.map(f => `
        <div class="modal-field mb-4">
            <label for="field_${f.id}">${f.label}</label>
            <input id="field_${f.id}" type="${f.type || 'text'}" ${f.value ? `value="${f.value}"` : ''} placeholder="${f.placeholder || ''}" />
        </div>
    `).join('');

    openModal(`
        <h3 class="font-bold text-base text-[#0b3d4f] mb-4">${title}</h3>
        ${fieldsHtml}
        <div class="flex gap-2 justify-end mt-2">
            <button id="modalCancelBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-100 text-[#0b3d4f] hover:bg-slate-200">Cancel</button>
            <button id="modalSubmitBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-[#0D9488] text-white hover:bg-[#0b7a70]">${submitLabel}</button>
        </div>
    `);

    document.getElementById('modalCancelBtn').onclick = closeModal;
    document.getElementById('modalSubmitBtn').onclick = () => {
        const submitBtn = document.getElementById('modalSubmitBtn');
        const values = {};
        for (const f of fields) {
            values[f.id] = document.getElementById(`field_${f.id}`).value.trim();
            if (f.required && !values[f.id]) {
                showToast(`${f.label} is required`, "error");
                return;
            }
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = "Sending...";
        }
        closeModal();
        onSubmit(values);
    };
    // Focus first field for quick keyboard entry
    const firstInput = document.getElementById(`field_${fields[0].id}`);
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

const API_URL = '/api';
let GOOGLE_CLIENT_ID = '';
let isAdmin = false;
let dashboardPoll = null;
let googleWaitTimer = null;
let googleWaitStarted = 0;


let currentUser = null;
let currentRole = 'emp';
let dashboardData = [];
let adminRequests = [];
let lastNotifId = null;
let resumeRequestPending = false;
let undoTimer = null;
let currentUndoToken = "";
let classTimer = null;
let activeClassSessionId = "";
let activeClassEndTime = "";
let classWarningShown = false;
let classPromptShown = false;

// Initialize App
async function initializeApp() {
    clearTimeout(googleWaitTimer);
    googleWaitStarted = Date.now();
    document.getElementById('loginRetry').classList.add('hidden');
    document.getElementById('loginStatus').textContent = 'Loading sign-in...';
    try {
        const response = await fetch('/api/config', {signal: AbortSignal.timeout(45000)});
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('connection');
        const config = await response.json();
        if (!config.googleClientId) throw new Error('configuration');
        GOOGLE_CLIENT_ID = config.googleClientId;
        await restoreSession();
    } catch (error) {
        document.getElementById('loginStatus').textContent = 'AEZ Live is taking longer to wake up. Please wait 30 seconds and tap Retry.';
        document.getElementById('loginRetry').classList.remove('hidden');
    }
}
document.addEventListener('DOMContentLoaded', initializeApp);

async function restoreSession() {
    const response = await fetch('/api/auth/me', {signal: AbortSignal.timeout(45000)});
    if (response.status === 401) { renderGoogleButton(); return; }
    if (!response.ok) throw new Error('Could not check session');
    const user = await response.json();
    currentUser = user.email;
    isAdmin = user.isAdmin;
    currentRole = user.isEmp ? 'emp' : 'teach';
    showApp();
}

// --- AUTHENTICATION ---
function renderGoogleButton() {
    if (!window.google?.accounts?.id) {
        if (Date.now() - googleWaitStarted > 15000) {
            document.getElementById('loginStatus').textContent = 'Google sign-in could not load. Check your connection or browser blocking settings, then retry.';
            document.getElementById('loginRetry').classList.remove('hidden');
            return;
        }
        googleWaitTimer = setTimeout(renderGoogleButton, 300); return;
    }
    document.getElementById('loginStatus').textContent = '';
    document.getElementById('googleButtonContainer').innerHTML = '';
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse
    });
    google.accounts.id.renderButton(
        document.getElementById("googleButtonContainer"),
        { theme: "outline", size: "large", shape: "pill", width: 280 }
    );
}

async function handleCredentialResponse(response) {
    showToast("Checking access...", "info", 2000);
    try {
        const res = await fetch('/api/auth/google', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:response.credential})});
        const json = await res.json();
        if (json.status === "success") {
            await restoreSession();
        } else {
            showToast(json.message || 'Sign in failed.', "error", 5000);
            google.accounts.id.disableAutoSelect();
        }
    } catch (err) {
        showToast("Could not verify access. Check your connection and try again.", "error", 5000);
    }
}

function parseJwt(token) {
    var base64Url = token.split('.')[1];
    var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    var jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
}

async function logout() {
    try {
        const response = await fetch('/api/auth/logout', {method:'POST'});
        if (!response.ok) throw new Error();
    } catch { showToast('Could not sign out. Please retry.', 'error'); return; }
    clearInterval(dashboardPoll);
    stopClassTimer();
    lastNotifId = null;
    isAdmin = false;
    currentUser = null;
    localStorage.removeItem('aez_user_email');
    if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
    }
    document.getElementById('appScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    renderGoogleButton();
}

function showApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('userDisplay').innerText = currentUser;
    bindDashboardTools();
    renderControls('Offline');

    document.getElementById('adminUsersButton').classList.toggle('hidden', !isAdmin);
    document.getElementById('adminReportsButton').classList.toggle('hidden', !isAdmin);
    switchTab(currentRole);
    clearInterval(dashboardPoll);
    if (isAdmin) {
        if ('Notification' in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
            Notification.requestPermission();
        }
        pollBackend(); // Fetch instantly on load
        dashboardPoll = setInterval(pollBackend, 2000);
    } else {
        fetchDashboard(); // Fetch instantly on load
        dashboardPoll = setInterval(fetchDashboard, 5000);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) {
        if (isAdmin) pollBackend();
        else fetchDashboard();
    }
});

// --- NATIVE NOTIFICATIONS & DASHBOARD FETCH ---
async function pollBackend() {
    try {
        const res = await fetch(`${API_URL}?action=poll&lastId=${lastNotifId}&email=${currentUser}&t=${Date.now()}`, {
            cache: 'no-store'
        });
        const json = await res.json();

        if (json.status === "success") {
            // Bulletproof parsing: accepts both new API format and old format safely
            dashboardData = json.dashboard || json.data || [];
            if (!Array.isArray(dashboardData)) dashboardData = [];
            adminRequests = Array.isArray(json.approvals) ? json.approvals : [];

            renderDashboard();

            if (lastNotifId === null) lastNotifId = json.latestNotificationId || 0;
            if (json.notifications && json.notifications.length > 0) {
                json.notifications.forEach(notif => {
                    if (notif.id > lastNotifId) {
                        triggerSystemNotification(notif);
                        lastNotifId = notif.id;
                    }
                });
            }
        } else {
            showToast(json.message || "Could not load dashboard", "error");
        }
    } catch (err) {
        console.log("Polling error:", err);
        showToast("Connection issue loading dashboard", "error");
    }
}

async function fetchDashboard() {
    try {
        const res = await fetch(`${API_URL}?action=dashboard&t=${Date.now()}`, { cache: 'no-store' });
        const json = await res.json();
        if (json.status === "success") {
            dashboardData = json.data || [];
            if (!Array.isArray(dashboardData)) dashboardData = [];
            adminRequests = [];
            renderDashboard();
        } else {
            showToast(json.message || "Could not load dashboard", "error");
        }
    } catch (err) {
        console.log("Fetch error:", err);
        showToast("Connection issue loading dashboard", "error");
    }
}

function triggerSystemNotification(notifOrName, legacyAction) {
    if (typeof notifOrName === 'object') showToast(`${notifOrName.name} ${notifOrName.action}`, 'info');
    if ('Notification' in window && Notification.permission === "granted") {
        playBeep();
        const notif = typeof notifOrName === "object"
            ? notifOrName
            : { name: notifOrName, action: legacyAction };
        const name = notif.name || "AEZ Live";
        const action = notif.action || notif.message || "";
        const isStatusEvent = /logged in|logged out/i.test(action || "");
        const roleLabel = notif.role === "teach" ? "Educator" : (notif.role === "emp" ? "Employee" : "");
        const statusLabel = notif.eventType === "Login" ? "Logged In" : (notif.eventType === "Logout" ? "Logged Out" : action);
        const body = isStatusEvent
            ? `Name: ${name}\nRole: ${roleLabel}\nTime: ${notif.timestamp || ""}\nStatus: ${statusLabel}`
            : `${name} ${action}`;
        new Notification(isStatusEvent ? "AEZ Live status update" : "Resume approval needed", {
            body,
            icon: "https://cdn-icons-png.flaticon.com/512/1828/1828506.png",
            requireInteraction: !isStatusEvent
        });
    }
}

function bindDashboardTools() {
    const search = document.getElementById('dashboardSearch');
    const status = document.getElementById('statusFilter');
    const leaveView = document.getElementById('leaveViewFilter');
    [search, status, leaveView].forEach(el => {
        if (!el || el.dataset.bound === "1") return;
        el.dataset.bound = "1";
        el.addEventListener('input', renderDashboard);
        el.addEventListener('change', renderDashboard);
    });
}

function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) { }
}

// --- ACTIONS & UI ---
function updateMyStatusLocal(status, extras = {}) {
    let touched = false;
    dashboardData = dashboardData.map(user => {
        if (user.email === currentUser && user.role === currentRole) {
            touched = true;
            return { ...user, status, ...extras };
        }
        return user;
    });
    if (touched) renderDashboard();
}

function resyncSoon(delay = 250) {
    setTimeout(() => {
        if (isAdmin) pollBackend();
        else fetchDashboard();
    }, delay);
}

async function sendAction(action, extraParams = {}, options = {}) {
    try {
        setControlsDisabled(true);

        const payload = { action, role: currentRole, requestId: crypto.randomUUID(), ...extraParams };

        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });

        const json = await res.json();
        if (json.status === "success") {
            showToast(json.message, "success");
            if (options.localStatus) updateMyStatusLocal(options.localStatus);
            if (json.undoToken && !options.skipUndo) showUndoToast(json.message, json.undoToken);
        } else {
            showToast(json.message, "error");
        }
        // Always resync after any response - a rejected action almost always means the UI's
        // idea of "my current status" is already stale, and without this the next click just
        // fails again against the same wrong button set.
        if (options.fast === false) {
            if (isAdmin) await pollBackend();
            else await fetchDashboard();
        } else {
            resyncSoon();
        }

        setControlsDisabled(false);
        return json;
    } catch (err) {
        showToast("Failed to send action", "error");
        setControlsDisabled(false);
        return { status: "error", message: "Failed to send action" };
    }
}

function showUndoToast(message, undoToken) {
    currentUndoToken = undoToken;
    if (undoTimer) clearInterval(undoTimer);
    document.querySelectorAll('.undo-toast').forEach(toast => toast.remove());
    const stack = document.getElementById('toastStack');
    const el = document.createElement('div');
    let remaining = 10;
    el.className = "toast success undo-toast";
    el.innerHTML = `<span>${escapeHtml(message)}</span><button type="button">Undo <b>${remaining}</b></button>`;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    const btn = el.querySelector('button');
    const count = el.querySelector('b');
    btn.onclick = async () => {
        btn.disabled = true;
        clearInterval(undoTimer);
        await sendAction("Undo Action", { undoToken }, { fast: false, skipUndo: true });
        el.classList.remove('show');
        setTimeout(() => el.remove(), 200);
    };

    undoTimer = setInterval(() => {
        remaining -= 1;
        if (count) count.innerText = remaining;
        if (remaining <= 0) {
            clearInterval(undoTimer);
            if (currentUndoToken === undoToken) currentUndoToken = "";
            el.classList.remove('show');
            setTimeout(() => el.remove(), 200);
        }
    }, 1000);
}

function switchTab(tab) {
    currentRole = tab;
    const tabEmp = document.getElementById('tabEmp');
    const tabTeach = document.getElementById('tabTeach');

    if (tab === 'emp') {
        tabEmp.className = "flex-1 py-2 rounded-lg text-sm font-semibold bg-white text-[#0D9488] shadow-sm transition-all";
        tabTeach.className = "flex-1 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:text-slate-700 transition-all";
    } else {
        tabTeach.className = "flex-1 py-2 rounded-lg text-sm font-semibold bg-white text-[#0D9488] shadow-sm transition-all";
        tabEmp.className = "flex-1 py-2 rounded-lg text-sm font-semibold text-slate-500 hover:text-slate-700 transition-all";
    }
    renderDashboard();
}

function renderDashboard() {
    const list = document.getElementById('dashboardList');
    const analytics = document.getElementById('analyticsStrip');
    const searchTerm = (document.getElementById('dashboardSearch')?.value || "").trim().toLowerCase();
    const statusFilter = document.getElementById('statusFilter')?.value || "all";
    let html = '';
    let myCurrentStatus = 'Offline';
    let myClassSession = null;
    let amIInThisRole = false;
    const stats = { active: 0, break: 0, leave: 0, total: 0 };

    const roleUsers = dashboardData.filter(user => user.role === currentRole);
    roleUsers.forEach(user => {
        if (user.email === currentUser && user.role === currentRole) {
            myCurrentStatus = user.status;
            myClassSession = user.classSession || null;
            amIInThisRole = true;
            resumeRequestPending = user.status === "On Leave" ? !!user.pendingResume : false;
        }

        stats.total += 1;
        if (user.status === "Active") stats.active += 1;
        else if (user.status === "On Break") stats.break += 1;
        else if (user.status === "On Leave") stats.leave += 1;
    });

    roleUsers
        .filter(user => !searchTerm || `${user.name} ${user.email}`.toLowerCase().includes(searchTerm))
        .filter(user => statusFilter === "all" || user.status === statusFilter)
        .forEach(user => {
        let badgeColor = "bg-slate-100 text-slate-600";
        let statusClass = "offline";
        if (user.status === "Active") { badgeColor = "bg-emerald-100 text-emerald-700"; statusClass = "active"; }
        else if (user.status === "On Break") { badgeColor = "bg-amber-100 text-amber-700"; statusClass = "break"; }
        else if (user.status === "On Leave") { badgeColor = "bg-red-100 text-red-700"; statusClass = "leave"; }
        else if (user.status === "Weekoff") { badgeColor = "bg-sky-100 text-sky-700"; statusClass = "weekoff"; }

        html += `
            <div class="dashboard-row ${statusClass}">
                <span class="dashboard-name">${escapeHtml(user.name)}</span>
                <span class="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${badgeColor}">${user.status}</span>
            </div>`;
    });

    if (analytics) {
        analytics.innerHTML = `
            <div class="analytics-card active"><span>Active</span><strong>${stats.active}</strong></div>
            <div class="analytics-card break"><span>Break</span><strong>${stats.break}</strong></div>
            <div class="analytics-card leave"><span>Leave</span><strong>${stats.leave}</strong></div>
            <div class="analytics-card total"><span>Total ${currentRole === 'teach' ? 'Educators' : 'Employees'}</span><strong>${stats.total}</strong></div>
        `;
    }
    renderLeaveCalendar();
    list.innerHTML = html || `<p class="text-xs text-slate-400 text-center py-4">No data found</p>`;

    if (!amIInThisRole && dashboardData.length > 0) renderControls('UNAUTHORIZED');
    else renderControls(myCurrentStatus);
    syncClassTimer(myClassSession, myCurrentStatus);
}

function syncClassTimer(session, status) {
    if (currentRole !== 'teach' || !['Active', 'On Break'].includes(status) || !session || session.status !== "ongoing") {
        stopClassTimer();
        return;
    }
    if (activeClassSessionId === session.id && activeClassEndTime === session.endTime && classTimer) return;
    stopClassTimer();
    activeClassSessionId = session.id;
    activeClassEndTime = session.endTime;
    classWarningShown = false;
    classPromptShown = false;
    classTimer = setInterval(() => tickClassTimer(session), 1000);
    tickClassTimer(session);
}

function stopClassTimer() {
    if (classTimer) clearInterval(classTimer);
    classTimer = null;
    activeClassSessionId = "";
    activeClassEndTime = "";
    classWarningShown = false;
    classPromptShown = false;
}

function tickClassTimer(session) {
    const start = new Date(session.startTime).getTime();
    const end = new Date(session.endTime).getTime();
    if (!start || Number.isNaN(start)) return;
    const now = Date.now();
    const elapsedMins = Math.floor((now - start) / 60000);

    if (!classWarningShown && elapsedMins >= 55 && now < end) {
        classWarningShown = true;
        showToast("Class ending in 5 minutes.", "info", 7000);
    }

    if (!classPromptShown && now >= end) {
        classPromptShown = true;
        showClassEndPrompt(session);
    }
}

function showClassEndPrompt(session) {
    const canExtend = !session.extended;
    openModal(`
        <h3 class="font-bold text-base text-[#0b3d4f] mb-2">Class time completed</h3>
        <p class="text-sm text-slate-600 mb-5 leading-relaxed">This class has reached its scheduled time. You can extend it once by 30 minutes or end the class now.</p>
        <div class="grid gap-2">
            <button id="extendClassBtn" ${canExtend ? "" : "disabled"} class="w-full bg-[#0D9488] text-white hover:bg-[#0b7a70] py-3 rounded-lg text-sm font-semibold">${canExtend ? "Extend by 30 min" : "Extension already used"}</button>
            <button id="endClassBtn" class="w-full bg-red-50 text-red-600 hover:bg-red-100 py-3 rounded-lg text-sm font-semibold">End Class</button>
        </div>
    `);
    const extendBtn = document.getElementById('extendClassBtn');
    const endBtn = document.getElementById('endClassBtn');
    if (extendBtn && canExtend) extendBtn.onclick = () => extendCurrentClass(session.id);
    if (endBtn) endBtn.onclick = () => {
        closeModal();
        sendAction('Offline', {}, { fast: false });
    };
    setTimeout(() => {
        if (activeClassSessionId === session.id && document.getElementById('endClassBtn')) {
            closeModal();
            sendAction('Offline', {}, { fast: false });
        }
    }, 2 * 60000);
}

async function extendCurrentClass(sessionId) {
    const btn = document.getElementById('extendClassBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Extending...";
    }
    const result = await sendAction("Extend Class Session", { classSessionId: sessionId }, { fast: false, skipUndo: true });
    closeModal();
    classPromptShown = false;
    classWarningShown = true;
    if (result && result.status === "success") {
        showToast("Class extended by 30 minutes.", "success");
    }
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function parseLeaveDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function leaveBucket(user) {
    const now = new Date();
    const start = parseLeaveDate(user.leaveStart);
    const end = parseLeaveDate(user.leaveEnd || user.leaveResume);
    if (user.status === "On Leave") return "current";
    if (start && start > now) return "upcoming";
    if (end && end < now) return "completed";
    return "current";
}

function renderLeaveCalendar() {
    const calendar = document.getElementById('leaveCalendar');
    if (!calendar) return;
    const view = document.getElementById('leaveViewFilter')?.value || "today";
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 86400000 - 1);
    const endOfWeek = new Date(startOfToday.getTime() + 7 * 86400000 - 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const leaveUsers = dashboardData
        .filter(user => user.role === currentRole)
        .filter(user => user.leaveStart || user.status === "On Leave")
        .filter(user => {
            const start = parseLeaveDate(user.leaveStart) || startOfToday;
            const end = parseLeaveDate(user.leaveEnd || user.leaveResume) || endOfToday;
            if (view === "today") return start <= endOfToday && end >= startOfToday;
            if (view === "week") return start <= endOfWeek && end >= startOfToday;
            return start <= endOfMonth && end >= new Date(now.getFullYear(), now.getMonth(), 1);
        });

    if (!leaveUsers.length) {
        calendar.innerHTML = `
            <div class="leave-section-head">
                <span>${leaveViewLabel(view)}</span>
                <strong>0</strong>
            </div>
            <p class="leave-empty">No leave entries for this view</p>`;
        return;
    }

    calendar.innerHTML = `
        <div class="leave-section-head">
            <span>${leaveViewLabel(view)}</span>
            <strong>${leaveUsers.length}</strong>
        </div>
        ${leaveUsers.map(user => {
        const start = parseLeaveDate(user.leaveStart);
        const end = parseLeaveDate(user.leaveEnd || user.leaveResume);
        const bucket = leaveBucket(user);
        return `
            <div class="leave-item ${bucket}">
                <div>
                    <strong>${escapeHtml(user.name)}</strong>
                    <span>${user.role === 'teach' ? 'Educator' : 'Employee'} · ${escapeHtml(user.status)}</span>
                </div>
                <p>${start ? start.toLocaleDateString() : 'Today'} - ${end ? end.toLocaleDateString() : 'Open'} · ${escapeHtml(user.leaveReason || 'No reason added')}</p>
                ${user.proofUrl ? `<a class="proof-link" href="${escapeHtml(user.proofUrl)}" target="_blank" rel="noopener">View Proof</a>` : ''}
            </div>
        `;
    }).join('')}`;
}

function leaveViewLabel(view) {
    if (view === "week") return "Leave This Week";
    if (view === "month") return "Leave This Month";
    return "On Leave Today";
}

function legacyRenderControls(status) {
    const container = document.getElementById('controls');
    if (status === 'UNAUTHORIZED') {
        container.innerHTML = `<button disabled class="w-full bg-slate-100 text-slate-400 py-3 rounded-xl font-semibold text-sm border border-slate-200">ðŸš« Unauthorized for this tab</button>`;
        return;
    }

    const isTeach = currentRole === 'teach';
    const activeLabel = isTeach ? "ðŸ“š Start Class" : "ðŸš€ Login / Resume";
    const activeFn = isTeach ? "triggerTeacherStart()" : "sendAction('Active')";

    let html = '';
    if (status === "Offline") {
        html = `<button onclick="${activeFn}" class="w-full bg-[#0D9488] hover:bg-[#0b7a70] text-white py-3 rounded-lg font-semibold text-sm">${activeLabel}</button>`;
    } else if (status === "On Break" || status === "On Leave") {
        html = `<button onclick="${activeFn}" class="w-full bg-[#0D9488] hover:bg-[#0b7a70] text-white py-3 rounded-lg font-semibold text-sm">ðŸš€ Resume Work</button>`;
    } else {
        // Employees get the confirm-dialog logout (Final vs Break); teachers get a plain
        // "Class Over" since there's no ambiguity about returning later in the same session.
        var logoutFn = isTeach ? "sendAction('Offline')" : "triggerEmpLogout()";
        var logoutLabel = isTeach ? "ðŸšª Class Over / Logout" : "ðŸšª Logout";
        html = `
        <button onclick="sendAction('On Break')" class="w-full bg-slate-100 text-[#0b3d4f] hover:bg-slate-200 py-3 rounded-lg font-semibold text-sm">â˜• Take a Break</button>
        <button onclick="${logoutFn}" class="w-full bg-red-50 text-red-600 hover:bg-red-100 py-3 rounded-lg font-semibold text-sm">${logoutLabel}</button>
        `;
    }

    html += `<button onclick="triggerLeave()" class="w-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 py-2.5 rounded-lg font-medium text-sm">ðŸ“¢ Mark Leave</button>`;
    container.innerHTML = html;
}

// Employee Logout Breaker
function triggerEmpLogout() {
    showConfirmModal({
        title: "Time to leave for the day?",
        message: "Choose <strong>Final Logout</strong> if you're done for today, or <strong>Still Working</strong> if you'll be back â€” this puts you on a break instead so your work time stops counting.",
        okLabel: "Final Logout",
        cancelLabel: "Still Working",
        onOk: () => sendAction('Offline'),
        onCancel: () => sendAction('On Break')
    });
}

function triggerTeacherStart() {
    showFormModal({
        title: "Start Class",
        fields: [
            { id: "subject", label: "Subject", placeholder: "e.g. Mathematics", required: true },
            { id: "student", label: "Student Name", placeholder: "e.g. Rohan", required: true }
        ],
        submitLabel: "Start Class",
        onSubmit: (values) => sendAction("Active", { subject: values.subject, student: values.student })
    });
}

function legacyTriggerLeave() {
    showFormModal({
        title: "Mark Leave",
        fields: [
            { id: "reason", label: "Reason", placeholder: "e.g. Not feeling well", required: true },
            { id: "days", label: "Number of Days", type: "number", value: "1", required: true }
        ],
        submitLabel: "Mark Leave",
        onSubmit: (values) => sendAction("On Leave", { reason: values.reason, days: values.days || 1 })
    });
}

// Final control renderer. Kept below the older functions so this clean version wins.
function renderControls(status) {
    const container = document.getElementById('controls');
    if (status === 'UNAUTHORIZED') {
        container.innerHTML = (isAdmin ? renderAdminApprovals() : '') + `<button disabled class="w-full bg-slate-100 text-slate-400 py-3 rounded-xl font-semibold text-sm border border-slate-200">Unauthorized for this tab</button>`;
        return;
    }

    const isTeach = currentRole === 'teach';
    const activeLabel = isTeach ? "Start Class" : "Login / Resume";
    const activeFn = isTeach ? "triggerTeacherStart()" : "sendAction('Active')";

    let html = isAdmin ? renderAdminApprovals() : '';
    if (status === "Offline") {
        html += `<button onclick="${activeFn}" class="w-full bg-[#0D9488] hover:bg-[#0b7a70] text-white py-3 rounded-lg font-semibold text-sm">${activeLabel}</button>`;
        if (!isTeach) html += `<button onclick="triggerWeekoff()" class="w-full bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 py-2.5 rounded-lg font-medium text-sm">Weekoff</button>`;
    } else if (status === "On Leave") {
        if (resumeRequestPending) {
            html += `<button disabled class="w-full bg-slate-100 text-slate-400 py-3 rounded-lg font-semibold text-sm border border-slate-200">Resume Request Sent</button>`;
        } else {
            html += `<button onclick="requestResume()" class="w-full bg-[#0D9488] hover:bg-[#0b7a70] text-white py-3 rounded-lg font-semibold text-sm">Request Resume</button>`;
        }
    } else if (status === "On Break") {
        const resumeFn = isTeach ? "sendAction('Active')" : activeFn;
        html += `<button onclick="${resumeFn}" class="w-full bg-[#0D9488] hover:bg-[#0b7a70] text-white py-3 rounded-lg font-semibold text-sm">Resume Work</button>`;
    } else {
        const logoutFn = isTeach ? "sendAction('Offline')" : "triggerEmpLogout()";
        const logoutLabel = isTeach ? "Class Over / Logout" : "Logout";
        html += `
        <button onclick="sendAction('On Break')" class="w-full bg-slate-100 text-[#0b3d4f] hover:bg-slate-200 py-3 rounded-lg font-semibold text-sm">Take a Break</button>
        <button onclick="${logoutFn}" class="w-full bg-red-50 text-red-600 hover:bg-red-100 py-3 rounded-lg font-semibold text-sm">${logoutLabel}</button>
        `;
        if (!isTeach) html += `<button onclick="triggerWeekoff()" class="w-full bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 py-2.5 rounded-lg font-medium text-sm">Weekoff</button>`;
    }

    html += `<button onclick="triggerLeave()" class="w-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 py-2.5 rounded-lg font-medium text-sm">Mark Leave</button>`;
    container.innerHTML = html;
}

function renderAdminApprovals() {
    if (!adminRequests.length) return '';
    return `
    <div class="admin-approvals mb-2 p-3 rounded-lg border border-amber-200 bg-amber-50">
        <p class="text-[11px] font-bold uppercase tracking-wide text-amber-700 mb-2">Resume approvals</p>
        ${adminRequests.map(req => `
            <div class="approval-item bg-white rounded-lg border border-amber-100 p-2 mb-2 last:mb-0">
                <p class="text-sm font-semibold text-[#0b3d4f]">${escapeHtml(req.name)}</p>
                <p class="text-xs text-slate-500">${req.role === 'teach' ? 'Educator' : 'Employee'} asked to return early from leave.</p>
                <div class="grid grid-cols-2 gap-2 mt-2">
                    <button onclick="sendAdminDecision('${req.id}', 'approve')" class="bg-emerald-600 text-white hover:bg-emerald-700 py-2 rounded-lg text-sm font-semibold">Allow</button>
                    <button onclick="sendAdminDecision('${req.id}', 'deny')" class="bg-red-50 text-red-600 hover:bg-red-100 py-2 rounded-lg text-sm font-semibold">Deny</button>
                </div>
            </div>
        `).join('')}
    </div>`;
}

async function sendAdminDecision(requestId, decision) {
    adminRequests = adminRequests.filter(req => req.id !== requestId);
    renderDashboard();
    const result = await sendAction("Admin Resume Decision", { requestId, decision }, { fast: true });
    if (result && Array.isArray(result.approvals)) {
        adminRequests = result.approvals;
        renderDashboard();
    }
    if (isAdmin) {
        setTimeout(pollBackend, 600);
    }
}

async function requestResume() {
    resumeRequestPending = true;
    updateMyStatusLocal("On Leave", { pendingResume: true });
    const result = await sendAction("Active", {}, { fast: true });
    if (!result || result.status !== "success") {
        resumeRequestPending = false;
        updateMyStatusLocal("On Leave", { pendingResume: false });
    }
}

function triggerLeave() {
    openModal(`
        <h3 class="font-bold text-base text-[#0b3d4f] mb-3">Before marking leave</h3>
        <div class="space-y-3 text-sm text-slate-600 leading-relaxed mb-6">
            <p><strong>1.</strong> Mark leave on the day your leave actually starts, and select the date you will resume work.</p>
            <p><strong>2.</strong> Do not add today's attendance as a remark. Once submitted, your status will become On Leave.</p>
            <p><strong>3.</strong> You cannot resume early unless admin approves your resume request.</p>
        </div>
        <div class="flex justify-end">
            <button id="leaveUnderstandBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-[#0D9488] text-white hover:bg-[#0b7a70]">I Understand</button>
        </div>
    `);
    document.getElementById('leaveUnderstandBtn').onclick = () => {
        closeModal();
        openLeaveForm();
    };
}

function openLeaveForm() {
    const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    openModal(`
        <h3 class="font-bold text-base text-[#0b3d4f] mb-4">Mark Leave</h3>
        <div class="modal-field mb-4">
            <label for="leaveReason">Reason</label>
            <input id="leaveReason" type="text" placeholder="e.g. Not feeling well" />
        </div>
        <div class="modal-field mb-4">
            <label for="leaveStartDate">Leave starts on</label>
            <input id="leaveStartDate" type="date" value="${today}" />
        </div>
        <div class="modal-field mb-4">
            <label for="leaveResumeDate">Resume work on</label>
            <input id="leaveResumeDate" type="date" />
        </div>
        <div class="modal-field mb-2">
            <label for="leaveProofFile">Proof document <span class="text-slate-400 font-medium">(optional)</span></label>
            <input id="leaveProofFile" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" />
            <p class="file-help">PDF, JPG, JPEG, or PNG. Max 5 MB.</p>
            <p id="leaveProofError" class="file-error hidden"></p>
        </div>
        <div class="flex gap-2 justify-end mt-5">
            <button id="modalCancelBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-100 text-[#0b3d4f] hover:bg-slate-200">Cancel</button>
            <button id="leaveSubmitBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-[#0D9488] text-white hover:bg-[#0b7a70]">Mark Leave</button>
        </div>
    `);

    document.getElementById('modalCancelBtn').onclick = closeModal;
    document.getElementById('leaveProofFile').onchange = validateLeaveProofFile;
    document.getElementById('leaveSubmitBtn').onclick = submitLeaveForm;
}

function validateLeaveProofFile() {
    const fileInput = document.getElementById('leaveProofFile');
    const error = document.getElementById('leaveProofError');
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    if (!error) return true;
    error.classList.add('hidden');
    error.innerText = '';
    if (!file) return true;

    const allowed = ["application/pdf", "image/jpeg", "image/png"];
    if (!allowed.includes(file.type)) {
        error.innerText = "Only PDF, JPG, JPEG, and PNG files are allowed.";
        error.classList.remove('hidden');
        fileInput.value = "";
        return false;
    }
    if (file.size > 5 * 1024 * 1024) {
        error.innerText = "Proof document must be 5 MB or smaller.";
        error.classList.remove('hidden');
        fileInput.value = "";
        return false;
    }
    return true;
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error("Could not read proof document."));
        reader.readAsDataURL(file);
    });
}

async function uploadLeaveProofFile(file) {
    const base64Data = await readFileAsBase64(file);
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
            action: "Upload Leave Proof",
            email: currentUser,
            role: currentRole,
            base64Data,
            fileName: file.name,
            mimeType: file.type
        })
    });
    const json = await res.json();
    if (json.status !== "success") throw new Error(json.message || "Proof upload failed.");
    return json.url || "";
}

async function submitLeaveForm() {
    const reason = document.getElementById('leaveReason').value.trim();
    const startDate = document.getElementById('leaveStartDate').value;
    const resumeDate = document.getElementById('leaveResumeDate').value;
    const fileInput = document.getElementById('leaveProofFile');
    const error = document.getElementById('leaveProofError');
    const submitBtn = document.getElementById('leaveSubmitBtn');

    if (!reason || !startDate || !resumeDate) {
        showToast("Reason, start date, and resume date are required.", "error");
        return;
    }
    if (!validateLeaveProofFile()) return;

    try {
        submitBtn.disabled = true;
        submitBtn.innerText = fileInput.files[0] ? "Uploading..." : "Sending...";
        let proofUrl = "";
        if (fileInput.files[0]) proofUrl = await uploadLeaveProofFile(fileInput.files[0]);

        submitBtn.innerText = "Sending...";
        closeModal();
        const result = await sendAction("On Leave", {
            reason,
            startDate,
            resumeDate,
            proofUrl
        }, { localStatus: "On Leave", fast: true });
        if (result && result.status === "success") resumeRequestPending = false;
    } catch (err) {
        if (error) {
            error.innerText = err.message || "Proof upload failed. Leave was not submitted.";
            error.classList.remove('hidden');
        }
        showToast(err.message || "Proof upload failed. Leave was not submitted.", "error", 5000);
        submitBtn.disabled = false;
        submitBtn.innerText = "Mark Leave";
    }
}

function triggerWeekoff() {
    const todayLabel = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowLabel = tomorrow.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

    openModal(`
        <h3 class="font-bold text-base text-[#0b3d4f] mb-2">Mark Weekoff</h3>
        <p class="text-sm text-slate-600 mb-4">Choose the company weekoff day you are marking.</p>
        <div class="space-y-2 mb-5">
            <label class="choice-row"><input type="radio" name="weekoffDay" value="today" checked><span>Today - ${todayLabel}</span></label>
            <label class="choice-row"><input type="radio" name="weekoffDay" value="tomorrow"><span>Tomorrow - ${tomorrowLabel}</span></label>
        </div>
        <div class="flex gap-2 justify-end">
            <button id="modalCancelBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-100 text-[#0b3d4f] hover:bg-slate-200">Cancel</button>
            <button id="weekoffSubmitBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-[#0D9488] text-white hover:bg-[#0b7a70]">Okay</button>
        </div>
    `);
    document.getElementById('modalCancelBtn').onclick = closeModal;
    document.getElementById('weekoffSubmitBtn').onclick = () => {
        const day = document.querySelector('input[name="weekoffDay"]:checked').value;
        closeModal();
        sendAction("Weekoff", { day }, { localStatus: "Weekoff", fast: true });
    };
}

function setControlsDisabled(disabled) {
    document.querySelectorAll('#controls button').forEach(b => b.disabled = disabled);
}
