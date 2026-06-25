require("dotenv").config();
const {
    Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    PermissionFlagsBits, ActivityType
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const http   = require("http");

// ── Env helpers ───────────────────────────────────────────────────────────────
function env(key) {
    return (process.env[key] || "").replace(/^["'\s]+|["'\s]+$/g, "");
}

// NO hardcoded fallbacks — crash clearly if missing
const BOT_TOKEN = env("DISCORD_BOT_TOKEN");
const APP_ID    = env("DISCORD_APP_ID") || env("DISCORD_CLIENT_ID");
const SB_URL    = env("SUPABASE_URL");
const SB_KEY    = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
const BASE      = (env("LUNA_WEB_URL") || "https://luna-sentinel-guard.lovable.app").replace(/\/+$/, "");

// ── Startup validation — crash loudly so Railway shows the real error ─────────
const missing = [];
if (!BOT_TOKEN || (BOT_TOKEN.match(/\./g) || []).length < 2) missing.push("DISCORD_BOT_TOKEN");
if (!APP_ID)  missing.push("DISCORD_APP_ID (or DISCORD_CLIENT_ID)");
if (!SB_URL)  missing.push("SUPABASE_URL");
if (!SB_KEY)  missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length) {
    console.error("[Bot] ❌ Missing required env vars:\n " + missing.join("\n  "));
    console.error("[Bot] Set them in Railway → your service → Variables");
    process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY);

// ── Rate limiter (per-user, in-memory) ────────────────────────────────────────
// Prevents button/command spam hammering the DB
const cooldowns = new Map();
function checkCooldown(userId, action, ms = 5000) {
    const key = `${userId}:${action}`;
    const last = cooldowns.get(key) || 0;
    const now  = Date.now();
    if (now - last < ms) return false; // still on cooldown
    cooldowns.set(key, now);
    // Clean up old entries every 1000 uses to prevent memory leak
    if (cooldowns.size > 1000) {
        const cutoff = now - 60000;
        for (const [k, v] of cooldowns) if (v < cutoff) cooldowns.delete(k);
    }
    return true;
}

// ── SQL scaffold ──────────────────────────────────────────────────────────────
const CREATE_SQL = `
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
    key_days          NUMERIC,
    created_at        TIMESTAMPTZ DEFAULT now()
);`;

async function checkTables() {
    const tables = ["bot_configs", "projects", "keys"];
    const missing = [];
    for (const t of tables) {
        const { error } = await sb.from(t).select("*").limit(1);
        if (error && (error.code === "42P01" || error.message?.includes("does not exist"))) missing.push(t);
    }
    if (missing.length) {
        console.error("\n❌ MISSING TABLES:", missing.join(", "));
        console.error("\n👇 Run this SQL in Supabase → SQL Editor:\n", CREATE_SQL, "\nThen restart.\n");
    } else {
        console.log("✅ All tables exist");
    }
    return missing;
}

// ── Railway health server ─────────────────────────────────────────────────────
// Returns only ok:true/false — does NOT leak bot tag or any internal info
function startHealthServer() {
    const port = Number(process.env.PORT || 3000);
    http.createServer((req, res) => {
        const online = client?.isReady?.() === true;
        res.writeHead(online ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: online })); // bot tag intentionally omitted
    }).listen(port, "0.0.0.0", () => console.log(`[Bot] Health server on :${port}`));
}

// ── Colours ───────────────────────────────────────────────────────────────────
const C = { main: 0x4f8ef7, ok: 0x23d18b, err: 0xf75050, warn: 0xf5a623 };

// ── Note sanitiser — strip Discord mention abuse ──────────────────────────────
function sanitiseNote(raw) {
    if (!raw) return null;
    return raw
        .replace(/@everyone/gi, "@\u200beveryone")
        .replace(/@here/gi,     "@\u200bhere")
        .replace(/<@[!&]?\d+>/g, "[mention]")
        .replace(/<#\d+>/g,     "[channel]")
        .trim()
        .slice(0, 200); // hard cap
}

// ── key_days mapping ──────────────────────────────────────────────────────────
function keyDays(durationStr) {
    if (!durationStr || durationStr === "lifetime") return "lifetime";
    const map = {
        "10m": 0.1, "1h": 0.1, "2h": 0.2, "3h": 0.3, "4h": 0.4,
        "5h":  0.5, "6h": 0.6, "7h": 0.7, "8h": 0.8, "9h": 0.9,
        "10h": 1.0, "11h": 1.1, "12h": 1.2,
        "1d": 1, "2d": 2, "3d": 3, "4d": 4, "5d": 5,
        "6d": 6, "7d": 7, "14d": 14, "30d": 30,
    };
    if (map[durationStr] !== undefined) return map[durationStr];
    const x = durationStr.match(/^(\d+)([mhd])$/);
    if (!x) return null;
    const n = parseInt(x[1]), unit = x[2];
    if (unit === "m") return parseFloat((n / 144).toFixed(4));
    if (unit === "h") return parseFloat((n / 10).toFixed(2));
    if (unit === "d") return n;
    return null;
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function genKey(prefix = "LUNA") {
    const s = () => crypto.randomBytes(3).toString("hex").toUpperCase();
    return `${prefix}-${s()}-${s()}-${s()}`;
}

function parseSecs(str) {
    if (!str || str === "lifetime") return null;
    const m = { m: 60, h: 3600, d: 86400 };
    const x = str.match(/^(\d+)([mhd])$/);
    return x ? parseInt(x[1]) * (m[x[2]] || 0) : null;
}

function durationLabel(s) {
    return {
        "10m": "10 minutes", "1h": "1 hour",   "6h": "6 hours",  "12h": "12 hours",
        "1d":  "1 day",      "3d": "3 days",    "7d": "7 days",   "14d": "14 days",
        "30d": "30 days",    "lifetime": "Lifetime"
    }[s] || s;
}

function fmtExpiry(k) {
    if (!k.expires_at) return "♾️ Lifetime";
    const sec = Number(k.expires_at) - Math.floor(Date.now() / 1000);
    if (sec <= 0) return "⛔ Expired";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), mn = Math.floor((sec % 3600) / 60);
    return d > 0 ? `⏳ ${d}d ${h}h` : h > 0 ? `⏳ ${h}h ${mn}m` : `⏳ ${mn}m`;
}

function normalizeUUID(raw) {
    if (!raw?.trim()) return null;
    const trimmed = raw.trim();
    const c = trimmed.replace(/-/g, "").toLowerCase();
    if (c.length === 32 && /^[0-9a-f]+$/.test(c))
        return `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
    return trimmed;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function getCfg(guildId) {
    try {
        const { data } = await sb.from("bot_configs").select("*").eq("guild_id", guildId).maybeSingle();
        return data || null;
    } catch { return null; }
}

async function setCfg(guildId, updates) {
    const safe = {};
    for (const [k, v] of Object.entries(updates))
        safe[k] = (v === undefined || v === null) ? null : String(v);
    if (updates.api_key !== undefined) safe.api_key = updates.api_key || null;

    const { data, error } = await sb.from("bot_configs")
        .upsert({ ...safe, guild_id: guildId, updated_at: new Date().toISOString() }, { onConflict: "guild_id" })
        .select().single();

    if (error) {
        console.error("[Bot] setCfg error:", error.message, error.hint || "");
        return null;
    }
    return data;
}

function isManager(member, cfg) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (cfg?.manager_role_id && member.roles.cache.has(cfg.manager_role_id)) return true;
    return false;
}

// ── Reply helpers ─────────────────────────────────────────────────────────────
async function reply(i, desc, color = C.main) {
    const e = new EmbedBuilder().setColor(color).setDescription(desc);
    const m = i.deferred || i.replied ? "editReply" : "reply";
    return i[m]({ embeds: [e], ephemeral: true }).catch(() => {});
}
async function replyE(i, embed) {
    const m = i.deferred || i.replied ? "editReply" : "reply";
    return i[m]({ embeds: [embed], ephemeral: true }).catch(() => {});
}

// ── Control panel ─────────────────────────────────────────────────────────────
function buildPanel(cfg) {
    const name = cfg?.project_name || "Luna Sentinel Guard";
    return {
        embeds: [new EmbedBuilder()
            .setColor(C.main)
            .setTitle(`🛡️ ${name} — Control Panel`)
            .setDescription(
                `Welcome to the **${name}** access panel.\n` +
                `Use the buttons below to redeem your key, get the loader, manage your role, or check your stats.`
            )
            .setFooter({ text: `Luna Sentinel Guard • ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}` })
            .setTimestamp()
        ],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel_redeem").setLabel("Redeem Key") .setEmoji("🔑").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("panel_script").setLabel("Get Script") .setEmoji("📋").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("panel_role")  .setLabel("Get Role")   .setEmoji("🎭").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("panel_hwid")  .setLabel("Reset HWID") .setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("panel_stats") .setLabel("My Stats")   .setEmoji("📊").setStyle(ButtonStyle.Secondary)
        )]
    };
}

// ── Duration choices ──────────────────────────────────────────────────────────
const DUR = [
    { name: "10 Minutes", value: "10m" }, { name: "1 Hour",   value: "1h"  },
    { name: "6 Hours",    value: "6h"  }, { name: "12 Hours", value: "12h" },
    { name: "1 Day",      value: "1d"  }, { name: "3 Days",   value: "3d"  },
    { name: "7 Days",     value: "7d"  }, { name: "14 Days",  value: "14d" },
    { name: "30 Days",    value: "30d" }, { name: "Lifetime", value: "lifetime" }
];

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName("login").setDescription("Link this server to your Luna Sentinel Guard account")
        .addStringOption(o => o.setName("api_key").setDescription("Your API key from the dashboard").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("setup").setDescription("Configure project, buyer role, and manager role")
        .addStringOption(o => o.setName("project_id")  .setDescription("Project UUID from the dashboard").setRequired(true))
        .addStringOption(o => o.setName("project_name").setDescription("Display name (e.g. Luna Sentinel)").setRequired(true))
        .addRoleOption(o   => o.setName("buyer_role")  .setDescription("Role given to buyers").setRequired(true))
        .addRoleOption(o   => o.setName("manager_role").setDescription("Role that can run bot commands"))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("panel").setDescription("Post the buyer control panel in this channel")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    // createkey & genkey now require ManageGuild so they're hidden from normal members
    new SlashCommandBuilder()
        .setName("createkey").setDescription("Whitelist a user and send them their key")
        .addUserOption(o   => o.setName("user")    .setDescription("User to whitelist").setRequired(true))
        .addStringOption(o => o.setName("duration").setDescription("Key duration").setRequired(true).addChoices(...DUR))
        .addStringOption(o => o.setName("note")    .setDescription("Optional note"))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("genkey").setDescription("Generate unassigned keys for selling")
        .addStringOption(o  => o.setName("duration").setDescription("Key duration").setRequired(true).addChoices(...DUR))
        .addIntegerOption(o => o.setName("amount")  .setDescription("How many (1–50)").setMinValue(1).setMaxValue(50))
        .addStringOption(o  => o.setName("note")    .setDescription("Optional note"))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("revoke").setDescription("Revoke a user's access")
        .addUserOption(o => o.setName("user").setDescription("User to revoke").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("resethwid").setDescription("Reset a user's HWID lock")
        .addUserOption(o => o.setName("user").setDescription("User to reset").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("extend").setDescription("Add days to a user's key")
        .addUserOption(o   => o.setName("user").setDescription("User to extend").setRequired(true))
        .addIntegerOption(o => o.setName("days").setDescription("Days to add").setRequired(true).setMinValue(1))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("keyinfo").setDescription("View a user's key details")
        .addUserOption(o => o.setName("user").setDescription("User to look up").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("stats").setDescription("View whitelist stats for this server")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
        .setName("checkdb").setDescription("Check database tables and show fix SQL if needed")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName("testkey").setDescription("Test if a specific key exists in the database")
        .addStringOption(o => o.setName("key").setDescription("The LUNA-xxx key to look up").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
    ]
});

client.on("interactionCreate", async interaction => {
    try {
        if (interaction.isChatInputCommand()) return handleCommand(interaction);
        if (interaction.isButton())           return handleButton(interaction);
        if (interaction.isModalSubmit())      return handleModal(interaction);
    } catch (e) { console.error("[Bot] Interaction error:", e.message); }
});

// ── Command handler ───────────────────────────────────────────────────────────
async function handleCommand(interaction) {
    const { commandName, guildId, member } = interaction;
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const cfg = await getCfg(guildId);
    try {
        return await _cmd(interaction, commandName, guildId, member, cfg);
    } catch (e) {
        console.error("[Bot] Command error in", commandName, ":", e.message, e.stack);
        // Generic message to user — never leak internal error detail
        return reply(interaction, "❌ Something went wrong — please try again.", C.err);
    }
}

async function _cmd(interaction, cmd, guildId, member, cfg) {

    // ── /login ────────────────────────────────────────────────────────────────
    if (cmd === "login") {
        const apiKey = interaction.options.getString("api_key").trim();
        if (!apiKey) return reply(interaction, "❌ Please provide an API key.", C.err);
        const saved = await setCfg(guildId, { api_key: apiKey, email: "", plan: "self-hosted" });
        if (!saved) return reply(interaction, "❌ Failed to save — run `/checkdb` to check table status.", C.err);
        return replyE(interaction, new EmbedBuilder().setColor(C.ok).setTitle("✅ Logged In!")
            .setDescription("Server linked. Run `/setup` to configure your project and roles.")
            .addFields({ name: "Plan", value: "`self-hosted`", inline: true }));
    }

    // ── /checkdb ──────────────────────────────────────────────────────────────
    if (cmd === "checkdb") {
        const missing = await checkTables();
        if (!missing.length) return reply(interaction, "✅ All tables exist (`bot_configs`, `projects`, `keys`).", C.ok);
        return reply(interaction,
            `❌ Missing tables: **${missing.join(", ")}**\n\nRun this in **Supabase → SQL Editor**:\n\`\`\`sql${CREATE_SQL}\`\`\``,
            C.err);
    }

    // ── /testkey ──────────────────────────────────────────────────────────────
    if (cmd === "testkey") {
        const keyVal = interaction.options.getString("key").trim().toUpperCase();
        const { data, error } = await sb.from("keys").select("*").eq("key_string", keyVal).maybeSingle();
        if (error) {
            console.error("[Bot] testkey DB error:", error.message);
            return reply(interaction, "❌ Database error — contact an admin.", C.err);
        }
        if (!data) return reply(interaction,
            `❌ Key \`${keyVal}\` not found.\n• Never created\n• Wrong Supabase URL\n• Was deleted`, C.err);
        return reply(interaction,
            `✅ Key found!\n\`\`\`json\n${JSON.stringify({
                key_string: data.key_string, project_id: data.project_id,
                active: data.active, expires_at: data.expires_at,
                key_days: data.key_days, discord_id: data.discord_id
            }, null, 2)}\n\`\`\``, C.ok);
    }

    // ── /setup ────────────────────────────────────────────────────────────────
    if (cmd === "setup") {
        if (!member.permissions.has(PermissionFlagsBits.Administrator))
            return reply(interaction, "❌ Administrator only.", C.err);

        const rawId       = interaction.options.getString("project_id").trim();
        const displayName = interaction.options.getString("project_name").trim();
        const buyerRole   = interaction.options.getRole("buyer_role");
        const managerRole = interaction.options.getRole("manager_role");
        const projectId   = normalizeUUID(rawId);
        if (!projectId) return reply(interaction, "❌ Invalid project ID format.", C.err);

        try {
            await sb.from("projects").upsert(
                { id: projectId, name: displayName, created_at: new Date().toISOString() },
                { onConflict: "id", ignoreDuplicates: false }
            );
        } catch (e) { console.warn("[Bot] projects upsert skipped:", e.message); }

        const saved = await setCfg(guildId, {
            project_id:      projectId,
            project_name:    displayName,
            buyer_role_id:   buyerRole.id,
            manager_role_id: managerRole?.id || null,
        });
        if (!saved?.project_id)
            return reply(interaction, "❌ Failed to save config — run `/checkdb`.", C.err);

        return replyE(interaction, new EmbedBuilder().setColor(C.ok).setTitle("✅ Setup Complete")
            .setDescription("Post a buyer panel with `/panel`.")
            .addFields(
                { name: "Project",      value: displayName,                                       inline: true },
                { name: "Buyer Role",   value: `<@&${buyerRole.id}>`,                             inline: true },
                { name: "Manager Role", value: managerRole ? `<@&${managerRole.id}>` : "Not set", inline: true }
            ));
    }

    // ── Require setup for everything below ────────────────────────────────────
    if (!cfg?.project_id)
        return reply(interaction, "❌ Run `/setup` first to configure this server.", C.err);

    // ── /panel ────────────────────────────────────────────────────────────────
    if (cmd === "panel") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        await interaction.channel.send(buildPanel(cfg));
        return reply(interaction, "✅ Panel posted!", C.ok);
    }

    // ── /createkey ────────────────────────────────────────────────────────────
    if (cmd === "createkey") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const target   = interaction.options.getUser("user");
        const duration = interaction.options.getString("duration");
        const rawNote  = interaction.options.getString("note") || null;
        const note     = sanitiseNote(rawNote);
        const secs     = parseSecs(duration);
        const expires_at = secs ? Math.floor(Date.now() / 1000) + secs : null;
        const kd       = keyDays(duration);
        const key      = genKey();

        try {
            await sb.from("projects").upsert(
                { id: cfg.project_id, name: cfg.project_name || cfg.project_id, created_at: new Date().toISOString() },
                { onConflict: "id", ignoreDuplicates: true }
            );
        } catch {}

        const { error } = await sb.from("keys").insert({
            project_id:       cfg.project_id,
            key_string:       key,
            discord_id:       target.id,
            note,
            active:           true,
            expires_at,
            key_days:         kd === "lifetime" ? null : kd,
            total_executions: 0,
            created_at:       new Date().toISOString()
        });
        if (error) {
            console.error("[Bot] createkey insert error:", error.message);
            if (error.message.includes("foreign key"))
                return reply(interaction, "❌ Project not in database. Re-run `/setup`.", C.err);
            return reply(interaction, "❌ Database error — could not create key.", C.err);
        }

        try {
            if (cfg.buyer_role_id) {
                const gm = await interaction.guild.members.fetch(target.id);
                await gm.roles.add(cfg.buyer_role_id);
            }
        } catch {}

        try {
            await target.send({ embeds: [new EmbedBuilder().setColor(C.ok)
                .setTitle("🔑 You've Been Whitelisted!")
                .setDescription(`Your key for **${cfg.project_name || "Luna Sentinel Guard"}**:`)
                .addFields(
                    { name: "Key",        value: `\`\`\`${key}\`\`\``,                                     inline: false },
                    { name: "Duration",   value: durationLabel(duration),                                    inline: true  },
                    { name: "How to use", value: `Place \`script_key="${key}"\` above the loader script`,   inline: false }
                ).setFooter({ text: "Do not share your key — HWID locks on first run" })] });
        } catch {}

        // Show manager only a truncated key so full key isn't in a channel log
        const truncKey = key.slice(0, 9) + "•••••••••••••";
        return replyE(interaction, new EmbedBuilder().setColor(C.ok).setTitle("✅ Key Created & DM'd")
            .addFields(
                { name: "User",     value: `<@${target.id}>`,      inline: true  },
                { name: "Key",      value: `\`${truncKey}\``,      inline: false },
                { name: "Duration", value: durationLabel(duration), inline: true  },
                { name: "Days",     value: kd === "lifetime" ? "lifetime" : String(kd), inline: true },
                { name: "Note",     value: note || "—",             inline: true  }
            ));
    }

    // ── /genkey ───────────────────────────────────────────────────────────────
    if (cmd === "genkey") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const duration   = interaction.options.getString("duration");
        const amount     = Math.min(interaction.options.getInteger("amount") || 1, 50);
        const rawNote    = interaction.options.getString("note") || null;
        const note       = sanitiseNote(rawNote);
        const secs       = parseSecs(duration);
        const expires_at = secs ? Math.floor(Date.now() / 1000) + secs : null;
        const kd         = keyDays(duration);

        try {
            await sb.from("projects").upsert(
                { id: cfg.project_id, name: cfg.project_name || cfg.project_id, created_at: new Date().toISOString() },
                { onConflict: "id", ignoreDuplicates: true }
            );
        } catch {}

        const rows = Array.from({ length: amount }, () => ({
            project_id:       cfg.project_id,
            key_string:       genKey(),
            discord_id:       null,
            note,
            active:           true,
            expires_at,
            key_days:         kd === "lifetime" ? null : kd,
            total_executions: 0,
            created_at:       new Date().toISOString()
        }));

        const { data, error } = await sb.from("keys").insert(rows).select("key_string");
        if (error) {
            console.error("[Bot] genkey insert error:", error.message);
            if (error.message.includes("foreign key"))
                return reply(interaction, "❌ Project not in database. Re-run `/setup`.", C.err);
            return reply(interaction, "❌ Database error — could not generate keys.", C.err);
        }

        const keyList = data.map(k => k.key_string).join("\n");
        return interaction.editReply({
            embeds: [new EmbedBuilder().setColor(C.ok).setTitle("🗝️ Keys Generated")
                .setDescription(`**${data.length}** key${data.length !== 1 ? "s" : ""} — ${durationLabel(duration)} (key_days: ${kd === "lifetime" ? "lifetime" : kd})`)],
            files: [{ attachment: Buffer.from(keyList, "utf8"), name: `luna-keys-${Date.now()}.txt` }],
            ephemeral: true
        });
    }

    // ── /revoke ───────────────────────────────────────────────────────────────
    if (cmd === "revoke") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const target = interaction.options.getUser("user");
        const { error } = await sb.from("keys").update({ active: false })
            .eq("discord_id", target.id).eq("project_id", cfg.project_id);
        if (error) {
            console.error("[Bot] revoke error:", error.message);
            return reply(interaction, "❌ Database error — could not revoke.", C.err);
        }
        try {
            const gm = await interaction.guild.members.fetch(target.id);
            if (cfg.buyer_role_id) await gm.roles.remove(cfg.buyer_role_id).catch(() => {});
        } catch {}
        try {
            await target.send({ embeds: [new EmbedBuilder().setColor(C.err)
                .setTitle("🚫 Access Revoked")
                .setDescription("Your whitelist access has been revoked. Contact support if this is a mistake.")] });
        } catch {}
        return reply(interaction, `✅ Revoked <@${target.id}>`, C.ok);
    }

    // ── /resethwid ────────────────────────────────────────────────────────────
    if (cmd === "resethwid") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const target = interaction.options.getUser("user");
        const { data, error } = await sb.from("keys")
            .update({ hwid: null, last_hwid_reset: new Date().toISOString() })
            .eq("discord_id", target.id).eq("project_id", cfg.project_id)
            .select("key_string");
        if (error) {
            console.error("[Bot] resethwid error:", error.message);
            return reply(interaction, "❌ Database error — could not reset HWID.", C.err);
        }
        if (!data?.length) return reply(interaction, "❌ No key found for this user.", C.err);
        try {
            await target.send({ embeds: [new EmbedBuilder().setColor(C.main)
                .setTitle("🔓 HWID Reset")
                .setDescription("Your HWID has been cleared. Your new device will lock on next script run.")] });
        } catch {}
        return reply(interaction, `✅ HWID reset for <@${target.id}>`, C.ok);
    }

    // ── /extend ───────────────────────────────────────────────────────────────
    if (cmd === "extend") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const target = interaction.options.getUser("user");
        const days   = interaction.options.getInteger("days");
        const { data, error } = await sb.from("keys").select("*")
            .eq("discord_id", target.id).eq("project_id", cfg.project_id).limit(1);
        if (error) {
            console.error("[Bot] extend select error:", error.message);
            return reply(interaction, "❌ Database error — could not extend key.", C.err);
        }
        if (!data?.length) return reply(interaction, "❌ No key found for this user.", C.err);
        const k      = data[0];
        const base   = k.expires_at ? Number(k.expires_at) : Math.floor(Date.now() / 1000);
        const newExp = base + days * 86400;
        await sb.from("keys").update({ expires_at: newExp }).eq("key_string", k.key_string);
        const nd = new Date(newExp * 1000).toLocaleDateString();
        try {
            await target.send({ embeds: [new EmbedBuilder().setColor(C.ok)
                .setTitle("✅ Key Extended")
                .setDescription(`Extended by **${days} day${days !== 1 ? "s" : ""}**. New expiry: **${nd}**`)] });
        } catch {}
        return reply(interaction, `✅ Extended <@${target.id}>'s key by ${days}d → ${nd}`, C.ok);
    }

    // ── /keyinfo ──────────────────────────────────────────────────────────────
    if (cmd === "keyinfo") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const target = interaction.options.getUser("user");
        const { data, error } = await sb.from("keys").select("*")
            .eq("discord_id", target.id).eq("project_id", cfg.project_id).limit(1);
        if (error) {
            console.error("[Bot] keyinfo error:", error.message);
            return reply(interaction, "❌ Database error — could not fetch key.", C.err);
        }
        if (!data?.length) return reply(interaction, "❌ No key found for this user.", C.err);
        const k     = data[0];
        const now   = Math.floor(Date.now() / 1000);
        const expTs = k.expires_at ? Number(k.expires_at) : null;
        const active = !!k.active && (!expTs || expTs > now);
        const kdVal  = k.key_days === null || k.key_days === undefined ? "lifetime" : String(k.key_days);
        return replyE(interaction, new EmbedBuilder().setColor(active ? C.main : C.err)
            .setTitle(`🔑 Key Info — ${target.username}`)
            .setThumbnail(target.displayAvatarURL())
            .addFields(
                { name: "Key",      value: `\`${k.key_string}\``,                                                   inline: false },
                { name: "Status",   value: active ? "✅ Active" : "❌ Revoked/Expired",                              inline: true  },
                { name: "Expires",  value: fmtExpiry(k),                                                             inline: true  },
                { name: "key_days", value: kdVal,                                                                    inline: true  },
                { name: "HWID",     value: k.hwid ? "🔒 Locked" : "🔓 Unlocked",                                    inline: true  },
                { name: "Runs",     value: String(k.total_executions || 0),                                          inline: true  },
                { name: "Last Run", value: k.last_exec ? `<t:${Math.floor(new Date(k.last_exec).getTime() / 1000)}:R>` : "Never", inline: true },
                { name: "Note",     value: k.note || "—",                                                            inline: true  }
            ).setTimestamp());
    }

    // ── /stats ────────────────────────────────────────────────────────────────
    if (cmd === "stats") {
        if (!isManager(member, cfg)) return reply(interaction, "❌ No permission.", C.err);
        const { data: allKeys, error } = await sb.from("keys")
            .select("active,expires_at,total_executions").eq("project_id", cfg.project_id);
        if (error) {
            console.error("[Bot] stats error:", error.message);
            return reply(interaction, "❌ Database error — could not fetch stats.", C.err);
        }
        const now     = Math.floor(Date.now() / 1000);
        const active  = (allKeys || []).filter(k =>  k.active && (!k.expires_at || k.expires_at > now)).length;
        const expired = (allKeys || []).filter(k =>  k.expires_at && k.expires_at <= now).length;
        const revoked = (allKeys || []).filter(k => !k.active).length;
        const runs    = (allKeys || []).reduce((s, k) => s + (k.total_executions || 0), 0);
        return replyE(interaction, new EmbedBuilder().setColor(C.main)
            .setTitle(`📊 Stats — ${cfg.project_name || "Project"}`)
            .addFields(
                { name: "🟢 Active",     value: String(active),                inline: true },
                { name: "⛔ Expired",    value: String(expired),               inline: true },
                { name: "🔴 Revoked",    value: String(revoked),               inline: true },
                { name: "⚡ Total Runs", value: String(runs),                  inline: true },
                { name: "📦 Total Keys", value: String((allKeys || []).length), inline: true }
            ).setTimestamp());
    }
}

// ── Button handler ────────────────────────────────────────────────────────────
async function handleButton(interaction) {
    const { customId, guildId, user } = interaction;
    const cfg = await getCfg(guildId);

    try {
        if (customId === "panel_redeem") {
            // Rate limit redeem attempts — 10s cooldown
            if (!checkCooldown(user.id, "redeem", 10000))
                return interaction.reply({ content: "⏳ Please wait a moment before trying again.", ephemeral: true });
            const modal = new ModalBuilder().setCustomId("modal_redeem").setTitle("Redeem a Key");
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("key_input")
                    .setLabel("Enter your key below:")
                    .setPlaceholder("LUNA-XXXXXX-XXXXXX-XXXXXX")
                    .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(10).setMaxLength(80)
            ));
            return interaction.showModal(modal);
        }

        // Rate limit all other buttons — 5s per user per action
        if (!checkCooldown(user.id, customId, 5000)) {
            return interaction.reply({ content: "⏳ Please wait a moment before doing that again.", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        async function findKey(uid) {
            if (cfg?.project_id) {
                const { data } = await sb.from("keys").select("*")
                    .eq("discord_id", uid).eq("project_id", cfg.project_id).eq("active", true).limit(1);
                if (data?.length) return data[0];
            }
            const { data } = await sb.from("keys").select("*")
                .eq("discord_id", uid).eq("active", true).limit(1);
            return data?.[0] || null;
        }

        if (customId === "panel_script") {
            const k   = await findKey(user.id);
            const now = Math.floor(Date.now() / 1000);
            if (!k) return reply(interaction,
                "❌ **Not whitelisted!**\n\nYou need a key to access this script.\nClick **Redeem Key** if you have one.", C.err);
            if (k.expires_at && k.expires_at <= now)
                return reply(interaction, "❌ Your key has expired. Contact support.", C.err);
            if (k.discord_id && k.discord_id !== user.id)
                return reply(interaction, "❌ This key belongs to another account.", C.err);
            const loader = `script_key="${k.key_string}"\nloadstring(game:HttpGet("${BASE}/v1/auth?key="..script_key.."&hwid="..game:GetService("RbxAnalyticsService"):GetClientId()))()`;
            try {
                await user.send({ embeds: [new EmbedBuilder().setColor(C.main)
                    .setTitle("📋 Your Script Loader")
                    .setDescription("Execute this in your Roblox executor.")
                    .addFields(
                        { name: "Loader",     value: `\`\`\`lua\n${loader}\n\`\`\`` },
                        { name: "Expires",    value: fmtExpiry(k),                    inline: true },
                        { name: "Total Runs", value: String(k.total_executions || 0), inline: true }
                    ).setFooter({ text: "Keep this private — HWID locks on first run" })] });
                return reply(interaction, "✅ Loader sent to your DMs!", C.ok);
            } catch {
                return reply(interaction, "❌ Couldn't DM you. Enable **Allow DMs from server members** in Discord privacy settings.", C.err);
            }
        }

        if (customId === "panel_role") {
            if (!cfg?.buyer_role_id) return reply(interaction, "❌ No buyer role configured.", C.err);
            const k   = await findKey(user.id);
            const now = Math.floor(Date.now() / 1000);
            if (!k) return reply(interaction, "❌ No active key found. Redeem a key first.", C.err);
            if (k.expires_at && k.expires_at <= now) return reply(interaction, "❌ Your key has expired.", C.err);
            try {
                const gm = await interaction.guild.members.fetch(user.id);
                if (gm.roles.cache.has(cfg.buyer_role_id)) return reply(interaction, "✅ You already have the buyer role!", C.ok);
                await gm.roles.add(cfg.buyer_role_id);
                return reply(interaction, `✅ You now have <@&${cfg.buyer_role_id}>!`, C.ok);
            } catch {
                return reply(interaction, "❌ Failed to assign role — bot needs **Manage Roles** above the buyer role.", C.err);
            }
        }

        if (customId === "panel_hwid") {
            const k = await findKey(user.id);
            if (!k) return reply(interaction, "❌ No key found for your account.", C.err);
            // HWID reset is allowed freely (no cooldown beyond the 5s spam guard above)
            await sb.from("keys").update({ hwid: null, last_hwid_reset: new Date().toISOString() }).eq("key_string", k.key_string);
            return replyE(interaction, new EmbedBuilder().setColor(C.ok).setTitle("🔓 HWID Reset")
                .setDescription("Your HWID has been cleared. Your new device locks on next script run."));
        }

        if (customId === "panel_stats") {
            const k     = await findKey(user.id);
            if (!k) return reply(interaction, "❌ No key found. Redeem a key first.", C.err);
            const now   = Math.floor(Date.now() / 1000);
            const expTs = k.expires_at ? Number(k.expires_at) : null;
            const active = !!k.active && (!expTs || expTs > now);
            const kdVal  = k.key_days === null || k.key_days === undefined ? "lifetime" : String(k.key_days);
            return replyE(interaction, new EmbedBuilder().setColor(C.main).setTitle("📊 Your Stats")
                .addFields(
                    { name: "Status",     value: active ? "✅ Active" : "❌ Expired/Revoked",                              inline: true },
                    { name: "Expires",    value: fmtExpiry(k),                                                              inline: true },
                    { name: "key_days",   value: kdVal,                                                                     inline: true },
                    { name: "HWID",       value: k.hwid ? "🔒 Locked" : "🔓 Not locked",                                   inline: true },
                    { name: "Total Runs", value: String(k.total_executions || 0),                                           inline: true },
                    { name: "Last Run",   value: k.last_exec ? `<t:${Math.floor(new Date(k.last_exec).getTime() / 1000)}:R>` : "Never", inline: true }
                ).setFooter({ text: cfg?.project_name || "Luna Sentinel Guard" }).setTimestamp());
        }
    } catch (e) {
        console.error("[Bot] Button error:", e.message);
        try { await reply(interaction, "❌ Something went wrong — please try again.", C.err); } catch {}
    }
}

// ── Modal handler ─────────────────────────────────────────────────────────────
async function handleModal(interaction) {
    const { customId, guildId, user } = interaction;
    const cfg = await getCfg(guildId);

    if (customId === "modal_redeem") {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const keyStr = interaction.fields.getTextInputValue("key_input").trim().toUpperCase();

        const { data: k, error } = await sb.from("keys").select("*").eq("key_string", keyStr).maybeSingle();
        if (error) {
            console.error("[Bot] modal_redeem DB error:", error.message);
            return reply(interaction, "❌ Database error — please try again.", C.err);
        }
        if (!k)        return reply(interaction, "❌ Invalid key — double-check and try again.", C.err);
        if (!k.active) return reply(interaction, "❌ This key has been revoked.", C.err);
        if (k.expires_at && k.expires_at <= Math.floor(Date.now() / 1000))
            return reply(interaction, "❌ This key has expired.", C.err);
        if (k.discord_id && k.discord_id !== user.id)
            return reply(interaction, "❌ This key is already claimed by another account.", C.err);

        if (!k.discord_id)
            await sb.from("keys").update({ discord_id: user.id }).eq("key_string", keyStr);

        try {
            if (cfg?.buyer_role_id) {
                const gm = await interaction.guild.members.fetch(user.id);
                await gm.roles.add(cfg.buyer_role_id);
            }
        } catch {}

        return replyE(interaction, new EmbedBuilder().setColor(C.ok).setTitle("✅ Key Redeemed!")
            .setDescription("Your key is now linked to your account.\nClick **Get Script** to get your loader.")
            .addFields(
                { name: "Key",      value: `\`${keyStr}\``,                                                 inline: false },
                { name: "Expires",  value: fmtExpiry(k),                                                    inline: true  },
                { name: "key_days", value: k.key_days === null || k.key_days === undefined ? "lifetime" : String(k.key_days), inline: true }
            ).setFooter({ text: "Do NOT share your key" }));
    }
}

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once("ready", async () => {
    console.log(`[Bot] Online as ${client.user.tag}`);
    await checkTables();
    try { client.user.setActivity("Luna Sentinel Guard", { type: ActivityType.Watching }); } catch {}
    if (!APP_ID) { console.warn("[Bot] Skipping command registration — APP_ID missing."); return; }
    try {
        await new REST({ version: "10" }).setToken(BOT_TOKEN)
            .put(Routes.applicationCommands(APP_ID), { body: commands.map(c => c.toJSON()) });
        console.log(`[Bot] Registered ${commands.length} global commands`);
    } catch (e) { console.error("[Bot] Command registration failed:", e.message); }
});

client.on("error", e => console.error("[Bot] Error:", e.message));
client.on("warn",  m => console.warn("[Bot] Warn:", m));
process.on("uncaughtException",  e => console.error("[Bot] Uncaught:", e.message));
process.on("unhandledRejection", e => console.error("[Bot] Unhandled:", e));

startHealthServer();

function startBot() {
    client.login(BOT_TOKEN).catch(e => {
        console.error("[Bot] Login failed:", e.message, "— retrying in 10s");
        setTimeout(startBot, 10000);
    });
}
startBot();
