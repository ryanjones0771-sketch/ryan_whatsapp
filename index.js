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
                    if (!warningsData[from]) warningsData[from] = {};
                    if (!warningsData[from][sender]) warningsData[from][sender] = [];
                    warningsData[from][sender].push({ reason: 'Link share kiya', time: Date.now() });
                    saveWarnings(warningsData);
                    const warnCount = warningsData[from][sender].length;

                    await this.sendMessage(from, {
                        text: `🚫 *LINK NOT ALLOWED!*\n\n@${sender.split('@')[0]} ne link share kiya.\n⚠️ Warning ${warnCount}/3 di gayi!\n\n${warnCount >= 3 ? '❌ 3 warnings complete — Auto-kick!' : ''}`,
                        mentions: [sender]
                    });

                    if (warnCount >= 3) {
                        try { await this.sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch (_) {}
                        if (warningsData[from]) delete warningsData[from][sender];
                        saveWarnings(warningsData);
                    }
                    return;
                }
            }
        }

        // ====== COMMAND CHECK ======
        if (!text.startsWith(commandPrefix)) return;

        const args = text.slice(commandPrefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const fullArgs = args.join(' ').trim();
        const isDM = !isGroup;

        const senderIsOwner = isOwner(sender);
        const senderIsAdmin = isAdmin(sender);
        const senderIsSubAdmin = isGroup ? isSubAdmin(sender, from) : false;
        const senderIsBotStaff = senderIsOwner || senderIsAdmin || senderIsSubAdmin;
        const senderIsWAAdmin = isGroup ? await isWAGroupAdmin(this.sock, sender, from) : false;
        const senderHasPermission = senderIsBotStaff || senderIsWAAdmin;

        // Quoted / mentioned helpers
        const ctx = msg.message?.extendedTextMessage?.contextInfo;
        const mentionedJids = ctx?.mentionedJid || [];
        const quotedParticipant = ctx?.participant;
        const targetJid = mentionedJids[0] || quotedParticipant || null;

        // ========== MENU ==========
        if (command === 'menu' || command === 'help') {
            await this.reply(msg, getMenu(commandPrefix));
            return;
        }

        // ========== PING ==========
        if (command === 'ping') {
            const start = Date.now();
            await this.sendMessage(from, { text: '🏓 Pinging...' });
            await this.reply(msg, `🏓 *Pong!*\n📶 Latency: *${Date.now() - start}ms*`);
            return;
        }

        // ========== OWNER COMMANDS ==========
        if (command === 'removeowner') {
            if (!senderIsOwner) { await this.reply(msg, '👑 Aap Bot Owner nahi hain!'); return; }
            removeOwner();
            await this.reply(msg, '✅ Owner removed. Dobara connect hone par auto-set hoga.');
            return;
        }

        if (command === 'addadmin') {
            if (!senderIsOwner) { await this.reply(msg, '👑 Sirf Bot Owner kar sakta hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ Kisi ko @mention karo ya reply karo'); return; }
            const r = addAdmin(targetJid);
            await this.reply(msg, r ? `✅ *Bot Admin Added!*\n@${targetJid.split('@')[0]}` : '⚠️ Pehle se Admin hai');
            return;
        }

        if (command === 'removeadmin') {
            if (!senderIsOwner && !senderIsAdmin) { await this.reply(msg, '👑 Sirf Owner/Admin kar sakta hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ Kisi ko @mention karo ya reply karo'); return; }
            const r = removeAdmin(targetJid);
            await this.reply(msg, r ? `✅ *Bot Admin Removed!*\n@${targetJid.split('@')[0]}` : '❌ Yeh Admin nahi hai');
            return;
        }

        if (command === 'listadmins') {
            const owner = roles.owner ? `+${roles.owner.replace('@s.whatsapp.net', '')}` : 'None';
            let list = `👑 *Bot Owner:* ${owner}\n\n📋 *Bot Admins (${roles.admins.length}):*\n`;
            list += roles.admins.length > 0 ? roles.admins.map(a => `• +${a.replace('@s.whatsapp.net', '')}`).join('\n') : 'Koi nahi';
            await this.reply(msg, list);
            return;
        }

        // ========== SUB-ADMIN ==========
        if (command === 'sub') {
            if (!isGroup) { await this.reply(msg, '⚠️ Group mein use karo!'); return; }
            if (!senderIsOwner && !senderIsAdmin && !senderIsWAAdmin) {
                await this.reply(msg, '❌ Permission nahi hai!'); return;
            }
            if (!targetJid) { await this.reply(msg, '⚠️ Kisi ko @mention karo ya reply karo'); return; }
            const r = addSubAdmin(targetJid, from);
            await this.reply(msg, r ? `✅ *Sub-Admin Added!*\n@${targetJid.split('@')[0]}` : '⚠️ Pehle se Sub-Admin hai');
            return;
        }

        if (command === 'removesub') {
            if (!isGroup) { await this.reply(msg, '⚠️ Group mein use karo!'); return; }
            if (!senderIsOwner && !senderIsAdmin && !senderIsWAAdmin) {
                await this.reply(msg, '❌ Permission nahi hai!'); return;
            }
            if (!targetJid) { await this.reply(msg, '⚠️ Kisi ko @mention karo ya reply karo'); return; }
            const r = removeSubAdmin(targetJid, from);
            await this.reply(msg, r ? `✅ *Sub-Admin Removed!*\n@${targetJid.split('@')[0]}` : '❌ Yeh Sub-Admin nahi hai');
            return;
        }

        if (command === 'listsub') {
            if (!isGroup) { await this.reply(msg, '⚠️ Group mein use karo!'); return; }
            const subs = roles.subAdmins[from] || [];
            const list = subs.length > 0 ? subs.map(s => `• +${s.replace('@s.whatsapp.net', '')}`).join('\n') : 'Koi nahi';
            await this.reply(msg, `📋 *Sub-Admins:*\n${list}`);
            return;
        }

        // ========== PREFIX ==========
        if (command === 'prefix') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!args[0]) { await this.reply(msg, `📌 Current prefix: *${commandPrefix}*`); return; }
            commandPrefix = args[0].trim()[0];
            savePrefix(commandPrefix);
            await this.reply(msg, `✅ Prefix badal gaya: *${commandPrefix}*`);
            return;
        }

        // ========== PLAY COMMAND ==========
        if (command === 'play') {
            if (!fullArgs) { await this.reply(msg, '🎵 Use: !play <song name>'); return; }
            await this.reply(msg, `🔍 *Searching:* ${fullArgs}\n⏳ Please wait...`);

            try {
                const result = await downloadYouTubeAudio(fullArgs);
                if (!result) {
                    await this.reply(msg, '❌ Song nahi mila. Dusra naam try karo.');
                    return;
                }

                const audioBuffer = fs.readFileSync(result.path);
                await this.sendMessage(from, {
                    audio: audioBuffer,
                    mimetype: 'audio/mpeg',
                    ptt: false,
                    fileName: `${result.title}.mp3`
                });

                await this.sendMessage(from, {
                    text: `🎵 *${result.title}*\n` +
                          `👤 Channel: ${result.channel}\n` +
                          `⏱️ Duration: ${result.duration}\n` +
                          `🔗 ${result.url}`
                });

                try { await unlinkAsync(result.path); } catch (_) {}
            } catch (err) {
                console.error('[PLAY] Error:', err.message);
                await this.reply(msg, `❌ Error: ${err.message}`);
            }
            return;
        }

        // ========== GROUP ONLY COMMANDS ==========
        if (!isGroup) {
            await this.reply(msg, '⚠️ Yeh command sirf group mein use karo!');
            return;
        }

        const settings = groupSettings[from] || {};

        // ===== WELCOME =====
        if (command === 'welcome') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!groupSettings[from]) groupSettings[from] = {};
            if (args[0]?.toLowerCase() === 'on') {
                const customMsg = args.slice(1).join(' ').trim();
                groupSettings[from].welcome = { enabled: true, message: customMsg || null };
                saveGroupSettings(groupSettings);
                await this.reply(msg, '✅ *Welcome message ON!*\n\n' + (customMsg ? `Custom: ${customMsg}` : 'Default message use hogi.') + '\n\n*Variables:* @user, @group');
            } else {
                groupSettings[from].welcome = { enabled: false };
                saveGroupSettings(groupSettings);
                await this.reply(msg, '❌ *Welcome message OFF!*');
            }
            return;
        }

        // ===== GOODBYE =====
        if (command === 'goodbye') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!groupSettings[from]) groupSettings[from] = {};
            if (args[0]?.toLowerCase() === 'on') {
                const customMsg = args.slice(1).join(' ').trim();
                groupSettings[from].goodbye = { enabled: true, message: customMsg || null };
                saveGroupSettings(groupSettings);
                await this.reply(msg, '✅ *Goodbye message ON!*');
            } else {
                groupSettings[from].goodbye = { enabled: false };
                saveGroupSettings(groupSettings);
                await this.reply(msg, '❌ *Goodbye message OFF!*');
            }
            return;
        }

        // ===== ANTILINK =====
        if (command === 'antilink') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!groupSettings[from]) groupSettings[from] = {};
            const val = args[0]?.toLowerCase();
            if (val === 'on') {
                groupSettings[from].antilink = true;
                saveGroupSettings(groupSettings);
                await this.reply(msg, '🔗 *Anti-Link ON!*\n\n• WhatsApp group links block honge\n• Link share karne par auto-warn milega\n• 3 warnings = auto-kick');
            } else if (val === 'all') {
                groupSettings[from].antilink = 'all';
                saveGroupSettings(groupSettings);
                await this.reply(msg, '🔗 *Anti-Link ON (ALL LINKS)!*\n\n• Koi bhi link block hoga\n• Auto-warn + 3 warn = kick');
            } else {
                groupSettings[from].antilink = false;
                saveGroupSettings(groupSettings);
                await this.reply(msg, '🔗 *Anti-Link OFF!*');
            }
            return;
        }

        // ===== LOCK / UNLOCK =====
        if (command === 'lock') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!groupSettings[from]) groupSettings[from] = {};
            groupSettings[from].locked = true;
            saveGroupSettings(groupSettings);
            await this.reply(msg, '🔒 *Group LOCKED!*\nSirf admins message kar sakte hain.');
            return;
        }

        if (command === 'unlock') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!groupSettings[from]) groupSettings[from] = {};
            groupSettings[from].locked = false;
            saveGroupSettings(groupSettings);
            await this.reply(msg, '🔓 *Group UNLOCKED!*\nSabhi message kar sakte hain.');
            return;
        }

        // ===== MUTE =====
        if (command === 'mute') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            const minutes = parseInt(args.find(a => /^\d+$/.test(a))) || 60;
            if (!groupSettings[from]) groupSettings[from] = {};
            if (!groupSettings[from].muted) groupSettings[from].muted = {};
            groupSettings[from].muted[targetJid] = Date.now() + minutes * 60 * 1000;
            saveGroupSettings(groupSettings);
            await this.reply(msg, `🔇 *@${targetJid.split('@')[0]} MUTED!*\n⏱️ Duration: ${minutes} minutes`, );
            await this.sendMessage(from, { text: `🔇 *User Muted*\n@${targetJid.split('@')[0]} ko ${minutes} minute ke liye mute kiya gaya.`, mentions: [targetJid] });
            return;
        }

        // ===== UNMUTE =====
        if (command === 'unmute') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            if (groupSettings[from]?.muted) {
                delete groupSettings[from].muted[targetJid];
                saveGroupSettings(groupSettings);
            }
            await this.sendMessage(from, { text: `🔊 *@${targetJid.split('@')[0]} UNMUTED!*`, mentions: [targetJid] });
            return;
        }

        // ===== KICK =====
        if (command === 'kick') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            try {
                await this.sendMessage(from, { text: `👢 *@${targetJid.split('@')[0]} kicked!*`, mentions: [targetJid] });
                await this.sock.groupParticipantsUpdate(from, [targetJid], 'remove');
            } catch (err) { await this.reply(msg, `❌ Kick nahi ho saka: ${err.message}`); }
            return;
        }

        // ===== BAN =====
        if (command === 'ban') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            try {
                await this.sendMessage(from, { text: `🚫 *@${targetJid.split('@')[0]} BANNED!*`, mentions: [targetJid] });
                await this.sock.groupParticipantsUpdate(from, [targetJid], 'remove');
            } catch (err) { await this.reply(msg, `❌ Ban nahi ho saka: ${err.message}`); }
            return;
        }

        // ===== WARN =====
        if (command === 'warn') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            const reason = fullArgs.replace(/@\d+/g, '').trim() || 'Koi reason nahi diya';
            if (!warningsData[from]) warningsData[from] = {};
            if (!warningsData[from][targetJid]) warningsData[from][targetJid] = [];
            warningsData[from][targetJid].push({ reason, time: Date.now() });
            saveWarnings(warningsData);
            const count = warningsData[from][targetJid].length;

            await this.sendMessage(from, {
                text: `⚠️ *WARNING!*\n\n` +
                      `👤 User: @${targetJid.split('@')[0]}\n` +
                      `📋 Reason: ${reason}\n` +
                      `🔢 Warnings: ${count}/3\n` +
                      `${count >= 3 ? '❌ *3 Warnings! Auto-kick ho raha hai...*' : `⚠️ ${3 - count} aur warning par kick!`}`,
                mentions: [targetJid]
            });

            if (count >= 3) {
                try { await this.sock.groupParticipantsUpdate(from, [targetJid], 'remove'); } catch (_) {}
                delete warningsData[from][targetJid];
                saveWarnings(warningsData);
            }
            return;
        }

        // ===== WARNS =====
        if (command === 'warns') {
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            const userWarns = warningsData[from]?.[targetJid] || [];
            if (userWarns.length === 0) {
                await this.reply(msg, `✨ @${targetJid.split('@')[0]} ki koi warnings nahi hain!`);
                return;
            }
            let list = `⚠️ *Warnings — @${targetJid.split('@')[0]} (${userWarns.length}/3):*\n\n`;
            userWarns.forEach((w, i) => {
                const date = new Date(w.time).toLocaleDateString('en-IN');
                list += `${i + 1}. ${w.reason} (${date})\n`;
            });
            await this.sendMessage(from, { text: list, mentions: [targetJid] });
            return;
        }

        // ===== RESETWARNS =====
        if (command === 'resetwarns') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!targetJid) { await this.reply(msg, '⚠️ @mention karo ya reply karo'); return; }
            if (warningsData[from]) { delete warningsData[from][targetJid]; saveWarnings(warningsData); }
            await this.sendMessage(from, { text: `🧹 *@${targetJid.split('@')[0]} ki saari warnings clear!*`, mentions: [targetJid] });
            return;
        }

        // ===== SETSUBJECT =====
        if (command === 'setsubject') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!fullArgs) { await this.reply(msg, '❌ Naam do: !setsubject <naam>'); return; }
            try {
                await this.sock.groupUpdateSubject(from, fullArgs);
                await this.reply(msg, `📛 *Group name updated:* ${fullArgs}`);
            } catch (err) { await this.reply(msg, `❌ Error: ${err.message}`); }
            return;
        }

        // ===== SETDESC =====
        if (command === 'setdesc') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            try {
                await this.sock.groupUpdateDescription(from, fullArgs);
                await this.reply(msg, `📝 *Description updated!*`);
            } catch (err) { await this.reply(msg, `❌ Error: ${err.message}`); }
            return;
        }

        // ===== SETPHOTO =====
        if (command === 'setphoto') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            const quotedMsg = ctx?.quotedMessage;
            if (!quotedMsg?.imageMessage) { await this.reply(msg, '⚠️ Kisi image ko reply karke !setphoto bhejo'); return; }
            try {
                const buffer = await downloadMediaMessage({ message: quotedMsg, type: 'buffer' }, 'buffer', {});
                await this.sock.updateProfilePicture(from, buffer);
                await this.reply(msg, '🖼️ *Group photo updated!*');
            } catch (err) { await this.reply(msg, `❌ Error: ${err.message}`); }
            return;
        }

        // ===== SETRULES =====
        if (command === 'setrules') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            if (!groupSettings[from]) groupSettings[from] = {};
            if (!fullArgs) {
                delete groupSettings[from].rules;
                saveGroupSettings(groupSettings);
                await this.reply(msg, '🧹 *Rules cleared!*');
            } else {
                groupSettings[from].rules = fullArgs;
                saveGroupSettings(groupSettings);
                await this.reply(msg, `📜 *Rules set!*\n\n${fullArgs}`);
            }
            return;
        }

        // ===== RULES =====
        if (command === 'rules') {
            const rules = groupSettings[from]?.rules;
            if (!rules) { await this.reply(msg, '📜 Is group mein koi rules set nahi hain.\nSet karo: !setrules <rules>'); return; }
            await this.reply(msg, `📜 *Group Rules:*\n\n${rules}`);
            return;
        }

        // ===== DELETE =====
        if (command === 'delete') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            const quotedId = ctx?.stanzaId;
            const quotedPart = ctx?.participant;
            if (!quotedId) { await this.reply(msg, '⚠️ Kisi message ko reply karke !delete bhejo'); return; }
            try {
                await this.sock.sendMessage(from, {
                    delete: { remoteJid: from, fromMe: false, id: quotedId, participant: quotedPart }
                });
            } catch (err) { await this.reply(msg, `❌ Delete nahi ho saka: ${err.message}`); }
            return;
        }

        // ===== GROUPINFO =====
        if (command === 'groupinfo') {
            const meta = await getGroupMetadataCached(this.sock, from);
            const s = groupSettings[from] || {};
            const desc = meta?.desc ? (Buffer.isBuffer(meta.desc) ? meta.desc.toString() : meta.desc) : 'None';
            let info = `📊 *Group Info*\n` +
                       `${'─'.repeat(25)}\n` +
                       `📛 Name: ${meta?.subject || 'Unknown'}\n` +
                       `🆔 ID: ${from.replace('@g.us', '')}\n` +
                       `👥 Members: ${meta?.participants?.length || 0}\n` +
                       `📝 Desc: ${typeof desc === 'string' ? desc.slice(0, 100) : 'None'}\n` +
                       `${'─'.repeat(25)}\n` +
                       `🔒 Locked: ${s.locked ? '✅ Yes' : '❌ No'}\n` +
                       `🔗 Anti-Link: ${s.antilink ? (s.antilink === 'all' ? '✅ All Links' : '✅ WA Links') : '❌ Off'}\n` +
                       `👋 Welcome: ${s.welcome?.enabled ? '✅ On' : '❌ Off'}\n` +
                       `🚪 Goodbye: ${s.goodbye?.enabled ? '✅ On' : '❌ Off'}\n` +
                       `📜 Rules: ${s.rules ? '✅ Set' : '❌ Not set'}`;
            await this.reply(msg, info);
            return;
        }

        // ===== ADMINS =====
        if (command === 'admins') {
            const meta = await getGroupMetadataCached(this.sock, from);
            if (!meta) { await this.reply(msg, '❌ Group info nahi mila'); return; }
            const admins = meta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
            const mentions = admins.map(a => a.id);
            const list = `👥 *Group Admins (${admins.length}):*\n\n` +
                         admins.map(a => `• @${a.id.split('@')[0]}${a.admin === 'superadmin' ? ' 👑' : ''}`).join('\n');
            await this.sendMessage(from, { text: list, mentions });
            return;
        }

        // ===== MEMBERS =====
        if (command === 'members') {
            const meta = await getGroupMetadataCached(this.sock, from);
            if (!meta) { await this.reply(msg, '❌ Group info nahi mila'); return; }
            const members = meta.participants;
            let text2 = `👥 *Members (${members.length} total):*\n\n`;
            text2 += members.slice(0, 50).map((m, i) => `${i + 1}. +${m.id.split('@')[0]}`).join('\n');
            if (members.length > 50) text2 += `\n...aur ${members.length - 50} aur`;
            await this.reply(msg, text2);
            return;
        }

        // ===== TAGALL =====
        if (command === 'tagall') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            const meta = await getGroupMetadataCached(this.sock, from);
            if (!meta) { await this.reply(msg, '❌ Group info nahi mila'); return; }
            const mentions = meta.participants.map(p => p.id);
            const tagText = fullArgs || '📢 Attention everyone!';
            const msgText = `${tagText}\n\n` + mentions.map(m => `@${m.split('@')[0]}`).join(' ');
            await this.sendMessage(from, { text: msgText, mentions });
            return;
        }

        // ===== HIDETAG =====
        if (command === 'hidetag') {
            if (!senderHasPermission) { await this.reply(msg, '❌ Permission nahi hai!'); return; }
            const meta = await getGroupMetadataCached(this.sock, from);
            if (!meta) { await this.reply(msg, '❌ Group info nahi mila'); return; }
            const mentions = meta.participants.map(p => p.id);
            await this.sendMessage(from, { text: fullArgs || '📢 Important message', mentions });
            return;
        }

        // ===== POLL =====
        if (command === 'poll') {
            if (!fullArgs.includes('|')) {
                await this.reply(msg, '❌ Format: !poll Question|Option1|Option2|Option3');
                return;
            }
            const parts = fullArgs.split('|').map(p => p.trim()).filter(Boolean);
            const question = parts[0];
            const options = parts.slice(1);
            if (options.length < 2) { await this.reply(msg, '❌ Kam se kam 2 options chahiye'); return; }
            try {
                await this.sock.sendMessage(from, {
                    poll: { name: question, values: options, selectableCount: 1 }
                });
            } catch (err) { await this.reply(msg, `❌ Poll error: ${err.message}`); }
            return;
        }

        // ===== WHOISHE =====
        if (command === 'whoishe' || command === 'whoisme' || command === 'whois') {
            const checkJid = targetJid || sender;
            const phoneNum = checkJid.split('@')[0];

            try {
                let profileText = `🔍 *User Info*\n` +
                                  `${'─'.repeat(25)}\n` +
                                  `📱 Phone: +${phoneNum}\n` +
                                  `🆔 WA ID: ${checkJid}\n`;

                // Try get status
                try {
                    const status = await this.sock.fetchStatus(checkJid);
                    if (status?.status) profileText += `💬 Status: ${status.status}\n`;
                } catch (_) {}

                // Try get profile name from group
                if (isGroup) {
                    const meta = await getGroupMetadataCached(this.sock, from);
                    const participant = meta?.participants?.find(p => p.id === checkJid);
                    if (participant?.admin) profileText += `🛡️ Role: ${participant.admin === 'superadmin' ? 'Group Creator' : 'Admin'}\n`;
                }

                const warnCount = warningsData[from]?.[checkJid]?.length || 0;
                profileText += `⚠️ Warnings: ${warnCount}/3\n`;
                profileText += `${'─'.repeat(25)}\n`;
                profileText += `🤖 Bot Role: ${isOwner(checkJid) ? '👑 Bot Owner' : isAdmin(checkJid) ? '🔰 Bot Admin' : isSubAdmin(checkJid, from) ? '⭐ Sub-Admin' : '👤 Member'}`;

                // Try to get profile picture
                let ppUrl = null;
                try {
                    ppUrl = await this.sock.profilePictureUrl(checkJid, 'image');
                } catch (_) {}

                if (ppUrl) {
                    const axios = (await import('axios')).default;
                    const response = await axios.get(ppUrl, { responseType: 'arraybuffer' });
                    const imgBuffer = Buffer.from(response.data);
                    await this.sendMessage(from, {
                        image: imgBuffer,
                        caption: profileText,
                        mentions: [checkJid]
                    });
                } else {
                    await this.sendMessage(from, { text: profileText + '\n\n_(Profile photo nahi mila)_', mentions: [checkJid] });
                }
            } catch (err) {
                await this.reply(msg, `❌ Info nahi mila: ${err.message}`);
            }
            return;
        }
    }
}

// ========== BOT MANAGER ==========
class BotManager {
    constructor() {
        this.bots = new Map();
        this.botCounter = 0;
        this.commandBus = new CommandBus();
        const saved = loadJSON(BOTS_FILE, { counter: 0, bots: [] });
        this.botCounter = saved.counter || 0;
        this.loadedData = saved;
    }

    saveBots() {
        const data = {
            counter: this.botCounter,
            bots: [...this.bots.entries()].map(([id, bot]) => ({
                id, phoneNumber: bot.phoneNumber, connected: bot.connected, disabled: bot.disabled
            }))
        };
        saveJSON(BOTS_FILE, data);
    }

    async restoreSavedBots() {
        if (this.loadedData.bots?.length > 0) {
            console.log(`[MANAGER] Restoring ${this.loadedData.bots.length} session(s)...`);
            for (const botData of this.loadedData.bots) {
                const session = new BotSession(botData.id, botData.phoneNumber || DEFAULT_PHONE, this);
                session.disabled = botData.disabled || false;
                this.bots.set(botData.id, session);
                this.commandBus.registerBot(botData.id, session);
                if (!session.disabled) {
                    console.log(`[MANAGER] Starting ${botData.id}...`);
                    await session.connect();
                }
                await delay(2000);
            }
            this.saveBots();
        } else {
            await this.addBot(DEFAULT_PHONE);
        }
    }

    async addBot(phoneNumber) {
        this.botCounter++;
        const botId = `BOT${this.botCounter}`;
        console.log(`[MANAGER] New session: ${botId} (${phoneNumber})`);
        const session = new BotSession(botId, phoneNumber, this);
        this.bots.set(botId, session);
        this.commandBus.registerBot(botId, session);
        await session.connect();
        this.saveBots();
        return botId;
    }

    removeBot(botId) {
        if (this.bots.has(botId)) {
            this.commandBus.unregisterBot(botId);
            this.bots.delete(botId);
            this.saveBots();
        }
    }
}

// ========== STARTUP ==========
console.log(`\n╔═══════════════════════════════╗`);
console.log(`║   🤖 Ryan WhatsApp Bot 🤖     ║`);
console.log(`║    Group Management Bot       ║`);
console.log(`╚═══════════════════════════════╝\n`);
console.log(`📱 Phone: ${DEFAULT_PHONE}`);
console.log(`🚀 Starting...\n`);

const botManager = new BotManager();
await botManager.restoreSavedBots();
