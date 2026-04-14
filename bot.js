/**
 * Chronomancer's Book — Discord Bot (Enhanced)
 * =============================================
 * - Posts new lists as embeds, sorted by time & category
 * - Each category posts into its own Discord channel
 * - Users can create lists via /create-list slash command
 * - 5-minute pre-event notifications
 *
 * Environment variables:
 *   DISCORD_TOKEN              — Bot Token
 *   DISCORD_CHANNEL_ID         — Fallback channel (used if no category-channel match)
 *   DISCORD_NOTIFY_CHANNEL_ID  — Channel for notifications (falls back to DISCORD_CHANNEL_ID)
 *   CATEGORY_CHANNEL_MAP       — JSON map of category name (lowercase) → channel ID
 *                                e.g. '{"raids":"123456","pvp":"789012","events":"345678"}'
 *   APP_URL                    — Web app URL
 *   APP_ADMIN_PASSWORD         — Admin password
 *   BOT_POLL_INTERVAL_MS       — Poll interval (default: 10000)
 *   BOT_CATEGORY_FILTER        — Comma-separated category names to filter (empty = all)
 */

'use strict';

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
const DISCORD_TOKEN          = process.env.DISCORD_TOKEN           || '';
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID      || '';
const DISCORD_NOTIFY_CHANNEL = process.env.DISCORD_NOTIFY_CHANNEL_ID || DISCORD_CHANNEL_ID;
const APP_URL                = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const APP_ADMIN_PASSWORD     = process.env.APP_ADMIN_PASSWORD      || 'admin123';
const POLL_INTERVAL          = parseInt(process.env.BOT_POLL_INTERVAL_MS || '10000', 10);
const CATEGORY_FILTER_RAW    = process.env.BOT_CATEGORY_FILTER     || '';
const CATEGORY_FILTER        = CATEGORY_FILTER_RAW
  ? CATEGORY_FILTER_RAW.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

/**
 * CATEGORY_CHANNEL_MAP — maps category name (lowercase) → Discord channel ID.
 *
 * Set via environment variable as JSON, e.g.:
 *   CATEGORY_CHANNEL_MAP='{"raids":"1234567890","pvp":"0987654321","events":"1122334455"}'
 *
 * Category names are matched case-insensitively against the list's category_name.
 * If no match is found, DISCORD_CHANNEL_ID is used as fallback.
 */
let CATEGORY_CHANNEL_MAP = {};
try {
  const raw = process.env.CATEGORY_CHANNEL_MAP || '{}';
  const parsed = JSON.parse(raw);
  // Normalise all keys to lowercase for case-insensitive matching
  for (const [k, v] of Object.entries(parsed)) {
    CATEGORY_CHANNEL_MAP[k.toLowerCase()] = String(v);
  }
} catch (err) {
  console.error('⚠️  CATEGORY_CHANNEL_MAP is not valid JSON — using fallback channel for all categories.');
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
/** Map<listId, { messageId: string, channelId: string }> */
const postedLists   = new Map();
/** Map<listId, categoryColor> */
const listColors    = new Map();
/** Set<listId> — lists that already got a 5-min notification */
const notifiedLists = new Set();

// ── Discord Client ────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve the Discord channel ID for a given category name.
 * Matching is case-insensitive. Falls back to DISCORD_CHANNEL_ID.
 */
function channelIdForCategory(categoryName) {
  const key = (categoryName || '').toLowerCase();
  return CATEGORY_CHANNEL_MAP[key] || DISCORD_CHANNEL_ID;
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

/** Sort lists: first by date, then by time (untimed lists last within same date), then by category */
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

/** Get event datetime as Date object */
function getEventDt(list) {
  if (!list.event_date || !list.event_time) return null;
  return new Date(`${list.event_date}T${list.event_time}:00`);
}

// ── Embed builder ─────────────────────────────────────────────────────────
function buildEmbed(list, signups, catName, catColor) {
  const filled     = signups.filter(s => s.status !== 'standby').length;
  const free       = list.slots - filled;
  const pct        = list.slots ? Math.round((filled / list.slots) * 100) : 0;
  const bar        = buildProgressBar(pct);
  const timeStr    = list.event_time ? ` · 🕐 ${list.event_time}` : '';
  const channelStr = list.channel    ? ` · 📡 Ch. ${list.channel}` : '';

  const slotLines = Array.from({ length: list.slots }, (_, i) => {
    const n      = i + 1;
    const signup = signups.find(s => s.slot_number === n);
    if (!signup) return `\`#${String(n).padStart(2, '0')}\` ░ free`;
    return `\`#${String(n).padStart(2, '0')}\` ${slotStatusEmoji(signup.status)} **${escMd(signup.nickname)}**`;
  });

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
      .setCustomId(`refresh__${listId}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setURL(APP_URL)
      .setLabel('🌐 Web App')
      .setStyle(ButtonStyle.Link),
  );
}

// ── Post / Update messages ────────────────────────────────────────────────
async function postOrUpdateList(list, catName, catColor) {
  // Determine which Discord channel to use for this category
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
    // If the category (and therefore channel) changed, delete the old message and repost
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
      // Edit in place
      try {
        const msg = await channel.messages.fetch(existing.messageId);
        await msg.edit({ embeds: [embed], components: [buttons] });
      } catch {
        // Message gone — repost
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

// ── 5-minute notifications ────────────────────────────────────────────────
async function checkNotifications(lists) {
  const now    = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const WINDOW   = 60 * 1000;

  for (const list of lists) {
    if (notifiedLists.has(list.id)) continue;
    const dt = getEventDt(list);
    if (!dt) continue;
    const ms = dt.getTime() - now;
    if (ms > 0 && ms <= FIVE_MIN + WINDOW) {
      notifiedLists.add(list.id);

      try {
        const notifyChannel = await client.channels.fetch(DISCORD_NOTIFY_CHANNEL);
        if (!notifyChannel) continue;

        const full    = await apiGet(`/api/lists/${list.id}`);
        const signups = full.signups || [];
        const filled  = signups.filter(s => s.status !== 'standby').length;
        const free    = list.slots - filled;

        const participantNames = signups
          .filter(s => s.status !== 'standby')
          .map(s => escMd(s.nickname))
          .join(', ') || '–';

        const embed = new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle(`⏰ Starting in ~5 minutes: **${list.title}**`)
          .addFields(
            { name: '📅 Date & Time', value: `${fmtDate(list.event_date)} 🕐 ${list.event_time}`, inline: true },
            { name: '🗂️ Category',    value: list.category_name || '–',                           inline: true },
            { name: '🪑 Slots',       value: `${filled}/${list.slots} filled (${free} free)`,     inline: true },
            { name: '👥 Participants', value: participantNames,                                    inline: false },
          )
          .setFooter({ text: 'Chronomancer\'s Book — Notification' })
          .setTimestamp();

        const linkBtn = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setURL(APP_URL)
            .setLabel('🌐 Open Web App')
            .setStyle(ButtonStyle.Link),
        );

        await notifyChannel.send({
          content: `🚨 **Event starting soon!** ${free > 0 ? `${free} slot(s) still open!` : 'Fully booked!'}`,
          embeds: [embed],
          components: [linkBtn],
        });

        console.log(`🔔  5-min notification sent for list ${list.id}: ${list.title}`);
      } catch (err) {
        console.error('Notification error:', err.message);
      }
    }
  }
}

// ── Polling ───────────────────────────────────────────────────────────────
async function pollLists() {
  try {
    const upcoming = await apiGet('/api/lists/upcoming');
    const filtered = upcoming.filter(l => categoryAllowed(l.category_name));
    const sorted   = sortLists(filtered);

    await checkNotifications(sorted);

    for (const list of sorted) {
      if (!postedLists.has(list.id)) {
        const targetChannelId = channelIdForCategory(list.category_name);
        console.log(`📬  New list: [${list.id}] ${list.title} (${list.category_name}) → channel ${targetChannelId}`);
        await postOrUpdateList(list, list.category_name || '', list.category_color || '#1a4a7a');
        listColors.set(list.id, list.category_color || '#1a4a7a');
      }
    }

    // Remove messages for expired/filtered lists
    for (const [listId, { messageId, channelId }] of postedLists) {
      const stillExists = sorted.find(l => l.id === listId);
      if (!stillExists) {
        console.log(`🗑️  List ${listId} expired — removing Discord message from channel ${channelId}.`);
        try {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) await msg.delete();
          }
        } catch { /* already gone */ }
        postedLists.delete(listId);
        listColors.delete(listId);
        notifiedLists.delete(listId);
      }
    }
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

  // ── Slash commands ─────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {

    // /list-categories
    if (interaction.commandName === 'list-categories') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const cats = await apiGet('/api/categories');
        if (!cats.length) {
          return interaction.editReply('No categories found.');
        }
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
          .setFooter({ text: 'Use /create-list to create a list in one of these categories.' });
        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ Error: ${err.message}`);
      }
    }

    // /create-list
    if (interaction.commandName === 'create-list') {
      await interaction.deferReply({ ephemeral: true });

      const title       = interaction.options.getString('title');
      const dateStr     = interaction.options.getString('date');
      const categoryStr = interaction.options.getString('category');
      const slots       = interaction.options.getInteger('slots')      || 10;
      const timeStr     = interaction.options.getString('time')         || '';
      const description = interaction.options.getString('description')  || '';
      const ch          = interaction.options.getInteger('channel')     || 1;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return interaction.editReply('❌ Invalid date format. Use `YYYY-MM-DD` (e.g. `2025-12-31`).');
      }
      if (timeStr && !/^\d{2}:\d{2}$/.test(timeStr)) {
        return interaction.editReply('❌ Invalid time format. Use `HH:MM` (e.g. `14:30`).');
      }

      try {
        const cats = await apiGet('/api/categories');
        const cat  = cats.find(c => c.name.toLowerCase() === categoryStr.toLowerCase());

        if (!cat) {
          const names = cats.map(c => `\`${c.name}\``).join(', ');
          return interaction.editReply(
            `❌ Category **${escMd(categoryStr)}** not found.\nAvailable: ${names || 'none'}\n\nUse \`/list-categories\` to see all options.`
          );
        }

        const result = await apiPost('/api/lists', {
          category_id: cat.id,
          title,
          description,
          event_date: dateStr,
          event_time: timeStr,
          slots,
          channel: ch,
        });

        if (result.error) {
          return interaction.editReply(`❌ Error: ${result.error}`);
        }

        const targetChannelId = channelIdForCategory(cat.name);

        const embed = new EmbedBuilder()
          .setColor(hexColor(cat.color))
          .setTitle(`✅ List Created: ${title}`)
          .addFields(
            { name: '🗂️ Category', value: cat.name,               inline: true },
            { name: '📅 Date',     value: fmtDate(dateStr),       inline: true },
            { name: '🕐 Time',     value: timeStr || '–',         inline: true },
            { name: '🪑 Slots',    value: String(slots),          inline: true },
            { name: '📡 Channel',  value: `Ch. ${ch}`,            inline: true },
            { name: '📢 Posted to', value: `<#${targetChannelId}>`, inline: true },
          )
          .setFooter({ text: 'The list will appear in the channel shortly.' });

        if (description) embed.setDescription(description);

        await interaction.editReply({ embeds: [embed] });

        await pollLists();

      } catch (err) {
        console.error('create-list error:', err.message);
        return interaction.editReply(`❌ Error: ${err.message}`);
      }

      return;
    }
  }

  // ── Button clicks ──────────────────────────────────────────────────────
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
  }

  // ── Modal submits ──────────────────────────────────────────────────────
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

        let slotNumber;
        if (slotRaw) {
          slotNumber = parseInt(slotRaw, 10);
          if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > full.slots) {
            return interaction.editReply({ content: `❌ Invalid slot. Valid range: 1–${full.slots}.` });
          }
          if (taken.has(slotNumber)) {
            return interaction.editReply({ content: `❌ Slot #${slotNumber} is taken. Choose another.` });
          }
        } else {
          slotNumber = null;
          for (let i = 1; i <= full.slots; i++) {
            if (!taken.has(i)) { slotNumber = i; break; }
          }
          if (!slotNumber) {
            return interaction.editReply({ content: '❌ All slots are taken!' });
          }
        }

        const result = await apiPost(`/api/lists/${listId}/signup`, {
          slot_number: slotNumber,
          nickname,
          status,
        });

        if (result.error) {
          return interaction.editReply({ content: `❌ ${result.error}` });
        }

        const emoji = status === 'sure' ? '✅' : '🟡';
        await interaction.editReply({
          content: `${emoji} **${escMd(nickname)}** signed up for **Slot #${slotNumber}** (${status === 'sure' ? 'Sure' : 'Maybe'})!`,
        });

        await refreshListMessage(listId);

      } catch (err) {
        console.error('Signup modal error:', err.message);
        await interaction.editReply({ content: `❌ Error: ${err.message}` });
      }
    }
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅  Bot logged in as: ${client.user.tag}`);
  console.log(`📡  Fallback channel: ${DISCORD_CHANNEL_ID}`);
  console.log(`🔔  Notify channel:   ${DISCORD_NOTIFY_CHANNEL}`);
  console.log(`🌐  Web App:          ${APP_URL}`);

  const mappedCategories = Object.entries(CATEGORY_CHANNEL_MAP);
  if (mappedCategories.length) {
    console.log('🗂️  Category → Channel mappings:');
    for (const [cat, chId] of mappedCategories) {
      console.log(`     "${cat}" → ${chId}`);
    }
  } else {
    console.log('⚠️  No CATEGORY_CHANNEL_MAP set — all categories post to fallback channel.');
  }

  if (CATEGORY_FILTER.length) console.log(`🔍  Category filter: ${CATEGORY_FILTER.join(', ')}`);

  await ensureAdminSession();
  await registerSlashCommands();
  await pollLists();
  setInterval(pollLists, POLL_INTERVAL);
});

client.login(DISCORD_TOKEN);