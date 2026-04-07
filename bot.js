'use strict';
var Telegraf=require('telegraf').Telegraf;
var express=require('express');
var fs=require('fs');
var path=require('path');
var BOT_TOKEN=process.env.BOT_TOKEN;
var GITHUB_TOKEN=process.env.GITHUB_TOKEN;
var RENDER_KEY=process.env.RENDER_API_KEY;
var CRON_KEY=process.env.CRONJOB_API_KEY;
var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();
var PORT=process.env.PORT||3000;
var GH_OWNER='';
var groqPool=[];
for(var _gi=1;_gi<=10;_gi++){var _gk=process.env['GROQ_KEY_'+_gi];if(_gk)groqPool.push(_gk.trim());}
var groqIdx=0;
function nextGroqKey(){if(!groqPool.length)return '';var k=groqPool[groqIdx%groqPool.length];groqIdx++;return k;}
var E={fire:'\u{1F525}',check:'\u2705',xmark:'\u274C',gear:'\u2699\uFE0F',party:'\u{1F389}',lock:'\u{1F512}',rocket:'\u{1F680}',folder:'\u{1F4C2}',cloud:'\u2601\uFE0F',clock:'\u23F0',warn:'\u26A0\uFE0F',pencil:'\u270F\uFE0F',link:'\u{1F517}',shield:'\u{1F6E1}',robot:'\u{1F916}',chart:'\u{1F4C8}',star:'\u2B50',stats:'\u{1F4CA}',list:'\u{1F4CB}',wrench:'\u{1F527}',money:'\u{1F4B0}',gem:'\u{1F48E}',copy:'\u{1F4CB}',back:'\u{1F519}'};
var CHAIN_INFO={bsc:{label:'BNB Smart Chain (BSC)',dex:'PancakeSwap',dexUrl:'https://pancakeswap.finance/swap?outputCurrency=',chartBase:'https://dexscreener.com/bsc/',explorer:'https://bscscan.com/token/'},sol:{label:'Solana',dex:'Raydium',dexUrl:'https://raydium.io/swap/?outputMint=',chartBase:'https://dexscreener.com/solana/',explorer:'https://solscan.io/token/'}};
var bot=new Telegraf(BOT_TOKEN);
var app=express();
app.use(express.json());
var botRegistry=[];
var sessions={};
var editSessions={};
function fmtNum(n){var s=String(n).replace(/,/g,'');var p=s.split('.');p[0]=p[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');return p.join('.');}
function ensurePct(s){s=String(s).trim();return s.endsWith('%')?s:s+'%';}
function newSession(){return{step:'chain',lastBotMsgId:null,data:{chain:'bsc',mode:'full',tokenName:'',ticker:'',ca:'',supply:'',maxWalletPct:'',maxWalletTokens:'',buyTax:'',sellTax:'',twitter:'',website:'',renounced:'',locked:'',narrative:'',botToken:'',revealCmd:'revealca',hideCmd:'hideca'},imageBuffer:null};}
var STEPS=[
  {key:'chain',    ask:'<b>Step 1/15 \u2014 Chain?</b>\n\nbsc \u2014 BNB Smart Chain\nsol \u2014 Solana'},
  {key:'mode',     ask:'<b>Step 2/15 \u2014 Bot mode?</b>\n\n<b>full</b> \u2014 AI replies, silence breaker, moderation\n<b>guard</b> \u2014 moderation + hardcoded answers only (no AI)'},
  {key:'name',     ask:'<b>Step 3/15</b> \u2014 Token name?\n<i>e.g. PECKER</i>'},
  {key:'ticker',   ask:'<b>Step 4/15</b> \u2014 Ticker with $?\n<i>e.g. $PECKER</i>'},
  {key:'ca',       ask:'<b>Step 5/15</b> \u2014 Contract address?'},
  {key:'supply',   ask:'<b>Step 6/15</b> \u2014 Total supply?\n<i>e.g. 1000000000</i>'},
  {key:'maxwallet',ask:'<b>Step 7/15</b> \u2014 Max wallet % / token count?\n<i>e.g. 4.9% / 49000000 \u2014 or - to skip</i>'},
  {key:'taxes',    ask:'<b>Step 8/15</b> \u2014 Buy / sell tax?\n<i>e.g. 5/5 \u2014 or - if no tax</i>'},
  {key:'twitter',  ask:'<b>Step 9/15</b> \u2014 Twitter/X link?'},
  {key:'website',  ask:'<b>Step 10/15</b> \u2014 Website? <i>(- to skip)</i>'},
  {key:'renounced',ask:'<b>Step 11/15</b> \u2014 Contract renounced?  yes / no'},
  {key:'locked',   ask:'<b>Step 12/15</b> \u2014 LP locked?  yes / no'},
  {key:'narrative',ask:'<b>Step 13/15</b> \u2014 Token narrative / story?\n<i>What makes it unique. Used for AI personality.</i>'},
  {key:'image',    ask:'<b>Step 14/15</b> \u2014 Send bot image (JPG or PNG)\n<i>- to skip</i>'},
  {key:'bottoken', ask:'<b>Step 15/15</b> \u2014 Bot token from BotFather\n\n<i>1. Open @BotFather\n2. Send /newbot\n3. Enter name then username (must end in bot)\n4. Copy the token it gives you</i>'},
  {key:'revealcmd',ask:'Reveal-CA command? <i>(- for default: revealca)</i>'},
  {key:'hidecmd',  ask:'Hide-CA command? <i>(- for default: hideca)</i>'},
];
function stepIdx(key){return STEPS.findIndex(function(s){return s.key===key;});}
function advanceStep(s){var i=stepIdx(s.step);if(i+1<STEPS.length){s.step=STEPS[i+1].key;return STEPS[i+1];}s.step='confirm';return null;}
function prevStep(s){var i=stepIdx(s.step);var prev=Math.max(0,i-1);s.step=STEPS[prev].key;return STEPS[prev];}
function processInput(s,text){
  var d=s.data;
  switch(s.step){
    case 'chain': d.chain=(/sol/i.test(text)?'sol':'bsc'); break;
    case 'mode': d.mode=(/guard/i.test(text)?'guard':'full'); break;
    case 'name': d.tokenName=text; break;
    case 'ticker': d.ticker=text.startsWith('$')?text:'$'+text; break;
    case 'ca': d.ca=text.trim(); break;
    case 'supply': d.supply=fmtNum(text.replace(/,/g,'')); break;
    case 'maxwallet':
      if(text==='-'){d.maxWalletPct='';d.maxWalletTokens='';break;}
      var mw=text.split('/');
      d.maxWalletPct=ensurePct((mw[0]||text).trim());
      d.maxWalletTokens=mw[1]?fmtNum(mw[1].trim().replace(/,/g,'')):'';
      break;
    case 'taxes':
      if(text==='-'){d.buyTax='0';d.sellTax='0';break;}
      var tx=text.split('/');
      d.buyTax=(tx[0]||text).trim().replace('%','');
      d.sellTax=(tx[1]||tx[0]||'').trim().replace('%','');
      break;
    case 'twitter': d.twitter=text; break;
    case 'website': d.website=(text==='-'?'':text); break;
    case 'renounced': d.renounced=(/yes/i.test(text)?'RENOUNCED':'NOT RENOUNCED'); break;
    case 'locked': d.locked=(/yes/i.test(text)?'LOCKED':'NOT LOCKED'); break;
    case 'narrative': d.narrative=(text==='-'?'':text); break;
    case 'bottoken': d.botToken=text.trim(); break;
    case 'revealcmd': d.revealCmd=(text==='-'?'revealca':text.replace(/^\//,'')); break;
    case 'hidecmd': d.hideCmd=(text==='-'?'hideca':text.replace(/^\//,'')); break;
  }
}
function buildSummary(s){
  var d=s.data,ci=CHAIN_INFO[d.chain]||CHAIN_INFO.bsc;
  return E.fire+' <b>Review your bot</b>\n\n'+
    '<b>Chain:</b> '+ci.label+'\n'+
    '<b>Mode:</b> '+(d.mode==='guard'?E.shield+' Guard only':E.robot+' Full bot')+'\n'+
    '<b>Token:</b> '+d.tokenName+' '+d.ticker+'\n'+
    '<b>CA:</b> <code>'+d.ca+'</code>\n'+
    '<b>Supply:</b> '+d.supply+'\n'+
    (d.maxWalletPct?'<b>Max Wallet:</b> '+d.maxWalletPct+(d.maxWalletTokens?' / '+d.maxWalletTokens:'')+'\n':'')+
    '<b>Tax:</b> '+d.buyTax+'% buy \u2022 '+d.sellTax+'% sell\n'+
    '<b>Twitter:</b> '+d.twitter+'\n'+
    (d.website?'<b>Website:</b> '+d.website+'\n':'')+
    '<b>Contract:</b> '+d.renounced+'  <b>LP:</b> '+d.locked+'\n'+
    '<b>Image:</b> '+(s.imageBuffer?E.check+' ready':'\u2014 none')+'\n\n'+
    'Type <b>yes</b> to deploy \u2014 <b>no</b> to cancel.';
}
var backKb=function(key){return{inline_keyboard:[[{text:E.back+' Back',callback_data:'back_'+key}]]};};
bot.command('start',async function(ctx){
  return ctx.reply(
    E.rocket+' <b>Bot Factory</b>\n\n'+
    'Build full Telegram bots for your crypto project automatically.\n\n'+
    E.robot+' <b>What it does:</b>\n'+
    '\u2022 Creates GitHub repo + pushes all code\n'+
    '\u2022 Deploys to Render (free tier)\n'+
    '\u2022 Sets up cron keepalive (every 2 min)\n'+
    '\u2022 Fully working bot in ~2 minutes\n\n'+
    '<b>Commands:</b>\n'+
    '/build \u2014 Build a new bot\n'+
    '/bots \u2014 List your bots\n'+
    '/edit \u2014 Edit a bot\n'+
    '/stats \u2014 Check bot health\n'+
    '/addgroq KEY \u2014 Add Groq API key\n'+
    '/cancel \u2014 Cancel current build',
    {parse_mode:'HTML'}
  );
});
bot.command('help',function(ctx){return ctx.reply(
  '/build \u2014 Build a new bot\n/bots \u2014 Your bots\n/edit \u2014 Edit a bot\n/stats \u2014 Bot health\n/addgroq KEY \u2014 Add Groq key\n/cancel \u2014 Cancel',
  {parse_mode:'HTML'}
);});
bot.command(['build','new'],async function(ctx){
  var uid=String(ctx.from.id);
  sessions[uid]=newSession();
  var m=await ctx.reply(STEPS[0].ask,{parse_mode:'HTML'});
  sessions[uid].lastBotMsgId=m.message_id;
});
bot.command('cancel',function(ctx){delete sessions[String(ctx.from.id)];return ctx.reply(E.xmark+' Cancelled.');});
bot.command('addgroq',function(ctx){var txt=(ctx.message.text||'').replace('/addgroq','').trim();if(!txt)return ctx.reply('Usage: /addgroq KEY');groqPool.push(txt);return ctx.reply(E.check+' Groq key added. Pool: '+groqPool.length);});
bot.command('bots',async function(ctx){
  if(!botRegistry.length)return ctx.reply(E.list+' No bots yet. Use /build.');
  var msg=E.list+' <b>Your Bots</b>\n\n';
  botRegistry.forEach(function(b,i){
    msg+=(i+1)+'. '+E.rocket+' <b>'+b.ticker+'</b> ('+b.chain.toUpperCase()+')\n';
    msg+='   '+(b.mode==='guard'?E.shield:'\\u{1F916}')+' '+b.mode+' mode\n';
    msg+='   '+E.link+' '+b.url+'\n\n';
  });
  return ctx.reply(msg,{parse_mode:'HTML',disable_web_page_preview:true});
});
bot.command('stats',async function(ctx){
  if(!botRegistry.length)return ctx.reply(E.stats+' No bots to check.');
  await ctx.reply(E.stats+' Checking bots...');
  var msg=E.stats+' <b>Bot Health</b>\n\n';
  for(var i=0;i<botRegistry.length;i++){
    var b=botRegistry[i];var alive=false;
    try{var r=await Promise.race([fetch(b.url+'/health'),new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},8000)})]);alive=r&&r.ok;}catch(_){}
    msg+=(i+1)+'. <b>'+b.ticker+'</b> \u2014 '+(alive?E.check+' Online':E.xmark+' Offline')+'\n   '+b.url+'\n\n';
  }
  return ctx.reply(msg,{parse_mode:'HTML',disable_web_page_preview:true});
});
bot.command('edit',async function(ctx){
  if(!botRegistry.length)return ctx.reply(E.wrench+' No bots to edit. Use /build first.');
  var kb=botRegistry.map(function(b,i){return[{text:b.ticker+' ('+b.chain.toUpperCase()+')',callback_data:'edit_pick_'+i}];});
  return ctx.reply(E.wrench+' <b>Which bot?</b>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^back_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=String(ctx.from.id);var s=sessions[uid];if(!s)return;
  try{await ctx.deleteMessage();}catch(_){}
  var prev=prevStep(s);
  var m=await ctx.reply(prev.ask,{parse_mode:'HTML',reply_markup:stepIdx(prev.key)>0?backKb(prev.key):undefined});
  s.lastBotMsgId=m.message_id;
});
bot.action(/^edit_pick_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=String(ctx.from.id);var i=parseInt(ctx.match[1]);var b=botRegistry[i];if(!b)return;
  editSessions[uid]={botIdx:i,field:null};
  var fields=[
    [{text:'Twitter/X link',callback_data:'edit_field_twitter_'+i}],
    [{text:'Website',callback_data:'edit_field_website_'+i}],
    [{text:'Narrative',callback_data:'edit_field_narrative_'+i}],
    [{text:'Bot image',callback_data:'edit_field_image_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'edit_cancel'}],
  ];
  return ctx.reply(E.wrench+' <b>Edit '+b.ticker+'</b>\nWhat to change?',{parse_mode:'HTML',reply_markup:{inline_keyboard:fields}});
});
bot.action(/^edit_field_(\w+)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=String(ctx.from.id);var field=ctx.match[1],i=parseInt(ctx.match[2]);
  editSessions[uid]={botIdx:i,field:field};
  var asks={twitter:'Send new Twitter/X link:',website:'Send new website (- to remove):',narrative:'Send new token narrative:',image:'Send new bot image (photo):'};
  return ctx.reply(asks[field]||'Send new value:');
});
bot.action('edit_cancel',async function(ctx){await ctx.answerCbQuery();delete editSessions[String(ctx.from.id)];return ctx.reply(E.xmark+' Cancelled.');});
bot.on('photo',async function(ctx){
  var uid=String(ctx.from.id);var es=editSessions[uid];var s=sessions[uid];
  var ph=ctx.message.photo[ctx.message.photo.length-1];
  var buf;
  try{var lnk=await ctx.telegram.getFileLink(ph.file_id);var rb=await fetch(lnk.href);var ab=await rb.arrayBuffer();buf=Buffer.from(ab);}catch(e){return ctx.reply(E.xmark+' Image error: '+e.message);}
  if(es&&es.field==='image'){
    var b=botRegistry[es.botIdx];if(!b)return;
    await ctx.reply(E.gear+' Updating image...');
    try{await githubPushFileUpdate(b.ghOwner,b.repoName,'siren.jpg',buf);delete editSessions[uid];return ctx.reply(E.check+' Image updated! Render redeploys in ~1 min.');}
    catch(e){delete editSessions[uid];return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  if(!s||s.step!=='image')return;
  try{await ctx.deleteMessage();}catch(_){}
  if(s.lastBotMsgId){try{await ctx.telegram.deleteMessage(ctx.chat.id,s.lastBotMsgId);}catch(_){}s.lastBotMsgId=null;}
  s.imageBuffer=buf;
  var nxt=advanceStep(s);
  if(s.step==='confirm'){var m=await ctx.reply(buildSummary(s),{parse_mode:'HTML'});s.lastBotMsgId=m.message_id;return;}
  var m2=await ctx.reply(E.check+' Image saved!\n\n'+nxt.ask,{parse_mode:'HTML',reply_markup:stepIdx(nxt.key)>0?backKb(nxt.key):undefined});
  s.lastBotMsgId=m2.message_id;
});
bot.on('document',async function(ctx){
  var uid=String(ctx.from.id);var s=sessions[uid];if(!s||s.step!=='image')return;
  var doc=ctx.message.document;if(!doc.mime_type||!doc.mime_type.startsWith('image/'))return ctx.reply('Please send a JPG or PNG image, or type - to skip.');
  try{await ctx.deleteMessage();}catch(_){}
  if(s.lastBotMsgId){try{await ctx.telegram.deleteMessage(ctx.chat.id,s.lastBotMsgId);}catch(_){}s.lastBotMsgId=null;}
  try{var lnk=await ctx.telegram.getFileLink(doc.file_id);var rb=await fetch(lnk.href);var ab=await rb.arrayBuffer();s.imageBuffer=Buffer.from(ab);}catch(e){return ctx.reply(E.xmark+' Image error: '+e.message);}
  var nxt=advanceStep(s);
  if(s.step==='confirm'){var m=await ctx.reply(buildSummary(s),{parse_mode:'HTML'});s.lastBotMsgId=m.message_id;return;}
  var m2=await ctx.reply(E.check+' Image saved!\n\n'+nxt.ask,{parse_mode:'HTML',reply_markup:stepIdx(nxt.key)>0?backKb(nxt.key):undefined});
  s.lastBotMsgId=m2.message_id;
});
bot.on('text',async function(ctx){
  var uid=String(ctx.from.id);var text=(ctx.message.text||'').trim();
  if(text.startsWith('/'))return;
  var es=editSessions[uid];
  if(es&&es.field&&es.field!=='image'){
    try{await ctx.deleteMessage();}catch(_){}
    var b=botRegistry[es.botIdx];if(!b){delete editSessions[uid];return;}
    await ctx.reply(E.gear+' Updating...');
    b.data[es.field]=(text==='-'?'':text);
    var newCode=b.mode==='guard'?generateGuardBotJs(b.data,CHAIN_INFO[b.chain]||CHAIN_INFO.bsc):generateFullBotJs(b.data,CHAIN_INFO[b.chain]||CHAIN_INFO.bsc);
    try{await githubPushFileUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(newCode));saveRegistry();delete editSessions[uid];return ctx.reply(E.check+' <b>'+b.ticker+'</b> updated! Render redeploys in ~1 min.',{parse_mode:'HTML'});}
    catch(e){delete editSessions[uid];return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  var s=sessions[uid];
  if(!s)return ctx.reply('Use /build to start, or /help for commands.');
  try{await ctx.deleteMessage();}catch(_){}
  if(s.lastBotMsgId){try{await ctx.telegram.deleteMessage(ctx.chat.id,s.lastBotMsgId);}catch(_){}s.lastBotMsgId=null;}
  if(s.step==='image'){
    if(text==='-'){s.imageBuffer=null;var nxt=advanceStep(s);if(s.step==='confirm'){var m=await ctx.reply(buildSummary(s),{parse_mode:'HTML'});s.lastBotMsgId=m.message_id;return;}var m2=await ctx.reply(nxt.ask,{parse_mode:'HTML',reply_markup:stepIdx(nxt.key)>0?backKb(nxt.key):undefined});s.lastBotMsgId=m2.message_id;return;}
    return ctx.reply('Send an image file or type <b>-</b> to skip.',{parse_mode:'HTML'});
  }
  if(s.step==='confirm'){
    if(/^yes$/i.test(text))return runBuild(ctx,s,uid);
    delete sessions[uid];return ctx.reply(E.xmark+' Cancelled.');
  }
  processInput(s,text);
  var nxt=advanceStep(s);
  if(s.step==='confirm'){var m=await ctx.reply(buildSummary(s),{parse_mode:'HTML'});s.lastBotMsgId=m.message_id;return;}
  var m3=await ctx.reply(nxt.ask,{parse_mode:'HTML',reply_markup:stepIdx(nxt.key)>0?backKb(nxt.key):undefined});
  s.lastBotMsgId=m3.message_id;
});
async function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function rndStr(n){var c='abcdefghijklmnopqrstuvwxyz0123456789',o='';for(var i=0;i<n;i++)o+=c[Math.floor(Math.random()*c.length)];return o;}
function saveRegistry(){
  var safe=botRegistry.map(function(b){
    var copy=JSON.parse(JSON.stringify(b));
    if(copy.data){delete copy.data.botToken;delete copy.data.revealCmd;delete copy.data.hideCmd;}
    delete copy.serviceId;
    return copy;
  });
  var json=JSON.stringify(safe,null,2);
  if(GH_OWNER)githubPushFileUpdate(GH_OWNER,'bot-factory','bots.json',Buffer.from(json)).catch(function(e){console.log('Registry:',e.message);});
}
async function loadRegistry(){if(!GH_OWNER)return;try{var r=await fetch('https://api.github.com/repos/'+GH_OWNER+'/bot-factory/contents/bots.json',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});if(r.ok){var d=await r.json();if(d.content){botRegistry=JSON.parse(Buffer.from(d.content,'base64').toString('utf8'));console.log('Registry:',botRegistry.length,'bots');}}}catch(e){console.log('Registry load:',e.message);}}
async function runBuild(ctx,s,uid){
  var d=s.data,ci=CHAIN_INFO[d.chain]||CHAIN_INFO.bsc;
  var groqKey=d.mode==='full'?nextGroqKey():'';
  if(d.mode==='full'&&!groqKey)return ctx.reply(E.xmark+' No Groq key. Use /addgroq KEY first.');
  var repoName=d.ticker.replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+'-bot-'+rndStr(4);
  var guessUrl='https://'+repoName+'.onrender.com';
  await ctx.reply(E.gear+' Deploying <b>'+d.ticker+'</b>...',{parse_mode:'HTML'});
  var ghOwner='',serviceId='',actualUrl=guessUrl;
  var steps=[
    {name:'GitHub repo',fn:async function(){
      var g=await githubCreateRepo(repoName);
      ghOwner=g.full_name.split('/')[0];GH_OWNER=GH_OWNER||ghOwner;
      await sleep(4000);
      var botCode=d.mode==='guard'?generateGuardBotJs(d,ci):generateFullBotJs(d,ci);
      await githubPushFileWithRetry(ghOwner,repoName,'bot.js',Buffer.from(botCode));
      await githubPushFileWithRetry(ghOwner,repoName,'package.json',Buffer.from(generatePackageJson(d.tokenName,d.mode)));
      if(s.imageBuffer)await githubPushFileWithRetry(ghOwner,repoName,'siren.jpg',s.imageBuffer);
    }},
    {name:'Render service',fn:async function(){
      var ownerId=await renderGetOwnerId();
      var envVars=[{key:'BOT_TOKEN',value:d.botToken},{key:'WEBHOOK_URL',value:guessUrl}];
      if(d.mode==='full')envVars.push({key:'GROQ_API_KEY',value:groqKey});
      var svc=await renderCreateService(repoName,ghOwner,ownerId,envVars);
      serviceId=svc.id;
      actualUrl=(svc.serviceDetails&&svc.serviceDetails.url)?svc.serviceDetails.url:guessUrl;
      if(actualUrl!==guessUrl){var uv=envVars.map(function(v){return v.key==='WEBHOOK_URL'?{key:'WEBHOOK_URL',value:actualUrl}:v;});await renderSetEnvVars(serviceId,uv);}
    }},
    {name:'Cron keepalive',fn:async function(){await cronCreateJob(repoName,actualUrl+'/health');}},
  ];
  var failed=false;
  for(var i=0;i<steps.length;i++){
    var st=steps[i];
    try{await st.fn();await ctx.reply(E.check+' '+st.name+' done');}
    catch(e){await ctx.reply(E.xmark+' <b>'+d.ticker+'</b>: '+st.name+' failed\n<code>'+e.message.slice(0,300)+'</code>\n\nUse /build to retry.',{parse_mode:'HTML'});failed=true;break;}
  }
  if(!failed){
    var safeData=JSON.parse(JSON.stringify(d));
    delete safeData.botToken;
    botRegistry.push({ticker:d.ticker,chain:d.chain,mode:d.mode,repoName:repoName,ghOwner:ghOwner,url:actualUrl,data:safeData,builtAt:Date.now()});
    saveRegistry();delete sessions[uid];
    await ctx.reply(E.party+' <b>'+d.ticker+' is live!</b>\n\n'+E.link+' '+actualUrl+'\n'+E.folder+' github.com/'+ghOwner+'/'+repoName+'\n\n<b>Next:</b>\n1. Wait 3-5 min for Render to build\n2. Add bot to your Telegram group\n3. Make it admin (delete/ban/restrict)\n4. /'+d.revealCmd+' to reveal CA',{parse_mode:'HTML'});
  }else{delete sessions[uid];}
}
async function githubCreateRepo(name){var r=await fetch('https://api.github.com/user/repos',{method:'POST',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({name:name,private:false,auto_init:false})});var d=await r.json();if(!d.full_name)throw new Error('Repo create failed: '+JSON.stringify(d).slice(0,200));return d;}
async function githubPushFileWithRetry(owner,repo,filename,content){var lastErr;for(var a=0;a<5;a++){if(a>0)await sleep(5000);try{var r=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+filename,{method:'PUT',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({message:'Add '+filename,content:content.toString('base64')})});var d=await r.json();if(d.content||d.commit)return d;lastErr=new Error('Push failed '+filename+': '+JSON.stringify(d).slice(0,200));}catch(e){lastErr=e;}}throw lastErr;}
async function githubPushFileUpdate(owner,repo,filename,content){var sha='';try{var rg=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+filename,{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});var dg=await rg.json();sha=dg.sha||'';}catch(_){}var body={message:'Update '+filename,content:content.toString('base64')};if(sha)body.sha=sha;var r=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+filename,{method:'PUT',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify(body)});var d=await r.json();if(!d.content&&!d.commit)throw new Error('Update failed: '+JSON.stringify(d).slice(0,200));return d;}
async function renderGetOwnerId(){var r=await fetch('https://api.render.com/v1/owners?limit=1',{headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json'}});var d=await r.json();if(!Array.isArray(d)||!d[0])throw new Error('Render owner failed: '+JSON.stringify(d).slice(0,200));return d[0].owner?d[0].owner.id:d[0].id;}
async function renderCreateService(name,ghOwner,ownerId,envVars){var r=await fetch('https://api.render.com/v1/services',{method:'POST',headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({autoDeploy:'yes',branch:'main',name:name,ownerId:ownerId,repo:'https://github.com/'+ghOwner+'/'+name,type:'web_service',envVars:envVars||[],serviceDetails:{runtime:'node',plan:'free',region:'oregon',numInstances:1,envSpecificDetails:{buildCommand:'npm install',startCommand:'npm start'}}})});var d=await r.json();var svc=d.service||d;if(!svc.id)throw new Error('Render create failed: '+JSON.stringify(d).slice(0,400));return svc;}
async function renderSetEnvVars(serviceId,vars){await fetch('https://api.render.com/v1/services/'+serviceId+'/env-vars',{method:'PUT',headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify(vars)});}
async function cronCreateJob(name,url){await fetch('https://api.cron-job.org/jobs',{method:'PUT',headers:{'Authorization':'Bearer '+CRON_KEY,'Content-Type':'application/json'},body:JSON.stringify({job:{url:url,title:name+' keepalive',enabled:true,saveResponses:false,schedule:{timezone:'UTC',hours:[-1],mdays:[-1],months:[-1],wdays:[-1],minutes:[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50,52,54,56,58]}}})});}
function generatePackageJson(tokenName,mode){var deps={telegraf:'^4.16.3',express:'^4.18.2'};if(mode==='full')deps['groq-sdk']='^0.3.3';return JSON.stringify({name:tokenName.toLowerCase().replace(/[^a-z0-9]/g,'-')+'-bot',version:'1.0.0',main:'bot.js',scripts:{start:'node bot.js'},dependencies:deps,engines:{node:'>=18.0.0'}},null,2);}
function generateGuardBotJs(d,ci){
  var TICKER=d.ticker,NAME=d.tokenName,CA=d.ca,SUPPLY=d.supply;
  var MAX_PCT=d.maxWalletPct||'N/A',MAX_TOK=d.maxWalletTokens||'';
  var BUY_TAX=d.buyTax,SELL_TAX=d.sellTax;
  var TWITTER=d.twitter,WEBSITE=d.website||'';
  var RENOUNCED=d.renounced,LOCKED=d.locked;
  var REVEAL=(d.revealCmd||'revealca').replace(/^\//,'');
  var HIDE=(d.hideCmd||'hideca').replace(/^\//,'');
  var CHART_URL=ci.chartBase+CA,BUY_URL=ci.dexUrl+CA,DEX_NAME=ci.dex,CHAIN_LBL=ci.label;
  var L=[];
  function ln(s){L.push(s===undefined?'':s);}
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
  ln("var E={lock:'\\u{1F512}',check:'\\u2705',copy:'\\u{1F4CB}',chart:'\\u{1F4C8}',money:'\\u{1F4B0}',gem:'\\u{1F48E}',shield:'\\u{1F6E1}',wave:'\\u{1F44B}'};");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("app.use(express.json());");
  ln("var caUnlocked=false,groupChatId=null;");
  ln("var imageMessages=new Map(),strikes=new Map(),spamTracker=new Map(),stickerTracker=new Map();");
  ln("var IMG=path.join(__dirname,'siren.jpg');");
  ln("var STRIKE_RESET=86400000,SPAM_WINDOW=60000,SPAM_MAX=5;");
  ln("async function deletePrevImage(chatId){var mid=imageMessages.get(chatId);if(mid){try{await bot.telegram.deleteMessage(chatId,mid);}catch(_){}imageMessages.delete(chatId);}}");
  ln("async function sendImage(chatId,caption,extra){await deletePrevImage(chatId);extra=extra||{};if(fs.existsSync(IMG)){try{var buf=fs.readFileSync(IMG);var m=await bot.telegram.sendPhoto(chatId,{source:buf},Object.assign({caption:caption,parse_mode:'HTML'},extra));imageMessages.set(chatId,m.message_id);return m;}catch(e){console.error('img:',e.message);}}return bot.telegram.sendMessage(chatId,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(chatId,msgId,delay){setTimeout(function(){try{bot.telegram.deleteMessage(chatId,msgId);}catch(_){}},delay);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid){var s=getStrike(uid);s.count++;try{await ctx.deleteMessage();}catch(_){}if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F Muted 5 min (3 strikes).');autoDelete(ctx.chat.id,m3.message_id,12000);}else{var m=await ctx.reply('\\u26A0\\uFE0F Warning '+s.count+'/3');autoDelete(ctx.chat.id,m.message_id,10000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{count:0,since:now};if(now-t.since>SPAM_WINDOW)t={count:0,since:now};t.count++;spamTracker.set(uid,t);if(t.count>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard','asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash','garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("function hasBlockedLink(t){var u=t.match(/https?:\\/\\/[^\\s]+/g)||[];return u.some(function(x){return!x.includes('x.com')&&!x.includes('twitter.com');});}");
  ln("function hasExtMention(t){return/@[a-zA-Z0-9_]+/.test(t);}");
  ln("var notLiveMsgs=['" + TICKER + " hasn\\u2019t launched yet. CA coming soon.','Hold tight \\u2014 launch is close.','Not yet. Stay ready.','CA drops soon.'];");
  ln("var socialsIdx=0;");
  ln("function buildSocialsMsg(){var i=socialsIdx%3;socialsIdx++;var web=WEBSITE?'\\n\\u{1F310} <a href=\\''+WEBSITE+'\\'>Website</a>':'';if(i===0)return'<b>" + TICKER + " Links</b>\\n\\n<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+web;if(i===1)return E.chart+' <a href=\\''+CHART+'\\'>Chart</a>  '+E.money+' <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>Twitter/X</a>'+web;return'<a href=\\''+CHART+'\\'>DexScreener</a>  <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>X</a>'+(WEBSITE?' <a href=\\''+WEBSITE+'\\'>Site</a>':'');}");
  ln("function buildInfoReply(topic){");
  ln("  if(topic==='ca'){if(!caUnlocked)return{text:notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)],kb:null};return{text:CA+'\\n\\n'+E.lock+' " + RENOUNCED + " '+E.check+' LP " + LOCKED + "',kb:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}};}");
  ln("  if(topic==='x')return{text:TWITTER,kb:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}};");
  ln("  if(topic==='tax')return{text:'" + TICKER + " Tax: Buy " + BUY_TAX + "% \\u2022 Sell " + SELL_TAX + "%',kb:null};");
  ln("  if(topic==='maxwallet')return{text:'Max Wallet: " + MAX_PCT + (MAX_TOK?' ('+MAX_TOK+')':'') + "\\nAnti-whale cap \\u2014 no wallet can hold more.',kb:null};");
  ln("  if(topic==='renounced')return{text:'Contract: " + RENOUNCED + "\\nPermanently locked. Nobody can alter it.',kb:null};");
  ln("  if(topic==='locked')return{text:'LP: " + LOCKED + "\\nLiquidity is fully secured.',kb:null};");
  ln("  if(topic==='supply')return{text:'Total Supply: " + SUPPLY + "',kb:null};");
  ln("  if(topic==='socials')return{text:buildSocialsMsg(),kb:null};");
  ln("  return null;");
  ln("}");
  ln("function detectTopic(lower){if(['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca','show ca'].some(function(w){return lower===w||lower.includes(w);}))return 'ca';if(lower==='x'||lower==='twitter'||lower.includes('twitter link')||lower.includes('follow on'))return 'x';if(lower.includes('tax')||lower.includes('buy tax')||lower.includes('sell tax'))return 'tax';if(lower.includes('max wallet')||lower.includes('maxwallet')||lower.includes('max hold'))return 'maxwallet';if(lower.includes('renounced')||lower.includes('contract lock'))return 'renounced';if(lower.includes(' lp ')||lower.includes('liquidity')||lower.includes('lp locked')||lower==='lp')return 'locked';if(lower.includes('supply')||lower.includes('total supply'))return 'supply';if(lower==='socials'||lower==='links'||lower.includes('website'))return 'socials';return null;}");
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}");
  ln("  for(var i=0;i<ctx.message.new_chat_members.length;i++){");
  ln("    var mem=ctx.message.new_chat_members[i];");
  ln("    var handle=mem.username?'@'+mem.username:mem.first_name;");
  ln("    var opts=[");
  ln("      handle+' just joined " + TICKER + ".\\n" + RENOUNCED + " \\u2022 LP " + LOCKED + " \\u2022 " + BUY_TAX + "%/" + SELL_TAX + "% tax\\n'+(caUnlocked?CA:'CA coming soon \\u2014 stay close.'),");
  ln("      'Welcome, '+handle+'.\\n" + TICKER + " \\u2022 " + CHAIN_LBL + " \\u2022 " + RENOUNCED + " \\u2022 LP " + LOCKED + "\\n'+(caUnlocked?'CA: '+CA:'Launch incoming.'),");
  ln("      handle+' joined the " + TICKER + " community.\\n" + BUY_TAX + "%/" + SELL_TAX + "% tax \\u2022 LP " + LOCKED + " \\u2022 " + RENOUNCED + "\\n'+(caUnlocked?CA:'CA reveals soon.'),");
  ln("    ];");
  ln("    var msg=opts[Math.floor(Math.random()*opts.length)];");
  ln("    var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);");
  ln("  }");
  ln("});");
  ln("bot.on('sticker',async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);var cnt=(stickerTracker.get(uid)||0)+1;stickerTracker.set(uid,cnt);if(cnt>3){try{await ctx.deleteMessage();}catch(_){}}});");
  ln("bot.on(['photo','video','document','audio','voice'],async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);});");
  ln("bot.command('ca',async function(ctx){var r=buildInfoReply('ca');if(r.kb)return sendImage(ctx.chat.id,r.text,{reply_markup:r.kb});return ctx.reply(r.text,{parse_mode:'HTML'});});");
  ln("bot.command('x',function(ctx){var r=buildInfoReply('x');return ctx.reply(r.text,{reply_markup:r.kb,parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('twitter',function(ctx){var r=buildInfoReply('x');return ctx.reply(r.text,{reply_markup:r.kb,parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('tax',function(ctx){return ctx.reply(buildInfoReply('tax').text);});");
  ln("bot.command('info',function(ctx){return ctx.reply('<b>" + TICKER + "</b>\\nChain: " + CHAIN_LBL + "\\nSupply: " + SUPPLY + "\\nMax Wallet: " + MAX_PCT + (MAX_TOK ? ' / ' + MAX_TOK : '') + "\\nBuy Tax: " + BUY_TAX + "% | Sell Tax: " + SELL_TAX + "%\\nContract: " + RENOUNCED + "\\nLP: " + LOCKED + "',{parse_mode:'HTML'});});");
  ln("bot.command('socials',function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('" + REVEAL + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('" + HIDE + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;return ctx.reply('CA is now HIDDEN.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.on('message',async function(ctx){var msg=ctx.message;if(!msg||!ctx.from)return;var uid=ctx.from.id,chatType=ctx.chat.type;var text=(msg.text||'').trim();var isPrivate=chatType==='private';if(!isPrivate&&groupChatId!==ctx.chat.id)groupChatId=ctx.chat.id;var admin=await isAdmin(ctx,uid);if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;stickerTracker.set(uid,0);if(msg.forward_from||msg.forward_sender_name||msg.forward_from_chat)return applyStrike(ctx,uid);if(hasBlockedLink(text))return applyStrike(ctx,uid);if(hasExtMention(text))return applyStrike(ctx,uid);if(hasFud(text))return applyStrike(ctx,uid);}if(!text)return;var lower=text.toLowerCase();var topic=detectTopic(lower);if(topic){var r=buildInfoReply(topic);if(r){if(topic==='ca')return sendImage(ctx.chat.id,r.text,r.kb?{reply_markup:r.kb}:{});return ctx.reply(r.text,Object.assign({parse_mode:'HTML',disable_web_page_preview:true},r.kb?{reply_markup:r.kb}:{}));}}});");
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function registerWebhook(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Webhook: '+url);return;}}catch(e){console.log('Attempt '+(i+1)+': '+e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('" + TICKER + " guard bot on port '+PORT);await new Promise(function(r){setTimeout(r,2000);});await registerWebhook();setInterval(function(){if(WEBHOOK_URL)fetch(WEBHOOK_URL+'/health').catch(function(){});},4*60*1000);console.log('" + TICKER + " guard bot live');});");
  return L.join('\n');
}
function generateFullBotJs(d,ci){
  var NAME=d.tokenName,TICKER=d.ticker,CA=d.ca,SUPPLY=d.supply;
  var MAX_PCT=d.maxWalletPct||'N/A',MAX_TOK=d.maxWalletTokens||'';
  var BUY_TAX=d.buyTax,SELL_TAX=d.sellTax;
  var TWITTER=d.twitter,WEBSITE=d.website||'';
  var RENOUNCED=d.renounced,LOCKED=d.locked;
  var NARR=JSON.stringify(d.narrative||'');
  var REVEAL=(d.revealCmd||'revealca').replace(/^\//,'');
  var HIDE=(d.hideCmd||'hideca').replace(/^\//,'');
  var CHAIN_LBL=ci.label,DEX_NAME=ci.dex;
  var CHART_URL=ci.chartBase+CA,BUY_URL=ci.dexUrl+CA;
  var L=[];
  function ln(s){L.push(s===undefined?'':s);}
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
  ln("var E={rocket:'\\u{1F680}',fire:'\\u{1F525}',chart:'\\u{1F4C8}',lock:'\\u{1F512}',check:'\\u2705',zap:'\\u26A1',gem:'\\u{1F48E}',star:'\\u2B50',money:'\\u{1F4B0}',shield:'\\u{1F6E1}',wave:'\\u{1F44B}',dash:'\\u2014',copy:'\\u{1F4CB}'};");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("var groq=new Groq({apiKey:GROQ_API_KEY});");
  ln("app.use(express.json());");
  ln("var caUnlocked=false,groupChatId=null,silenceTimer=null;");
  ln("var imageMessages=new Map(),strikes=new Map(),spamTracker=new Map(),stickerTracker=new Map();");
  ln("var lastReplies=[],MAX_REPLY_HIST=12;");
  ln("var IMG=path.join(__dirname,'siren.jpg');");
  ln("var SILENCE_DELAY=10*60*1000,STRIKE_RESET=86400000,SPAM_WINDOW=60000,SPAM_MAX=5;");
  // Build system prompt as JS function that concatenates facts - no escaping issues
  ln("function systemPrompt(withCa){");
  ln("  var facts=[");
  ln("    'You are the community bot for " + TICKER + ", a " + CHAIN_LBL + " meme token.',");
  ln("    'Token: " + NAME + " (" + TICKER + ") | Chain: " + CHAIN_LBL + "',");
  ln("    'Supply: " + SUPPLY + " | Max Wallet: " + MAX_PCT + (MAX_TOK?" ("+MAX_TOK+")":"") + "',");
  ln("    'Tax: " + BUY_TAX + "% buy / " + SELL_TAX + "% sell',");
  ln("    'Contract: " + RENOUNCED + " | LP: " + LOCKED + "',");
  ln("    'Dev is ACTIVE. Never say or imply otherwise.',");
  ln("    'Twitter: '+TWITTER,");
  ln("  ];");
  ln("  if(withCa)facts.push('CA: '+CA+' | Chart: '+CHART+' | Buy on " + DEX_NAME + ": '+BUY);");
  ln("  var s=facts.join('\\n')+'\\n';");
  ln("  s+='\\nNARRATIVE: '+" + NARR + "+'\\n';");
  ln("  s+='RULES: Max 2 lines per reply. Sharp and direct. Vary every reply. Never robotic. NEVER share TG group link. NEVER put emoji on same line as CA. NEVER repeat reply. If hype/casual chat/no real question: reply with exactly IGNORE';");
  ln("  return s;");
  ln("}");
  ln("async function askGroq(sys,msg){var r=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',temperature:1.0,max_tokens:120,messages:[{role:'system',content:sys},{role:'user',content:msg}]});return r.choices[0].message.content.trim();}");
  ln("function isDupe(r){return lastReplies.includes(r);}");
  ln("function recordReply(r){lastReplies.push(r);if(lastReplies.length>MAX_REPLY_HIST)lastReplies.shift();}");
  ln("async function smartAsk(sys,p){var r=await askGroq(sys,p);if(isDupe(r))r=await askGroq(sys,p+' Completely different from before.');recordReply(r);return r;}");
  ln("async function deletePrevImage(chatId){var mid=imageMessages.get(chatId);if(mid){try{await bot.telegram.deleteMessage(chatId,mid);}catch(_){}imageMessages.delete(chatId);}}");
  ln("async function sendImage(chatId,caption,extra){await deletePrevImage(chatId);extra=extra||{};if(fs.existsSync(IMG)){try{var buf=fs.readFileSync(IMG);var m=await bot.telegram.sendPhoto(chatId,{source:buf},Object.assign({caption:caption,parse_mode:'HTML'},extra));imageMessages.set(chatId,m.message_id);return m;}catch(e){console.error('img:',e.message);}}return bot.telegram.sendMessage(chatId,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(chatId,msgId,delay){setTimeout(function(){try{bot.telegram.deleteMessage(chatId,msgId);}catch(_){}},delay);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid){var s=getStrike(uid);s.count++;try{await ctx.deleteMessage();}catch(_){}if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F Muted 5 min (3 strikes).');autoDelete(ctx.chat.id,m3.message_id,12000);}else{var m=await ctx.reply('\\u26A0\\uFE0F Warning '+s.count+'/3');autoDelete(ctx.chat.id,m.message_id,10000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{count:0,since:now};if(now-t.since>SPAM_WINDOW)t={count:0,since:now};t.count++;spamTracker.set(uid,t);if(t.count>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','shit','fuck','bitch','bastard','asshole','cunt','retard','idiot','dump','dumping','dead','worthless','trash','garbage','fake','fraud','exit scam','dev ran','dev is gone','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("function hasBlockedLink(t){var u=t.match(/https?:\\/\\/[^\\s]+/g)||[];return u.some(function(x){return!x.includes('x.com')&&!x.includes('twitter.com');});}");
  ln("function hasExtMention(t){return/@[a-zA-Z0-9_]+/.test(t);}");
  ln("var notLiveMsgs=['" + TICKER + " hasn\\u2019t launched yet. CA coming soon.','Hold tight \\u2014 the drop is close.','Not yet. Stay ready.','CA drops soon.'];");
  ln("var caPrompts=['2 sharp lines. Why " + TICKER + " right now. No CA.','2 lines. " + TICKER + " fundamentals: renounced, locked LP. No CA.','2 lines. Early opportunity in " + TICKER + ". No CA.','2 lines. What makes " + TICKER + " worth holding. No CA.','2 lines. " + TICKER + " built for the long game. No CA.'];");
  ln("var caPromptIdx=0;");
  ln("async function buildCaCaption(){var p=caPrompts[caPromptIdx%caPrompts.length];caPromptIdx++;var ai=await smartAsk(systemPrompt(true),p);return ai+'\\n\\n'+CA+'\\n\\n'+E.lock+' " + RENOUNCED + " '+E.check+' LP " + LOCKED + "';}");
  ln("var xPrompts=['1 line. " + TICKER + " on Twitter. Real energy. No hashtags.','1 sharp line. Follow " + TICKER + " on X.','1 line. " + TICKER + " Twitter is worth following.','1 line. Why " + TICKER + " X matters right now.'];");
  ln("var xPromptIdx=0;");
  ln("async function buildXCaption(){var p=xPrompts[xPromptIdx%xPrompts.length];xPromptIdx++;var ai=await smartAsk(systemPrompt(false),p);return ai+'\\n\\n'+TWITTER;}");
  ln("var socialsIdx=0;");
  ln("function buildSocialsMsg(){var i=socialsIdx%3;socialsIdx++;var web=WEBSITE?'\\n\\u{1F310} <a href=\\''+WEBSITE+'\\'>Website</a>':'';if(i===0)return'<b>" + TICKER + "</b>\\n<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+web;if(i===1)return E.chart+' <a href=\\''+CHART+'\\'>Chart</a>  '+E.money+' <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>Twitter/X</a>'+web;return'<a href=\\''+CHART+'\\'>DexScreener</a>  <a href=\\''+BUY+'\\'>" + DEX_NAME + "</a>  <a href=\\''+TWITTER+'\\'>X</a>'+(WEBSITE?' <a href=\\''+WEBSITE+'\\'>Site</a>':'');}");
  ln("var silenceAngles=['2-3 lines. Why hold " + TICKER + " now.','2-3 lines. Being early to " + TICKER + ".','2-3 lines. " + TICKER + " built clean: renounced, locked, low tax.','2-3 lines. What " + TICKER + " holders know that others don\\u2019t.','2-3 lines. " + TICKER + " community is building quietly.','2-3 lines. The move in " + TICKER + " is still early.'];");
  ln("var silenceIdx=0;");
  ln("async function fireSilenceBreaker(){if(!groupChatId){resetSilence();return;}try{var p=silenceAngles[silenceIdx%silenceAngles.length];silenceIdx++;var cap=await smartAsk(systemPrompt(caUnlocked),p);await sendImage(groupChatId,cap,{});}catch(_){}resetSilence();}");
  ln("function resetSilence(){if(silenceTimer)clearTimeout(silenceTimer);silenceTimer=setTimeout(fireSilenceBreaker,SILENCE_DELAY);}");
  // Welcome - tags by @username, 3 rotating hardcoded lines, fast
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}");
  ln("  for(var i=0;i<ctx.message.new_chat_members.length;i++){");
  ln("    var mem=ctx.message.new_chat_members[i];");
  ln("    var handle=mem.username?'@'+mem.username:mem.first_name;");
  ln("    var opts=[");
  ln("      handle+' just joined " + TICKER + ".\\n" + RENOUNCED + " \\u2022 LP " + LOCKED + " \\u2022 " + BUY_TAX + "%/" + SELL_TAX + "% tax\\n'+(caUnlocked?CA:'CA coming soon \\u2014 stay close.'),");
  ln("      'Glad you\\u2019re here, '+handle+'.\\n" + TICKER + " \\u2022 " + CHAIN_LBL + " \\u2022 " + RENOUNCED + " \\u2022 LP " + LOCKED + "\\n'+(caUnlocked?'CA: '+CA:'Launch incoming.'),");
  ln("      handle+' joined the " + TICKER + " community.\\n" + BUY_TAX + "%/" + SELL_TAX + "% tax \\u2022 LP " + LOCKED + " \\u2022 " + RENOUNCED + "\\n'+(caUnlocked?CA:'CA reveals soon.'),");
  ln("    ];");
  ln("    var msg=opts[Math.floor(Math.random()*opts.length)];");
  ln("    var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);");
  ln("  }");
  ln("});");
  ln("bot.on('sticker',async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);var cnt=(stickerTracker.get(uid)||0)+1;stickerTracker.set(uid,cnt);if(cnt>3){try{await ctx.deleteMessage();}catch(_){}}});");
  ln("bot.on(['photo','video','document','audio','voice'],async function(ctx){var uid=ctx.from.id;var admin=await isAdmin(ctx,uid);if(admin)return;if(ctx.message.forward_from||ctx.message.forward_sender_name||ctx.message.forward_from_chat)return applyStrike(ctx,uid);});");
  ln("async function sendXReply(ctx){try{var cap=await buildXCaption();await sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});}catch(_){await ctx.reply(TWITTER);}}");
  ln("bot.command('x',function(ctx){return sendXReply(ctx);});");
  ln("bot.command('twitter',function(ctx){return sendXReply(ctx);});");
  ln("bot.command('ca',async function(ctx){if(!caUnlocked)return ctx.reply(notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)]);try{var cap=await buildCaCaption();return sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}});}catch(_){return ctx.reply(CA);}});");
  ln("bot.command('socials',async function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',async function(ctx){return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('" + REVEAL + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('" + HIDE + "',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;return ctx.reply('CA is now HIDDEN.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.on('message',async function(ctx){var msg=ctx.message;if(!msg||!ctx.from)return;var uid=ctx.from.id,chatType=ctx.chat.type;var text=(msg.text||'').trim();var isPrivate=chatType==='private';if(!isPrivate&&groupChatId!==ctx.chat.id)groupChatId=ctx.chat.id;if(!isPrivate)resetSilence();var admin=await isAdmin(ctx,uid);if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;stickerTracker.set(uid,0);if(msg.forward_from||msg.forward_sender_name||msg.forward_from_chat)return applyStrike(ctx,uid);if(hasBlockedLink(text))return applyStrike(ctx,uid);if(hasExtMention(text))return applyStrike(ctx,uid);if(hasFud(text))return applyStrike(ctx,uid);}if(!text)return;var lower=text.toLowerCase();var caWords=['ca','contract','contract address','token address','where is the ca','whats the ca','what is the ca','give ca','drop ca','show ca'];if(caWords.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(notLiveMsgs[Math.floor(Math.random()*notLiveMsgs.length)]);try{var cap=await buildCaCaption();return sendImage(ctx.chat.id,cap,{reply_markup:{inline_keyboard:[[{text:E.copy+' Copy CA',copy_text:{text:CA}}]]}});}catch(_){return ctx.reply(CA);}}if(lower==='x'||lower==='twitter')return sendXReply(ctx);if(lower==='socials'||lower==='links')return ctx.reply(buildSocialsMsg(),{parse_mode:'HTML',disable_web_page_preview:true});if(isPrivate){try{var dr=await smartAsk(systemPrompt(caUnlocked),text);if(dr!=='IGNORE')return ctx.reply(dr);}catch(_){}return;}try{var gr=await smartAsk(systemPrompt(caUnlocked),text);if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}});");
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function registerWebhook(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Webhook: '+url);return;}}catch(e){console.log('Attempt '+(i+1)+': '+e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('" + TICKER + " bot on port '+PORT);await new Promise(function(r){setTimeout(r,2000);});await registerWebhook();resetSilence();setInterval(function(){if(WEBHOOK_URL)fetch(WEBHOOK_URL+'/health').catch(function(){});},4*60*1000);console.log('" + TICKER + " bot live');});");
  return L.join('\n');
}
//  FACTORY STARTUP 
app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});
app.get('/',function(req,res){res.end('OK');});
app.get('/health',function(req,res){res.end('OK');});
async function registerWebhook(){
  if(!WEBHOOK_URL){console.log('No WEBHOOK_URL');return;}
  var url=WEBHOOK_URL+'/webhook';
  for(var i=0;i<5;i++){
    try{var ok=await bot.telegram.setWebhook(url);if(ok){console.log('Factory webhook: '+url);return;}}catch(e){console.log('Attempt '+(i+1)+': '+e.message);}
    await new Promise(function(r){setTimeout(r,3000);});
  }
}
async function getGhOwner(){try{var r=await fetch('https://api.github.com/user',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});var d=await r.json();GH_OWNER=d.login||'';console.log('GH owner:',GH_OWNER);}catch(e){console.log('GH owner error:',e.message);}}
process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});
process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});
app.listen(PORT,async function(){
  console.log('Bot Factory starting on port '+PORT);
  await new Promise(function(r){setTimeout(r,2000);});
  await getGhOwner();
  await loadRegistry();
  await registerWebhook();
  setInterval(function(){if(WEBHOOK_URL)fetch(WEBHOOK_URL+'/health').catch(function(){});},4*60*1000);
  console.log('Bot Factory live. Send /start or /build.');
});
