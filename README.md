# Luna Sentinel Guard Discord Bot

The official Discord bot for managing Luna Sentinel Guard whitelist keys.
Connects directly to your Luna Sentinel Guard website database — every key
created in Discord appears live in the dashboard at https://luna-sentinel-guard.lovable.app

## What it does

| Command | Who | Description |
|---|---|---|
| `/login` | Admin | Link server to your account (stores API key) |
| `/setup` | Admin | Set project ID, display name, buyer role, manager role |
| `/panel` | Manager | Post the buyer control panel with 5 action buttons |
| `/createkey` | Manager | Whitelist a user and DM them their key |
| `/genkey` | Manager | Generate 1–50 unassigned keys (exported as .txt) |
| `/revoke` | Manager | Revoke a user's access and remove their role |
| `/resethwid` | Manager | Clear a user's HWID lock |
| `/extend` | Manager | Add days to a user's key |
| `/keyinfo` | Manager | View full key details for a user |
| `/stats` | Manager | View active / expired / revoked / run counts |
| `/checkdb` | Admin | Verify database tables exist, show fix SQL if not |
| `/testkey` | Admin | Look up a specific key in the database |

### Buyer panel buttons
After `/panel` is posted, buyers can self-serve:
- **Redeem Key** — claim an unassigned key to their account
- **Get Script** — receive their Lua loader via DM
- **Get Role** — self-assign the buyer role
- **Reset HWID** — clear their hardware lock
- **My Stats** — view their key status and run count

## Railway deployment

### 1. Create a new Railway project
1. Go to https://railway.app → **New Project**
2. Choose **Deploy from GitHub repo** (or **Empty project** → add service)
3. Point it at this bot folder

### 2. Set environment variables in Railway
Go to your service → **Variables** and add:

| Variable | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | From Discord Developer Portal → Bot |
| `DISCORD_APP_ID` | From Discord Developer Portal → General Information |
| `SUPABASE_URL` | `https://vpmbiscioxkfauoesyqg.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase → Project Settings → API → service_role |
| `LUNA_WEB_URL` | `https://luna-sentinel-guard.lovable.app` |

Railway sets `PORT` automatically — do not set it manually.

### 3. Deploy
Railway will run `npm install && npm start` automatically.
The bot exposes a health endpoint on `$PORT` — Railway uses this to confirm
the service is up.

## Supabase table setup

Run this once in **Supabase → SQL Editor** if the tables don't exist
(the bot's `/checkdb` command will tell you if they're missing):

```sql
CREATE TABLE IF NOT EXISTS bot_configs (
    guild_id        TEXT PRIMARY KEY,
    project_id      TEXT,
    project_name    TEXT,
    api_key         TEXT,
    buyer_role_id   TEXT,
    manager_role_id TEXT,
    email           TEXT,
    plan            TEXT,
    updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS keys (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
    key_string        TEXT UNIQUE,
    discord_id        TEXT,
    note              TEXT,
    active            BOOLEAN DEFAULT true,
    expires_at        BIGINT,
    hwid              TEXT,
    last_hwid_reset   TIMESTAMPTZ,
    total_executions  INTEGER DEFAULT 0,
    last_exec         TIMESTAMPTZ,
    key_days          INTEGER,
    created_at        TIMESTAMPTZ DEFAULT now()
);
```

## First-time server setup

Once the bot is online in your Discord server:

```
/login api_key:<your-key>
/setup project_id:<uuid-from-dashboard> project_name:Luna Sentinel Guard buyer_role:@Buyers manager_role:@Staff
/panel   ← post the control panel in your #access channel
```

Keys are formatted `LUNA-XXXXXX-XXXXXX-XXXXXX` and sync instantly to your website dashboard.
