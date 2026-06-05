# UpAlert — Uptime Monitoring SaaS

Know instantly when your website goes down. UpAlert monitors your URLs every minute and sends alerts via email (Resend) or Slack.

## Architecture

```
Cloudflare Workers (cron)  →  D1 Database (SQLite)  ←  Cloudflare Workers (API)
                                                              ↑
                                                    Cloudflare Pages (Frontend)
```

- **`workers/monitor/`** — Cron worker, fires every minute, pings all active monitors
- **`workers/api/`** — REST API: auth, CRUD for monitors, status history
- **`frontend/`** — Static HTML/CSS/JS dashboard + landing page + public status pages
- **`schema.sql`** — D1 SQLite schema (users, monitors, checks, incidents)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 database

```bash
npm run db:create
# Copy the database_id from output → paste into wrangler.toml and wrangler.monitor.toml
```

### 3. Run the schema migration

```bash
npm run db:migrate
```

### 4. Set secrets

```bash
# Required for email alerts (get free key at resend.com)
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_API_KEY --config wrangler.monitor.toml

# Change the JWT signing secret
wrangler secret put JWT_SECRET
```

### 5. Deploy workers

```bash
npm run deploy:all
```

### 6. Deploy frontend to Cloudflare Pages

```bash
# First: update API_URL in frontend/dashboard/app.js and frontend/status/index.html
# to point to your deployed API worker URL (https://upalert.workers.dev by default)

npm run pages:deploy
```

## Development

```bash
# Run API worker locally (port 8787)
npm run dev:api

# Run monitor worker locally
npm run dev:monitor

# Open frontend/dashboard/index.html directly in a browser
# or serve with: npx serve frontend
```

## Plans & Limits

| Feature              | Free     | Pro ($9/mo) | Business ($19/mo) |
|----------------------|----------|-------------|-------------------|
| Monitors             | 3        | 20          | Unlimited         |
| Check interval       | 5 min    | 1 min       | 1 min             |
| Email alerts         | yes      | yes         | yes               |
| Public status page   | no       | yes         | yes               |
| Slack alerts         | no       | no          | yes               |
| History retention    | 7 days   | 30 days     | 30 days           |

## API Reference

### Auth
| Method | Path                  | Body                     | Description         |
|--------|-----------------------|--------------------------|---------------------|
| POST   | /api/auth/register    | {email, password}        | Create account      |
| POST   | /api/auth/login       | {email, password}        | Login, get token    |
| POST   | /api/auth/logout      | none                     | Invalidate token    |
| GET    | /api/auth/me          | none                     | Current user info   |

### Monitors
| Method | Path                         | Description                     |
|--------|------------------------------|---------------------------------|
| GET    | /api/monitors                | List all monitors + 24h uptime  |
| POST   | /api/monitors                | Create a monitor                |
| GET    | /api/monitors/:id            | Get monitor + 7d/30d uptime     |
| PUT    | /api/monitors/:id            | Update monitor                  |
| DELETE | /api/monitors/:id            | Delete monitor + history        |
| GET    | /api/monitors/:id/checks     | Check history (?period=24h)     |
| GET    | /api/monitors/:id/uptime     | Uptime % for 24h/7d/30d         |

### Public
| Method | Path              | Description                       |
|--------|-------------------|-----------------------------------|
| GET    | /api/status/:uid  | Public status page (Pro/Business) |

All authenticated endpoints require: Authorization: Bearer <token>

## Email Alerts (Resend)

1. Sign up at resend.com (free tier: 3K emails/month)
2. Add your API key: wrangler secret put RESEND_API_KEY
3. Update the from address in workers/monitor/index.js to your verified domain

## Cloudflare Free Tier Usage

| Resource        | Limit/day      | Estimated usage (100 monitors x 1min) |
|-----------------|----------------|---------------------------------------|
| Worker requests | 100K           | ~144K (monitor) + dashboard hits      |
| D1 reads        | 5M             | ~288K (2 reads/check)                 |
| D1 writes       | 100K           | ~288K (2 writes/check)                |

Note: At high scale (100+ monitors, 1-min interval) you may exceed D1 write limits on the free tier.
Upgrading to Cloudflare Workers Paid ($5/mo) includes 1M D1 writes/day.
