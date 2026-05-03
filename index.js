import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay, 
    fetchLatestBaileysVersion, 
    Browsers, 
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import NodeCache from 'node-cache';

// ========== CONFIG ==========
// Pre-configured phone number for auto-pairing on first run
const DEFAULT_PHONE = process.env.PHONE_NUMBER || '584164707937';

// ========== CACHE ==========
const msgRetryCounterCache = new NodeCache();
const groupMetadataCache = new Map();
const METADATA_TTL = 5 * 60 * 1000;

// ========== FILE PATHS ==========
const ROLES_FILE = './data/roles.json';
const BOTS_FILE = './data/bots.json';
const PREFIX_FILE = './data/prefix.json';
const GROUP_SETTINGS_FILE = './data/group_settings.json';
const WARNINGS_FILE = './data/warnings.json';

// ========== DEFAULT VALUES ==========
const defaultRoles = { owner: null, admins: [], subAdmins: {} };
const defaultPrefix = '!';

// ========== DATA HELPERS ==========
function loadJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {}
    return fallback;
}
function saveJSON(file, data) {
    try {
        if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {}
}

function loadRoles() { return loadJSON(ROLES_FILE, { ...defaultRoles }); }
function saveRoles(r) { saveJSON(ROLES_FILE, r); }
function loadPrefix() { return loadJSON(PREFIX_FILE, { prefix: defaultPrefix }).prefix || defaultPrefix; }
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
function hasPermission(jid, groupJid) { return isOwner(jid) || isAdmin(jid) || isSubAdmin(jid, groupJid); }

function setOwner(jid) {
    if (!roles.owner) { roles.owner = jid; saveRoles(roles); return true; }
    return false;
}
function removeOwner() { roles.owner = null; saveRoles(roles); return true; }
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
    } catch (err) {
        return cached ? cached.data : null;
    }
}

async function isGroupAdmin(sock, jid, groupJid) {
    const meta = await getGroupMetadataCached(sock, groupJid);
    if (!meta) return false;
    return meta.participants.some(p => p.id === jid && (p.admin === 'admin' || p.admin === 'superadmin'));
}

// ========== REPLY MESSAGES ==========
const R = {
    youAreNowOwner: '👑 YOU ARE NOW THE BOT OWNER',
    youAreAlreadyOwner: '👑 YOU ARE ALREADY THE BOT OWNER',
    ownerAlreadyExists: '👑 BOT OWNER ALREADY EXISTS',
    youAreNoLongerOwner: '👑 YOU ARE NO LONGER THE BOT OWNER',
    youAreNotOwner: '👑 YOU ARE NOT THE BOT OWNER',
    botAdminAdded: '✅ BOT ADMIN ADDED',
    alreadyBotAdmin: '⚠️ ALREADY BOT ADMIN',
    botAdminRemoved: '✅ BOT ADMIN REMOVED',
    notBotAdmin: '❌ NOT A BOT ADMIN',
    subAdminAdded: '✅ BOT SUB-ADMIN ADDED',
    alreadySubAdmin: '⚠️ ALREADY BOT SUB-ADMIN',
    subAdminRemoved: '✅ BOT SUB-ADMIN REMOVED',
    notSubAdmin: '❌ NOT A BOT SUB-ADMIN',
    replyToSomeone: '⚠️ REPLY TO SOMEONE',
    invalidPhone: '❌ INVALID PHONE NUMBER',
    useInGroup: '⚠️ USE IN GROUP',
    onlyOwner: '👑 ONLY BOT OWNER CAN USE THIS',
    onlyBotAdmin: '👑 ONLY BOT ADMIN CAN USE THIS',
    noPermission: '❌ YOU DO NOT HAVE PERMISSION',
    welcomeEnabled: '✅ WELCOME MESSAGE ENABLED',
    welcomeDisabled: '❌ WELCOME DISABLED',
    goodbyeEnabled: '✅ GOODBYE MESSAGE ENABLED',
    goodbyeDisabled: '❌ GOODBYE DISABLED',
    antilinkOn: '🔗 ANTI-LINK ENABLED',
    antilinkOff: '🔗 ANTI-LINK DISABLED',
    groupLocked: '🔒 GROUP LOCKED (only admins can send messages)',
    groupUnlocked: '🔓 GROUP UNLOCKED',
    userMuted: '🔇 USER MUTED',
    userUnmuted: '🔊 USER UNMUTED',
    userKicked: '👢 USER KICKED',
    userBanned: '🚫 USER BANNED',
    warnAdded: '⚠️ WARNING ADDED',
    noWarnings: '✨ NO WARNINGS',
    warningsCleared: '🧹 WARNINGS CLEARED',
    descUpdated: '📝 DESCRIPTION UPDATED',
    subjectUpdated: '📛 SUBJECT UPDATED',
    photoUpdated: '🖼️ GROUP PICTURE UPDATED',
    rulesSet: '📜 RULES SET',
    rulesCleared: '🧹 RULES CLEARED',
    messageDeleted: '🗑️ MESSAGE DELETED',
    prefixChanged: '🧡 PREFIX CHANGED TO',
    connected: '✅ CONNECTED',
};

// ========== MENU ==========
const RyanMenu = `╔═══❖•ೋ° °ೋ•❖═══╗
       Ryan BOT 
╚═══❖•ೋ° °ೋ•❖═══╝
◎ ══════ ❈ ══════ ◎
👑 BOT OWNER COMMANDS 
◎ ══════ ❈ ══════ ◎
👑!owner - Claim Bot Ownership (DM Only)
🔓!removeowner - Remove Yourself As Owner (DM)
➕!addadmin @user - Add Bot Admin (Owner Only)
🗑️!removeadmin @user - Remove Bot Admin
📋!listadmins - List All Bot Admins

◎ ══════ ❈ ══════ ◎
👥 BOT SUB-ADMIN COMMANDS (Per Group)
◎ ══════ ❈ ══════ ◎
👥!sub @user - Add Bot Sub-Admin
🚫!removesub @user - Remove Bot Sub-Admin
📋!listsub - List Sub-Admins In Current Group

◎ ══════ ❈ ══════ ◎
👑 GROUP MANAGEMENT
◎ ══════ ❈ ══════ ◎
👋!welcome <on/off> [message] - Enable/disable welcome
🚪!goodbye <on/off> [message] - Enable/disable goodbye
🔗!antilink <on/off> - Block links from non-admins
🔒!lock - Only admins can send messages
🔓!unlock - Unlock group
🔇!mute @user [minutes] - Soft mute (messages deleted)
🔊!unmute @user - Unmute
👢!kick @user - Remove from group
🚫!ban @user - Ban and remove
⚠️!warn @user [reason] - Give warning
📋!warns @user - Show warnings
🧹!resetwarns @user - Clear warnings
📛!setsubject <text> - Change group name
📝!setdesc <text> - Set group description
🖼️!setphoto (reply image) - Change group picture
📜!setrules <text> - Set group rules
📋!rules - View group rules
🗑️!delete (reply message) - Delete message
📊!groupinfo - Show group settings
👥!admins - List WhatsApp admins
👥!members - List members
🔔!tagall [message] - Tag all members
🤫!hidetag [message] - Hidden tag all
📊!poll <question|opt1|opt2...> - Create poll

◎ ══════ ❈ ══════ ◎ 
🤖 BOT INFO
◎ ══════ ❈ ══════ ◎
🎐!ping - Bot Ping
🧡!prefix <char> - Change command prefix
📋!menu - Show this menu`;

// ========== COMMAND BUS ==========
class CommandBus {
    constructor() {
        this.botSessions = new Map();
        this.processedMessages = new Map();
    }
    registerBot(botId, session) { this.botSessions.set(botId, session); }
    unregisterBot(botId) { this.botSessions.delete(botId); }
    shouldProcessMessage(msgId) {
        if (this.processedMessages.has(msgId)) return false;
        this.processedMessages.set(msgId, Date.now());
        if (this.processedMessages.size > 1000) {
            const oldest = Array.from(this.processedMessages.entries())
                .sort((a, b) => a[1] - b[1]).slice(0, 500);
            for (const [k] of oldest) this.processedMessages.delete(k);
        }
        return true;
    }
    getAllBots() { return Array.from(this.botSessions.values()); }
    getConnectedBots() { return Array.from(this.botSessions.values()).filter(b => b.connected); }
    getLeaderBot() {
        const connected = this.getConnectedBots();
        return connected.length > 0 ? connected[0] : null;
    }
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
        this.authPath = `./auth/${botId}`;
        this.pairingCodeRequested = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 100;
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
                shouldIgnoreJid: (jid) => jid === 'status@broadcast'
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
                        console.log(`Phone Number: ${this.phoneNumber}`);
                        console.log(`==========================================\n`);
                        console.log(`Open WhatsApp > Linked Devices > Link a Device > enter code above`);
                    } catch (err) {
                        console.error(`[${this.botId}] Pairing code error:`, err.message);
                        this.pairingCodeRequested = false;
                    }
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error instanceof Boom)
                        ? lastDisconnect.error.output.statusCode : 500;
                    console.log(`[${this.botId}] Connection closed. Status: ${statusCode}`);
                    this.connected = false;
                    this.reconnecting = false;

                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`[${this.botId}] Logged out. Clearing auth...`);
                        try { fs.rmSync(this.authPath, { recursive: true, force: true }); } catch (e) {}
                        this.botManager.removeBot(this.botId);
                    } else if (!this.disabled) {
                        this.reconnectAttempts++;
                        const reconnectDelay = Math.min(5000 * Math.pow(1.2, this.reconnectAttempts - 1), 30000);
                        console.log(`[${this.botId}] Reconnecting in ${Math.round(reconnectDelay/1000)}s...`);
                        await delay(reconnectDelay);
                        this.connect();
                    }
                } else if (connection === 'open') {
                    console.log(`[${this.botId}] ✅ Connected successfully!`);
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    this.reconnecting = false;
                    const userJid = this.sock.user.id;
                    this.botNumberJid = userJid;
                    this.botNumber = userJid.split(':')[0];
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            // Welcome / Goodbye on participant update
            this.sock.ev.on('group-participants.update', async (update) => {
                try {
                    const leader = this.botManager.commandBus.getLeaderBot();
                    if (!leader || leader.botId !== this.botId) return;

                    const { id, participants, action } = update;
                    const settings = groupSettings[id];
                    if (!settings) return;

                    for (const participant of participants) {
                        if (action === 'add' && settings.welcome?.enabled) {
                            let msg = settings.welcome.message || 'Welcome @user to the group!';
                            msg = msg.replace(/@user/g, `@${participant.split('@')[0]}`);
                            await this.sock.sendMessage(id, { text: msg, mentions: [participant] });
                        } else if ((action === 'remove' || action === 'leave') && settings.goodbye?.enabled) {
                            let msg = settings.goodbye.message || 'Goodbye @user!';
                            msg = msg.replace(/@user/g, `@${participant.split('@')[0]}`);
                            await this.sock.sendMessage(id, { text: msg, mentions: [participant] });
                        }
                    }
                } catch (err) {}
            });

            this.sock.ev.on('messages.upsert', async (m) => {
                try { await this.handleMessage(m); } catch (err) {
                    console.error(`[${this.botId}] Message error:`, err.message);
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
            if (this.sock && this.connected) {
                return await this.sock.sendMessage(jid, content);
            }
        } catch (err) {}
    }

    async handleMessage({ messages, type }) {
        try {
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
            if (msg.message.conversation) text = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text;
            else if (msg.message.imageMessage?.caption) text = msg.message.imageMessage.caption;
            else if (msg.message.videoMessage?.caption) text = msg.message.videoMessage.caption;

            // ====== PRE-COMMAND GROUP CHECKS ======
            if (isGroup) {
                const settings = groupSettings[from] || {};
                const senderIsBotAdmin = hasPermission(sender, from);
                const senderIsWAAdmin = await isGroupAdmin(this.sock, sender, from);

                // Lock check
                if (settings.locked && !senderIsWAAdmin && !senderIsBotAdmin) {
                    await this.sock.sendMessage(from, { delete: msg.key });
                    return;
                }

                // Mute check
                const muteExpiry = settings.muted?.[sender];
                if (muteExpiry) {
                    if (Date.now() < muteExpiry) {
                        await this.sock.sendMessage(from, { delete: msg.key });
                        return;
                    } else {
                        delete groupSettings[from].muted[sender];
                        saveGroupSettings(groupSettings);
                    }
                }

                // Antilink check
                if (settings.antilink && !senderIsWAAdmin && !senderIsBotAdmin) {
                    const urlRegex = /https?:\/\/[^\s]+|wa\.me\/[^\s]+|chat\.whatsapp\.com\/[^\s]+/i;
                    if (urlRegex.test(text)) {
                        await this.sock.sendMessage(from, { delete: msg.key });
                        await this.sock.sendMessage(from, {
                            text: `@${sender.split('@')[0]} ⚠️ Links not allowed!`,
                            mentions: [sender]
                        });
                        return;
                    }
                }
            }

            // ====== COMMAND HANDLING ======
            if (!text.startsWith(commandPrefix)) return;

            const args = text.slice(commandPrefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();
            const fullArgs = args.join(' ');
            const isDM = !isGroup;

            const senderIsOwner = isOwner(sender);
            const senderIsAdmin = isAdmin(sender);
            const senderIsSubAdmin = isGroup ? isSubAdmin(sender, from) : false;
            const senderHasPermission = senderIsOwner || senderIsAdmin || senderIsSubAdmin;

            // Quoted/mentioned user helper
            const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
            const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const targetJid = mentionedJids[0] || quotedParticipant || null;

            // ========== MENU ==========
            if (command === 'menu' || command === 'help') {
                await this.sendMessage(from, { text: RyanMenu });
                return;
            }

            // ========== PING ==========
            if (command === 'ping') {
                const start = Date.now();
                const sentMsg = await this.sendMessage(from, { text: '🏓 Pinging...' });
                const latency = Date.now() - start;
                await this.sendMessage(from, { text: `🏓 Pong!\n📶 Latency: ${latency}ms` });
                return;
            }

            // ========== OWNER COMMANDS (DM only) ==========
            if (command === 'owner' && isDM) {
                if (!roles.owner) { setOwner(sender); await this.sendMessage(from, { text: R.youAreNowOwner }); }
                else if (senderIsOwner) await this.sendMessage(from, { text: R.youAreAlreadyOwner });
                else await this.sendMessage(from, { text: R.ownerAlreadyExists });
                return;
            }

            if (command === 'removeowner' && isDM) {
                if (senderIsOwner) { removeOwner(); await this.sendMessage(from, { text: R.youAreNoLongerOwner }); }
                else await this.sendMessage(from, { text: R.youAreNotOwner });
                return;
            }

            // ========== ADMIN COMMANDS ==========
            if (command === 'addadmin') {
                if (!senderIsOwner) { await this.sendMessage(from, { text: R.onlyOwner }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const result = addAdmin(targetJid);
                await this.sendMessage(from, { text: result ? R.botAdminAdded : R.alreadyBotAdmin });
                return;
            }

            if (command === 'removeadmin') {
                if (!senderIsOwner && !senderIsAdmin) { await this.sendMessage(from, { text: R.onlyOwner }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const result = removeAdmin(targetJid);
                await this.sendMessage(from, { text: result ? R.botAdminRemoved : R.notBotAdmin });
                return;
            }

            if (command === 'listadmins') {
                const admins = roles.admins;
                const owner = roles.owner;
                let list = `👑 Owner: ${owner ? owner.split('@')[0] : 'None'}\n\n`;
                list += `📋 Bot Admins (${admins.length}):\n`;
                list += admins.length > 0 ? admins.map(a => `• ${a.split('@')[0]}`).join('\n') : 'None';
                await this.sendMessage(from, { text: list });
                return;
            }

            // ========== SUB-ADMIN COMMANDS ==========
            if (command === 'sub') {
                if (!isGroup) { await this.sendMessage(from, { text: R.useInGroup }); return; }
                if (!senderIsOwner && !senderIsAdmin) { await this.sendMessage(from, { text: R.onlyBotAdmin }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const result = addSubAdmin(targetJid, from);
                await this.sendMessage(from, { text: result ? R.subAdminAdded : R.alreadySubAdmin });
                return;
            }

            if (command === 'removesub') {
                if (!isGroup) { await this.sendMessage(from, { text: R.useInGroup }); return; }
                if (!senderIsOwner && !senderIsAdmin) { await this.sendMessage(from, { text: R.onlyBotAdmin }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const result = removeSubAdmin(targetJid, from);
                await this.sendMessage(from, { text: result ? R.subAdminRemoved : R.notSubAdmin });
                return;
            }

            if (command === 'listsub') {
                if (!isGroup) { await this.sendMessage(from, { text: R.useInGroup }); return; }
                const subs = roles.subAdmins[from] || [];
                const list = subs.length > 0 ? subs.map(s => `• ${s.split('@')[0]}`).join('\n') : 'None';
                await this.sendMessage(from, { text: `📋 Sub-Admins:\n${list}` });
                return;
            }

            // ========== PREFIX ==========
            if (command === 'prefix') {
                if (!senderHasPermission) { await this.sendMessage(from, { text: R.onlyBotAdmin }); return; }
                if (!args[0]) { await this.sendMessage(from, { text: `Current prefix: ${commandPrefix}` }); return; }
                commandPrefix = args[0].trim()[0];
                savePrefix(commandPrefix);
                await this.sendMessage(from, { text: `${R.prefixChanged}: ${commandPrefix}` });
                return;
            }

            // ========== GROUP COMMANDS (must be in group) ==========
            if (!isGroup) {
                await this.sendMessage(from, { text: R.useInGroup });
                return;
            }

            const settings = groupSettings[from] || {};
            const senderIsWAAdmin = await isGroupAdmin(this.sock, sender, from);

            // ===== WELCOME =====
            if (command === 'welcome') {
                if (!senderHasPermission) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!groupSettings[from]) groupSettings[from] = {};
                if (args[0] === 'on') {
                    groupSettings[from].welcome = { enabled: true, message: fullArgs.slice(3).trim() || 'Welcome @user to the group! 👋' };
                    saveGroupSettings(groupSettings);
                    await this.sendMessage(from, { text: R.welcomeEnabled });
                } else {
                    groupSettings[from].welcome = { enabled: false };
                    saveGroupSettings(groupSettings);
                    await this.sendMessage(from, { text: R.welcomeDisabled });
                }
                return;
            }

            // ===== GOODBYE =====
            if (command === 'goodbye') {
                if (!senderHasPermission) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!groupSettings[from]) groupSettings[from] = {};
                if (args[0] === 'on') {
                    groupSettings[from].goodbye = { enabled: true, message: fullArgs.slice(3).trim() || 'Goodbye @user! 👋' };
                    saveGroupSettings(groupSettings);
                    await this.sendMessage(from, { text: R.goodbyeEnabled });
                } else {
                    groupSettings[from].goodbye = { enabled: false };
                    saveGroupSettings(groupSettings);
                    await this.sendMessage(from, { text: R.goodbyeDisabled });
                }
                return;
            }

            // ===== ANTILINK =====
            if (command === 'antilink') {
                if (!senderHasPermission) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!groupSettings[from]) groupSettings[from] = {};
                groupSettings[from].antilink = args[0] === 'on';
                saveGroupSettings(groupSettings);
                await this.sendMessage(from, { text: args[0] === 'on' ? R.antilinkOn : R.antilinkOff });
                return;
            }

            // ===== LOCK / UNLOCK =====
            if (command === 'lock') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!groupSettings[from]) groupSettings[from] = {};
                groupSettings[from].locked = true;
                saveGroupSettings(groupSettings);
                await this.sendMessage(from, { text: R.groupLocked });
                return;
            }

            if (command === 'unlock') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!groupSettings[from]) groupSettings[from] = {};
                groupSettings[from].locked = false;
                saveGroupSettings(groupSettings);
                await this.sendMessage(from, { text: R.groupUnlocked });
                return;
            }

            // ===== MUTE =====
            if (command === 'mute') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const minutes = parseInt(args[args.length - 1]) || 60;
                if (!groupSettings[from]) groupSettings[from] = {};
                if (!groupSettings[from].muted) groupSettings[from].muted = {};
                groupSettings[from].muted[targetJid] = Date.now() + minutes * 60 * 1000;
                saveGroupSettings(groupSettings);
                await this.sendMessage(from, {
                    text: `${R.userMuted}\n@${targetJid.split('@')[0]} muted for ${minutes} minutes`,
                    mentions: [targetJid]
                });
                return;
            }

            // ===== UNMUTE =====
            if (command === 'unmute') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                if (groupSettings[from]?.muted) {
                    delete groupSettings[from].muted[targetJid];
                    saveGroupSettings(groupSettings);
                }
                await this.sendMessage(from, { text: R.userUnmuted, mentions: [targetJid] });
                return;
            }

            // ===== KICK =====
            if (command === 'kick') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                try {
                    await this.sendMessage(from, { text: `${R.userKicked}\n@${targetJid.split('@')[0]}`, mentions: [targetJid] });
                    await this.sock.groupParticipantsUpdate(from, [targetJid], 'remove');
                } catch (err) { await this.sendMessage(from, { text: `❌ Failed to kick: ${err.message}` }); }
                return;
            }

            // ===== BAN =====
            if (command === 'ban') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                try {
                    await this.sendMessage(from, { text: `${R.userBanned}\n@${targetJid.split('@')[0]}`, mentions: [targetJid] });
                    await this.sock.groupParticipantsUpdate(from, [targetJid], 'remove');
                } catch (err) { await this.sendMessage(from, { text: `❌ Failed to ban: ${err.message}` }); }
                return;
            }

            // ===== WARN =====
            if (command === 'warn') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const reason = fullArgs.replace(/@\d+/g, '').trim() || 'No reason provided';
                if (!warningsData[from]) warningsData[from] = {};
                if (!warningsData[from][targetJid]) warningsData[from][targetJid] = [];
                warningsData[from][targetJid].push({ reason, time: Date.now() });
                saveWarnings(warningsData);
                const count = warningsData[from][targetJid].length;
                await this.sendMessage(from, {
                    text: `${R.warnAdded}\n@${targetJid.split('@')[0]}\n📋 Reason: ${reason}\n⚠️ Total Warnings: ${count}`,
                    mentions: [targetJid]
                });
                if (count >= 3) {
                    await this.sendMessage(from, { text: `🚫 @${targetJid.split('@')[0]} reached 3 warnings! Auto-kick.`, mentions: [targetJid] });
                    try { await this.sock.groupParticipantsUpdate(from, [targetJid], 'remove'); } catch (err) {}
                }
                return;
            }

            // ===== WARNS =====
            if (command === 'warns') {
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                const userWarns = warningsData[from]?.[targetJid] || [];
                if (userWarns.length === 0) { await this.sendMessage(from, { text: R.noWarnings }); return; }
                let list = `⚠️ Warnings for @${targetJid.split('@')[0]} (${userWarns.length}):\n`;
                userWarns.forEach((w, i) => { list += `${i + 1}. ${w.reason}\n`; });
                await this.sendMessage(from, { text: list, mentions: [targetJid] });
                return;
            }

            // ===== RESETWARNS =====
            if (command === 'resetwarns') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!targetJid) { await this.sendMessage(from, { text: R.replyToSomeone }); return; }
                if (warningsData[from]) { delete warningsData[from][targetJid]; saveWarnings(warningsData); }
                await this.sendMessage(from, { text: R.warningsCleared, mentions: [targetJid] });
                return;
            }

            // ===== SETSUBJECT =====
            if (command === 'setsubject') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!fullArgs) { await this.sendMessage(from, { text: '❌ Provide a name' }); return; }
                try {
                    await this.sock.groupUpdateSubject(from, fullArgs);
                    await this.sendMessage(from, { text: R.subjectUpdated });
                } catch (err) { await this.sendMessage(from, { text: `❌ Error: ${err.message}` }); }
                return;
            }

            // ===== SETDESC =====
            if (command === 'setdesc') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                try {
                    await this.sock.groupUpdateDescription(from, fullArgs);
                    await this.sendMessage(from, { text: R.descUpdated });
                } catch (err) { await this.sendMessage(from, { text: `❌ Error: ${err.message}` }); }
                return;
            }

            // ===== SETPHOTO =====
            if (command === 'setphoto') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg?.imageMessage) { await this.sendMessage(from, { text: '⚠️ Reply to an image' }); return; }
                try {
                    const buffer = await downloadMediaMessage({ message: quotedMsg, type: 'buffer' }, 'buffer', {});
                    await this.sock.updateProfilePicture(from, buffer);
                    await this.sendMessage(from, { text: R.photoUpdated });
                } catch (err) { await this.sendMessage(from, { text: `❌ Error: ${err.message}` }); }
                return;
            }

            // ===== SETRULES =====
            if (command === 'setrules') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                if (!groupSettings[from]) groupSettings[from] = {};
                if (!fullArgs) {
                    delete groupSettings[from].rules;
                    saveGroupSettings(groupSettings);
                    await this.sendMessage(from, { text: R.rulesCleared });
                } else {
                    groupSettings[from].rules = fullArgs;
                    saveGroupSettings(groupSettings);
                    await this.sendMessage(from, { text: R.rulesSet });
                }
                return;
            }

            // ===== RULES =====
            if (command === 'rules') {
                const rules = groupSettings[from]?.rules;
                if (!rules) { await this.sendMessage(from, { text: '📜 No rules set for this group.' }); return; }
                await this.sendMessage(from, { text: `📜 Group Rules:\n\n${rules}` });
                return;
            }

            // ===== DELETE =====
            if (command === 'delete') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                const quotedKey = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
                const quotedParticipantKey = msg.message.extendedTextMessage?.contextInfo?.participant;
                if (!quotedKey) { await this.sendMessage(from, { text: '⚠️ Reply to a message to delete it' }); return; }
                try {
                    await this.sock.sendMessage(from, {
                        delete: { remoteJid: from, fromMe: false, id: quotedKey, participant: quotedParticipantKey }
                    });
                    await this.sendMessage(from, { text: R.messageDeleted });
                } catch (err) { await this.sendMessage(from, { text: `❌ Error: ${err.message}` }); }
                return;
            }

            // ===== GROUPINFO =====
            if (command === 'groupinfo') {
                const s = groupSettings[from] || {};
                const meta = await getGroupMetadataCached(this.sock, from);
                let info = `📊 Group Info:\n`;
                info += `📛 Name: ${meta?.subject || 'Unknown'}\n`;
                info += `👥 Members: ${meta?.participants?.length || 0}\n`;
                info += `🔒 Locked: ${s.locked ? 'Yes' : 'No'}\n`;
                info += `🔗 Anti-Link: ${s.antilink ? 'On' : 'Off'}\n`;
                info += `👋 Welcome: ${s.welcome?.enabled ? 'On' : 'Off'}\n`;
                info += `🚪 Goodbye: ${s.goodbye?.enabled ? 'On' : 'Off'}\n`;
                info += `📜 Rules: ${s.rules ? 'Set' : 'Not set'}`;
                await this.sendMessage(from, { text: info });
                return;
            }

            // ===== ADMINS =====
            if (command === 'admins') {
                const meta = await getGroupMetadataCached(this.sock, from);
                if (!meta) { await this.sendMessage(from, { text: '❌ Could not get group info' }); return; }
                const admins = meta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
                const mentions = admins.map(a => a.id);
                let text2 = `👥 Group Admins (${admins.length}):\n`;
                text2 += admins.map(a => `• @${a.id.split('@')[0]}`).join('\n');
                await this.sendMessage(from, { text: text2, mentions });
                return;
            }

            // ===== MEMBERS =====
            if (command === 'members') {
                const meta = await getGroupMetadataCached(this.sock, from);
                if (!meta) { await this.sendMessage(from, { text: '❌ Could not get group info' }); return; }
                const members = meta.participants.slice(0, 50);
                let text2 = `👥 Members (${meta.participants.length} total, showing ${members.length}):\n`;
                text2 += members.map(m => `• ${m.id.split('@')[0]}`).join('\n');
                await this.sendMessage(from, { text: text2 });
                return;
            }

            // ===== TAGALL =====
            if (command === 'tagall') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                const meta = await getGroupMetadataCached(this.sock, from);
                if (!meta) { await this.sendMessage(from, { text: '❌ Could not get group info' }); return; }
                const mentions = meta.participants.map(p => p.id);
                const tagText = fullArgs || '📢 Attention everyone!';
                const msgText = `${tagText}\n\n` + mentions.map(m => `@${m.split('@')[0]}`).join(' ');
                await this.sendMessage(from, { text: msgText, mentions });
                return;
            }

            // ===== HIDETAG =====
            if (command === 'hidetag') {
                if (!senderHasPermission && !senderIsWAAdmin) { await this.sendMessage(from, { text: R.noPermission }); return; }
                const meta = await getGroupMetadataCached(this.sock, from);
                if (!meta) { await this.sendMessage(from, { text: '❌ Could not get group info' }); return; }
                const mentions = meta.participants.map(p => p.id);
                await this.sendMessage(from, { text: fullArgs || '📢 Message for all', mentions });
                return;
            }

            // ===== POLL =====
            if (command === 'poll') {
                if (!fullArgs.includes('|')) { await this.sendMessage(from, { text: '❌ Format: !poll question|option1|option2...' }); return; }
                const parts = fullArgs.split('|');
                const question = parts[0].trim();
                const options = parts.slice(1).map(o => o.trim()).filter(Boolean);
                if (options.length < 2) { await this.sendMessage(from, { text: '❌ At least 2 options required' }); return; }
                try {
                    await this.sock.sendMessage(from, {
                        poll: { name: question, values: options, selectableCount: 1 }
                    });
                } catch (err) { await this.sendMessage(from, { text: `❌ Poll error: ${err.message}` }); }
                return;
            }

        } catch (err) {
            console.error(`[${this.botId}] Handle message error:`, err.message);
        }
    }
}

// ========== BOT MANAGER ==========
class BotManager {
    constructor() {
        this.bots = new Map();
        this.botCounter = 0;
        this.commandBus = new CommandBus();
        this.loadedData = loadJSON(BOTS_FILE, { counter: 0, bots: [] });
        this.botCounter = this.loadedData.counter || 0;
    }

    saveBots() {
        try {
            if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
            const data = {
                counter: this.botCounter,
                bots: Array.from(this.bots.entries()).map(([id, bot]) => ({
                    id,
                    phoneNumber: bot.phoneNumber,
                    connected: bot.connected,
                    disabled: bot.disabled
                }))
            };
            fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
        } catch (err) {}
    }

    async restoreSavedBots() {
        if (this.loadedData.bots && this.loadedData.bots.length > 0) {
            console.log(`[MANAGER] Restoring ${this.loadedData.bots.length} bot session(s)...`);
            for (const botData of this.loadedData.bots) {
                const authPath = `./auth/${botData.id}`;
                const hasAuth = fs.existsSync(authPath) && fs.readdirSync(authPath).length > 0;
                let phoneNumber = botData.phoneNumber || DEFAULT_PHONE;
                const session = new BotSession(botData.id, phoneNumber, this);
                session.disabled = botData.disabled || false;
                this.bots.set(botData.id, session);
                this.commandBus.registerBot(botData.id, session);
                if (!session.disabled) {
                    console.log(`[MANAGER] Starting ${botData.id}...`);
                    await session.connect();
                } else {
                    console.log(`[MANAGER] ${botData.id} is disabled`);
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
        console.log(`[MANAGER] Creating new session: ${botId} for ${phoneNumber}`);
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
console.log(`\n╔═══════════════════════════╗`);
console.log(`║     Ryan WhatsApp Bot     ║`);
console.log(`║   Group Management Bot    ║`);
console.log(`╚═══════════════════════════╝\n`);
console.log(`Phone: ${DEFAULT_PHONE}`);
console.log(`Starting bot...\n`);

const botManager = new BotManager();
await botManager.restoreSavedBots();
