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

// --- GROQ POOL ---
var groqPool = [];
for (var gi = 1; gi <= 10; gi++) {
  var gk = process.env['GROQ_KEY_' + gi];
  if (gk) groqPool.push(gk.trim());
}
var groqIdx = 0;
function nextGroqKey() {
  if (!groqPool.length) return '';
  var k = groqPool[groqIdx % groqPool.length];
  groqIdx++;
  return k;
}

// --- EMOJI ---
var E = {
  fire   : '\u{1F525}',
  check  : '\u2705',
  xmark  : '\u274C',
  gear   : '\u2699\uFE0F',
  party  : '\u{1F389}',
  lock   : '\u{1F512}',
  rocket : '\u{1F680}',
  bird   : '\u{1F426}',
  folder : '\u{1F4C2}',
  cloud  : '\u2601\uFE0F',
  clock  : '\u23F0',
  warn   : '\u26A0\uFE0F',
  pencil : '\u270F\uFE0F',
  link   : '\u{1F517}',
  shield : '\u{1F6E1}',
  robot  : '\u{1F916}',
};

// --- CHAIN CONFIG ---
var CHAIN_INFO = {
  bsc: {
    label    : 'BNB Smart Chain (BSC)',
    dex      : 'PancakeSwap',
    dexUrl   : 'https://pancakeswap.finance/swap?outputCurrency=',
    chartBase: 'https://dexscreener.com/bsc/',
    explorer : 'https://bscscan.com/token/',
  },
  sol: {
    label    : 'Solana',
    dex      : 'Raydium',
    dexUrl   : 'https://raydium.io/swap/?outputMint=',
    chartBase: 'https://dexscreener.com/solana/',
    explorer : 'https://solscan.io/token/',
  },
};

var bot = new Telegraf(BOT_TOKEN);
var app = express();
app.use(express.json());

// --- SESSIONS ---
var sessions = {};

function newSession() {
  return {
    step: 'chain',
    data: {
      chain: 'bsc', mode: 'full',
      tokenName: '', ticker: '', ca: '', supply: '',
      maxWalletPct: '', maxWalletTokens: '',
      buyTax: '', sellTax: '',
      twitter: '', website: '',
      renounced: '', locked: '',
      narrative: '',
      botToken: '',
      revealCmd: 'revealca', hideCmd: 'hideca',
    },
    imageBuffer: null,
  };
}

var BOTFATHER_INSTRUCTIONS =
  '\u{1F916} <b>How to get your bot token from BotFather:</b>\n\n' +
  '1. Open Telegram and search <b>@BotFather</b>\n' +
  '2. Send /newbot\n' +
  '3. Enter a display name (e.g. <b>PECKER Bot</b>)\n' +
  '4. Enter a username ending in bot (e.g. <b>pecker_bscbot</b>)\n' +
  '5. BotFather sends you a token like:\n' +
  '   <code>7404076592:AAFk3j...</code>\n\n' +
  'Copy that token and paste it here:';

// --- STEPS ---
var STEPS = [
  { key: 'chain',     ask: '\u{1F7E1} <b>Chain?</b>\n\nReply <b>bsc</b> or <b>sol</b>' },
  { key: 'mode',      ask: E.robot + ' <b>Bot mode?</b>\n\n<b>full</b> \u2014 Full bot: silence breaker, AI replies, moderation, CA/X/socials\n<b>guard</b> \u2014 Guard only: moderation + simple answers (CA, X, tax, max wallet, locked, renounced). No AI, no silence breaker.\n\nReply <b>full</b> or <b>guard</b>' },
  { key: 'name',      ask: E.pencil + ' Token name? (e.g. PECKER)' },
  { key: 'ticker',    ask: E.pencil + ' Ticker with $? (e.g. $PECKER)' },
  { key: 'ca',        ask: E.pencil + ' Contract address?' },
  { key: 'supply',    ask: E.pencil + ' Total supply? (e.g. 1,000,000,000)' },
  { key: 'maxwallet', ask: E.pencil + ' Max wallet % / token count? (e.g. 4.9% / 49,000,000)\nSend <b>-</b> to skip' },
  { key: 'taxes',     ask: E.pencil + ' Buy / sell tax? (e.g. 5/5)\nSend <b>-</b> if no tax' },
  { key: 'twitter',   ask: E.pencil + ' Twitter/X link? (e.g. https://x.com/pecker_bsc)' },
  { key: 'website',   ask: E.pencil + ' Website? (send <b>-</b> to skip)' },
  { key: 'renounced', ask: E.pencil + ' Contract renounced? (yes/no)' },
  { key: 'locked',    ask: E.pencil + ' LP locked? (yes/no)' },
  { key: 'narrative', ask: E.pencil + ' Token story / narrative? (can be long)\nSend <b>-</b> if guard mode and you want to skip' },
  { key: 'image',     ask: E.pencil + ' Send the bot image now (JPG or PNG)\nSend <b>-</b> to skip (bot will reply text-only)' },
  { key: 'bottoken',  ask: BOTFATHER_INSTRUCTIONS },
  { key: 'revealcmd', ask: E.pencil + ' Secret reveal-CA command? (send <b>-</b> for default: revealca)' },
  { key: 'hidecmd',   ask: E.pencil + ' Secret hide-CA command? (send <b>-</b> for default: hideca)' },
];

function advanceStep(s) {
  var idx = STEPS.findIndex(function(t) { return t.key === s.step; });
  if (idx + 1 < STEPS.length) { s.step = STEPS[idx + 1].key; return STEPS[idx + 1]; }
  s.step = 'confirm';
  return null;
}

function processInput(s, text) {
  var d = s.data;
  switch (s.step) {
    case 'chain': {
      var c = text.toLowerCase().replace(/[^a-z]/g, '');
      d.chain = (c === 'sol' || c === 'solana') ? 'sol' : 'bsc';
      break;
    }
    case 'mode': {
      d.mode = /guard/i.test(text) ? 'guard' : 'full';
      break;
    }
    case 'name':      d.tokenName = text; break;
    case 'ticker':    d.ticker = text.startsWith('$') ? text : '$' + text; break;
    case 'ca':        d.ca = text.trim(); break;
    case 'supply':    d.supply = text; break;
    case 'maxwallet': {
      if (text === '-') { d.maxWalletPct = 'N/A'; d.maxWalletTokens = ''; break; }
      var mw = text.split('/');
      d.maxWalletPct = (mw[0] || text).trim();
      d.maxWalletTokens = (mw[1] || '').trim();
      break;
    }
    case 'taxes': {
      if (text === '-') { d.buyTax = '0'; d.sellTax = '0'; break; }
      var tx = text.split('/');
      d.buyTax = (tx[0] || text).trim();
      d.sellTax = (tx[1] || tx[0] || '').trim();
      break;
    }
    case 'twitter':   d.twitter = text; break;
    case 'website':   d.website = (text === '-') ? '' : text; break;
    case 'renounced': d.renounced = /yes/i.test(text) ? 'RENOUNCED' : 'NOT RENOUNCED'; break;
    case 'locked':    d.locked = /yes/i.test(text) ? 'LOCKED' : 'NOT LOCKED'; break;
    case 'narrative': d.narrative = (text === '-') ? '' : text; break;
    case 'bottoken':  d.botToken = text.trim(); break;
    case 'revealcmd': d.revealCmd = (text === '-') ? 'revealca' : text.replace(/^\//, ''); break;
    case 'hidecmd':   d.hideCmd = (text === '-') ? 'hideca' : text.replace(/^\//, ''); break;
  }
}

function handleSkipImage(ctx, s) {
  s.imageBuffer = null;
  var nxt = advanceStep(s);
  if (nxt) return ctx.reply(nxt.ask, { parse_mode: 'HTML' });
  return ctx.reply(buildSummary(s), { parse_mode: 'HTML' });
}

function buildSummary(s) {
  var d = s.data;
  var ci = CHAIN_INFO[d.chain] || CHAIN_INFO.bsc;
  return (
    E.fire + ' <b>Build Summary \u2014 Review before deploying</b>\n\n' +
    '<b>Chain:</b> ' + ci.label + '\n' +
    '<b>Mode:</b> ' + (d.mode === 'guard' ? E.shield + ' Guard only' : E.robot + ' Full bot') + '\n' +
    '<b>Name:</b> ' + d.tokenName + ' (' + d.ticker + ')\n' +
    '<b>CA:</b> <code>' + d.ca + '</code>\n' +
    '<b>Supply:</b> ' + d.supply + '\n' +
    '<b>Max Wallet:</b> ' + d.maxWalletPct + (d.maxWalletTokens ? ' / ' + d.maxWalletTokens : '') + '\n' +
    '<b>Tax:</b> Buy ' + d.buyTax + '% / Sell ' + d.sellTax + '%\n' +
    '<b>Twitter:</b> ' + d.twitter + '\n' +
    (d.website ? '<b>Website:</b> ' + d.website + '\n' : '') +
    '<b>Contract:</b> ' + d.renounced + '\n' +
    '<b>LP:</b> ' + d.locked + '\n' +
    '<b>Reveal cmd:</b> /' + d.revealCmd + '\n' +
    '<b>Hide cmd:</b> /' + d.hideCmd + '\n' +
    '<b>Image:</b> ' + (s.imageBuffer ? E.check + ' received' : '\u2014 text only') + '\n\n' +
    'Reply <b>yes</b> to deploy \u2014 <b>no</b> to cancel.'
  );
}

// --- COMMANDS ---
bot.command(['build', 'new'], function(ctx) {
  var uid = String(ctx.from.id);
  sessions[uid] = newSession();
  return ctx.reply(E.fire + ' <b>New bot build started!</b>\n\n' + STEPS[0].ask, { parse_mode: 'HTML' });
});

bot.command('cancel', function(ctx) {
  delete sessions[String(ctx.from.id)];
  return ctx.reply(E.xmark + ' Build cancelled.');
});

bot.command('addgroq', function(ctx) {
  var txt = (ctx.message.text || '').replace('/addgroq', '').trim();
  if (!txt) return ctx.reply('Usage: /addgroq YOUR_GROQ_KEY');
  groqPool.push(txt);
  return ctx.reply(E.check + ' Groq key added. Pool size: ' + groqPool.length);
});

bot.command('help', function(ctx) {
  return ctx.reply(
    E.gear + ' <b>Bot Factory</b>\n\n' +
    '/build \u2014 Build a new bot\n' +
    '/cancel \u2014 Cancel current build\n' +
    '/addgroq KEY \u2014 Add Groq key to pool\n' +
    '/help \u2014 This message\n\n' +
    '<b>Chains:</b> BSC \u2022 Solana\n' +
    '<b>Modes:</b> Full bot \u2022 Guard only',
    { parse_mode: 'HTML' }
  );
});

// --- IMAGE HANDLER ---
function handleImageBuffer(ctx, buf) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'image') return ctx.reply('No active build. Use /build first.');
  s.imageBuffer = buf;
  var nxt = advanceStep(s);
  if (nxt) return ctx.reply(E.check + ' Image saved!\n\n' + nxt.ask, { parse_mode: 'HTML' });
  return ctx.reply(buildSummary(s), { parse_mode: 'HTML' });
}

bot.on('photo', function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'image') return;
  var ph = ctx.message.photo[ctx.message.photo.length - 1];
  return ctx.telegram.getFileLink(ph.file_id).then(function(link) {
    return fetch(link.href);
  }).then(function(r) { return r.arrayBuffer(); }).then(function(ab) {
    return handleImageBuffer(ctx, Buffer.from(ab));
  }).catch(function(e) { return ctx.reply(E.xmark + ' Image error: ' + e.message); });
});

bot.on('document', function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'image') return;
  var doc = ctx.message.document;
  if (!doc.mime_type || !doc.mime_type.startsWith('image/')) return ctx.reply('Please send a JPG or PNG image.');
  return ctx.telegram.getFileLink(doc.file_id).then(function(link) {
    return fetch(link.href);
  }).then(function(r) { return r.arrayBuffer(); }).then(function(ab) {
    return handleImageBuffer(ctx, Buffer.from(ab));
  }).catch(function(e) { return ctx.reply(E.xmark + ' Image error: ' + e.message); });
});

// --- TEXT HANDLER ---
bot.on('text', function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s) return ctx.reply('Send /build to start, or /help for commands.');
  var text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  if (s.step === 'image') {
    if (text === '-') return handleSkipImage(ctx, s);
    return ctx.reply('Send an image, or send <b>-</b> to skip.', { parse_mode: 'HTML' });
  }

  if (s.step === 'confirm') {
    if (/^yes$/i.test(text)) return runBuild(ctx, s, uid);
    delete sessions[uid];
    return ctx.reply(E.xmark + ' Cancelled. Send /build to start again.');
  }

  processInput(s, text);
  var nxt = advanceStep(s);
  if (s.step === 'confirm') return ctx.reply(buildSummary(s), { parse_mode: 'HTML' });
  return ctx.reply(nxt.ask, { parse_mode: 'HTML' });
});

// --- HELPERS ---
async function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function rndStr(n) {
  var c = 'abcdefghijklmnopqrstuvwxyz0123456789', o = '';
  for (var i = 0; i < n; i++) o += c[Math.floor(Math.random() * c.length)];
  return o;
}

// --- BUILD ORCHESTRATOR ---
async function runBuild(ctx, s, uid) {
  var d = s.data;
  var ci = CHAIN_INFO[d.chain] || CHAIN_INFO.bsc;
  var groqKey = d.mode === 'full' ? nextGroqKey() : (groqPool[0] || '');
  if (d.mode === 'full' && !groqKey) return ctx.reply(E.xmark + ' No Groq key. Use /addgroq KEY first.');

  await ctx.reply(E.gear + ' Building... about 2 minutes. Stay here.');

  try {
    // 1 - GitHub
    await ctx.reply(E.folder + ' Creating GitHub repo...');
    var repoName = d.ticker.replace(/\$/g, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() + '-bot-' + rndStr(4);
    var ghResult = await githubCreateRepo(repoName);
    var ghOwner  = ghResult.full_name.split('/')[0];

    await sleep(4000);

    var botCode = d.mode === 'guard'
      ? generateGuardBotJs(d, ci)
      : generateFullBotJs(d, ci);
    var pkgCode = generatePackageJson(d.tokenName, d.mode);

    await githubPushFileWithRetry(ghOwner, repoName, 'bot.js',       Buffer.from(botCode));
    await githubPushFileWithRetry(ghOwner, repoName, 'package.json', Buffer.from(pkgCode));
    if (s.imageBuffer) await githubPushFileWithRetry(ghOwner, repoName, 'siren.jpg', s.imageBuffer);

    await ctx.reply(E.check + ' GitHub: github.com/' + ghOwner + '/' + repoName);

    // 2 - Render
    await ctx.reply(E.cloud + ' Creating Render service...');
    var ownerId = await renderGetOwnerId();
    var guessUrl = 'https://' + repoName + '.onrender.com';
    var envVars = [
      { key: 'BOT_TOKEN',   value: d.botToken },
      { key: 'WEBHOOK_URL', value: guessUrl },
    ];
    if (d.mode === 'full') envVars.push({ key: 'GROQ_API_KEY', value: groqKey });
    var svc = await renderCreateService(repoName, ghOwner, ownerId, envVars);
    var serviceId = svc.id;
    var actualUrl = (svc.serviceDetails && svc.serviceDetails.url)
      ? svc.serviceDetails.url
      : guessUrl;
    if (actualUrl !== guessUrl) {
      var updatedVars = envVars.map(function(v) {
        return v.key === 'WEBHOOK_URL' ? { key: 'WEBHOOK_URL', value: actualUrl } : v;
      });
      await renderSetEnvVars(serviceId, updatedVars);
    }
    await ctx.reply(E.check + ' Render: ' + actualUrl);

    // 3 - Cron-job
    await ctx.reply(E.clock + ' Setting up keepalive...');
    await cronCreateJob(repoName, actualUrl + '/health');
    await ctx.reply(E.check + ' Cron-job done (every 5 min)');

    delete sessions[uid];

    await ctx.reply(
      E.party + ' <b>Bot deployed!</b>\n\n' +
      E.link  + ' ' + actualUrl + '\n' +
      E.folder + ' github.com/' + ghOwner + '/' + repoName + '\n' +
      '<b>Chain:</b> ' + ci.label + '\n' +
      '<b>Mode:</b> ' + (d.mode === 'guard' ? 'Guard only' : 'Full bot') + '\n\n' +
      '<b>Next steps:</b>\n' +
      '1. Wait 3\u20135 min for Render to build\n' +
      '2. Add bot to your Telegram group\n' +
      '3. Make it admin (delete / ban / restrict)\n' +
      '4. Use /' + d.revealCmd + ' when ready to show CA',
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    await ctx.reply(
      E.xmark + ' Build failed:\n<code>' + (err.message || '').slice(0, 500) + '</code>\n\nSend /build to retry.',
      { parse_mode: 'HTML' }
    );
    delete sessions[uid];
  }
}

// --- GITHUB API ---
async function githubCreateRepo(name) {
  var r = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: name, private: false, auto_init: false }),
  });
  var d = await r.json();
  if (!d.full_name) throw new Error('Repo create failed: ' + JSON.stringify(d).slice(0, 300));
  return d;
}

async function githubPushFileWithRetry(owner, repo, filename, content) {
  var lastErr;
  for (var attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(5000);
    try {
      var r = await fetch('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + filename, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Add ' + filename, content: content.toString('base64') }),
      });
      var d = await r.json();
      if (d.content || d.commit) return d;
      lastErr = new Error('Push failed for ' + filename + ': ' + JSON.stringify(d).slice(0, 300));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// --- RENDER API ---
async function renderGetOwnerId() {
  var r = await fetch('https://api.render.com/v1/owners?limit=1', {
    headers: { 'Authorization': 'Bearer ' + RENDER_KEY, 'Accept': 'application/json' },
  });
  var d = await r.json();
  if (!Array.isArray(d) || !d[0]) throw new Error('Render owner fetch failed: ' + JSON.stringify(d).slice(0, 300));
  return d[0].owner ? d[0].owner.id : d[0].id;
}

async function renderCreateService(name, ghOwner, ownerId, envVars) {
  var body = {
    autoDeploy : 'yes',
    branch     : 'main',
    name       : name,
    ownerId    : ownerId,
    repo       : 'https://github.com/' + ghOwner + '/' + name,
    type       : 'web_service',
    envVars    : envVars || [],
    serviceDetails: {
      runtime      : 'node',
      plan         : 'free',
      region       : 'oregon',
      numInstances : 1,
      envSpecificDetails: {
        buildCommand : 'npm install',
        startCommand : 'npm start',
      },
    },
  };
  var r = await fetch('https://api.render.com/v1/services', {
    method : 'POST',
    headers: { 'Authorization': 'Bearer ' + RENDER_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body   : JSON.stringify(body),
  });
  var d = await r.json();
  var svc = d.service || d;
  if (!svc.id) throw new Error('Render create failed: ' + JSON.stringify(d).slice(0, 500));
  return svc;
}

async function renderSetEnvVars(serviceId, vars) {
  var r = await fetch('https://api.render.com/v1/services/' + serviceId + '/env-vars', {
    method : 'PUT',
    headers: { 'Authorization': 'Bearer ' + RENDER_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body   : JSON.stringify(vars),
  });
  var d = await r.json();
  if (!Array.isArray(d)) console.log('EnvVar set response:', JSON.stringify(d).slice(0, 200));
}

// --- CRON-JOB API ---
async function cronCreateJob(name, url) {
  await fetch('https://api.cron-job.org/jobs', {
    method : 'PUT',
    headers: { 'Authorization': 'Bearer ' + CRON_KEY, 'Content-Type': 'application/json' },
    body   : JSON.stringify({
      job: {
        url: url, title: name + ' keepalive', enabled: true, saveResponses: false,
        schedule: { timezone: 'UTC', hours: [-1], mdays: [-1], months: [-1], wdays: [-1],
          minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55] },
      },
    }),
  });
}

// --- PACKAGE.JSON GENERATOR ---
function generatePackageJson(tokenName, mode) {
  var deps = { telegraf: '^4.16.3', express: '^4.18.2' };
  if (mode === 'full') deps['groq-sdk'] = '^0.3.3';
  return JSON.stringify({
    name: tokenName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-bot',
    version: '1.0.0', main: 'bot.js',
    scripts: { start: 'node bot.js' },
    dependencies: deps,
    engines: { node: '>=18.0.0' },
  }, null, 2);
}

// ================================================================
// GUARD BOT GENERATOR (no AI, no silence breaker)
// ================================================================
function generateGuardBotJs(d, ci) {
  var TICKER    = d.ticker;
  var NAME      = d.tokenName;
  var CA        = d.ca;
  var SUPPLY    = d.supply;
  var MAX_PCT   = d.maxWalletPct;
  var MAX_TOK   = d.maxWalletTokens;
  var BUY_TAX   = d.buyTax;
  var SELL_TAX  = d.sellTax;
  var TWITTER   = d.twitter;
  var WEBSITE   = d.website || '';
  var RENOUNCED = d.renounced;
  var LOCKED    = d.locked;
  var REVEAL    = d.revealCmd.replace(/^\//, '');
  var HIDE      = d.hideCmd.replace(/^\//, '');
  var CHART_URL = ci.chartBase + CA;
  var BUY_URL   = ci.dexUrl + CA;
  var DEX_NAME  = ci.dex;
  var CHAIN_LBL = ci.label;

  var L = []; function ln(s) { L.push(s === undefined ? '' : s); }

  ln("'use strict';");
  ln("var Telegraf=require('telegraf').Telegraf;");
  ln("var express=require('express');");
  ln("var fs=require('fs');");
  ln("var path=require('path');");
  ln("var BOT_TOKEN=process.env.BOT_TOKEN;");
  ln("var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();");
  ln("var PORT=process.env.PORT||3000;");
  ln("var CA='"+CA+"';");
  ln("var CHART='"+CHART_URL+"';");
  ln("var BUY='"+BUY_URL+"';");
  ln("var TWITTER='"+TWITTER+"';");
  ln("var WEBSITE='"+WEBSITE+"';");
  ln("var E={lock:'\\u{1F512}',check:'\\u2705',bird:'\\u{1F426}',chart:'\\u{1F4C8}',money:'\\u{1F4B0}',gem:'\\u{1F48E}',copy:'\\u{1F4CB}',shield:'\\u{1F6E1}'};");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("app.use(express.json());");
  ln("var caUnlocked=false,groupChatId=null;");
  ln("var imageMessages=new Map(),strikes=new Map(),spamTracker=new Map(),stickerTracker=new Map();");
  ln("var IMG=path.join(__dirname,'siren.jpg');");
  ln("var STRIKE_RESET=86400000,SPAM_WINDOW=60000,SPAM_MAX=5;");
  ln();
  ln("var TOKEN_INFO = {");
  ln("  name: '"+NAME+"',");
  ln("  ticker: '"+TICKER+"',");
  ln("  chain: '"+CHAIN_LBL+"',");
  ln("  supply: '"+SUPPLY+"',");
  ln("  maxWallet: '"+MAX_PCT+(MAX_TOK?" / "+MAX_TOK:"")+"',");
  ln("  buyTax: '"+BUY_TAX+"%',");
  ln("  sellTax: '"+SELL_TAX+"%',");
  ln("  renounced: '"+RENOUNCED+"',");
  ln("  locked: '"+LOCKED+"',");
  ln("};");
  ln();
  ln("async function deletePrevImage(chatId){var mid=imageMessages.get(chatId);if(mid){try{await bot.telegram.deleteMessage(chatId,mid);}catch(_){}imageMessages.delete(chatId);}}");
  ln("async function sendImage(chatId,caption,extra){await deletePrevImage(chatId);extra=extra||{};try{if(fs.existsSync(IMG)){var m=await bot.telegram.sendPhoto(chatId,{source:IMG},Object.assign({caption:caption,parse_mode:'HTML'},extra));imageMessages.set(chatId,m.message_id);return m;}}catch(_){}return bot.telegram.sendMessage(chatId,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(chatId,msgId,delay){setTimeout(function(){try{bot.telegram.deleteMessage(chatId,msgId);}catch(_){}},delay);}");
  ln("async function isAdmin(ctx,userId){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,userId);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid){var s=getStrike(uid);s.count++;try{await ctx.deleteMessage();}catch(_){}if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m3=await ctx.reply('Muted 5 minutes (3 strikes).');autoDelete(ctx.chat.id,m3.message_id,12000);}else{var m=await ctx.reply('Warning '+s.count+'/3');autoDelete(ctx.chat.id,m.message_id,10000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{count:0,since:now};if(now-t.since>SPAM_WINDOW)t={count:0,since:now};t.count++;spamTracker.set(uid,t);if(t.count>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard','asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash','garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  // Anti-link: only x.com and twitter.com allowed
  ln("function hasBlockedLink(t){var u=t.match(/https?:\\/\\/[^\\s]+/g)||[];return u.some(function(x){return!x.includes('x.com')&&!x.includes('twitter.com');});}");
  ln("function hasExtMention(t){return/@[a-zA-Z0-9_]+/.test(t);}");
  ln("var notLiveMsgs=['"+TICKER+" hasn\\u2019t launched yet. CA drops soon.','Not yet. Stay patient.','CA isn\\u2019t live yet. You\\u2019ll know first.','Hold tight. Launches soon.','Sit tight \\u2014 launch is close.'];");
  ln("var socialsIdx=0;");
  ln("function buildSocialsMsg(){var i=socialsIdx%4;socialsIdx++;var web=WEBSITE?'\\n\\u{1F310} <a href=\\''+WEBSITE+'\\'>Website</a>':'';if(i===0)return'<b>"+TICKER+" Links</b>\\n\\n<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY+'\\'>"+DEX_NAME+"</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+web;if(i===1)return E.chart+' <a href=\\''+CHART+'\\'>View Chart</a>\\n'+E.money+' <a href=\\''+BUY+'\\'>Buy on "+DEX_NAME+"</a>\\n'+E.bird+' <a href=\\''+TWITTER+'\\'>Follow on X</a>'+web;if(i===2)return E.gem+' <b>"+TICKER+" Links</b>\\n\\n<a href=\\''+CHART+'\\'>DexScreener</a> \\u2022 <a href=\\''+BUY+'\\'>"+DEX_NAME+"</a> \\u2022 <a href=\\''+TWITTER+'\\'>Twitter/X</a>'+web;return'"+TICKER+"\\nChart \\u2192 '+CHART+'\\nBuy \\u2192 '+BUY+'\\nX \\u2192 '+TWITTER+(WEBSITE?'\\nSite \\u2192 '+WEBSITE:'');}");
  ln();
  // Guard simple reply builder
  ln("function buildInfoReply(topic){");
  ln("  if(topic==='ca'){");
  ln("    if(!caUnlocked)return{text:notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)],kb:null};");
  ln("    return{text:CA+'\\n\\n'+E.lock+' "+RENOUNCED+" '+E.check+' LP "+LOCKED+"',kb:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}};");
  ln("  }");
  ln("  if(topic==='x')return{text:'Follow "+TICKER+" on X:\\n'+TWITTER,kb:{inline_keyboard:[[{text:E.bird+' Follow on X',url:TWITTER}]]}};");
  ln("  if(topic==='tax')return{text:'"+TICKER+" Tax\\nBuy: "+BUY_TAX+"% \\u2022 Sell: "+SELL_TAX+"%',kb:null};");
  ln("  if(topic==='maxwallet')return{text:'Max Wallet: "+MAX_PCT+(MAX_TOK?" ("+MAX_TOK+" tokens)":"")+"\\n\\u2014 Anti-whale protection. No wallet can hold more than this cap.',kb:null};");
  ln("  if(topic==='renounced')return{text:'Contract: "+RENOUNCED+"\\n\\u2014 The contract code is permanently locked. Nobody can alter it.',kb:null};");
  ln("  if(topic==='locked')return{text:'LP: "+LOCKED+"\\n\\u2014 Liquidity is fully secured.',kb:null};");
  ln("  if(topic==='supply')return{text:'Total Supply: "+SUPPLY+"',kb:null};");
  ln("  if(topic==='socials')return{text:buildSocialsMsg(),kb:null};");
  ln("  return null;");
  ln("}");
  ln();
  ln("function detectTopic(lower){");
  ln("  if(['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca'].some(function(w){return lower===w||lower.includes(w);}))return'ca';");
  ln("  if(lower==='x'||lower==='twitter'||lower.includes('twitter')||lower.includes('follow'))return'x';");
  ln("  if(lower.includes('tax')||lower.includes('buy tax')||lower.includes('sell tax'))return'tax';");
  ln("  if(lower.includes('max wallet')||lower.includes('maxwallet')||lower.includes('max hold'))return'maxwallet';");
  ln("  if(lower.includes('renounced')||lower.includes('contract lock')||lower.includes('safe'))return'renounced';");
  ln("  if(lower.includes('lp')||lower.includes('liquidity')||lower.includes('locked'))return'locked';");
  ln("  if(lower.includes('supply')||lower.includes('total supply')||lower.includes('how many'))return'supply';");
  ln("  if(lower==='socials'||lower==='links'||lower.includes('socials')||lower.includes('website'))return'socials';");
  ln("  return null;");
  ln("}");
  ln();
  ln("bot.on('new_chat_members',async function(ctx){");
  ln("  if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;");
  ln("  try{await ctx.deleteMessage();}catch(_){}");
  ln("  for(var i=0;i<ctx.message.new_chat_members.length;i++){");
  ln("    var mem=ctx.message.new_chat_members[i];");
  ln("    var name=mem.first_name||'fren';");
  ln("    var msg=E.shield+' '+name+' joined "+TICKER+". Welcome!\\n\\nUse /ca, /x, /socials for info.';");
  ln("    var sent=await ctx.reply(msg);");
  ln("    autoDelete(ctx.chat.id,sent.message_id,60000);");
  ln("  }");
  ln("});");
  ln();
  ln("bot.on('sticker',async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);var cnt=(stickerTracker.get(uid)||0)+1;stickerTracker.set(uid,cnt);if(cnt>3){try{await ctx.deleteMessage();}catch(_){}}});");
  ln("bot.on(['photo','video','document','audio','voice'],async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);});");
  ln();
  ln("bot.command('ca',async function(ctx){var r=buildInfoReply('ca');return sendImage(ctx.chat.id,r.text,r.kb?{reply_markup:r.kb}:{});});");
  ln("bot.command('x',function(ctx){var r=buildInfoReply('x');return ctx.reply(r.text,{reply_markup:r.kb,parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('twitter',function(ctx){var r=buildInfoReply('x');return ctx.reply(r.text,{reply_markup:r.kb,parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('tax',function(ctx){var r=buildInfoReply('tax');return ctx.reply(r.text);});");
  ln("bot.command('socials',function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('info',function(ctx){");
  ln("  return ctx.reply(");
  ln("    '<b>"+TICKER+" Info</b>\\n\\n'+");
  ln("    'Name: "+NAME+"\\n'+");
  ln("    'Chain: "+CHAIN_LBL+"\\n'+");
  ln("    'Supply: "+SUPPLY+"\\n'+");
  ln("    'Max Wallet: "+MAX_PCT+(MAX_TOK?" / "+MAX_TOK:"")+"\\n'+");
  ln("    'Buy Tax: "+BUY_TAX+"% | Sell Tax: "+SELL_TAX+"%\\n'+");
  ln("    'Contract: "+RENOUNCED+"\\n'+");
  ln("    'LP: "+LOCKED+"',");
  ln("    {parse_mode:'HTML'}");
  ln("  );");
  ln("});");
  ln();
  ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;return ctx.reply('CA is now HIDDEN.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln();
  ln("bot.on('message',async function(ctx){");
  ln("  var msg=ctx.message;if(!msg||!ctx.from)return;");
  ln("  var uid=ctx.from.id,chatType=ctx.chat.type;");
  ln("  var text=(msg.text||'').trim();");
  ln("  var isPrivate=chatType==='private';");
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id)groupChatId=ctx.chat.id;");
  ln("  var admin=await isAdmin(ctx,uid);");
  ln("  if(!isPrivate&&!admin){");
  ln("    if(text){");
  ln("      var spammed=await checkSpam(ctx,uid);if(spammed)return;");
  ln("      stickerTracker.set(uid,0);");
  ln("      if(msg.forward_from||msg.forward_sender_name||msg.forward_from_chat)return applyStrike(ctx,uid);");
  ln("      if(hasBlockedLink(text))return applyStrike(ctx,uid);");
  ln("      if(hasExtMention(text))return applyStrike(ctx,uid);");
  ln("      if(hasFud(text))return applyStrike(ctx,uid);");
  ln("    }");
  ln("  }");
  ln("  if(!text)return;");
  ln("  var lower=text.toLowerCase();");
  ln("  var topic=detectTopic(lower);");
  ln("  if(topic){");
  ln("    var r=buildInfoReply(topic);");
  ln("    if(r){");
  ln("      if(topic==='ca')return sendImage(ctx.chat.id,r.text,r.kb?{reply_markup:r.kb}:{});");
  ln("      return ctx.reply(r.text,Object.assign({parse_mode:'HTML',disable_web_page_preview:true},r.kb?{reply_markup:r.kb}:{}));");
  ln("    }");
  ln("  }");
  ln("});");
  ln();
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function registerWebhook(){if(!WEBHOOK_URL){console.log('No WEBHOOK_URL');return;}var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Webhook set: '+url);return;}}catch(e){console.log('Attempt '+(i+1)+': '+e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('Guard bot starting on port '+PORT);await new Promise(function(r){setTimeout(r,2000);});await registerWebhook();console.log('"+TICKER+" guard bot is live');});");

  return L.join('\n');
}

// ================================================================
// FULL BOT GENERATOR (AI + silence breaker + full moderation)
// ================================================================
function generateFullBotJs(d, ci) {
  var NAME=d.tokenName, TICKER=d.ticker, CA=d.ca, SUPPLY=d.supply;
  var MAX_PCT=d.maxWalletPct, MAX_TOK=d.maxWalletTokens;
  var BUY_TAX=d.buyTax, SELL_TAX=d.sellTax;
  var TWITTER=d.twitter, WEBSITE=d.website||'';
  var RENOUNCED=d.renounced, LOCKED=d.locked;
  var NARR=JSON.stringify(d.narrative);
  var REVEAL=d.revealCmd.replace(/^\//,''), HIDE=d.hideCmd.replace(/^\//,'');
  var CHAIN_LBL=ci.label, DEX_NAME=ci.dex;
  var CHART_URL=ci.chartBase+CA, BUY_URL=ci.dexUrl+CA;

  var L=[]; function ln(s){L.push(s===undefined?'':s);}

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
  ln("var CA='"+CA+"';");
  ln("var CHART='"+CHART_URL+"';");
  ln("var BUY='"+BUY_URL+"';");
  ln("var TWITTER='"+TWITTER+"';");
  ln("var WEBSITE='"+WEBSITE+"';");
  ln("var E={rocket:'\\u{1F680}',fire:'\\u{1F525}',chart:'\\u{1F4C8}',lock:'\\u{1F512}',check:'\\u2705',zap:'\\u26A1',gem:'\\u{1F48E}',star:'\\u2B50',money:'\\u{1F4B0}',shield:'\\u{1F6E1}',bird:'\\u{1F426}',wave:'\\u{1F44B}',dash:'\\u2014',copy:'\\u{1F4CB}'};");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("var groq=new Groq({apiKey:GROQ_API_KEY});");
  ln("app.use(express.json());");
  ln("var caUnlocked=false,groupChatId=null,silenceTimer=null;");
  ln("var imageMessages=new Map(),strikes=new Map(),spamTracker=new Map(),stickerTracker=new Map();");
  ln("var lastReplies=[],MAX_REPLY_HIST=12;");
  ln("var IMG=path.join(__dirname,'siren.jpg');");
  ln("var SILENCE_DELAY=10*60*1000,STRIKE_RESET=86400000,SPAM_WINDOW=60000,SPAM_MAX=5;");
  ln("function systemPrompt(withCa){return 'You are the official Telegram bot for "+TICKER+", a "+CHAIN_LBL+" meme token.\\n\\nTOKEN FACTS:\\n- Name: "+NAME+" | Ticker: "+TICKER+"\\n- Blockchain: "+CHAIN_LBL+"\\n- Total Supply: "+SUPPLY+"\\n- Max Wallet: "+MAX_PCT+(MAX_TOK?" / "+MAX_TOK+" tokens":"")+" \\u2014 anti-whale cap.\\n- Buy Tax: "+BUY_TAX+"% | Sell Tax: "+SELL_TAX+"%\\n- Contract: "+RENOUNCED+" \\u2014 permanently locked. Security feature.\\n- Liquidity: "+LOCKED+" \\u2014 funds fully secured.\\n- DEV STATUS: Dev is ACTIVE. NEVER imply dev stepped back or is gone.\\n- Twitter/X: '+TWITTER+'\\n'+(withCa?'- CA: '+CA+'\\n':' ')+(withCa?'- Chart: '+CHART+'\\n':' ')+(withCa?'- Buy on "+DEX_NAME+": '+BUY+'\\n':' ')+'\\nNARRATIVE:\\n'+" + NARR + "+'\\n\\nPERSONALITY: Calm, confident, warm, genuinely bullish. Every reply completely different. Never robotic. Minimal emojis. Short=1-3 lines, detailed=up to 5 lines.\\n\\nHARD RULES: NEVER share TG group link. NEVER volunteer CA. NEVER emoji same line as CA. NEVER repeat reply. If hype/casual/no answer needed: reply with exactly IGNORE';}");
  ln("async function askGroq(sys,msg){var r=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',temperature:1.0,max_tokens:300,messages:[{role:'system',content:sys},{role:'user',content:msg}]});return r.choices[0].message.content.trim();}");
  ln("function isDupe(r){return lastReplies.includes(r);}");
  ln("function recordReply(r){lastReplies.push(r);if(lastReplies.length>MAX_REPLY_HIST)lastReplies.shift();}");
  ln("async function smartAsk(sys,p){var r=await askGroq(sys,p);if(isDupe(r))r=await askGroq(sys,p+' Give completely different response.');recordReply(r);return r;}");
  ln("async function deletePrevImage(chatId){var mid=imageMessages.get(chatId);if(mid){try{await bot.telegram.deleteMessage(chatId,mid);}catch(_){}imageMessages.delete(chatId);}}");
  ln("async function sendImage(chatId,caption,extra){await deletePrevImage(chatId);extra=extra||{};try{if(fs.existsSync(IMG)){var m=await bot.telegram.sendPhoto(chatId,{source:IMG},Object.assign({caption:caption,parse_mode:'HTML'},extra));imageMessages.set(chatId,m.message_id);return m;}}catch(_){}return bot.telegram.sendMessage(chatId,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(chatId,msgId,delay){setTimeout(function(){try{bot.telegram.deleteMessage(chatId,msgId);}catch(_){}},delay);}");
  ln("async function isAdmin(ctx,userId){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,userId);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid){var s=getStrike(uid);s.count++;try{await ctx.deleteMessage();}catch(_){}if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m3=await ctx.reply('Muted 5 minutes (3 strikes).');autoDelete(ctx.chat.id,m3.message_id,12000);}else{var m=await ctx.reply('Warning '+s.count+'/3');autoDelete(ctx.chat.id,m.message_id,10000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{count:0,since:now};if(now-t.since>SPAM_WINDOW)t={count:0,since:now};t.count++;spamTracker.set(uid,t);if(t.count>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var notLiveMsgs=['"+TICKER+" hasn\\u2019t launched yet. CA drops soon.','Not yet. Stay patient.','CA isn\\u2019t live yet. You\\u2019ll know first.','Hold tight. Launches soon.','Sit tight \\u2014 launch is close.'];");
  ln("var caPrompts=['3-4 punchy bullish lines about why "+TICKER+" is the move. No CA.','3-4 lines. "+TICKER+" fundamentals solid. Renounced, locked LP, active dev. No CA.','3-4 lines. "+TICKER+" found early feeling. No CA.','3-4 lines. "+TICKER+" built different. Safety, community, momentum. No CA.','3-4 lines. "+TICKER+" holders are early. No CA.','3-4 lines. "+TICKER+" worth attention now. No CA.','3-4 lines. "+TICKER+" moving. Get in now. No CA.'];");
  ln("var caPromptIdx=0;");
  ln("async function buildCaCaption(){var p=caPrompts[caPromptIdx%caPrompts.length];caPromptIdx++;var ai=await smartAsk(systemPrompt(true),p);return ai+'\\n\\n'+CA+'\\n\\n'+E.lock+' "+RENOUNCED+" '+E.check+' LP "+LOCKED+"';}");
  ln("var xPrompts=['1-2 short punchy lines about "+TICKER+" on Twitter. Real energy. No hashtags.','1-2 lines. "+TICKER+" X is where the alpha drops.','1-2 tweet-energy lines. Follow "+TICKER+" on X.','1-2 lines. Why following "+TICKER+" on X is smart.','1-2 lines. "+TICKER+" Twitter updates worth watching.'];");
  ln("var xPromptIdx=0;");
  ln("async function buildXCaption(){var p=xPrompts[xPromptIdx%xPrompts.length];xPromptIdx++;var ai=await smartAsk(systemPrompt(false),p);return ai+'\\n\\n'+TWITTER;}");
  ln("var socialsIdx=0;");
  ln("function buildSocialsMsg(){var i=socialsIdx%4;socialsIdx++;var web=WEBSITE?'\\n\\u{1F310} <a href=\\''+WEBSITE+'\\'>Website</a>':'';if(i===0)return'<b>"+TICKER+" Links</b>\\n\\n<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY+'\\'>"+DEX_NAME+"</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+web;if(i===1)return E.chart+' <a href=\\''+CHART+'\\'>Chart</a>\\n'+E.money+' <a href=\\''+BUY+'\\'>Buy on "+DEX_NAME+"</a>\\n'+E.bird+' <a href=\\''+TWITTER+'\\'>Follow on X</a>'+web;if(i===2)return E.gem+' <b>"+TICKER+" Links</b>\\n\\n<a href=\\''+CHART+'\\'>DexScreener</a> \\u2022 <a href=\\''+BUY+'\\'>"+DEX_NAME+"</a> \\u2022 <a href=\\''+TWITTER+'\\'>Twitter/X</a>'+web;return'"+TICKER+":\\nChart \\u2192 '+CHART+'\\nBuy \\u2192 '+BUY+'\\nX \\u2192 '+TWITTER+(WEBSITE?'\\nSite \\u2192 '+WEBSITE:'');}");
  ln("var silenceAngles=['4-5 bullish lines. Why buy and hold "+TICKER+". Calm confidence.','4-5 lines. Early to "+TICKER+". DOGE/PEPE comparison.','4-5 lines. "+TICKER+" fundamentals: renounced, locked LP, low tax.','4-5 lines. Psychology of early "+TICKER+" investors.','4-5 lines. "+TICKER+" community strength.','4-5 lines. "+TICKER+" different from the noise.','4-5 lines. "+TICKER+" clean project. Just building.','4-5 lines. Quiet before the pump. "+TICKER+" holders know something.'];");
  ln("var silenceIdx=0;");
  ln("async function fireSilenceBreaker(){if(!groupChatId){resetSilence();return;}try{var p=silenceAngles[silenceIdx%silenceAngles.length];silenceIdx++;var cap=await smartAsk(systemPrompt(caUnlocked),p);await sendImage(groupChatId,cap,{});}catch(_){}resetSilence();}");
  ln("function resetSilence(){if(silenceTimer)clearTimeout(silenceTimer);silenceTimer=setTimeout(fireSilenceBreaker,SILENCE_DELAY);}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard','asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash','garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  // Anti-link: only x.com and twitter.com links are allowed
  ln("function hasBlockedLink(t){var u=t.match(/https?:\\/\\/[^\\s]+/g)||[];return u.some(function(x){return!x.includes('x.com')&&!x.includes('twitter.com');});}");
  ln("function hasExtMention(t){return/@[a-zA-Z0-9_]+/.test(t);}");
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}for(var i=0;i<ctx.message.new_chat_members.length;i++){var mem=ctx.message.new_chat_members[i];var name=mem.first_name||'fren';var p='Welcome '+name+' to "+TICKER+". Max 4 lines. Never start with Welcome. Vary everything.'+(caUnlocked?' CA: '+CA:' CA not revealed yet.');try{var msg=await smartAsk(systemPrompt(caUnlocked),p);var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);}catch(_){}}});");
  ln("bot.on('sticker',async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);var cnt=(stickerTracker.get(uid)||0)+1;stickerTracker.set(uid,cnt);if(cnt>3){try{await ctx.deleteMessage();}catch(_){}}});");
  ln("bot.on(['photo','video','document','audio','voice'],async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);});");
  ln("async function sendXReply(ctx){try{var cap=await buildXCaption();await sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:E.bird+' Follow on X',url:TWITTER}]]}});}catch(_){await ctx.reply('Twitter: '+TWITTER);}}");
  ln("bot.command('x',function(ctx){return sendXReply(ctx);});");
  ln("bot.command('twitter',function(ctx){return sendXReply(ctx);});");
  ln("bot.command('socials',async function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',async function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;return ctx.reply('CA is now HIDDEN.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.on('message',async function(ctx){var msg=ctx.message;if(!msg||!ctx.from)return;var uid=ctx.from.id,chatType=ctx.chat.type;var text=(msg.text||'').trim();var isPrivate=chatType==='private';if(!isPrivate&&groupChatId!==ctx.chat.id)groupChatId=ctx.chat.id;if(!isPrivate)resetSilence();var admin=await isAdmin(ctx,uid);if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;stickerTracker.set(uid,0);if(msg.forward_from||msg.forward_sender_name||msg.forward_from_chat)return applyStrike(ctx,uid);if(hasBlockedLink(text))return applyStrike(ctx,uid);if(hasExtMention(text))return applyStrike(ctx,uid);if(hasFud(text))return applyStrike(ctx,uid);}if(!text)return;var lower=text.toLowerCase();var caWords=['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca'];if(caWords.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)]);try{var cap=await buildCaCaption();return sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}});}catch(_){return ctx.reply(CA);}}if(lower==='x'||lower==='twitter')return sendXReply(ctx);if(lower==='socials'||lower==='links')return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});if(isPrivate){try{var dr=await smartAsk(systemPrompt(caUnlocked),text);if(dr!=='IGNORE')return ctx.reply(dr);}catch(_){}return;}try{var gr=await smartAsk(systemPrompt(caUnlocked),text);if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}});");
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function registerWebhook(){if(!WEBHOOK_URL){console.log('No WEBHOOK_URL');return;}var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Webhook set: '+url);return;}}catch(e){console.log('Attempt '+(i+1)+': '+e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('Bot starting on port '+PORT);await new Promise(function(r){setTimeout(r,2000);});await registerWebhook();resetSilence();console.log('"+TICKER+" bot is live');});");

  return L.join('\n');
}

// ================================================================
// FACTORY STARTUP
// ================================================================
app.post('/webhook', function(req, res) { bot.handleUpdate(req.body, res); });
app.get('/',        function(req, res) { res.end('OK'); });
app.get('/health',  function(req, res) { res.end('OK'); });

async function registerWebhook() {
  if (!WEBHOOK_URL) { console.log('No WEBHOOK_URL set'); return; }
  var url = WEBHOOK_URL + '/webhook';
  for (var i = 0; i < 5; i++) {
    try {
      var ok = await bot.telegram.setWebhook(url);
      if (ok) { console.log('Factory webhook set: ' + url); return; }
    } catch (e) { console.log('Webhook attempt ' + (i + 1) + ': ' + e.message); }
    await new Promise(function(r) { setTimeout(r, 3000); });
  }
}

process.on('uncaughtException',  function(e) { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', function(e) { console.error('Rejection:', e && e.message); });

app.listen(PORT, async function() {
  console.log('Factory bot starting on port ' + PORT);
  await new Promise(function(r) { setTimeout(r, 2000); });
  await registerWebhook();
  console.log('Bot Factory is live. Send /build to start.');
});
