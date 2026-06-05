/**
 * UpAlert API Worker
 * REST API for the dashboard: auth, monitors CRUD, status, public pages.
 *
 * Routes:
 *   POST   /api/auth/register
 *   POST   /api/auth/login
 *   POST   /api/auth/logout
 *   GET    /api/auth/me
 *
 *   GET    /api/monitors
 *   POST   /api/monitors
 *   GET    /api/monitors/:id
 *   PUT    /api/monitors/:id
 *   DELETE /api/monitors/:id
 *   GET    /api/monitors/:id/checks      (last 24h / 7d)
 *   GET    /api/monitors/:id/uptime      (uptime % for 24h/7d/30d)
 *
 *   GET    /api/status/:userId           (public status page data)
 *
 *   PUT    /api/settings                 (update plan, API keys)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const PLAN_LIMITS = {
  free:     { maxMonitors: 3,         minInterval: 5 },
  pro:      { maxMonitors: 20,        minInterval: 1 },
  business: { maxMonitors: Infinity,  minInterval: 1 },
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      return await router(request, env, ctx);
    } catch (err) {
      console.error('Unhandled error:', err);
      return jsonError('Internal server error', 500);
    }
  }
};

// ─── Router ──────────────────────────────────────────────────────────────────

async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Auth routes
  if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
  if (path === '/api/auth/login'    && method === 'POST') return handleLogin(request, env);
  if (path === '/api/auth/logout'   && method === 'POST') return handleLogout(request, env);
  if (path === '/api/auth/me'       && method === 'GET')  return handleMe(request, env);

  // Settings
  if (path === '/api/settings' && method === 'PUT') return handleUpdateSettings(request, env);

  // Monitor routes
  if (path === '/api/monitors' && method === 'GET')  return handleListMonitors(request, env);
  if (path === '/api/monitors' && method === 'POST') return handleCreateMonitor(request, env);

  const monitorMatch = path.match(/^\/api\/monitors\/(\d+)(\/.*)?$/);
  if (monitorMatch) {
    const monitorId = parseInt(monitorMatch[1]);
    const sub = monitorMatch[2] || '';
    if (sub === '' && method === 'GET')    return handleGetMonitor(request, env, monitorId);
    if (sub === '' && method === 'PUT')    return handleUpdateMonitor(request, env, monitorId);
    if (sub === '' && method === 'DELETE') return handleDeleteMonitor(request, env, monitorId);
    if (sub === '/checks' && method === 'GET') return handleGetChecks(request, env, monitorId);
    if (sub === '/uptime' && method === 'GET') return handleGetUptime(request, env, monitorId);
  }

  // Public status page
  const statusMatch = path.match(/^\/api\/status\/(\d+)$/);
  if (statusMatch && method === 'GET') {
    return handlePublicStatus(request, env, parseInt(statusMatch[1]));
  }

  return jsonError('Not found', 404);
}

// ─── Auth Handlers ────────────────────────────────────────────────────────────

async function handleRegister(request, env) {
  const body = await parseBody(request);
  if (!body) return jsonError('Invalid JSON', 400);

  const { email, password } = body;
  if (!email || !password) return jsonError('Email and password required', 400);
  if (!isValidEmail(email)) return jsonError('Invalid email address', 400);
  if (password.length < 8) return jsonError('Password must be at least 8 characters', 400);

  // Check if email already exists
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first();

  if (existing) return jsonError('Email already registered', 409);

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const result = await env.DB.prepare(`
    INSERT INTO users (email, password_hash, plan)
    VALUES (?, ?, 'free')
  `).bind(email.toLowerCase(), passwordHash).run();

  const userId = result.meta.last_row_id;

  // Create session
  const token = await generateToken();
  const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days

  await env.DB.prepare(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).bind(userId, token, expiresAt).run();

  return jsonOk({
    token,
    user: { id: userId, email: email.toLowerCase(), plan: 'free' }
  }, 201);
}

async function handleLogin(request, env) {
  const body = await parseBody(request);
  if (!body) return jsonError('Invalid JSON', 400);

  const { email, password } = body;
  if (!email || !password) return jsonError('Email and password required', 400);

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, plan FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first();

  if (!user) return jsonError('Invalid email or password', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return jsonError('Invalid email or password', 401);

  // Create session
  const token = await generateToken();
  const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

  await env.DB.prepare(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).bind(user.id, token, expiresAt).run();

  return jsonOk({
    token,
    user: { id: user.id, email: user.email, plan: user.plan }
  });
}

async function handleLogout(request, env) {
  const session = await getSession(request, env);
  if (!session) return jsonOk({ ok: true });

  const token = getBearerToken(request);
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();

  return jsonOk({ ok: true });
}

async function handleMe(request, env) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const user = await env.DB.prepare(
    'SELECT id, email, plan, created_at FROM users WHERE id = ?'
  ).bind(session.userId).first();

  if (!user) return jsonError('User not found', 404);

  // Get monitor count
  const { results: monitors } = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM monitors WHERE user_id = ? AND is_active = 1'
  ).bind(session.userId).all();

  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

  return jsonOk({
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan,
      created_at: user.created_at,
    },
    usage: {
      monitors: monitors[0].count,
      max_monitors: limits.maxMonitors === Infinity ? null : limits.maxMonitors,
      min_interval: limits.minInterval,
    }
  });
}

// ─── Settings Handler ─────────────────────────────────────────────────────────

async function handleUpdateSettings(request, env) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const body = await parseBody(request);
  if (!body) return jsonError('Invalid JSON', 400);

  const allowed = ['resend_api_key', 'slack_webhook_url'];
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) return jsonError('No valid fields to update', 400);

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), Math.floor(Date.now() / 1000), session.userId];

  await env.DB.prepare(
    `UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`
  ).bind(...values).run();

  return jsonOk({ ok: true });
}

// ─── Monitor Handlers ─────────────────────────────────────────────────────────

async function handleListMonitors(request, env) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const { results: monitors } = await env.DB.prepare(`
    SELECT id, name, url, check_interval, is_active, alert_email, alert_slack,
           last_status, last_checked_at, last_response_time, created_at
    FROM monitors
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(session.userId).all();

  // Enrich each monitor with 24h uptime
  const enriched = await Promise.all((monitors || []).map(async (m) => {
    const uptime24h = await computeUptime(m.id, 24 * 3600, env);
    return { ...m, uptime_24h: uptime24h };
  }));

  return jsonOk({ monitors: enriched });
}

async function handleCreateMonitor(request, env) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const body = await parseBody(request);
  if (!body) return jsonError('Invalid JSON', 400);

  const { name, url, check_interval, alert_email, alert_slack } = body;
  if (!name || !url) return jsonError('Name and URL required', 400);
  if (!isValidUrl(url)) return jsonError('Invalid URL (must start with http:// or https://)', 400);

  // Fetch user plan and current monitor count
  const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(session.userId).first();
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

  const { results: countResult } = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM monitors WHERE user_id = ?'
  ).bind(session.userId).all();

  const currentCount = countResult[0].count;
  if (currentCount >= limits.maxMonitors) {
    return jsonError(`Plan limit reached: ${limits.maxMonitors} monitors max. Upgrade to add more.`, 403);
  }

  // Validate / clamp check_interval
  let interval = parseInt(check_interval) || limits.minInterval;
  if (interval < limits.minInterval) interval = limits.minInterval;
  if (![1, 5, 10, 15, 30, 60].includes(interval)) interval = limits.minInterval;

  const result = await env.DB.prepare(`
    INSERT INTO monitors (user_id, name, url, check_interval, alert_email, alert_slack)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    session.userId,
    name.trim(),
    url.trim(),
    interval,
    alert_email !== false ? 1 : 0,
    alert_slack ? 1 : 0
  ).run();

  const monitorId = result.meta.last_row_id;
  const monitor = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(monitorId).first();

  return jsonOk({ monitor }, 201);
}

async function handleGetMonitor(request, env, monitorId) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const monitor = await env.DB.prepare(
    'SELECT * FROM monitors WHERE id = ? AND user_id = ?'
  ).bind(monitorId, session.userId).first();

  if (!monitor) return jsonError('Monitor not found', 404);

  const uptime7d = await computeUptime(monitorId, 7 * 24 * 3600, env);
  const uptime30d = await computeUptime(monitorId, 30 * 24 * 3600, env);

  return jsonOk({ monitor: { ...monitor, uptime_7d: uptime7d, uptime_30d: uptime30d } });
}

async function handleUpdateMonitor(request, env, monitorId) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const monitor = await env.DB.prepare(
    'SELECT * FROM monitors WHERE id = ? AND user_id = ?'
  ).bind(monitorId, session.userId).first();

  if (!monitor) return jsonError('Monitor not found', 404);

  const body = await parseBody(request);
  if (!body) return jsonError('Invalid JSON', 400);

  const user = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(session.userId).first();
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

  const allowed = ['name', 'url', 'check_interval', 'is_active', 'alert_email', 'alert_slack'];
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }

  if (updates.url && !isValidUrl(updates.url)) return jsonError('Invalid URL', 400);
  if (updates.check_interval) {
    let interval = parseInt(updates.check_interval);
    if (interval < limits.minInterval) interval = limits.minInterval;
    updates.check_interval = interval;
  }

  if (Object.keys(updates).length === 0) return jsonError('No valid fields to update', 400);

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), Math.floor(Date.now() / 1000), monitorId, session.userId];

  await env.DB.prepare(
    `UPDATE monitors SET ${sets}, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(...values).run();

  const updated = await env.DB.prepare('SELECT * FROM monitors WHERE id = ?').bind(monitorId).first();
  return jsonOk({ monitor: updated });
}

async function handleDeleteMonitor(request, env, monitorId) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const monitor = await env.DB.prepare(
    'SELECT id FROM monitors WHERE id = ? AND user_id = ?'
  ).bind(monitorId, session.userId).first();

  if (!monitor) return jsonError('Monitor not found', 404);

  await env.DB.prepare('DELETE FROM monitors WHERE id = ?').bind(monitorId).run();

  return jsonOk({ ok: true });
}

async function handleGetChecks(request, env, monitorId) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const monitor = await env.DB.prepare(
    'SELECT id FROM monitors WHERE id = ? AND user_id = ?'
  ).bind(monitorId, session.userId).first();

  if (!monitor) return jsonError('Monitor not found', 404);

  const url = new URL(request.url);
  const period = url.searchParams.get('period') || '24h';
  const periodMap = { '24h': 24 * 3600, '7d': 7 * 24 * 3600, '30d': 30 * 24 * 3600 };
  const seconds = periodMap[period] || periodMap['24h'];
  const since = Math.floor(Date.now() / 1000) - seconds;

  const { results: checks } = await env.DB.prepare(`
    SELECT id, status, response_time, status_code, error_message, checked_at
    FROM checks
    WHERE monitor_id = ? AND checked_at > ?
    ORDER BY checked_at DESC
    LIMIT 500
  `).bind(monitorId, since).all();

  return jsonOk({ checks: checks || [] });
}

async function handleGetUptime(request, env, monitorId) {
  const session = await requireAuth(request, env);
  if (session.error) return session.error;

  const monitor = await env.DB.prepare(
    'SELECT id FROM monitors WHERE id = ? AND user_id = ?'
  ).bind(monitorId, session.userId).first();

  if (!monitor) return jsonError('Monitor not found', 404);

  const [u24h, u7d, u30d] = await Promise.all([
    computeUptime(monitorId, 24 * 3600, env),
    computeUptime(monitorId, 7 * 24 * 3600, env),
    computeUptime(monitorId, 30 * 24 * 3600, env),
  ]);

  return jsonOk({ uptime: { '24h': u24h, '7d': u7d, '30d': u30d } });
}

// ─── Public Status Page ───────────────────────────────────────────────────────

async function handlePublicStatus(request, env, userId) {
  const user = await env.DB.prepare(
    'SELECT id, email, plan FROM users WHERE id = ?'
  ).bind(userId).first();

  if (!user) return jsonError('Status page not found', 404);

  // Only Pro/Business plans get public status pages
  if (user.plan === 'free') {
    return jsonError('Public status pages are available on Pro and Business plans', 403);
  }

  const { results: monitors } = await env.DB.prepare(`
    SELECT id, name, url, last_status, last_checked_at, last_response_time
    FROM monitors
    WHERE user_id = ? AND is_active = 1
    ORDER BY created_at ASC
  `).bind(userId).all();

  const monitorsWithUptime = await Promise.all((monitors || []).map(async (m) => {
    const uptime24h = await computeUptime(m.id, 24 * 3600, env);
    const uptime7d  = await computeUptime(m.id, 7 * 24 * 3600, env);
    return { ...m, uptime_24h: uptime24h, uptime_7d: uptime7d };
  }));

  // Get recent incidents (last 7 days)
  const since7d = Math.floor(Date.now() / 1000) - (7 * 24 * 3600);
  const { results: incidents } = await env.DB.prepare(`
    SELECT i.*, m.name as monitor_name
    FROM incidents i
    JOIN monitors m ON i.monitor_id = m.id
    WHERE m.user_id = ? AND i.started_at > ?
    ORDER BY i.started_at DESC
    LIMIT 20
  `).bind(userId, since7d).all();

  const allUp = monitorsWithUptime.every(m => m.last_status === 'up' || m.last_status === null);

  return jsonOk({
    page: {
      owner: user.email.split('@')[0], // Show username, not full email
      overall_status: allUp ? 'operational' : 'degraded',
      last_updated: Math.floor(Date.now() / 1000),
    },
    monitors: monitorsWithUptime,
    incidents: incidents || [],
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function computeUptime(monitorId, periodSeconds, env) {
  const since = Math.floor(Date.now() / 1000) - periodSeconds;
  const { results } = await env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_count
    FROM checks
    WHERE monitor_id = ? AND checked_at > ?
  `).bind(monitorId, since).all();

  if (!results || results[0].total === 0) return null;
  return Math.round((results[0].up_count / results[0].total) * 10000) / 100;
}

async function requireAuth(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return { error: jsonError('Unauthorized', 401) };
  }
  return session;
}

async function getSession(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare(`
    SELECT s.user_id, s.expires_at
    FROM sessions s
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, now).first();

  if (!session) return null;
  return { userId: session.user_id };
}

function getBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  // Use a simple PBKDF2 via WebCrypto (available in Workers)
  const key = await crypto.subtle.importKey('raw', data, { name: 'PBKDF2' }, false, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const hashArray = new Uint8Array(derivedBits);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password, storedHash) {
  const [, saltHex, hashHex] = storedHash.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const key = await crypto.subtle.importKey('raw', data, { name: 'PBKDF2' }, false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const hashArray = new Uint8Array(derivedBits);
  const computedHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHex === hashHex;
}

async function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
