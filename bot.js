'use strict';

/**
 * Chronomancer's Book — Discord Bot (Enhanced v3.2)
 * ================================================
 * FIXES v3.2:
 * - checkNotifications: Snapshot event data AT notification time to avoid
 *   stale references when the event is about to expire from /upcoming
 * - sendFiveMinNotification: Now receives the FULL list object (with signups)
 *   already fetched, avoiding a second apiGet that could return a different list
 * - 5-min DM reminder: now correctly references the event the user signed up for
 * - DM reminder: skips empty discord_id strings reliably
 * - notifiedLists: now keyed by list ID (was already correct, but added guard
 *   to never notify for a list whose event is already past)
 * - Channel lookup in sendFiveMinNotification: uses category_name from the
 *   already-fetched full list object, not re-fetched data
 */

const fs = require('fs');
const path = require('path');

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

// ── Config ────────────────────────────────────────────────────────────────
const DISCORD_TOKEN           = process.env.DISCORD_TOKEN            || '';
const DISCORD_CHANNEL_ID      = process.env.DISCORD_CHANNEL_ID       || '';
const DISCORD_NOTIFY_CHANNEL  = process.env.DISCORD_NOTIFY_CHANNEL_ID || DISCORD_CHANNEL_ID;
const DISCORD_ADMIN_CHANNEL   = process.env.DISCORD_ADMIN_CHANNEL_ID  || DISCORD_NOTIFY_CHANNEL;
const APP_URL                 = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const APP_ADMIN_PASSWORD      = process.env.APP_ADMIN_PASSWORD        || 'admin123';
const POLL_INTERVAL           = parseInt(process.env.BOT_POLL_INTERVAL_MS || '10000', 10);
const CATEGORY_FILTER_RAW     = process.env.BOT_CATEGORY_FILTER      || '';
const CATEGORY_FILTER         = CATEGORY_FILTER_RAW
  ? CATEGORY_FILTER_RAW.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

// ── Admin Discord ID store ─────────────────────────────────────────────────
const ADMIN_STORE_PATH = path.join(__dirname, 'data', 'discord_admins.json');

function loadAdminStore() {
  try {
    if (fs.existsSync(ADMIN_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(ADMIN_STORE_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveAdminStore(store) {
  try {
    const dir = path.dirname(ADMIN_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ADMIN_STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('⚠️  Could not save admin store:', err.message);
  }
}

let adminStore = loadAdminStore();

function isLinkedAdmin(discordUserId) {
  return !!adminStore[discordUserId];
}

function linkAdmin(discordUserId) {
  adminStore[discordUserId] = { discordUserId, linkedAt: new Date().toISOString() };
  saveAdminStore(adminStore);
}

function unlinkAdmin(discordUserId) {
  delete adminStore[discordUserId];
  saveAdminStore(adminStore);
}

function getLinkedAdminIds() {
  return Object.keys(adminStore);
}

// ── Category Channel Map ──────────────────────────────────────────────────
let CATEGORY_CHANNEL_MAP = {};
try {
  const raw = process.env.CATEGORY_CHANNEL_MAP || '{}';
  const parsed = JSON.parse(raw);
  for (const [k, v] of Object.entries(parsed)) {
    CATEGORY_CHANNEL_MAP[k.toLowerCase()] = String(v);
  }
} catch {
  console.error('⚠️  CATEGORY_CHANNEL_MAP is not valid JSON — using fallback channel.');
}

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error('❌  DISCORD_TOKEN and DISCORD_CHANNEL_ID must be set.');
  process.exit(1);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────
const nodeFetch = (() => {
  if (typeof fetch !== 'undefined') return fetch.bind(globalThis);
  try { return require('node-fetch'); } catch { return null; }
})();

if (!nodeFetch) {
  console.error('❌  No fetch available. Use Node 18+ or install node-fetch.');
  process.exit(1);
}

let adminCookie = '';

async function apiGet(path) {
  const res = await nodeFetch(`${APP_URL}${path}`, {
    headers: { Cookie: adminCookie },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await nodeFetch(`${APP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `POST ${path} → ${res.status}`);
  return json;
}

async function ensureAdminSession() {
  try {
    const res = await nodeFetch(`${APP_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: APP_ADMIN_PASSWORD }),
    });
    if (!res.ok) throw new Error('Login failed: ' + res.status);
    const setCookie = res.headers.get('set-cookie') || '';
    const m = setCookie.match(/auth_token=([^;]+)/);
    if (m) {
      adminCookie = `auth_token=${m[1]}`;
      console.log('🔑  Admin session acquired.');
    }
  } catch (err) {
    console.error('⚠️  Could not log in to web-app:', err.message);
  }
}

// ── State ─────────────────────────────────────────────────────────────────
const postedLists    = new Map();
const listColors     = new Map();
// FIX: keyed by "id|event_date|event_time" — not just id — so that SQLite ID
// recycling (DELETE old event → INSERT new event gets same id) never causes the
// new event to be treated as already-notified.
const notifiedLists  = new Set();
const postedRequests = new Map();
const processedRequests = new Set();

/** Stable notification key that survives ID recycling */
function notifyKey(list) {
  return `${list.id}|${list.event_date}|${list.event_time}`;
}

// ── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
});

// ── Helpers ───────────────────────────────────────────────────────────────
function channelIdForCategory(categoryName) {
  const key = (categoryName || '').toLowerCase();
  return CATEGORY_CHANNEL_MAP[key] || DISCORD_CHANNEL_ID;
}

/**
 * Returns all category names (lowercase) that belong to a given channelId.
 * If channelId is the default channel, also includes categories with no mapping.
 */
function categoriesForChannel(channelId) {
  const mapped = Object.entries(CATEGORY_CHANNEL_MAP)
    .filter(([, chId]) => chId === channelId)
    .map(([cat]) => cat);

  const isDefault = channelId === DISCORD_CHANNEL_ID;
  if (isDefault) {
    return { mapped, includeUnmapped: true };
  }
  return { mapped, includeUnmapped: false };
}

function listBelongsToChannel(list, channelId) {
  const { mapped, includeUnmapped } = categoriesForChannel(channelId);
  const catKey = (list.category_name || '').toLowerCase();
  if (mapped.includes(catKey)) return true;
  if (includeUnmapped && !CATEGORY_CHANNEL_MAP[catKey]) return true;
  return false;
}

function hexColor(hex) {
  if (!hex) return 0x1a4a7a;
  return parseInt(hex.replace('#', ''), 16);
}

function fmtDate(iso) {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${+d} ${months[+m - 1]} ${y}`;
}

function slotStatusEmoji(status) {
  if (status === 'maybe')   return '🟡';
  if (status === 'standby') return '🟠';
  return '✅';
}

function categoryAllowed(categoryName) {
  if (!CATEGORY_FILTER.length) return true;
  return CATEGORY_FILTER.includes((categoryName || '').toLowerCase());
}

function escMd(str) {
  return String(str).replace(/([*_`~|\\])/g, '\\$1');
}

function buildProgressBar(pct) {
  const filled = Math.round(pct / 10);
  const empty  = 10 - filled;
  const bar    = '█'.repeat(filled) + '░'.repeat(empty);
  const color  = pct >= 100 ? '🔴' : pct >= 70 ? '🟡' : '🟢';
  return `${color} \`${bar}\` ${pct}%`;
}

function sortLists(lists) {
  return [...lists].sort((a, b) => {
    if (a.event_date < b.event_date) return -1;
    if (a.event_date > b.event_date) return 1;
    const ta = a.event_time || '99:99';
    const tb = b.event_time || '99:99';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return (a.category_name || '').localeCompare(b.category_name || '');
  });
}

// ── Timezone-aware event time parsing ────────────────────────────────────
// Events are stored as local wall-clock time (Europe/Berlin).
// new Date('YYYY-MM-DDTHH:MM:00') on a UTC server parses as UTC → 1-2h wrong.
// Fix: use Intl to find the UTC offset for Europe/Berlin at the event's date,
// then subtract it so Date.now() comparisons are correct.
function getBerlinOffsetMs(isoDatetime) {
  // isoDatetime = "YYYY-MM-DDTHH:MM:00" — treated as Berlin wall-clock time
  // We need to know what UTC offset Berlin has at that moment.
  // Strategy: format a known UTC time back as Berlin time and compare.
  // We binary-search isn't needed — Intl gives us the offset directly via
  // formatting a UTC Date and comparing to the input.
  //
  // Simpler: create a Date as if it were UTC, then ask Intl what Berlin
  // wall-clock that corresponds to, and compute the delta.
  const asIfUtc = new Date(isoDatetime + 'Z'); // parse as UTC first
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(asIfUtc);
  const get = type => parts.find(p => p.type === type)?.value || '00';
  const berlinWall = new Date(
    `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`
  );
  // berlinWall - asIfUtc = offset that Berlin is ahead of UTC (in ms)
  return berlinWall.getTime() - asIfUtc.getTime();
}

function getEventDt(list) {
  if (!list.event_date || !list.event_time) return null;
  const isoDatetime = `${list.event_date}T${list.event_time}:00`;
  // Parse as UTC first, then subtract the Berlin offset to get the true UTC instant
  const asUtc = new Date(isoDatetime + 'Z');
  const offsetMs = getBerlinOffsetMs(isoDatetime);
  // asUtc is Berlin-hours parsed as UTC → it's offsetMs too late
  // Correct UTC instant = asUtc - offsetMs
  return new Date(asUtc.getTime() - offsetMs);
}

// ── Embed builder ─────────────────────────────────────────────────────────
function buildEmbed(list, signups, catName, catColor) {
  const filled     = signups.filter(s => s.status !== 'standby' && s.slot_number <= list.slots).length;
  const free       = list.slots - filled;
  const pct        = list.slots ? Math.round((filled / list.slots) * 100) : 0;
  const bar        = buildProgressBar(pct);
  const timeStr    = list.event_time ? ` · 🕐 ${list.event_time}` : '';
  const channelStr = list.channel    ? ` · 📡 Ch. ${list.channel}` : '';

  const slotLines = [];

  // Normal Slots
  for (let i = 0; i < list.slots; i++) {
    const n = i + 1;
    const signup = signups.find(s => s.slot_number === n);
    if (!signup) {
      slotLines.push(`\`#${String(n).padStart(2, '0')}\` ░ free`);
    } else {
      const name = signup.discord_id ? `<@${signup.discord_id}>` : escMd(signup.nickname);
      slotLines.push(`\`#${String(n).padStart(2, '0')}\` ${slotStatusEmoji(signup.status)} **${name}**`);
    }
  }

  // Waitlist
  const waiting = signups.filter(s => s.slot_number > list.slots).sort((a, b) => a.slot_number - b.slot_number);
  if (waiting.length > 0) {
    slotLines.push('\n**⏳ Waitlist (Reserved):**');
    waiting.forEach((s, idx) => {
      const name = s.discord_id ? `<@${s.discord_id}>` : escMd(s.nickname);
      slotLines.push(`\`W${idx + 1}\` ${slotStatusEmoji(s.status)} **${name}**`);
    });
  }

  const CHUNK = 20;
  const chunks = [];
  for (let i = 0; i < slotLines.length; i += CHUNK) {
    chunks.push(slotLines.slice(i, i + CHUNK).join('\n'));
  }

  const embed = new EmbedBuilder()
    .setColor(hexColor(catColor))
    .setTitle(`📋 ${list.title}`)
    .setDescription(list.description || null)
    .addFields(
      { name: '📅 Date',     value: `${fmtDate(list.event_date)}${timeStr}${channelStr}`, inline: true },
      { name: '🗂️ Category', value: catName || '–',                                       inline: true },
      { name: '🪑 Slots',    value: `${filled}/${list.slots} filled (${free} free)`,      inline: true },
      { name: '📊 Progress', value: bar,                                                   inline: false },
    );

  chunks.forEach((chunk, idx) => {
    embed.addFields({
      name: chunks.length > 1
        ? `Slots (${idx * CHUNK + 1}–${Math.min((idx + 1) * CHUNK, list.slots)})`
        : 'Slots',
      value: chunk || '–',
      inline: chunks.length > 1,
    });
  });

  embed
    .setFooter({ text: `Chronomancer's Book · ${APP_URL}` })
    .setTimestamp();

  return embed;
}

// ── Buttons ───────────────────────────────────────────────────────────────
function buildButtons(listId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`signup_sure__${listId}`)
      .setLabel('✅  Sure — I\'m in!')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`signup_maybe__${listId}`)
      .setLabel('🟡  Maybe')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cancel_request__${listId}`)
      .setLabel('❌  Cancel my slot')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`refresh__${listId}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setURL(APP_URL)
      .setLabel('🌐 Web App')
      .setStyle(ButtonStyle.Link),
  );
}

function buildRequestButtons(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`req_accept__${requestId}`)
      .setLabel('✓ Accept — Remove Slot')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`req_deny__${requestId}`)
      .setLabel('✗ Deny')
      .setStyle(ButtonStyle.Danger),
  );
}

// ── Post / Update list messages ───────────────────────────────────────────
async function postOrUpdateList(list, catName, catColor) {
  const targetChannelId = channelIdForCategory(catName);
  const channel = await client.channels.fetch(targetChannelId).catch(() => null);
  if (!channel) {
    console.warn(`⚠️  Channel ${targetChannelId} not found for category "${catName}" (list ${list.id})`);
    return;
  }

  let signups = [];
  try {
    const full = await apiGet(`/api/lists/${list.id}`);
    signups = full.signups || [];
  } catch { /* ignore */ }

  const embed   = buildEmbed(list, signups, catName, catColor);
  const buttons = buildButtons(list.id);

  const existing = postedLists.get(list.id);

  if (existing) {
    if (existing.channelId !== targetChannelId) {
      try {
        const oldChannel = await client.channels.fetch(existing.channelId).catch(() => null);
        if (oldChannel) {
          const oldMsg = await oldChannel.messages.fetch(existing.messageId).catch(() => null);
          if (oldMsg) await oldMsg.delete();
        }
      } catch { /* already gone */ }
      const msg = await channel.send({ embeds: [embed], components: [buttons] });
      postedLists.set(list.id, { messageId: msg.id, channelId: targetChannelId });
    } else {
      try {
        const msg = await channel.messages.fetch(existing.messageId);
        await msg.edit({ embeds: [embed], components: [buttons] });
      } catch {
        const msg = await channel.send({ embeds: [embed], components: [buttons] });
        postedLists.set(list.id, { messageId: msg.id, channelId: targetChannelId });
      }
    }
  } else {
    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    postedLists.set(list.id, { messageId: msg.id, channelId: targetChannelId });
    listColors.set(list.id, catColor);
  }
}

async function refreshListMessage(listId) {
  if (!postedLists.has(listId)) return;
  try {
    const full = await apiGet(`/api/lists/${listId}`);
    const cats = await apiGet('/api/categories');
    const cat  = cats.find(c => c.id === full.category_id) || {};
    await postOrUpdateList(full, cat.name || '', cat.color || '#1a4a7a');
  } catch (err) {
    console.error('refreshListMessage error:', err.message);
  }
}

// ── Removal Request notifications ─────────────────────────────────────────
async function notifyAdminsOfRequest(req) {
  if (processedRequests.has(req.id)) return;

  const embed = new EmbedBuilder()
    .setColor(0xff4444)
    .setTitle('⚠️ Slot Removal Request')
    .addFields(
      { name: '👤 Nickname',  value: escMd(req.nickname),                                    inline: true },
      { name: '📋 List',      value: escMd(req.list_title || `#${req.list_id}`),              inline: true },
      { name: '#️⃣  Slot',     value: String(req.slot_number),                                inline: true },
      { name: '📅 Date',      value: fmtDate(req.event_date),                                inline: true },
      { name: '💬 Reason',    value: req.reason ? escMd(req.reason) : '_(no reason given)_', inline: false },
    )
    .setFooter({ text: `Request ID: ${req.id} · Chronomancer's Book` })
    .setTimestamp();

  const buttons = buildRequestButtons(req.id);

  try {
    const adminChannel = await client.channels.fetch(DISCORD_ADMIN_CHANNEL).catch(() => null);
    if (adminChannel) {
      const msg = await adminChannel.send({
        content: '🔔 **New removal request — admin action required:**',
        embeds: [embed],
        components: [buttons],
      });
      postedRequests.set(req.id, { messageId: msg.id, channelId: DISCORD_ADMIN_CHANNEL });
    }
  } catch (err) {
    console.error('Failed to post to admin channel:', err.message);
  }

  const linkedIds = getLinkedAdminIds();
  for (const discordId of linkedIds) {
    try {
      const user = await client.users.fetch(discordId).catch(() => null);
      if (!user) continue;
      await user.send({
        content: `🔔 **New slot removal request on Chronomancer's Book:**`,
        embeds: [embed],
        components: [buttons],
      });
    } catch (err) {
      console.warn(`⚠️  Could not DM admin ${discordId}: ${err.message}`);
    }
  }
}

async function pollRemovalRequests() {
  try {
    const requests = await apiGet('/api/delete-requests');
    for (const req of requests) {
      if (!postedRequests.has(req.id) && !processedRequests.has(req.id)) {
        await notifyAdminsOfRequest(req);
      }
    }
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('Unauthorized')) {
      await ensureAdminSession();
    } else {
      console.error('pollRemovalRequests error:', err.message);
    }
  }
}

async function resolveRequestMessage(requestId, accepted, adminTag) {
  processedRequests.add(requestId);
  const posted = postedRequests.get(requestId);
  if (!posted) return;

  try {
    const ch = await client.channels.fetch(posted.channelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(posted.messageId).catch(() => null);
    if (!msg) return;

    const statusEmbed = EmbedBuilder.from(msg.embeds[0])
      .setColor(accepted ? 0x2d6a4f : 0x888888)
      .setTitle(accepted ? '✅ Slot Removal — Accepted' : '❌ Slot Removal — Denied')
      .setFooter({ text: `${accepted ? 'Accepted' : 'Denied'} by ${adminTag} · Request ID: ${requestId}` });

    await msg.edit({ embeds: [statusEmbed], components: [] });
  } catch (err) {
    console.error('resolveRequestMessage error:', err.message);
  }

  postedRequests.delete(requestId);
}

// ── 5-minute notifications ────────────────────────────────────────────────
// FIX: We fetch full list data (including signups) HERE in checkNotifications,
// so sendFiveMinNotification always gets the correct list — not a stale reference
// from a previous poll cycle, and not confused by list ordering.
async function checkNotifications(lists) {
  const now      = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const WINDOW   = 60 * 1000; // 1-minute window to catch the event despite poll interval

  for (const list of lists) {
    // Skip already notified — key includes date+time to survive SQLite ID recycling
    const key = notifyKey(list);
    if (notifiedLists.has(key)) continue;

    // Skip events without a time (can't calculate countdown)
    const dt = getEventDt(list);
    if (!dt) continue;

    const ms = dt.getTime() - now;

    // Skip events already in the past (e.g. bot restarted after event started)
    if (ms <= 0) continue;

    // Trigger if within the 5-min window (+1min buffer for poll jitter)
    if (ms <= FIVE_MIN + WINDOW) {
      // Mark BEFORE sending to prevent duplicate notifications if the send is slow
      notifiedLists.add(key);
      console.log(`🔔  Triggering 5-min notification for list ${list.id} (${list.title}) [key=${key}]`);

      // FIX: Fetch the FULL list data right now so we have accurate signups
      // and the correct category_name for channel routing.
      // This is the canonical source — not the poll snapshot.
      let fullList;
      try {
        fullList = await apiGet(`/api/lists/${list.id}`);
      } catch (err) {
        console.error(`checkNotifications: could not fetch full list ${list.id}:`, err.message);
        // Fall back to the poll snapshot so the notification still goes out
        fullList = list;
      }

      // Re-attach category info from the poll snapshot (not available in /api/lists/:id)
      // since the detail endpoint doesn't return category_name/category_color
      fullList.category_name  = fullList.category_name  || list.category_name  || '';
      fullList.category_color = fullList.category_color || list.category_color || '#1a4a7a';

      await sendFiveMinNotification(fullList);
    }
  }
}

// FIX: sendFiveMinNotification now receives the already-fetched full list
// (with signups array attached). No second apiGet needed — avoids the bug
// where a second fetch could return a different or expired list.
async function sendFiveMinNotification(list) {
  // Use category_name from the passed object for correct channel routing
  const targetChannelId = channelIdForCategory(list.category_name || '');

  try {
    // Signups are already on the list object from checkNotifications.
    // If we're called from a fallback path without signups, default to [].
    const signups = list.signups || [];

    const filledSignups = signups.filter(s => s.status !== 'standby' && s.slot_number <= list.slots);
    const filled  = filledSignups.length;
    const free    = list.slots - filled;

    const participantNames = filledSignups
      .map(s => s.discord_id ? `<@${s.discord_id}>` : escMd(s.nickname))
      .join(', ') || '–';

    const embed = new EmbedBuilder()
      .setColor(0xff4444)
      .setTitle(`⏰ Starting in ~5 minutes: **${list.title}**`)
      .addFields(
        { name: '📅 Date & Time',  value: `${fmtDate(list.event_date)} 🕐 ${list.event_time}`, inline: true },
        { name: '🗂️ Category',     value: list.category_name || '–',                           inline: true },
        { name: '🪑 Slots',        value: `${filled}/${list.slots} filled (${free} free)`,     inline: true },
        { name: '✅ Confirmed',     value: participantNames,                                    inline: false },
      )
      .setFooter({ text: 'Chronomancer\'s Book — 5-Minute Warning' })
      .setTimestamp();

    const linkBtn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setURL(APP_URL)
        .setLabel('🌐 Open Web App')
        .setStyle(ButtonStyle.Link),
    );

    // Post to the category's channel
    const categoryChannel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (categoryChannel) {
      await categoryChannel.send({
        content: `🚨 **Event starting in ~5 minutes!** ${free > 0 ? `${free} slot(s) still open!` : 'Fully booked!'}`,
        embeds: [embed],
        components: [linkBtn],
      });
    }

    // Also post to the general notify channel if different
    if (DISCORD_NOTIFY_CHANNEL && DISCORD_NOTIFY_CHANNEL !== targetChannelId) {
      const notifyChannel = await client.channels.fetch(DISCORD_NOTIFY_CHANNEL).catch(() => null);
      if (notifyChannel) {
        await notifyChannel.send({
          content: `🚨 **Event starting in ~5 minutes!** ${free > 0 ? `${free} slot(s) still open!` : 'Fully booked!'}`,
          embeds: [embed],
          components: [linkBtn],
        });
      }
    }

    // FIX: DM all signed-up users who have a non-empty discord_id
    // The original code used `if (s.discord_id)` which correctly skips empty strings,
    // but the message only said the event name — now it includes date, time and channel.
    for (const s of signups) {
      // Skip empty string, null, or undefined discord_id values
      if (!s.discord_id || s.discord_id.trim() === '') continue;

      // Only DM confirmed/maybe participants — skip standby unless they're the only coverage
      if (s.status === 'standby' && s.slot_number > list.slots) continue;

      try {
        const user = await client.users.fetch(s.discord_id);
        const timeStr    = list.event_time ? ` at **${list.event_time}**` : '';
        const channelStr = list.channel    ? ` (Channel **${list.channel}**)` : '';
        const slotLabel  = s.slot_number > list.slots
          ? `Waitlist position W${s.slot_number - list.slots}`
          : `Slot #${s.slot_number}`;

        await user.send(
          `🔔 **Reminder:** The event **${list.title}** starts in approximately **5 minutes**${timeStr}!\n` +
          `📅 **Date:** ${fmtDate(list.event_date)}${timeStr}\n` +
          `🗂️ **Category:** ${list.category_name || '–'}${channelStr}\n` +
          `🪑 **Your slot:** ${slotLabel} (${s.status === 'sure' ? '✅ Sure' : s.status === 'maybe' ? '🟡 Maybe' : '🟠 Standby'})\n` +
          `🌐 ${APP_URL}`
        );
        console.log(`📨  DM reminder sent to ${s.discord_id} (${s.nickname}) for list ${list.id}`);
      } catch (err) {
        console.warn(`⚠️  Could not DM user ${s.discord_id} (${s.nickname}): ${err.message}`);
      }
    }

    console.log(`🔔  5-min notification sent for list ${list.id}: ${list.title}`);
  } catch (err) {
    console.error(`5-min notification error for list ${list.id} (${list.title}):`, err.message);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────
async function pollLists() {
  try {
    const upcoming = await apiGet('/api/lists/upcoming');
    const filtered = upcoming.filter(l => categoryAllowed(l.category_name));
    const sorted   = sortLists(filtered);

    // checkNotifications fetches full list data internally for accurate routing
    await checkNotifications(sorted);

    for (const list of sorted) {
      if (!postedLists.has(list.id)) {
        const targetChannelId = channelIdForCategory(list.category_name);
        console.log(`📬  New list: [${list.id}] ${list.title} (${list.category_name}) → channel ${targetChannelId}`);
        await postOrUpdateList(list, list.category_name || '', list.category_color || '#1a4a7a');
        listColors.set(list.id, list.category_color || '#1a4a7a');
      }
    }

    for (const [listId, { messageId, channelId }] of postedLists) {
      const stillExists = sorted.find(l => l.id === listId);
      if (!stillExists) {
        console.log(`🗑️  List ${listId} expired — removing Discord message.`);
        try {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) await msg.delete();
          }
        } catch { /* already gone */ }
        postedLists.delete(listId);
        listColors.delete(listId);
        // Remove ALL notifyKey entries for this listId (covers ID-recycling cases)
        for (const key of notifiedLists) {
          if (key.startsWith(`${listId}|`)) notifiedLists.delete(key);
        }
      }
    }

    // Prune notifiedLists entries whose event time is well in the past (>2h ago)
    // so the Set doesn't grow unbounded over long uptimes
    const TWO_HOURS_AGO = Date.now() - 2 * 60 * 60 * 1000;
    for (const key of notifiedLists) {
      // key format: "id|YYYY-MM-DD|HH:MM"
      const parts = key.split('|');
      if (parts.length === 3) {
        const dt = new Date(`${parts[1]}T${parts[2]}:00`);
        if (!isNaN(dt) && dt.getTime() < TWO_HOURS_AGO) {
          notifiedLists.delete(key);
        }
      }
    }

    await pollRemovalRequests();

  } catch (err) {
    console.error('❌  Poll error:', err.message);
    if (err.message.includes('401') || err.message.includes('Unauthorized')) {
      await ensureAdminSession();
    }
  }
}

// ── Slash Commands ────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('create-list')
    .setDescription('Create a new sign-up list in a category')
    .addStringOption(opt =>
      opt.setName('title').setDescription('Title of the list').setRequired(true))
    .addStringOption(opt =>
      opt.setName('date').setDescription('Event date (YYYY-MM-DD)').setRequired(true))
    .addStringOption(opt =>
      opt.setName('category').setDescription('Category name').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('slots').setDescription('Number of slots (default: 10)').setRequired(false).setMinValue(1).setMaxValue(500))
    .addStringOption(opt =>
      opt.setName('time').setDescription('Event time (HH:MM, optional)').setRequired(false))
    .addStringOption(opt =>
      opt.setName('description').setDescription('Description (optional)').setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('channel').setDescription('Channel number 1-7 (default: 1)').setRequired(false).setMinValue(1).setMaxValue(7))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('list-categories')
    .setDescription('Show all available categories')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('refresh-channel')
    .setDescription('Re-post all active lists for this channel\'s category')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('link-admin')
    .setDescription('Link your Discord account as an admin to receive removal request notifications & DMs')
    .addStringOption(opt =>
      opt.setName('password').setDescription('Admin password').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('unlink-admin')
    .setDescription('Unlink your Discord account from admin notifications')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('list-admins')
    .setDescription('Show all linked Discord admins (admin only)')
    .addStringOption(opt =>
      opt.setName('password').setDescription('Admin password').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('pending-requests')
    .setDescription('Show all pending slot removal requests (admin only)')
    .addStringOption(opt =>
      opt.setName('password').setDescription('Admin password').setRequired(true))
    .toJSON(),
];

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const appId = client.application?.id;
    if (!appId) { console.warn('⚠️  No application ID yet — skipping command registration.'); return; }
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('✅  Slash commands registered.');
  } catch (err) {
    console.error('⚠️  Failed to register slash commands:', err.message);
  }
}

// ── Interaction handler ───────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Slash Commands (usable from ANY channel) ──────────────────────────
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'list-categories') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const cats = await apiGet('/api/categories');
        if (!cats.length) return interaction.editReply('No categories found.');
        const lines = cats.map(c => {
          const chId = channelIdForCategory(c.name);
          const chNote = chId !== DISCORD_CHANNEL_ID
            ? ` → <#${chId}>`
            : ` → <#${DISCORD_CHANNEL_ID}> (fallback)`;
          return `• **${escMd(c.name)}**${c.description ? ` — ${escMd(c.description)}` : ''}${chNote}`;
        });
        const embed = new EmbedBuilder()
          .setColor(0x1a4a7a)
          .setTitle('🗂️ Available Categories')
          .setDescription(lines.join('\n'))
          .setFooter({ text: 'Use /create-list to create a list.' });
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    if (interaction.commandName === 'create-list') {
      await interaction.deferReply({ ephemeral: true });
      const title       = interaction.options.getString('title');
      const dateStr     = interaction.options.getString('date');
      const categoryStr = interaction.options.getString('category');
      const slots       = interaction.options.getInteger('slots')     || 10;
      const timeStr     = interaction.options.getString('time')        || '';
      const description = interaction.options.getString('description') || '';
      const ch          = interaction.options.getInteger('channel')    || 1;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return interaction.editReply('❌ Invalid date format. Use `YYYY-MM-DD`.');
      }
      if (timeStr && !/^\d{2}:\d{2}$/.test(timeStr)) {
        return interaction.editReply('❌ Invalid time format. Use `HH:MM`.');
      }

      try {
        const cats = await apiGet('/api/categories');
        const cat  = cats.find(c => c.name.toLowerCase() === categoryStr.toLowerCase());
        if (!cat) {
          const names = cats.map(c => `\`${c.name}\``).join(', ');
          return interaction.editReply(`❌ Category **${escMd(categoryStr)}** not found.\nAvailable: ${names || 'none'}`);
        }
        const result = await apiPost('/api/lists', {
          category_id: cat.id, title, description, event_date: dateStr, event_time: timeStr, slots, channel: ch,
        });
        if (result.error) return interaction.editReply(`❌ Error: ${result.error}`);

        const targetChannelId = channelIdForCategory(cat.name);
        const embed = new EmbedBuilder()
          .setColor(hexColor(cat.color))
          .setTitle(`✅ List Created: ${title}`)
          .addFields(
            { name: '🗂️ Category', value: cat.name,        inline: true },
            { name: '📅 Date',     value: fmtDate(dateStr), inline: true },
            { name: '🕐 Time',     value: timeStr || '–',   inline: true },
            { name: '🪑 Slots',    value: String(slots),    inline: true },
            { name: '📡 Channel',  value: `Ch. ${ch}`,      inline: true },
            { name: '📢 Posted to', value: `<#${targetChannelId}>`, inline: true },
          )
          .setFooter({ text: 'The list will appear in the channel shortly.' });
        if (description) embed.setDescription(description);
        await interaction.editReply({ embeds: [embed] });
        await pollLists();
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
      return;
    }

    // ── /refresh-channel ────────────────────────────────────────────────
    if (interaction.commandName === 'refresh-channel') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const currentChannelId = String(interaction.channelId);

        console.log(`🔄 refresh-channel called from channel: ${currentChannelId}`);
        console.log(`🗂️  CATEGORY_CHANNEL_MAP:`, CATEGORY_CHANNEL_MAP);

        const upcoming = await apiGet('/api/lists/upcoming');
        console.log(`📋 Total upcoming lists: ${upcoming.length}`);

        const filtered = upcoming
          .filter(l => categoryAllowed(l.category_name))
          .filter(l => listBelongsToChannel(l, currentChannelId));

        console.log(`✅ Lists matching this channel: ${filtered.length}`);

        if (!filtered.length) {
          return interaction.editReply(
            `ℹ️ No active lists found for this channel.\n` +
            `Channel ID: \`${currentChannelId}\`\n` +
            `Mapped categories: \`${JSON.stringify(CATEGORY_CHANNEL_MAP)}\``
          );
        }

        for (const list of filtered) {
          const existing = postedLists.get(list.id);
          if (existing && existing.channelId === currentChannelId) {
            try {
              const ch = await client.channels.fetch(existing.channelId).catch(() => null);
              if (ch) {
                const msg = await ch.messages.fetch(existing.messageId).catch(() => null);
                if (msg) await msg.delete();
              }
            } catch { /* already gone */ }
            postedLists.delete(list.id);
          }
        }

        let count = 0;
        for (const list of sortLists(filtered)) {
          try {
            await postOrUpdateList(list, list.category_name || '', list.category_color || '#1a4a7a');
            listColors.set(list.id, list.category_color || '#1a4a7a');
            count++;
          } catch (err) {
            console.error(`refresh-channel: failed to post list ${list.id}:`, err.message);
          }
        }

        const { mapped } = categoriesForChannel(currentChannelId);
        const catLabel = mapped.length
          ? mapped.map(c => `**${c}**`).join(', ')
          : '*(default)*';

        return interaction.editReply(
          `✅ Re-posted **${count}** list(s) for ${catLabel} in this channel.`
        );

      } catch (err) {
        console.error('refresh-channel error:', err);
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    if (interaction.commandName === 'link-admin') {
      await interaction.deferReply({ ephemeral: true });
      const pw = interaction.options.getString('password') || '';
      if (pw !== APP_ADMIN_PASSWORD) {
        return interaction.editReply('❌ Wrong password. Your Discord account was **not** linked.');
      }
      linkAdmin(interaction.user.id);
      return interaction.editReply(
        `✅ **${escMd(interaction.user.tag)}** is now linked as admin.\n` +
        `You will receive DM notifications for slot removal requests and can approve/deny them directly.\n` +
        `Use \`/unlink-admin\` to remove yourself.`
      );
    }

    if (interaction.commandName === 'unlink-admin') {
      await interaction.deferReply({ ephemeral: true });
      if (!isLinkedAdmin(interaction.user.id)) {
        return interaction.editReply('ℹ️ Your Discord account is not linked as admin.');
      }
      unlinkAdmin(interaction.user.id);
      return interaction.editReply('✅ Your Discord account has been **unlinked** from admin notifications.');
    }

    if (interaction.commandName === 'list-admins') {
      await interaction.deferReply({ ephemeral: true });
      const pw = interaction.options.getString('password') || '';
      if (pw !== APP_ADMIN_PASSWORD) {
        return interaction.editReply('❌ Wrong password.');
      }
      const ids = getLinkedAdminIds();
      if (!ids.length) {
        return interaction.editReply('ℹ️ No Discord admins linked yet. Use `/link-admin` to add yourself.');
      }
      const lines = ids.map((id, i) => {
        const info = adminStore[id];
        return `${i + 1}. <@${id}> (linked: ${new Date(info.linkedAt).toLocaleDateString()})`;
      });
      const embed = new EmbedBuilder()
        .setColor(0x1a4a7a)
        .setTitle('🔑 Linked Discord Admins')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${ids.length} admin(s) linked` });
      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'pending-requests') {
      await interaction.deferReply({ ephemeral: true });
      const pw = interaction.options.getString('password') || '';
      if (pw !== APP_ADMIN_PASSWORD) {
        return interaction.editReply('❌ Wrong password.');
      }
      try {
        const requests = await apiGet('/api/delete-requests');
        if (!requests.length) {
          return interaction.editReply('🎉 No pending removal requests!');
        }
        const embed = new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle('⚠️ Pending Slot Removal Requests')
          .setDescription(requests.map(r =>
            `**#${r.id}** — **${escMd(r.nickname)}** · Slot #${r.slot_number} · ${escMd(r.list_title || `List ${r.list_id}`)} · ${fmtDate(r.event_date)}\n> ${r.reason ? escMd(r.reason) : '_(no reason)_'}`
          ).join('\n\n'))
          .setFooter({ text: `${requests.length} pending request(s)` });

        await interaction.editReply({ embeds: [embed] });

        for (const req of requests) {
          if (!postedRequests.has(req.id) && !processedRequests.has(req.id)) {
            await notifyAdminsOfRequest(req);
          }
        }
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }
  }

  // ── Buttons ─────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith('refresh__')) {
      const listId = parseInt(id.split('__')[1], 10);
      await interaction.deferUpdate();
      await refreshListMessage(listId);
      return;
    }

    if (id.startsWith('signup_sure__') || id.startsWith('signup_maybe__')) {
      const parts  = id.split('__');
      const status = parts[0].replace('signup_', '');
      const listId = parts[1];

      const modal = new ModalBuilder()
        .setCustomId(`modal_signup__${status}__${listId}`)
        .setTitle(status === 'sure' ? '✅  Sign up — Sure' : '🟡  Sign up — Maybe');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nickname')
            .setLabel('Your nickname')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(60)
            .setPlaceholder('e.g. Max'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('slot_number')
            .setLabel('Slot number (empty = auto-assign)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(4)
            .setPlaceholder('e.g. 3  (leave empty for next free slot)'),
        ),
      );

      await interaction.showModal(modal);
      return;
    }

    if (id.startsWith('cancel_request__')) {
      const listId = id.split('__')[1];

      const modal = new ModalBuilder()
        .setCustomId(`modal_cancel__${listId}`)
        .setTitle('❌  Request Slot Cancellation');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nickname')
            .setLabel('Your nickname (must match the slot!)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(60)
            .setPlaceholder('Exactly as signed up'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('slot_number')
            .setLabel('Your slot number')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4)
            .setPlaceholder('e.g. 3'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason for cancellation')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500)
            .setPlaceholder('Why are you cancelling?'),
        ),
      );

      await interaction.showModal(modal);
      return;
    }

    if (id.startsWith('req_accept__')) {
      const requestId = parseInt(id.split('__')[1], 10);

      if (!isLinkedAdmin(interaction.user.id)) {
        await interaction.reply({
          content: `❌ You are not a linked admin. Use \`/link-admin\` with the admin password to link your account.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferUpdate();
      try {
        await apiPost(`/api/delete-requests/${requestId}/accept`, {});
        console.log(`✅  Admin ${interaction.user.tag} accepted removal request ${requestId}`);
        await resolveRequestMessage(requestId, true, interaction.user.tag);

        for (const [listId] of postedLists) {
          try { await refreshListMessage(listId); } catch { /* ignore */ }
        }

        await interaction.followUp({
          content: `✅ Request **#${requestId}** accepted by **${escMd(interaction.user.tag)}** — slot has been removed (and waitlist updated if applicable).`,
          ephemeral: false,
        });
      } catch (err) {
        await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
      }
      return;
    }

    if (id.startsWith('req_deny__')) {
      const requestId = parseInt(id.split('__')[1], 10);

      if (!isLinkedAdmin(interaction.user.id)) {
        await interaction.reply({
          content: `❌ You are not a linked admin. Use \`/link-admin\` with the admin password to link your account.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferUpdate();
      try {
        await apiPost(`/api/delete-requests/${requestId}/deny`, {});
        console.log(`❌  Admin ${interaction.user.tag} denied removal request ${requestId}`);
        await resolveRequestMessage(requestId, false, interaction.user.tag);

        await interaction.followUp({
          content: `❌ Request **#${requestId}** denied by **${escMd(interaction.user.tag)}**.`,
          ephemeral: false,
        });
      } catch (err) {
        await interaction.followUp({ content: `❌ Error: ${err.message}`, ephemeral: true });
      }
      return;
    }
  }

  // ── Modal Submits ────────────────────────────────────────────────────────
  if (interaction.type === InteractionType.ModalSubmit) {

    if (interaction.customId.startsWith('modal_signup__')) {
      const parts    = interaction.customId.split('__');
      const status   = parts[1];
      const listId   = parseInt(parts[2], 10);
      const nickname = interaction.fields.getTextInputValue('nickname').trim();
      const slotRaw  = interaction.fields.getTextInputValue('slot_number').trim();

      await interaction.deferReply({ ephemeral: true });

      try {
        const full    = await apiGet(`/api/lists/${listId}`);
        const signups = full.signups || [];
        const taken   = new Set(signups.map(s => s.slot_number));
        const maxSlotsAllowed = full.slots + 2;

        let slotNumber;
        if (slotRaw) {
          slotNumber = parseInt(slotRaw, 10);
          if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > maxSlotsAllowed) {
            return interaction.editReply({ content: `❌ Invalid slot. Valid range: 1–${maxSlotsAllowed} (including 2 waitlist slots).` });
          }
          if (taken.has(slotNumber)) {
            return interaction.editReply({ content: `❌ Slot #${slotNumber} is taken. Choose another.` });
          }
        } else {
          slotNumber = null;
          for (let i = 1; i <= maxSlotsAllowed; i++) {
            if (!taken.has(i)) { slotNumber = i; break; }
          }
          if (!slotNumber) return interaction.editReply({ content: '❌ All slots and waitlist positions are taken!' });
        }

        const discord_id = interaction.user.id;
        const result = await apiPost(`/api/lists/${listId}/signup`, { slot_number: slotNumber, nickname, status, discord_id });
        if (result.error) return interaction.editReply({ content: `❌ ${result.error}` });

        const isWaitlist = slotNumber > full.slots;
        const emoji = status === 'sure' ? '✅' : '🟡';
        await interaction.editReply({
          content: isWaitlist
            ? `⏳ **${escMd(nickname)}** added to the **Waitlist** (position W${slotNumber - full.slots})!`
            : `${emoji} **${escMd(nickname)}** signed up for **Slot #${slotNumber}** (${status === 'sure' ? 'Sure' : 'Maybe'})!`,
        });
        await refreshListMessage(listId);
      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }

    if (interaction.customId.startsWith('modal_cancel__')) {
      const listId   = parseInt(interaction.customId.split('__')[1], 10);
      const nickname = interaction.fields.getTextInputValue('nickname').trim();
      const slotRaw  = interaction.fields.getTextInputValue('slot_number').trim();
      const reason   = interaction.fields.getTextInputValue('reason').trim();

      await interaction.deferReply({ ephemeral: true });

      const slotNumber = parseInt(slotRaw, 10);
      if (isNaN(slotNumber) || slotNumber < 1) {
        return interaction.editReply({ content: '❌ Invalid slot number.' });
      }

      try {
        const result = await apiPost(
          `/api/lists/${listId}/signup/${slotNumber}/request-delete`,
          { nickname, reason }
        );

        if (result.error) {
          return interaction.editReply({
            content: `❌ **${result.error}**\n\nMake sure your nickname matches **exactly** as it appears in the slot (case-sensitive).`,
          });
        }

        await interaction.editReply({
          content: `✅ Your cancellation request for **Slot #${slotNumber}** has been submitted!\n> Reason: _${escMd(reason)}_\n\nAn admin will review it shortly.`,
        });

        await pollRemovalRequests();

      } catch (err) {
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
      return;
    }
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅  Bot logged in as: ${client.user.tag}`);
  console.log(`📡  Fallback channel:  ${DISCORD_CHANNEL_ID}`);
  console.log(`🔔  Notify channel:    ${DISCORD_NOTIFY_CHANNEL}`);
  console.log(`🔑  Admin channel:     ${DISCORD_ADMIN_CHANNEL}`);
  console.log(`🌐  Web App:           ${APP_URL}`);
  console.log(`👥  Linked admins:     ${getLinkedAdminIds().length}`);

  const mappedCategories = Object.entries(CATEGORY_CHANNEL_MAP);
  if (mappedCategories.length) {
    console.log('🗂️  Category → Channel mappings:');
    for (const [cat, chId] of mappedCategories) console.log(`     "${cat}" → ${chId}`);
  } else {
    console.log('⚠️  No CATEGORY_CHANNEL_MAP — all categories post to fallback channel.');
  }

  if (CATEGORY_FILTER.length) console.log(`🔍  Category filter: ${CATEGORY_FILTER.join(', ')}`);

  await ensureAdminSession();
  await registerSlashCommands();
  await pollLists();
  setInterval(pollLists, POLL_INTERVAL);
});

client.login(DISCORD_TOKEN);