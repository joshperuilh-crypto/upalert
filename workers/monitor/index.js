/**
 * UpAlert Monitor Worker
 * Runs every minute via cron trigger.
 * Fetches all active monitors due for a check, pings them, records results.
 */

export default {
  // HTTP handler (for manual triggers / health checks)
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/trigger') {
      await runMonitorCycle(env, ctx);
      return new Response(JSON.stringify({ ok: true, message: 'Monitor cycle triggered' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('UpAlert Monitor Worker', { status: 200 });
  },

  // Cron handler: fires every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitorCycle(env, ctx));
  }
};

/**
 * Main monitoring loop: finds due monitors and pings them in parallel.
 */
async function runMonitorCycle(env, ctx) {
  const now = Math.floor(Date.now() / 1000);

  // Fetch all active monitors with user plan info
  const { results: monitors } = await env.DB.prepare(`
    SELECT m.*, u.plan, u.email as user_email, u.resend_api_key, u.slack_webhook_url
    FROM monitors m
    JOIN users u ON m.user_id = u.id
    WHERE m.is_active = 1
  `).all();

  if (!monitors || monitors.length === 0) return;

  // Filter monitors that are due for a check
  const dueMonitors = monitors.filter(monitor => {
    if (!monitor.last_checked_at) return true; // Never checked
    const intervalSeconds = monitor.check_interval * 60;
    return (now - monitor.last_checked_at) >= intervalSeconds;
  });

  if (dueMonitors.length === 0) return;

  // Check all due monitors in parallel (Cloudflare handles concurrency)
  await Promise.allSettled(
    dueMonitors.map(monitor => checkMonitor(monitor, env, now))
  );
}

/**
 * Ping a single monitor URL and record the result.
 */
async function checkMonitor(monitor, env, now) {
  const startTime = Date.now();
  let status = 'down';
  let responseTime = null;
  let statusCode = null;
  let errorMessage = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(monitor.url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'UpAlert-Monitor/1.0 (https://upalert.io)',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);
    responseTime = Date.now() - startTime;
    statusCode = response.status;

    // Consider 2xx and 3xx as "up"
    if (response.status >= 200 && response.status < 400) {
      status = 'up';
    } else {
      status = 'down';
      errorMessage = `HTTP ${response.status}`;
    }
  } catch (err) {
    responseTime = null;
    if (err.name === 'AbortError') {
      errorMessage = 'Timeout after 10 seconds';
    } else {
      errorMessage = err.message || 'Connection failed';
    }
    status = 'down';
  }

  const previousStatus = monitor.last_status;
  const statusChanged = previousStatus !== status;

  // Record the check
  await env.DB.prepare(`
    INSERT INTO checks (monitor_id, status, response_time, status_code, error_message, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(monitor.id, status, responseTime, statusCode, errorMessage, now).run();

  // Update monitor's last status
  await env.DB.prepare(`
    UPDATE monitors
    SET last_status = ?, last_checked_at = ?, last_response_time = ?, updated_at = ?
    WHERE id = ?
  `).bind(status, now, responseTime, now, monitor.id).run();

  // Handle incidents (outage tracking)
  if (statusChanged) {
    if (status === 'down') {
      // New outage — create incident
      await env.DB.prepare(`
        INSERT INTO incidents (monitor_id, started_at)
        VALUES (?, ?)
      `).bind(monitor.id, now).run();

      // Send alert
      await sendAlert(monitor, status, null, env);
    } else {
      // Recovery — close the open incident
      const { results: openIncidents } = await env.DB.prepare(`
        SELECT id, started_at FROM incidents
        WHERE monitor_id = ? AND resolved_at IS NULL
        ORDER BY started_at DESC LIMIT 1
      `).bind(monitor.id).all();

      if (openIncidents && openIncidents.length > 0) {
        const incident = openIncidents[0];
        const duration = now - incident.started_at;
        await env.DB.prepare(`
          UPDATE incidents
          SET resolved_at = ?, duration = ?
          WHERE id = ?
        `).bind(now, duration, incident.id).run();

        // Send recovery alert
        await sendAlert(monitor, status, duration, env);
      }
    }
  }

  // Clean up old checks (keep last 30 days = ~43,200 checks per monitor)
  // Run occasionally (1% chance) to avoid overhead every minute
  if (Math.random() < 0.01) {
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);
    await env.DB.prepare(`
      DELETE FROM checks WHERE monitor_id = ? AND checked_at < ?
    `).bind(monitor.id, thirtyDaysAgo).run();
  }
}

/**
 * Send alert email via Resend API when status changes.
 */
async function sendAlert(monitor, newStatus, outrageDuration, env) {
  if (!monitor.alert_email) return;

  // Use monitor owner's Resend key, or fall back to env key
  const apiKey = monitor.resend_api_key || env.RESEND_API_KEY;
  if (!apiKey) return;

  const isDown = newStatus === 'down';
  const subject = isDown
    ? `[UpAlert] DOWN: ${monitor.name} is unreachable`
    : `[UpAlert] RECOVERED: ${monitor.name} is back up`;

  const durationText = outrageDuration
    ? formatDuration(outrageDuration)
    : '';

  const htmlBody = isDown
    ? `
      <h2 style="color:#ef4444;">Alert: ${monitor.name} is DOWN</h2>
      <p><strong>URL:</strong> <a href="${monitor.url}">${monitor.url}</a></p>
      <p><strong>Time:</strong> ${new Date(Date.now()).toUTCString()}</p>
      <p>We'll notify you when it recovers.</p>
      <hr>
      <small>Sent by <a href="https://upalert.io">UpAlert</a></small>
    `
    : `
      <h2 style="color:#22c55e;">Recovered: ${monitor.name} is back UP</h2>
      <p><strong>URL:</strong> <a href="${monitor.url}">${monitor.url}</a></p>
      <p><strong>Downtime duration:</strong> ${durationText}</p>
      <p><strong>Time:</strong> ${new Date(Date.now()).toUTCString()}</p>
      <hr>
      <small>Sent by <a href="https://upalert.io">UpAlert</a></small>
    `;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'UpAlert <alerts@upalert.io>',
        to: [monitor.user_email],
        subject,
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Failed to send email alert:', err.message);
  }

  // Slack alert (Business plan)
  if (monitor.alert_slack && monitor.slack_webhook_url) {
    await sendSlackAlert(monitor, newStatus, outrageDuration);
  }
}

/**
 * Send Slack webhook alert.
 */
async function sendSlackAlert(monitor, newStatus, outrageDuration) {
  const isDown = newStatus === 'down';
  const emoji = isDown ? ':red_circle:' : ':large_green_circle:';
  const text = isDown
    ? `${emoji} *${monitor.name}* is *DOWN*\n${monitor.url}`
    : `${emoji} *${monitor.name}* recovered after ${formatDuration(outrageDuration)}\n${monitor.url}`;

  try {
    await fetch(monitor.slack_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Failed to send Slack alert:', err.message);
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
