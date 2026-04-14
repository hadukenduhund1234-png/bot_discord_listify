/**
 * Chronomancer's Book — Discord Bot
 * ====================================
 * Automatically posts new lists as embeds in Discord.
 * Users can sign up directly via buttons (Sure ✅ / Maybe 🟡).
 *
 * Environment variables (set in Railway dashboard):
 *   DISCORD_TOKEN            — Bot Token (Discord Developer Portal)
 *   DISCORD_CHANNEL_ID       — Channel ID where lists are posted
 *   APP_URL                  — URL of your Railway web app (e.g. https://your-app.railway.app)
 *   APP_ADMIN_PASSWORD       — Admin password of the web app
 *   BOT_POLL_INTERVAL_MS     — How often to check for new lists (default: 10000)
 *   BOT_CATEGORY_FILTER      — Optional: comma-separated category names to post
 *                              (e.g. "Gaming,Events") — leave empty to post ALL categories
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
} = require('discord.js');

// ── Config ────────────────────────────────────────────────────────────────
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN        || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID   || '';
const APP_URL            = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const APP_ADMIN_PASSWORD = process.env.APP_ADMIN_PASSWORD   || 'admin123';
const POLL_INTERVAL      = parseInt(process.env.BOT_POLL_INTERVAL_MS || '10000', 10);

// Category filter — set BOT_CATEGORY_FILTER="Gaming,Events" to only post those categories.
// Leave the env var empty or unset to post ALL categories.
const CATEGORY_FILTER_RAW = process.env.BOT_CATEGORY_FILTER || '';
const CATEGORY_FILTER = CATEGORY_FILTER_RAW
  ? CATEGORY_FILTER_RAW.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : [];

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error('❌  DISCORD_TOKEN and DISCORD_CHANNEL_ID must be set.');
  process.exit(1);
}

if (CATEGORY_FILTER.length) {
  console.log(`🔍  Category filter active: ${CATEGORY_FILTER.join(', ')}`);
} else {
  console.log('🔍  No category filter — posting all categories.');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────
// Native fetch (Node 18+) or node-fetch fallback
const nodeFetch = (() => {
  if (typeof fetch !== 'undefined') return fetch.bind(globalThis);
  try { return require('node-fetch'); } catch { return null; }
})();

if (!nodeFetch) {
  console.error('❌  No fetch available. Run: npm install node-fetch  (or use Node 18+)');
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/** Log in to the web-app to get an admin session cookie */
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
/** Map<listId, discordMessageId> */
const postedLists = new Map();

/** Map<listId, categoryColor> */
const listColors = new Map();

// ── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ── Helpers ───────────────────────────────────────────────────────────────
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

/** Returns true if the list's category passes the filter */
function categoryAllowed(categoryName) {
  if (!CATEGORY_FILTER.length) return true;
  return CATEGORY_FILTER.includes((categoryName || '').toLowerCase());
}

/** Build a Discord embed for a list */
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

  // Split into columns of max 20 (Discord embed field limit)
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
    .setFooter({ text: `${catName} · Chronomancer's Book` })
    .setTimestamp();

  return embed;
}

function buildProgressBar(pct) {
  const filled = Math.round(pct / 10);
  const empty  = 10 - filled;
  const bar    = '█'.repeat(filled) + '░'.repeat(empty);
  const color  = pct >= 100 ? '🔴' : pct >= 70 ? '🟡' : '🟢';
  return `${color} \`${bar}\` ${pct}%`;
}

function escMd(str) {
  return String(str).replace(/([*_`~|\\])/g, '\\$1');
}

/** Build action row with signup buttons */
function buildButtons(listId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`signup_sure__${listId}`)
      .setLabel('✅  Sure — I\'m in!')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`signup_maybe__${listId}`)
      .setLabel('🟡  Maybe — Not sure yet')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`refresh__${listId}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setURL(`${APP_URL}`)
      .setLabel('🌐 Open Web App')
      .setStyle(ButtonStyle.Link),
  );
}

// ── Post / Update messages ────────────────────────────────────────────────
async function postOrUpdateList(list, catName, catColor) {
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  if (!channel) return;

  let signups = [];
  try {
    const full = await apiGet(`/api/lists/${list.id}`);
    signups = full.signups || [];
  } catch { /* ignore */ }

  const embed   = buildEmbed(list, signups, catName, catColor);
  const buttons = buildButtons(list.id);

  if (postedLists.has(list.id)) {
    try {
      const msg = await channel.messages.fetch(postedLists.get(list.id));
      await msg.edit({ embeds: [embed], components: [buttons] });
    } catch {
      // Message was deleted — repost
      const msg = await channel.send({ embeds: [embed], components: [buttons] });
      postedLists.set(list.id, msg.id);
    }
  } else {
    const msg = await channel.send({ embeds: [embed], components: [buttons] });
    postedLists.set(list.id, msg.id);
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

// ── Polling ───────────────────────────────────────────────────────────────
async function pollLists() {
  try {
    const upcoming = await apiGet('/api/lists/upcoming');

    for (const list of upcoming) {
      // Apply category filter
      if (!categoryAllowed(list.category_name)) continue;

      if (!postedLists.has(list.id)) {
        console.log(`📬  New list detected: [${list.id}] ${list.title} (${list.category_name})`);
        await postOrUpdateList(list, list.category_name || '', list.category_color || '#1a4a7a');
        listColors.set(list.id, list.category_color || '#1a4a7a');
      }
    }

    // Remove messages for lists that no longer exist or are now filtered out
    for (const [listId, msgId] of postedLists) {
      const stillExists = upcoming.find(l => l.id === listId && categoryAllowed(l.category_name));
      if (!stillExists) {
        console.log(`🗑️  List ${listId} expired or filtered — removing Discord message.`);
        try {
          const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
          const msg     = await channel.messages.fetch(msgId);
          await msg.delete();
        } catch { /* already gone */ }
        postedLists.delete(listId);
        listColors.delete(listId);
      }
    }
  } catch (err) {
    console.error('❌  Poll error:', err.message);
    if (err.message.includes('401') || err.message.includes('Unauthorized')) {
      await ensureAdminSession();
    }
  }
}

// ── Interaction handler ───────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Button clicks ──────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;

    // Refresh button
    if (id.startsWith('refresh__')) {
      const listId = parseInt(id.split('__')[1], 10);
      await interaction.deferUpdate();
      await refreshListMessage(listId);
      return;
    }

    // Signup buttons — open modal
    if (id.startsWith('signup_sure__') || id.startsWith('signup_maybe__')) {
      const parts  = id.split('__');
      const status = parts[0].replace('signup_', ''); // 'sure' or 'maybe'
      const listId = parts[1];

      const modal = new ModalBuilder()
        .setCustomId(`modal_signup__${status}__${listId}`)
        .setTitle(status === 'sure' ? '✅  Sign up — Sure' : '🟡  Sign up — Maybe');

      const nicknameInput = new TextInputBuilder()
        .setCustomId('nickname')
        .setLabel('Your nickname')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(60)
        .setPlaceholder('e.g. Max');

      const slotInput = new TextInputBuilder()
        .setCustomId('slot_number')
        .setLabel('Slot number (leave empty = auto-assign)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(4)
        .setPlaceholder('e.g. 3  (leave empty for next free slot)');

      modal.addComponents(
        new ActionRowBuilder().addComponents(nicknameInput),
        new ActionRowBuilder().addComponents(slotInput),
      );

      await interaction.showModal(modal);
      return;
    }
  }

  // ── Modal submits ──────────────────────────────────────────────────────
  if (interaction.type === InteractionType.ModalSubmit) {
    if (interaction.customId.startsWith('modal_signup__')) {
      const parts    = interaction.customId.split('__');
      const status   = parts[1]; // 'sure' or 'maybe'
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
            return interaction.editReply({ content: `❌ Invalid slot number. Valid range: 1–${full.slots}.` });
          }
          if (taken.has(slotNumber)) {
            return interaction.editReply({ content: `❌ Slot #${slotNumber} is already taken. Please choose another.` });
          }
        } else {
          slotNumber = null;
          for (let i = 1; i <= full.slots; i++) {
            if (!taken.has(i)) { slotNumber = i; break; }
          }
          if (!slotNumber) {
            return interaction.editReply({ content: '❌ All slots are already taken!' });
          }
        }

        const result = await apiPost(`/api/lists/${listId}/signup`, {
          slot_number: slotNumber,
          nickname,
          status,
        });

        if (result.error) {
          return interaction.editReply({ content: `❌ Error: ${result.error}` });
        }

        const emoji = status === 'sure' ? '✅' : '🟡';
        await interaction.editReply({
          content: `${emoji} **${nickname}** signed up for **Slot #${slotNumber}**! (${status === 'sure' ? 'Sure' : 'Maybe'})`,
        });

        await refreshListMessage(listId);

      } catch (err) {
        console.error('Signup error:', err.message);
        await interaction.editReply({ content: `❌ Error signing up: ${err.message}` });
      }

      return;
    }
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅  Discord Bot logged in as: ${client.user.tag}`);
  console.log(`📡  Channel: ${DISCORD_CHANNEL_ID}`);
  console.log(`🌐  Web App: ${APP_URL}`);

  await ensureAdminSession();
  await pollLists();
  setInterval(pollLists, POLL_INTERVAL);
});

client.login(DISCORD_TOKEN);
