import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage,
    getContentType
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import NodeCache from 'node-cache';
import playdl from 'play-dl';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { createWriteStream, unlink } from 'fs';
import { promisify } from 'util';
import { pipeline } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const streamPipeline = promisify(pipeline);
const unlinkAsync = promisify(unlink);

ffmpeg.setFfmpegPath(ffmpegStatic);

// ========== CONFIG ==========
const DEFAULT_PHONE = process.env.PHONE_NUMBER || '584164707937';

// ========== CACHE ==========
const msgRetryCounterCache = new NodeCache();
const groupMetadataCache = new Map();
const METADATA_TTL = 5 * 60 * 1000;

// ========== FILE PATHS ==========
const DATA_DIR = './data';
const AUTH_DIR = './auth';
const TEMP_DIR = './temp';
const ROLES_FILE = `${DATA_DIR}/roles.json`;
const BOTS_FILE = `${DATA_DIR}/bots.json`;
const PREFIX_FILE = `${DATA_DIR}/prefix.json`;
const GROUP_SETTINGS_FILE = `${DATA_DIR}/group_settings.json`;
const WARNINGS_FILE = `${DATA_DIR}/warnings.json`;

[DATA_DIR, AUTH_DIR, TEMP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ========== DATA HELPERS ==========
function loadJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {}
    return fallback;
}
function saveJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (_) {}
}

function loadRoles() { return loadJSON(ROLES_FILE, { owner: null, admins: [], subAdmins: {} }); }
function saveRoles(r) { saveJSON(ROLES_FILE, r); }
function loadPrefix() { return loadJSON(PREFIX_FILE, { prefix: '!' }).prefix || '!'; }
function savePrefix(p) { saveJSON(PREFIX_FILE, { prefix: p }); }
function loadGroupSettings() { return loadJSON(GROUP_SETTINGS_FILE, {}); }
function saveGroupSettings(s) { saveJSON(GROUP_SETTINGS_FILE, s); }
function loadWarnings() { return loadJSON(WARNINGS_FILE, {}); }
function saveWarnings(w) { saveJSON(WARNINGS_FILE, w); }

// ========== GLOBAL STATE ==========
let roles = loadRoles();
let commandPrefix = loadPrefix();
let groupSettings = loadGroupSettings();
let warningsData = loadWarnings();

// ========== PERMISSION HELPERS ==========
function isOwner(jid) { return roles.owner === jid; }
function isAdmin(jid) { return roles.admins.includes(jid); }
function isSubAdmin(jid, groupJid) { return roles.subAdmins[groupJid]?.includes(jid) || false; }
function isBotStaff(jid, groupJid) { return isOwner(jid) || isAdmin(jid) || isSubAdmin(jid, groupJid); }

function autoSetOwner(jid) {
    if (!roles.owner) { roles.owner = jid; saveRoles(roles); return true; }
    return false;
}
function setOwner(jid) {
    roles.owner = jid; saveRoles(roles); return true;
}
function removeOwner() { roles.owner = null; saveRoles(roles); }
function addAdmin(jid) {
    if (!roles.admins.includes(jid)) { roles.admins.push(jid); saveRoles(roles); return true; }
    return false;
}
function removeAdmin(jid) {
    const idx = roles.admins.indexOf(jid);
    if (idx > -1) { roles.admins.splice(idx, 1); saveRoles(roles); return true; }
    return false;
}
function addSubAdmin(jid, groupJid) {
    if (!roles.subAdmins[groupJid]) roles.subAdmins[groupJid] = [];
    if (!roles.subAdmins[groupJid].includes(jid)) { roles.subAdmins[groupJid].push(jid); saveRoles(roles); return true; }
    return false;
}
function removeSubAdmin(jid, groupJid) {
    if (roles.subAdmins[groupJid]) {
        const idx = roles.subAdmins[groupJid].indexOf(jid);
        if (idx > -1) { roles.subAdmins[groupJid].splice(idx, 1); saveRoles(roles); return true; }
    }
    return false;
}

// ========== GROUP METADATA ==========
async function getGroupMetadataCached(sock, jid) {
    const now = Date.now();
    const cached = groupMetadataCache.get(jid);
    if (cached && (now - cached.timestamp) < METADATA_TTL) return cached.data;
    try {
        const meta = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { data: meta, timestamp: now });
        return meta;
    } catch (_) { return cached ? cached.data : null; }
}

async function isWAGroupAdmin(sock, jid, groupJid) {
    const meta = await getGroupMetadataCached(sock, groupJid);
    if (!meta) return false;
    return meta.participants.some(p => p.id === jid && (p.admin === 'admin' || p.admin === 'superadmin'));
}

// Has permission: bot owner / bot admin / bot sub-admin / WhatsApp group admin
async function hasAnyPermission(sock, senderJid, groupJid) {
    if (isBotStaff(senderJid, groupJid)) return true;
    if (groupJid) return await isWAGroupAdmin(sock, senderJid, groupJid);
    return false;
}

// ========== LINK DETECTION ==========
const WA_GROUP_LINK_REGEX = /chat\.whatsapp\.com\/[A-Za-z0-9]+/i;
const ANY_LINK_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+/i;

// ========== YOUTUBE PLAY ==========
async function downloadYouTubeAudio(query) {
    try {
        const results = await playdl.search(query, { source: { youtube: 'video' }, limit: 1 });
        if (!results || results.length === 0) return null;

        const video = results[0];
        const stream = await playdl.stream(video.url, { quality: 2 });

        const outPath = path.join(TEMP_DIR, `audio_${Date.now()}.mp3`);

        await new Promise((resolve, reject) => {
            ffmpeg(stream.stream)
                .setFfmpegPath(ffmpegStatic)
                .audioCodec('libmp3lame')
                .audioBitrate(128)
                .format('mp3')
                .on('end', resolve)
                .on('error', reject)
                .save(outPath);
        });

        return {
            path: outPath,
            title: video.title || query,
            duration: video.durationRaw || '?',
            url: video.url,
            thumbnail: video.thumbnails?.[0]?.url || null,
            channel: video.channel?.name || 'Unknown'
        };
    } catch (err) {
        console.error('[PLAY] Error:', err.message);
        return null;
    }
}

// ========== MENU ==========
const getMenu = (prefix) => `╔═══❖•ೋ° °ೋ•❖═══╗
       🤖 𝗥𝘆𝗮𝗻 𝗕𝗢𝗧 🤖
╚═══❖•ೋ° °ೋ•❖═══╝

◎ ══════ ❈ ══════ ◎
👑 𝗢𝗪𝗡𝗘𝗥 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
◎ ══════ ❈ ══════ ◎
➕ ${prefix}addadmin @user — Bot Admin add karo
🗑️ ${prefix}removeadmin @user — Bot Admin hatao
📋 ${prefix}listadmins — Sabhi admins dekhao

◎ ══════ ❈ ══════ ◎
👥 𝗦𝗨𝗕-𝗔𝗗𝗠𝗜𝗡 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
◎ ══════ ❈ ══════ ◎
👥 ${prefix}sub @user — Sub-Admin add karo
🚫 ${prefix}removesub @user — Sub-Admin hatao
📋 ${prefix}listsub — List dekhao

◎ ══════ ❈ ══════ ◎
🛡️ 𝗚𝗥𝗢𝗨𝗣 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧
◎ ══════ ❈ ══════ ◎
👋 ${prefix}welcome on/off [msg] — Welcome message
🚪 ${prefix}goodbye on/off [msg] — Goodbye message
🔗 ${prefix}antilink on/off — Link block + auto warn
🔒 ${prefix}lock — Group lock
🔓 ${prefix}unlock — Group unlock
🔇 ${prefix}mute @user [mins] — User mute
🔊 ${prefix}unmute @user — Unmute
👢 ${prefix}kick @user — Nikalo
🚫 ${prefix}ban @user — Ban karo
⚠️ ${prefix}warn @user [reason] — Warning (3=kick)
📋 ${prefix}warns @user — Warnings dekhao
🧹 ${prefix}resetwarns @user — Warnings clear
📛 ${prefix}setsubject <text> — Group name change
📝 ${prefix}setdesc <text> — Description
🖼️ ${prefix}setphoto — Group photo (image reply)
📜 ${prefix}setrules <text> — Rules set
📋 ${prefix}rules — Rules dekhao
🗑️ ${prefix}delete — Message delete (reply)
📊 ${prefix}groupinfo — Group info
👥 ${prefix}admins — WA Admins list
👥 ${prefix}members — Members list
🔔 ${prefix}tagall [msg] — Sabko tag
🤫 ${prefix}hidetag [msg] — Hidden tag
📊 ${prefix}poll Q|opt1|opt2 — Poll banao
🔍 ${prefix}whoishe @user — User ki info

◎ ══════ ❈ ══════ ◎
🎵 𝗠𝗨𝗦𝗜𝗖
◎ ══════ ❈ ══════ ◎
▶️ ${prefix}play <song name> — YouTube music

◎ ══════ ❈ ══════ ◎
🤖 𝗕𝗢𝗧
◎ ══════ ❈ ══════ ◎
🏓 ${prefix}ping — Ping check
🧡 ${prefix}prefix <char> — Prefix change
📋 ${prefix}menu — Yeh menu`;

// ========== COMMAND BUS ==========
class CommandBus {
    constructor() {
        this.botSessions = new Map();
        this.processedMessages = new Map();
    }
    registerBot(id, s) { this.botSessions.set(id, s); }
    unregisterBot(id) { this.botSessions.delete(id); }
    shouldProcessMessage(id) {
        if (this.processedMessages.has(id)) return false;
        this.processedMessages.set(id, Date.now());
        if (this.processedMessages.size > 1000) {
            const old = [...this.processedMessages.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
            for (const [k] of old) this.processedMessages.delete(k);
        }
        return true;
    }
    getAllBots() { return [...this.botSessions.values()]; }
    getConnectedBots() { return [...this.botSessions.values()].filter(b => b.connected); }
    getLeaderBot() { return this.getConnectedBots()[0] || null; }
}

// ========== BOT SESSION ==========
class BotSession {
    constructor(botId, phoneNumber, botManager) {
        this.botId = botId;
        this.phoneNumber = phoneNumber;
        this.botManager = botManager;
        this.sock = null;
        this.connected = false;
        this.botNumber = null;
        this.botNumberJid = null;
        this.authPath = `${AUTH_DIR}/${botId}`;
        this.pairingCodeRequested = false;
        this.reconnectAttempts = 0;
        this.reconnecting = false;
        this.disabled = false;
    }

    async connect() {
        try {
            if (this.reconnecting || this.disabled) return;
            this.reconnecting = true;

            if (!fs.existsSync(this.authPath)) fs.mkdirSync(this.authPath, { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
            const { version } = await fetchLatestBaileysVersion();
            const needsPairing = !state.creds.registered;

            this.sock = makeWASocket({
                auth: state,
                logger: pino({ level: 'silent' }),
                browser: Browsers.macOS('Chrome'),
                version,
                printQRInTerminal: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 30000,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                markOnlineOnConnect: true,
                msgRetryCounterCache,
                shouldIgnoreJid: jid => jid === 'status@broadcast'
            });

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (needsPairing && this.phoneNumber && !this.pairingCodeRequested && !state.creds.registered) {
                    this.pairingCodeRequested = true;
                    await delay(3000);
                    try {
                        const code = await this.sock.requestPairingCode(this.phoneNumber);
                        console.log(`\n==========================================`);
                        console.log(`[${this.botId}] PAIRING CODE: ${code}`);
                        console.log(`Phone: ${this.phoneNumber}`);
                        console.log(`==========================================`);
                        console.log(`WhatsApp > Linked Devices > Link a Device > Enter Code\n`);
                    } catch (err) {
                        console.error(`[${this.botId}] Pairing error:`, err.message);
                        this.pairingCodeRequested = false;
                    }
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error instanceof Boom)
                        ? lastDisconnect.error.output.statusCode : 500;
                    console.log(`[${this.botId}] Closed. Code: ${statusCode}`);
                    this.connected = false;
                    this.reconnecting = false;

                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`[${this.botId}] Logged out. Clearing auth...`);
                        try { fs.rmSync(this.authPath, { recursive: true, force: true }); } catch (_) {}
                        this.botManager.removeBot(this.botId);
                    } else if (!this.disabled) {
                        this.reconnectAttempts++;
                        const wait = Math.min(5000 * Math.pow(1.2, this.reconnectAttempts - 1), 30000);
                        console.log(`[${this.botId}] Reconnecting in ${Math.round(wait / 1000)}s...`);
                        await delay(wait);
                        this.connect();
                    }
                } else if (connection === 'open') {
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    this.reconnecting = false;
                    const userJid = this.sock.user.id;
                    this.botNumberJid = userJid;
                    this.botNumber = userJid.split(':')[0];
                    const cleanJid = `${this.botNumber}@s.whatsapp.net`;

                    // ✅ AUTO-SET OWNER — no need to send !owner
                    if (!roles.owner) {
                        autoSetOwner(cleanJid);
                        console.log(`[${this.botId}] ✅ Connected! Auto-owner set: ${cleanJid}`);
                    } else {
                        console.log(`[${this.botId}] ✅ Connected!`);
                    }
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            // ===== WELCOME / GOODBYE =====
            this.sock.ev.on('group-participants.update', async (update) => {
                try {
                    const leader = this.botManager.commandBus.getLeaderBot();
                    if (!leader || leader.botId !== this.botId) return;

                    const { id, participants, action } = update;
                    const settings = groupSettings[id] || {};

                    for (const participant of participants) {
                        const pNum = participant.split('@')[0];

                        if ((action === 'add' || action === 'invite') && settings.welcome?.enabled) {
                            const meta = await getGroupMetadataCached(this.sock, id);
                            const groupName = meta?.subject || 'Group';
                            const memberCount = meta?.participants?.length || '?';
                            let customMsg = settings.welcome.message || '';

                            let welcomeText = customMsg
                                ? customMsg.replace(/@user/g, `@${pNum}`).replace(/@group/g, groupName)
                                : `╔══════════════════╗\n` +
                                  `║  👋 𝗪𝗘𝗟𝗖𝗢𝗠𝗘!  ║\n` +
                                  `╚══════════════════╝\n\n` +
                                  `🎉 @${pNum} group mein aaye!\n\n` +
                                  `📛 Group: *${groupName}*\n` +
                                  `👥 Members: *${memberCount}*\n\n` +
                                  `📜 Rules dekhne ke liye: *${commandPrefix}rules*\n` +
                                  `📋 Help ke liye: *${commandPrefix}menu*`;

                            await this.sock.sendMessage(id, { text: welcomeText, mentions: [participant] });
                        }

                        if ((action === 'remove' || action === 'leave') && settings.goodbye?.enabled) {
                            let goodbyeText = settings.goodbye.message
                                ? settings.goodbye.message.replace(/@user/g, `@${pNum}`)
                                : `╔══════════════════╗\n` +
                                  `║  👋 𝗔𝗟𝗩𝗜𝗗𝗔!  ║\n` +
                                  `╚══════════════════╝\n\n` +
                                  `😢 @${pNum} ne group chod diya.\n` +
                                  `Hum unhe miss karenge!`;

                            await this.sock.sendMessage(id, { text: goodbyeText, mentions: [participant] });
                        }
                    }
                } catch (_) {}
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                try { await this.handleMessage(m); } catch (err) {
                    console.error(`[${this.botId}] Msg error:`, err.message);
                }
            });

        } catch (err) {
            console.error(`[${this.botId}] Connection error:`, err.message);
            this.reconnecting = false;
            if (!this.disabled) { await delay(5000); this.connect(); }
        }
    }

    async sendMessage(jid, content) {
        try {
            if (this.sock && this.connected) return await this.sock.sendMessage(jid, content);
        } catch (err) { console.error('sendMessage error:', err.message); }
    }

    async reply(msg, text) {
        const from = msg.key.remoteJid;
        try {
            await this.sock.sendMessage(from, { text }, { quoted: msg });
        } catch (_) {}
    }

    async handleMessage({ messages, type }) {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? (msg.key.participant || from) : from;
        const msgId = msg.key.id;

        if (!this.botManager.commandBus.shouldProcessMessage(msgId)) return;

        const isLeader = this.botManager.commandBus.getLeaderBot()?.botId === this.botId;
        if (isGroup && !isLeader) return;

        // Extract text
        let text = '';
        const msgType = getContentType(msg.message);
        if (msgType === 'conversation') text = msg.message.conversation;
        else if (msgType === 'extendedTextMessage') text = msg.message.extendedTextMessage?.text || '';
        else if (msgType === 'imageMessage') text = msg.message.imageMessage?.caption || '';
        else if (msgType === 'videoMessage') text = msg.message.videoMessage?.caption || '';

        text = text.trim();

        // ====== GROUP PRE-CHECKS ======
        if (isGroup) {
            const settings = groupSettings[from] || {};
            const senderIsWAAdmin = await isWAGroupAdmin(this.sock, sender, from);
            const senderIsBotStaff = isBotStaff(sender, from);
            const senderHasAny = senderIsWAAdmin || senderIsBotStaff;

            // Lock check
            if (settings.locked && !senderHasAny) {
                try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                return;
            }

            // Mute check
            const muteExpiry = settings.muted?.[sender];
            if (muteExpiry) {
                if (Date.now() < muteExpiry) {
                    try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (_) {}
                    return;
                } else {
                    if (!groupSettings[from]) groupSettings[from] = {};
                    delete groupSettings[from].muted?.[sender];
                    saveGroupSettings(groupSettings);
                }
            }

            // Antilink check
            if (settings.antilink && !senderHasAny) {
                const hasWALink = WA_GROUP_LINK_REGEX.test(text);
                const hasAnyLink = settings.antilink === 'all' ? ANY_LINK_REGEX.test(text) : hasWALink;

                if (hasWALink || hasAnyLink) {
                    try { await this.sock.sendMessage(from, { delete: msg.key }); } catch (_) {}

                    // Auto-warn
                    if (!warningsData[from]) warn
