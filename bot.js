'use strict';

var Telegraf = require('telegraf').Telegraf;
var express  = require('express');
var fs       = require('fs');
var path     = require('path');

var BOT_TOKEN    = process.env.BOT_TOKEN;
var GITHUB_TOKEN = process.env.GITHUB_TOKEN;
var RENDER_KEY   = process.env.RENDER_API_KEY;
var CRON_KEY     = process.env.CRONJOB_API_KEY;
var WEBHOOK_URL  = (process.env.WEBHOOK_URL || '').trim();
var PORT         = process.env.PORT || 3000;
var GH_OWNER     = '';

// Groq pool
var groqPool = [];
for (var _gi = 1; _gi <= 10; _gi++) {
  var _gk = process.env['GROQ_KEY_' + _gi];
  if (_gk) groqPool.push(_gk.trim());
}
var groqIdx = 0;
function nextGroqKey() {
  if (!groqPool.length) return '';
  var k = groqPool[groqIdx % groqPool.length];
  groqIdx++;
  return k;
}

// Emoji - pure ASCII
var E = {
  fire    : '\u{1F525}', check   : '\u2705',  xmark   : '\u274C',
  gear    : '\u2699\uFE0F', party : '\u{1F389}', lock  : '\u{1F512}',
  rocket  : '\u{1F680}', folder  : '\u{1F4C2}', cloud  : '\u2601\uFE0F',
  clock   : '\u23F0',   warn    : '\u26A0\uFE0F', pencil: '\u270F\uFE0F',
  link    : '\u{1F517}', shield  : '\u{1F6E1}', robot  : '\u{1F916}',
  chart   : '\u{1F4C8}', star    : '\u2B50',   stats  : '\u{1F4CA}',
  list    : '\u{1F4CB}', wrench  : '\u{1F527}', money  : '\u{1F4B0}',
  gem     : '\u{1F48E}', copy    : '\u{1F4CB}', back   : '\u{1F519}',
  bnb     : '\u{1F7E1}', sol     : '\u{1F7E3}', alpha  : '\u26A1',
  pro     : '\u{1F454}', hype    : '\u{1F525}', comm   : '\u{1F91D}',
  wave    : '\u{1F44B}',
};

var CHAIN_INFO = {
  bsc: { label:'BNB Smart Chain (BSC)', dex:'PancakeSwap', dexUrl:'https://pancakeswap.finance/swap?outputCurrency=', chartBase:'https://dexscreener.com/bsc/', explorer:'https://bscscan.com/token/' },
  sol: { label:'Solana', dex:'Raydium', dexUrl:'https://raydium.io/swap/?outputMint=', chartBase:'https://dexscreener.com/solana/', explorer:'https://solscan.io/token/' },
};

var PERS_LABELS = {
  alpha: '\u26A1 Alpha',
  professional: '\u{1F454} Professional',
  hype: '\u{1F525} Hype',
  community: '\u{1F91D} Community',
};

var bot = new Telegraf(BOT_TOKEN);
var app = express();
app.use(express.json());

// Registry
var botRegistry = [];
var sessions     = {};  // build sessions
var editSessions = {};  // edit sessions

// 
// HELPERS
// 
function rndStr(n) {
  var c = 'abcdefghijklmnopqrstuvwxyz0123456789', o = '';
  for (var i = 0; i < n; i++) o += c[Math.floor(Math.random() * c.length)];
  return o;
}
function rndCmd() { return rndStr(3) + rndStr(3) + rndStr(2); }

function fmtNum(n) {
  var s = String(n).replace(/,/g, '');
  var p = s.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return p.join('.');
}
function parseSupply(raw) {
  raw = String(raw).trim().replace(/,/g, '');
  var m = raw.match(/^([\d.]+)\s*([BBTMK])?$/i);
  if (!m) return fmtNum(raw.replace(/[^0-9.]/g,''));
  var num = parseFloat(m[1]), suf = (m[2] || '').toUpperCase();
  if (suf === 'T') num = num * 1e12;
  else if (suf === 'B') num = num * 1e9;
  else if (suf === 'M') num = num * 1e6;
  else if (suf === 'K') num = num * 1e3;
  return fmtNum(Math.round(num).toString());
}
function ensurePct(s) { s = String(s).trim(); return s.endsWith('%') ? s : s + '%'; }
function repoFromUrl(url) {
  var m = (url || '').match(/https?:\/\/([a-z0-9-]+)\.onrender\.com/);
  return m ? m[1] : '';
}
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// 
// REGISTRY SAVE / LOAD
// 
function saveRegistry() {
  if (!GH_OWNER) return;
  // Strip sensitive fields before saving
  var safe = botRegistry.map(function(b) {
    var c = JSON.parse(JSON.stringify(b));
    if (c.data) { delete c.data.botToken; }
    return c;
  });
  githubPushFileUpdate(GH_OWNER, 'bot-factory', 'bots.json', Buffer.from(JSON.stringify(safe, null, 2)))
    .catch(function(e) { console.log('Registry save:', e.message); });
}
async function loadRegistry() {
  if (!GH_OWNER) return;
  try {
    var r = await fetch('https://api.github.com/repos/' + GH_OWNER + '/bot-factory/contents/bots.json', {
      headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (r.ok) {
      var d = await r.json();
      if (d.content) {
        botRegistry = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
        console.log('Registry loaded:', botRegistry.length, 'bots');
      }
    }
  } catch(e) { console.log('Registry load:', e.message); }
}

// 
// BUILD WIZARD STEPS
// 
var BUILD_STEPS = [
  'chain', 'mode', 'status', 'personality',
  'name', 'ticker', 'ca', 'supply', 'maxwallet', 'taxes',
  'twitter', 'website', 'renounced', 'locked', 'narrative',
  'image', 'bottoken',
];

var BUILD_ASKS = {
  name      : E.pencil + ' Token name?\n<i>e.g. PECKER</i>',
  ticker    : E.pencil + ' Ticker with $?\n<i>e.g. $PECKER</i>',
  ca        : E.pencil + ' Contract address?',
  supply    : E.pencil + ' Total supply?\n<i>Shorthand: 1B, 500M, 1.5B, 100K or full number</i>',
  maxwallet : E.pencil + ' Max wallet %?\n<i>e.g. 4.9% and token count auto-calculates\nOr both: 4.9% / 49M \u2014 or - to skip</i>',
  taxes     : E.pencil + ' Tax? (buy/sell)\n<i>e.g. 5 if same both sides, or 5/3 \u2014 or - if none</i>',
  twitter   : E.pencil + ' Twitter/X link?',
  website   : E.pencil + ' Website? <i>(- to skip)</i>',
  renounced : E.pencil + ' Contract renounced? <b>yes</b> or <b>no</b>',
  locked    : E.pencil + ' LP locked? <b>yes</b> or <b>no</b>',
  narrative : E.pencil + ' Token narrative / story?\n<i>What makes it unique. Used for AI personality.</i>',
  image     : E.pencil + ' Send bot image (JPG or PNG)\n<i>- to skip</i>',
  bottoken  : E.pencil + ' BotFather token?\n\n<i>1. Open @BotFather\n2. Send /newbot\n3. Enter name then username (must end in bot)\n4. Copy the token it gives you</i>',
};

function newSession(isAddbot) {
  return {
    step: isAddbot ? 'chain' : 'chain',
    isAddbot: !!isAddbot,
    lastBotMsgId: null,
    data: {
      chain:'bsc', mode:'full', status:'launch', personality:'alpha',
      tokenName:'', ticker:'', ca:'', supply:'',
      maxWalletPct:'', maxWalletTokens:'', buyTax:'', sellTax:'',
      twitter:'', website:'', renounced:'', locked:'', narrative:'',
      botToken:'', revealCmd:'', hideCmd:'',
      renderUrl:'', repoName:'',
    },
    imageBuffer: null,
  };
}

function processInput(s, text) {
  var d = s.data;
  switch (s.step) {
    case 'name':      d.tokenName = text; break;
    case 'ticker':    d.ticker = text.startsWith('$') ? text : '$' + text; break;
    case 'ca':        d.ca = text.trim(); break;
    case 'supply':    d.supply = parseSupply(text); break;
    case 'maxwallet':
      if (text === '-') { d.maxWalletPct = ''; d.maxWalletTokens = ''; break; }
      var mw = text.split('/');
      d.maxWalletPct = ensurePct((mw[0] || text).trim());
      if (mw[1]) {
        d.maxWalletTokens = parseSupply(mw[1].trim());
      } else if (d.supply && d.maxWalletPct) {
        var pct = parseFloat(d.maxWalletPct);
        var sup = parseInt(d.supply.replace(/,/g, ''));
        if (!isNaN(pct) && !isNaN(sup)) d.maxWalletTokens = fmtNum(Math.round(sup * pct / 100).toString());
      }
      break;
    case 'taxes':
      if (text === '-') { d.buyTax = '0'; d.sellTax = '0'; break; }
      var tx = text.split('/');
      d.buyTax  = (tx[0] || text).trim().replace(/[^0-9.]/g, '');
      d.sellTax = (tx[1] ? tx[1].trim().replace(/[^0-9.]/g, '') : d.buyTax);
      break;
    case 'twitter':   d.twitter = text; break;
    case 'website':   d.website = (text === '-' ? '' : text); break;
    case 'renounced': d.renounced = /yes/i.test(text) ? 'RENOUNCED' : 'NOT RENOUNCED'; break;
    case 'locked':    d.locked   = /yes/i.test(text) ? 'LOCKED'    : 'NOT LOCKED'; break;
    case 'narrative': d.narrative = (text === '-' ? '' : text); break;
    case 'bottoken':  d.botToken  = text.trim(); break;
    case 'renderurl': d.renderUrl = text.trim().replace(/\/+$/, ''); d.repoName = repoFromUrl(d.renderUrl); break;
  }
}

function nextTextStep(currentStep, isAddbot) {
  var steps = isAddbot
    ? ['name','ticker','ca','supply','maxwallet','taxes','twitter','website','renounced','locked','narrative','image','renderurl','bottoken']
    : ['name','ticker','ca','supply','maxwallet','taxes','twitter','website','renounced','locked','narrative','image','bottoken'];
  var idx = steps.indexOf(currentStep);
  return idx >= 0 && idx + 1 < steps.length ? steps[idx + 1] : 'confirm';
}

function buildSummary(s) {
  var d = s.data;
  var ci = CHAIN_INFO[d.chain] || CHAIN_INFO.bsc;
  return (
    E.fire + ' <b>Review before deploying</b>\n\n' +
    '<b>Chain:</b> ' + ci.label + '\n' +
    '<b>Mode:</b> ' + (d.mode === 'guard' ? E.shield + ' Guard' : E.robot + ' Full') + '\n' +
    '<b>Status:</b> ' + (d.status === 'cto' ? E.shield + ' CTO' : E.rocket + ' Active dev') + '\n' +
    '<b>Personality:</b> ' + (PERS_LABELS[d.personality] || d.personality) + '\n' +
    '<b>Token:</b> ' + d.tokenName + ' ' + d.ticker + '\n' +
    '<b>CA:</b> <code>' + d.ca + '</code>\n' +
    '<b>Supply:</b> ' + d.supply + '\n' +
    (d.maxWalletPct ? '<b>Max Wallet:</b> ' + d.maxWalletPct + (d.maxWalletTokens ? ' / ' + d.maxWalletTokens : '') + '\n' : '') +
    '<b>Tax:</b> ' + d.buyTax + '% buy / ' + d.sellTax + '% sell\n' +
    '<b>Twitter:</b> ' + d.twitter + '\n' +
    (d.website ? '<b>Website:</b> ' + d.website + '\n' : '') +
    '<b>Contract:</b> ' + d.renounced + '  <b>LP:</b> ' + d.locked + '\n' +
    '<b>Image:</b> ' + (s.imageBuffer ? E.check + ' ready' : '\u2014 none') + '\n' +
    '<i>Reveal/hide commands are auto-generated and secret</i>\n\n' +
    'Type <b>yes</b> to deploy \u2014 <b>no</b> to cancel.'
  );
}

function buildAddbotSummary(s) {
  var d = s.data;
  var ci = CHAIN_INFO[d.chain] || CHAIN_INFO.bsc;
  return (
    E.wrench + ' <b>Review bot details</b>\n\n' +
    '<b>Chain:</b> ' + ci.label + '\n' +
    '<b>Mode:</b> ' + (d.mode === 'guard' ? E.shield + ' Guard' : E.robot + ' Full') + '\n' +
    '<b>Status:</b> ' + (d.status === 'cto' ? E.shield + ' CTO' : E.rocket + ' Active dev') + '\n' +
    '<b>Token:</b> ' + d.tokenName + ' ' + d.ticker + '\n' +
    '<b>CA:</b> <code>' + d.ca + '</code>\n' +
    '<b>Supply:</b> ' + d.supply + '\n' +
    '<b>Tax:</b> ' + d.buyTax + '% buy / ' + d.sellTax + '% sell\n' +
    '<b>Twitter:</b> ' + d.twitter + '\n' +
    '<b>Render URL:</b> ' + d.renderUrl + '\n' +
    (d.repoName ? '<b>Repo:</b> ' + d.repoName + '\n' : '') + '\n' +
    'Type <b>yes</b> to register \u2014 <b>no</b> to cancel.'
  );
}

// 
// BUTTON HELPERS
// 
function chainButtons(uid) {
  return { inline_keyboard: [
    [{ text: E.bnb + ' BNB Smart Chain', callback_data: 'bld_chain_bsc_' + uid }],
    [{ text: E.sol + ' Solana',          callback_data: 'bld_chain_sol_' + uid }],
  ]};
}
function modeButtons(uid) {
  return { inline_keyboard: [
    [{ text: E.robot  + ' Full \u2014 AI replies + moderation + silence breaker', callback_data: 'bld_mode_full_'  + uid }],
    [{ text: E.shield + ' Guard \u2014 moderation + hardcoded answers only',       callback_data: 'bld_mode_guard_' + uid }],
  ]};
}
function statusButtons(uid) {
  return { inline_keyboard: [
    [{ text: E.rocket + ' New launch \u2014 dev is active',          callback_data: 'bld_status_launch_' + uid }],
    [{ text: E.shield + ' CTO \u2014 community takeover, dev gone',   callback_data: 'bld_status_cto_'   + uid }],
  ]};
}
function persButtons(uid) {
  return { inline_keyboard: [
    [{ text: '\u26A1 Alpha \u2014 sharp, bold, crypto-native',          callback_data: 'bld_pers_alpha_'        + uid }],
    [{ text: '\u{1F454} Professional \u2014 clean, precise, informative', callback_data: 'bld_pers_professional_' + uid }],
    [{ text: '\u{1F525} Hype \u2014 high energy, exciting, bullish',     callback_data: 'bld_pers_hype_'        + uid }],
    [{ text: '\u{1F91D} Community \u2014 warm, friendly, inclusive',     callback_data: 'bld_pers_community_'   + uid }],
  ]};
}

async function sendStep(ctx, s, ask, kb) {
  try { if (s.lastBotMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, s.lastBotMsgId); } catch(_) {}
  var m = await ctx.reply(ask, { parse_mode: 'HTML', reply_markup: kb || undefined });
  s.lastBotMsgId = m.message_id;
}

// 
// COMMANDS
// 
bot.command('start', async function(ctx) {
  return ctx.reply(
    E.rocket + ' <b>Bot Factory</b>\n\n' +
    'Build and manage Telegram community bots for your token.\n\n' +
    '<b>Chains:</b> BNB Smart Chain \u2022 Solana\n' +
    '<b>Modes:</b> Full (AI) \u2022 Guard (moderation)\n' +
    '<b>Types:</b> New launch \u2022 CTO\n' +
    '<b>Personality:</b> Alpha \u2022 Professional \u2022 Hype \u2022 Community\n\n' +
    '<b>Commands:</b>\n' +
    '/build \u2014 Build a brand new bot\n' +
    '/addbot \u2014 Register an existing bot (+ store all its details)\n' +
    '/bots \u2014 List all your bots\n' +
    '/edit \u2014 Edit a bot (twitter, narrative, image, personality, CTO)\n' +
    '/update \u2014 Push latest factory improvements to bot(s)\n' +
    '/rebuild \u2014 Full regeneration of a bot from stored data\n' +
    '/stats \u2014 Check which bots are online\n' +
    '/addgroq \u2014 Add a Groq API key\n' +
    '/cancel \u2014 Cancel current operation',
    { parse_mode: 'HTML' }
  );
});

bot.command('help', function(ctx) {
  return ctx.reply(
    '/build \u2014 New bot\n' +
    '/addbot \u2014 Register existing bot\n' +
    '/bots \u2014 List bots\n' +
    '/edit \u2014 Edit a bot\n' +
    '/update \u2014 Push factory fixes\n' +
    '/rebuild \u2014 Full regeneration\n' +
    '/stats \u2014 Health check\n' +
    '/addgroq \u2014 Add Groq key\n' +
    '/cancel \u2014 Cancel'
  );
});

bot.command(['build', 'new'], async function(ctx) {
  var uid = String(ctx.from.id);
  sessions[uid] = newSession(false);
  try { await ctx.deleteMessage(); } catch(_) {}
  var m = await ctx.reply(
    E.rocket + ' <b>New bot \u2014 Step 1</b>\n\nSelect chain:',
    { parse_mode: 'HTML', reply_markup: chainButtons(uid) }
  );
  sessions[uid].lastBotMsgId = m.message_id;
});

bot.command('addbot', async function(ctx) {
  var uid = String(ctx.from.id);
  sessions[uid] = newSession(true);
  try { await ctx.deleteMessage(); } catch(_) {}
  var m = await ctx.reply(
    E.wrench + ' <b>Register existing bot</b>\n\nThis stores all your token details so the factory can manage the bot properly.\n\nStep 1 \u2014 Select chain:',
    { parse_mode: 'HTML', reply_markup: chainButtons(uid) }
  );
  sessions[uid].lastBotMsgId = m.message_id;
});

bot.command('cancel', function(ctx) {
  var uid = String(ctx.from.id);
  delete sessions[uid];
  delete editSessions[uid];
  return ctx.reply(E.xmark + ' Cancelled.');
});

var groqKeySessions = {};
bot.command('addgroq', async function(ctx) {
  var uid = String(ctx.from.id);
  groqKeySessions[uid] = true;
  try { await ctx.deleteMessage(); } catch(_) {}
  return ctx.reply(E.gear + ' Send your Groq API key and it will be added automatically.');
});

bot.command('bots', async function(ctx) {
  if (!botRegistry.length) return ctx.reply(E.list + ' No bots yet. Use /build or /addbot.');
  var msg = E.list + ' <b>Your Bots</b>\n\n';
  botRegistry.forEach(function(b, i) {
    msg += (i + 1) + '. ' + E.rocket + ' <b>' + b.ticker + '</b> (' + (b.chain || 'bsc').toUpperCase() + ')\n';
    msg += '   ' + (b.mode === 'guard' ? E.shield + ' Guard' : E.robot + ' Full') + ' \u2022 ';
    msg += (b.data && b.data.status === 'cto' ? 'CTO' : 'Active dev') + '\n';
    msg += '   ' + E.link + ' ' + b.url + '\n\n';
  });
  return ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.command('stats', async function(ctx) {
  if (!botRegistry.length) return ctx.reply(E.stats + ' No bots registered.');
  await ctx.reply(E.stats + ' Checking bots...');
  var msg = E.stats + ' <b>Bot Health</b>\n\n';
  for (var i = 0; i < botRegistry.length; i++) {
    var b = botRegistry[i];
    var alive = false;
    try {
      var r = await Promise.race([
        fetch(b.url + '/health'),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('timeout')); }, 8000); }),
      ]);
      alive = r && r.ok;
    } catch(_) {}
    msg += (i + 1) + '. <b>' + b.ticker + '</b> \u2014 ' + (alive ? E.check + ' Online' : E.xmark + ' Offline') + '\n';
    msg += '   ' + b.url + '\n\n';
  }
  return ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
});

bot.command('edit', async function(ctx) {
  if (!botRegistry.length) return ctx.reply(E.wrench + ' No bots to edit.');
  var kb = botRegistry.map(function(b, i) {
    return [{ text: b.ticker + ' (' + (b.chain || 'bsc').toUpperCase() + ')', callback_data: 'edit_pick_' + i }];
  });
  return ctx.reply(E.wrench + ' <b>Which bot?</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});

bot.command('update', async function(ctx) {
  var eligible = botRegistry.filter(function(b) { return b.repoName && b.ghOwner && b.data && b.data.ticker; });
  var noData   = botRegistry.filter(function(b) { return !b.data || !b.data.ticker; });
  if (!eligible.length && !noData.length) return ctx.reply(E.wrench + ' No bots registered. Use /addbot.');
  var msg = '';
  if (noData.length) {
    msg += E.warn + ' These bots have no stored data and cannot be updated:\n';
    noData.forEach(function(b) { msg += '\u2022 ' + b.ticker + ' \u2014 use /addbot to register with full details\n'; });
    msg += '\n';
  }
  if (!eligible.length) return ctx.reply(msg.trim(), { parse_mode: 'HTML' });
  var kb = eligible.map(function(b) {
    var i = botRegistry.indexOf(b);
    return [{ text: b.ticker + ' (' + (b.chain || 'bsc').toUpperCase() + ')', callback_data: 'upd_bot_' + i }];
  });
  kb.push([{ text: E.gear + ' Update ALL', callback_data: 'upd_bot_all' }]);
  if (msg) await ctx.reply(msg, { parse_mode: 'HTML' });
  return ctx.reply(E.wrench + ' <b>Push latest factory code to:</b>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});

bot.command('rebuild', async function(ctx) {
  var eligible = botRegistry.filter(function(b) { return b.repoName && b.ghOwner && b.data && b.data.ticker; });
  if (!eligible.length) return ctx.reply(E.wrench + ' No bots with full data. Use /addbot first.');
  var kb = eligible.map(function(b) {
    var i = botRegistry.indexOf(b);
    return [{ text: b.ticker + ' (' + (b.chain || 'bsc').toUpperCase() + ')', callback_data: 'rbd_bot_' + i }];
  });
  return ctx.reply(
    E.gear + ' <b>Full rebuild</b>\nRegenerates bot code from stored data. Use after changing personality, mode, or CTO status.',
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
  );
});

// 
// BUILD BUTTON CALLBACKS
// 
bot.action(/^bld_chain_(bsc|sol)_(.+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var uid = ctx.match[2], s = sessions[uid];
  if (!s) return ctx.reply(E.xmark + ' Session expired. Start again.');
  s.data.chain = ctx.match[1];
  s.step = 'mode';
  try { await ctx.deleteMessage(); } catch(_) {}
  await sendStep(ctx, s, (s.isAddbot ? E.wrench + ' Register bot \u2014 Step 2\n\n' : E.rocket + ' New bot \u2014 Step 2\n\n') + 'Bot mode:', modeButtons(uid));
});

bot.action(/^bld_mode_(full|guard)_(.+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var uid = ctx.match[2], s = sessions[uid];
  if (!s) return ctx.reply(E.xmark + ' Session expired.');
  s.data.mode = ctx.match[1];
  s.step = 'status';
  try { await ctx.deleteMessage(); } catch(_) {}
  await sendStep(ctx, s, 'Project status:', statusButtons(uid));
});

bot.action(/^bld_status_(launch|cto)_(.+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var uid = ctx.match[2], s = sessions[uid];
  if (!s) return ctx.reply(E.xmark + ' Session expired.');
  s.data.status = ctx.match[1];
  try { await ctx.deleteMessage(); } catch(_) {}
  if (s.data.mode === 'full') {
    s.step = 'personality';
    await sendStep(ctx, s, 'Bot personality:', persButtons(uid));
  } else {
    s.step = 'name';
    await sendStep(ctx, s, BUILD_ASKS.name);
  }
});

bot.action(/^bld_pers_(alpha|professional|hype|community)_(.+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var uid = ctx.match[2], s = sessions[uid];
  if (!s) return ctx.reply(E.xmark + ' Session expired.');
  s.data.personality = ctx.match[1];
  s.step = 'name';
  try { await ctx.deleteMessage(); } catch(_) {}
  await sendStep(ctx, s, BUILD_ASKS.name);
});

// 
// IMAGE HANDLER
// 
bot.on('photo', async function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'image') return;
  var ph = ctx.message.photo[ctx.message.photo.length - 1];
  try {
    var lnk = await ctx.telegram.getFileLink(ph.file_id);
    var rb = await fetch(lnk.href);
    var ab = await rb.arrayBuffer();
    s.imageBuffer = Buffer.from(ab);
  } catch(e) { return ctx.reply(E.xmark + ' Image error: ' + e.message); }
  try { await ctx.deleteMessage(); } catch(_) {}
  try { if (s.lastBotMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, s.lastBotMsgId); } catch(_) {}
  s.step = nextTextStep('image', s.isAddbot);
  if (s.step === 'confirm') {
    var m = await ctx.reply(s.isAddbot ? buildAddbotSummary(s) : buildSummary(s), { parse_mode: 'HTML' });
    s.lastBotMsgId = m.message_id;
  } else {
    var m2 = await ctx.reply(E.check + ' Image saved!\n\n' + (BUILD_ASKS[s.step] || ''), { parse_mode: 'HTML' });
    s.lastBotMsgId = m2.message_id;
  }
});

// 
// TEXT HANDLER
// 
bot.on('text', async function(ctx) {
  var uid = String(ctx.from.id);
  var text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  // Groq key
  if (groqKeySessions[uid]) {
    delete groqKeySessions[uid];
    try { await ctx.deleteMessage(); } catch(_) {}
    if (!text || text.length < 20) return ctx.reply(E.xmark + ' That does not look like a valid key. Try /addgroq again.');
    groqPool.push(text.trim());
    return ctx.reply(E.check + ' Groq key added. Pool: ' + groqPool.length + ' key(s).');
  }

  var s = sessions[uid];
  if (!s) return ctx.reply('Use /build to build a new bot, /addbot to register one, or /help for all commands.');

  try { await ctx.deleteMessage(); } catch(_) {}
  try { if (s.lastBotMsgId) await ctx.telegram.deleteMessage(ctx.chat.id, s.lastBotMsgId); } catch(_) {}
  s.lastBotMsgId = null;

  // Button-only steps
  if (['chain','mode','status','personality'].includes(s.step)) {
    var m = await ctx.reply('Please use the buttons to select.', { parse_mode: 'HTML' });
    s.lastBotMsgId = m.message_id; return;
  }

  if (s.step === 'image') {
    if (text === '-') {
      s.imageBuffer = null;
      s.step = nextTextStep('image', s.isAddbot);
    } else {
      var m2 = await ctx.reply('Send an image photo or type <b>-</b> to skip.', { parse_mode: 'HTML' });
      s.lastBotMsgId = m2.message_id; return;
    }
  } else {
    processInput(s, text);
    s.step = nextTextStep(s.step, s.isAddbot);
  }

  if (s.step === 'confirm') {
    var m3 = await ctx.reply(s.isAddbot ? buildAddbotSummary(s) : buildSummary(s), { parse_mode: 'HTML' });
    s.lastBotMsgId = m3.message_id; return;
  }

  if (s.step === 'confirm' && text.toLowerCase() === 'yes') {
    return s.isAddbot ? registerBot(ctx, s, uid) : runBuild(ctx, s, uid);
  }

  if (s.step === 'confirm') {
    if (/^yes$/i.test(text)) return s.isAddbot ? registerBot(ctx, s, uid) : runBuild(ctx, s, uid);
    delete sessions[uid];
    return ctx.reply(E.xmark + ' Cancelled.');
  }

  var ask = BUILD_ASKS[s.step] || 'Continue:';
  var m4 = await ctx.reply(ask, { parse_mode: 'HTML' });
  s.lastBotMsgId = m4.message_id;
});

// Handle yes/no at confirm step
bot.on('text', async function() {}); // placeholder  handled above

// Intercept confirm replies
bot.hears(/^yes$/i, async function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'confirm') return;
  try { await ctx.deleteMessage(); } catch(_) {}
  return s.isAddbot ? registerBot(ctx, s, uid) : runBuild(ctx, s, uid);
});
bot.hears(/^no$/i, async function(ctx) {
  var uid = String(ctx.from.id);
  if (!sessions[uid]) return;
  delete sessions[uid];
  try { await ctx.deleteMessage(); } catch(_) {}
  return ctx.reply(E.xmark + ' Cancelled.');
});

// 
// EDIT CALLBACKS
// 
bot.action(/^edit_pick_(\d+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var i = parseInt(ctx.match[1]);
  var b = botRegistry[i];
  if (!b) return ctx.reply('Bot not found.');
  var uid = String(ctx.from.id);
  editSessions[uid] = { botIdx: i };
  var ctoLabel = b.data && b.data.status === 'cto' ? 'Switch to Launch mode' : 'Switch to CTO mode';
  var kb = [
    [{ text: 'Twitter/X link',  callback_data: 'ef_twitter_'     + i }],
    [{ text: 'Website',         callback_data: 'ef_website_'     + i }],
    [{ text: 'Narrative',       callback_data: 'ef_narrative_'   + i }],
    [{ text: 'Personality',     callback_data: 'ef_personality_' + i }],
    [{ text: 'Bot image',       callback_data: 'ef_image_'       + i }],
    [{ text: ctoLabel,          callback_data: 'ef_cto_'         + i }],
    [{ text: E.xmark + ' Cancel', callback_data: 'edit_cancel'      }],
  ];
  try { await ctx.deleteMessage(); } catch(_) {}
  return ctx.reply(E.wrench + ' <b>Edit ' + b.ticker + '</b>\nWhat to change?', { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
});

bot.action(/^ef_(twitter|website|narrative|image)_(\d+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var field = ctx.match[1], i = parseInt(ctx.match[2]), uid = String(ctx.from.id);
  editSessions[uid] = { botIdx: i, field: field };
  var asks = {
    twitter   : 'Send new Twitter/X link:',
    website   : 'Send new website URL (- to remove):',
    narrative : 'Send the new token narrative:',
    image     : 'Send new bot image (photo):',
  };
  try { await ctx.deleteMessage(); } catch(_) {}
  return ctx.reply(asks[field]);
});

bot.action(/^ef_personality_(\d+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var i = parseInt(ctx.match[1]), uid = String(ctx.from.id);
  editSessions[uid] = { botIdx: i, field: 'personality' };
  try { await ctx.deleteMessage(); } catch(_) {}
  return ctx.reply(E.star + ' Choose personality:', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
    [{ text: '\u26A1 Alpha \u2014 sharp, bold, crypto-native',          callback_data: 'ep_alpha_'        + i }],
    [{ text: '\u{1F454} Professional \u2014 clean, precise, informative', callback_data: 'ep_professional_' + i }],
    [{ text: '\u{1F525} Hype \u2014 high energy, exciting, bullish',     callback_data: 'ep_hype_'        + i }],
    [{ text: '\u{1F91D} Community \u2014 warm, friendly, inclusive',     callback_data: 'ep_community_'   + i }],
    [{ text: E.xmark + ' Cancel', callback_data: 'edit_cancel' }],
  ]}});
});

bot.action(/^ep_(alpha|professional|hype|community)_(\d+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var pers = ctx.match[1], i = parseInt(ctx.match[2]), uid = String(ctx.from.id);
  var b = botRegistry[i]; if (!b) return ctx.reply('Bot not found.');
  b.data = b.data || {}; b.data.personality = pers;
  delete editSessions[uid];
  try { await ctx.deleteMessage(); } catch(_) {}
  await ctx.reply(E.gear + ' Updating personality...');
  if (b.repoName && b.ghOwner) {
    var code = generateBotCode(b.data, CHAIN_INFO[b.chain] || CHAIN_INFO.bsc, b.mode);
    try {
      await githubPushFileUpdate(b.ghOwner, b.repoName, 'bot.js', Buffer.from(code));
      saveRegistry();
      return ctx.reply(E.check + ' <b>' + b.ticker + '</b> personality set to <b>' + (PERS_LABELS[pers] || pers) + '</b>\nRender redeploys in ~1 min.', { parse_mode: 'HTML' });
    } catch(e) { return ctx.reply(E.xmark + ' Failed: ' + e.message); }
  }
  saveRegistry();
  return ctx.reply(E.check + ' Personality saved. Use /rebuild to push to the bot.', { parse_mode: 'HTML' });
});

bot.action(/^ef_cto_(\d+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  var i = parseInt(ctx.match[1]);
  var b = botRegistry[i]; if (!b) return ctx.reply('Bot not found.');
  b.data = b.data || {};
  b.data.status = b.data.status === 'cto' ? 'launch' : 'cto';
  try { await ctx.deleteMessage(); } catch(_) {}
  await ctx.reply(E.gear + ' Switching status...');
  if (b.repoName && b.ghOwner) {
    var code = generateBotCode(b.data, CHAIN_INFO[b.chain] || CHAIN_INFO.bsc, b.mode);
    try {
      await githubPushFileUpdate(b.ghOwner, b.repoName, 'bot.js', Buffer.from(code));
      saveRegistry();
      return ctx.reply(E.check + ' <b>' + b.ticker + '</b> switched to <b>' + (b.data.status === 'cto' ? 'CTO mode' : 'Launch mode') + '</b>\nRender redeploys in ~1 min.', { parse_mode: 'HTML' });
    } catch(e) { return ctx.reply(E.xmark + ' Failed: ' + e.message); }
  }
  saveRegistry();
  return ctx.reply(E.check + ' Status updated. Use /rebuild to push.', { parse_mode: 'HTML' });
});

bot.action('edit_cancel', async function(ctx) {
  await ctx.answerCbQuery();
  delete editSessions[String(ctx.from.id)];
  try { await ctx.deleteMessage(); } catch(_) {}
  return ctx.reply(E.xmark + ' Cancelled.');
});

// Edit text + image handler
bot.on('photo', async function(ctx) {
  var uid = String(ctx.from.id);
  var es = editSessions[uid];
  if (!es || es.field !== 'image') return;
  var b = botRegistry[es.botIdx]; if (!b) return;
  if (!b.repoName || !b.ghOwner) {
    delete editSessions[uid];
    return ctx.reply(E.warn + ' This bot has no GitHub repo linked. Register it properly with /addbot first.');
  }
  var ph = ctx.message.photo[ctx.message.photo.length - 1];
  try {
    var lnk = await ctx.telegram.getFileLink(ph.file_id);
    var rb = await fetch(lnk.href);
    var ab = await rb.arrayBuffer();
    var buf = Buffer.from(ab);
    await ctx.reply(E.gear + ' Updating image...');
    await githubPushFileUpdate(b.ghOwner, b.repoName, 'siren.jpg', buf);
    delete editSessions[uid];
    return ctx.reply(E.check + ' Image updated! Render redeploys in ~1 min.');
  } catch(e) {
    delete editSessions[uid];
    return ctx.reply(E.xmark + ' Failed: ' + e.message);
  }
});

bot.on('text', async function(ctx) {
  var uid = String(ctx.from.id);
  var es = editSessions[uid];
  if (!es || !es.field || es.field === 'image' || es.field === 'personality') return;
  var text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;
  var b = botRegistry[es.botIdx]; if (!b) { delete editSessions[uid]; return; }
  try { await ctx.deleteMessage(); } catch(_) {}
  b.data = b.data || {};
  if (es.field === 'twitter')   b.data.twitter   = text;
  if (es.field === 'website')   b.data.website    = (text === '-' ? '' : text);
  if (es.field === 'narrative') b.data.narrative  = text;
  await ctx.reply(E.gear + ' Updating...');
  if (b.repoName && b.ghOwner) {
    var code = generateBotCode(b.data, CHAIN_INFO[b.chain] || CHAIN_INFO.bsc, b.mode);
    try {
      await githubPushFileUpdate(b.ghOwner, b.repoName, 'bot.js', Buffer.from(code));
      saveRegistry();
      delete editSessions[uid];
      return ctx.reply(E.check + ' <b>' + b.ticker + '</b> \u2014 <b>' + es.field + '</b> updated!\nRender redeploys in ~1 min. No action needed.', { parse_mode: 'HTML' });
    } catch(e) { delete editSessions[uid]; return ctx.reply(E.xmark + ' Failed: ' + e.message); }
  }
  saveRegistry();
  delete editSessions[uid];
  return ctx.reply(E.check + ' Saved. Use /rebuild to push to the bot.');
});

// UPDATE callbacks
bot.action(/^upd_bot_(\d+|all)$/, async function(ctx) {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch(_) {}
  var target = ctx.match[1];
  var bots = target === 'all'
    ? botRegistry.filter(function(b) { return b.repoName && b.ghOwner && b.data && b.data.ticker; })
    : [botRegistry[parseInt(target)]].filter(Boolean);
  if (!bots.length) return ctx.reply(E.xmark + ' Nothing to update.');
  await ctx.reply(E.gear + ' Updating ' + bots.length + ' bot(s)...');
  var results = [];
  for (var i = 0; i < bots.length; i++) {
    var b = bots[i];
    try {
      var code = generateBotCode(b.data, CHAIN_INFO[b.chain] || CHAIN_INFO.bsc, b.mode);
      await githubPushFileUpdate(b.ghOwner, b.repoName, 'bot.js', Buffer.from(code));
      results.push(E.check + ' <b>' + b.ticker + '</b>');
    } catch(e) {
      results.push(E.xmark + ' <b>' + b.ticker + '</b>: ' + e.message.slice(0, 80));
    }
  }
  return ctx.reply(results.join('\n') + '\n\nRender redeploys automatically.', { parse_mode: 'HTML' });
});

// REBUILD callbacks
bot.action(/^rbd_bot_(\d+)$/, async function(ctx) {
  await ctx.answerCbQuery();
  try { await ctx.deleteMessage(); } catch(_) {}
  var b = botRegistry[parseInt(ctx.match[1])];
  if (!b || !b.repoName || !b.ghOwner) return ctx.reply(E.xmark + ' Bot not found or no repo linked.');
  await ctx.reply(E.gear + ' Rebuilding <b>' + b.ticker + '</b>...', { parse_mode: 'HTML' });
  try {
    var code = generateBotCode(b.data, CHAIN_INFO[b.chain] || CHAIN_INFO.bsc, b.mode);
    await githubPushFileUpdate(b.ghOwner, b.repoName, 'bot.js', Buffer.from(code));
    await githubPushFileUpdate(b.ghOwner, b.repoName, 'package.json', Buffer.from(generatePackageJson(b.data.tokenName, b.mode)));
    return ctx.reply(E.check + ' <b>' + b.ticker + '</b> fully rebuilt!\nRender redeploys in ~1 min.', { parse_mode: 'HTML' });
  } catch(e) { return ctx.reply(E.xmark + ' Failed: ' + e.message); }
});

// 
// BUILD ORCHESTRATOR
// 
async function runBuild(ctx, s, uid) {
  var d = s.data;
  var ci = CHAIN_INFO[d.chain] || CHAIN_INFO.bsc;
  var groqKey = d.mode === 'full' ? nextGroqKey() : '';
  if (d.mode === 'full' && !groqKey) return ctx.reply(E.xmark + ' No Groq key. Use /addgroq first.');
  d.revealCmd = rndCmd();
  d.hideCmd   = rndCmd();
  var repoName = d.ticker.replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase() + '-bot-' + rndStr(4);
  var guessUrl = 'https://' + repoName + '.onrender.com';
  await ctx.reply(E.gear + ' Deploying <b>' + d.ticker + '</b>...', { parse_mode: 'HTML' });
  var ghOwner = '', serviceId = '', actualUrl = guessUrl;
  var steps = [
    { name: 'GitHub repo', fn: async function() {
      var g = await githubCreateRepo(repoName);
      ghOwner = g.full_name.split('/')[0]; GH_OWNER = GH_OWNER || ghOwner;
      await sleep(4000);
      await githubPushFileWithRetry(ghOwner, repoName, 'bot.js', Buffer.from(generateBotCode(d, ci, d.mode)));
      await githubPushFileWithRetry(ghOwner, repoName, 'package.json', Buffer.from(generatePackageJson(d.tokenName, d.mode)));
      if (s.imageBuffer) await githubPushFileWithRetry(ghOwner, repoName, 'siren.jpg', s.imageBuffer);
    }},
    { name: 'Render service', fn: async function() {
      var ownerId = await renderGetOwnerId();
      var envVars = [{ key:'BOT_TOKEN', value:d.botToken }, { key:'WEBHOOK_URL', value:guessUrl }];
      if (d.mode === 'full') envVars.push({ key:'GROQ_API_KEY', value:groqKey });
      var svc = await renderCreateService(repoName, ghOwner, ownerId, envVars);
      serviceId  = svc.id;
      actualUrl  = (svc.serviceDetails && svc.serviceDetails.url) ? svc.serviceDetails.url : guessUrl;
      if (actualUrl !== guessUrl) {
        var uv = envVars.map(function(v) { return v.key === 'WEBHOOK_URL' ? { key:'WEBHOOK_URL', value:actualUrl } : v; });
        await renderSetEnvVars(serviceId, uv);
      }
    }},
    { name: 'Cron keepalive', fn: async function() { await cronCreateJob(repoName, actualUrl + '/health'); }},
  ];
  var failed = false;
  for (var i = 0; i < steps.length; i++) {
    try { await steps[i].fn(); await ctx.reply(E.check + ' ' + steps[i].name + ' done'); }
    catch(e) { await ctx.reply(E.xmark + ' <b>' + d.ticker + '</b>: ' + steps[i].name + ' failed\n<code>' + e.message.slice(0,300) + '</code>', { parse_mode:'HTML' }); failed=true; break; }
  }
  if (!failed) {
    botRegistry.push({ ticker:d.ticker, chain:d.chain, mode:d.mode, repoName:repoName, ghOwner:ghOwner, serviceId:serviceId, url:actualUrl, data:JSON.parse(JSON.stringify(d)), builtAt:Date.now() });
    saveRegistry();
    delete sessions[uid];
    await ctx.reply(
      E.party + ' <b>' + d.ticker + ' is live!</b>\n\n' +
      E.link   + ' Render URL:\n<code>' + actualUrl + '</code>\n\n' +
      E.folder + ' GitHub:\n<code>github.com/' + ghOwner + '/' + repoName + '</code>\n\n' +
      E.warn   + ' <b>Secret commands (save these):</b>\n' +
      'Reveal CA: <code>/' + d.revealCmd + '</code>\n' +
      'Hide CA:   <code>/' + d.hideCmd   + '</code>\n\n' +
      '<b>Next steps:</b>\n' +
      '1. Wait 3-5 min for Render to build\n' +
      '2. Add bot to your Telegram group\n' +
      '3. Make it admin (delete / ban / restrict)\n' +
      '4. Use <code>/' + d.revealCmd + '</code> to reveal CA when ready',
      { parse_mode: 'HTML', disable_web_page_preview: true }
    );
  } else { delete sessions[uid]; }
}

async function registerBot(ctx, s, uid) {
  var d = s.data;
  var existing = botRegistry.findIndex(function(b) { return b.url === d.renderUrl || b.ticker === d.ticker; });
  if (existing >= 0) {
    botRegistry[existing].data = JSON.parse(JSON.stringify(d));
    botRegistry[existing].repoName = d.repoName || botRegistry[existing].repoName;
    botRegistry[existing].chain    = d.chain;
    botRegistry[existing].mode     = d.mode;
    saveRegistry();
    delete sessions[uid];
    return ctx.reply(E.check + ' <b>' + d.ticker + '</b> updated in registry with full details!\nUse /rebuild to push updated code to the bot.', { parse_mode: 'HTML' });
  }
  botRegistry.push({
    ticker: d.ticker, chain: d.chain, mode: d.mode,
    repoName: d.repoName, ghOwner: GH_OWNER,
    url: d.renderUrl, data: JSON.parse(JSON.stringify(d)), builtAt: Date.now(),
  });
  saveRegistry();
  delete sessions[uid];
  return ctx.reply(
    E.check + ' <b>' + d.ticker + '</b> registered with full details!\n\n' +
    'You can now use:\n' +
    '/rebuild \u2014 push fresh code to the bot\n' +
    '/edit \u2014 change twitter, narrative, personality etc\n' +
    '/stats \u2014 check if it\'s online',
    { parse_mode: 'HTML' }
  );
}


// 
// GITHUB API
// 
async function githubCreateRepo(name) {
  var r = await fetch('https://api.github.com/user/repos', {
    method:'POST', headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},
    body: JSON.stringify({ name:name, private:false, auto_init:false }),
  });
  var d = await r.json();
  if (!d.full_name) throw new Error('Repo create failed: ' + JSON.stringify(d).slice(0,200));
  return d;
}
async function githubPushFileWithRetry(owner, repo, filename, content) {
  var lastErr;
  for (var a = 0; a < 5; a++) {
    if (a > 0) await sleep(5000);
    try {
      var r = await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+filename, {
        method:'PUT', headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},
        body: JSON.stringify({ message:'Add '+filename, content:content.toString('base64') }),
      });
      var d = await r.json();
      if (d.content || d.commit) return d;
      lastErr = new Error('Push failed '+filename+': '+JSON.stringify(d).slice(0,200));
    } catch(e) { lastErr = e; }
  }
  throw lastErr;
}
async function githubPushFileUpdate(owner, repo, filename, content) {
  var sha = '';
  try {
    var rg = await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+filename, {
      headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'},
    });
    var dg = await rg.json(); sha = dg.sha || '';
  } catch(_) {}
  var body = { message:'Update '+filename, content:content.toString('base64') };
  if (sha) body.sha = sha;
  var r = await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+filename, {
    method:'PUT', headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  var d = await r.json();
  if (!d.content && !d.commit) throw new Error('Update failed: '+JSON.stringify(d).slice(0,200));
  return d;
}

// 
// RENDER API
// 
async function renderGetOwnerId() {
  var r = await fetch('https://api.render.com/v1/owners?limit=1', { headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json'} });
  var d = await r.json();
  if (!Array.isArray(d)||!d[0]) throw new Error('Render owner failed: '+JSON.stringify(d).slice(0,200));
  return d[0].owner ? d[0].owner.id : d[0].id;
}
async function renderCreateService(name, ghOwner, ownerId, envVars) {
  var r = await fetch('https://api.render.com/v1/services', {
    method:'POST', headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json','Content-Type':'application/json'},
    body: JSON.stringify({
      autoDeploy:'yes', branch:'main', name:name, ownerId:ownerId,
      repo:'https://github.com/'+ghOwner+'/'+name, type:'web_service',
      envVars:envVars||[],
      serviceDetails:{ runtime:'node', plan:'free', region:'oregon', numInstances:1, envSpecificDetails:{ buildCommand:'npm install', startCommand:'npm start' }},
    }),
  });
  var d = await r.json();
  var svc = d.service || d;
  if (!svc.id) throw new Error('Render create failed: '+JSON.stringify(d).slice(0,400));
  return svc;
}
async function renderSetEnvVars(serviceId, vars) {
  await fetch('https://api.render.com/v1/services/'+serviceId+'/env-vars', {
    method:'PUT', headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json','Content-Type':'application/json'},
    body: JSON.stringify(vars),
  });
}

// 
// CRON-JOB API (every 2 min)
// 
async function cronCreateJob(name, url) {
  await fetch('https://api.cron-job.org/jobs', {
    method:'PUT', headers:{'Authorization':'Bearer '+CRON_KEY,'Content-Type':'application/json'},
    body: JSON.stringify({ job:{ url:url, title:name+' keepalive', enabled:true, saveResponses:false,
      schedule:{ timezone:'UTC', hours:[-1], mdays:[-1], months:[-1], wdays:[-1],
        minutes:[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50,52,54,56,58] },
    }}),
  });
}

// 
// PACKAGE.JSON GENERATOR
// 
function generatePackageJson(tokenName, mode) {
  var deps = { telegraf:'^4.16.3', express:'^4.18.2' };
  if (mode === 'full') deps['groq-sdk'] = '^0.3.3';
  return JSON.stringify({
    name: (tokenName||'token').toLowerCase().replace(/[^a-z0-9]/g,'-')+'-bot',
    version:'1.0.0', main:'bot.js',
    scripts:{ start:'node bot.js' },
    dependencies:deps, engines:{ node:'>=18.0.0' },
  }, null, 2);
}

// 
// BOT CODE GENERATOR  unified entry point
// 
function generateBotCode(d, ci, mode) {
  return mode === 'guard' ? generateGuardBot(d, ci) : generateFullBot(d, ci);
}


// 
// GUARD BOT GENERATOR
// 
function generateGuardBot(d, ci) {
  var TICKER    = d.ticker    || '$TOKEN';
  var NAME      = d.tokenName || TICKER;
  var CA        = d.ca        || '';
  var SUPPLY    = d.supply    || 'N/A';
  var MAX_PCT   = d.maxWalletPct || 'N/A';
  var MAX_TOK   = d.maxWalletTokens || '';
  var BUY_TAX   = d.buyTax   || '0';
  var SELL_TAX  = d.sellTax  || '0';
  var TWITTER   = d.twitter  || '';
  var WEBSITE   = d.website  || '';
  var RENOUNCED = d.renounced || 'RENOUNCED';
  var LOCKED    = d.locked   || 'LOCKED';
  var IS_CTO    = d.status === 'cto';
  var REVEAL    = (d.revealCmd || 'revealca').replace(/^\//,'');
  var HIDE      = (d.hideCmd   || 'hideca').replace(/^\//,'');
  var CHART_URL = ci.chartBase + CA;
  var BUY_URL   = ci.dexUrl   + CA;
  var DEX_NAME  = ci.dex;
  var CHAIN_LBL = ci.label;

  var L = []; function ln(s) { L.push(s === undefined ? '' : String(s)); }

  ln("'use strict';");
  ln("var Telegraf=require('telegraf').Telegraf;");
  ln("var express=require('express');");
  ln("var fs=require('fs');");
  ln("var path=require('path');");
  ln("var BOT_TOKEN=process.env.BOT_TOKEN;");
  ln("var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();");
  ln("var PORT=process.env.PORT||3000;");
  ln("var CA='" + CA + "';");
  ln("var CHART='" + CHART_URL + "';");
  ln("var BUY='" + BUY_URL + "';");
  ln("var TWITTER='" + TWITTER + "';");
  ln("var WEBSITE='" + WEBSITE + "';");
  ln("var IS_CTO=" + (IS_CTO ? 'true' : 'false') + ";");
  ln("var E={lock:'\\u{1F512}',check:'\\u2705',copy:'\\u{1F4CB}',chart:'\\u{1F4C8}',money:'\\u{1F4B0}',gem:'\\u{1F48E}',shield:'\\u{1F6E1}',wave:'\\u{1F44B}'};");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("app.use(express.json());");
  ln("var _SF='/tmp/bot_state.json';");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("var caUnlocked=false,groupChatId=null;");
  ln("loadState();");
  ln("var imageMessages=new Map(),strikes=new Map(),spamTracker=new Map(),stickerTracker=new Map();");
  ln("var IMG=path.join(__dirname,'siren.jpg'),IMG_BUF=null;");
  ln("try{if(fs.existsSync(IMG))IMG_BUF=fs.readFileSync(IMG);}catch(_){}");
  ln("var STRIKE_RESET=86400000,SPAM_WINDOW=60000,SPAM_MAX=5;");
  ln("async function deletePrevImg(chatId){var mid=imageMessages.get(chatId);if(mid){try{await bot.telegram.deleteMessage(chatId,mid);}catch(_){}imageMessages.delete(chatId);}}");
  ln("async function sendImage(chatId,caption,extra){await deletePrevImg(chatId);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(chatId,{source:IMG_BUF},Object.assign({caption:caption,parse_mode:'HTML'},extra));imageMessages.set(chatId,m.message_id);return m;}catch(e){console.error('img:',e.message);IMG_BUF=null;}}return bot.telegram.sendMessage(chatId,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(chatId,msgId,delay){setTimeout(function(){try{bot.telegram.deleteMessage(chatId,msgId);}catch(_){}},delay);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid,reason){var s=getStrike(uid);s.count++;try{await ctx.deleteMessage();}catch(_){}var why=reason?' ('+reason+')':'';if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F Muted 5 min \\u2014 3 strikes'+why+'.');autoDelete(ctx.chat.id,m3.message_id,12000);}else{var m=await ctx.reply('\\u26A0\\uFE0F Warning '+s.count+'/3'+why);autoDelete(ctx.chat.id,m.message_id,10000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{count:0,since:now};if(now-t.since>SPAM_WINDOW)t={count:0,since:now};t.count++;spamTracker.set(uid,t);if(t.count>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard','asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash','garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("function hasBlockedLink(t){var u=t.match(/https?:\\/\\/[^\\s]+/g)||[];return u.some(function(x){return!x.includes('x.com')&&!x.includes('twitter.com');});}");
  ln("function hasTmeLink(t){return/t\\.me\\/[+a-zA-Z0-9_]+/.test(t)||/telegram\\.me\\//i.test(t);}");
  ln("function hasExtMention(t){if(!t)return false;var mm=t.match(/@[a-zA-Z0-9_]+/g)||[];if(mm.length>1)return true;if(mm.length===1){var idx=t.indexOf(mm[0]);if(idx>0)return true;}return false;}");
  ln("var notLiveMsgs=['" + TICKER + " hasn\\u2019t launched yet. CA coming soon.','Hold tight \\u2014 launch is close.','Not yet. Stay ready.','CA drops soon.'];");
  ln("var socialsIdx=0;");
  ln("function buildSocials(){var i=socialsIdx%3;socialsIdx++;var web=WEBSITE?'\\n\\u{1F310} <a href=\\''+WEBSITE+'\\'>Website</a>':'';if(i===0)return'<b>" + TICKER + " Links</b>\\n\\n<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+web;if(i===1)return E.chart+' <a href=\\''+CHART+'\\'>Chart</a>  '+E.money+' <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>Twitter/X</a>'+web;return'<a href=\\''+CHART+'\\'>DexScreener</a>  <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>X</a>'+(WEBSITE?' <a href=\\''+WEBSITE+'\\'>Site</a>':'');}");
  ln("function buildInfoReply(topic){");
  ln("  if(topic==='ca'){if(!caUnlocked)return{text:notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)],kb:null};return{text:CA+'\\n\\n'+E.lock+' " + RENOUNCED + " '+E.check+' LP " + LOCKED + "',kb:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}};}");
  ln("  if(topic==='x')return{text:'" + TICKER + " on X',kb:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}};");
  ln("  if(topic==='tax')return{text:'" + TICKER + " Tax: Buy " + BUY_TAX + "% \\u2022 Sell " + SELL_TAX + "%',kb:null};");
  ln("  if(topic==='maxwallet')return{text:'Max Wallet: " + MAX_PCT + (MAX_TOK ? ' ('+MAX_TOK+')' : '') + "\\nAnti-whale cap \\u2014 no wallet can hold more.',kb:null};");
  ln("  if(topic==='renounced')return{text:'Contract: " + RENOUNCED + "\\nPermanently locked. Nobody can change it.',kb:null};");
  ln("  if(topic==='locked')return{text:'LP: " + LOCKED + "\\nLiquidity is fully secured.',kb:null};");
  ln("  if(topic==='supply')return{text:'Total Supply: " + SUPPLY + "',kb:null};");
  ln("  if(topic==='socials')return{text:buildSocials(),kb:null};");
  ln("  if(topic==='dev'){");
  ln("    if(IS_CTO){var ctoOpts=['" + TICKER + " is a CTO \\u2014 community takeover. Original dev is gone. The community owns and runs this completely. No dev to rug. The holders are the team.','This is a CTO. Original dev walked away. The community stepped up and took full ownership of " + TICKER + ". Community power, not a dev.','No dev here \\u2014 " + TICKER + " is 100% community-owned. Original dev left. The community holds the wheel and drives this forward.','CTO project. Original dev is gone. Community took over " + TICKER + " completely. That is the strength here.'];return{text:ctoOpts[Math.floor(Math.random()*ctoOpts.length)],kb:null};}");
  ln("    return{text:'Dev is active, present and building. " + TICKER + " is a live project with a committed team.',kb:null};");
  ln("  }");
  ln("  return null;");
  ln("}");
  ln("function detectTopic(lower){if(['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca','show ca'].some(function(w){return lower===w||lower.includes(w);}))return'ca';if(lower==='x'||lower==='twitter'||lower.includes('twitter link')||lower.includes('follow on'))return'x';if(lower.includes('tax')||lower.includes('buy tax')||lower.includes('sell tax'))return'tax';if(lower.includes('max wallet')||lower.includes('maxwallet')||lower.includes('max hold'))return'maxwallet';if(lower.includes('renounced')||lower.includes('contract lock'))return'renounced';if(lower.includes(' lp ')||lower.includes('liquidity')||lower.includes('lp locked')||lower==='lp')return'locked';if(lower.includes('supply')||lower.includes('total supply'))return'supply';if(lower==='socials'||lower==='links'||lower.includes('website'))return'socials';if(lower.includes('dev')||lower.includes('team')||lower.includes('cto')||lower.includes('who run')||lower.includes('who own'))return'dev';return null;}");
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}");
  ln("  for(var i=0;i<ctx.message.new_chat_members.length;i++){");
  ln("    var mem=ctx.message.new_chat_members[i];");
  ln("    var handle=mem.username?'@'+mem.username:mem.first_name;");
  ln("    var opts=[handle+' just joined " + TICKER + ".\\n" + RENOUNCED + " \\u2022 LP " + LOCKED + " \\u2022 " + BUY_TAX + "%/" + SELL_TAX + "% tax\\n'+(caUnlocked?CA:'CA coming soon \\u2014 stay close.'),'Welcome, '+handle+'.\\n" + TICKER + " \\u2022 " + CHAIN_LBL + " \\u2022 " + RENOUNCED + " \\u2022 LP " + LOCKED + "\\n'+(caUnlocked?'CA: '+CA:'Launch incoming.'),handle+' joined " + TICKER + ".\\n" + BUY_TAX + "%/" + SELL_TAX + "% tax \\u2022 LP " + LOCKED + " \\u2022 " + RENOUNCED + "\\n'+(caUnlocked?CA:'CA reveals soon.')];");
  ln("    var msg=opts[Math.floor(Math.random()*opts.length)];");
  ln("    var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);");
  ln("  }");
  ln("});");
  ln("bot.on('sticker',async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid,'no forwards');var cnt=(stickerTracker.get(uid)||0)+1;stickerTracker.set(uid,cnt);if(cnt>3){try{await ctx.deleteMessage();}catch(_){}}});");
  ln("bot.on(['photo','video','document','audio','voice'],async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid,'no forwards');});");
  ln("bot.command('ca',async function(ctx){var r=buildInfoReply('ca');if(r.kb)return sendImage(ctx.chat.id,r.text,{reply_markup:r.kb});return ctx.reply(r.text,{parse_mode:'HTML'});});");
  ln("bot.command('x',async function(ctx){var r=buildInfoReply('x');return sendImage(ctx.chat.id,r.text,{reply_markup:r.kb});});");
  ln("bot.command('twitter',async function(ctx){var r=buildInfoReply('x');return sendImage(ctx.chat.id,r.text,{reply_markup:r.kb});});");
  ln("bot.command('tax',function(ctx){return ctx.reply(buildInfoReply('tax').text);});");
  ln("bot.command('info',function(ctx){return ctx.reply('<b>" + TICKER + "</b>\\nChain: " + CHAIN_LBL + "\\nSupply: " + SUPPLY + "\\nMax Wallet: " + MAX_PCT + (MAX_TOK?' / '+MAX_TOK:'') + "\\nBuy: " + BUY_TAX + "% | Sell: " + SELL_TAX + "%\\nContract: " + RENOUNCED + "\\nLP: " + LOCKED + "',{parse_mode:'HTML'});});");
  ln("bot.command('socials',function(ctx){return ctx.reply(buildSocials(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply(buildSocials(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('" + REVEAL + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('" + HIDE + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA is now HIDDEN.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.on('message',async function(ctx){var msg=ctx.message;if(!msg||!ctx.from)return;var uid=ctx.from.id,chatType=ctx.chat.type;var text=(msg.text||'').trim();var isPrivate=chatType==='private';if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}var admin=await isAdmin(ctx,uid);if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;stickerTracker.set(uid,0);if(msg.forward_from||msg.forward_sender_name||msg.forward_from_chat)return applyStrike(ctx,uid,'no forwards');if(hasBlockedLink(text))return applyStrike(ctx,uid,'no external links');if(hasTmeLink(text))return applyStrike(ctx,uid,'no TG invite links');if(hasExtMention(text))return applyStrike(ctx,uid,'no promoting other groups');if(hasFud(text))return applyStrike(ctx,uid,'no FUD');}if(!text)return;var lower=text.toLowerCase();var topic=detectTopic(lower);if(topic){var r=buildInfoReply(topic);if(r){if(topic==='ca')return sendImage(ctx.chat.id,r.text,r.kb?{reply_markup:r.kb}:{});if(topic==='x')return sendImage(ctx.chat.id,r.text,r.kb?{reply_markup:r.kb}:{});return ctx.reply(r.text,Object.assign({parse_mode:'HTML',disable_web_page_preview:true},r.kb?{reply_markup:r.kb}:{}));}}});");
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function registerWebhook(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Webhook:',url);return;}}catch(e){console.log('Attempt '+(i+1)+':',e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('" + TICKER + " guard bot on port '+PORT);try{await new Promise(function(r){setTimeout(r,2000);});}catch(_){}try{await registerWebhook();}catch(e){console.log(e.message);}setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);console.log('" + TICKER + " guard bot live');});");

  return L.join('\n');
}

// 
// FULL BOT GENERATOR
// 
function generateFullBot(d, ci) {
  var TICKER    = d.ticker    || '$TOKEN';
  var NAME      = d.tokenName || TICKER;
  var CA        = d.ca        || '';
  var SUPPLY    = d.supply    || 'N/A';
  var MAX_PCT   = d.maxWalletPct || 'N/A';
  var MAX_TOK   = d.maxWalletTokens || '';
  var BUY_TAX   = d.buyTax   || '0';
  var SELL_TAX  = d.sellTax  || '0';
  var TWITTER   = d.twitter  || '';
  var WEBSITE   = d.website  || '';
  var RENOUNCED = d.renounced || 'RENOUNCED';
  var LOCKED    = d.locked   || 'LOCKED';
  var IS_CTO    = d.status === 'cto';
  var NARR      = JSON.stringify(d.narrative || '');
  var PERSONALITY = d.personality || 'alpha';
  var PERS_STYLE = {
    alpha:        'Confident, sharp, and crypto-native. Talk like a seasoned degen who genuinely believes in the project. Direct and bold. No fluff.',
    professional: 'Clean, informative, and professional. Precise answers. Measured tone. Build trust through clarity and accuracy.',
    hype:         'High energy, exciting, and bullish. Match the community energy. Enthusiastic but genuine, never fake.',
    community:    'Warm, inclusive, and friendly. Make everyone feel welcome. Genuine and supportive like a trusted community member.',
  }[PERSONALITY] || 'Confident and direct.';
  var REVEAL    = (d.revealCmd || 'revealca').replace(/^\//,'');
  var HIDE      = (d.hideCmd   || 'hideca').replace(/^\//,'');
  var CHAIN_LBL = ci.label;
  var DEX_NAME  = ci.dex;
  var CHART_URL = ci.chartBase + CA;
  var BUY_URL   = ci.dexUrl   + CA;

  var L = []; function ln(s) { L.push(s === undefined ? '' : String(s)); }

  ln("'use strict';");
  ln("var Telegraf=require('telegraf').Telegraf;");
  ln("var express=require('express');");
  ln("var Groq=require('groq-sdk');");
  ln("var fs=require('fs');");
  ln("var path=require('path');");
  ln("var BOT_TOKEN=process.env.BOT_TOKEN;");
  ln("var GROQ_API_KEY=process.env.GROQ_API_KEY;");
  ln("var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();");
  ln("var PORT=process.env.PORT||3000;");
  ln("var CA='" + CA + "';");
  ln("var CHART='" + CHART_URL + "';");
  ln("var BUY='" + BUY_URL + "';");
  ln("var TWITTER='" + TWITTER + "';");
  ln("var WEBSITE='" + WEBSITE + "';");
  ln("var IS_CTO=" + (IS_CTO ? 'true' : 'false') + ";");
  ln("var TICKER='" + TICKER + "';");
  ln("var E={rocket:'\\u{1F680}',fire:'\\u{1F525}',chart:'\\u{1F4C8}',lock:'\\u{1F512}',check:'\\u2705',gem:'\\u{1F48E}',money:'\\u{1F4B0}',shield:'\\u{1F6E1}',wave:'\\u{1F44B}',copy:'\\u{1F4CB}'};");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("var groq=new Groq({apiKey:GROQ_API_KEY});");
  ln("app.use(express.json());");
  ln("var _SF='/tmp/bot_state.json';");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("var caUnlocked=false,groupChatId=null,silenceTimer=null;");
  ln("loadState();");
  ln("var imageMessages=new Map(),strikes=new Map(),spamTracker=new Map(),stickerTracker=new Map();");
  ln("var lastReplies=[],MAX_REPLY_HIST=12;");
  ln("var IMG=path.join(__dirname,'siren.jpg'),IMG_BUF=null;");
  ln("try{if(fs.existsSync(IMG))IMG_BUF=fs.readFileSync(IMG);}catch(_){}");
  ln("var SILENCE_DELAY=10*60*1000,STRIKE_RESET=86400000,SPAM_WINDOW=60000,SPAM_MAX=5;");

  // System prompt
  ln("function systemPrompt(withCa){");
  ln("  var facts=[");
  ln("    'You are the community bot for " + TICKER + ", a " + CHAIN_LBL + " meme token.',");
  ln("    'Token: " + NAME + " (" + TICKER + ") | Chain: " + CHAIN_LBL + "',");
  ln("    'Supply: " + SUPPLY + " | Max Wallet: " + MAX_PCT + (MAX_TOK ? ' (' + MAX_TOK + ')' : '') + "',");
  ln("    'Tax: " + BUY_TAX + "% buy / " + SELL_TAX + "% sell',");
  ln("    'Contract: " + RENOUNCED + " | LP: " + LOCKED + "',");
  ln("    " + (IS_CTO
    ? "'DEV: This is a CTO (community takeover). Original dev is gone. Community owns and runs ' + TICKER + ' completely. When asked about dev: explain clearly that original dev left and community took over. CTO is a strength.'"
    : "'DEV: Active, building, present. Never say or imply the dev stepped back or left.'") + ",");
  ln("    'Twitter: ' + TWITTER,");
  ln("  ];");
  ln("  if(withCa)facts.push('CA: '+CA+' | Chart: '+CHART+' | Buy on " + DEX_NAME + ": '+BUY);");
  ln("  var s=facts.join('\\n')+'\\n';");
  ln("  s+='\\nNARRATIVE: '+" + NARR + "+'\\n';");
  ln("  s+='\\nPERSONALITY STYLE: " + PERS_STYLE.replace(/'/g, "\\'") + "\\n';");
  ln("  s+='RULES: 2-4 lines max per reply. Natural and professional. Vary every reply. Never robotic. NEVER share TG group link. NEVER put emoji on same line as CA. NEVER repeat reply. If hype/casual/no real question: reply exactly IGNORE';");
  ln("  return s;");
  ln("}");

  ln("async function askGroq(sys,msg){var r=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',temperature:1.0,max_tokens:160,messages:[{role:'system',content:sys},{role:'user',content:msg}]});return r.choices[0].message.content.trim();}");
  ln("function isDupe(r){return lastReplies.includes(r);}");
  ln("function recordReply(r){lastReplies.push(r);if(lastReplies.length>MAX_REPLY_HIST)lastReplies.shift();}");
  ln("async function smartAsk(sys,p){var r=await askGroq(sys,p);if(isDupe(r))r=await askGroq(sys,p+' Give a completely different response.');recordReply(r);return r;}");
  ln("async function deletePrevImg(chatId){var mid=imageMessages.get(chatId);if(mid){try{await bot.telegram.deleteMessage(chatId,mid);}catch(_){}imageMessages.delete(chatId);}}");
  ln("async function sendImage(chatId,caption,extra){await deletePrevImg(chatId);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(chatId,{source:IMG_BUF},Object.assign({caption:caption,parse_mode:'HTML'},extra));imageMessages.set(chatId,m.message_id);return m;}catch(e){console.error('img:',e.message);IMG_BUF=null;}}return bot.telegram.sendMessage(chatId,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(chatId,msgId,delay){setTimeout(function(){try{bot.telegram.deleteMessage(chatId,msgId);}catch(_){}},delay);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid,reason){var s=getStrike(uid);s.count++;try{await ctx.deleteMessage();}catch(_){}var why=reason?' ('+reason+')':'';if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F Muted 5 min \\u2014 3 strikes'+why+'.');autoDelete(ctx.chat.id,m3.message_id,12000);}else{var m=await ctx.reply('\\u26A0\\uFE0F Warning '+s.count+'/3'+why);autoDelete(ctx.chat.id,m.message_id,10000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{count:0,since:now};if(now-t.since>SPAM_WINDOW)t={count:0,since:now};t.count++;spamTracker.set(uid,t);if(t.count>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard','asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash','garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("function hasBlockedLink(t){var u=t.match(/https?:\\/\\/[^\\s]+/g)||[];return u.some(function(x){return!x.includes('x.com')&&!x.includes('twitter.com');});}");
  ln("function hasTmeLink(t){return/t\\.me\\/[+a-zA-Z0-9_]+/.test(t)||/telegram\\.me\\//i.test(t);}");
  ln("function hasExtMention(t){if(!t)return false;var mm=t.match(/@[a-zA-Z0-9_]+/g)||[];if(mm.length>1)return true;if(mm.length===1){var idx=t.indexOf(mm[0]);if(idx>0)return true;}return false;}");
  ln("var notLiveMsgs=['" + TICKER + " hasn\\u2019t launched yet. CA coming soon.','Hold tight \\u2014 the drop is close.','Not yet. Stay ready.','CA drops soon.'];");
  ln("var caPrompts=['2-3 confident lines. Why " + TICKER + " right now. No CA.','2-3 lines. " + TICKER + " fundamentals: renounced, locked LP. No CA.','2-3 lines. What makes " + TICKER + " worth holding. No CA.','2-3 lines. " + TICKER + " built for the long game. No CA.'];");
  ln("var caPromptIdx=0;");
  ln("async function buildCaCaption(){var p=caPrompts[caPromptIdx%caPrompts.length];caPromptIdx++;var ai=await smartAsk(systemPrompt(true),p);return ai+'\\n\\n'+CA+'\\n\\n'+E.lock+' " + RENOUNCED + " '+E.check+' LP " + LOCKED + "';}");
  ln("var xPrompts=['1-2 lines. " + TICKER + " on Twitter. Real energy.','1-2 lines. Why follow " + TICKER + " on X.','1-2 lines. " + TICKER + " Twitter is worth following.'];");
  ln("var xPromptIdx=0;");
  ln("async function buildXCaption(){var p=xPrompts[xPromptIdx%xPrompts.length];xPromptIdx++;var ai=await smartAsk(systemPrompt(false),p);return ai+'\\n\\n'+TWITTER;}");
  ln("var socialsIdx=0;");
  ln("function buildSocials(){var i=socialsIdx%3;socialsIdx++;var web=WEBSITE?'\\n\\u{1F310} <a href=\\''+WEBSITE+'\\'>Website</a>':'';if(i===0)return'<b>" + TICKER + "</b>\\n<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+web;if(i===1)return E.chart+' <a href=\\''+CHART+'\\'>Chart</a>  '+E.money+' <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>Twitter/X</a>'+web;return'<a href=\\''+CHART+'\\'>DexScreener</a>  <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>X</a>'+(WEBSITE?' <a href=\\''+WEBSITE+'\\'>Site</a>':'');}");
  ln("var devRepliesCTO=['" + TICKER + " is a CTO \\u2014 community takeover. Original dev is gone. The community now owns and runs this completely. No dev to rug. The holders are the team.','This is a CTO. Original dev walked away. The community stepped up and took full ownership of " + TICKER + ". Community power, not a dev.','No dev here \\u2014 " + TICKER + " is 100% community-owned. Original dev left. The community holds the wheel and drives this forward.','CTO project. Original dev is gone. Community took over " + TICKER + " completely. That is the strength here.'];");
  ln("var silenceAngles=['2-3 bullish lines. Why hold " + TICKER + " right now.','2-3 lines. Being early to " + TICKER + ".','2-3 lines. " + TICKER + " built clean: renounced, locked, low tax.','2-3 lines. What " + TICKER + " holders know.','2-3 lines. " + TICKER + " community is building.','2-3 lines. The move in " + TICKER + " is still early.'];");
  ln("var silenceIdx=0;");
  ln("async function fireSilence(){if(!groupChatId){resetSilence();return;}try{var p=silenceAngles[silenceIdx%silenceAngles.length];silenceIdx++;var cap=await smartAsk(systemPrompt(caUnlocked),p);await sendImage(groupChatId,cap,{});}catch(_){}resetSilence();}");
  ln("function resetSilence(){if(silenceTimer)clearTimeout(silenceTimer);silenceTimer=setTimeout(fireSilence,SILENCE_DELAY);}");
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}");
  ln("  for(var i=0;i<ctx.message.new_chat_members.length;i++){");
  ln("    var mem=ctx.message.new_chat_members[i];");
  ln("    var handle=mem.username?'@'+mem.username:mem.first_name;");
  ln("    var opts=[handle+' just joined " + TICKER + ".\\n" + RENOUNCED + " \\u2022 LP " + LOCKED + " \\u2022 " + BUY_TAX + "%/" + SELL_TAX + "% tax\\n'+(caUnlocked?CA:'CA coming soon \\u2014 stay close.'),'Glad you\\u2019re here, '+handle+'.\\n" + TICKER + " \\u2022 " + CHAIN_LBL + " \\u2022 " + RENOUNCED + " \\u2022 LP " + LOCKED + "\\n'+(caUnlocked?'CA: '+CA:'Launch incoming.'),handle+' joined " + TICKER + ".\\n" + BUY_TAX + "%/" + SELL_TAX + "% tax \\u2022 LP " + LOCKED + " \\u2022 " + RENOUNCED + "\\n'+(caUnlocked?CA:'CA reveals soon.')];");
  ln("    var msg=opts[Math.floor(Math.random()*opts.length)];");
  ln("    var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);");
  ln("  }");
  ln("});");
  ln("bot.on('sticker',async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid,'no forwards');var cnt=(stickerTracker.get(uid)||0)+1;stickerTracker.set(uid,cnt);if(cnt>3){try{await ctx.deleteMessage();}catch(_){}}});");
  ln("bot.on(['photo','video','document','audio','voice'],async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid,'no forwards');});");
  ln("async function sendXReply(ctx){var btn={reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}};var cap=TICKER+' on X';try{cap=await buildXCaption();}catch(_){}return sendImage(ctx.chat.id,cap,btn);}");
  ln("bot.command('x',function(ctx){return sendXReply(ctx);});");
  ln("bot.command('twitter',function(ctx){return sendXReply(ctx);});");
  ln("bot.command('ca',async function(ctx){if(!caUnlocked)return ctx.reply(notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)]);try{var cap=await buildCaCaption();return sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}});}catch(_){return ctx.reply(CA);}});");
  ln("bot.command('socials',async function(ctx){return ctx.reply(buildSocials(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',async function(ctx){return ctx.reply(buildSocials(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('" + REVEAL + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('" + HIDE + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA is now HIDDEN.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.on('message',async function(ctx){var msg=ctx.message;if(!msg||!ctx.from)return;var uid=ctx.from.id,chatType=ctx.chat.type;var text=(msg.text||'').trim();var isPrivate=chatType==='private';if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}if(!isPrivate)resetSilence();var admin=await isAdmin(ctx,uid);if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;stickerTracker.set(uid,0);if(msg.forward_from||msg.forward_sender_name||msg.forward_from_chat)return applyStrike(ctx,uid,'no forwards');if(hasBlockedLink(text))return applyStrike(ctx,uid,'no external links');if(hasTmeLink(text))return applyStrike(ctx,uid,'no TG invite links');if(hasExtMention(text))return applyStrike(ctx,uid,'no promoting other groups');if(hasFud(text))return applyStrike(ctx,uid,'no FUD');}if(!text)return;var lower=text.toLowerCase();var devWords=['dev','who is the dev','is dev active','dev status','dev gone','cto','community takeover','who runs','who owns','team active','team behind'];if(devWords.some(function(w){return lower.includes(w);})){if(IS_CTO)return ctx.reply(devRepliesCTO[Math.floor(Math.random()*devRepliesCTO.length)]);try{var dr=await smartAsk(systemPrompt(caUnlocked),text);if(dr&&dr!=='IGNORE')return ctx.reply(dr);}catch(_){}return;}var caWords=['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca','show ca'];if(caWords.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)]);try{var cap=await buildCaCaption();return sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}});}catch(_){return ctx.reply(CA);}}if(lower==='x'||lower==='twitter')return sendXReply(ctx);if(lower==='socials'||lower==='links')return ctx.reply(buildSocials(),{parse_mode:'HTML',disable_web_page_preview:true});if(isPrivate){try{var dr2=await smartAsk(systemPrompt(caUnlocked),text);if(dr2!=='IGNORE')return ctx.reply(dr2);}catch(_){}return;}try{var gr=await smartAsk(systemPrompt(caUnlocked),text);if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}});");
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function registerWebhook(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Webhook:',url);return;}}catch(e){console.log('Attempt '+(i+1)+':',e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('" + TICKER + " bot on port '+PORT);try{await new Promise(function(r){setTimeout(r,2000);});}catch(_){}try{await registerWebhook();}catch(e){console.log(e.message);}try{resetSilence();}catch(_){}setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);console.log('" + TICKER + " bot live');});");

  return L.join('\n');
}

// 
// FACTORY HTTP + STARTUP
// 
app.post('/webhook', function(req, res) { bot.handleUpdate(req.body, res); });
app.get('/',         function(req, res) { res.end('OK'); });
app.get('/health',   function(req, res) { res.end('OK'); });

async function registerWebhook() {
  if (!WEBHOOK_URL) { console.log('No WEBHOOK_URL'); return; }
  var url = WEBHOOK_URL + '/webhook';
  for (var i = 0; i < 5; i++) {
    try { var ok = await bot.telegram.setWebhook(url); if (ok) { console.log('Factory webhook:', url); return; } }
    catch(e) { console.log('Webhook attempt ' + (i+1) + ':', e.message); }
    await sleep(3000);
  }
}
async function getGhOwner() {
  try {
    var r = await fetch('https://api.github.com/user', { headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'} });
    var d = await r.json(); GH_OWNER = d.login || ''; console.log('GH owner:', GH_OWNER);
  } catch(e) { console.log('GH owner:', e.message); }
}

process.on('uncaughtException',  function(e) { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', function(e) { console.error('Rejection:', e && e.message); });

app.listen(PORT, async function() {
  console.log('Bot Factory starting on port', PORT);
  try { await sleep(2000); } catch(_) {}
  try { await getGhOwner(); } catch(e) { console.log('GH:', e.message); }
  try { await loadRegistry(); } catch(e) { console.log('Reg:', e.message); }
  try { await registerWebhook(); } catch(e) { console.log('Hook:', e.message); }
  try {
    await bot.telegram.setMyCommands([
      { command:'build',   description:'Build a new bot' },
      { command:'addbot',  description:'Register existing bot with full details' },
      { command:'bots',    description:'List all your bots' },
      { command:'edit',    description:'Edit a bot' },
      { command:'update',  description:'Push factory fixes to bot(s)' },
      { command:'rebuild', description:'Full rebuild from stored data' },
      { command:'stats',   description:'Check bots are online' },
      { command:'addgroq', description:'Add Groq API key' },
      { command:'cancel',  description:'Cancel current operation' },
    ]);
  } catch(e) { console.log('setMyCommands:', e.message); }
  setInterval(function() {
    if (WEBHOOK_URL) try { fetch(WEBHOOK_URL + '/health').catch(function() {}); } catch(_) {}
  }, 4 * 60 * 1000);
  console.log('Bot Factory is live.');
});
