/**
 * ════════════════════════════════════════════════════════════════════════════
 *  CHRONOX BOT — Moderasyon • Ticket • AutoMod • Log • Kart Oyunu (Gacha)
 *  Discord.js v14 + better-sqlite3  |  index.js + modules/ (karşılama modülü)
 * ════════════════════════════════════════════════════════════════════════════
 *  İÇİNDEKİLER
 *   1. Kurulum, ortam değişkenleri, yardımcılar
 *   2. SQLite veritabanı (şema + hazır sorgular)
 *   3. Ortak servisler (log, vaka, uyarı, ceza kademesi)
 *   4. Komutlar: Moderasyon
 *   5. Komutlar: Ticket sistemi (panel, butonlar, modallar, /add, /remove ...)
 *   6. Komutlar: Ayarlar (/config) ve AutoMod (/automod)
 *   7. Komutlar: Ekonomi + Kart oyunu (gacha, market, takas) + Bilgi komutları
 *   8. Olaylar: AutoMod, Raid koruması, Loglar, Karşılama (modules/welcome.js)
 *   9. Interaction yönlendirici ve bot başlangıcı
 * ════════════════════════════════════════════════════════════════════════════
 */
'use strict';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. KURULUM
 * ════════════════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

/** Küçük .env okuyucu (ekstra paket gerektirmez) */
function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;
const DEV_GUILD_ID = process.env.GUILD_ID || null; // doluysa komutlar sadece bu sunucuya yüklenir (anında)
if (!TOKEN) {
  console.error('❌ DISCORD_TOKEN bulunamadı. .env dosyasına DISCORD_TOKEN=... yaz.');
  process.exit(1);
}

const EPHEMERAL = MessageFlags.Ephemeral;
const COLOR = {
  ok: 0x57f287,
  error: 0xed4245,
  warn: 0xfee75c,
  info: 0x5865f2,
  mod: 0xeb459e,
  ticket: 0x3498db,
  gold: 0xf1c40f,
  dark: 0x2b2d31,
};

/* ── Genel yardımcılar ─────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n = 1000) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const fmt = (n) => Number(n).toLocaleString('tr-TR');
const unix = (ms) => Math.floor(ms / 1000);
const dt = (ms, style = 'f') => `<t:${unix(ms)}:${style}>`;
const pad = (n) => String(n).padStart(4, '0');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const lower = (s) => String(s ?? '').toLocaleLowerCase('tr');

function embed(color, title, description) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
}
const okBody = (text) => ({ embeds: [embed(COLOR.ok, null, `✅ ${text}`)] });
const errBody = (text) => ({ embeds: [embed(COLOR.error, null, `❌ ${text}`)] });

/** Interaction'ın durumuna göre reply / editReply / followUp seçer */
async function respond(i, body) {
  if (i.deferred && !i.replied) {
    const { flags, ...rest } = body; // editReply'da flags gönderilmez
    return i.editReply(rest);
  }
  if (i.replied || i.deferred) return i.followUp(body);
  return i.reply(body);
}
const fail = (i, text) => respond(i, { ...errBody(text), flags: EPHEMERAL });
const succeed = (i, text, ephemeral = false) =>
  respond(i, ephemeral ? { ...okBody(text), flags: EPHEMERAL } : okBody(text));

/* ── Süre ayrıştırma / biçimlendirme ──────────────────────────────────────── */
const DURATION_UNITS = { s: 1e3, sn: 1e3, m: 6e4, dk: 6e4, h: 36e5, sa: 36e5, d: 864e5, g: 864e5, w: 6048e5, hf: 6048e5 };
/** "10m", "2h", "1d12h", "30dk", "1sa" → milisaniye (geçersizse null) */
function parseDuration(input) {
  if (!input) return null;
  const clean = String(input).toLowerCase().replace(/\s+/g, '');
  const re = /(\d+)([a-z]+)/g;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(clean))) {
    const unit = DURATION_UNITS[m[2]];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    consumed += m[0].length;
  }
  return consumed === clean.length && total > 0 ? total : null;
}
function formatDuration(ms) {
  const parts = [];
  for (const [name, size] of [['gün', 864e5], ['saat', 36e5], ['dakika', 6e4], ['saniye', 1e3]]) {
    const v = Math.floor(ms / size);
    if (v > 0) {
      parts.push(`${v} ${name}`);
      ms -= v * size;
    }
  }
  return parts.join(' ') || '0 saniye';
}
const MAX_TIMEOUT_MS = 28 * 864e5; // Discord limiti: 28 gün

/* ════════════════════════════════════════════════════════════════════════════
 * 2. VERİTABANI
 * ════════════════════════════════════════════════════════════════════════════ */
const db = new Database(path.join(__dirname, 'bot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
/* ── Kart oyunu / ekonomi ── */
CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  gold         INTEGER NOT NULL DEFAULT 500,
  pity_count   INTEGER NOT NULL DEFAULT 0,
  last_daily   INTEGER NOT NULL DEFAULT 0,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  total_pulls  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_cards (
  user_id     TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1,
  obtained_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS market_listings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id  TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  price      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_seller ON market_listings (seller_id);

CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user    TEXT NOT NULL,
  to_user      TEXT NOT NULL,
  offer_card   TEXT,
  request_card TEXT,
  offer_gold   INTEGER NOT NULL DEFAULT 0,
  request_gold INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL
);

/* ── Sunucu ayarları ── */
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id             TEXT PRIMARY KEY,
  log_channel          TEXT,
  mod_log_channel      TEXT,
  ticket_log_channel   TEXT,
  welcome_channel      TEXT,
  welcome_message      TEXT,
  autorole             TEXT,
  ticket_category      TEXT,
  support_role         TEXT,
  max_tickets          INTEGER NOT NULL DEFAULT 1,
  ticket_counter       INTEGER NOT NULL DEFAULT 0,
  warn_timeout_at      INTEGER NOT NULL DEFAULT 3,
  warn_timeout_minutes INTEGER NOT NULL DEFAULT 60,
  warn_kick_at         INTEGER NOT NULL DEFAULT 5,
  warn_ban_at          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS automod_settings (
  guild_id             TEXT PRIMARY KEY,
  spam                 INTEGER NOT NULL DEFAULT 1,
  spam_messages        INTEGER NOT NULL DEFAULT 5,
  spam_seconds         INTEGER NOT NULL DEFAULT 5,
  spam_timeout_minutes INTEGER NOT NULL DEFAULT 5,
  invites              INTEGER NOT NULL DEFAULT 1,
  links                INTEGER NOT NULL DEFAULT 0,
  badwords             INTEGER NOT NULL DEFAULT 0,
  caps                 INTEGER NOT NULL DEFAULT 0,
  caps_percent         INTEGER NOT NULL DEFAULT 70,
  mentions             INTEGER NOT NULL DEFAULT 1,
  mention_limit        INTEGER NOT NULL DEFAULT 5,
  raid                 INTEGER NOT NULL DEFAULT 0,
  raid_joins           INTEGER NOT NULL DEFAULT 8,
  raid_seconds         INTEGER NOT NULL DEFAULT 10,
  min_account_days     INTEGER NOT NULL DEFAULT 0
);

/* kind: badword | domain (izinli alan adı) | ignore (kanal/rol/kategori ID) */
CREATE TABLE IF NOT EXISTS automod_lists (
  guild_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (guild_id, kind, value)
);

/* ── Moderasyon ── */
CREATE TABLE IF NOT EXISTS warnings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings (guild_id, user_id);

CREATE TABLE IF NOT EXISTS mod_cases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  case_no      INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT,
  duration_ms  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_user ON mod_cases (guild_id, user_id);

CREATE TABLE IF NOT EXISTS temp_bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

/* ── Ticket ── */
CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  ticket_no    INTEGER NOT NULL,
  channel_id   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL,
  category     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  priority     TEXT NOT NULL DEFAULT 'normal',
  claimed_by   TEXT,
  message_id   TEXT,
  rating       INTEGER,
  close_reason TEXT,
  closed_by    TEXT,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (guild_id, user_id, status);

CREATE TABLE IF NOT EXISTS ticket_blacklist (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  reason   TEXT,
  PRIMARY KEY (guild_id, user_id)
);
`);

/* ── Hazır sorgular ───────────────────────────────────────────────────────── */
const S = {
  // ayarlar
  getSettings: db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?'),
  insertSettings: db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)'),
  getAutomod: db.prepare('SELECT * FROM automod_settings WHERE guild_id = ?'),
  insertAutomod: db.prepare('INSERT OR IGNORE INTO automod_settings (guild_id) VALUES (?)'),
  listGet: db.prepare('SELECT value FROM automod_lists WHERE guild_id = ? AND kind = ?'),
  listAdd: db.prepare('INSERT OR IGNORE INTO automod_lists (guild_id, kind, value) VALUES (?, ?, ?)'),
  listDel: db.prepare('DELETE FROM automod_lists WHERE guild_id = ? AND kind = ? AND value = ?'),

  // moderasyon
  insertWarning: db.prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)'),
  countWarnings: db.prepare('SELECT COUNT(*) AS c FROM warnings WHERE guild_id = ? AND user_id = ?'),
  listWarnings: db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15'),
  getWarning: db.prepare('SELECT * FROM warnings WHERE id = ? AND guild_id = ?'),
  delWarning: db.prepare('DELETE FROM warnings WHERE id = ? AND guild_id = ?'),
  clearWarnings: db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?'),
  nextCase: db.prepare('SELECT COALESCE(MAX(case_no), 0) + 1 AS n FROM mod_cases WHERE guild_id = ?'),
  insertCase: db.prepare(
    'INSERT INTO mod_cases (guild_id, case_no, user_id, moderator_id, action, reason, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  listCases: db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15'),
  addTempBan: db.prepare('INSERT INTO temp_bans (guild_id, user_id, expires_at) VALUES (?, ?, ?)'),
  dueTempBans: db.prepare('SELECT * FROM temp_bans WHERE expires_at <= ?'),
  delTempBan: db.prepare('DELETE FROM temp_bans WHERE id = ?'),
  delTempBanUser: db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?'),

  // ticket
  bumpTicketCounter: db.prepare('UPDATE guild_settings SET ticket_counter = ticket_counter + 1 WHERE guild_id = ?'),
  getTicketCounter: db.prepare('SELECT ticket_counter FROM guild_settings WHERE guild_id = ?'),
  insertTicket: db.prepare(
    `INSERT INTO tickets (guild_id, ticket_no, channel_id, user_id, category, subject, description, created_at)
     VALUES (@guild_id, @ticket_no, @channel_id, @user_id, @category, @subject, @description, @created_at)`
  ),
  getTicketByChannel: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
  getTicketById: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  countOpenByUser: db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'"),
  listOpenTickets: db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND status = 'open' ORDER BY id DESC LIMIT 25"),
  setTicketMessage: db.prepare('UPDATE tickets SET message_id = ? WHERE id = ?'),
  setTicketClaim: db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?'),
  setTicketPriority: db.prepare('UPDATE tickets SET priority = ? WHERE id = ?'),
  setTicketRating: db.prepare('UPDATE tickets SET rating = ? WHERE id = ?'),
  closeTicket: db.prepare(
    "UPDATE tickets SET status = 'closed', close_reason = @reason, closed_by = @closed_by, closed_at = @closed_at WHERE id = @id"
  ),
  getBlacklist: db.prepare('SELECT * FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?'),
  addBlacklist: db.prepare('INSERT OR REPLACE INTO ticket_blacklist (guild_id, user_id, reason) VALUES (?, ?, ?)'),
  delBlacklist: db.prepare('DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?'),

  // ekonomi
  getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  insertUser: db.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)'),
  addGold: db.prepare('UPDATE users SET gold = gold + ? WHERE user_id = ?'),
  topGold: db.prepare('SELECT user_id, gold FROM users ORDER BY gold DESC LIMIT 10'),
  userCards: db.prepare('SELECT card_id, quantity FROM user_cards WHERE user_id = ? ORDER BY obtained_at ASC'),
  getCardRow: db.prepare('SELECT quantity FROM user_cards WHERE user_id = ? AND card_id = ?'),
  upsertCard: db.prepare(
    `INSERT INTO user_cards (user_id, card_id, quantity, obtained_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = quantity + excluded.quantity`
  ),
  setCardQty: db.prepare('UPDATE user_cards SET quantity = ? WHERE user_id = ? AND card_id = ?'),
  delCardRow: db.prepare('DELETE FROM user_cards WHERE user_id = ? AND card_id = ?'),

  marketCount: db.prepare('SELECT COUNT(*) AS c FROM market_listings'),
  marketPage: db.prepare('SELECT * FROM market_listings ORDER BY id DESC LIMIT ? OFFSET ?'),
  marketGet: db.prepare('SELECT * FROM market_listings WHERE id = ?'),
  marketBySeller: db.prepare('SELECT * FROM market_listings WHERE seller_id = ? ORDER BY id DESC'),
  marketInsert: db.prepare('INSERT INTO market_listings (seller_id, card_id, price, created_at) VALUES (?, ?, ?, ?)'),
  marketDelete: db.prepare('DELETE FROM market_listings WHERE id = ?'),

  insertTrade: db.prepare(
    `INSERT INTO trades (from_user, to_user, offer_card, request_card, offer_gold, request_gold, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getTrade: db.prepare('SELECT * FROM trades WHERE id = ?'),
  setTradeStatus: db.prepare('UPDATE trades SET status = ? WHERE id = ?'),
};

/* ── Ayar erişimi ─────────────────────────────────────────────────────────── */
const SETTING_COLUMNS = new Set([
  'log_channel', 'mod_log_channel', 'ticket_log_channel', 'welcome_channel', 'welcome_message', 'autorole',
  'ticket_category', 'support_role', 'max_tickets', 'warn_timeout_at', 'warn_timeout_minutes', 'warn_kick_at', 'warn_ban_at',
]);
const AUTOMOD_COLUMNS = new Set([
  'spam', 'spam_messages', 'spam_seconds', 'spam_timeout_minutes', 'invites', 'links', 'badwords', 'caps', 'caps_percent',
  'mentions', 'mention_limit', 'raid', 'raid_joins', 'raid_seconds', 'min_account_days',
]);

function getSettings(guildId) {
  let row = S.getSettings.get(guildId);
  if (!row) {
    S.insertSettings.run(guildId);
    row = S.getSettings.get(guildId);
  }
  return row;
}
function setSetting(guildId, column, value) {
  if (!SETTING_COLUMNS.has(column)) throw new Error(`Geçersiz ayar sütunu: ${column}`);
  getSettings(guildId);
  db.prepare(`UPDATE guild_settings SET ${column} = ? WHERE guild_id = ?`).run(value, guildId);
}
function getAutomod(guildId) {
  let row = S.getAutomod.get(guildId);
  if (!row) {
    S.insertAutomod.run(guildId);
    row = S.getAutomod.get(guildId);
  }
  return row;
}
function setAutomod(guildId, column, value) {
  if (!AUTOMOD_COLUMNS.has(column)) throw new Error(`Geçersiz automod sütunu: ${column}`);
  getAutomod(guildId);
  db.prepare(`UPDATE automod_settings SET ${column} = ? WHERE guild_id = ?`).run(value, guildId);
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3. ORTAK SERVİSLER
 * ════════════════════════════════════════════════════════════════════════════ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // (Privileged) Server Members Intent
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent, // (Privileged) Message Content Intent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
  allowedMentions: { parse: [], repliedUser: false }, // yanlışlıkla ping atmayı engeller
});

/** Komut kayıt defteri */
const commands = new Map();
function register(def) {
  if (def.perm) def.data.setDefaultMemberPermissions(def.perm);
  commands.set(def.data.name, def);
}

/** Karşılama modülü (modules/welcome.js): GIF'li rastgele karşılama + /welcome */
const welcome = require('./modules/welcome')({ db, getSettings, setSetting, embed, COLOR, EPHEMERAL, fail, succeed });
for (const def of welcome.commands) register(def);

/** ChronoxVoice modülü (modules/chronoxvoice.js): "kanala gir, odanı oluştur" + /chronoxvoice + /voice */
const chronoxvoice = require('./modules/chronoxvoice')({ client, db, embed, COLOR, EPHEMERAL, fail, succeed, truncate });
for (const def of chronoxvoice.commands) register(def);

/** Kullanıcıya DM atar, başarılı olup olmadığını döndürür */
async function dmUser(user, payload) {
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

/** Log kanalına gönderir. kind: 'general' | 'mod' | 'ticket' */
async function sendLog(guild, kind, embedObj, files) {
  try {
    const s = getSettings(guild.id);
    const id =
      kind === 'mod' ? s.mod_log_channel || s.log_channel
      : kind === 'ticket' ? s.ticket_log_channel || s.log_channel
      : s.log_channel;
    if (!id) return null;
    const ch = guild.channels.cache.get(id);
    if (!ch || !ch.isTextBased()) return null;
    return await ch.send({ embeds: [embedObj], files, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[sendLog]', err.message);
    return null;
  }
}
function isLogChannel(guildId, channelId) {
  const s = getSettings(guildId);
  return [s.log_channel, s.mod_log_channel, s.ticket_log_channel].includes(channelId);
}

/* ── Ceza türleri ─────────────────────────────────────────────────────────── */
const ACTIONS = {
  warn: { emoji: '⚠️', label: 'Uyarı', color: COLOR.warn },
  mute: { emoji: '🔇', label: 'Susturma', color: COLOR.warn },
  unmute: { emoji: '🔊', label: 'Susturma Kaldırıldı', color: COLOR.ok },
  kick: { emoji: '👢', label: 'Atılma', color: 0xe67e22 },
  ban: { emoji: '🔨', label: 'Yasaklama', color: COLOR.error },
  unban: { emoji: '🔓', label: 'Yasak Kaldırıldı', color: COLOR.ok },
};

const createCase = db.transaction((guildId, userId, modId, action, reason, durationMs) => {
  const n = S.nextCase.get(guildId).n;
  S.insertCase.run(guildId, n, userId, modId, action, reason ?? null, durationMs ?? null, Date.now());
  return n;
});

/** Vakayı DB'ye yazar + mod log kanalına gönderir. Vaka numarasını döndürür. */
async function recordCase(guild, { action, target, moderator, reason, durationMs }) {
  const caseNo = createCase(guild.id, target.id, moderator.id, action, reason, durationMs);
  const meta = ACTIONS[action];
  const e = embed(meta.color, `${meta.emoji} ${meta.label} • Vaka #${caseNo}`)
    .addFields(
      { name: 'Kullanıcı', value: `${target} (\`${target.id}\`)`, inline: true },
      { name: 'Yetkili', value: `${moderator} (\`${moderator.id}\`)`, inline: true }
    )
    .setTimestamp();
  if (durationMs) e.addFields({ name: 'Süre', value: formatDuration(durationMs), inline: true });
  e.addFields({ name: 'Sebep', value: truncate(reason || 'Belirtilmedi', 1000) });
  await sendLog(guild, 'mod', e);
  return caseNo;
}

/** Kullanıcıya gidecek DM embed'i */
function punishDm(guild, { action, reason, durationMs, caseNo }) {
  const meta = ACTIONS[action];
  const e = embed(meta.color, `${meta.emoji} ${guild.name} • ${meta.label}`)
    .addFields({ name: 'Sebep', value: truncate(reason || 'Belirtilmedi', 1000) })
    .setTimestamp();
  if (durationMs) e.addFields({ name: 'Süre', value: formatDuration(durationMs) });
  if (caseNo) e.setFooter({ text: `Vaka #${caseNo}` });
  return e;
}

function addWarning(guildId, userId, modId, reason) {
  S.insertWarning.run(guildId, userId, modId, reason, Date.now());
  return S.countWarnings.get(guildId, userId).c;
}

/**
 * Uyarı sayısına göre otomatik ceza kademesi.
 * Ayarlanan eşiğe TAM ulaşıldığında uygulanır. Uygulanan cezanın açıklamasını döndürür.
 */
async function applyEscalation(guild, member, count) {
  const s = getSettings(guild.id);
  const me = client.user;
  const reason = `Otomatik ceza: ${count} uyarıya ulaştı`;
  try {
    if (s.warn_ban_at && count === s.warn_ban_at && member.bannable) {
      await dmUser(member.user, punishDm(guild, { action: 'ban', reason }));
      await member.ban({ reason });
      await recordCase(guild, { action: 'ban', target: member.user, moderator: me, reason });
      return `🔨 ${count} uyarıya ulaştığı için **otomatik banlandı**.`;
    }
    if (s.warn_kick_at && count === s.warn_kick_at && member.kickable) {
      await dmUser(member.user, punishDm(guild, { action: 'kick', reason }));
      await member.kick(reason);
      await recordCase(guild, { action: 'kick', target: member.user, moderator: me, reason });
      return `👢 ${count} uyarıya ulaştığı için **otomatik atıldı**.`;
    }
    if (s.warn_timeout_at && count === s.warn_timeout_at && member.moderatable) {
      const ms = Math.min(s.warn_timeout_minutes * 6e4, MAX_TIMEOUT_MS);
      await member.timeout(ms, reason);
      const caseNo = await recordCase(guild, { action: 'mute', target: member.user, moderator: me, reason, durationMs: ms });
      await dmUser(member.user, punishDm(guild, { action: 'mute', reason, durationMs: ms, caseNo }));
      return `🔇 ${count} uyarıya ulaştığı için **${formatDuration(ms)}** susturuldu.`;
    }
  } catch (err) {
    console.error('[escalation]', err.message);
  }
  return null;
}

/** Yetki hiyerarşisi kontrolü — hata varsa metin, yoksa null döner */
function hierarchyError(i, target) {
  const { guild, member: mod } = i;
  if (target.id === mod.id) return 'Bu işlemi kendine uygulayamazsın.';
  if (target.id === client.user.id) return 'Bu işlemi bana uygulayamazsın.';
  if (target.id === guild.ownerId) return 'Sunucu sahibine bu işlem uygulanamaz.';
  if (mod.id !== guild.ownerId && target.roles.highest.position >= mod.roles.highest.position) {
    return 'Bu kullanıcının rolü seninkinden yüksek veya eşit olduğu için işlem yapamazsın.';
  }
  return null;
}

/** Audit log'dan son olayın yürütücüsünü bulur (en iyi çaba) */
async function findAudit(guild, type, targetId) {
  try {
    await sleep(1200);
    const logs = await guild.fetchAuditLogs({ type, limit: 6 });
    return logs.entries.find((e) => e.target?.id === targetId && Date.now() - e.createdTimestamp < 15_000) ?? null;
  } catch {
    return null;
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. MODERASYON KOMUTLARI
 * ════════════════════════════════════════════════════════════════════════════ */
const NO_REASON = 'Sebep belirtilmedi';
const reasonOpt = (o, required = false) =>
  o.setName('reason').setDescription('Sebep').setRequired(required).setMaxLength(500);

/* /warn */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Kullanıcıyı uyarır (DM ile bildirilir)')
    .addUserOption((o) => o.setName('user').setDescription('Uyarılacak kullanıcı').setRequired(true))
    .addStringOption((o) => reasonOpt(o, true)),
  async execute(i) {
    const member = i.options.getMember('user');
    const reason = i.options.getString('reason', true);
    if (!member) return fail(i, 'Bu kullanıcı sunucuda bulunamadı.');
    if (member.user.bot) return fail(i, 'Botlar uyarılamaz.');
    const he = hierarchyError(i, member);
    if (he) return fail(i, he);

    const count = addWarning(i.guildId, member.id, i.user.id, reason);
    const caseNo = await recordCase(i.guild, { action: 'warn', target: member.user, moderator: i.user, reason });
    const dmOk = await dmUser(member.user, punishDm(i.guild, { action: 'warn', reason, caseNo }).addFields({ name: 'Toplam uyarı', value: String(count) }));
    const esc = await applyEscalation(i.guild, member, count);

    const e = embed(COLOR.warn, `⚠️ Uyarı verildi • Vaka #${caseNo}`)
      .setDescription(`${member} uyarıldı. **Toplam uyarı:** ${count}`)
      .addFields({ name: 'Sebep', value: truncate(reason) })
      .setFooter({ text: dmOk ? 'Kullanıcıya DM gönderildi.' : 'Kullanıcının DM\'i kapalı, bildirim gönderilemedi.' });
    if (esc) e.addFields({ name: 'Otomatik ceza', value: esc });
    return i.reply({ embeds: [e] });
  },
});

/* /warnings */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Kullanıcının uyarılarını listeler')
    .addUserOption((o) => o.setName('user').setDescription('Kullanıcı').setRequired(true)),
  async execute(i) {
    const user = i.options.getUser('user', true);
    const rows = S.listWarnings.all(i.guildId, user.id);
    const total = S.countWarnings.get(i.guildId, user.id).c;
    if (!rows.length) return i.reply({ ...okBody(`${user} için kayıtlı uyarı yok.`), flags: EPHEMERAL });
    const lines = rows.map((w) => `**#${w.id}** • ${dt(w.created_at, 'd')} • <@${w.moderator_id}>\n└ ${truncate(w.reason, 150)}`);
    return i.reply({
      embeds: [embed(COLOR.warn, `⚠️ ${user.username} — Uyarılar (${total})`, truncate(lines.join('\n'), 4000)).setFooter({ text: 'Son 15 uyarı gösterilir • /unwarn ile silebilirsin' })],
      flags: EPHEMERAL,
    });
  },
});

/* /unwarn */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Belirli bir uyarıyı ID ile siler')
    .addIntegerOption((o) => o.setName('id').setDescription('Uyarı ID (/warnings içinde görünür)').setRequired(true).setMinValue(1)),
  async execute(i) {
    const id = i.options.getInteger('id', true);
    const w = S.getWarning.get(id, i.guildId);
    if (!w) return fail(i, 'Bu ID ile bir uyarı bulunamadı.');
    S.delWarning.run(id, i.guildId);
    await sendLog(i.guild, 'mod', embed(COLOR.ok, '🧹 Uyarı silindi').addFields(
      { name: 'Kullanıcı', value: `<@${w.user_id}>`, inline: true },
      { name: 'Yetkili', value: `${i.user}`, inline: true },
      { name: 'Silinen uyarı', value: truncate(w.reason, 500) }
    ).setTimestamp());
    return succeed(i, `Uyarı **#${id}** silindi.`);
  },
});

/* /clearwarnings */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('clearwarnings')
    .setDescription('Kullanıcının tüm uyarılarını temizler')
    .addUserOption((o) => o.setName('user').setDescription('Kullanıcı').setRequired(true)),
  async execute(i) {
    const user = i.options.getUser('user', true);
    const info = S.clearWarnings.run(i.guildId, user.id);
    await sendLog(i.guild, 'mod', embed(COLOR.ok, '🧹 Uyarılar temizlendi').addFields(
      { name: 'Kullanıcı', value: `${user}`, inline: true },
      { name: 'Yetkili', value: `${i.user}`, inline: true },
      { name: 'Silinen adet', value: String(info.changes), inline: true }
    ).setTimestamp());
    return succeed(i, `${user} kullanıcısının **${info.changes}** uyarısı silindi.`);
  },
});

/* /history */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('Kullanıcının moderasyon geçmişini (vakalarını) gösterir')
    .addUserOption((o) => o.setName('user').setDescription('Kullanıcı').setRequired(true)),
  async execute(i) {
    const user = i.options.getUser('user', true);
    const rows = S.listCases.all(i.guildId, user.id);
    if (!rows.length) return i.reply({ ...okBody(`${user} için moderasyon kaydı yok.`), flags: EPHEMERAL });
    const lines = rows.map((c) => {
      const m = ACTIONS[c.action] ?? { emoji: '•', label: c.action };
      const dur = c.duration_ms ? ` (${formatDuration(c.duration_ms)})` : '';
      return `**#${c.case_no}** ${m.emoji} ${m.label}${dur} • ${dt(c.created_at, 'd')}\n└ ${truncate(c.reason || NO_REASON, 120)}`;
    });
    return i.reply({
      embeds: [embed(COLOR.mod, `📚 ${user.username} — Moderasyon geçmişi`, truncate(lines.join('\n'), 4000)).setFooter({ text: 'Son 15 vaka' })],
      flags: EPHEMERAL,
    });
  },
});

/* /kick */
register({
  perm: P.KickMembers,
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kullanıcıyı sunucudan atar (DM ile bildirilir)')
    .addUserOption((o) => o.setName('user').setDescription('Atılacak kullanıcı').setRequired(true))
    .addStringOption((o) => reasonOpt(o, true)),
  async execute(i) {
    const member = i.options.getMember('user');
    const reason = i.options.getString('reason', true);
    if (!member) return fail(i, 'Bu kullanıcı sunucuda bulunamadı.');
    const he = hierarchyError(i, member);
    if (he) return fail(i, he);
    if (!member.kickable) return fail(i, 'Botun rolü bu kullanıcıyı atmaya yetmiyor (rol sırasını kontrol et).');

    const dmOk = await dmUser(member.user, punishDm(i.guild, { action: 'kick', reason }));
    await member.kick(`${i.user.username}: ${truncate(reason, 400)}`);
    const caseNo = await recordCase(i.guild, { action: 'kick', target: member.user, moderator: i.user, reason });
    return i.reply({
      embeds: [embed(ACTIONS.kick.color, `👢 Kullanıcı atıldı • Vaka #${caseNo}`, `${member.user} (\`${member.id}\`) sunucudan atıldı.`)
        .addFields({ name: 'Sebep', value: truncate(reason) })
        .setFooter({ text: dmOk ? 'Kullanıcıya DM gönderildi.' : 'DM gönderilemedi.' })],
    });
  },
});

/* /ban */
register({
  perm: P.BanMembers,
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Kullanıcıyı yasaklar (kalıcı veya süreli, DM ile bildirilir)')
    .addUserOption((o) => o.setName('user').setDescription('Yasaklanacak kullanıcı').setRequired(true))
    .addStringOption((o) => reasonOpt(o, true))
    .addStringOption((o) => o.setName('duration').setDescription('Süreli ban için süre (örn: 1d, 12h, 7d). Boş = kalıcı'))
    .addIntegerOption((o) =>
      o.setName('delete_days').setDescription('Kaç günlük mesajları silinsin? (0-7)').setMinValue(0).setMaxValue(7)
    ),
  async execute(i) {
    const user = i.options.getUser('user', true);
    const member = i.options.getMember('user');
    const reason = i.options.getString('reason', true);
    const days = i.options.getInteger('delete_days') ?? 0;
    const durStr = i.options.getString('duration');
    const durationMs = durStr ? parseDuration(durStr) : null;
    if (durStr && !durationMs) return fail(i, 'Geçersiz süre. Örnek: `30m`, `12h`, `7d`.');

    if (member) {
      const he = hierarchyError(i, member);
      if (he) return fail(i, he);
      if (!member.bannable) return fail(i, 'Botun rolü bu kullanıcıyı banlamaya yetmiyor (rol sırasını kontrol et).');
    } else if (user.id === i.user.id || user.id === client.user.id) {
      return fail(i, 'Bu işlemi bu kullanıcıya uygulayamazsın.');
    }

    const dmOk = await dmUser(user, punishDm(i.guild, { action: 'ban', reason, durationMs }));
    await i.guild.members.ban(user, { reason: `${i.user.username}: ${truncate(reason, 400)}`, deleteMessageSeconds: days * 86400 });
    S.delTempBanUser.run(i.guildId, user.id);
    if (durationMs) S.addTempBan.run(i.guildId, user.id, Date.now() + durationMs);
    const caseNo = await recordCase(i.guild, { action: 'ban', target: user, moderator: i.user, reason, durationMs });

    const e = embed(ACTIONS.ban.color, `🔨 Kullanıcı yasaklandı • Vaka #${caseNo}`, `${user} (\`${user.id}\`) yasaklandı.`)
      .addFields({ name: 'Sebep', value: truncate(reason) })
      .setFooter({ text: dmOk ? 'Kullanıcıya DM gönderildi.' : 'DM gönderilemedi.' });
    if (durationMs) e.addFields({ name: 'Süre', value: formatDuration(durationMs) });
    return i.reply({ embeds: [e] });
  },
});

/* /unban */
register({
  perm: P.BanMembers,
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Kullanıcının yasağını kaldırır')
    .addStringOption((o) => o.setName('user_id').setDescription('Kullanıcı ID').setRequired(true))
    .addStringOption((o) => reasonOpt(o, true)),
  async execute(i) {
    const id = i.options.getString('user_id', true).trim();
    const reason = i.options.getString('reason', true);
    if (!/^\d{16,20}$/.test(id)) return fail(i, 'Geçerli bir kullanıcı ID\'si gir.');
    let user;
    try {
      user = await i.guild.members.unban(id, `${i.user.username}: ${truncate(reason, 400)}`);
    } catch {
      return fail(i, 'Bu kullanıcı yasaklı değil veya ID hatalı.');
    }
    S.delTempBanUser.run(i.guildId, id);
    const caseNo = await recordCase(i.guild, { action: 'unban', target: user, moderator: i.user, reason });
    return succeed(i, `**${user.username}** (\`${id}\`) kullanıcısının yasağı kaldırıldı. • Vaka #${caseNo}`);
  },
});

/* /timeout (Discord Timeout) */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Kullanıcıya timeout verir (sebep zorunlu, DM ile bildirilir)')
    .addUserOption((o) => o.setName('user').setDescription('Susturulacak kullanıcı').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('Süre (örn: 10m, 2h, 1d, 30dk). En fazla 28 gün').setRequired(true))
    .addStringOption((o) => reasonOpt(o, true)),
  async execute(i) {
    const member = i.options.getMember('user');
    const reason = i.options.getString('reason', true);
    const ms = parseDuration(i.options.getString('duration', true));
    if (!member) return fail(i, 'Bu kullanıcı sunucuda bulunamadı.');
    if (!ms) return fail(i, 'Geçersiz süre. Örnek: `10m`, `2h`, `1d`.');
    if (ms > MAX_TIMEOUT_MS) return fail(i, 'Discord en fazla **28 gün** susturmaya izin verir.');
    const he = hierarchyError(i, member);
    if (he) return fail(i, he);
    if (!member.moderatable) return fail(i, 'Botun rolü bu kullanıcıyı susturmaya yetmiyor.');

    const dmOk = await dmUser(member.user, punishDm(i.guild, { action: 'mute', reason, durationMs: ms }));
    await member.timeout(ms, `${i.user.username}: ${truncate(reason, 400)}`);
    const caseNo = await recordCase(i.guild, { action: 'mute', target: member.user, moderator: i.user, reason, durationMs: ms });
    return i.reply({
      embeds: [embed(ACTIONS.mute.color, `🔇 Kullanıcı susturuldu • Vaka #${caseNo}`, `${member} **${formatDuration(ms)}** boyunca susturuldu.`)
        .addFields({ name: 'Sebep', value: truncate(reason) })
        .setFooter({ text: dmOk ? 'Kullanıcıya DM gönderildi.' : 'DM gönderilemedi.' })],
    });
  },
});

/* /untimeout */
register({
  perm: P.ModerateMembers,
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Kullanıcının timeout\'unu kaldırır (sebep zorunlu, DM ile bildirilir)')
    .addUserOption((o) => o.setName('user').setDescription('Kullanıcı').setRequired(true))
    .addStringOption((o) => reasonOpt(o, true)),
  async execute(i) {
    const member = i.options.getMember('user');
    const reason = i.options.getString('reason', true);
    if (!member) return fail(i, 'Bu kullanıcı sunucuda bulunamadı.');
    if (!member.isCommunicationDisabled()) return fail(i, 'Bu kullanıcı zaten susturulmuş değil.');
    if (!member.moderatable) return fail(i, 'Botun rolü bu kullanıcı için yetersiz.');
    await member.timeout(null, `${i.user.username}: ${truncate(reason, 400)}`);
    const caseNo = await recordCase(i.guild, { action: 'unmute', target: member.user, moderator: i.user, reason });
    await dmUser(member.user, punishDm(i.guild, { action: 'unmute', reason, caseNo }));
    return succeed(i, `${member} kullanıcısının susturması kaldırıldı. • Vaka #${caseNo}`);
  },
});

/* /purge */
register({
  perm: P.ManageMessages,
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Kanaldaki mesajları toplu siler')
    .addIntegerOption((o) => o.setName('amount').setDescription('Silinecek mesaj sayısı (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Sadece bu kullanıcının mesajlarını sil')),
  async execute(i) {
    await i.deferReply({ flags: EPHEMERAL });
    const amount = i.options.getInteger('amount', true);
    const user = i.options.getUser('user');
    let msgs = await i.channel.messages.fetch({ limit: 100 });
    if (user) msgs = msgs.filter((m) => m.author.id === user.id);
    const list = [...msgs.values()].slice(0, amount);
    const deleted = await i.channel.bulkDelete(list, true); // 14 günden eski mesajlar atlanır
    await sendLog(i.guild, 'mod', embed(COLOR.mod, '🧹 Toplu mesaj silindi').addFields(
      { name: 'Kanal', value: `${i.channel}`, inline: true },
      { name: 'Yetkili', value: `${i.user}`, inline: true },
      { name: 'Silinen', value: String(deleted.size), inline: true },
      ...(user ? [{ name: 'Hedef', value: `${user}`, inline: true }] : [])
    ).setTimestamp());
    return succeed(i, `**${deleted.size}** mesaj silindi.`);
  },
});

/* /slowmode */
register({
  perm: P.ManageChannels,
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Kanalın yavaş mod süresini ayarlar')
    .addIntegerOption((o) => o.setName('seconds').setDescription('Saniye (0 = kapat, en fazla 21600)').setRequired(true).setMinValue(0).setMaxValue(21600)),
  async execute(i) {
    const s = i.options.getInteger('seconds', true);
    await i.channel.setRateLimitPerUser(s, `Yetkili: ${i.user.username}`);
    return succeed(i, s === 0 ? 'Yavaş mod kapatıldı.' : `Yavaş mod **${s} saniye** olarak ayarlandı.`);
  },
});

/* /lock & /unlock */
register({
  perm: P.ManageChannels,
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Kanalı @everyone için mesaj yazmaya kapatır')
    .addStringOption((o) => reasonOpt(o)),
  async execute(i) {
    const reason = i.options.getString('reason') ?? NO_REASON;
    await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false }, { reason: `Kilit: ${i.user.username}` });
    await sendLog(i.guild, 'mod', embed(COLOR.warn, '🔒 Kanal kilitlendi').addFields(
      { name: 'Kanal', value: `${i.channel}`, inline: true }, { name: 'Yetkili', value: `${i.user}`, inline: true }, { name: 'Sebep', value: truncate(reason) }
    ).setTimestamp());
    return i.reply({ embeds: [embed(COLOR.warn, '🔒 Kanal kilitlendi', `Sebep: ${truncate(reason, 500)}`)] });
  },
});
register({
  perm: P.ManageChannels,
  data: new SlashCommandBuilder().setName('unlock').setDescription('Kanalın kilidini açar'),
  async execute(i) {
    await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null }, { reason: `Kilit açıldı: ${i.user.username}` });
    await sendLog(i.guild, 'mod', embed(COLOR.ok, '🔓 Kanal kilidi açıldı').addFields(
      { name: 'Kanal', value: `${i.channel}`, inline: true }, { name: 'Yetkili', value: `${i.user}`, inline: true }
    ).setTimestamp());
    return i.reply({ embeds: [embed(COLOR.ok, '🔓 Kanal kilidi açıldı')] });
  },
});

/* Süreli banları kaldıran zamanlayıcı */
async function processTempBans() {
  for (const t of S.dueTempBans.all(Date.now())) {
    S.delTempBan.run(t.id);
    const guild = client.guilds.cache.get(t.guild_id);
    if (!guild) continue;
    try {
      const user = await guild.members.unban(t.user_id, 'Süreli ban sona erdi');
      await recordCase(guild, { action: 'unban', target: user, moderator: client.user, reason: 'Süreli ban sona erdi' });
    } catch {
      /* zaten kaldırılmış olabilir */
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. TICKET SİSTEMİ
 * ════════════════════════════════════════════════════════════════════════════ */
const TICKET_TYPES = {
  support: { label: 'Genel Destek', emoji: '🛠️', slug: 'destek', style: ButtonStyle.Primary },
  report: { label: 'Şikayet / Bildirim', emoji: '🚨', slug: 'sikayet', style: ButtonStyle.Danger },
  other: { label: 'Öneri / Diğer', emoji: '💡', slug: 'diger', style: ButtonStyle.Secondary },
};
const PRIORITIES = {
  low: { label: '🟢 Düşük', color: 0x57f287 },
  normal: { label: '🔵 Normal', color: COLOR.ticket },
  high: { label: '🟠 Yüksek', color: 0xe67e22 },
  urgent: { label: '🔴 Acil', color: COLOR.error },
};
const TICKET_MEMBER_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const TICKET_BOT_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.ManageChannels, P.ManageMessages];

function isStaff(member, settings) {
  if (!member) return false;
  if (member.permissions.has(P.Administrator) || member.permissions.has(P.ManageChannels)) return true;
  return !!settings.support_role && member.roles.cache.has(settings.support_role);
}

const nextTicketNo = db.transaction((guildId) => {
  getSettings(guildId);
  S.bumpTicketCounter.run(guildId);
  return S.getTicketCounter.get(guildId).ticket_counter;
});

function ticketEmbed(t) {
  const type = TICKET_TYPES[t.category] ?? TICKET_TYPES.other;
  const pri = PRIORITIES[t.priority] ?? PRIORITIES.normal;
  return new EmbedBuilder()
    .setColor(t.status === 'open' ? pri.color : COLOR.dark)
    .setTitle(`${type.emoji} Ticket #${pad(t.ticket_no)} — ${truncate(t.subject, 200)}`)
    .setDescription(truncate(t.description, 3500))
    .addFields(
      { name: 'Açan', value: `<@${t.user_id}>`, inline: true },
      { name: 'Kategori', value: type.label, inline: true },
      { name: 'Öncelik', value: pri.label, inline: true },
      { name: 'Üstlenen', value: t.claimed_by ? `<@${t.claimed_by}>` : 'Henüz üstlenilmedi', inline: true },
      { name: 'Durum', value: t.status === 'open' ? '🟢 Açık' : '🔴 Kapalı', inline: true },
      { name: 'Oluşturulma', value: dt(t.created_at, 'R'), inline: true }
    )
    .setFooter({ text: 'Komutlar: /add • /remove • /ticket close • /ticket claim • /ticket priority • /ticket rename' });
}
const ticketControls = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk:claim').setLabel('Üstlen').setEmoji('🙋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tk:transcript').setLabel('Transkript').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tk:close').setLabel('Kapat').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );

async function refreshTicketMessage(channel, ticketId) {
  try {
    const t = S.getTicketById.get(ticketId);
    if (!t?.message_id) return;
    const msg = await channel.messages.fetch(t.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [ticketEmbed(t)] });
  } catch {
    /* önemli değil */
  }
}

/** Kanal mesajlarını düz metin transkripte çevirir */
async function buildTranscript(channel, ticket) {
  const all = [];
  let before;
  while (all.length < 5000) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse(); // eskiden yeniye
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `TICKET #${pad(ticket.ticket_no)} — ${ticket.subject}`,
    `Sunucu ID : ${ticket.guild_id}`,
    `Açan      : ${ticket.user_id}`,
    `Kategori  : ${(TICKET_TYPES[ticket.category] ?? TICKET_TYPES.other).label}`,
    `Oluşturma : ${stamp(ticket.created_at)} UTC`,
    `Mesaj sayısı: ${all.length}`,
    '='.repeat(70),
  ];
  for (const m of all) {
    lines.push(`[${stamp(m.createdTimestamp)}] ${m.author?.username ?? 'Bilinmiyor'} (${m.author?.id ?? '?'}): ${m.content || ''}`);
    for (const a of m.attachments.values()) lines.push(`    📎 ${a.name}: ${a.url}`);
    for (const em of m.embeds) {
      const bits = [em.title, em.description].filter(Boolean).join(' — ');
      if (bits) lines.push(`    [embed] ${truncate(bits, 300)}`);
    }
  }
  return { buffer: Buffer.from(lines.join('\n'), 'utf8'), name: `transcript-${pad(ticket.ticket_no)}.txt` };
}

/** Ticket oluşturur (modal gönderildikten sonra) */
async function createTicket(i, type) {
  await i.deferReply({ flags: EPHEMERAL });
  const guild = i.guild;
  const s = getSettings(guild.id);
  if (!s.support_role) return fail(i, 'Ticket sistemi henüz kurulmamış.');
  if (S.getBlacklist.get(guild.id, i.user.id)) return fail(i, 'Ticket açman yetkililer tarafından engellenmiş.');
  if (S.countOpenByUser.get(guild.id, i.user.id).c >= s.max_tickets) {
    return fail(i, `Aynı anda en fazla **${s.max_tickets}** açık ticketın olabilir.`);
  }
  const subject = i.fields.getTextInputValue('subject').trim();
  const description = i.fields.getTextInputValue('description').trim();
  const meta = TICKET_TYPES[type];
  const num = nextTicketNo(guild.id);
  const parent = s.ticket_category && guild.channels.cache.get(s.ticket_category) ? s.ticket_category : undefined;

  const channel = await guild.channels.create({
    name: `${meta.slug}-${pad(num)}`,
    type: ChannelType.GuildText,
    parent,
    topic: `Ticket #${pad(num)} • Sahip: ${i.user.username} (${i.user.id}) • ${meta.label}`,
    permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: i.user.id, allow: TICKET_MEMBER_PERMS },
      { id: s.support_role, allow: [...TICKET_MEMBER_PERMS, P.ManageMessages] },
      { id: client.user.id, allow: TICKET_BOT_PERMS },
    ],
    reason: `Ticket #${pad(num)} — ${i.user.username}`,
  });

  const info = S.insertTicket.run({
    guild_id: guild.id,
    ticket_no: num,
    channel_id: channel.id,
    user_id: i.user.id,
    category: type,
    subject,
    description,
    created_at: Date.now(),
  });
  const ticketId = Number(info.lastInsertRowid);
  const ticket = S.getTicketById.get(ticketId);

  const msg = await channel.send({
    content: `<@${i.user.id}> <@&${s.support_role}>`,
    embeds: [ticketEmbed(ticket)],
    components: [ticketControls()],
    allowedMentions: { users: [i.user.id], roles: [s.support_role] },
  });
  S.setTicketMessage.run(msg.id, ticketId);
  msg.pin().catch(() => {});
  await channel.send({
    embeds: [embed(COLOR.info, null, '👋 Talebin alındı! Yetkililer en kısa sürede seninle ilgilenecek.\nEk bilgi veya dosyalarını bu kanala yazabilirsin.')],
  });

  await sendLog(guild, 'ticket', embed(COLOR.ok, `🎫 Yeni ticket • #${pad(num)}`).addFields(
    { name: 'Açan', value: `${i.user} (\`${i.user.id}\`)`, inline: true },
    { name: 'Kategori', value: meta.label, inline: true },
    { name: 'Kanal', value: `${channel}`, inline: true },
    { name: 'Konu', value: truncate(subject, 250) }
  ).setTimestamp());

  return succeed(i, `Ticketın oluşturuldu: ${channel}`, true);
}

/** Ticketı kapatır: transkript → log → DM (+ puanlama) → kanalı sil */
async function closeTicket({ channel, guild, ticket, closer, reason }) {
  S.closeTicket.run({ id: ticket.id, reason, closed_by: closer.id, closed_at: Date.now() });
  const fresh = S.getTicketById.get(ticket.id);
  await channel.send({
    embeds: [embed(COLOR.error, '🔒 Ticket kapatılıyor', `**Kapatan:** ${closer}\n**Sebep:** ${truncate(reason, 500)}\n\nTranskript hazırlanıyor, kanal birkaç saniye içinde silinecek.`)],
  }).catch(() => {});

  let transcript = null;
  try {
    transcript = await buildTranscript(channel, fresh);
  } catch (err) {
    console.error('[transcript]', err.message);
  }
  const file = () => (transcript ? [new AttachmentBuilder(transcript.buffer, { name: transcript.name })] : undefined);

  await sendLog(guild, 'ticket', embed(COLOR.error, `🔒 Ticket kapatıldı • #${pad(ticket.ticket_no)}`).addFields(
    { name: 'Açan', value: `<@${ticket.user_id}>`, inline: true },
    { name: 'Kapatan', value: `${closer}`, inline: true },
    { name: 'Üstlenen', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : '—', inline: true },
    { name: 'Konu', value: truncate(ticket.subject, 250) },
    { name: 'Kapatma sebebi', value: truncate(reason, 500) }
  ).setTimestamp(), file());

  const owner = await client.users.fetch(ticket.user_id).catch(() => null);
  if (owner) {
    const rate = new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`tk:rate:${ticket.id}:${n}`).setLabel(`${n} ⭐`).setStyle(ButtonStyle.Secondary))
    );
    await dmUser(owner, {
      embeds: [embed(COLOR.ticket, `🎫 ${guild.name} • Ticketın kapatıldı`, `**Ticket:** #${pad(ticket.ticket_no)} — ${truncate(ticket.subject, 100)}\n**Kapatma sebebi:** ${truncate(reason, 500)}\n\nDestek deneyimini aşağıdan puanlayabilirsin.`).setTimestamp()],
      files: file(),
      components: [rate],
    });
  }
  setTimeout(() => channel.delete(`Ticket #${pad(ticket.ticket_no)} kapatıldı`).catch(() => {}), 5000);
}

/** Geçerli kanal açık bir ticket mı? */
function currentTicket(i) {
  const t = S.getTicketByChannel.get(i.channelId);
  return t && t.status === 'open' ? t : null;
}
const NOT_TICKET = 'Bu komut sadece açık bir ticket kanalında kullanılabilir.';
const STAFF_ONLY = 'Bu işlem için ticket yetkilisi olmalısın.';

/* ── Ticket işlemleri (hem buton hem komut kullanır) ──────────────────────── */
async function ticketClaim(i, ticket) {
  const s = getSettings(i.guildId);
  if (!isStaff(i.member, s)) return fail(i, STAFF_ONLY);
  if (ticket.claimed_by && ticket.claimed_by !== i.user.id) return fail(i, `Bu ticket zaten <@${ticket.claimed_by}> tarafından üstlenilmiş.`);
  if (ticket.claimed_by === i.user.id) return fail(i, 'Bu ticketı zaten sen üstlendin.');
  S.setTicketClaim.run(i.user.id, ticket.id);
  await refreshTicketMessage(i.channel, ticket.id);
  await sendLog(i.guild, 'ticket', embed(COLOR.info, `🙋 Ticket üstlenildi • #${pad(ticket.ticket_no)}`).addFields(
    { name: 'Yetkili', value: `${i.user}`, inline: true }, { name: 'Kanal', value: `${i.channel}`, inline: true }
  ).setTimestamp());
  return i.reply({ embeds: [embed(COLOR.ok, null, `🙋 Bu ticket artık ${i.user} tarafından ilgilenilecek.`)] });
}

async function ticketTranscript(i, ticket) {
  const s = getSettings(i.guildId);
  if (!isStaff(i.member, s)) return fail(i, STAFF_ONLY);
  await i.deferReply({ flags: EPHEMERAL });
  const tr = await buildTranscript(i.channel, ticket);
  return i.editReply({ content: '📝 Transkript hazır:', files: [new AttachmentBuilder(tr.buffer, { name: tr.name })] });
}

async function ticketAddRemove(i, add) {
  const t = currentTicket(i);
  if (!t) return fail(i, NOT_TICKET);
  const s = getSettings(i.guildId);
  if (!isStaff(i.member, s) && i.user.id !== t.user_id) return fail(i, 'Sadece ticket sahibi veya yetkililer kullanıcı ekleyip çıkarabilir.');
  const user = i.options.getUser('user', true);
  if (user.bot) return fail(i, 'Botlar ticketa eklenemez/çıkarılamaz.');
  if (add) {
    await i.channel.permissionOverwrites.edit(user, Object.fromEntries(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks'].map((k) => [k, true])));
    return i.reply({ embeds: [embed(COLOR.ok, null, `➕ ${user} ticketa eklendi. (Ekleyen: ${i.user})`)], allowedMentions: { users: [user.id] } });
  }
  if (user.id === t.user_id) return fail(i, 'Ticket sahibi tickettan çıkarılamaz.');
  if (user.id === i.user.id) return fail(i, 'Kendini çıkaramazsın.');
  await i.channel.permissionOverwrites.delete(user);
  return i.reply({ embeds: [embed(COLOR.warn, null, `➖ ${user} tickettan çıkarıldı. (Çıkaran: ${i.user})`)] });
}

/* /add & /remove */
register({
  data: new SlashCommandBuilder()
    .setName('add')
    .setDescription('Ticketa bir kullanıcı ekler')
    .addUserOption((o) => o.setName('user').setDescription('Eklenecek kullanıcı').setRequired(true)),
  execute: (i) => ticketAddRemove(i, true),
});
register({
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Tickettan bir kullanıcıyı çıkarır')
    .addUserOption((o) => o.setName('user').setDescription('Çıkarılacak kullanıcı').setRequired(true)),
  execute: (i) => ticketAddRemove(i, false),
});

/* /ticket-setup */
register({
  perm: P.ManageGuild,
  data: new SlashCommandBuilder()
    .setName('ticket-setup')
    .setDescription('Butonlu ticket panelini kurar')
    .addChannelOption((o) => o.setName('channel').setDescription('Panelin gönderileceği kanal').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addRoleOption((o) => o.setName('support_role').setDescription('Ticketları görecek yetkili rolü').setRequired(true))
    .addChannelOption((o) => o.setName('category').setDescription('Ticketların açılacağı kategori (boşsa otomatik oluşturulur)').addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption((o) => o.setName('log_channel').setDescription('Ticket log kanalı (transkriptler buraya gider)').addChannelTypes(ChannelType.GuildText))
    .addIntegerOption((o) => o.setName('max_tickets').setDescription('Kullanıcı başına açık ticket limiti (varsayılan 1)').setMinValue(1).setMaxValue(10)),
  async execute(i) {
    await i.deferReply({ flags: EPHEMERAL });
    const panelChannel = i.options.getChannel('channel', true);
    const role = i.options.getRole('support_role', true);
    let category = i.options.getChannel('category');
    const logChannel = i.options.getChannel('log_channel');
    const max = i.options.getInteger('max_tickets') ?? 1;

    if (!category) {
      category = await i.guild.channels.create({
        name: '🎫 Destek Talepleri',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: i.guild.id, deny: [P.ViewChannel] },
          { id: role.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
          { id: client.user.id, allow: TICKET_BOT_PERMS },
        ],
      });
    }
    setSetting(i.guildId, 'support_role', role.id);
    setSetting(i.guildId, 'ticket_category', category.id);
    setSetting(i.guildId, 'max_tickets', max);
    if (logChannel) setSetting(i.guildId, 'ticket_log_channel', logChannel.id);

    const panel = embed(COLOR.ticket, '🎫 Destek Merkezi', 'Bir sorunun, şikayetin veya önerin mi var?\nAşağıdaki butonlardan uygun kategoriyi seç; sadece **sen ve yetkililer** görebilecek özel bir kanal açılacak.')
      .addFields(
        { name: '🛠️ Genel Destek', value: 'Sorun yaşıyorsan veya yardım istiyorsan.', inline: true },
        { name: '🚨 Şikayet / Bildirim', value: 'Bir kullanıcıyı veya durumu bildir.', inline: true },
        { name: '💡 Öneri / Diğer', value: 'Fikirlerin ve diğer konular için.', inline: true }
      )
      .setFooter({ text: `Kullanıcı başına en fazla ${max} açık ticket • ${i.guild.name}` });
    const row = new ActionRowBuilder().addComponents(
      Object.entries(TICKET_TYPES).map(([key, t]) => new ButtonBuilder().setCustomId(`tk:open:${key}`).setLabel(t.label).setEmoji(t.emoji).setStyle(t.style))
    );
    await panelChannel.send({ embeds: [panel], components: [row] });
    return succeed(i, `Ticket paneli ${panelChannel} kanalına gönderildi.\nKategori: **${category.name}** • Yetkili rol: ${role}${logChannel ? ` • Log: ${logChannel}` : ''}`);
  },
});

/* /ticket ... */
register({
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket yönetim komutları')
    .addSubcommand((s) => s.setName('close').setDescription('Bu ticketı kapatır').addStringOption((o) => reasonOpt(o)))
    .addSubcommand((s) => s.setName('claim').setDescription('Bu ticketı üstlenir'))
    .addSubcommand((s) => s.setName('unclaim').setDescription('Ticket üstlenmesini bırakır'))
    .addSubcommand((s) =>
      s.setName('priority').setDescription('Ticket önceliğini ayarlar').addStringOption((o) =>
        o.setName('level').setDescription('Öncelik').setRequired(true).addChoices(
          ...Object.entries(PRIORITIES).map(([value, p]) => ({ name: p.label.replace(/^\S+\s/, ''), value }))
        )
      )
    )
    .addSubcommand((s) => s.setName('rename').setDescription('Ticket kanalının adını değiştirir').addStringOption((o) => o.setName('name').setDescription('Yeni ad').setRequired(true).setMaxLength(60)))
    .addSubcommand((s) => s.setName('transfer').setDescription('Ticketı başka bir yetkiliye devreder').addUserOption((o) => o.setName('staff').setDescription('Devredilecek yetkili').setRequired(true)))
    .addSubcommand((s) => s.setName('transcript').setDescription('Ticket transkriptini dosya olarak verir'))
    .addSubcommand((s) => s.setName('info').setDescription('Ticket bilgilerini gösterir'))
    .addSubcommand((s) => s.setName('list').setDescription('Sunucudaki açık ticketları listeler (yetkili)'))
    .addSubcommand((s) => s.setName('ban').setDescription('Kullanıcının ticket açmasını engeller (yetkili)').addUserOption((o) => o.setName('user').setDescription('Kullanıcı').setRequired(true)).addStringOption((o) => reasonOpt(o, true)))
    .addSubcommand((s) => s.setName('unban').setDescription('Kullanıcının ticket engelini kaldırır (yetkili)').addUserOption((o) => o.setName('user').setDescription('Kullanıcı').setRequired(true))),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const s = getSettings(i.guildId);
    const staff = isStaff(i.member, s);

    // Kanaldan bağımsız çalışanlar
    if (sub === 'list') {
      if (!staff) return fail(i, STAFF_ONLY);
      const rows = S.listOpenTickets.all(i.guildId);
      if (!rows.length) return i.reply({ ...okBody('Açık ticket yok.'), flags: EPHEMERAL });
      const lines = rows.map((t) => `<#${t.channel_id}> • **#${pad(t.ticket_no)}** • <@${t.user_id}> • ${(PRIORITIES[t.priority] ?? PRIORITIES.normal).label}${t.claimed_by ? ` • 🙋 <@${t.claimed_by}>` : ''}`);
      return i.reply({ embeds: [embed(COLOR.ticket, `🎫 Açık ticketlar (${rows.length})`, truncate(lines.join('\n'), 4000))], flags: EPHEMERAL });
    }
    if (sub === 'ban' || sub === 'unban') {
      if (!staff) return fail(i, STAFF_ONLY);
      const user = i.options.getUser('user', true);
      if (sub === 'ban') {
        const reason = i.options.getString('reason', true);
        S.addBlacklist.run(i.guildId, user.id, reason);
        const dmOk = await dmUser(user, embed(COLOR.warn, `🎫 ${i.guild.name} • Ticket engeli`).addFields({ name: 'Sebep', value: truncate(reason, 1000) }).setTimestamp());
        return succeed(i, `${user} artık ticket açamaz. ${dmOk ? '(Kullanıcıya DM gönderildi.)' : '(DM gönderilemedi.)'}`);
      }
      S.delBlacklist.run(i.guildId, user.id);
      return succeed(i, `${user} kullanıcısının ticket engeli kaldırıldı.`);
    }

    // Ticket kanalı gerektirenler
    const t = currentTicket(i);
    if (!t) return fail(i, NOT_TICKET);
    const isOwner = i.user.id === t.user_id;

    switch (sub) {
      case 'close': {
        if (!staff && !isOwner) return fail(i, 'Sadece ticket sahibi veya yetkililer ticketı kapatabilir.');
        await i.deferReply({ flags: EPHEMERAL });
        await closeTicket({ channel: i.channel, guild: i.guild, ticket: t, closer: i.user, reason: i.options.getString('reason') ?? NO_REASON });
        return succeed(i, 'Ticket kapatılıyor...');
      }
      case 'claim':
        return ticketClaim(i, t);
      case 'unclaim': {
        if (!staff) return fail(i, STAFF_ONLY);
        if (!t.claimed_by) return fail(i, 'Bu ticket üstlenilmemiş.');
        if (t.claimed_by !== i.user.id && !i.member.permissions.has(P.Administrator)) return fail(i, 'Sadece üstlenen yetkili veya yönetici bırakabilir.');
        S.setTicketClaim.run(null, t.id);
        await refreshTicketMessage(i.channel, t.id);
        return i.reply({ embeds: [embed(COLOR.warn, null, `↩️ ${i.user} ticket üstlenmesini bıraktı.`)] });
      }
      case 'priority': {
        if (!staff) return fail(i, STAFF_ONLY);
        const level = i.options.getString('level', true);
        S.setTicketPriority.run(level, t.id);
        await refreshTicketMessage(i.channel, t.id);
        return i.reply({ embeds: [embed(PRIORITIES[level].color, null, `📌 Ticket önceliği **${PRIORITIES[level].label}** olarak ayarlandı. (${i.user})`)] });
      }
      case 'rename': {
        if (!staff) return fail(i, STAFF_ONLY);
        const name = i.options.getString('name', true).toLowerCase().replace(/[^a-z0-9ğüşıöç\s-]/gi, '').trim().replace(/\s+/g, '-').slice(0, 90);
        if (!name) return fail(i, 'Geçerli bir ad gir.');
        await i.deferReply();
        await i.channel.setName(name, `Ticket yeniden adlandırıldı: ${i.user.username}`);
        return i.editReply(okBody(`Kanal adı **${name}** olarak değiştirildi.`));
      }
      case 'transfer': {
        if (!staff) return fail(i, STAFF_ONLY);
        const target = i.options.getMember('staff');
        if (!target || !isStaff(target, s)) return fail(i, 'Seçilen kullanıcı ticket yetkilisi değil.');
        S.setTicketClaim.run(target.id, t.id);
        await refreshTicketMessage(i.channel, t.id);
        return i.reply({ embeds: [embed(COLOR.info, null, `🔁 Ticket ${i.user} tarafından ${target} yetkilisine devredildi.`)], allowedMentions: { users: [target.id] } });
      }
      case 'transcript':
        return ticketTranscript(i, t);
      case 'info':
        return i.reply({ embeds: [ticketEmbed(t)], flags: EPHEMERAL });
      default:
        return fail(i, 'Bilinmeyen alt komut.');
    }
  },
});

/* ── Ticket butonları / modalları ─────────────────────────────────────────── */
async function ticketOpenButton(i, type) {
  if (!i.inGuild() || !TICKET_TYPES[type]) return;
  const s = getSettings(i.guildId);
  if (!s.support_role) return fail(i, 'Ticket sistemi henüz kurulmamış.');
  if (S.getBlacklist.get(i.guildId, i.user.id)) return fail(i, 'Ticket açman yetkililer tarafından engellenmiş.');
  if (S.countOpenByUser.get(i.guildId, i.user.id).c >= s.max_tickets) {
    return fail(i, `Aynı anda en fazla **${s.max_tickets}** açık ticketın olabilir.`);
  }
  const modal = new ModalBuilder()
    .setCustomId(`tk:modal:${type}`)
    .setTitle(truncate(TICKET_TYPES[type].label, 40))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('subject').setLabel('Konu').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(80).setPlaceholder('Kısaca konunu yaz')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Açıklama').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(10).setMaxLength(1000).setPlaceholder('Sorununu / talebini detaylıca anlat')
      )
    );
  return i.showModal(modal);
}

async function ticketCloseButton(i) {
  const t = currentTicket(i);
  if (!t) return fail(i, NOT_TICKET);
  if (!isStaff(i.member, getSettings(i.guildId)) && i.user.id !== t.user_id) return fail(i, 'Sadece ticket sahibi veya yetkililer ticketı kapatabilir.');
  const modal = new ModalBuilder()
    .setCustomId('tk:closemodal')
    .setTitle('Ticketı Kapat')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Kapatma sebebi (isteğe bağlı)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
      )
    );
  return i.showModal(modal);
}

async function ticketCloseModal(i) {
  const t = currentTicket(i);
  if (!t) return fail(i, NOT_TICKET);
  const reason = i.fields.getTextInputValue('reason')?.trim() || NO_REASON;
  await i.deferReply({ flags: EPHEMERAL });
  await closeTicket({ channel: i.channel, guild: i.guild, ticket: t, closer: i.user, reason });
  return succeed(i, 'Ticket kapatılıyor...');
}

async function ticketRate(i, ticketId, stars) {
  const t = S.getTicketById.get(ticketId);
  if (!t || t.user_id !== i.user.id || !(stars >= 1 && stars <= 5)) return i.reply({ ...errBody('Bu değerlendirme geçersiz.'), flags: EPHEMERAL });
  if (t.rating) return i.update({ components: [] });
  S.setTicketRating.run(stars, ticketId);
  await i.update({ components: [], content: `⭐ Değerlendirmen için teşekkürler! Verdiğin puan: **${stars}/5**` });
  const guild = client.guilds.cache.get(t.guild_id);
  if (guild) {
    await sendLog(guild, 'ticket', embed(COLOR.gold, `⭐ Ticket değerlendirmesi • #${pad(t.ticket_no)}`).addFields(
      { name: 'Kullanıcı', value: `<@${t.user_id}>`, inline: true },
      { name: 'Puan', value: `${'⭐'.repeat(stars)} (${stars}/5)`, inline: true },
      { name: 'Üstlenen', value: t.claimed_by ? `<@${t.claimed_by}>` : '—', inline: true }
    ).setTimestamp());
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 6. AYARLAR (/config) VE AUTOMOD (/automod)
 * ════════════════════════════════════════════════════════════════════════════ */
register({
  perm: P.ManageGuild,
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Sunucu ayarları (log, karşılama, otorol, uyarı cezaları)')
    .addSubcommand((s) =>
      s.setName('log').setDescription('Log kanalını ayarlar (kanal vermezsen kapatılır)')
        .addStringOption((o) => o.setName('type').setDescription('Log türü').setRequired(true).addChoices(
          { name: 'Genel (mesaj, üye, kanal, rol, ses)', value: 'log_channel' },
          { name: 'Moderasyon (ban, kick, mute, warn)', value: 'mod_log_channel' },
          { name: 'Ticket', value: 'ticket_log_channel' }
        ))
        .addChannelOption((o) => o.setName('channel').setDescription('Log kanalı').addChannelTypes(ChannelType.GuildText))
    )
    .addSubcommand((s) =>
      s.setName('welcome').setDescription('Karşılama kanalı/özel metin (GIF’li: /welcome channel). Kanal vermezsen kapatılır')
        .addChannelOption((o) => o.setName('channel').setDescription('Karşılama kanalı').addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('message').setDescription('Mesaj. Değişkenler: {user} {username} {server} {count}').setMaxLength(500))
    )
    .addSubcommand((s) => s.setName('autorole').setDescription('Yeni üyelere verilecek rolü ayarlar (rol vermezsen kapatılır)').addRoleOption((o) => o.setName('role').setDescription('Otomatik rol')))
    .addSubcommand((s) =>
      s.setName('warn-punish').setDescription('Uyarı sayısına göre otomatik cezaları ayarlar (0 = kapalı)')
        .addIntegerOption((o) => o.setName('timeout_at').setDescription('Kaç uyarıda susturulsun? (varsayılan 3)').setMinValue(0).setMaxValue(50))
        .addIntegerOption((o) => o.setName('timeout_minutes').setDescription('Susturma süresi (dakika, varsayılan 60)').setMinValue(1).setMaxValue(40320))
        .addIntegerOption((o) => o.setName('kick_at').setDescription('Kaç uyarıda atılsın? (varsayılan 5)').setMinValue(0).setMaxValue(50))
        .addIntegerOption((o) => o.setName('ban_at').setDescription('Kaç uyarıda banlansın? (varsayılan kapalı)').setMinValue(0).setMaxValue(50))
    )
    .addSubcommand((s) => s.setName('show').setDescription('Mevcut ayarları gösterir')),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const gid = i.guildId;
    if (sub === 'log') {
      const type = i.options.getString('type', true);
      const ch = i.options.getChannel('channel');
      setSetting(gid, type, ch?.id ?? null);
      return succeed(i, ch ? `Log kanalı ${ch} olarak ayarlandı.` : 'Bu log türü kapatıldı.');
    }
    if (sub === 'welcome') {
      const ch = i.options.getChannel('channel');
      const msg = i.options.getString('message');
      setSetting(gid, 'welcome_channel', ch?.id ?? null);
      if (msg) setSetting(gid, 'welcome_message', msg);
      return succeed(i, ch ? `Karşılama kanalı ${ch} olarak ayarlandı.` : 'Karşılama mesajı kapatıldı.');
    }
    if (sub === 'autorole') {
      const role = i.options.getRole('role');
      if (role && (role.managed || role.id === i.guild.id)) return fail(i, 'Bu rol otomatik rol olarak verilemez.');
      if (role && role.position >= i.guild.members.me.roles.highest.position) return fail(i, 'Bu rol botun rolünden yüksek, veremem. Bot rolünü yukarı taşı.');
      setSetting(gid, 'autorole', role?.id ?? null);
      return succeed(i, role ? `Otomatik rol: ${role}` : 'Otomatik rol kapatıldı.');
    }
    if (sub === 'warn-punish') {
      const map = { timeout_at: 'warn_timeout_at', timeout_minutes: 'warn_timeout_minutes', kick_at: 'warn_kick_at', ban_at: 'warn_ban_at' };
      let changed = 0;
      for (const [opt, col] of Object.entries(map)) {
        const v = i.options.getInteger(opt);
        if (v !== null) {
          setSetting(gid, col, v);
          changed++;
        }
      }
      if (!changed) return fail(i, 'En az bir değer girmelisin.');
    }
    // 'show' ve warn-punish sonrası özet
    const s = getSettings(gid);
    const ch = (id) => (id ? `<#${id}>` : '`Kapalı`');
    const off = (n) => (n ? `**${n}** uyarıda` : '`Kapalı`');
    return i.reply({
      embeds: [embed(COLOR.info, '⚙️ Sunucu Ayarları').addFields(
        { name: '📜 Genel log', value: ch(s.log_channel), inline: true },
        { name: '🔨 Mod log', value: ch(s.mod_log_channel), inline: true },
        { name: '🎫 Ticket log', value: ch(s.ticket_log_channel), inline: true },
        { name: '👋 Karşılama', value: ch(s.welcome_channel), inline: true },
        { name: '🏷️ Otomatik rol', value: s.autorole ? `<@&${s.autorole}>` : '`Kapalı`', inline: true },
        { name: '🎫 Ticket yetkili rolü', value: s.support_role ? `<@&${s.support_role}>` : '`Kurulmamış`', inline: true },
        { name: '⚠️ Uyarı → Susturma', value: `${off(s.warn_timeout_at)} (${s.warn_timeout_minutes} dk)`, inline: true },
        { name: '⚠️ Uyarı → Atma', value: off(s.warn_kick_at), inline: true },
        { name: '⚠️ Uyarı → Ban', value: off(s.warn_ban_at), inline: true }
      )],
      flags: EPHEMERAL,
    });
  },
});

/* ── AutoMod ──────────────────────────────────────────────────────────────── */
const AUTOMOD_RULES = {
  spam: 'Spam koruması',
  invites: 'Discord davet linki engeli',
  links: 'Link engeli',
  badwords: 'Yasaklı kelime filtresi',
  caps: 'Büyük harf (CAPS) filtresi',
  mentions: 'Toplu etiket (mention) engeli',
};
register({
  perm: P.ManageGuild,
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Otomatik moderasyon ayarları')
    .addSubcommand((s) => s.setName('status').setDescription('AutoMod durumunu gösterir'))
    .addSubcommand((s) =>
      s.setName('toggle').setDescription('Bir kuralı açar/kapatır')
        .addStringOption((o) => o.setName('rule').setDescription('Kural').setRequired(true).addChoices(...Object.entries(AUTOMOD_RULES).map(([value, name]) => ({ name, value }))))
        .addBooleanOption((o) => o.setName('enabled').setDescription('Açık mı?').setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName('limits').setDescription('Kural eşiklerini ayarlar')
        .addIntegerOption((o) => o.setName('spam_messages').setDescription('Spam: kaç mesaj?').setMinValue(2).setMaxValue(30))
        .addIntegerOption((o) => o.setName('spam_seconds').setDescription('Spam: kaç saniye içinde?').setMinValue(2).setMaxValue(60))
        .addIntegerOption((o) => o.setName('spam_timeout_minutes').setDescription('Spam: susturma süresi (dk, 0 = susturma yok)').setMinValue(0).setMaxValue(1440))
        .addIntegerOption((o) => o.setName('caps_percent').setDescription('CAPS: büyük harf yüzdesi eşiği').setMinValue(30).setMaxValue(100))
        .addIntegerOption((o) => o.setName('mention_limit').setDescription('Tek mesajdaki maksimum etiket').setMinValue(2).setMaxValue(30))
    )
    .addSubcommand((s) => s.setName('word-add').setDescription('Yasaklı kelime ekler').addStringOption((o) => o.setName('word').setDescription('Kelime / ifade').setRequired(true).setMaxLength(60)))
    .addSubcommand((s) => s.setName('word-remove').setDescription('Yasaklı kelimeyi siler').addStringOption((o) => o.setName('word').setDescription('Kelime / ifade').setRequired(true).setMaxLength(60)))
    .addSubcommand((s) => s.setName('word-list').setDescription('Yasaklı kelimeleri listeler'))
    .addSubcommand((s) => s.setName('domain-allow').setDescription('Link engelinde izin verilen alan adı ekler').addStringOption((o) => o.setName('domain').setDescription('örn: youtube.com').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName('domain-remove').setDescription('İzinli alan adını siler').addStringOption((o) => o.setName('domain').setDescription('örn: youtube.com').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) =>
      s.setName('ignore-add').setDescription('AutoMod\'dan muaf kanal/rol ekler')
        .addChannelOption((o) => o.setName('channel').setDescription('Muaf kanal veya kategori'))
        .addRoleOption((o) => o.setName('role').setDescription('Muaf rol'))
    )
    .addSubcommand((s) =>
      s.setName('ignore-remove').setDescription('Muaf kanal/rolü kaldırır')
        .addChannelOption((o) => o.setName('channel').setDescription('Kanal veya kategori'))
        .addRoleOption((o) => o.setName('role').setDescription('Rol'))
    )
    .addSubcommand((s) =>
      s.setName('raid').setDescription('Raid koruması ayarları')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Raid koruması açık mı?').setRequired(true))
        .addIntegerOption((o) => o.setName('joins').setDescription('Kaç katılımda alarm? (varsayılan 8)').setMinValue(3).setMaxValue(50))
        .addIntegerOption((o) => o.setName('seconds').setDescription('Kaç saniye içinde? (varsayılan 10)').setMinValue(3).setMaxValue(120))
        .addIntegerOption((o) => o.setName('min_account_days').setDescription('Minimum hesap yaşı (gün, 0 = kapalı)').setMinValue(0).setMaxValue(365))
    )
    .addSubcommand((s) => s.setName('raid-reset').setDescription('Aktif raid kilidini manuel kaldırır')),
  async execute(i) {
    const sub = i.options.getSubcommand();
    const gid = i.guildId;

    if (sub === 'toggle') {
      const rule = i.options.getString('rule', true);
      const on = i.options.getBoolean('enabled', true);
      setAutomod(gid, rule, on ? 1 : 0);
      return succeed(i, `**${AUTOMOD_RULES[rule]}** ${on ? 'açıldı' : 'kapatıldı'}.`);
    }
    if (sub === 'limits') {
      let changed = 0;
      for (const col of ['spam_messages', 'spam_seconds', 'spam_timeout_minutes', 'caps_percent', 'mention_limit']) {
        const v = i.options.getInteger(col);
        if (v !== null) {
          setAutomod(gid, col, v);
          changed++;
        }
      }
      if (!changed) return fail(i, 'En az bir değer girmelisin.');
      return succeed(i, 'Eşikler güncellendi. `/automod status` ile kontrol edebilirsin.');
    }
    if (sub === 'word-add' || sub === 'word-remove') {
      const word = lower(i.options.getString('word', true).trim());
      if (sub === 'word-add') S.listAdd.run(gid, 'badword', word);
      else S.listDel.run(gid, 'badword', word);
      return succeed(i, `\`${word}\` ${sub === 'word-add' ? 'yasaklı listesine eklendi' : 'listeden silindi'}.`, true);
    }
    if (sub === 'word-list') {
      const words = S.listGet.all(gid, 'badword').map((r) => r.value);
      return i.reply({ embeds: [embed(COLOR.info, '🚫 Yasaklı kelimeler', words.length ? truncate(words.map((w) => `\`${w}\``).join(', '), 4000) : 'Liste boş.')], flags: EPHEMERAL });
    }
    if (sub === 'domain-allow' || sub === 'domain-remove') {
      const domain = lower(i.options.getString('domain', true).trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]);
      if (!domain.includes('.')) return fail(i, 'Geçerli bir alan adı gir (örn: youtube.com).');
      if (sub === 'domain-allow') S.listAdd.run(gid, 'domain', domain);
      else S.listDel.run(gid, 'domain', domain);
      return succeed(i, `\`${domain}\` ${sub === 'domain-allow' ? 'izinli listeye eklendi' : 'listeden silindi'}.`, true);
    }
    if (sub === 'ignore-add' || sub === 'ignore-remove') {
      const targets = [i.options.getChannel('channel'), i.options.getRole('role')].filter(Boolean);
      if (!targets.length) return fail(i, 'Bir kanal veya rol seçmelisin.');
      for (const t of targets) {
        if (sub === 'ignore-add') S.listAdd.run(gid, 'ignore', t.id);
        else S.listDel.run(gid, 'ignore', t.id);
      }
      return succeed(i, `${targets.map((t) => `${t}`).join(', ')} ${sub === 'ignore-add' ? 'AutoMod\'dan muaf tutulacak' : 'artık muaf değil'}.`);
    }
    if (sub === 'raid') {
      setAutomod(gid, 'raid', i.options.getBoolean('enabled', true) ? 1 : 0);
      for (const [opt, col] of [['joins', 'raid_joins'], ['seconds', 'raid_seconds'], ['min_account_days', 'min_account_days']]) {
        const v = i.options.getInteger(opt);
        if (v !== null) setAutomod(gid, col, v);
      }
      return succeed(i, 'Raid koruması ayarları güncellendi. `/automod status` ile görebilirsin.');
    }
    if (sub === 'raid-reset') {
      lockdowns.delete(gid);
      joinLog.delete(gid);
      return succeed(i, 'Raid kilidi kaldırıldı.');
    }

    // status
    const a = getAutomod(gid);
    const on = (v) => (v ? '✅ Açık' : '❌ Kapalı');
    const ignores = S.listGet.all(gid, 'ignore').map((r) => r.value);
    const domains = S.listGet.all(gid, 'domain').map((r) => r.value);
    const wordCount = S.listGet.all(gid, 'badword').length;
    return i.reply({
      embeds: [embed(COLOR.info, '🛡️ AutoMod Durumu').addFields(
        { name: 'Spam koruması', value: `${on(a.spam)}\n${a.spam_messages} mesaj / ${a.spam_seconds} sn\nSusturma: ${a.spam_timeout_minutes ? a.spam_timeout_minutes + ' dk' : 'yok'}`, inline: true },
        { name: 'Davet engeli', value: on(a.invites), inline: true },
        { name: 'Link engeli', value: `${on(a.links)}\nİzinli alan: ${domains.length}`, inline: true },
        { name: 'Yasaklı kelime', value: `${on(a.badwords)}\nKelime sayısı: ${wordCount}`, inline: true },
        { name: 'CAPS filtresi', value: `${on(a.caps)}\nEşik: %${a.caps_percent}`, inline: true },
        { name: 'Toplu etiket', value: `${on(a.mentions)}\nLimit: ${a.mention_limit}`, inline: true },
        { name: '🚨 Raid koruması', value: `${on(a.raid)}\n${a.raid_joins} katılım / ${a.raid_seconds} sn\nMin. hesap yaşı: ${a.min_account_days ? a.min_account_days + ' gün' : 'kapalı'}`, inline: true },
        { name: 'Muaf kanal/rol', value: ignores.length ? truncate(ignores.map((id) => `<#${id}>`).join(' '), 900).replace(/<#(\d+)>/g, (m, id) => (i.guild.roles.cache.has(id) ? `<@&${id}>` : m)) : 'Yok', inline: false }
      ).setFooter({ text: 'Mesajlarda ManageMessages yetkisi olanlar AutoMod\'dan muaftır.' })],
      flags: EPHEMERAL,
    });
  },
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7. EKONOMİ • KART OYUNU • EĞLENCE
 * ════════════════════════════════════════════════════════════════════════════ */
const RARITY = {
  legendary: { label: 'Efsanevi', emoji: '🟡', color: 0xf1c40f, rate: 2, sell: 1000 },
  epic: { label: 'Destansı', emoji: '🟣', color: 0x9b59b6, rate: 8, sell: 250 },
  rare: { label: 'Nadir', emoji: '🔵', color: 0x3498db, rate: 30, sell: 75 },
  common: { label: 'Sıradan', emoji: '⚪', color: 0x95a5a6, rate: 60, sell: 25 },
};
const RARITY_ORDER = ['legendary', 'epic', 'rare', 'common'];
const PULL_COST = 100;
const PULL10_COST = 900;
const PITY_LIMIT = 50; // 50. çekilişte Efsanevi garantisi
const MARKET_TAX = 0.05;
const MARKET_MAX_LISTINGS = 10;
const TRADE_TTL = 5 * 60_000;

const CARDS = [
  // Sıradan
  { id: 'c01', name: 'Orman Okçusu', rarity: 'common', emoji: '🏹', desc: 'Ağaçların arasından tek atışta hedefi bulur.' },
  { id: 'c02', name: 'Köy Demircisi', rarity: 'common', emoji: '🔨', desc: 'Çekici kadar sağlam bir dostluk sunar.' },
  { id: 'c03', name: 'Gezgin Tüccar', rarity: 'common', emoji: '🎒', desc: 'Her şehirde bir sırrı, her çantada bir fırsatı var.' },
  { id: 'c04', name: 'Taş Golem Çırağı', rarity: 'common', emoji: '🗿', desc: 'Yavaş ama inatçı.' },
  { id: 'c05', name: 'Kurt Sürüsü', rarity: 'common', emoji: '🐺', desc: 'Ay doğunca hep birlikte uluyorlar.' },
  { id: 'c06', name: 'Gölge Hırsızı', rarity: 'common', emoji: '🗝️', desc: 'Kilit onun için sadece bir bilmece.' },
  { id: 'c07', name: 'Mantar Cücesi', rarity: 'common', emoji: '🍄', desc: 'Şapkası zehirli, kalbi altın.' },
  { id: 'c08', name: 'Nehir Balıkçısı', rarity: 'common', emoji: '🎣', desc: 'Sabır onun en büyük silahı.' },
  // Nadir
  { id: 'r01', name: 'Alev Büyücüsü', rarity: 'rare', emoji: '🔥', desc: 'Parmak uçlarında küçük bir güneş taşır.' },
  { id: 'r02', name: 'Gölge Suikastçı', rarity: 'rare', emoji: '🗡️', desc: 'Geldiğini kimse görmez, gittiğini kimse bilmez.' },
  { id: 'r03', name: 'Buz Şövalyesi', rarity: 'rare', emoji: '🧊', desc: 'Zırhı kış gibi soğuk, yemini kış gibi uzun.' },
  { id: 'r04', name: 'Orman Perisi', rarity: 'rare', emoji: '🧚', desc: 'Dokunduğu yerde çiçek açar.' },
  { id: 'r05', name: 'Fırtına Çağırıcı', rarity: 'rare', emoji: '⚡', desc: 'Bulutlar onun emriyle gürler.' },
  { id: 'r06', name: 'Demir Muhafız', rarity: 'rare', emoji: '🛡️', desc: 'Kapıdan geçmek isteyen önce ona sorar.' },
  // Destansı
  { id: 'e01', name: 'Kristal Ejderha Yavrusu', rarity: 'epic', emoji: '🐉', desc: 'Nefesi bile ışıl ışıl parlar.' },
  { id: 'e02', name: 'Kadim Ağaç Bekçisi', rarity: 'epic', emoji: '🌳', desc: 'Bin yıldır aynı yerde, bin yıldır uyanık.' },
  { id: 'e03', name: 'Kızıl Vampir Lordu', rarity: 'epic', emoji: '🧛', desc: 'Gece onun hükümdarlığıdır.' },
  { id: 'e04', name: 'Gökyüzü Mimarı', rarity: 'epic', emoji: '🏰', desc: 'Bulutların üstünde şehirler kurar.' },
  { id: 'e05', name: 'Rün Ustası', rarity: 'epic', emoji: '🔮', desc: 'Her sembol bir kader, her kader bir seçim.' },
  // Efsanevi
  { id: 'l01', name: 'Ejderha İmparatoru Vaelor', rarity: 'legendary', emoji: '👑', desc: 'Kanatlarının gölgesi krallıkları örter.' },
  { id: 'l02', name: 'Ebedi Anka Seraphine', rarity: 'legendary', emoji: '🦅', desc: 'Küllerinden her seferinde daha parlak doğar.' },
  { id: 'l03', name: 'Boşluk Kraliçesi Nyxara', rarity: 'legendary', emoji: '🌌', desc: 'Yıldızlar bile onun karanlığında yol bulur.' },
  { id: 'l04', name: 'Güneş Muhafızı Ahtareon', rarity: 'legendary', emoji: '☀️', desc: 'Şafağı getiren ilk ışığın bekçisi.' },
];
const CARD_MAP = new Map(CARDS.map((c) => [c.id, c]));
const CARDS_BY_RARITY = Object.fromEntries(RARITY_ORDER.map((r) => [r, CARDS.filter((c) => c.rarity === r)]));
const cardLine = (c) => `${RARITY[c.rarity].emoji} ${c.emoji} **${c.name}**`;
function findCard(input) {
  if (!input) return null;
  return CARD_MAP.get(input) ?? CARDS.find((c) => lower(c.name) === lower(input)) ?? null;
}

/* ── Veri yardımcıları ────────────────────────────────────────────────────── */
function ensureUser(id) {
  S.insertUser.run(id);
  return S.getUser.get(id);
}
const cardQty = (userId, cardId) => S.getCardRow.get(userId, cardId)?.quantity ?? 0;
function addCard(userId, cardId, qty = 1) {
  S.upsertCard.run(userId, cardId, qty, Date.now());
}
/** Karttan qty adet çıkarır; yeterli yoksa false */
function removeCard(userId, cardId, qty = 1) {
  const have = cardQty(userId, cardId);
  if (have < qty) return false;
  if (have === qty) S.delCardRow.run(userId, cardId);
  else S.setCardQty.run(have - qty, userId, cardId);
  return true;
}

function rollRarity(pity) {
  if (pity >= PITY_LIMIT - 1) return 'legendary'; // garanti
  let r = Math.random() * 100;
  for (const key of RARITY_ORDER) {
    r -= RARITY[key].rate;
    if (r < 0) return key;
  }
  return 'common';
}

const doGacha = db.transaction((userId, count) => {
  const cost = count === 10 ? PULL10_COST : PULL_COST * count;
  const user = ensureUser(userId);
  if (user.gold < cost) return { error: true, cost, gold: user.gold };
  let pity = user.pity_count;
  const results = [];
  const newlyOwned = new Set();
  for (let n = 0; n < count; n++) {
    const rarity = rollRarity(pity);
    const card = pick(CARDS_BY_RARITY[rarity]);
    pity = rarity === 'legendary' ? 0 : pity + 1;
    const isNew = cardQty(userId, card.id) === 0 && !newlyOwned.has(card.id);
    if (isNew) newlyOwned.add(card.id);
    addCard(userId, card.id);
    results.push({ card, isNew });
  }
  db.prepare('UPDATE users SET gold = gold - ?, pity_count = ?, total_pulls = total_pulls + ? WHERE user_id = ?').run(cost, pity, count, userId);
  return { results, cost, pity, gold: user.gold - cost };
});

const doDaily = db.transaction((userId) => {
  const u = ensureUser(userId);
  const nowMs = Date.now();
  const wait = 22 * 36e5 - (nowMs - u.last_daily);
  if (wait > 0) return { wait };
  const streak = nowMs - u.last_daily <= 48 * 36e5 && u.last_daily > 0 ? u.daily_streak + 1 : 1;
  const reward = 200 + Math.min(streak, 10) * 25;
  db.prepare('UPDATE users SET gold = gold + ?, last_daily = ?, daily_streak = ? WHERE user_id = ?').run(reward, nowMs, streak, userId);
  return { reward, streak, gold: u.gold + reward };
});

const doGive = db.transaction((from, to, amount) => {
  const a = ensureUser(from);
  ensureUser(to);
  if (a.gold < amount) return false;
  S.addGold.run(-amount, from);
  S.addGold.run(amount, to);
  return true;
});

const doSellDupes = db.transaction((userId) => {
  let total = 0;
  let sold = 0;
  for (const row of S.userCards.all(userId)) {
    const card = CARD_MAP.get(row.card_id);
    if (!card || row.quantity <= 1) continue;
    const extra = row.quantity - 1;
    S.setCardQty.run(1, userId, row.card_id);
    total += extra * RARITY[card.rarity].sell;
    sold += extra;
  }
  if (total > 0) {
    ensureUser(userId);
    S.addGold.run(total, userId);
  }
  return { total, sold };
});

const doMarketSell = db.transaction((userId, cardId, price) => {
  if (S.marketBySeller.all(userId).length >= MARKET_MAX_LISTINGS) return { error: `En fazla **${MARKET_MAX_LISTINGS}** aktif ilanın olabilir.` };
  if (!removeCard(userId, cardId, 1)) return { error: 'Bu karta sahip değilsin.' };
  const info = S.marketInsert.run(userId, cardId, price, Date.now());
  return { id: Number(info.lastInsertRowid) };
});
const doMarketBuy = db.transaction((buyerId, listingId) => {
  const l = S.marketGet.get(listingId);
  if (!l) return { error: 'Bu ilan bulunamadı (satılmış veya iptal edilmiş olabilir).' };
  if (l.seller_id === buyerId) return { error: 'Kendi ilanını satın alamazsın. İptal etmek için `/market cancel` kullan.' };
  const buyer = ensureUser(buyerId);
  if (buyer.gold < l.price) return { error: `Yetersiz altın. Gerekli: **${fmt(l.price)}**, Sende: **${fmt(buyer.gold)}**` };
  ensureUser(l.seller_id);
  const net = Math.floor(l.price * (1 - MARKET_TAX));
  S.addGold.run(-l.price, buyerId);
  S.addGold.run(net, l.seller_id);
  addCard(buyerId, l.card_id, 1);
  S.marketDelete.run(listingId);
  return { listing: l, net };
});
const doMarketCancel = db.transaction((userId, listingId) => {
  const l = S.marketGet.get(listingId);
  if (!l) return { error: 'İlan bulunamadı.' };
  if (l.seller_id !== userId) return { error: 'Bu ilan sana ait değil.' };
  S.marketDelete.run(listingId);
  addCard(userId, l.card_id, 1);
  return { listing: l };
});

const doTrade = db.transaction((tradeId) => {
  const t = S.getTrade.get(tradeId);
  if (!t || t.status !== 'pending') return { error: 'Bu takas artık geçerli değil.' };
  if (Date.now() - t.created_at > TRADE_TTL) {
    S.setTradeStatus.run('expired', tradeId);
    return { error: 'Takas teklifinin süresi doldu.' };
  }
  const a = ensureUser(t.from_user);
  const b = ensureUser(t.to_user);
  if (t.offer_card && cardQty(t.from_user, t.offer_card) < 1) return { error: 'Teklif eden artık bu karta sahip değil.' };
  if (a.gold < t.offer_gold) return { error: 'Teklif edenin altını yetersiz.' };
  if (t.request_card && cardQty(t.to_user, t.request_card) < 1) return { error: 'İstenen karta artık sahip değilsin.' };
  if (b.gold < t.request_gold) return { error: 'Altının yetersiz.' };
  if (t.offer_card) {
    removeCard(t.from_user, t.offer_card, 1);
    addCard(t.to_user, t.offer_card, 1);
  }
  if (t.request_card) {
    removeCard(t.to_user, t.request_card, 1);
    addCard(t.from_user, t.request_card, 1);
  }
  const delta = t.request_gold - t.offer_gold; // from_user kazanır (+) / kaybeder (-)
  if (delta !== 0) {
    S.addGold.run(delta, t.from_user);
    S.addGold.run(-delta, t.to_user);
  }
  S.setTradeStatus.run('completed', tradeId);
  return { ok: true, trade: t };
});

/* ── Kart autocomplete ────────────────────────────────────────────────────── */
function suggestCards(i, ownedOnly) {
  const q = lower(i.options.getFocused());
  let list;
  if (ownedOnly) {
    list = S.userCards.all(i.user.id).map((r) => ({ card: CARD_MAP.get(r.card_id), qty: r.quantity })).filter((x) => x.card);
  } else {
    list = CARDS.map((card) => ({ card, qty: 0 }));
  }
  const out = list
    .filter((x) => lower(x.card.name).includes(q))
    .slice(0, 25)
    .map((x) => ({
      name: truncate(`${x.card.emoji} ${x.card.name} • ${RARITY[x.card.rarity].label}${ownedOnly ? ` ×${x.qty}` : ''}`, 100),
      value: x.card.id,
    }));
  return i.respond(out);
}
const cardOption = (o, name, desc, required = true) => o.setName(name).setDescription(desc).setRequired(required).setAutocomplete(true);

/* /daily */
register({
  data: new SlashCommandBuilder().setName('daily').setDescription('Günlük altın ödülünü al (seri yaptıkça artar)'),
  async execute(i) {
    const r = doDaily(i.user.id);
    if (r.wait) {
      return i.reply({ ...errBody(`Günlük ödülünü zaten aldın. Tekrar: ${dt(Date.now() + r.wait, 'R')}`), flags: EPHEMERAL });
    }
    return i.reply({ embeds: [embed(COLOR.gold, '🎁 Günlük Ödül', `**+${fmt(r.reward)}** 🪙 kazandın!\n🔥 Seri: **${r.streak}** gün (en fazla +250 bonus)\n💰 Bakiye: **${fmt(r.gold)}** 🪙`)] });
  },
});

/* /balance */
register({
  data: new SlashCommandBuilder().setName('balance').setDescription('Altın ve koleksiyon durumunu gösterir').addUserOption((o) => o.setName('user').setDescription('Kullanıcı')),
  async execute(i) {
    const user = i.options.getUser('user') ?? i.user;
    if (user.bot) return fail(i, 'Botların hesabı yok.');
    const u = ensureUser(user.id);
    const rows = S.userCards.all(user.id);
    const total = rows.reduce((a, r) => a + r.quantity, 0);
    return i.reply({
      embeds: [embed(COLOR.gold, `💰 ${user.username} — Hesap`).setThumbnail(user.displayAvatarURL()).addFields(
        { name: 'Altın', value: `${fmt(u.gold)} 🪙`, inline: true },
        { name: 'Koleksiyon', value: `${rows.length}/${CARDS.length} benzersiz • ${total} kart`, inline: true },
        { name: 'Toplam çekiliş', value: fmt(u.total_pulls), inline: true },
        { name: 'Efsanevi garantisi', value: `${u.pity_count}/${PITY_LIMIT - 1} (sonraki ${PITY_LIMIT - u.pity_count}. çekilişte)`, inline: true },
        { name: 'Günlük seri', value: `${u.daily_streak} gün`, inline: true }
      )],
    });
  },
});

/* /gacha */
register({
  data: new SlashCommandBuilder()
    .setName('gacha')
    .setDescription(`Kart çek! Tek çekiliş ${PULL_COST} 🪙, 10'lu çekiliş ${PULL10_COST} 🪙`)
    .addIntegerOption((o) => o.setName('count').setDescription('Çekiliş sayısı').addChoices({ name: `1 çekiliş (${PULL_COST} 🪙)`, value: 1 }, { name: `10 çekiliş (${PULL10_COST} 🪙)`, value: 10 })),
  async execute(i) {
    const count = i.options.getInteger('count') ?? 1;
    const r = doGacha(i.user.id, count);
    if (r.error) return i.reply({ ...errBody(`Yetersiz altın! Gerekli: **${fmt(r.cost)}** 🪙 • Sende: **${fmt(r.gold)}** 🪙\n\`/daily\` ile altın toplayabilirsin.`), flags: EPHEMERAL });
    const best = r.results.reduce((a, x) => (RARITY_ORDER.indexOf(x.card.rarity) < RARITY_ORDER.indexOf(a.card.rarity) ? x : a));
    const lines = r.results.map(({ card, isNew }) => `${cardLine(card)} • ${RARITY[card.rarity].label}${isNew ? ' 🆕' : ''}`);
    const e = embed(RARITY[best.card.rarity].color, count === 1 ? '🎴 Kart Çekildi!' : '🎴 10\'lu Çekiliş Sonucu', lines.join('\n'))
      .setFooter({ text: `Bakiye: ${fmt(r.gold)} 🪙 • Efsanevi garantisine ${PITY_LIMIT - r.pity} çekiliş` });
    if (count === 1) e.addFields({ name: best.card.name, value: `*${best.card.desc}*` });
    return i.reply({ embeds: [e] });
  },
});

/* /cards */
register({
  data: new SlashCommandBuilder()
    .setName('cards')
    .setDescription('Kart koleksiyonu')
    .addSubcommand((s) => s.setName('list').setDescription('Koleksiyonunu gösterir').addUserOption((o) => o.setName('user').setDescription('Başka bir kullanıcı')))
    .addSubcommand((s) => s.setName('view').setDescription('Bir kartın detayını gösterir').addStringOption((o) => cardOption(o, 'card', 'Kart')))
    .addSubcommand((s) => s.setName('sell-dupes').setDescription('Her karttan 1 tane bırakıp fazlalıkları bota satar')),
  autocomplete: (i) => suggestCards(i, false),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const user = i.options.getUser('user') ?? i.user;
      const rows = S.userCards.all(user.id);
      if (!rows.length) return i.reply({ ...okBody(`${user.username} henüz hiç kart toplamamış. \`/gacha\` ile başla!`), flags: EPHEMERAL });
      const qty = new Map(rows.map((r) => [r.card_id, r.quantity]));
      const sections = [];
      for (const rar of RARITY_ORDER) {
        const owned = CARDS_BY_RARITY[rar].filter((c) => qty.has(c.id));
        sections.push(`**${RARITY[rar].emoji} ${RARITY[rar].label}** (${owned.length}/${CARDS_BY_RARITY[rar].length})\n${owned.length ? owned.map((c) => `${c.emoji} ${c.name}${qty.get(c.id) > 1 ? ` ×${qty.get(c.id)}` : ''}`).join(' • ') : '—'}`);
      }
      return i.reply({ embeds: [embed(COLOR.info, `🃏 ${user.username} — Koleksiyon (${rows.length}/${CARDS.length})`, truncate(sections.join('\n\n'), 4000))] });
    }
    if (sub === 'view') {
      const card = findCard(i.options.getString('card', true));
      if (!card) return fail(i, 'Böyle bir kart bulunamadı.');
      const owned = cardQty(i.user.id, card.id);
      return i.reply({
        embeds: [embed(RARITY[card.rarity].color, `${card.emoji} ${card.name}`, `*${card.desc}*`).addFields(
          { name: 'Nadirlik', value: `${RARITY[card.rarity].emoji} ${RARITY[card.rarity].label}`, inline: true },
          { name: 'Hızlı satış değeri', value: `${fmt(RARITY[card.rarity].sell)} 🪙`, inline: true },
          { name: 'Sende', value: owned ? `×${owned}` : 'Yok', inline: true }
        )],
      });
    }
    const r = doSellDupes(i.user.id);
    if (!r.sold) return fail(i, 'Satılacak fazla kartın yok.');
    return succeed(i, `**${r.sold}** fazla kart satıldı ve **${fmt(r.total)}** 🪙 kazandın!`);
  },
});

/* /market */
function listingLine(l) {
  const c = CARD_MAP.get(l.card_id);
  return `**#${l.id}** • ${c ? cardLine(c) : l.card_id} • 💰 **${fmt(l.price)}** 🪙 • <@${l.seller_id}>`;
}
register({
  data: new SlashCommandBuilder()
    .setName('market')
    .setDescription('Oyuncular arası kart pazarı')
    .addSubcommand((s) => s.setName('list').setDescription('Pazardaki ilanları gösterir').addIntegerOption((o) => o.setName('page').setDescription('Sayfa').setMinValue(1)))
    .addSubcommand((s) =>
      s.setName('sell').setDescription('Kartını pazara koyar')
        .addStringOption((o) => cardOption(o, 'card', 'Satılacak kart'))
        .addIntegerOption((o) => o.setName('price').setDescription('Fiyat (altın)').setRequired(true).setMinValue(1).setMaxValue(1_000_000))
    )
    .addSubcommand((s) => s.setName('buy').setDescription('Bir ilanı satın alır').addIntegerOption((o) => o.setName('id').setDescription('İlan ID').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Kendi ilanını iptal eder').addIntegerOption((o) => o.setName('id').setDescription('İlan ID').setRequired(true).setMinValue(1)))
    .addSubcommand((s) => s.setName('mine').setDescription('Kendi ilanlarını gösterir')),
  autocomplete: (i) => suggestCards(i, true),
  async execute(i) {
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const per = 10;
      const total = S.marketCount.get().c;
      const pages = Math.max(1, Math.ceil(total / per));
      const page = Math.min(i.options.getInteger('page') ?? 1, pages);
      const rows = S.marketPage.all(per, (page - 1) * per);
      return i.reply({
        embeds: [embed(COLOR.gold, '🏪 Kart Pazarı', rows.length ? rows.map(listingLine).join('\n') : 'Şu an hiç ilan yok. `/market sell` ile ilk ilanı sen ver!')
          .setFooter({ text: `Sayfa ${page}/${pages} • ${total} ilan • Satın almak için /market buy • Satıcıdan %${MARKET_TAX * 100} vergi kesilir` })],
      });
    }
    if (sub === 'sell') {
      const card = findCard(i.options.getString('card', true));
      if (!card) return fail(i, 'Böyle bir kart bulunamadı.');
      const r = doMarketSell(i.user.id, card.id, i.options.getInteger('price', true));
      if (r.error) return fail(i, r.error);
      return succeed(i, `${cardLine(card)} pazara **${fmt(i.options.getInteger('price', true))}** 🪙 fiyatla konuldu. (İlan **#${r.id}**)`);
    }
    if (sub === 'buy') {
      const r = doMarketBuy(i.user.id, i.options.getInteger('id', true));
      if (r.error) return fail(i, r.error);
      const c = CARD_MAP.get(r.listing.card_id);
      return i.reply({ embeds: [embed(COLOR.ok, '🛒 Satın alma başarılı', `${c ? cardLine(c) : r.listing.card_id} kartını **${fmt(r.listing.price)}** 🪙 karşılığında aldın.\nSatıcı <@${r.listing.seller_id}> vergi sonrası **${fmt(r.net)}** 🪙 kazandı.`)], allowedMentions: { users: [r.listing.seller_id] } });
    }
    if (sub === 'cancel') {
      const r = doMarketCancel(i.user.id, i.options.getInteger('id', true));
      if (r.error) return fail(i, r.error);
      return succeed(i, `İlan **#${r.listing.id}** iptal edildi, kart envanterine geri döndü.`);
    }
    const mine = S.marketBySeller.all(i.user.id);
    return i.reply({ embeds: [embed(COLOR.gold, '📦 İlanların', mine.length ? mine.map(listingLine).join('\n') : 'Aktif ilanın yok.')], flags: EPHEMERAL });
  },
});

/* /trade */
function tradeSideText(card, gold) {
  const parts = [];
  if (card) parts.push(cardLine(CARD_MAP.get(card)));
  if (gold) parts.push(`**${fmt(gold)}** 🪙`);
  return parts.join(' + ') || '—';
}
const tradeEmbed = (t, status) =>
  embed(status === 'completed' ? COLOR.ok : status === 'pending' ? COLOR.info : COLOR.error, '🤝 Takas Teklifi')
    .setDescription(`<@${t.from_user}> ➜ <@${t.to_user}>`)
    .addFields(
      { name: `📤 <@${t.from_user}> veriyor`, value: tradeSideText(t.offer_card, t.offer_gold), inline: true },
      { name: `📥 <@${t.to_user}> veriyor`, value: tradeSideText(t.request_card, t.request_gold), inline: true },
      { name: 'Durum', value: { pending: '⏳ Bekliyor (5 dk)', completed: '✅ Tamamlandı', declined: '❌ Reddedildi / iptal', expired: '⌛ Süresi doldu' }[status] ?? status }
    );
register({
  data: new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Başka bir oyuncuya kart/altın takas teklifi gönder')
    .addUserOption((o) => o.setName('user').setDescription('Takas yapılacak kullanıcı').setRequired(true))
    .addStringOption((o) => cardOption(o, 'give_card', 'Vereceğin kart', false))
    .addIntegerOption((o) => o.setName('give_gold').setDescription('Vereceğin altın').setMinValue(1).setMaxValue(1_000_000))
    .addStringOption((o) => cardOption(o, 'want_card', 'İstediğin kart', false))
    .addIntegerOption((o) => o.setName('want_gold').setDescription('İstediğin altın').setMinValue(1).setMaxValue(1_000_000)),
  async autocomplete(i) {
    return suggestCards(i, i.options.getFocused(true).name === 'give_card');
  },
  async execute(i) {
    const target = i.options.getUser('user', true);
    if (target.bot || target.id === i.user.id) return fail(i, 'Geçerli başka bir oyuncu seçmelisin.');
    const giveCard = i.options.getString('give_card') ? findCard(i.options.getString('give_card')) : null;
    const wantCard = i.options.getString('want_card') ? findCard(i.options.getString('want_card')) : null;
    if ((i.options.getString('give_card') && !giveCard) || (i.options.getString('want_card') && !wantCard)) return fail(i, 'Seçilen kart bulunamadı.');
    const giveGold = i.options.getInteger('give_gold') ?? 0;
    const wantGold = i.options.getInteger('want_gold') ?? 0;
    if (!giveCard && !giveGold && !wantCard && !wantGold) return fail(i, 'Takasta en az bir şey (kart veya altın) olmalı.');
    if (!giveCard && !giveGold) return fail(i, 'Hiçbir şey vermeden takas teklif edemezsin.');
    const me = ensureUser(i.user.id);
    if (giveCard && cardQty(i.user.id, giveCard.id) < 1) return fail(i, 'Vermek istediğin karta sahip değilsin.');
    if (me.gold < giveGold) return fail(i, 'Teklif ettiğin altın bakiyenden fazla.');

    const info = S.insertTrade.run(i.user.id, target.id, giveCard?.id ?? null, wantCard?.id ?? null, giveGold, wantGold, Date.now());
    const id = Number(info.lastInsertRowid);
    const t = S.getTrade.get(id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade:accept:${id}`).setLabel('Kabul Et').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`trade:decline:${id}`).setLabel('Reddet / İptal').setEmoji('✖️').setStyle(ButtonStyle.Danger)
    );
    await i.reply({ content: `<@${target.id}>, sana bir takas teklifi geldi!`, embeds: [tradeEmbed(t, 'pending')], components: [row], allowedMentions: { users: [target.id] } });
    setTimeout(async () => {
      const cur = S.getTrade.get(id);
      if (cur?.status === 'pending') {
        S.setTradeStatus.run('expired', id);
        await i.editReply({ content: '', embeds: [tradeEmbed(cur, 'expired')], components: [] }).catch(() => {});
      }
    }, TRADE_TTL + 1000);
  },
});

async function tradeButton(i, action, id) {
  const t = S.getTrade.get(id);
  if (!t || t.status !== 'pending') return i.update({ components: [] });
  if (action === 'decline') {
    if (![t.from_user, t.to_user].includes(i.user.id)) return fail(i, 'Bu takas seni ilgilendirmiyor.');
    S.setTradeStatus.run('declined', id);
    return i.update({ content: '', embeds: [tradeEmbed(t, 'declined')], components: [] });
  }
  if (i.user.id !== t.to_user) return fail(i, 'Bu teklifi sadece kendisine gönderilen kişi kabul edebilir.');
  const r = doTrade(id);
  if (r.error) {
    const cur = S.getTrade.get(id);
    if (cur.status === 'pending') S.setTradeStatus.run('declined', id);
    await i.update({ content: '', embeds: [tradeEmbed(cur, cur.status === 'expired' ? 'expired' : 'declined')], components: [] });
    return i.followUp({ ...errBody(r.error), flags: EPHEMERAL });
  }
  return i.update({ content: '', embeds: [tradeEmbed(t, 'completed')], components: [] });
}

/* /give */
register({
  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('Başka bir oyuncuya altın gönderir')
    .addUserOption((o) => o.setName('user').setDescription('Alıcı').setRequired(true))
    .addIntegerOption((o) => o.setName('amount').setDescription('Miktar').setRequired(true).setMinValue(1).setMaxValue(1_000_000)),
  async execute(i) {
    const to = i.options.getUser('user', true);
    const amount = i.options.getInteger('amount', true);
    if (to.bot || to.id === i.user.id) return fail(i, 'Geçerli başka bir oyuncu seçmelisin.');
    if (!doGive(i.user.id, to.id, amount)) return fail(i, 'Yetersiz altın.');
    return i.reply({ embeds: [embed(COLOR.ok, null, `💸 ${i.user} ➜ ${to}: **${fmt(amount)}** 🪙 gönderdi.`)], allowedMentions: { users: [to.id] } });
  },
});

/* /leaderboard */
register({
  data: new SlashCommandBuilder().setName('leaderboard').setDescription('En zengin 10 oyuncu'),
  async execute(i) {
    const rows = S.topGold.all();
    const medals = ['🥇', '🥈', '🥉'];
    return i.reply({ embeds: [embed(COLOR.gold, '🏆 Altın Sıralaması', rows.length ? rows.map((r, n) => `${medals[n] ?? `**${n + 1}.**`} <@${r.user_id}> — ${fmt(r.gold)} 🪙`).join('\n') : 'Henüz kimse yok.')] });
  },
});

/* ── Bilgi / yardımcı komutlar ────────────────────────────────────────────── */
register({
  data: new SlashCommandBuilder().setName('ping').setDescription('Bot gecikmesini gösterir'),
  async execute(i) {
    return i.reply({ embeds: [embed(COLOR.info, '🏓 Pong!', `WebSocket gecikmesi: **${client.ws.ping} ms**`)], flags: EPHEMERAL });
  },
});

register({
  data: new SlashCommandBuilder().setName('avatar').setDescription('Kullanıcının avatarını gösterir').addUserOption((o) => o.setName('user').setDescription('Kullanıcı')),
  async execute(i) {
    const u = i.options.getUser('user') ?? i.user;
    return i.reply({ embeds: [embed(COLOR.info, `🖼️ ${u.username}`).setImage(u.displayAvatarURL({ size: 1024 }))] });
  },
});

register({
  data: new SlashCommandBuilder().setName('userinfo').setDescription('Kullanıcı bilgilerini gösterir').addUserOption((o) => o.setName('user').setDescription('Kullanıcı')),
  async execute(i) {
    const user = i.options.getUser('user') ?? i.user;
    const m = i.options.getMember('user') ?? (user.id === i.user.id ? i.member : null);
    const e = embed(COLOR.info, `👤 ${user.username}`).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields(
      { name: 'ID', value: `\`${user.id}\``, inline: true },
      { name: 'Hesap oluşturma', value: dt(user.createdTimestamp, 'R'), inline: true },
      { name: 'Bot mu?', value: user.bot ? 'Evet' : 'Hayır', inline: true }
    );
    if (m) {
      e.addFields(
        { name: 'Sunucuya katılma', value: m.joinedTimestamp ? dt(m.joinedTimestamp, 'R') : '—', inline: true },
        { name: 'En yüksek rol', value: `${m.roles.highest}`, inline: true },
        { name: 'Rol sayısı', value: String(m.roles.cache.size - 1), inline: true }
      );
      if (m.isCommunicationDisabled()) e.addFields({ name: '🔇 Susturulmuş', value: `Bitiş: ${dt(m.communicationDisabledUntilTimestamp, 'R')}` });
    }
    if (i.member.permissions.has(P.ModerateMembers)) {
      e.addFields({ name: '⚠️ Uyarı sayısı', value: String(S.countWarnings.get(i.guildId, user.id).c), inline: true });
    }
    return i.reply({ embeds: [e] });
  },
});

register({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('Sunucu bilgilerini gösterir'),
  async execute(i) {
    const g = i.guild;
    return i.reply({
      embeds: [embed(COLOR.info, `🏠 ${g.name}`).setThumbnail(g.iconURL({ size: 256 })).addFields(
        { name: 'Sahip', value: `<@${g.ownerId}>`, inline: true },
        { name: 'Üye', value: fmt(g.memberCount), inline: true },
        { name: 'Kanal', value: fmt(g.channels.cache.size), inline: true },
        { name: 'Rol', value: fmt(g.roles.cache.size), inline: true },
        { name: 'Boost', value: `Seviye ${g.premiumTier} (${g.premiumSubscriptionCount ?? 0})`, inline: true },
        { name: 'Oluşturulma', value: dt(g.createdTimestamp, 'R'), inline: true }
      )],
    });
  },
});

register({
  data: new SlashCommandBuilder().setName('help').setDescription('Tüm komutları listeler'),
  async execute(i) {
    return i.reply({
      embeds: [embed(COLOR.info, '📖 Chronox • Komut Listesi').addFields(
        { name: '🔨 Moderasyon', value: '`/warn` `/warnings` `/unwarn` `/clearwarnings` `/history`\n`/kick` `/ban` `/unban` `/timeout` `/untimeout`\n`/purge` `/slowmode` `/lock` `/unlock`' },
        { name: '🎫 Ticket', value: '`/ticket-setup` `/add` `/remove`\n`/ticket close|claim|unclaim|priority|rename|transfer|transcript|info|list|ban|unban`' },
        { name: '🛡️ Ayarlar & AutoMod', value: '`/config log|welcome|autorole|warn-punish|show`\n`/automod status|toggle|limits|word-*|domain-*|ignore-*|raid|raid-reset`' },
        { name: '🎙️ Geçici Ses Odaları', value: '`/chronoxvoice setup|panel|disable` (yetkili) — oda yönetimi komutsuz, kanaldaki **butonlu panelden** yapılır' },
        { name: '👋 Karşılama (GIF’li)', value: '`/welcome channel|gif-add|gif-remove|gif-list|test|disable`' },
        { name: '🎴 Kart Oyunu & Ekonomi', value: '`/daily` `/balance` `/gacha` `/cards` `/market` `/trade` `/give` `/leaderboard`' },
        { name: 'ℹ️ Bilgi', value: '`/avatar` `/userinfo` `/serverinfo` `/ping`' }
      )],
      flags: EPHEMERAL,
    });
  },
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8. OLAYLAR: AUTOMOD • RAID • LOG • KARŞILAMA
 * ════════════════════════════════════════════════════════════════════════════ */
const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg|discord\.me)\/[\w-]+/i;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
const spamTracker = new Map(); // "guild:user" -> [timestamps]
const violationCooldown = new Map(); // "guild:user" -> son ihlal zamanı
const joinLog = new Map(); // guildId -> [{ t, id }]
const lockdowns = new Map(); // guildId -> bitiş zamanı

function automodExempt(message) {
  const m = message.member;
  if (m.permissions.has(P.ManageMessages)) return true;
  const ignored = S.listGet.all(message.guildId, 'ignore').map((r) => r.value);
  if (!ignored.length) return false;
  if (ignored.includes(message.channelId) || (message.channel.parentId && ignored.includes(message.channel.parentId))) return true;
  return m.roles.cache.some((r) => ignored.includes(r.id));
}

async function handleViolation(message, rule, reason, { timeoutMs = 0 } = {}) {
  const { guild, member, author } = message;
  const key = `${guild.id}:${author.id}`;
  await message.delete().catch(() => {});
  // Aynı saldırı serisi için tekrar tekrar ceza verme
  if (Date.now() - (violationCooldown.get(key) ?? 0) < 4000) return;
  violationCooldown.set(key, Date.now());

  const notice = await message.channel.send({ content: `${author}, ${reason}`, allowedMentions: { users: [author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);

  const count = addWarning(guild.id, author.id, client.user.id, `[AutoMod • ${rule}] ${reason}`);
  const caseNo = await recordCase(guild, { action: 'warn', target: author, moderator: client.user, reason: `[AutoMod • ${rule}] ${reason}` });
  await dmUser(author, punishDm(guild, { action: 'warn', reason: `[AutoMod] ${reason}`, caseNo }).addFields({ name: 'Toplam uyarı', value: String(count) }));

  let extra = '';
  if (timeoutMs && member.moderatable) {
    await member.timeout(Math.min(timeoutMs, MAX_TIMEOUT_MS), `AutoMod: ${rule}`).catch(() => {});
    extra = `\n🔇 ${formatDuration(timeoutMs)} susturuldu.`;
  }
  const esc = await applyEscalation(guild, member, count);
  await sendLog(guild, 'mod', embed(COLOR.warn, `🛡️ AutoMod • ${rule}`).addFields(
    { name: 'Kullanıcı', value: `${author} (\`${author.id}\`)`, inline: true },
    { name: 'Kanal', value: `${message.channel}`, inline: true },
    { name: 'Toplam uyarı', value: String(count), inline: true },
    { name: 'Mesaj', value: truncate(message.content || '(boş)', 800) },
    { name: 'İşlem', value: `Mesaj silindi + uyarı verildi.${extra}${esc ? `\n${esc}` : ''}` }
  ).setTimestamp());
}

async function runAutomod(message) {
  const cfg = getAutomod(message.guildId);
  if (!(cfg.spam || cfg.invites || cfg.links || cfg.badwords || cfg.caps || cfg.mentions)) return;
  if (automodExempt(message)) return;
  const content = message.content ?? '';

  // 1) Discord davet linki
  if (cfg.invites && INVITE_RE.test(content)) return handleViolation(message, 'Davet', 'Sunucuda davet linki paylaşmak yasak.');

  // 2) Linkler (izinli alan adları hariç)
  if (cfg.links) {
    const urls = content.match(URL_RE) ?? [];
    if (urls.length) {
      const allowed = S.listGet.all(message.guildId, 'domain').map((r) => r.value);
      const bad = urls.some((u) => {
        try {
          const host = new URL(u.startsWith('http') ? u : `http://${u}`).hostname.replace(/^www\./, '').toLowerCase();
          return !allowed.some((d) => host === d || host.endsWith(`.${d}`));
        } catch {
          return true;
        }
      });
      if (bad) return handleViolation(message, 'Link', 'Burada link paylaşmak yasak.');
    }
  }

  // 3) Yasaklı kelimeler
  if (cfg.badwords && content) {
    const text = lower(content);
    const hit = S.listGet.all(message.guildId, 'badword').find((r) => text.includes(r.value));
    if (hit) return handleViolation(message, 'Yasaklı kelime', 'Mesajında yasaklı bir kelime bulunuyor.');
  }

  // 4) Toplu etiket
  if (cfg.mentions) {
    const total = message.mentions.users.size + message.mentions.roles.size;
    if (total > cfg.mention_limit || (message.mentions.everyone && !message.member.permissions.has(P.MentionEveryone))) {
      return handleViolation(message, 'Toplu etiket', `Tek mesajda en fazla ${cfg.mention_limit} etiket atabilirsin.`);
    }
  }

  // 5) CAPS
  if (cfg.caps && content.length >= 12) {
    const letters = content.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 12) {
      const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
      if ((upper / letters.length) * 100 >= cfg.caps_percent) return handleViolation(message, 'CAPS', 'Lütfen bu kadar çok büyük harf kullanma.');
    }
  }

  // 6) Spam
  if (cfg.spam) {
    const key = `${message.guildId}:${message.author.id}`;
    const nowMs = message.createdTimestamp;
    const arr = (spamTracker.get(key) ?? []).filter((t) => nowMs - t < cfg.spam_seconds * 1000);
    arr.push(nowMs);
    spamTracker.set(key, arr);
    if (arr.length > cfg.spam_messages) {
      spamTracker.delete(key);
      // yakın zamandaki spam mesajlarını da temizle
      try {
        const recent = await message.channel.messages.fetch({ limit: 30 });
        const mine = recent.filter((m) => m.author.id === message.author.id && nowMs - m.createdTimestamp < cfg.spam_seconds * 1000 + 2000);
        await message.channel.bulkDelete(mine, true);
      } catch {
        /* yetki yoksa sadece geçerli mesaj silinir */
      }
      return handleViolation(message, 'Spam', 'Çok hızlı mesaj gönderiyorsun, lütfen yavaşla.', { timeoutMs: cfg.spam_timeout_minutes * 6e4 });
    }
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot || message.webhookId || !message.member) return;
    await runAutomod(message);
  } catch (err) {
    console.error('[automod]', err);
  }
});

/* ── Raid koruması ────────────────────────────────────────────────────────── */
async function autoKick(member, reason) {
  try {
    if (!member.kickable) return;
    await dmUser(member.user, punishDm(member.guild, { action: 'kick', reason }));
    await member.kick(reason);
    await recordCase(member.guild, { action: 'kick', target: member.user, moderator: client.user, reason });
  } catch (err) {
    console.error('[autoKick]', err.message);
  }
}

/** true dönerse üye atılmıştır */
async function raidCheck(member) {
  const cfg = getAutomod(member.guild.id);
  if (!cfg.raid || member.user.bot) return false;
  const gid = member.guild.id;
  const nowMs = Date.now();

  if (cfg.min_account_days > 0) {
    const ageDays = (nowMs - member.user.createdTimestamp) / 864e5;
    if (ageDays < cfg.min_account_days) {
      await autoKick(member, `Raid koruması: hesap yaşı yetersiz (${ageDays.toFixed(1)} gün < ${cfg.min_account_days} gün)`);
      return true;
    }
  }
  if ((lockdowns.get(gid) ?? 0) > nowMs) {
    await autoKick(member, 'Raid koruması: sunucu geçici olarak yeni üyelere kapalı');
    return true;
  }
  const arr = (joinLog.get(gid) ?? []).filter((x) => nowMs - x.t < cfg.raid_seconds * 1000);
  arr.push({ t: nowMs, id: member.id });
  joinLog.set(gid, arr);
  if (arr.length >= cfg.raid_joins) {
    lockdowns.set(gid, nowMs + 5 * 60_000);
    joinLog.delete(gid);
    await sendLog(member.guild, 'mod', embed(COLOR.error, '🚨 RAID ALGILANDI', `**${cfg.raid_seconds} saniye** içinde **${arr.length}** üye katıldı.\nSunucu **5 dakika** boyunca yeni üyelere kapatıldı ve son katılanlar atılıyor.\nErken kaldırmak için: \`/automod raid-reset\``).setTimestamp());
    for (const x of arr) {
      const m = member.guild.members.cache.get(x.id) ?? (await member.guild.members.fetch(x.id).catch(() => null));
      if (m) await autoKick(m, 'Raid koruması: toplu katılım algılandı');
    }
    return true;
  }
  return false;
}

/* ── Karşılama + otorol + raid ────────────────────────────────────────────── */
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (await raidCheck(member)) return;
    const s = getSettings(member.guild.id);

    if (s.autorole) {
      await member.roles.add(s.autorole, 'Otomatik rol').catch((e) => console.error('[autorole]', e.message));
    }
    if (s.welcome_channel) await welcome.sendWelcome(member, s); // modules/welcome.js (hata fırlatmaz)
    await sendLog(member.guild, 'general', embed(COLOR.ok, '📥 Üye katıldı').setThumbnail(member.user.displayAvatarURL()).addFields(
      { name: 'Üye', value: `${member.user} (\`${member.id}\`)`, inline: true },
      { name: 'Hesap oluşturma', value: dt(member.user.createdTimestamp, 'R'), inline: true },
      { name: 'Üye sayısı', value: String(member.guild.memberCount), inline: true }
    ).setTimestamp());
  } catch (err) {
    console.error('[memberAdd]', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const kick = await findAudit(member.guild, AuditLogEvent.MemberKick, member.id);
    if (kick && kick.executor && kick.executor.id !== client.user.id) {
      await recordCase(member.guild, { action: 'kick', target: member.user, moderator: kick.executor, reason: kick.reason ?? 'Belirtilmedi' });
    }
    const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id).map((r) => `${r}`).join(' ');
    await sendLog(member.guild, 'general', embed(COLOR.error, kick ? '👢 Üye atıldı' : '📤 Üye ayrıldı').setThumbnail(member.user.displayAvatarURL()).addFields(
      { name: 'Üye', value: `${member.user} (\`${member.id}\`)`, inline: true },
      { name: 'Katılma', value: member.joinedTimestamp ? dt(member.joinedTimestamp, 'R') : '—', inline: true },
      ...(roles ? [{ name: 'Roller', value: truncate(roles, 900) }] : [])
    ).setTimestamp());
  } catch (err) {
    console.error('[memberRemove]', err);
  }
});

/* ── Ban / unban (başka yollarla yapılanlar da vaka olarak kaydedilir) ─────── */
client.on(Events.GuildBanAdd, async (ban) => {
  try {
    const entry = await findAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (entry?.executor?.id === client.user.id) return; // bot komutları zaten logluyor
    if (entry?.executor) {
      await recordCase(ban.guild, { action: 'ban', target: ban.user, moderator: entry.executor, reason: entry.reason ?? ban.reason ?? 'Belirtilmedi' });
    } else {
      await sendLog(ban.guild, 'mod', embed(COLOR.error, '🔨 Üye yasaklandı').addFields({ name: 'Kullanıcı', value: `${ban.user} (\`${ban.user.id}\`)` }).setTimestamp());
    }
  } catch (err) {
    console.error('[banAdd]', err);
  }
});
client.on(Events.GuildBanRemove, async (ban) => {
  try {
    const entry = await findAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    if (entry?.executor?.id === client.user.id) return;
    if (entry?.executor) {
      await recordCase(ban.guild, { action: 'unban', target: ban.user, moderator: entry.executor, reason: entry.reason ?? 'Belirtilmedi' });
    } else {
      await sendLog(ban.guild, 'mod', embed(COLOR.ok, '🔓 Yasak kaldırıldı').addFields({ name: 'Kullanıcı', value: `${ban.user} (\`${ban.user.id}\`)` }).setTimestamp());
    }
  } catch (err) {
    console.error('[banRemove]', err);
  }
});

/* ── Mesaj logları ────────────────────────────────────────────────────────── */
client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.guild || message.author?.bot || isLogChannel(message.guild.id, message.channelId)) return;
    const e = embed(COLOR.error, '🗑️ Mesaj silindi').addFields(
      { name: 'Yazar', value: message.author ? `${message.author} (\`${message.author.id}\`)` : 'Bilinmiyor (önbellekte yok)', inline: true },
      { name: 'Kanal', value: `<#${message.channelId}>`, inline: true },
      { name: 'İçerik', value: truncate(message.content || '*(boş veya önbellekte yok)*', 1000) }
    ).setTimestamp();
    if (message.attachments?.size) e.addFields({ name: 'Ekler', value: truncate(message.attachments.map((a) => a.name).join(', '), 500) });
    await sendLog(message.guild, 'general', e);
  } catch (err) {
    console.error('[messageDelete]', err);
  }
});
client.on(Events.MessageBulkDelete, async (messages, channel) => {
  try {
    if (!channel.guild || isLogChannel(channel.guild.id, channel.id)) return;
    await sendLog(channel.guild, 'general', embed(COLOR.error, '🧹 Toplu mesaj silindi').addFields(
      { name: 'Kanal', value: `${channel}`, inline: true }, { name: 'Adet', value: String(messages.size), inline: true }
    ).setTimestamp());
  } catch (err) {
    console.error('[bulkDelete]', err);
  }
});
client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    if (!newMsg.guild || newMsg.author?.bot || isLogChannel(newMsg.guild.id, newMsg.channelId)) return;
    if (oldMsg.content === newMsg.content || newMsg.content == null) return;
    await sendLog(newMsg.guild, 'general', embed(COLOR.warn, '✏️ Mesaj düzenlendi').addFields(
      { name: 'Yazar', value: newMsg.author ? `${newMsg.author} (\`${newMsg.author.id}\`)` : 'Bilinmiyor', inline: true },
      { name: 'Kanal', value: `<#${newMsg.channelId}> • [Mesaja git](${newMsg.url})`, inline: true },
      { name: 'Önce', value: truncate(oldMsg.content || '*(önbellekte yok)*', 1000) },
      { name: 'Sonra', value: truncate(newMsg.content, 1000) }
    ).setTimestamp());
  } catch (err) {
    console.error('[messageUpdate]', err);
  }
});

/* ── Üye güncelleme (rol / takma ad / timeout) ────────────────────────────── */
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  try {
    if (oldM.partial) return;
    const fields = [];
    const added = newM.roles.cache.filter((r) => !oldM.roles.cache.has(r.id));
    const removed = oldM.roles.cache.filter((r) => !newM.roles.cache.has(r.id));
    if (added.size) fields.push({ name: '➕ Eklenen roller', value: added.map((r) => `${r}`).join(' ') });
    if (removed.size) fields.push({ name: '➖ Alınan roller', value: removed.map((r) => `${r}`).join(' ') });
    if (oldM.nickname !== newM.nickname) fields.push({ name: 'Takma ad', value: `${oldM.nickname ?? '*yok*'} ➜ ${newM.nickname ?? '*yok*'}` });
    if (oldM.communicationDisabledUntilTimestamp !== newM.communicationDisabledUntilTimestamp) {
      fields.push({ name: 'Timeout', value: newM.isCommunicationDisabled() ? `Bitiş: ${dt(newM.communicationDisabledUntilTimestamp, 'R')}` : 'Kaldırıldı' });
    }
    if (!fields.length) return;
    await sendLog(newM.guild, 'general', embed(COLOR.info, '🔧 Üye güncellendi', `${newM.user} (\`${newM.id}\`)`).addFields(fields).setTimestamp());
  } catch (err) {
    console.error('[memberUpdate]', err);
  }
});

/* ── Kanal / rol / ses logları ────────────────────────────────────────────── */
client.on(Events.ChannelCreate, async (ch) => {
  if (!ch.guild || chronoxvoice.isBusy(ch.guild.id)) return; // ChronoxVoice odaları loglanmaz
  await sendLog(ch.guild, 'general', embed(COLOR.ok, '📁 Kanal oluşturuldu').addFields({ name: 'Kanal', value: `${ch} (\`${ch.name}\`)` }).setTimestamp());
});
client.on(Events.ChannelDelete, async (ch) => {
  if (!ch.guild || chronoxvoice.isManaged(ch.id)) return; // ChronoxVoice odaları loglanmaz
  await sendLog(ch.guild, 'general', embed(COLOR.error, '🗑️ Kanal silindi').addFields({ name: 'Kanal', value: `\`${ch.name}\`` }).setTimestamp());
});
client.on(Events.GuildRoleCreate, async (role) => {
  await sendLog(role.guild, 'general', embed(COLOR.ok, '🏷️ Rol oluşturuldu').addFields({ name: 'Rol', value: `${role} (\`${role.name}\`)` }).setTimestamp());
});
client.on(Events.GuildRoleDelete, async (role) => {
  await sendLog(role.guild, 'general', embed(COLOR.error, '🏷️ Rol silindi').addFields({ name: 'Rol', value: `\`${role.name}\`` }).setTimestamp());
});
client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  try {
    if (!newS.guild || newS.member?.user.bot || oldS.channelId === newS.channelId) return;
    let text;
    if (!oldS.channelId) text = `🔊 ${newS.member} → ${newS.channel} kanalına katıldı.`;
    else if (!newS.channelId) text = `🔇 ${newS.member} → ${oldS.channel} kanalından ayrıldı.`;
    else text = `🔁 ${newS.member} → ${oldS.channel} ➜ ${newS.channel}`;
    await sendLog(newS.guild, 'general', embed(COLOR.dark, '🎙️ Ses kanalı', text).setTimestamp());
  } catch (err) {
    console.error('[voice]', err);
  }
});

/* ── ChronoxVoice: oda oluştur / devret / boşalınca sil ──────────────────────── */
client.on(Events.VoiceStateUpdate, (oldS, newS) => {
  chronoxvoice.handleVoiceState(oldS, newS); // hataları kendi içinde yakalar
});
client.on(Events.ChannelDelete, (ch) => {
  chronoxvoice.onChannelDelete(ch); // log dinleyicisinden SONRA kayıtlıdır (sıra önemli)
});

/* ════════════════════════════════════════════════════════════════════════════
 * 9. INTERACTION YÖNLENDİRİCİ & BAŞLANGIÇ
 * ════════════════════════════════════════════════════════════════════════════ */
async function onCommand(i) {
  const cmd = commands.get(i.commandName);
  if (!cmd) return;
  if (!i.inGuild() || !i.guild) return fail(i, 'Bu komut sadece sunucularda kullanılabilir.');
  if (cmd.perm && !i.memberPermissions?.has(cmd.perm)) return fail(i, 'Bu komutu kullanmak için gerekli yetkiye sahip değilsin.');
  await cmd.execute(i);
}

async function onButton(i) {
  const [scope, action, a, b] = i.customId.split(':');
  if (scope === 'tk') {
    if (action === 'rate') return ticketRate(i, Number(a), Number(b)); // DM'de çalışır
    if (!i.inGuild()) return;
    if (action === 'open') return ticketOpenButton(i, a);
    if (action === 'close') return ticketCloseButton(i);
    const t = currentTicket(i);
    if (!t) return fail(i, NOT_TICKET);
    if (action === 'claim') return ticketClaim(i, t);
    if (action === 'transcript') return ticketTranscript(i, t);
  }
  if (scope === 'trade') return tradeButton(i, action, Number(a));
}

async function onModal(i) {
  const [scope, action, a] = i.customId.split(':');
  if (scope !== 'tk' || !i.inGuild()) return;
  if (action === 'modal' && TICKET_TYPES[a]) return createTicket(i, a);
  if (action === 'closemodal') return ticketCloseModal(i);
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) return await onCommand(i);
    // ChronoxVoice kontrol paneli: butonlar, modallar ve seçim menüleri ("tv:" önekli)
    if ((i.isButton() || i.isModalSubmit() || i.isAnySelectMenu()) && i.inGuild() && i.customId.startsWith('tv:')) {
      return await chronoxvoice.handleComponent(i);
    }
    if (i.isAutocomplete()) {
      const cmd = commands.get(i.commandName);
      if (cmd?.autocomplete) return await cmd.autocomplete(i);
      return;
    }
    if (i.isButton()) return await onButton(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (err) {
    console.error(`[interaction:${i.commandName ?? i.customId}]`, err);
    if (i.isAutocomplete?.()) return;
    const msg = err?.code === 50013 || err?.code === 50001
      ? 'Botun bu işlem için yetkisi yok. Bot rolüne gerekli izinleri ver ve rolünü yukarı taşı.'
      : 'Beklenmeyen bir hata oluştu. Lütfen tekrar dene.';
    await fail(i, msg).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ ${c.user.tag} olarak giriş yapıldı • ${c.guilds.cache.size} sunucu`);
  c.user.setPresence({ activities: [{ name: '/help • Chronox', type: ActivityType.Playing }], status: 'online' });

  const body = [...commands.values()].map((x) => x.data.toJSON());
  try {
    if (DEV_GUILD_ID) {
      const guild = await c.guilds.fetch(DEV_GUILD_ID);
      await guild.commands.set(body);
      console.log(`📌 ${body.length} komut GUILD_ID (${DEV_GUILD_ID}) sunucusuna yüklendi.`);
    } else {
      await c.application.commands.set(body);
      console.log(`🌍 ${body.length} komut global olarak yüklendi (görünmesi biraz sürebilir).`);
    }
  } catch (err) {
    console.error('❌ Komutlar yüklenemedi:', err);
  }

  chronoxvoice.cleanup().catch((e) => console.error('[chronoxvoice]', e));
  setInterval(() => processTempBans().catch((e) => console.error('[tempban]', e)), 30_000);
  setInterval(() => {
    // bellek temizliği
    const nowMs = Date.now();
    for (const [k, arr] of spamTracker) if (!arr.length || nowMs - arr[arr.length - 1] > 120_000) spamTracker.delete(k);
    for (const [k, t] of violationCooldown) if (nowMs - t > 60_000) violationCooldown.delete(k);
    for (const [k, until] of lockdowns) if (until < nowMs) lockdowns.delete(k);
  }, 60_000);
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const shutdown = () => {
  console.log('Kapatılıyor...');
  try { db.close(); } catch { /* yoksay */ }
  client.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(TOKEN);
