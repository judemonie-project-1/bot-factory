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

// Groq pool
var groqPool=[];
for(var _i=1;_i<=10;_i++){var _k=process.env['GROQ_KEY_'+_i];if(_k)groqPool.push(_k.trim());}
var groqIdx=0;
function nextGroq(){if(!groqPool.length)return'';var k=groqPool[groqIdx%groqPool.length];groqIdx++;return k;}

var E={
  check:'\u2705', xmark:'\u274C', gear:'\u2699\uFE0F', fire:'\u{1F525}',
  rocket:'\u{1F680}', party:'\u{1F389}', warn:'\u26A0\uFE0F', link:'\u{1F517}',
  folder:'\u{1F4C2}', wrench:'\u{1F527}', shield:'\u{1F6E1}', robot:'\u{1F916}',
  star:'\u2B50', pencil:'\u270F\uFE0F', chart:'\u{1F4CA}', bnb:'\u{1F7E1}',
  sol:'\u{1F7E3}', list:'\u{1F4CB}', money:'\u{1F4B0}', copy:'\u{1F4CB}',
};

var CHAIN={
  bsc:{label:'BNB Smart Chain (BSC)',dex:'PancakeSwap',dexUrl:'https://pancakeswap.finance/swap?outputCurrency=',chartBase:'https://dexscreener.com/bsc/',explorer:'https://bscscan.com/token/',dsNetwork:'bsc'},
  sol:{label:'Solana',dex:'Raydium',dexUrl:'https://raydium.io/swap/?outputMint=',chartBase:'https://dexscreener.com/solana/',explorer:'https://solscan.io/token/',dsNetwork:'solana'},
};

var bot=new Telegraf(BOT_TOKEN);
var app=express();
app.use(express.json());

var registry=[];
var sessions={};
var editSessions={};
var groqSessions={};

//  HELPERS 
function rnd(n){var c='abcdefghijklmnopqrstuvwxyz0123456789',o='';for(var i=0;i<n;i++)o+=c[Math.floor(Math.random()*c.length)];return o;}
function rndCmd(){return rnd(3)+rnd(3)+rnd(2);}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function fmtNum(n){var s=String(n).replace(/,/g,'');var p=s.split('.');p[0]=p[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');return p.join('.');}

//  DEXSCREENER FETCH 
async function fetchTokenData(ca,chain){
  var net=CHAIN[chain].dsNetwork;
  var result={name:'',ticker:'',supply:'',buyTax:'',sellTax:'',maxWalletPct:'',renounced:'',locked:'',twitter:'',found:false};
  try{
    var r=await Promise.race([
      fetch('https://api.dexscreener.com/latest/dex/tokens/'+ca),
      new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},8000);}),
    ]);
    var d=await r.json();
    var pairs=(d.pairs||[]).filter(function(p){return p.chainId===net;});
    if(pairs.length){
      var p=pairs[0];
      result.found=true;
      result.name=p.baseToken&&p.baseToken.name||'';
      result.ticker=p.baseToken&&p.baseToken.symbol?'$'+p.baseToken.symbol:'';
      if(p.info&&p.info.socials){
        var tw=p.info.socials.find(function(s){return s.type==='twitter';});
        if(tw)result.twitter=tw.url;
      }
    }
  }catch(_){}
  return result;
}

//  REGISTRY 
function saveRegistry(){
  if(!GH_OWNER)return;
  var safe=registry.map(function(b){var c=JSON.parse(JSON.stringify(b));if(c.d)delete c.d.botToken;return c;});
  githubUpdate(GH_OWNER,'bot-factory','bots.json',Buffer.from(JSON.stringify(safe,null,2))).catch(function(){});
}
async function loadRegistry(){
  if(!GH_OWNER)return;
  try{
    var r=await fetch('https://api.github.com/repos/'+GH_OWNER+'/bot-factory/contents/bots.json',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
    if(r.ok){var d=await r.json();if(d.content){registry=JSON.parse(Buffer.from(d.content,'base64').toString('utf8'));console.log('Registry:',registry.length,'bots');}}
  }catch(e){console.log('Registry:',e.message);}
}

//  SESSION 
function newSession(isAdd){
  return{isAdd:!!isAdd,step:'chain',lastMsgId:null,fetching:false,
    d:{chain:'bsc',mode:'full',status:'launch',guardType:'standard',
       personality:'alpha',responseMode:'focused',
       name:'',ticker:'',ca:'',twitter:'',narrative:'',
       supply:'N/A',buyTax:'0',sellTax:'0',maxWalletPct:'N/A',
       renounced:'RENOUNCED',locked:'LOCKED',
       revealCmd:'',hideCmd:'',botToken:'',renderUrl:'',repoName:''},
    imgBuf:null};
}

//  BUTTONS 
function chainBtns(uid){return{inline_keyboard:[[{text:E.bnb+' BNB Smart Chain',callback_data:'s_chain_bsc_'+uid},{text:E.sol+' Solana',callback_data:'s_chain_sol_'+uid}]]};}
function modeBtns(uid){return{inline_keyboard:[[{text:E.robot+' Full (AI)',callback_data:'s_mode_full_'+uid},{text:E.shield+' Guard',callback_data:'s_mode_guard_'+uid}]]};}
function gtBtns(uid){return{inline_keyboard:[[{text:'\u26A1 Standard',callback_data:'s_gt_standard_'+uid},{text:'\u{1F6AB} Strict',callback_data:'s_gt_strict_'+uid},{text:'\u{1F9F9} Soft',callback_data:'s_gt_soft_'+uid}]]};}
function statusBtns(uid){return{inline_keyboard:[[{text:E.rocket+' Active dev',callback_data:'s_status_launch_'+uid},{text:E.shield+' CTO',callback_data:'s_status_cto_'+uid}]]};}
function persBtns(uid){return{inline_keyboard:[
  [{text:'\u26A1 Alpha \u2014 sharp & crypto-native',callback_data:'s_pers_alpha_'+uid}],
  [{text:'\u{1F454} Professional \u2014 clean & precise',callback_data:'s_pers_professional_'+uid}],
  [{text:'\u{1F525} Hype \u2014 high energy & bullish',callback_data:'s_pers_hype_'+uid}],
  [{text:'\u{1F91D} Community \u2014 warm & inclusive',callback_data:'s_pers_community_'+uid}],
]};}
function rmodeBtns(uid){return{inline_keyboard:[
  [{text:'\u{1F3AF} Focused \u2014 project questions only',callback_data:'s_rmode_focused_'+uid}],
  [{text:'\u{1F4AC} Conversational \u2014 responds to ? and mentions',callback_data:'s_rmode_conversational_'+uid}],
]};}

async function delMsg(ctx,id){if(id)try{await ctx.telegram.deleteMessage(ctx.chat.id,id);}catch(_){}}
async function say(ctx,s,text,kb){
  await delMsg(ctx,s.lastMsgId);
  var m=await ctx.reply(text,{parse_mode:'HTML',reply_markup:kb||undefined});
  s.lastMsgId=m.message_id;
}

//  COMMANDS 
bot.command('start',function(ctx){
  return ctx.reply(
    E.rocket+' <b>Bot Factory</b>\n\nBuild and manage Telegram bots for your crypto token.\n\n'+
    '<b>Chains:</b> BSC \u2022 Solana\n'+
    '<b>Modes:</b> Full (AI) \u2022 Guard (moderation)\n'+
    '<b>Types:</b> New launch \u2022 CTO\n\n'+
    '<b>Commands</b>\n'+
    '/build \u2014 Build a new bot\n'+
    '/addbot \u2014 Register existing bot\n'+
    '/bots \u2014 List your bots\n'+
    '/edit \u2014 Edit a bot\n'+
    '/rebuild \u2014 Full rebuild from data\n'+
    '/update \u2014 Push latest code\n'+
    '/stats \u2014 Health check\n'+
    '/addgroq \u2014 Add Groq key\n'+
    '/cancel \u2014 Cancel',
    {parse_mode:'HTML'}
  );
});
bot.command('cancel',function(ctx){var uid=String(ctx.from.id);delete sessions[uid];delete editSessions[uid];return ctx.reply(E.xmark+' Cancelled.');});
bot.command('addgroq',async function(ctx){var uid=String(ctx.from.id);groqSessions[uid]=true;try{await ctx.deleteMessage();}catch(_){}return ctx.reply(E.gear+' Send your Groq API key:');});
bot.command('bots',function(ctx){
  if(!registry.length)return ctx.reply(E.list+' No bots yet. Use /build.');
  var msg=E.list+' <b>Your Bots</b>\n\n';
  registry.forEach(function(b,i){msg+=(i+1)+'. <b>'+b.ticker+'</b> ('+b.chain.toUpperCase()+')\n   '+(b.mode==='guard'?E.shield+' Guard':E.robot+' Full')+' \u2022 '+(b.d&&b.d.status==='cto'?'CTO':'Active dev')+'\n   '+b.url+'\n\n';});
  return ctx.reply(msg,{parse_mode:'HTML',disable_web_page_preview:true});
});
bot.command('stats',async function(ctx){
  if(!registry.length)return ctx.reply(E.chart+' No bots registered.');
  await ctx.reply(E.chart+' Checking bots...');
  var msg=E.chart+' <b>Bot Health</b>\n\n';
  for(var i=0;i<registry.length;i++){
    var b=registry[i];var ok=false;
    try{var r=await Promise.race([fetch(b.url+'/health'),new Promise(function(_,rej){setTimeout(function(){rej(new Error('t'));},7000);})]);ok=r&&r.ok;}catch(_){}
    msg+=(i+1)+'. <b>'+b.ticker+'</b> \u2014 '+(ok?E.check+' Online':E.xmark+' Offline')+'\n   '+b.url+'\n\n';
  }
  return ctx.reply(msg,{parse_mode:'HTML',disable_web_page_preview:true});
});

//  BUILD / ADDBOT 
bot.command(['build','new'],async function(ctx){
  var uid=String(ctx.from.id);
  sessions[uid]=newSession(false);
  try{await ctx.deleteMessage();}catch(_){}
  var m=await ctx.reply(E.rocket+' <b>New bot \u2014 Step 1</b>\n\nSelect chain:',{parse_mode:'HTML',reply_markup:chainBtns(uid)});
  sessions[uid].lastMsgId=m.message_id;
});
bot.command('addbot',async function(ctx){
  var uid=String(ctx.from.id);
  sessions[uid]=newSession(true);
  try{await ctx.deleteMessage();}catch(_){}
  var m=await ctx.reply(E.wrench+' <b>Register bot \u2014 Step 1</b>\n\nSelect chain:',{parse_mode:'HTML',reply_markup:chainBtns(uid)});
  sessions[uid].lastMsgId=m.message_id;
});

//  BUTTON CALLBACKS 
bot.action(/^s_chain_(bsc|sol)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.chain=ctx.match[1];s.step='mode';
  try{await ctx.deleteMessage();}catch(_){}
  await say(ctx,s,'Step 2 \u2014 Bot mode:',modeBtns(uid));
});
bot.action(/^s_mode_(full|guard)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.mode=ctx.match[1];
  try{await ctx.deleteMessage();}catch(_){}
  if(s.d.mode==='guard'){s.step='gt';await say(ctx,s,'Guard type:',gtBtns(uid));}
  else{s.step='status';await say(ctx,s,'Step 3 \u2014 Project status:',statusBtns(uid));}
});
bot.action(/^s_gt_(standard|strict|soft)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.guardType=ctx.match[1];s.step='status';
  try{await ctx.deleteMessage();}catch(_){}
  await say(ctx,s,'Project status:',statusBtns(uid));
});
bot.action(/^s_status_(launch|cto)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.status=ctx.match[1];
  try{await ctx.deleteMessage();}catch(_){}
  if(s.d.mode==='full'){s.step='pers';await say(ctx,s,'Bot personality:',persBtns(uid));}
  else{s.step='ticker';await say(ctx,s,E.pencil+' Token ticker? (e.g. $MPC)');}
});
bot.action(/^s_pers_(alpha|professional|hype|community)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.personality=ctx.match[1];s.step='rmode';
  try{await ctx.deleteMessage();}catch(_){}
  await say(ctx,s,'Response mode:',rmodeBtns(uid));
});
bot.action(/^s_rmode_(focused|conversational)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.responseMode=ctx.match[1];s.step='ticker';
  try{await ctx.deleteMessage();}catch(_){}
  await say(ctx,s,E.pencil+' Token ticker? (e.g. $MPC)');
});

//  EDIT SYSTEM 
bot.command('edit',async function(ctx){
  if(!registry.length)return ctx.reply(E.wrench+' No bots to edit.');
  var kb=registry.map(function(b,i){return[{text:b.ticker+' ('+b.chain.toUpperCase()+')',callback_data:'epick_'+i}];});
  return ctx.reply(E.wrench+' <b>Which bot?</b>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^epick_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];
  if(!b)return ctx.reply('Not found.');
  var uid=String(ctx.from.id);editSessions[uid]={idx:i};
  var d=b.d||{};
  var kb=[
    [{text:'Twitter/X link',callback_data:'ef_twitter_'+i}],
    [{text:'Narrative',callback_data:'ef_narrative_'+i}],
    [{text:'Supply',callback_data:'ef_supply_'+i}],
    [{text:'Tax (buy/sell)',callback_data:'ef_tax_'+i}],
    [{text:'Max wallet',callback_data:'ef_maxwallet_'+i}],
    [{text:'Renounced: '+(d.renounced||'?'),callback_data:'ef_toggle_renounced_'+i}],
    [{text:'LP Locked: '+(d.locked||'?'),callback_data:'ef_toggle_locked_'+i}],
    [{text:'Bot image',callback_data:'ef_image_'+i}],
    [{text:(d.status==='cto'?E.rocket+' Switch to Launch':E.shield+' Switch to CTO'),callback_data:'ef_cto_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
  ];
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.wrench+' <b>Edit '+b.ticker+'</b>\nWhat to change?',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^ef_(twitter|narrative|supply|tax|maxwallet)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var field=ctx.match[1],i=parseInt(ctx.match[2]),uid=String(ctx.from.id);
  editSessions[uid]={idx:i,field:field};
  var asks={twitter:'Send new Twitter/X link:',narrative:'Send new narrative:',supply:'Send new supply (e.g. 1B):',tax:'Send tax as buy/sell (e.g. 5/5):',maxwallet:'Send new max wallet % (e.g. 4.9%):'};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(asks[field]);
});
bot.action(/^ef_image_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),uid=String(ctx.from.id);
  editSessions[uid]={idx:i,field:'image'};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply('Send new bot image (photo):');
});
bot.action(/^ef_toggle_(renounced|locked)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var field=ctx.match[1],i=parseInt(ctx.match[2]);
  var b=registry[i];if(!b)return ctx.reply('Not found.');
  b.d=b.d||{};
  if(field==='renounced')b.d.renounced=b.d.renounced==='RENOUNCED'?'NOT RENOUNCED':'RENOUNCED';
  else b.d.locked=b.d.locked==='LOCKED'?'NOT LOCKED':'LOCKED';
  try{await ctx.deleteMessage();}catch(_){}
  await ctx.reply(E.gear+' Updating...');
  if(b.repoName&&b.ghOwner){
    try{await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain],b.mode)));saveRegistry();return ctx.reply(E.check+' Updated! Render redeploys in ~1 min.');}
    catch(e){return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  saveRegistry();return ctx.reply(E.check+' Saved. Use /rebuild to push.');
});
bot.action(/^ef_cto_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]);
  var b=registry[i];if(!b)return ctx.reply('Not found.');
  b.d=b.d||{};b.d.status=b.d.status==='cto'?'launch':'cto';
  try{await ctx.deleteMessage();}catch(_){}
  await ctx.reply(E.gear+' Updating...');
  if(b.repoName&&b.ghOwner){
    try{await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain],b.mode)));saveRegistry();return ctx.reply(E.check+' <b>'+b.ticker+'</b> switched to <b>'+(b.d.status==='cto'?'CTO':'Launch')+'</b>\nRender redeploys in ~1 min.',{parse_mode:'HTML'});}
    catch(e){return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  saveRegistry();return ctx.reply(E.check+' Saved. Use /rebuild to push.');
});
bot.action('ecancel',async function(ctx){await ctx.answerCbQuery();delete editSessions[String(ctx.from.id)];try{await ctx.deleteMessage();}catch(_){}return ctx.reply(E.xmark+' Cancelled.');});

// rebuild
bot.command('rebuild',async function(ctx){
  var eligible=registry.filter(function(b){return b.repoName&&b.ghOwner&&b.d&&b.d.ticker;});
  if(!eligible.length)return ctx.reply(E.wrench+' No bots with data. Use /addbot first.');
  var kb=eligible.map(function(b){var i=registry.indexOf(b);return[{text:b.ticker+' ('+b.chain.toUpperCase()+')',callback_data:'rbd_'+i}];});
  return ctx.reply(E.gear+' <b>Rebuild from stored data:</b>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^rbd_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();try{await ctx.deleteMessage();}catch(_){}
  var b=registry[parseInt(ctx.match[1])];
  if(!b||!b.repoName||!b.ghOwner)return ctx.reply(E.xmark+' No repo linked.');
  await ctx.reply(E.gear+' Rebuilding <b>'+b.ticker+'</b>...',{parse_mode:'HTML'});
  try{
    await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain],b.mode)));
    await githubUpdate(b.ghOwner,b.repoName,'package.json',Buffer.from(genPkg(b.d.name,b.mode)));
    return ctx.reply(E.check+' <b>'+b.ticker+'</b> rebuilt!\nRender redeploys in ~1 min.',{parse_mode:'HTML'});
  }catch(e){return ctx.reply(E.xmark+' Failed: '+e.message);}
});

// update
bot.command('update',async function(ctx){
  var ok=registry.filter(function(b){return b.repoName&&b.ghOwner&&b.d&&b.d.ticker;});
  var bad=registry.filter(function(b){return!b.d||!b.d.ticker;});
  if(!ok.length&&!bad.length)return ctx.reply(E.wrench+' No bots. Use /addbot.');
  if(bad.length){var warn=E.warn+' No data for: '+bad.map(function(b){return b.ticker;}).join(', ')+'. Use /addbot to register.\n\n';if(!ok.length)return ctx.reply(warn,{parse_mode:'HTML'});}
  var kb=ok.map(function(b){var i=registry.indexOf(b);return[{text:b.ticker,callback_data:'upd_'+i}];});
  kb.push([{text:E.gear+' Update ALL',callback_data:'upd_all'}]);
  return ctx.reply(E.wrench+' <b>Push latest code to:</b>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^upd_(\d+|all)$/,async function(ctx){
  await ctx.answerCbQuery();try{await ctx.deleteMessage();}catch(_){}
  var target=ctx.match[1];
  var bots=target==='all'?registry.filter(function(b){return b.repoName&&b.ghOwner&&b.d&&b.d.ticker;}):[registry[parseInt(target)]].filter(Boolean);
  if(!bots.length)return ctx.reply(E.xmark+' Nothing to update.');
  await ctx.reply(E.gear+' Updating '+bots.length+' bot(s)...');
  var results=[];
  for(var i=0;i<bots.length;i++){
    var b=bots[i];
    try{await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain],b.mode)));results.push(E.check+' <b>'+b.ticker+'</b>');}
    catch(e){results.push(E.xmark+' <b>'+b.ticker+'</b>: '+e.message.slice(0,60));}
  }
  return ctx.reply(results.join('\n')+'\n\nRender redeploys automatically.',{parse_mode:'HTML'});
});


//  TEXT + PHOTO HANDLER 
bot.on('photo',async function(ctx){
  var uid=String(ctx.from.id);
  var es=editSessions[uid];
  if(es&&es.field==='image'){
    var b=registry[es.idx];if(!b)return;
    if(!b.repoName||!b.ghOwner){delete editSessions[uid];return ctx.reply(E.warn+' No repo linked. Use /addbot first.');}
    var ph=ctx.message.photo[ctx.message.photo.length-1];
    try{var lnk=await ctx.telegram.getFileLink(ph.file_id);var rb=await fetch(lnk.href);var buf=Buffer.from(await rb.arrayBuffer());
      await ctx.reply(E.gear+' Updating image...');
      await githubUpdate(b.ghOwner,b.repoName,'siren.jpg',buf);
      delete editSessions[uid];return ctx.reply(E.check+' Image updated! Render redeploys in ~1 min.');
    }catch(e){delete editSessions[uid];return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  var s=sessions[uid];
  if(!s||s.step!=='img')return;
  var ph2=ctx.message.photo[ctx.message.photo.length-1];
  try{var lnk2=await ctx.telegram.getFileLink(ph2.file_id);var rb2=await fetch(lnk2.href);s.imgBuf=Buffer.from(await rb2.arrayBuffer());}
  catch(e){return ctx.reply(E.xmark+' Image error: '+e.message);}
  try{await ctx.deleteMessage();}catch(_){}
  try{if(s.lastMsgId)await ctx.telegram.deleteMessage(ctx.chat.id,s.lastMsgId);}catch(_){}
  s.step=s.isAdd?'renderurl':'bottoken';
  await say(ctx,s,s.isAdd?E.pencil+' Render URL?\n<i>e.g. https://mpc-bot-31hk.onrender.com</i>':E.pencil+' BotFather token?\n\n<i>Open @BotFather \u2192 /newbot \u2192 copy the token</i>');
});

bot.on('text',async function(ctx){
  var uid=String(ctx.from.id);
  var text=(ctx.message.text||'').trim();
  if(text.startsWith('/'))return;

  // Groq key
  if(groqSessions[uid]){delete groqSessions[uid];try{await ctx.deleteMessage();}catch(_){}
    if(text.length<20)return ctx.reply(E.xmark+' Invalid key.');
    groqPool.push(text.trim());return ctx.reply(E.check+' Groq key added. Pool: '+groqPool.length);
  }

  // Edit session
  var es=editSessions[uid];
  if(es&&es.field&&es.field!=='image'){
    var b=registry[es.idx];if(!b){delete editSessions[uid];return;}
    try{await ctx.deleteMessage();}catch(_){}
    b.d=b.d||{};
    if(es.field==='twitter')b.d.twitter=text;
    else if(es.field==='narrative')b.d.narrative=text;
    else if(es.field==='supply')b.d.supply=text;
    else if(es.field==='tax'){var tx=text.split('/');b.d.buyTax=(tx[0]||text).trim();b.d.sellTax=(tx[1]||tx[0]||'').trim();}
    else if(es.field==='maxwallet')b.d.maxWalletPct=text;
    var pm=await ctx.reply(E.gear+' Updating...');
    if(b.repoName&&b.ghOwner){
      try{await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain],b.mode)));saveRegistry();delete editSessions[uid];
        try{await ctx.telegram.deleteMessage(ctx.chat.id,pm.message_id);}catch(_){}
        return ctx.reply(E.check+' <b>'+b.ticker+'</b> \u2014 <b>'+es.field+'</b> updated!\nRender redeploys in ~1 min.',{parse_mode:'HTML'});}
      catch(e){delete editSessions[uid];return ctx.reply(E.xmark+' Failed: '+e.message);}
    }
    saveRegistry();delete editSessions[uid];
    try{await ctx.telegram.deleteMessage(ctx.chat.id,pm.message_id);}catch(_){}
    return ctx.reply(E.check+' Saved. Use /rebuild to push.');
  }

  // Build wizard
  var s=sessions[uid];
  if(!s)return ctx.reply('Use /build or /addbot to start. Type /help for commands.');
  try{await ctx.deleteMessage();}catch(_){}
  try{if(s.lastMsgId)await ctx.telegram.deleteMessage(ctx.chat.id,s.lastMsgId);}catch(_){}
  s.lastMsgId=null;

  if(['chain','mode','gt','status','pers','rmode'].includes(s.step)){
    var m=await ctx.reply('Please tap one of the buttons above.');s.lastMsgId=m.message_id;return;
  }
  if(s.step==='confirm'){
    if(/^yes$/i.test(text)){return s.isAdd?doRegister(ctx,s,uid):doBuild(ctx,s,uid);}
    delete sessions[uid];return ctx.reply(E.xmark+' Cancelled.');
  }

  // Text steps
  if(s.step==='ticker'){
    s.d.ticker=text.startsWith('$')?text:'$'+text;
    s.step='ca';
    await say(ctx,s,E.pencil+' Contract address?');
    return;
  }
  if(s.step==='ca'){
    s.d.ca=text.trim();
    // Auto-fetch from DexScreener
    var fetchMsg=await ctx.reply(E.gear+' Fetching token data from DexScreener...');
    var data=await fetchTokenData(s.d.ca,s.d.chain);
    try{await ctx.telegram.deleteMessage(ctx.chat.id,fetchMsg.message_id);}catch(_){}
    if(data.found){
      if(data.name&&!s.d.name)s.d.name=data.name;
      if(data.ticker&&s.d.ticker==='$TOKEN')s.d.ticker=data.ticker;
      if(data.twitter&&!s.d.twitter)s.d.twitter=data.twitter;
      var found='<b>'+E.check+' Found on DexScreener:</b>\n'+
        'Name: '+(data.name||'N/A')+'\n'+
        (data.twitter?'Twitter: '+data.twitter+'\n':'')+
        '\n<i>Supply, tax and wallet info can be edited after via /edit</i>';
      var m2=await ctx.reply(found,{parse_mode:'HTML'});
      s.lastMsgId=m2.message_id;
      await sleep(2000);
      try{await ctx.telegram.deleteMessage(ctx.chat.id,m2.message_id);}catch(_){}
    }
    s.step='twitter';
    await say(ctx,s,E.pencil+' Twitter/X link?\n<i>Or - to skip</i>');
    return;
  }
  if(s.step==='twitter'){
    s.d.twitter=text==='-'?'':text;
    s.step='narrative';
    await say(ctx,s,E.pencil+' Token narrative / story?\n<i>1-2 sentences. What makes it unique. Or - to skip</i>');
    return;
  }
  if(s.step==='narrative'){
    s.d.narrative=text==='-'?'':text;
    s.step='img';
    var m3=await ctx.reply(E.pencil+' Send bot image (JPG/PNG)\nOr type <b>skip</b> to continue without one',{parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'Skip (no image)',callback_data:'s_skipimg_'+uid}]]}});
    s.lastMsgId=m3.message_id;
    return;
  }
  if(s.step==='img'){
    // Text entered instead of photo
    if(text.toLowerCase()==='skip'){s.imgBuf=null;s.step=s.isAdd?'renderurl':'bottoken';}
    else{var m4=await ctx.reply('Send a photo or tap Skip.',{reply_markup:{inline_keyboard:[[{text:'Skip',callback_data:'s_skipimg_'+uid}]]}});s.lastMsgId=m4.message_id;return;}
    await say(ctx,s,s.isAdd?E.pencil+' Render URL?\n<i>e.g. https://mpc-bot-31hk.onrender.com</i>':E.pencil+' BotFather token?\n\n<i>Open @BotFather \u2192 /newbot \u2192 copy the token</i>');
    return;
  }
  if(s.step==='renderurl'){
    s.d.renderUrl=text.trim().replace(/\/+$/,'');
    s.d.repoName=s.d.renderUrl.match(/https?:\/\/([a-z0-9-]+)\.onrender\.com/)?RegExp.$1:'';
    s.step='bottoken';
    await say(ctx,s,E.pencil+' BotFather token?\n\n<i>Open @BotFather \u2192 /mybots \u2192 select bot \u2192 API Token</i>');
    return;
  }
  if(s.step==='bottoken'){
    s.d.botToken=text.trim();
    // Generate summary
    var ci=CHAIN[s.d.chain];
    var summary=(s.isAdd?E.wrench:E.fire)+' <b>Confirm '+(s.isAdd?'registration':'build')+'</b>\n\n'+
      '<b>Chain:</b> '+ci.label+'\n'+
      '<b>Mode:</b> '+(s.d.mode==='guard'?E.shield+' Guard':E.robot+' Full')+'\n'+
      '<b>Status:</b> '+(s.d.status==='cto'?E.shield+' CTO':E.rocket+' Active dev')+'\n'+
      '<b>Ticker:</b> '+s.d.ticker+'\n'+
      '<b>CA:</b> <code>'+s.d.ca+'</code>\n'+
      (s.d.twitter?'<b>Twitter:</b> '+s.d.twitter+'\n':'')+
      (s.isAdd&&s.d.renderUrl?'<b>Render URL:</b> '+s.d.renderUrl+'\n':'')+
      '<b>Image:</b> '+(s.imgBuf?E.check+' ready':'\u2014 none')+'\n\n'+
      'Type <b>yes</b> to '+(s.isAdd?'register':'deploy')+' \u2014 <b>no</b> to cancel.';
    s.step='confirm';
    await say(ctx,s,summary);
    return;
  }
});

bot.action(/^s_skipimg_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.imgBuf=null;s.step=s.isAdd?'renderurl':'bottoken';
  try{await ctx.deleteMessage();}catch(_){}
  await say(ctx,s,s.isAdd?E.pencil+' Render URL?\n<i>e.g. https://mpc-bot-31hk.onrender.com</i>':E.pencil+' BotFather token?\n\n<i>Open @BotFather \u2192 /newbot \u2192 copy the token</i>');
});


//  BUILD ORCHESTRATOR 
async function doBuild(ctx,s,uid){
  var d=s.d,ci=CHAIN[d.chain];
  var groqKey=d.mode==='full'?nextGroq():'';
  if(d.mode==='full'&&!groqKey)return ctx.reply(E.xmark+' No Groq key. Use /addgroq first.');
  d.revealCmd=rndCmd();d.hideCmd=rndCmd();
  d.name=d.name||d.ticker.replace('$','');
  var repoName=d.ticker.replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+'-bot-'+rnd(4);
  var guessUrl='https://'+repoName+'.onrender.com';
  await ctx.reply(E.gear+' Deploying <b>'+d.ticker+'</b>...',{parse_mode:'HTML'});
  var ghOwner='',svcId='',actualUrl=guessUrl;
  var steps=[
    {n:'GitHub repo',fn:async function(){
      var g=await githubCreateRepo(repoName);
      ghOwner=g.full_name.split('/')[0];GH_OWNER=GH_OWNER||ghOwner;
      await sleep(4000);
      await githubPush(ghOwner,repoName,'bot.js',Buffer.from(genBot(d,ci,d.mode)));
      await githubPush(ghOwner,repoName,'package.json',Buffer.from(genPkg(d.name,d.mode)));
      if(s.imgBuf)await githubPush(ghOwner,repoName,'siren.jpg',s.imgBuf);
    }},
    {n:'Render service',fn:async function(){
      var oid=await renderOwner();
      var ev=[{key:'BOT_TOKEN',value:d.botToken},{key:'WEBHOOK_URL',value:guessUrl}];
      if(d.mode==='full')ev.push({key:'GROQ_API_KEY',value:groqKey});
      var svc=await renderCreate(repoName,ghOwner,oid,ev);
      svcId=svc.id;actualUrl=(svc.serviceDetails&&svc.serviceDetails.url)||guessUrl;
      if(actualUrl!==guessUrl){var uv=ev.map(function(v){return v.key==='WEBHOOK_URL'?{key:'WEBHOOK_URL',value:actualUrl}:v;});await renderEnv(svcId,uv);}
    }},
    {n:'Cron keepalive',fn:async function(){await cronJob(repoName,actualUrl+'/health');}},
  ];
  var ok=true;
  for(var i=0;i<steps.length;i++){
    try{await steps[i].fn();await ctx.reply(E.check+' '+steps[i].n);}
    catch(e){await ctx.reply(E.xmark+' '+steps[i].n+' failed\n<code>'+e.message.slice(0,200)+'</code>',{parse_mode:'HTML'});ok=false;break;}
  }
  if(ok){
    registry.push({ticker:d.ticker,chain:d.chain,mode:d.mode,repoName:repoName,ghOwner:ghOwner,svcId:svcId,url:actualUrl,d:JSON.parse(JSON.stringify(d)),builtAt:Date.now()});
    saveRegistry();delete sessions[uid];
    await ctx.reply(
      E.party+' <b>'+d.ticker+' is live!</b>\n\n'+
      E.link+' <code>'+actualUrl+'</code>\n'+
      E.folder+' <code>github.com/'+ghOwner+'/'+repoName+'</code>\n\n'+
      E.warn+' <b>Save these secret commands:</b>\n'+
      'Reveal CA: <code>/'+d.revealCmd+'</code>\n'+
      'Hide CA: <code>/'+d.hideCmd+'</code>\n\n'+
      '<b>Next:</b>\n1. Wait 3-5 min for Render to build\n2. Add bot to group, make it admin\n3. Use <code>/'+d.revealCmd+'</code> in group to reveal CA',
      {parse_mode:'HTML',disable_web_page_preview:true}
    );
  }else{delete sessions[uid];}
}

async function doRegister(ctx,s,uid){
  var d=s.d;
  var pm=await ctx.reply(E.gear+' Registering <b>'+d.ticker+'</b>...',{parse_mode:'HTML'});
  await sleep(300);
  try{await ctx.telegram.deleteMessage(ctx.chat.id,pm.message_id);}catch(_){}
  var existing=registry.findIndex(function(b){return b.url===d.renderUrl||b.ticker===d.ticker;});
  if(existing>=0){
    registry[existing].d=JSON.parse(JSON.stringify(d));
    registry[existing].repoName=d.repoName||registry[existing].repoName;
    registry[existing].chain=d.chain;registry[existing].mode=d.mode;
    saveRegistry();delete sessions[uid];
    return ctx.reply(E.check+' <b>'+d.ticker+'</b> updated with full details!\nUse /rebuild to push fresh code.',{parse_mode:'HTML'});
  }
  registry.push({ticker:d.ticker,chain:d.chain,mode:d.mode,repoName:d.repoName,ghOwner:GH_OWNER,url:d.renderUrl,d:JSON.parse(JSON.stringify(d)),builtAt:Date.now()});
  saveRegistry();delete sessions[uid];
  return ctx.reply(
    E.check+' <b>'+d.ticker+'</b> registered!\n\nUse /rebuild to push code, /edit to update details.',
    {parse_mode:'HTML'}
  );
}

//  GITHUB API 
async function githubCreateRepo(name){
  var r=await fetch('https://api.github.com/user/repos',{method:'POST',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({name:name,private:false,auto_init:false})});
  var d=await r.json();if(!d.full_name)throw new Error('Repo failed: '+JSON.stringify(d).slice(0,150));return d;
}
async function githubPush(owner,repo,file,content){
  var lastErr;
  for(var a=0;a<5;a++){
    if(a>0)await sleep(5000);
    try{var r=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+file,{method:'PUT',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({message:'Add '+file,content:content.toString('base64')})});var d=await r.json();if(d.content||d.commit)return d;lastErr=new Error('Push failed: '+JSON.stringify(d).slice(0,150));}
    catch(e){lastErr=e;}
  }throw lastErr;
}
async function githubUpdate(owner,repo,file,content){
  var sha='';
  try{var rg=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+file,{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});var dg=await rg.json();sha=dg.sha||'';}catch(_){}
  var body={message:'Update '+file,content:content.toString('base64')};if(sha)body.sha=sha;
  var r=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+file,{method:'PUT',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify(body)});
  var d=await r.json();if(!d.content&&!d.commit)throw new Error('Update failed: '+JSON.stringify(d).slice(0,150));return d;
}

//  RENDER API 
async function renderOwner(){
  var r=await fetch('https://api.render.com/v1/owners?limit=1',{headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json'}});
  var d=await r.json();if(!Array.isArray(d)||!d[0])throw new Error('Render owner failed');
  return d[0].owner?d[0].owner.id:d[0].id;
}
async function renderCreate(name,ghOwner,ownerId,envVars){
  var r=await fetch('https://api.render.com/v1/services',{method:'POST',headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({autoDeploy:'yes',branch:'main',name:name,ownerId:ownerId,repo:'https://github.com/'+ghOwner+'/'+name,type:'web_service',envVars:envVars||[],serviceDetails:{runtime:'node',plan:'free',region:'oregon',numInstances:1,envSpecificDetails:{buildCommand:'npm install',startCommand:'npm start'}}})});
  var d=await r.json();var svc=d.service||d;if(!svc.id)throw new Error('Render create failed: '+JSON.stringify(d).slice(0,300));return svc;
}
async function renderEnv(svcId,vars){await fetch('https://api.render.com/v1/services/'+svcId+'/env-vars',{method:'PUT',headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify(vars)});}

//  CRON 
async function cronJob(name,url){
  await fetch('https://api.cron-job.org/jobs',{method:'PUT',headers:{'Authorization':'Bearer '+CRON_KEY,'Content-Type':'application/json'},body:JSON.stringify({job:{url:url,title:name+' keepalive',enabled:true,saveResponses:false,schedule:{timezone:'UTC',hours:[-1],mdays:[-1],months:[-1],wdays:[-1],minutes:[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50,52,54,56,58]}}})});
}

//  PACKAGE.JSON 
function genPkg(name,mode){
  var deps={telegraf:'^4.16.3',express:'^4.18.2'};
  if(mode==='full')deps['groq-sdk']='^0.3.3';
  return JSON.stringify({name:(name||'token').toLowerCase().replace(/[^a-z0-9]/g,'-')+'-bot',version:'1.0.0',main:'bot.js',scripts:{start:'node bot.js'},dependencies:deps,engines:{node:'>=18.0.0'}},null,2);
}


//  BOT GENERATOR 
function genBot(d,ci,mode){return mode==='guard'?genGuard(d,ci):genFull(d,ci);}

function genGuard(d,ci){
  var TICKER=d.ticker||'$TOKEN';
  var CA=d.ca||'';
  var SUPPLY=d.supply||'N/A';
  var MAXPCT=d.maxWalletPct||'N/A';
  var MAXTOK=d.maxWalletTokens||'';
  var BUYTAX=d.buyTax||'0';
  var SELLTAX=d.sellTax||'0';
  var TWITTER=d.twitter||'';
  var WEBSITE=d.website||'';
  var RENOUNCED=d.renounced||'RENOUNCED';
  var LOCKED=d.locked||'LOCKED';
  var IS_CTO=d.status==='cto';
  var REVEAL=(d.revealCmd||'revealca').replace(/^\//,'');
  var HIDE=(d.hideCmd||'hideca').replace(/^\//,'');
  var CHAIN_LBL=ci.label;
  var DEX=ci.dex;
  var CHART=ci.chartBase+CA;
  var BUY_URL=ci.dexUrl+CA;
  var GT=d.guardType||'standard';

  var L=[];function ln(s){L.push(String(s===undefined?'':s));}

  ln("'use strict';");
  ln("var Telegraf=require('telegraf').Telegraf;");
  ln("var express=require('express');");
  ln("var fs=require('fs');");
  ln("var path=require('path');");
  ln("var BOT_TOKEN=process.env.BOT_TOKEN;");
  ln("var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();");
  ln("var PORT=process.env.PORT||3000;");
  ln("var TICKER='"+TICKER+"';");
  ln("var CA='"+CA+"';");
  ln("var TWITTER='"+TWITTER+"';");
  ln("var WEBSITE='"+WEBSITE+"';");
  ln("var IS_CTO="+IS_CTO+";");
  ln("var GUARD_TYPE='"+GT+"';");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();");
  ln("app.use(express.json());");
  ln("var _SF='/tmp/state.json';");
  ln("var caUnlocked=false,groupChatId=null;");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("loadState();");
  ln("var IMG=path.join(__dirname,'siren.jpg');");
  ln("var IMG_BUF=null;");
  ln("try{if(fs.existsSync(IMG))IMG_BUF=fs.readFileSync(IMG);}catch(_){}");
  ln("var imgMsgs=new Map(),strikes=new Map(),spamTracker=new Map();");
  ln("var STRIKE_RESET=86400000,SPAM_WIN=60000,SPAM_MAX=5;");
  ln("async function delPrevImg(cid){var mid=imgMsgs.get(cid);if(mid){try{await bot.telegram.deleteMessage(cid,mid);}catch(_){}imgMsgs.delete(cid);}}");
  ln("async function sendImg(cid,caption,extra){await delPrevImg(cid);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(cid,{source:IMG_BUF},Object.assign({caption:caption,parse_mode:'HTML'},extra));imgMsgs.set(cid,m.message_id);return m;}catch(e){IMG_BUF=null;}}return bot.telegram.sendMessage(cid,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(cid,mid,ms){setTimeout(function(){try{bot.telegram.deleteMessage(cid,mid);}catch(_){}},ms);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>STRIKE_RESET){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid,reason){var s=getStrike(uid);try{await ctx.deleteMessage();}catch(_){}var mem=ctx.message&&ctx.message.from;var tag=mem&&mem.username?'@'+mem.username:mem&&mem.first_name||'user';var why=reason?' ('+reason+')':'';if(GUARD_TYPE==='soft')return;if(GUARD_TYPE==='strict'){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+86400});}catch(_){}var ms=await ctx.reply('\\u26A0\\uFE0F '+tag+' muted 24h'+why+'.');autoDelete(ctx.chat.id,ms.message_id,45000);return;}s.count++;if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+86400});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F '+tag+' muted 24h \\u2014 3 strikes'+why+'.');autoDelete(ctx.chat.id,m3.message_id,60000);}else{var mw=await ctx.reply('\\u26A0\\uFE0F '+tag+' warning '+s.count+'/3'+why);autoDelete(ctx.chat.id,mw.message_id,45000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{c:0,s:now};if(now-t.s>SPAM_WIN)t={c:0,s:now};t.c++;spamTracker.set(uid,t);if(t.c>SPAM_MAX){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','fuck','bitch','bastard','asshole','cunt','exit scam','dev ran','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("var NOT_LIVE=['"+TICKER+" hasn\\u2019t launched yet. CA coming soon.','Not yet. Stay ready.','Hold tight \\u2014 drop is close.','CA coming soon.'];");

  // CA command  hardcoded, no AI
  ln("bot.command('ca',async function(ctx){");
  ln("  if(!caUnlocked){return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);}");
  ln("  return sendImg(ctx.chat.id,'<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("});");

  // X command  hardcoded, no AI
  ln("bot.command('x',async function(ctx){");
  ln("  return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("});");
  ln("bot.command('twitter',async function(ctx){");
  ln("  return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("});");

  // Socials
  ln("bot.command('socials',function(ctx){return ctx.reply('<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY_URL+'\\'>" + DEX + "</a> | <a href=\\''+TWITTER+"+"'\\'>Twitter</a>'+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply('<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY_URL+'\\'>" + DEX + "</a> | <a href=\\''+TWITTER+"+"'\\'>Twitter</a>'+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");

  // Info
  ln("bot.command('info',function(ctx){");
  ln("  return ctx.reply(");
  ln("    '<b>"+TICKER+"</b> \\u2014 "+CHAIN_LBL+"\\n\\n'+");
  ln("    'Supply: "+SUPPLY+"\\n'+");
  ln("    'Max Wallet: "+MAXPCT+(MAXTOK?' ('+MAXTOK+')':'')+"\\n'+");
  ln("    'Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\n'+");
  ln("    'Contract: "+RENOUNCED+" | LP: "+LOCKED+"'+");
  ln("    (TWITTER?'\\nTwitter: '+TWITTER:''),");
  ln("    {parse_mode:'HTML',disable_web_page_preview:true}");
  ln("  );");
  ln("});");

  // Reveal / Hide
  ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA hidden.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");

  // New members
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}for(var i=0;i<ctx.message.new_chat_members.length;i++){var mem=ctx.message.new_chat_members[i];var handle=mem.username?'@'+mem.username:mem.first_name;var msg=handle+' joined "+TICKER+".\\n"+RENOUNCED+" \\u2022 LP "+LOCKED+" \\u2022 "+BUYTAX+"%/"+SELLTAX+"% tax\\n'+(caUnlocked?CA:'CA coming soon.');var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);}});");

  // Message handler
  ln("bot.on('message',async function(ctx){var msg=ctx.message;if(!msg||!ctx.from)return;var uid=ctx.from.id,chatType=ctx.chat.type;var text=(msg.text||'').trim();var isPrivate=chatType==='private';if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}var admin=await isAdmin(ctx,uid);if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;if(hasFud(text))return applyStrike(ctx,uid,'no FUD');}if(!text)return;var lower=text.toLowerCase();");
  ln("  var ctoReplies=['"+TICKER+" is a CTO. Original dev gone. Community took over completely. The holders are the team.','This is a CTO. Dev walked away. Community stepped up and owns "+TICKER+" now.','No dev here. "+TICKER+" is 100% community-owned. Original dev left. Community drives this forward.'];");
  ln("  if(lower.includes('dev')||lower.includes('cto')||lower.includes('community takeover')||lower.includes('who run')){");
  ln("    if(IS_CTO)return ctx.reply(ctoReplies[Math.floor(Math.random()*ctoReplies.length)]);");
  ln("    return ctx.reply('Dev is active, building and present.');");
  ln("  }");
  ln("  var caWords=['ca','contract address','token address','where is the ca','give ca','drop ca'];");
  ln("  if(caWords.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);return sendImg(ctx.chat.id,'<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("  if(lower==='x'||lower==='twitter')return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("  if(lower==='socials'||lower==='links')return ctx.reply('<a href=\\''+CHART+'\\'>Chart</a> | <a href=\\''+BUY_URL+'\\'>" + DEX + "</a> | <a href=\\''+TWITTER+"+"'\\'>Twitter</a>',{parse_mode:'HTML',disable_web_page_preview:true});");
  ln("  if(lower.includes('tax'))return ctx.reply('Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell');");
  ln("  if(lower.includes('max wallet')||lower.includes('maxwallet'))return ctx.reply('Max Wallet: "+MAXPCT+(MAXTOK?' ('+MAXTOK+')':'')+"');");
  ln("  if(lower.includes('supply'))return ctx.reply('Supply: "+SUPPLY+"');");
  ln("});");

  // Server
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function regWebhook(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{if(await bot.telegram.setWebhook(url)){console.log('Webhook:',url);return;}}catch(e){console.log('Attempt '+(i+1)+':',e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Err:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rej:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('"+TICKER+" guard bot port '+PORT);try{await new Promise(function(r){setTimeout(r,2000);});}catch(_){}try{await regWebhook();}catch(e){console.log(e.message);}setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);console.log('"+TICKER+" guard bot live');});");

  return L.join('\n');
}


function genFull(d,ci){
  var TICKER=d.ticker||'$TOKEN';
  var CA=d.ca||'';
  var SUPPLY=d.supply||'N/A';
  var MAXPCT=d.maxWalletPct||'N/A';
  var MAXTOK=d.maxWalletTokens||'';
  var BUYTAX=d.buyTax||'0';
  var SELLTAX=d.sellTax||'0';
  var TWITTER=d.twitter||'';
  var WEBSITE=d.website||'';
  var RENOUNCED=d.renounced||'RENOUNCED';
  var LOCKED=d.locked||'LOCKED';
  var IS_CTO=d.status==='cto';
  var NARR=JSON.stringify(d.narrative||'');
  var PERS=d.personality||'alpha';
  var RMODE=d.responseMode||'focused';
  var REVEAL=(d.revealCmd||'revealca').replace(/^\//,'');
  var HIDE=(d.hideCmd||'hideca').replace(/^\//,'');
  var CHAIN_LBL=ci.label;
  var DEX=ci.dex;
  var CHART=ci.chartBase+CA;
  var BUY_URL=ci.dexUrl+CA;

  var PERS_STYLE={
    alpha:'Confident, sharp, and crypto-native. Talk like a seasoned degen who genuinely believes in the project. Direct and bold.',
    professional:'Clean, informative, and professional. Precise answers. Measured tone. Build trust through clarity.',
    hype:'High energy, exciting, and bullish. Match the community energy. Enthusiastic but genuine.',
    community:'Warm, inclusive, and friendly. Make everyone feel welcome. Genuine and supportive.',
  }[PERS]||'Confident and direct.';

  var L=[];function ln(s){L.push(String(s===undefined?'':s));}

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
  ln("var TICKER='"+TICKER+"';");
  ln("var CA='"+CA+"';");
  ln("var TWITTER='"+TWITTER+"';");
  ln("var WEBSITE='"+WEBSITE+"';");
  ln("var IS_CTO="+IS_CTO+";");
  ln("var RESPONSE_MODE='"+RMODE+"';");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var groq=new Groq({apiKey:GROQ_API_KEY});");
  ln("var app=express();");
  ln("app.use(express.json());");
  ln("var _SF='/tmp/state.json';");
  ln("var caUnlocked=false,groupChatId=null,silenceTimer=null;");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("loadState();");
  ln("var IMG=path.join(__dirname,'siren.jpg');");
  ln("var IMG_BUF=null;");
  ln("try{if(fs.existsSync(IMG))IMG_BUF=fs.readFileSync(IMG);}catch(_){}");
  ln("var imgMsgs=new Map(),strikes=new Map(),spamTracker=new Map();");
  ln("var lastReplies=[],SILENCE_DELAY=10*60*1000;");
  ln("async function delPrevImg(cid){var mid=imgMsgs.get(cid);if(mid){try{await bot.telegram.deleteMessage(cid,mid);}catch(_){}imgMsgs.delete(cid);}}");
  ln("async function sendImg(cid,caption,extra){await delPrevImg(cid);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(cid,{source:IMG_BUF},Object.assign({caption:caption,parse_mode:'HTML'},extra));imgMsgs.set(cid,m.message_id);return m;}catch(e){IMG_BUF=null;}}return bot.telegram.sendMessage(cid,caption,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDelete(cid,mid,ms){setTimeout(function(){try{bot.telegram.deleteMessage(cid,mid);}catch(_){}},ms);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var now=Date.now(),s=strikes.get(uid);if(!s||now-s.since>86400000){s={count:0,since:now};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid,reason){var s=getStrike(uid);try{await ctx.deleteMessage();}catch(_){}var mem=ctx.message&&ctx.message.from;var tag=mem&&mem.username?'@'+mem.username:mem&&mem.first_name||'user';var why=reason?' ('+reason+')':'';s.count++;if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+86400});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F '+tag+' muted 24h \\u2014 3 strikes'+why+'.');autoDelete(ctx.chat.id,m3.message_id,60000);}else{var mw=await ctx.reply('\\u26A0\\uFE0F '+tag+' warning '+s.count+'/3'+why);autoDelete(ctx.chat.id,mw.message_id,45000);}}");
  ln("async function checkSpam(ctx,uid){var now=Date.now(),t=spamTracker.get(uid)||{c:0,s:now};if(now-t.s>60000)t={c:0,s:now};t.c++;spamTracker.set(uid,t);if(t.c>5){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDelete(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','fuck','bitch','bastard','asshole','cunt','exit scam','dev ran','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("var NOT_LIVE=['"+TICKER+" hasn\\u2019t launched yet. CA coming soon.','Not yet. Stay ready.','CA drops soon.','Hold tight \\u2014 launch incoming.'];");

  // System prompt  used only for AI replies
  ln("function sysPrompt(){");
  ln("  return 'You are the community bot for "+TICKER+", a "+CHAIN_LBL+" meme token.\\n'+");
  ln("    'Token: "+TICKER+" | Chain: "+CHAIN_LBL+"\\n'+");
  ln("    'Supply: "+SUPPLY+" | Max Wallet: "+MAXPCT+(MAXTOK?' ('+MAXTOK+')':'')+"\\n'+");
  ln("    'Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\n'+");
  ln("    'Contract: "+RENOUNCED+" | LP: "+LOCKED+"\\n'+");
  ln("    '"+(IS_CTO?'DEV: CTO project. Original dev gone. Community owns and runs this completely. Say this clearly when asked.':'DEV: Active, building, present. Never imply dev stepped back.')+"\\n'+");
  ln("    'Twitter: '+TWITTER+'\\n'+");
  ln("    'Narrative: '+"+NARR+"+'\\n'+");
  ln("    'Personality: "+PERS_STYLE.replace(/'/g,"\\'")+"\\n'+");
  ln("    'RULES: 2-4 lines max. Natural and professional. Never share TG group link. Never repeat reply. If hype/casual/no question: reply IGNORE exactly.';");
  ln("}");

  ln("async function ask(sys,msg){var r=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',temperature:1.0,max_tokens:160,messages:[{role:'system',content:sys},{role:'user',content:msg}]});return r.choices[0].message.content.trim();}");
  ln("async function smartAsk(msg){var r=await ask(sysPrompt(),msg);if(lastReplies.includes(r))r=await ask(sysPrompt(),msg+' Give a completely different response.');lastReplies.push(r);if(lastReplies.length>12)lastReplies.shift();return r;}");

  // Silence breaker
  ln("var SILENCE_ANGLES=['2-3 lines. Why hold "+TICKER+" right now.','2-3 lines. "+TICKER+" fundamentals.','2-3 lines. Being early to "+TICKER+".','2-3 lines. "+TICKER+" community is building.','2-3 lines. The move in "+TICKER+" is still early.'];");
  ln("var silIdx=0;");
  ln("async function fireSilence(){if(!groupChatId)return resetSilence();try{var p=SILENCE_ANGLES[silIdx%SILENCE_ANGLES.length];silIdx++;var cap=await smartAsk(p);if(cap&&cap!=='IGNORE')await sendImg(groupChatId,cap,{});}catch(_){}resetSilence();}");
  ln("function resetSilence(){if(silenceTimer)clearTimeout(silenceTimer);silenceTimer=setTimeout(fireSilence,SILENCE_DELAY);}");

  // Shoutout
  ln("var SHOUTOUT_ON=false,shoutTimer=null;");
  ln("async function doShoutout(){if(!groupChatId||!SHOUTOUT_ON)return;try{var admins=await bot.telegram.getChatAdministrators(groupChatId);var humans=admins.filter(function(a){return!a.user.is_bot;});var names=humans.map(function(a){return a.user.username?'@'+a.user.username:a.user.first_name;});if(!names.length)return schedShoutout();var ppt='1-2 warm lines. Shoutout to admins keeping "+TICKER+" alive: '+names.join(', ')+'. Sound genuine. Tag them.';var msg=await smartAsk(ppt);if(msg&&msg!=='IGNORE'){var sm=await bot.telegram.sendMessage(groupChatId,msg);setTimeout(function(){try{bot.telegram.deleteMessage(groupChatId,sm.message_id);}catch(_){}},7200000);}}catch(_){}schedShoutout();}");
  ln("function schedShoutout(){if(shoutTimer)clearTimeout(shoutTimer);if(!SHOUTOUT_ON)return;var slots=[21600000,43200000,61200000,75600000];var now=Date.now()%86400000;var next=slots.find(function(t){return t>now;});var wait=next!==undefined?next-now:86400000-now+slots[0];wait+=Math.floor(Math.random()*1800000);shoutTimer=setTimeout(doShoutout,wait);}");
  ln("bot.command('shoutout',async function(ctx){var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;var arg=(ctx.message.text||'').split(' ')[1]||'';if(arg.toLowerCase()==='on'){SHOUTOUT_ON=true;schedShoutout();return ctx.reply('\\u2705 Admin shoutouts enabled. Fires 2-4x daily.');}if(arg.toLowerCase()==='off'){SHOUTOUT_ON=false;if(shoutTimer)clearTimeout(shoutTimer);return ctx.reply('\\u274C Admin shoutouts disabled.');}if(arg.toLowerCase()==='now'){await doShoutout();return;}return ctx.reply('Usage: /shoutout on / off / now');});");

  // Commands  CA and X are 100% hardcoded
  ln("bot.command('ca',async function(ctx){");
  ln("  if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);");
  ln("  return sendImg(ctx.chat.id,'<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("});");

  ln("bot.command('x',async function(ctx){return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('twitter',async function(ctx){return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");

  ln("bot.command('socials',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>'+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");

  ln("bot.command('info',function(ctx){return ctx.reply('<b>"+TICKER+"</b> \\u2014 "+CHAIN_LBL+"\\n\\nSupply: "+SUPPLY+"\\nMax Wallet: "+MAXPCT+(MAXTOK?' ('+MAXTOK+')':'')+"\\nTax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\nContract: "+RENOUNCED+" | LP: "+LOCKED+"'+(TWITTER?'\\nTwitter: '+TWITTER:''),{parse_mode:'HTML',disable_web_page_preview:true});});");

  ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDelete(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA hidden.');}var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDelete(ctx.chat.id,m.message_id,10000);});");

  // New members
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}for(var i=0;i<ctx.message.new_chat_members.length;i++){var mem=ctx.message.new_chat_members[i];var handle=mem.username?'@'+mem.username:mem.first_name;var opts=[handle+' joined "+TICKER+".\\n"+RENOUNCED+" \\u2022 LP "+LOCKED+" \\u2022 "+BUYTAX+"%/"+SELLTAX+"% tax\\n'+(caUnlocked?CA:'CA coming soon.'),'Welcome, '+handle+'. '+TICKER+' \\u2022 "+CHAIN_LBL+"\\n'+(caUnlocked?'CA: '+CA:'Launch incoming.')];var msg=opts[Math.floor(Math.random()*opts.length)];var sent=await ctx.reply(msg);autoDelete(ctx.chat.id,sent.message_id,60000);}});");

  // Main message handler
  ln("var CTO_REPLIES=['"+TICKER+" is a CTO. Original dev gone. Community took full ownership. No dev to rug.','CTO project. Dev walked away. Community stepped up and owns "+TICKER+" now. That is the strength.','No dev here. "+TICKER+" is 100% community-owned and driven. Original dev left.'];");
  ln("bot.on('message',async function(ctx){");
  ln("  var msg=ctx.message;if(!msg||!ctx.from)return;");
  ln("  var uid=ctx.from.id,chatType=ctx.chat.type,isPrivate=chatType==='private';");
  ln("  var text=(msg.text||'').trim();");
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}");
  ln("  if(!isPrivate)resetSilence();");
  ln("  var admin=await isAdmin(ctx,uid);");
  ln("  if(!isPrivate&&!admin&&text){var spammed=await checkSpam(ctx,uid);if(spammed)return;if(hasFud(text))return applyStrike(ctx,uid,'no FUD');}");
  ln("  if(!text)return;");
  ln("  var lower=text.toLowerCase();");
  // Dev/CTO  hardcoded
  ln("  if(lower.includes('dev')||lower.includes('cto')||lower.includes('community takeover')||lower.includes('who run')||lower.includes('who own')){");
  ln("    if(IS_CTO)return ctx.reply(CTO_REPLIES[Math.floor(Math.random()*CTO_REPLIES.length)]);");
  ln("    try{var dr=await smartAsk(text);if(dr&&dr!=='IGNORE')return ctx.reply(dr);}catch(_){}return;");
  ln("  }");
  // CA  hardcoded
  ln("  var caWords=['ca','contract address','token address','where is the ca','give ca','drop ca','show ca','contract'];");
  ln("  if(caWords.some(function(w){return lower===w||lower.includes(w);})){");
  ln("    if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);");
  ln("    return sendImg(ctx.chat.id,'<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("  }");
  // X  hardcoded
  ln("  if(lower==='x'||lower==='twitter'||lower.includes('twitter link')||lower.includes('follow on'))return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  // Socials
  ln("  if(lower==='socials'||lower==='links')return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a> | <a href=\\''+TWITTER+'\\'>Twitter</a>',{parse_mode:'HTML',disable_web_page_preview:true});");
  // AI for everything else
  ln("  if(isPrivate){try{var gr=await smartAsk(text);if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}return;}");
  ln("  if(RESPONSE_MODE==='focused'){if(text.indexOf('?')===-1)return;try{var gr2=await smartAsk(text);if(gr2&&gr2!=='IGNORE')return ctx.reply(gr2);}catch(_){}return;}");
  ln("  var tkLow=TICKER.toLowerCase().replace('$','');if(text.indexOf('?')!==-1||lower.includes(tkLow)){try{var gr3=await smartAsk(text);if(gr3&&gr3!=='IGNORE')return ctx.reply(gr3);}catch(_){}}");
  ln("});");

  // Server
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function regWebhook(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{if(await bot.telegram.setWebhook(url)){console.log('Webhook:',url);return;}}catch(e){console.log('Attempt '+(i+1)+':',e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error('Err:',e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error('Rej:',e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('"+TICKER+" bot port '+PORT);try{await new Promise(function(r){setTimeout(r,2000);});}catch(_){}try{await regWebhook();}catch(e){console.log(e.message);}try{resetSilence();}catch(_){}try{schedShoutout();}catch(_){}setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);console.log('"+TICKER+" bot live');});");

  return L.join('\n');
}


//  FACTORY HTTP + STARTUP 
app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});
app.get('/',function(req,res){res.end('OK');});
app.get('/health',function(req,res){res.end('OK');});

async function regWebhook(){
  if(!WEBHOOK_URL){console.log('No WEBHOOK_URL');return;}
  var url=WEBHOOK_URL+'/webhook';
  for(var i=0;i<5;i++){
    try{if(await bot.telegram.setWebhook(url)){console.log('Factory webhook:',url);return;}}
    catch(e){console.log('Webhook attempt '+(i+1)+':',e.message);}
    await sleep(3000);
  }
}
async function getGhOwner(){
  try{var r=await fetch('https://api.github.com/user',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});var d=await r.json();GH_OWNER=d.login||'';console.log('GH owner:',GH_OWNER);}
  catch(e){console.log('GH owner:',e.message);}
}
process.on('uncaughtException',function(e){console.error('Uncaught:',e.message);});
process.on('unhandledRejection',function(e){console.error('Rejection:',e&&e.message);});

app.listen(PORT,async function(){
  console.log('Bot Factory starting on port',PORT);
  try{await sleep(2000);}catch(_){}
  try{await getGhOwner();}catch(e){console.log('GH:',e.message);}
  try{await loadRegistry();}catch(e){console.log('Reg:',e.message);}
  try{await regWebhook();}catch(e){console.log('Hook:',e.message);}
  try{
    await bot.telegram.setMyCommands([
      {command:'build',   description:'Build a new bot'},
      {command:'addbot',  description:'Register existing bot'},
      {command:'bots',    description:'List your bots'},
      {command:'edit',    description:'Edit a bot'},
      {command:'rebuild', description:'Full rebuild from data'},
      {command:'update',  description:'Push latest code'},
      {command:'stats',   description:'Health check'},
      {command:'addgroq', description:'Add Groq API key'},
      {command:'cancel',  description:'Cancel'},
    ]);
  }catch(e){console.log('setMyCommands:',e.message);}
  setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);
  console.log('Bot Factory is live.');
});
