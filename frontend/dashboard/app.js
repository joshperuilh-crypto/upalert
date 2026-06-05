/**
 * UpAlert Dashboard — app.js
 * Vanilla JS, no framework. Communicates with the API worker.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

// When running locally via wrangler dev, the API is at localhost:8787
// In production, set this to your deployed API worker URL
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  : 'https://upalert.workers.dev'; // Replace with your actual worker URL

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser = null;
let monitors = [];
let refreshInterval = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Check for plan in URL hash (from pricing page)
  const hash = window.location.hash;
  if (hash.includes('signup')) {
    switchTab('signup');
  }

  const token = getToken();
  if (token) {
    bootstrapApp();
  }
});

async function bootstrapApp() {
  try {
    const data = await apiGet('/api/auth/me');
    currentUser = data.user;
    showApp();
    await loadMonitors();
    // Auto-refresh every 30s
    refreshInterval = setInterval(loadMonitors, 30000);
  } catch (err) {
    // Token invalid or expired
    clearToken();
    showAuth();
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.getElementById('login-form').style.display  = tab === 'login'  ? '' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? '' : 'none';
  document.querySelectorAll('.auth-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0) === (tab === 'login'));
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Logging in…';

  try {
    const data = await apiPost('/api/auth/login', {
      email:    document.getElementById('login-email').value,
      password: document.getElementById('login-password').value,
    });
    setToken(data.token);
    currentUser = data.user;
    showApp();
    await loadMonitors();
    refreshInterval = setInterval(loadMonitors, 30000);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Login';
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const btn = document.getElementById('signup-btn');
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    const data = await apiPost('/api/auth/register', {
      email:    document.getElementById('signup-email').value,
      password: document.getElementById('signup-password').value,
    });
    setToken(data.token);
    currentUser = data.user;
    showApp();
    await loadMonitors();
    refreshInterval = setInterval(loadMonitors, 30000);
    toast('Account created! Welcome to UpAlert.', 'success');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create free account';
  }
}

async function handleLogout() {
  try { await apiPost('/api/auth/logout', {}); } catch (_) {}
  clearToken();
  clearInterval(refreshInterval);
  currentUser = null;
  monitors = [];
  showAuth();
}

// ─── App UI ───────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('sidebar-email').textContent = currentUser.email;
  document.getElementById('sidebar-plan').textContent = currentUser.plan;
}

function showAuth() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navEl = document.getElementById(`nav-${name}`);
  if (navEl) navEl.classList.add('active');

  if (name === 'settings') loadSettings();
}

// ─── Monitors ─────────────────────────────────────────────────────────────────

async function loadMonitors() {
  try {
    const data = await apiGet('/api/monitors');
    monitors = data.monitors || [];
    renderMonitors();
    renderStats();
  } catch (err) {
    document.getElementById('monitors-list-container').innerHTML =
      `<p style="color:var(--red);text-align:center;">${err.message}</p>`;
  }
}

function renderStats() {
  const total  = monitors.length;
  const upCount   = monitors.filter(m => m.last_status === 'up').length;
  const downCount = monitors.filter(m => m.last_status === 'down').length;
  const uptimes   = monitors.filter(m => m.uptime_24h !== null).map(m => m.uptime_24h);
  const avgUptime = uptimes.length
    ? (uptimes.reduce((a, b) => a + b, 0) / uptimes.length).toFixed(2) + '%'
    : '—';

  document.getElementById('stat-total').textContent    = total;
  document.getElementById('stat-up').textContent       = upCount;
  document.getElementById('stat-down').textContent     = downCount;
  document.getElementById('stat-avg-uptime').textContent = avgUptime;

  const subtitle = total === 0
    ? 'No monitors yet — add your first URL below'
    : `${upCount} up, ${downCount} down`;
  document.getElementById('monitors-subtitle').textContent = subtitle;
}

function renderMonitors() {
  const container = document.getElementById('monitors-list-container');

  if (monitors.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🖥️</div>
        <h3>No monitors yet</h3>
        <p>Add your first URL to start monitoring.</p>
        <button class="btn btn-primary" onclick="openAddMonitor()" style="margin-top:1rem;width:auto;">+ Add your first monitor</button>
      </div>`;
    return;
  }

  const html = monitors.map(m => {
    const statusClass = m.last_status === 'up' ? 'status-up'
                      : m.last_status === 'down' ? 'status-down' : 'status-unknown';
    const uptime = m.uptime_24h !== null ? `${m.uptime_24h}%` : 'No data';
    const responseTime = m.last_response_time ? `${m.last_response_time}ms` : '—';
    const uptimeColor = m.uptime_24h === null ? ''
                      : m.uptime_24h >= 99 ? 'color:var(--green)'
                      : m.uptime_24h >= 95 ? 'color:var(--yellow)'
                      : 'color:var(--red)';

    return `
      <div class="monitor-card">
        <div class="status-indicator ${statusClass}"></div>
        <div class="monitor-main">
          <div class="monitor-name">${escHtml(m.name)}</div>
          <div class="monitor-url">${escHtml(m.url)}</div>
        </div>
        <div class="monitor-meta">
          <div class="uptime-pct" style="${uptimeColor}">${uptime}</div>
          <div class="response-time">${responseTime}</div>
        </div>
        <div class="monitor-actions">
          <button class="btn btn-ghost btn-sm" onclick="openMonitorDetail(${m.id})" title="View details">📊</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteMonitor(${m.id})" title="Delete">🗑</button>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="monitors-list">${html}</div>`;
}

// ─── Monitor Detail ───────────────────────────────────────────────────────────

async function openMonitorDetail(monitorId) {
  showPage('monitor-detail');
  document.getElementById('detail-name').textContent = 'Loading…';

  try {
    const [monitorData, checksData] = await Promise.all([
      apiGet(`/api/monitors/${monitorId}`),
      apiGet(`/api/monitors/${monitorId}/checks?period=24h`),
    ]);

    const m = monitorData.monitor;
    document.getElementById('detail-name').textContent = m.name;
    document.getElementById('detail-url').textContent = m.url;

    const statusText = m.last_status === 'up' ? 'Operational'
                     : m.last_status === 'down' ? 'Down' : 'No data';
    const statusColor = m.last_status === 'up' ? 'var(--green)'
                      : m.last_status === 'down' ? 'var(--red)' : 'var(--gray-400)';
    document.getElementById('detail-status').textContent = statusText;
    document.getElementById('detail-status').style.color = statusColor;

    document.getElementById('detail-uptime-24h').textContent = m.uptime_24h != null ? `${m.uptime_24h}%` : '—';
    document.getElementById('detail-uptime-7d').textContent  = m.uptime_7d  != null ? `${m.uptime_7d}%`  : '—';
    document.getElementById('detail-response').textContent   = m.last_response_time ? `${m.last_response_time}ms` : '—';

    // Uptime bars (last 90 checks)
    const checks = checksData.checks || [];
    renderUptimeBars(checks.slice(0, 90).reverse());

    // Checks table
    renderChecksTable(checks.slice(0, 50));

  } catch (err) {
    document.getElementById('detail-name').textContent = 'Error loading monitor';
    toast(err.message, 'error');
  }
}

function renderUptimeBars(checks) {
  const container = document.getElementById('detail-bars');
  if (checks.length === 0) {
    container.innerHTML = '<p style="color:var(--gray-500);font-size:.85rem;">No checks yet — waiting for first ping.</p>';
    return;
  }

  // Fill to 90 bars (oldest first, newest right)
  const bars = Array(90).fill('empty');
  const offset = 90 - checks.length;
  checks.forEach((c, i) => {
    bars[offset + i] = c.status;
  });

  container.innerHTML = bars.map(s =>
    `<div class="uptime-bar bar-${s}" title="${s === 'empty' ? 'No data' : s}"></div>`
  ).join('');
}

function renderChecksTable(checks) {
  if (checks.length === 0) {
    document.getElementById('detail-checks-table').innerHTML =
      '<p style="color:var(--gray-500);font-size:.85rem;">No check history yet.</p>';
    return;
  }

  const rows = checks.map(c => {
    const time = new Date(c.checked_at * 1000).toLocaleString();
    const badge = c.status === 'up'
      ? `<span class="badge-up">UP</span>`
      : `<span class="badge-down">DOWN</span>`;
    const rt = c.response_time ? `${c.response_time}ms` : '—';
    const code = c.status_code || '—';
    const err = c.error_message ? `<span style="color:var(--red);font-size:.8rem;">${escHtml(c.error_message)}</span>` : '';
    return `<tr>
      <td>${badge}</td>
      <td>${time}</td>
      <td>${rt}</td>
      <td>${code}</td>
      <td>${err}</td>
    </tr>`;
  }).join('');

  document.getElementById('detail-checks-table').innerHTML = `
    <table class="checks-table">
      <thead><tr><th>Status</th><th>Time</th><th>Response</th><th>HTTP Code</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── Add Monitor ──────────────────────────────────────────────────────────────

function openAddMonitor() {
  document.getElementById('add-monitor-modal').style.display = 'flex';
  document.getElementById('new-monitor-name').focus();
}

function closeAddMonitor() {
  document.getElementById('add-monitor-modal').style.display = 'none';
  document.getElementById('add-monitor-error').textContent = '';
}

async function handleAddMonitor(e) {
  e.preventDefault();
  const btn = document.getElementById('add-monitor-btn');
  const errEl = document.getElementById('add-monitor-error');
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    await apiPost('/api/monitors', {
      name:           document.getElementById('new-monitor-name').value,
      url:            document.getElementById('new-monitor-url').value,
      check_interval: parseInt(document.getElementById('new-monitor-interval').value),
      alert_email:    document.getElementById('new-monitor-email').checked,
    });
    closeAddMonitor();
    toast('Monitor added!', 'success');
    await loadMonitors();

    // Reset form
    document.getElementById('new-monitor-name').value = '';
    document.getElementById('new-monitor-url').value = '';
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Monitor';
  }
}

async function deleteMonitor(monitorId) {
  const m = monitors.find(x => x.id === monitorId);
  if (!m) return;
  if (!confirm(`Delete "${m.name}"? This will remove all history.`)) return;

  try {
    await apiDelete(`/api/monitors/${monitorId}`);
    toast('Monitor deleted', 'success');
    await loadMonitors();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  if (!currentUser) return;
  const planDescMap = {
    free:     '3 monitors, 5-minute checks',
    pro:      '20 monitors, 1-minute checks, public status page',
    business: 'Unlimited monitors, 1-minute checks, Slack alerts',
  };
  document.getElementById('settings-plan').textContent = currentUser.plan;
  document.getElementById('settings-plan-desc').textContent = planDescMap[currentUser.plan] || '';
}

async function saveSettings() {
  const body = {
    resend_api_key:   document.getElementById('settings-resend-key').value || null,
    slack_webhook_url: document.getElementById('settings-slack-url').value || null,
  };
  // Remove null keys
  Object.keys(body).forEach(k => { if (!body[k]) delete body[k]; });

  try {
    await apiPut('/api/settings', body);
    toast('Settings saved!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body)  opts.body = JSON.stringify(body);

  const res = await fetch(API_URL + path, opts);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

const apiGet    = (path)        => apiFetch('GET',    path);
const apiPost   = (path, body)  => apiFetch('POST',   path, body);
const apiPut    = (path, body)  => apiFetch('PUT',    path, body);
const apiDelete = (path)        => apiFetch('DELETE', path);

// ─── Token Storage ────────────────────────────────────────────────────────────

function getToken()          { return localStorage.getItem('ua_token'); }
function setToken(t)         { localStorage.setItem('ua_token', t); }
function clearToken()        { localStorage.removeItem('ua_token'); }

// ─── Toast Notifications ──────────────────────────────────────────────────────

function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  const modal = document.getElementById('add-monitor-modal');
  if (e.target === modal) closeAddMonitor();
});
