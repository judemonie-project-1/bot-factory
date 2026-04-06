'use strict';

var Telegraf = require('telegraf').Telegraf;
var express = require('express');
var fs = require('fs');
var path = require('path');

// --- ENV ---
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

// --- EMOJI (pure ASCII source) ---
var E = {
  fire   : '\u{1F525}',
  check  : '\u2705',
  x      : '\u274C',
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
};

var bot = new Telegraf(BOT_TOKEN);
var app = express();
app.use(express.json());

// --- SESSIONS ---
var sessions = {};

function newSession() {
  return {
    step: 'name',
    data: {
      tokenName: '', ticker: '', ca: '', supply: '',
      maxWalletPct: '', maxWalletTokens: '',
      buyTax: '', sellTax: '',
      twitter: '', website: '',
      renounced: '', locked: '',
      narrative: '',
      botToken: '',
      revealCmd: 'revealca',
      hideCmd: 'hideca',
    },
    imageBuffer: null,
  };
}

// --- STEPS ---
var STEPS = [
  { key: 'name',      ask: E.pencil + ' Token name? (e.g. PECKER)' },
  { key: 'ticker',    ask: E.pencil + ' Ticker with $? (e.g. $PECKER)' },
  { key: 'ca',        ask: E.pencil + ' Contract address?' },
  { key: 'supply',    ask: E.pencil + ' Total supply? (e.g. 1,000,000,000)' },
  { key: 'maxwallet', ask: E.pencil + ' Max wallet % / token count? (e.g. 4.9% / 49,000,000)' },
  { key: 'taxes',     ask: E.pencil + ' Buy / sell tax? (e.g. 5/5)' },
  { key: 'twitter',   ask: E.pencil + ' Twitter/X link? (e.g. https://x.com/pecker_bsc)' },
  { key: 'website',   ask: E.pencil + ' Website? (send - to skip)' },
  { key: 'renounced', ask: E.pencil + ' Contract renounced? (yes/no)' },
  { key: 'locked',    ask: E.pencil + ' LP locked? (yes/no)' },
  { key: 'narrative', ask: E.pencil + ' Token story / narrative? (can be long)' },
  { key: 'image',     ask: E.pencil + ' Send the bot image now (JPG or PNG)' },
  { key: 'bottoken',  ask: E.pencil + ' BotFather token for this new bot?' },
  { key: 'revealcmd', ask: E.pencil + ' Secret reveal-CA command? (send - for default: revealca)' },
  { key: 'hidecmd',   ask: E.pencil + ' Secret hide-CA command? (send - for default: hideca)' },
];

function stepByKey(key) { return STEPS.find(function(s) { return s.key === key; }); }

function advanceStep(s) {
  var idx = STEPS.findIndex(function(t) { return t.key === s.step; });
  if (idx + 1 < STEPS.length) { s.step = STEPS[idx + 1].key; return STEPS[idx + 1]; }
  s.step = 'confirm';
  return null;
}

function processInput(s, text) {
  var d = s.data;
  switch (s.step) {
    case 'name':      d.tokenName = text; break;
    case 'ticker':    d.ticker = text; break;
    case 'ca':        d.ca = text; break;
    case 'supply':    d.supply = text; break;
    case 'maxwallet': {
      var mw = text.split('/');
      d.maxWalletPct    = (mw[0] || text).trim();
      d.maxWalletTokens = (mw[1] || '').trim();
      break;
    }
    case 'taxes': {
      var tx = text.split('/');
      d.buyTax  = (tx[0] || text).trim();
      d.sellTax = (tx[1] || tx[0] || '').trim();
      break;
    }
    case 'twitter':   d.twitter = text; break;
    case 'website':   d.website = (text === '-') ? '' : text; break;
    case 'renounced': d.renounced = /yes/i.test(text) ? 'RENOUNCED' : 'NOT RENOUNCED'; break;
    case 'locked':    d.locked   = /yes/i.test(text) ? 'LOCKED'    : 'NOT LOCKED'; break;
    case 'narrative': d.narrative = text; break;
    case 'bottoken':  d.botToken = text; break;
    case 'revealcmd': d.revealCmd = (text === '-') ? 'revealca' : text.replace(/^\//, ''); break;
    case 'hidecmd':   d.hideCmd   = (text === '-') ? 'hideca'   : text.replace(/^\//, ''); break;
  }
}

function buildSummary(d) {
  return (
    E.fire + ' <b>Build Summary \u2014 Review before deploying</b>\n\n' +
    '<b>Name:</b> ' + d.tokenName + ' (' + d.ticker + ')\n' +
    '<b>CA:</b> <code>' + d.ca + '</code>\n' +
    '<b>Supply:</b> ' + d.supply + '\n' +
    '<b>Max Wallet:</b> ' + d.maxWalletPct + ' / ' + d.maxWalletTokens + '\n' +
    '<b>Tax:</b> Buy ' + d.buyTax + '% / Sell ' + d.sellTax + '%\n' +
    '<b>Twitter:</b> ' + d.twitter + '\n' +
    (d.website ? '<b>Website:</b> ' + d.website + '\n' : '') +
    '<b>Contract:</b> ' + d.renounced + '\n' +
    '<b>LP:</b> ' + d.locked + '\n' +
    '<b>Reveal cmd:</b> /' + d.revealCmd + '\n' +
    '<b>Hide cmd:</b> /' + d.hideCmd + '\n' +
    '<b>Image:</b> ' + (sessions._img ? E.check + ' received' : E.warn + ' missing') + '\n\n' +
    'Reply <b>yes</b> to build \u2014 <b>no</b> to cancel.'
  );
}

// --- HANDLERS ---

bot.command(['build', 'new'], function(ctx) {
  var uid = String(ctx.from.id);
  sessions[uid] = newSession();
  return ctx.reply(
    E.fire + ' <b>New bot build started!</b>\n\n' + STEPS[0].ask,
    { parse_mode: 'HTML' }
  );
});

bot.command('cancel', function(ctx) {
  var uid = String(ctx.from.id);
  delete sessions[uid];
  return ctx.reply(E.x + ' Build cancelled.');
});

bot.command('addgroq', function(ctx) {
  var txt = (ctx.message.text || '').replace('/addgroq', '').trim();
  if (!txt) return ctx.reply('Usage: /addgroq YOUR_GROQ_KEY');
  groqPool.push(txt);
  return ctx.reply(E.check + ' Groq key added. Pool: ' + groqPool.length + ' key(s).');
});

bot.command('help', function(ctx) {
  return ctx.reply(
    E.gear + ' <b>Bot Factory</b>\n\n' +
    '/build \u2014 Build a new bot\n' +
    '/cancel \u2014 Cancel current build\n' +
    '/addgroq KEY \u2014 Add Groq API key\n' +
    '/help \u2014 Show this',
    { parse_mode: 'HTML' }
  );
});

function handleImageBuffer(ctx, buf) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'image') return ctx.reply('No active build waiting for an image. Use /build first.');
  s.imageBuffer = buf;
  sessions._img = true;
  var nxt = advanceStep(s);
  if (nxt) return ctx.reply(E.check + ' Image saved!\n\n' + nxt.ask);
  return ctx.reply(buildSummary(s.data), { parse_mode: 'HTML' });
}

bot.on('photo', function(ctx) {
  var photos = ctx.message.photo;
  var ph = photos[photos.length - 1];
  return ctx.telegram.getFileLink(ph.file_id).then(function(link) {
    return fetch(link.href);
  }).then(function(r) { return r.arrayBuffer(); }).then(function(ab) {
    return handleImageBuffer(ctx, Buffer.from(ab));
  }).catch(function(e) { return ctx.reply(E.x + ' Image download failed: ' + e.message); });
});

bot.on('document', function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s || s.step !== 'image') return;
  var doc = ctx.message.document;
  if (!doc.mime_type || !doc.mime_type.startsWith('image/')) {
    return ctx.reply('Please send an image file (JPG or PNG).');
  }
  return ctx.telegram.getFileLink(doc.file_id).then(function(link) {
    return fetch(link.href);
  }).then(function(r) { return r.arrayBuffer(); }).then(function(ab) {
    return handleImageBuffer(ctx, Buffer.from(ab));
  }).catch(function(e) { return ctx.reply(E.x + ' Image download failed: ' + e.message); });
});

bot.on('text', function(ctx) {
  var uid = String(ctx.from.id);
  var s = sessions[uid];
  if (!s) return ctx.reply('Send /build to start, or /help for commands.');
  var text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;

  if (s.step === 'image') return ctx.reply('Please send an image (photo or PNG file).');

  if (s.step === 'confirm') {
    if (/^yes$/i.test(text)) return runBuild(ctx, s, uid);
    delete sessions[uid];
    return ctx.reply(E.x + ' Cancelled.');
  }

  processInput(s, text);
  var nxt = advanceStep(s);

  if (s.step === 'confirm') {
    return ctx.reply(buildSummary(s.data), { parse_mode: 'HTML' });
  }
  return ctx.reply(nxt.ask);
});

// --- BUILD ORCHESTRATOR ---
async function runBuild(ctx, s, uid) {
  var d = s.data;
  var groqKey = nextGroqKey();
  if (!groqKey) return ctx.reply(E.x + ' No Groq key. Use /addgroq KEY first.');

  await ctx.reply(E.gear + ' Building... this takes about 2 minutes. Stay here.');

  try {
    // 1. GitHub
    await ctx.reply(E.folder + ' Creating GitHub repo...');
    var ghUser = await githubGetUser();
    var repoName = d.ticker.replace('$', '').toLowerCase() + '-bot-' + rndStr(4);
    await githubCreateRepo(repoName);

    var svcUrl = 'https://' + repoName + '.onrender.com';
    var botCode = generateBotJs(d, svcUrl);
    var pkgCode = generatePackageJson(d.tokenName);

    await githubPushFile(ghUser, repoName, 'bot.js',       Buffer.from(botCode));
    await githubPushFile(ghUser, repoName, 'package.json', Buffer.from(pkgCode));
    if (s.imageBuffer) {
      await githubPushFile(ghUser, repoName, 'siren.jpg', s.imageBuffer);
    }
    await ctx.reply(E.check + ' GitHub: github.com/' + ghUser + '/' + repoName);

    // 2. Render
    await ctx.reply(E.cloud + ' Creating Render service...');
    var ownerId = await renderGetOwnerId();
    var svc = await renderCreateService(repoName, ghUser, ownerId);
    var serviceId = svc.id || (svc.service && svc.service.id);
    // Get actual URL if returned
    var actualUrl = (svc.serviceDetails && svc.serviceDetails.url)
      || (svc.service && svc.service.serviceDetails && svc.service.serviceDetails.url)
      || svcUrl;

    await renderSetEnvVars(serviceId, [
      { key: 'BOT_TOKEN',    value: d.botToken },
      { key: 'GROQ_API_KEY', value: groqKey },
      { key: 'WEBHOOK_URL',  value: actualUrl },
    ]);
    await ctx.reply(E.check + ' Render: ' + actualUrl);

    // 3. Cron-job
    await ctx.reply(E.clock + ' Setting up keepalive...');
    await cronCreateJob(repoName, actualUrl + '/health');
    await ctx.reply(E.check + ' Cron-job created (every 5 min)');

    // 4. Done
    delete sessions[uid];
    await ctx.reply(
      E.party + ' <b>Bot deployed!</b>\n\n' +
      '\u{1F517} ' + actualUrl + '\n' +
      '\u{1F4E6} github.com/' + ghUser + '/' + repoName + '\n\n' +
      '<b>What to do now:</b>\n' +
      '1. Wait 3-5 min for Render to build\n' +
      '2. Add your new bot to your Telegram group\n' +
      '3. Make it admin (delete / ban / restrict)\n' +
      '4. Use /' + d.revealCmd + ' when ready to reveal CA',
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    await ctx.reply(E.x + ' Build failed:\n<code>' + err.message + '</code>\n\nSend /build to retry.', { parse_mode: 'HTML' });
    delete sessions[uid];
  }
}

// --- GITHUB API ---
async function githubGetUser() {
  var r = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' },
  });
  var d = await r.json();
  if (!d.login) throw new Error('GitHub auth failed: ' + JSON.stringify(d).slice(0, 200));
  return d.login;
}

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
  if (!d.full_name) throw new Error('Repo create failed: ' + JSON.stringify(d).slice(0, 200));
  return d;
}

async function githubPushFile(user, repo, filename, content) {
  var r = await fetch('https://api.github.com/repos/' + user + '/' + repo + '/contents/' + filename, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'Deploy ' + filename, content: content.toString('base64') }),
  });
  var d = await r.json();
  if (!d.content && !d.commit) throw new Error('Push failed for ' + filename + ': ' + JSON.stringify(d).slice(0, 200));
  return d;
}

// --- RENDER API ---
async function renderGetOwnerId() {
  var r = await fetch('https://api.render.com/v1/owners?limit=1', {
    headers: { 'Authorization': 'Bearer ' + RENDER_KEY, 'Accept': 'application/json' },
  });
  var d = await r.json();
  if (!Array.isArray(d) || !d[0]) throw new Error('Render owner fetch failed: ' + JSON.stringify(d).slice(0, 200));
  return d[0].owner ? d[0].owner.id : d[0].id;
}

async function renderCreateService(name, ghUser, ownerId) {
  var body = {
    autoDeploy: 'yes',
    branch: 'main',
    name: name,
    ownerId: ownerId,
    repo: 'https://github.com/' + ghUser + '/' + name,
    type: 'web_service',
    serviceDetails: {
      buildCommand: 'npm install',
      startCommand: 'npm start',
      envSpecificDetails: { buildCommand: 'npm install', startCommand: 'npm start' },
      plan: 'free',
      region: 'oregon',
      runtime: 'node',
      numInstances: 1,
    },
  };
  var r = await fetch('https://api.render.com/v1/services', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RENDER_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  var d = await r.json();
  var svc = d.service || d;
  if (!svc.id) throw new Error('Render create failed: ' + JSON.stringify(d).slice(0, 300));
  return svc;
}

async function renderSetEnvVars(serviceId, vars) {
  await fetch('https://api.render.com/v1/services/' + serviceId + '/env-vars', {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + RENDER_KEY,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(vars),
  });
}

// --- CRON-JOB API ---
async function cronCreateJob(name, url) {
  await fetch('https://api.cron-job.org/jobs', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + CRON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job: {
        url: url, title: name + ' keepalive', enabled: true, saveResponses: false,
        schedule: { timezone: 'UTC', hours: [-1], mdays: [-1], months: [-1], wdays: [-1],
          minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55] },
      }
    }),
  });
}

// --- HELPERS ---
function rndStr(n) {
  var c = 'abcdefghijklmnopqrstuvwxyz0123456789', o = '';
  for (var i = 0; i < n; i++) o += c[Math.floor(Math.random() * c.length)];
  return o;
}

function generatePackageJson(tokenName) {
  return JSON.stringify({
    name: tokenName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-bot',
    version: '1.0.0',
    main: 'bot.js',
    scripts: { start: 'node bot.js' },
    dependencies: { telegraf: '^4.16.3', 'groq-sdk': '^0.3.3', express: '^4.18.2' },
    engines: { node: '>=18.0.0' },
  }, null, 2);
}

// ===========================================================
// GENERATED BOT.JS TEMPLATE
// ===========================================================
function generateBotJs(d, webhookUrl) {
  var NAME      = d.tokenName;
  var TICKER    = d.ticker;
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
  var NARR      = JSON.stringify(d.narrative); // safely escaped
  var REVEAL    = d.revealCmd.replace(/^\//, '');
  var HIDE      = d.hideCmd.replace(/^\//, '');
  var CHART     = 'https://dexscreener.com/bsc/' + CA;
  var BUY_LINK  = 'https://pancakeswap.finance/swap?outputCurrency=' + CA;

  var L = [];
  function ln(s) { L.push(s === undefined ? '' : s); }

  ln("'use strict';");
  ln("var Telegraf = require('telegraf').Telegraf;");
  ln("var express  = require('express');");
  ln("var Groq     = require('groq-sdk');");
  ln("var fs       = require('fs');");
  ln("var path     = require('path');");
  ln();
  ln("var BOT_TOKEN   = process.env.BOT_TOKEN;");
  ln("var GROQ_API_KEY = process.env.GROQ_API_KEY;");
  ln("var WEBHOOK_URL  = (process.env.WEBHOOK_URL || '').trim();");
  ln("var PORT         = process.env.PORT || 3000;");
  ln();
  ln("var CA      = '" + CA + "';");
  ln("var CHART   = 'https://dexscreener.com/bsc/' + CA;");
  ln("var BUY     = 'https://pancakeswap.finance/swap?outputCurrency=' + CA;");
  ln("var TWITTER = '" + TWITTER + "';");
  ln("var WEBSITE = '" + WEBSITE + "';");
  ln();
  ln("var E = {");
  ln("  rocket : '\\u{1F680}',");
  ln("  fire   : '\\u{1F525}',");
  ln("  chart  : '\\u{1F4C8}',");
  ln("  lock   : '\\u{1F512}',");
  ln("  check  : '\\u2705',");
  ln("  zap    : '\\u26A1',");
  ln("  gem    : '\\u{1F48E}',");
  ln("  star   : '\\u2B50',");
  ln("  money  : '\\u{1F4B0}',");
  ln("  shield : '\\u{1F6E1}',");
  ln("  bird   : '\\u{1F426}',");
  ln("  wave   : '\\u{1F44B}',");
  ln("  dash   : '\\u2014',");
  ln("};");
  ln();
  ln("var bot  = new Telegraf(BOT_TOKEN);");
  ln("var app  = express();");
  ln("var groq = new Groq({ apiKey: GROQ_API_KEY });");
  ln("app.use(express.json());");
  ln();
  ln("var caUnlocked    = false;");
  ln("var groupChatId   = null;");
  ln("var silenceTimer  = null;");
  ln("var imageMessages = new Map();");
  ln("var strikes       = new Map();");
  ln("var spamTracker   = new Map();");
  ln("var stickerTracker = new Map();");
  ln("var lastReplies   = [];");
  ln("var MAX_REPLY_HIST = 12;");
  ln("var IMG           = path.join(__dirname, 'siren.jpg');");
  ln("var SILENCE_DELAY = 10 * 60 * 1000;");
  ln("var STRIKE_RESET  = 86400000;");
  ln("var SPAM_WINDOW   = 60000;");
  ln("var SPAM_MAX      = 5;");
  ln();
  ln("function systemPrompt(withCa) {");
  ln("  return (");
  ln("    'You are the official Telegram bot for " + TICKER + ", a BNB Smart Chain meme token.\\n\\n' +");
  ln("    'TOKEN FACTS:\\n' +");
  ln("    '- Name: " + NAME + " | Ticker: " + TICKER + "\\n' +");
  ln("    '- Blockchain: BNB Smart Chain (BSC)\\n' +");
  ln("    '- Total Supply: " + SUPPLY + "\\n' +");
  ln("    '- Max Wallet: " + MAX_PCT + " \\u2014 anti-whale cap. No wallet can hold more than " + MAX_TOK + " tokens.\\n' +");
  ln("    '- Buy Tax: " + BUY_TAX + "% | Sell Tax: " + SELL_TAX + "%\\n' +");
  ln("    '- Contract: " + RENOUNCED + " \\u2014 permanently locked code. Security feature, not an exit.\\n' +");
  ln("    '- Liquidity: " + LOCKED + " \\u2014 funds fully secured.\\n' +");
  ln("    '- DEV STATUS: Dev is ACTIVE \\u2014 in the group, watching charts, working on marketing. NEVER imply dev stepped back or is gone.\\n' +");
  ln("    '- Twitter/X: ' + TWITTER + '\\n' +");
  ln("    (withCa ? '- Contract Address: ' + CA + '\\n' : '') +");
  ln("    (withCa ? '- Chart: ' + CHART + '\\n' : '') +");
  ln("    (withCa ? '- Buy: ' + BUY + '\\n' : '') +");
  ln("    '\\nNARRATIVE:\\n' + " + NARR + " + '\\n\\n' +");
  ln("    'PERSONALITY:\\n' +");
  ln("    '- Calm, confident, warm, genuinely bullish \\u2014 never fake hype\\n' +");
  ln("    '- Every reply must feel completely different every time\\n' +");
  ln("    '- Vary words, structure, energy, opening, tone\\n' +");
  ln("    '- Never robotic, never corporate, never stiff\\n' +");
  ln("    '- Minimal emojis \\u2014 natural, never forced\\n' +");
  ln("    '- Short questions = 1-3 lines | Detailed = up to 5 lines\\n\\n' +");
  ln("    'HARD RULES:\\n' +");
  ln("    '- NEVER share the Telegram group link\\n' +");
  ln("    '- NEVER volunteer the CA unless directly asked\\n' +");
  ln("    '- NEVER put emoji on the same line as the contract address\\n' +");
  ln("    '- NEVER repeat the same reply twice\\n' +");
  ln("    '- NEVER use corporate or stiff language\\n' +");
  ln("    '- If message is hype, casual chat, or needs no answer: reply with exactly IGNORE'");
  ln("  );");
  ln("}");
  ln();
  ln("async function askGroq(sys, msg) {");
  ln("  var r = await groq.chat.completions.create({");
  ln("    model: 'llama-3.3-70b-versatile', temperature: 1.0, max_tokens: 300,");
  ln("    messages: [{ role: 'system', content: sys }, { role: 'user', content: msg }],");
  ln("  });");
  ln("  return r.choices[0].message.content.trim();");
  ln("}");
  ln();
  ln("function isDupe(r) { return lastReplies.includes(r); }");
  ln("function recordReply(r) { lastReplies.push(r); if (lastReplies.length > MAX_REPLY_HIST) lastReplies.shift(); }");
  ln("async function smartAsk(sys, prompt) {");
  ln("  var r = await askGroq(sys, prompt);");
  ln("  if (isDupe(r)) r = await askGroq(sys, prompt + ' Give a completely different response from before.');");
  ln("  recordReply(r);");
  ln("  return r;");
  ln("}");
  ln();
  ln("async function deletePrevImage(chatId) {");
  ln("  var mid = imageMessages.get(chatId);");
  ln("  if (mid) { try { await bot.telegram.deleteMessage(chatId, mid); } catch (_) {} imageMessages.delete(chatId); }");
  ln("}");
  ln();
  ln("async function sendImage(chatId, caption, extra) {");
  ln("  await deletePrevImage(chatId);");
  ln("  extra = extra || {};");
  ln("  try {");
  ln("    if (fs.existsSync(IMG)) {");
  ln("      var m = await bot.telegram.sendPhoto(chatId, { source: IMG }, Object.assign({ caption: caption, parse_mode: 'HTML' }, extra));");
  ln("      imageMessages.set(chatId, m.message_id);");
  ln("      return m;");
  ln("    }");
  ln("  } catch (_) {}");
  ln("  return bot.telegram.sendMessage(chatId, caption, Object.assign({ parse_mode: 'HTML' }, extra));");
  ln("}");
  ln();
  ln("function autoDelete(chatId, msgId, delay) {");
  ln("  setTimeout(function() { try { bot.telegram.deleteMessage(chatId, msgId); } catch (_) {} }, delay);");
  ln("}");
  ln();
  ln("async function isAdmin(ctx, userId) {");
  ln("  var t = ctx.chat && ctx.chat.type;");
  ln("  if (t !== 'group' && t !== 'supergroup') return false;");
  ln("  try { var m = await ctx.telegram.getChatMember(ctx.chat.id, userId); return m.status === 'administrator' || m.status === 'creator'; } catch (_) { return false; }");
  ln("}");
  ln();
  ln("function getStrike(uid) {");
  ln("  var now = Date.now(), s = strikes.get(uid);");
  ln("  if (!s || now - s.since > STRIKE_RESET) { s = { count: 0, since: now }; strikes.set(uid, s); }");
  ln("  return s;");
  ln("}");
  ln();
  ln("async function applyStrike(ctx, uid) {");
  ln("  var s = getStrike(uid); s.count++;");
  ln("  try { await ctx.deleteMessage(); } catch (_) {}");
  ln("  if (s.count >= 3) {");
  ln("    s.count = 0;");
  ln("    try { await ctx.telegram.restrictChatMember(ctx.chat.id, uid, { permissions: { can_send_messages: false }, until_date: Math.floor(Date.now() / 1000) + 300 }); } catch (_) {}");
  ln("    var m3 = await ctx.reply('Muted 5 minutes (3 strikes).');");
  ln("    autoDelete(ctx.chat.id, m3.message_id, 12000);");
  ln("  } else {");
  ln("    var m = await ctx.reply('Warning ' + s.count + '/3');");
  ln("    autoDelete(ctx.chat.id, m.message_id, 10000);");
  ln("  }");
  ln("}");
  ln();
  ln("async function checkSpam(ctx, uid) {");
  ln("  var now = Date.now(), t = spamTracker.get(uid) || { count: 0, since: now };");
  ln("  if (now - t.since > SPAM_WINDOW) t = { count: 0, since: now };");
  ln("  t.count++; spamTracker.set(uid, t);");
  ln("  if (t.count > SPAM_MAX) {");
  ln("    try { await ctx.telegram.restrictChatMember(ctx.chat.id, uid, { permissions: { can_send_messages: false }, until_date: Math.floor(Date.now() / 1000) + 300 }); } catch (_) {}");
  ln("    var m = await ctx.reply('Slow down. Muted 5 min for spam.'); autoDelete(ctx.chat.id, m.message_id, 15000);");
  ln("    return true;");
  ln("  }");
  ln("  return false;");
  ln("}");
  ln();
  ln("var notLiveMsgs = [");
  ln("  '" + TICKER + " hasn\\u2019t officially launched yet. Stay close \\u2014 CA drops soon.',");
  ln("  'Not yet. Contract reveal is coming. Stay patient and stay ready.',");
  ln("  'CA isn\\u2019t live yet. When it drops you\\u2019ll know first.',");
  ln("  'Hold tight. " + TICKER + " launches soon. CA revealed when the time is right.',");
  ln("  'We\\u2019re not there yet. Sit tight \\u2014 launch is close.',");
  ln("];");
  ln();
  ln("var caPrompts = [");
  ln("  'Write 3-4 punchy bullish lines about why " + TICKER + " is the move right now. No CA. Short, confident.',");
  ln("  'Give 3-4 lines on why " + TICKER + " fundamentals are solid. Renounced, locked LP, active dev. No CA.',");
  ln("  'Write 3-4 lines that make someone feel they found something early. " + TICKER + " energy. No CA.',");
  ln("  '3-4 lines about " + TICKER + " being built different. Safety, community, momentum. No CA.',");
  ln("  'Write 3-4 lines about why " + TICKER + " holders are early. Calm confidence. No CA.',");
  ln("  'Short 3-4 lines on what makes " + TICKER + " worth attention right now. No CA.',");
  ln("  '3-4 lines. " + TICKER + " is moving. Why get in now? No CA.',");
  ln("]; var caPromptIdx = 0;");
  ln();
  ln("async function buildCaCaption() {");
  ln("  var p = caPrompts[caPromptIdx % caPrompts.length]; caPromptIdx++;");
  ln("  var ai = await smartAsk(systemPrompt(true), p);");
  ln("  return ai + '\\n\\n' + CA + '\\n\\n' + E.lock + ' " + RENOUNCED + " ' + E.check + ' LP " + LOCKED + "';");
  ln("}");
  ln();
  ln("var xPrompts = [");
  ln("  'Write 1-2 short punchy lines about " + TICKER + " Twitter. Real energy. No hashtags.',");
  ln("  '1-2 lines. " + TICKER + " X is where the alpha is. Short and confident.',");
  ln("  '1-2 tweet-energy lines about following " + TICKER + " on X. No hashtags.',");
  ln("  '1-2 lines why following " + TICKER + " on X is smart right now.',");
  ln("  '1-2 punchy lines. " + TICKER + " Twitter updates worth watching.',");
  ln("]; var xPromptIdx = 0;");
  ln();
  ln("async function buildXCaption() {");
  ln("  var p = xPrompts[xPromptIdx % xPrompts.length]; xPromptIdx++;");
  ln("  var ai = await smartAsk(systemPrompt(false), p);");
  ln("  return ai + '\\n\\n' + TWITTER;");
  ln("}");
  ln();
  ln("var socialsIdx = 0;");
  ln("function buildSocialsMsg() {");
  ln("  var i = socialsIdx % 4; socialsIdx++;");
  ln("  var web = WEBSITE ? '\\n\\u{1F310} <a href=\\'' + WEBSITE + '\\'>Website</a>' : '';");
  ln("  if (i === 0) return '<b>" + TICKER + " Links</b>\\n\\n<a href=\\'' + CHART + '\\'>Chart</a> | <a href=\\'' + BUY + '\\'>Buy</a> | <a href=\\'' + TWITTER + '\\'>Twitter</a>' + web;");
  ln("  if (i === 1) return E.chart + ' <a href=\\'' + CHART + '\\'>View Chart</a>\\n' + E.money + ' <a href=\\'' + BUY + '\\'>Buy on PancakeSwap</a>\\n' + E.bird + ' <a href=\\'' + TWITTER + '\\'>Follow on X</a>' + web;");
  ln("  if (i === 2) return E.gem + ' <b>" + TICKER + " Official Links</b>\\n\\n\\u{1F4CA} <a href=\\'' + CHART + '\\'>DexScreener</a>\\n\\u{1F4B8} <a href=\\'' + BUY + '\\'>PancakeSwap</a>\\n\\u{1F426} <a href=\\'' + TWITTER + '\\'>Twitter/X</a>' + web;");
  ln("  return 'Everything for " + TICKER + ":\\n\\nChart \\u2192 ' + CHART + '\\nBuy \\u2192 ' + BUY + '\\nX \\u2192 ' + TWITTER + (WEBSITE ? '\\nSite \\u2192 ' + WEBSITE : '');");
  ln("}");
  ln();
  ln("var silenceAngles = [");
  ln("  'Write 4-5 bullish lines about why now is the time to buy and hold " + TICKER + ". Calm confidence.',");
  ln("  '4-5 lines about being early to " + TICKER + ". DOGE and PEPE comparison angle. No hype words.',");
  ln("  '4-5 lines. " + TICKER + " fundamentals: renounced, locked LP, low tax, max wallet cap. Why this matters.',");
  ln("  '4-5 lines on psychology of early " + TICKER + " investors. Those who hold early win.',");
  ln("  '4-5 lines about " + TICKER + " community strength and momentum. Genuine bullish energy.',");
  ln("  '4-5 lines. What makes " + TICKER + " different from the noise right now.',");
  ln("  '4-5 lines about " + TICKER + " being a clean project. No games, just building.',");
  ln("  '4-5 lines. The quiet before the pump. " + TICKER + " holders know something the crowd doesn\\u2019t.',");
  ln("]; var silenceIdx = 0;");
  ln();
  ln("async function fireSilenceBreaker() {");
  ln("  if (!groupChatId) { resetSilence(); return; }");
  ln("  try {");
  ln("    var p = silenceAngles[silenceIdx % silenceAngles.length]; silenceIdx++;");
  ln("    var cap = await smartAsk(systemPrompt(caUnlocked), p);");
  ln("    await sendImage(groupChatId, cap, {});");
  ln("  } catch (_) {}");
  ln("  resetSilence();");
  ln("}");
  ln("function resetSilence() {");
  ln("  if (silenceTimer) clearTimeout(silenceTimer);");
  ln("  silenceTimer = setTimeout(fireSilenceBreaker, SILENCE_DELAY);");
  ln("}");
  ln();
  ln("var FUD = ['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard',");
  ln("  'asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash',");
  ln("  'garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t) { var l = t.toLowerCase(); return FUD.some(function(w) { return l.includes(w); }); }");
  ln("function hasExtLink(t) { var u = t.match(/https?:\\/\\/[^\\s]+/g) || []; return u.some(function(x) { return !x.includes('x.com') && !x.includes('twitter.com'); }); }");
  ln("function hasExtMention(t) { return /@[a-zA-Z0-9_]+/.test(t); }");
  ln();
  ln("bot.on('new_chat_members', async function(ctx) {");
  ln("  if (ctx.message.new_chat_members.some(function(m) { return m.is_bot; })) return;");
  ln("  try { await ctx.deleteMessage(); } catch (_) {}");
  ln("  for (var i = 0; i < ctx.message.new_chat_members.length; i++) {");
  ln("    var mem = ctx.message.new_chat_members[i];");
  ln("    var name = mem.first_name || 'fren';");
  ln("    var p = 'Write a warm unique welcome for ' + name + ' joining the " + TICKER + " Telegram group. Max 4 lines. Never start with Welcome. Vary everything. Genuine bullish energy.' + (caUnlocked ? ' CA is live: ' + CA + '. Chart: ' + CHART : '');");
  ln("    try { var m = await smartAsk(systemPrompt(caUnlocked), p); var msg = await ctx.reply(m); autoDelete(ctx.chat.id, msg.message_id, 60000); } catch (_) {}");
  ln("  }");
  ln("});");
  ln();
  ln("bot.on('sticker', async function(ctx) {");
  ln("  var uid = ctx.from.id; var admin = await isAdmin(ctx, uid); if (admin) return;");
  ln("  if (ctx.message.forward_from || ctx.message.forward_sender_name || ctx.message.forward_from_chat) return applyStrike(ctx, uid);");
  ln("  var cnt = (stickerTracker.get(uid) || 0) + 1; stickerTracker.set(uid, cnt);");
  ln("  if (cnt > 3) { try { await ctx.deleteMessage(); } catch (_) {} }");
  ln("});");
  ln();
  ln("bot.on(['photo','video','document','audio','voice'], async function(ctx) {");
  ln("  var uid = ctx.from.id; var admin = await isAdmin(ctx, uid); if (admin) return;");
  ln("  if (ctx.message.forward_from || ctx.message.forward_sender_name || ctx.message.forward_from_chat) return applyStrike(ctx, uid);");
  ln("});");
  ln();
  ln("async function sendXReply(ctx) {");
  ln("  try {");
  ln("    var cap = await buildXCaption();");
  ln("    await sendImage(ctx.chat.id, cap, { reply_markup: { inline_keyboard: [[{ text: E.bird + ' Follow on X', url: TWITTER }]] } });");
  ln("  } catch (_) { await ctx.reply('Twitter: ' + TWITTER); }");
  ln("}");
  ln();
  ln("bot.command('x',       function(ctx) { return sendXReply(ctx); });");
  ln("bot.command('twitter', function(ctx) { return sendXReply(ctx); });");
  ln("bot.command('socials', async function(ctx) { return ctx.reply(buildSocialsMsg(), { parse_mode: 'HTML', disable_web_page_preview: true }); });");
  ln("bot.command('links',   async function(ctx) { return ctx.reply(buildSocialsMsg(), { parse_mode: 'HTML', disable_web_page_preview: true }); });");
  ln();
  ln("bot.command('" + REVEAL + "', async function(ctx) {");
  ln("  var t = ctx.chat && ctx.chat.type;");
  ln("  if (t === 'private') { caUnlocked = true; return ctx.reply('CA is now REVEALED.'); }");
  ln("  var admin = await isAdmin(ctx, ctx.from.id); if (!admin) return;");
  ln("  caUnlocked = true; var m = await ctx.reply('CA is now live and visible.'); autoDelete(ctx.chat.id, m.message_id, 10000);");
  ln("});");
  ln();
  ln("bot.command('" + HIDE + "', async function(ctx) {");
  ln("  var t = ctx.chat && ctx.chat.type;");
  ln("  if (t === 'private') { caUnlocked = false; return ctx.reply('CA is now HIDDEN.'); }");
  ln("  var admin = await isAdmin(ctx, ctx.from.id); if (!admin) return;");
  ln("  caUnlocked = false; var m = await ctx.reply('CA is now hidden.'); autoDelete(ctx.chat.id, m.message_id, 10000);");
  ln("});");
  ln();
  ln("bot.on('message', async function(ctx) {");
  ln("  var msg = ctx.message; if (!msg || !ctx.from) return;");
  ln("  var uid = ctx.from.id, chatType = ctx.chat.type;");
  ln("  var text = (msg.text || '').trim();");
  ln("  var isPrivate = chatType === 'private';");
  ln("  if (!isPrivate && groupChatId !== ctx.chat.id) groupChatId = ctx.chat.id;");
  ln("  if (!isPrivate) resetSilence();");
  ln("  var admin = await isAdmin(ctx, uid);");
  ln("  if (!isPrivate && !admin && text) {");
  ln("    var spammed = await checkSpam(ctx, uid); if (spammed) return;");
  ln("    stickerTracker.set(uid, 0);");
  ln("    if (msg.forward_from || msg.forward_sender_name || msg.forward_from_chat) return applyStrike(ctx, uid);");
  ln("    if (hasExtLink(text)) return applyStrike(ctx, uid);");
  ln("    if (hasExtMention(text)) return applyStrike(ctx, uid);");
  ln("    if (hasFud(text)) return applyStrike(ctx, uid);");
  ln("  }");
  ln("  if (!text) return;");
  ln("  var lower = text.toLowerCase();");
  ln("  var caWords = ['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca'];");
  ln("  if (caWords.some(function(w) { return lower === w || lower.includes(w); })) {");
  ln("    if (!caUnlocked) { return ctx.reply(notLiveMsgs[Math.floor(Math.random() * notLiveMsgs.length)]); }");
  ln("    try {");
  ln("      var cap = await buildCaCaption();");
  ln("      return sendImage(ctx.chat.id, cap, { reply_markup: { inline_keyboard: [[{ text: '\\u{1F4CB} Copy CA', copy_text: { text: CA } }]] } });");
  ln("    } catch (_) { return ctx.reply(CA); }");
  ln("  }");
  ln("  if (lower === 'x' || lower === 'twitter' || lower === '/x' || lower === '/twitter') return sendXReply(ctx);");
  ln("  if (lower === 'socials' || lower === 'links' || lower === '/socials' || lower === '/links') {");
  ln("    return ctx.reply(buildSocialsMsg(), { parse_mode: 'HTML', disable_web_page_preview: true });");
  ln("  }");
  ln("  if (isPrivate) {");
  ln("    try { var dr = await smartAsk(systemPrompt(caUnlocked), text); if (dr !== 'IGNORE') return ctx.reply(dr); } catch (_) {}");
  ln("    return;");
  ln("  }");
  ln("  if (!isPrivate) {");
  ln("    try { var gr = await smartAsk(systemPrompt(caUnlocked), text); if (gr && gr !== 'IGNORE') return ctx.reply(gr); } catch (_) {}");
  ln("  }");
  ln("});");
  ln();
  ln("app.post('/webhook', function(req, res) { bot.handleUpdate(req.body, res); });");
  ln("app.get('/', function(req, res) { res.end('OK'); });");
  ln("app.get('/health', function(req, res) { res.end('OK'); });");
  ln();
  ln("async function registerWebhook() {");
  ln("  if (!WEBHOOK_URL) { console.log('No WEBHOOK_URL'); return; }");
  ln("  var url = WEBHOOK_URL + '/webhook';");
  ln("  for (var i = 0; i < 5; i++) {");
  ln("    try { var ok = await bot.telegram.setWebhook(url); if (ok) { console.log('Webhook set: ' + url); return; } } catch (e) { console.log('Attempt ' + (i+1) + ': ' + e.message); }");
  ln("    await new Promise(function(r) { setTimeout(r, 3000); });");
  ln("  }");
  ln("}");
  ln();
  ln("process.on('uncaughtException',  function(e) { console.error('Uncaught:', e.message); });");
  ln("process.on('unhandledRejection', function(e) { console.error('Rejection:', e && e.message); });");
  ln();
  ln("app.listen(PORT, async function() {");
  ln("  console.log('Bot starting on port ' + PORT);");
  ln("  await new Promise(function(r) { setTimeout(r, 2000); });");
  ln("  await registerWebhook();");
  ln("  resetSilence();");
  ln("  console.log('" + TICKER + " bot is live');");
  ln("});");

  return L.join('\n');
}

// ===========================================================
// FACTORY EXPRESS + STARTUP
// ===========================================================
app.post('/webhook', function(req, res) { bot.handleUpdate(req.body, res); });
app.get('/', function(req, res) { res.end('OK'); });
app.get('/health', function(req, res) { res.end('OK'); });

async function registerWebhook() {
  if (!WEBHOOK_URL) { console.log('No WEBHOOK_URL set for factory'); return; }
  var url = WEBHOOK_URL + '/webhook';
  for (var i = 0; i < 5; i++) {
    try { var ok = await bot.telegram.setWebhook(url); if (ok) { console.log('Factory webhook: ' + url); return; } } catch (e) { console.log('Webhook attempt ' + (i + 1) + ': ' + e.message); }
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
