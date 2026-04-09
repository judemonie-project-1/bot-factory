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
var BSCSCAN_KEY=process.env.BSCSCAN_API_KEY||'';
var GH_OWNER='';

var groqPool=[];
for(var _i=1;_i<=10;_i++){var _k=process.env['GROQ_KEY_'+_i];if(_k)groqPool.push(_k.trim());}
var groqIdx=0;
function nextGroq(){if(!groqPool.length)return'';var k=groqPool[groqIdx%groqPool.length];groqIdx++;return k;}

var E={
  check:'\u2705',xmark:'\u274C',gear:'\u2699\uFE0F',fire:'\u{1F525}',
  rocket:'\u{1F680}',party:'\u{1F389}',warn:'\u26A0\uFE0F',link:'\u{1F517}',
  folder:'\u{1F4C2}',wrench:'\u{1F527}',shield:'\u{1F6E1}',robot:'\u{1F916}',
  star:'\u2B50',pencil:'\u270F\uFE0F',chart:'\u{1F4CA}',bnb:'\u{1F7E1}',
  sol:'\u{1F7E3}',list:'\u{1F4CB}',money:'\u{1F4B0}',copy:'\u{1F4CB}',
  search:'\u{1F50D}',
};

var CHAIN={
  bsc:{label:'BNB Smart Chain (BSC)',dex:'PancakeSwap',
    dexUrl:'https://pancakeswap.finance/swap?outputCurrency=',
    chartBase:'https://dexscreener.com/bsc/',
    explorer:'https://bscscan.com/token/',
    dsNetwork:'bsc'},
  sol:{label:'Solana',dex:'Raydium',
    dexUrl:'https://raydium.io/swap/?outputMint=',
    chartBase:'https://dexscreener.com/solana/',
    explorer:'https://solscan.io/token/',
    dsNetwork:'solana'},
};

var PERS_LABELS={
  alpha:'\u26A1 Alpha',professional:'\u{1F454} Professional',
  hype:'\u{1F525} Hype',community:'\u{1F91D} Community',
};

var bot=new Telegraf(BOT_TOKEN);
var app=express();
app.use(express.json());
var registry=[],sessions={},editSessions={},groqSessions={},ownerChatIds=new Set();

//  HELPERS 
function rnd(n){var c='abcdefghijklmnopqrstuvwxyz0123456789',o='';for(var i=0;i<n;i++)o+=c[Math.floor(Math.random()*c.length)];return o;}
function rndCmd(){return rnd(3)+rnd(3)+rnd(2);}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function fmtSupply(n){
  if(!n||isNaN(n))return'N/A';
  n=parseFloat(n);
  if(n>=1e12)return(n/1e12).toFixed(n%1e12===0?0:2)+'T';
  if(n>=1e9)return(n/1e9).toFixed(n%1e9===0?0:2)+'B';
  if(n>=1e6)return(n/1e6).toFixed(n%1e6===0?0:2)+'M';
  if(n>=1e3)return(n/1e3).toFixed(n%1e3===0?0:2)+'K';
  return String(n);
}
function fmtNum(n){var s=String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g,',');return s;}

//  AUTO-FETCH 
async function fetchAllData(ca,chain){
  var result={
    name:'',ticker:'',supply:'',supplyRaw:0,
    buyTax:'',sellTax:'',twitter:'',
    renounced:false,renouncedText:'NOT RENOUNCED',
    found:false,errors:[],
  };

  // 1. BSCScan  name, ticker, supply, owner (renounced check)
  if(chain==='bsc'){
    try{
      // Token info
      var bUrl='https://api.bscscan.com/api?module=token&action=tokeninfo&contractaddress='+ca+'&apikey='+(BSCSCAN_KEY||'YourApiKeyToken');
      var br=await Promise.race([fetch(bUrl),new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},8000);})]);
      var bd=await br.json();
      if(bd.status==='1'&&bd.result&&bd.result[0]){
        var ti=bd.result[0];
        result.name=ti.tokenName||'';
        result.ticker='$'+(ti.symbol||'TOKEN');
        if(ti.totalSupply&&ti.divisor){
          var raw=parseFloat(ti.totalSupply)/parseFloat(ti.divisor);
          result.supplyRaw=raw;
          result.supply=fmtNum(raw);
        }
        result.found=true;
      }
      // Check if renounced (owner = zero address)
      var oUrl='https://api.bscscan.com/api?module=contract&action=getcontractcreation&contractaddresses='+ca+'&apikey='+(BSCSCAN_KEY||'YourApiKeyToken');
      var or2=await Promise.race([fetch(oUrl),new Promise(function(_,rej){setTimeout(function(){rej(new Error('t'));},6000);})]);
      var od=await or2.json();
      if(od.status==='1'&&od.result&&od.result[0]){
        // Check current owner via read contract
        var rUrl='https://api.bscscan.com/api?module=proxy&action=eth_call&to='+ca+'&data=0x8da5cb5b&apikey='+(BSCSCAN_KEY||'YourApiKeyToken');
        var rr=await Promise.race([fetch(rUrl),new Promise(function(_,rej){setTimeout(function(){rej(new Error('t'));},6000);})]);
        var rd=await rr.json();
        if(rd.result){
          var owner=rd.result.toLowerCase().replace('0x','').replace(/^0+/,'');
          if(!owner||owner==='0'||rd.result==='0x0000000000000000000000000000000000000000000000000000000000000000'){
            result.renounced=true;
            result.renouncedText='RENOUNCED';
          }
        }
      }
    }catch(e){result.errors.push('BSCScan: '+e.message);}
  }

  // 2. DexScreener  tax and twitter
  try{
    var dsNet=CHAIN[chain].dsNetwork;
    var dr=await Promise.race([
      fetch('https://api.dexscreener.com/latest/dex/tokens/'+ca),
      new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},8000);}),
    ]);
    var dd=await dr.json();
    var pairs=(dd.pairs||[]).filter(function(p){return p.chainId===dsNet;});
    if(pairs.length){
      var p=pairs[0];
      if(!result.name&&p.baseToken)result.name=p.baseToken.name||'';
      if(result.ticker==='$TOKEN'&&p.baseToken)result.ticker='$'+(p.baseToken.symbol||'TOKEN');
      result.found=true;
      // Tax
      if(p.txns){
        if(p.info&&p.info.websites){/* skip */}
      }
      // Try to get tax from pair data
      if(p.liquidity&&p.priceNative){
        // Some pairs expose buy/sell tax
        if(typeof p.boosts==='object'&&p.boosts){/* skip */}
      }
      // Twitter/social
      if(p.info&&p.info.socials){
        var tw=p.info.socials.find(function(s){return s.type==='twitter';});
        if(tw)result.twitter=tw.url;
      }
    }
  }catch(e){result.errors.push('DexScreener: '+e.message);}

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
  return{isAdd:!!isAdd,step:'chain',lastMsgId:null,
    d:{chain:'bsc',mode:'full',status:'launch',guardType:'standard',
       personality:'alpha',responseMode:'focused',silenceBreaker:'3600000',
       name:'',ticker:'',ca:'',twitter:'',narrative:'',
       supply:'N/A',buyTax:'5',sellTax:'5',
       maxWalletPct:'',maxWalletTokens:'',
       renounced:'NOT RENOUNCED',locked:'NOT LOCKED',
       revealCmd:'',hideCmd:'',botToken:'',renderUrl:'',repoName:''},
    imgBuf:null,fetchedData:null};
}

//  BUTTON HELPERS 
function chainBtns(uid){return{inline_keyboard:[[{text:E.bnb+' BNB Smart Chain',callback_data:'w_chain_bsc_'+uid},{text:E.sol+' Solana',callback_data:'w_chain_sol_'+uid}]]};}
function modeBtns(uid){return{inline_keyboard:[[{text:E.robot+' Full \u2014 AI + moderation',callback_data:'w_mode_full_'+uid}],[{text:E.shield+' Guard \u2014 moderation only',callback_data:'w_mode_guard_'+uid}]]};}
function gtBtns(uid){return{inline_keyboard:[[{text:'\u26A1 Standard \u2014 3 warnings then mute',callback_data:'w_gt_standard_'+uid}],[{text:'\u{1F6AB} Strict \u2014 1 strike = 24hr mute',callback_data:'w_gt_strict_'+uid}],[{text:'\u{1F9F9} Soft \u2014 delete only, no mutes',callback_data:'w_gt_soft_'+uid}]]};}
function statusBtns(uid){return{inline_keyboard:[[{text:E.rocket+' New launch \u2014 dev is active',callback_data:'w_status_launch_'+uid}],[{text:E.shield+' CTO \u2014 community takeover, dev gone',callback_data:'w_status_cto_'+uid}]]};}
function persBtns(uid){return{inline_keyboard:[
  [{text:'\u26A1 Alpha \u2014 sharp & crypto-native',callback_data:'w_pers_alpha_'+uid}],
  [{text:'\u{1F454} Professional \u2014 clean & precise',callback_data:'w_pers_professional_'+uid}],
  [{text:'\u{1F525} Hype \u2014 high energy & bullish',callback_data:'w_pers_hype_'+uid}],
  [{text:'\u{1F91D} Community \u2014 warm & inclusive',callback_data:'w_pers_community_'+uid}],
]};}
function rmodeBtns(uid){return{inline_keyboard:[
  [{text:'\u{1F3AF} Focused \u2014 project questions only',callback_data:'w_rmode_focused_'+uid}],
  [{text:'\u{1F4AC} Conversational \u2014 responds to ? & mentions',callback_data:'w_rmode_conversational_'+uid}],
]};}
function mwBtns(uid){return{inline_keyboard:[[{text:'No limit (skip)',callback_data:'w_mw_skip_'+uid},{text:'Has limit \u2014 enter %',callback_data:'w_mw_enter_'+uid}]]};}
function lpBtns(uid){return{inline_keyboard:[[{text:'\u2705 Yes \u2014 LP is locked',callback_data:'w_lp_yes_'+uid},{text:'\u274C No \u2014 not locked',callback_data:'w_lp_no_'+uid}]]};}
function skipBtn(uid,step){return{inline_keyboard:[[{text:'Skip',callback_data:'w_skip_'+step+'_'+uid}]]};}
function silBtns(uid){return{inline_keyboard:[
  [{text:'\u{1F507} Off \u2014 never auto-post',callback_data:'w_sil_0_'+uid}],
  [{text:'\u23F1 10 minutes \u2014 very active',callback_data:'w_sil_600000_'+uid}],
  [{text:'\u23F1 30 minutes \u2014 active',callback_data:'w_sil_1800000_'+uid}],
  [{text:'\u23F0 1 hour \u2014 moderate (recommended)',callback_data:'w_sil_3600000_'+uid}],
  [{text:'\u23F0 3 hours \u2014 light touch',callback_data:'w_sil_10800000_'+uid}],
]};}

function taxBtns(uid){return{inline_keyboard:[
  [{text:'No tax (0/0)',callback_data:'w_tax_0_'+uid},{text:'5/5',callback_data:'w_tax_5_'+uid},{text:'10/10',callback_data:'w_tax_10_'+uid}],
  [{text:'Enter manually',callback_data:'w_tax_manual_'+uid}],
]};}

async function delMsg(ctx,id){if(id)try{await ctx.telegram.deleteMessage(ctx.chat.id,id);}catch(_){}}
async function say(ctx,s,text,kb){
  await delMsg(ctx,s.lastMsgId);
  var m=await ctx.reply(text,{parse_mode:'HTML',reply_markup:kb||undefined,disable_web_page_preview:true});
  s.lastMsgId=m.message_id;
}


//  WIZARD STEP MANAGER 
// Steps for full bot build:
// chain > mode > status > pers > rmode > ca > twitter > tax > maxwallet > lp > narrative > img > bottoken [> renderurl if addbot] > confirm
// Steps for guard bot:
// chain > mode > gt > status > ca > twitter > tax > maxwallet > lp > narrative > img > bottoken [> renderurl] > confirm

function nextStep(s){
  var step=s.step,d=s.d,isAdd=s.isAdd;
  var flow=[];
  if(d.mode==='full')
    flow=['chain','mode','status','pers','rmode','sil','ca','twitter','tax','maxwallet','lp','narrative','img','bottoken'];
  else
    flow=['chain','mode','gt','status','sil','ca','twitter','tax','maxwallet','lp','narrative','img','bottoken'];
  if(isAdd&&!d.renderUrl)flow.push('renderurl');
  flow.push('confirm');
  var idx=flow.indexOf(step);
  return idx>=0&&idx+1<flow.length?flow[idx+1]:'confirm';
}

async function showStep(ctx,s,uid){
  var d=s.d,step=s.step;
  if(step==='chain')   return say(ctx,s,'\u{1F3AF} <b>Step 1</b> \u2014 Select chain:',chainBtns(uid));
  if(step==='mode')    return say(ctx,s,'\u{1F4AC} <b>Step 2</b> \u2014 Bot mode:',modeBtns(uid));
  if(step==='gt')      return say(ctx,s,E.shield+' Guard type:',gtBtns(uid));
  if(step==='status')  return say(ctx,s,E.rocket+' Project status:',statusBtns(uid));
  if(step==='pers')    return say(ctx,s,E.star+' Bot personality:',persBtns(uid));
  if(step==='rmode')   return say(ctx,s,'\u{1F4AC} Response mode:',rmodeBtns(uid));
  if(step==='ca')      return say(ctx,s,E.search+' <b>Contract address?</b>\n<i>Paste the CA and I will auto-fetch token data from BSCScan + DexScreener</i>');
  if(step==='twitter') return say(ctx,s,E.pencil+' Twitter/X link?'+(d.twitter?'\n<i>Auto-fetched: '+d.twitter+' \u2014 send new one to change, or tap Skip</i>':'\n<i>Paste the link or tap Skip</i>'),skipBtn(uid,'twitter'));
  if(step==='tax')     return say(ctx,s,E.pencil+' Buy / sell tax?'+(d.buyTax&&d.sellTax&&d.buyTax!=='5'?'\n<i>Auto-detected: '+d.buyTax+'% / '+d.sellTax+'%</i>':''),taxBtns(uid));
  if(step==='maxwallet')return say(ctx,s,E.pencil+' Max wallet limit?',mwBtns(uid));
  if(step==='lp')      return say(ctx,s,E.pencil+' Is LP (liquidity) locked?',lpBtns(uid));
  if(step==='narrative')return say(ctx,s,E.pencil+' Token narrative?\n<i>1-2 sentences. What makes it unique. Used for AI personality.</i>',skipBtn(uid,'narrative'));
  if(step==='img')     return say(ctx,s,E.pencil+' Send bot image (JPG/PNG)\n<i>This is the image shown with CA and X replies</i>',skipBtn(uid,'img'));
  if(step==='bottoken')return say(ctx,s,E.pencil+' <b>BotFather token?</b>\n\n<i>1. Open @BotFather\n2. Send /newbot, enter a name and username (must end in bot)\n3. Copy the token and paste it here</i>');
  if(step==='renderurl')return say(ctx,s,E.pencil+' <b>Render URL?</b>\n<i>e.g. https://mpc-bot.onrender.com</i>');
  if(step==='confirm') return say(ctx,s,buildSummary(s));
}

function buildSummary(s){
  var d=s.d,ci=CHAIN[d.chain]||CHAIN.bsc;
  return (s.isAdd?E.wrench:E.fire)+' <b>Confirm '+(s.isAdd?'registration':'deployment')+'</b>\n\n'+
    '<b>Chain:</b> '+ci.label+'\n'+
    '<b>Mode:</b> '+(d.mode==='guard'?E.shield+' Guard':E.robot+' Full')+'\n'+
    '<b>Status:</b> '+(d.status==='cto'?'\u{1F91D} CTO':E.rocket+' Active dev')+'\n'+
    (d.mode==='full'?'<b>Personality:</b> '+(PERS_LABELS[d.personality]||d.personality)+'\n':'')+
    '<b>Token:</b> '+d.name+' '+d.ticker+'\n'+
    '<b>CA:</b> <code>'+d.ca+'</code>\n'+
    '<b>Supply:</b> '+d.supply+'\n'+
    (d.maxWalletPct?'<b>Max Wallet:</b> '+d.maxWalletPct+'\n':'')+
    '<b>Tax:</b> '+d.buyTax+'% buy / '+d.sellTax+'% sell\n'+
    '<b>Contract:</b> '+d.renounced+'\n'+
    '<b>LP:</b> '+d.locked+'\n'+
    (d.twitter?'<b>Twitter:</b> '+d.twitter+'\n':'')+
    '<b>Image:</b> '+(s.imgBuf?E.check+' ready':'\u2014 none')+'\n'+
    (s.isAdd&&d.renderUrl?'<b>Bot URL:</b> '+d.renderUrl+'\n':'')+
    '\nType <b>yes</b> to '+(s.isAdd?'register':'deploy')+' \u2014 <b>no</b> to cancel.';
}

//  COMMANDS 
bot.command('start',function(ctx){
  ownerChatIds.add(ctx.chat.id);
  return ctx.reply(
    E.rocket+' <b>Bot Factory</b>\n'+
    '<i>The fastest way to launch a Telegram community bot for your token.</i>\n\n'+

    E.gear+' <b>What happens when you build:</b>\n'+
    '\u2022 Token data auto-fetched from BSCScan + DexScreener\n'+
    '\u2022 Bot code generated with your exact details\n'+
    '\u2022 Repository created and code pushed\n'+
    '\u2022 Bot deployed and running automatically\n'+
    '\u2022 Always-on keepalive configured\n'+
    '\u2022 <b>Bot live in ~3 minutes. Zero manual setup.</b>\n\n'+

    E.shield+' <b>Two bot types:</b>\n'+
    '\u2022 <b>Full</b> \u2014 AI-powered replies, moderation, silence breaker, admin shoutouts\n'+
    '\u2022 <b>Guard</b> \u2014 moderation + hardcoded replies, no AI\n\n'+

    E.star+' <b>After building:</b>\n'+
    '\u2022 /edit \u2014 change any detail, pushes instantly\n'+
    '\u2022 /rebuild \u2014 full refresh with stored data\n'+
    '\u2022 /update \u2014 push latest factory improvements\n'+
    '\u2022 Daily report sent every morning automatically\n\n'+

    '<b>Commands</b>\n'+
    '/build \u2014 Build a new bot\n'+
    '/addbot \u2014 Register existing bot\n'+
    '/bots \u2014 List your bots\n'+
    '/edit \u2014 Edit a bot\n'+
    '/rebuild \u2014 Full rebuild from stored data\n'+
    '/update \u2014 Push latest factory improvements\n'+
    '/stats \u2014 Health check all bots\n'+
    '/addgroq \u2014 Add AI key\n'+
    '/cancel \u2014 Cancel current operation',
    {parse_mode:'HTML'}
  );
});
bot.command('cancel',function(ctx){var uid=String(ctx.from.id);delete sessions[uid];delete editSessions[uid];return ctx.reply(E.xmark+' Cancelled.');});
bot.command('addgroq',async function(ctx){var uid=String(ctx.from.id);groqSessions[uid]=true;try{await ctx.deleteMessage();}catch(_){}return ctx.reply(E.gear+' Send your AI API key and it will be added:');});

bot.command(['build','new'],async function(ctx){ownerChatIds.add(ctx.chat.id);
  var uid=String(ctx.from.id);
  sessions[uid]=newSession(false);
  try{await ctx.deleteMessage();}catch(_){}
  await showStep(ctx,sessions[uid],uid);
});
bot.command('addbot',async function(ctx){ownerChatIds.add(ctx.chat.id);
  var uid=String(ctx.from.id);
  sessions[uid]=newSession(true);
  try{await ctx.deleteMessage();}catch(_){}
  // Ask for Render URL first  check if already registered
  var s=sessions[uid];
  s.step='check_url';
  var m=await ctx.reply(
    E.wrench+' <b>Register / update bot</b>\n\n'+
    'Paste the <b>Bot URL</b> of your existing bot:\n'+
    '<i>e.g. https://mpc-bot-31hk.onrender.com</i>\n\n'+
    '<i>If already registered, I will recognize it instantly.</i>',
    {parse_mode:'HTML'}
  );
  s.lastMsgId=m.message_id;
});

bot.command('bots',function(ctx){ownerChatIds.add(ctx.chat.id);
  if(!registry.length)return ctx.reply(E.list+' No bots yet. Use /build.');
  var msg=E.list+' <b>Your Bots</b>\n\n';
  registry.forEach(function(b,i){
    msg+=(i+1)+'. '+E.rocket+' <b>'+b.ticker+'</b> ('+b.chain.toUpperCase()+')\n'+
      '   '+(b.mode==='guard'?E.shield+' Guard':E.robot+' Full')+
      ' \u2022 '+(b.d&&b.d.status==='cto'?'CTO':'Active dev')+'\n'+
      '   '+E.link+' '+b.url+'\n\n';
  });
  return ctx.reply(msg,{parse_mode:'HTML',disable_web_page_preview:true});
});

bot.command('stats',async function(ctx){ownerChatIds.add(ctx.chat.id);
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


//  WIZARD BUTTON CALLBACKS 
function wizardBtn(pattern,field,valueExtractor){
  bot.action(new RegExp(pattern),async function(ctx){
    await ctx.answerCbQuery();
    var m=ctx.match;
    var uid=m[m.length-1];
    var s=sessions[uid];
    if(!s)return ctx.reply(E.xmark+' Session expired. Use /build again.');
    var val=valueExtractor?valueExtractor(m):m[1];
    s.d[field]=val;
    s.step=nextStep(s);
    try{await ctx.deleteMessage();}catch(_){}
    await showStep(ctx,s,uid);
  });
}

wizardBtn('^w_chain_(bsc|sol)_(.+)$','chain');
wizardBtn('^w_gt_(standard|strict|soft)_(.+)$','guardType');
wizardBtn('^w_status_(launch|cto)_(.+)$','status');
wizardBtn('^w_pers_(alpha|professional|hype|community)_(.+)$','personality');
wizardBtn('^w_rmode_(focused|conversational)_(.+)$','responseMode');
wizardBtn('^w_lp_(yes|no)_(.+)$','locked',function(m){return m[1]==='yes'?'LOCKED':'NOT LOCKED';});

bot.action(/^w_mode_(full|guard)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.mode=ctx.match[1];
  s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}
  await showStep(ctx,s,uid);
});

// Tax buttons
bot.action(/^w_tax_0_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  s.d.buyTax='0';s.d.sellTax='0';s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}await showStep(ctx,s,uid);
});
bot.action(/^w_tax_5_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  s.d.buyTax='5';s.d.sellTax='5';s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}await showStep(ctx,s,uid);
});
bot.action(/^w_tax_10_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  s.d.buyTax='10';s.d.sellTax='10';s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}await showStep(ctx,s,uid);
});
bot.action(/^w_tax_manual_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  try{await ctx.deleteMessage();}catch(_){}
  var m=await ctx.reply(E.pencil+' Enter tax as <b>buy/sell</b>\n<i>e.g. 5/5 or 3/7</i>',{parse_mode:'HTML'});
  s.lastMsgId=m.message_id;s.step='tax_manual';
});

// Max wallet buttons
bot.action(/^w_sil_(\d+)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var val=ctx.match[1],uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.silenceBreaker=val;s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}
  await showStep(ctx,s,uid);
});

bot.action(/^w_mw_skip_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  s.d.maxWalletPct='';s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}await showStep(ctx,s,uid);
});
bot.action(/^w_mw_enter_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  try{await ctx.deleteMessage();}catch(_){}
  var m=await ctx.reply(E.pencil+' Enter max wallet %\n<i>e.g. 4.9</i>',{parse_mode:'HTML'});
  s.lastMsgId=m.message_id;s.step='maxwallet_manual';
});

// Skip buttons
bot.action(/^w_skip_(\w+)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();var field=ctx.match[1],uid=ctx.match[2],s=sessions[uid];if(!s)return;
  if(field==='twitter')s.d.twitter='';
  if(field==='narrative')s.d.narrative='';
  if(field==='img')s.imgBuf=null;
  s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}await showStep(ctx,s,uid);
});

//  EDIT SYSTEM 
bot.command('edit',async function(ctx){
  if(!registry.length)return ctx.reply(E.wrench+' No bots to edit.');
  var kb=registry.map(function(b,i){return[{text:b.ticker+' ('+b.chain.toUpperCase()+')',callback_data:'epk_'+i}];});
  return ctx.reply(E.wrench+' <b>Which bot?</b>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^epk_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];
  if(!b)return ctx.reply('Not found.');
  var uid=String(ctx.from.id);editSessions[uid]={idx:i};
  var d=b.d||{};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.wrench+' <b>Edit '+b.ticker+'</b>\nWhat to change?',{parse_mode:'HTML',reply_markup:{inline_keyboard:[
    [{text:'Twitter/X link',callback_data:'ef_twitter_'+i}],
    [{text:'Narrative',callback_data:'ef_narrative_'+i}],
    [{text:'Supply',callback_data:'ef_supply_'+i}],
    [{text:'Tax (buy/sell)',callback_data:'ef_tax_'+i}],
    [{text:'Max wallet %',callback_data:'ef_maxwallet_'+i}],
    [{text:'Renounced: '+(d.renounced||'NOT RENOUNCED'),callback_data:'ef_ren_'+i}],
    [{text:'LP Locked: '+(d.locked||'NOT LOCKED'),callback_data:'ef_lp_'+i}],
    [{text:'Bot image',callback_data:'ef_image_'+i}],
    [{text:(d.status==='cto'?E.rocket+' Switch to Launch':E.shield+' Switch to CTO'),callback_data:'ef_cto_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
  ]}});
});

bot.action(/^ef_(twitter|narrative|supply|tax|maxwallet)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var field=ctx.match[1],i=parseInt(ctx.match[2]),uid=String(ctx.from.id);
  editSessions[uid]={idx:i,field:field};
  var asks={twitter:'New Twitter/X link:',narrative:'New narrative (1-2 sentences):',supply:'New supply (e.g. 1B or 1,000,000,000):',tax:'New tax as buy/sell (e.g. 5/5):',maxwallet:'New max wallet % (e.g. 4.9 or - to remove):'};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.pencil+' '+asks[field]);
});
bot.action(/^ef_image_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),uid=String(ctx.from.id);
  editSessions[uid]={idx:i,field:'image'};try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.pencil+' Send new bot image (photo):');
});
bot.action(/^ef_sil_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return ctx.reply('Not found.');
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply('\u23F0 Silence breaker setting:',{reply_markup:{inline_keyboard:[
    [{text:'\u{1F507} Off',callback_data:'esl_0_'+i}],
    [{text:'10 minutes',callback_data:'esl_600000_'+i}],
    [{text:'30 minutes',callback_data:'esl_1800000_'+i}],
    [{text:'1 hour (recommended)',callback_data:'esl_3600000_'+i}],
    [{text:'3 hours',callback_data:'esl_10800000_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
  ]}});
});

bot.action(/^esl_(\d+)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var val=ctx.match[1],i=parseInt(ctx.match[2]),b=registry[i];if(!b)return ctx.reply('Not found.');
  b.d=b.d||{};b.d.silenceBreaker=val;
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'silence breaker updated');
});

bot.action(/^ef_ren_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.renounced=b.d.renounced==='RENOUNCED'?'NOT RENOUNCED':'RENOUNCED';
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'renounced toggled to '+b.d.renounced);
});
bot.action(/^ef_lp_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.locked=b.d.locked==='LOCKED'?'NOT LOCKED':'LOCKED';
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'LP toggled to '+b.d.locked);
});
bot.action(/^ef_cto_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.status=b.d.status==='cto'?'launch':'cto';
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'switched to '+(b.d.status==='cto'?'CTO':'Launch')+' mode');
});
bot.action('ecancel',async function(ctx){
  await ctx.answerCbQuery();delete editSessions[String(ctx.from.id)];
  try{await ctx.deleteMessage();}catch(_){}return ctx.reply(E.xmark+' Cancelled.');
});

async function pushAndSave(ctx,b,what){
  await ctx.reply(E.gear+' Updating...');
  if(b.repoName&&b.ghOwner){
    try{
      await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain]||CHAIN.bsc,b.mode)));
      saveRegistry();
      return ctx.reply(
        E.check+' <b>'+b.ticker+'</b> \u2014 '+what+'!\n'+
        E.rocket+' Deploying \u2014 bot will be live in ~2 min.',
        {parse_mode:'HTML'}
      );
    }catch(e){return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  saveRegistry();
  return ctx.reply(E.check+' Saved. Use /rebuild to push to bot.');
}

//  REBUILD / UPDATE 
bot.command('rebuild',async function(ctx){
  var el=registry.filter(function(b){return b.repoName&&b.ghOwner&&b.d&&b.d.ticker;});
  if(!el.length)return ctx.reply(E.wrench+' No bots with data. Use /addbot first.');
  var kb=el.map(function(b){var i=registry.indexOf(b);return[{text:b.ticker+' ('+b.chain.toUpperCase()+')',callback_data:'rbd_'+i}];});
  return ctx.reply(E.gear+' <b>Full rebuild from stored data:</b>\n<i>Use after changing personality, CTO mode, silence breaker etc via /edit</i>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^rbd_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();try{await ctx.deleteMessage();}catch(_){}
  var b=registry[parseInt(ctx.match[1])];
  if(!b||!b.repoName||!b.ghOwner)return ctx.reply(E.xmark+' No repo linked.');
  await ctx.reply(E.gear+' Rebuilding <b>'+b.ticker+'</b>...',{parse_mode:'HTML'});
  try{
    await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain]||CHAIN.bsc,b.mode)));
    await githubUpdate(b.ghOwner,b.repoName,'package.json',Buffer.from(genPkg(b.d.name,b.mode)));
    // Try to also rename image from siren.jpg to ticker name if needed
    try{
      var tickerFile=(b.ticker||'token').replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+'.jpg';
      var sirenR=await fetch('https://api.github.com/repos/'+b.ghOwner+'/'+b.repoName+'/contents/siren.jpg',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
      if(sirenR.ok){
        var sirenD=await sirenR.json();
        if(sirenD.content){
          var imgBuf=Buffer.from(sirenD.content.replace(/\s/g,''),'base64');
          await githubUpdate(b.ghOwner,b.repoName,tickerFile,imgBuf);
        }
      }
    }catch(_){}
    return ctx.reply(
      E.check+' <b>'+b.ticker+'</b> successfully rebuilt!\n\n'+
      E.gear+' Code pushed successfully.\n'+
      E.rocket+' Deploying \u2014 bot will be live in ~2 min.\n\n'+
      '<i>Check /stats after 2 min to confirm it is online.</i>',
      {parse_mode:'HTML'}
    );
  }catch(e){return ctx.reply(E.xmark+' Failed: '+e.message);}
});

bot.command('update',async function(ctx){
  var ok=registry.filter(function(b){return b.repoName&&b.ghOwner&&b.d&&b.d.ticker;});
  if(!ok.length)return ctx.reply(E.wrench+' No bots with data. Use /addbot.');
  var kb=ok.map(function(b){var i=registry.indexOf(b);return[{text:b.ticker,callback_data:'upd_'+i}];});
  kb.push([{text:E.gear+' Update ALL',callback_data:'upd_all'}]);
  return ctx.reply(E.wrench+' <b>Push factory improvements to:</b>\n<i>Bug fixes, new features from latest factory version</i>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
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
    try{await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(genBot(b.d,CHAIN[b.chain]||CHAIN.bsc,b.mode)));results.push(E.check+' <b>'+b.ticker+'</b>');}
    catch(e){results.push(E.xmark+' <b>'+b.ticker+'</b>: '+e.message.slice(0,60));}
  }
  return ctx.reply(results.join('\n')+'\n\nBot is being updated automatically.',{parse_mode:'HTML'});
});


//  PHOTO HANDLER 
bot.on('photo',async function(ctx){
  var uid=String(ctx.from.id);
  // Edit image
  var es=editSessions[uid];
  if(es&&es.field==='image'){
    var b=registry[es.idx];if(!b)return;
    if(!b.repoName||!b.ghOwner){delete editSessions[uid];return ctx.reply(E.warn+' No repo linked.');}
    var ph=ctx.message.photo[ctx.message.photo.length-1];
    try{var lnk=await ctx.telegram.getFileLink(ph.file_id);var rb=await fetch(lnk.href);var buf=Buffer.from(await rb.arrayBuffer());
      await ctx.reply(E.gear+' Updating image...');
      var eImgFile=(b.ticker||'token').replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+'.jpg';
      await githubUpdate(b.ghOwner,b.repoName,eImgFile,buf);
      delete editSessions[uid];return ctx.reply(E.check+' Image updated! Deploying \u2014 bot will be live shortly.');
    }catch(e){delete editSessions[uid];return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  // Wizard image
  var s=sessions[uid];
  if(!s||s.step!=='img')return;
  var ph2=ctx.message.photo[ctx.message.photo.length-1];
  try{var lnk2=await ctx.telegram.getFileLink(ph2.file_id);var rb2=await fetch(lnk2.href);s.imgBuf=Buffer.from(await rb2.arrayBuffer());}
  catch(e){return ctx.reply(E.xmark+' Image error: '+e.message);}
  try{await ctx.deleteMessage();}catch(_){}
  s.step=nextStep(s);
  await showStep(ctx,s,uid);
});

//  TEXT HANDLER 
bot.on('text',async function(ctx){
  var uid=String(ctx.from.id);
  var text=(ctx.message.text||'').trim();
  if(text.startsWith('/'))return;

  // Groq key
  if(groqSessions[uid]){
    delete groqSessions[uid];try{await ctx.deleteMessage();}catch(_){}
    if(text.length<20)return ctx.reply(E.xmark+' Invalid key. Try /addgroq again.');
    groqPool.push(text.trim());
    return ctx.reply(E.check+' AI key added! Pool: '+groqPool.length+' key(s).');
  }

  // Edit text fields
  var es=editSessions[uid];
  if(es&&es.field&&es.field!=='image'){
    var b=registry[es.idx];if(!b){delete editSessions[uid];return;}
    try{await ctx.deleteMessage();}catch(_){}
    b.d=b.d||{};
    if(es.field==='twitter')  b.d.twitter=text;
    if(es.field==='narrative')b.d.narrative=text;
    if(es.field==='supply')   b.d.supply=text;
    if(es.field==='maxwallet')b.d.maxWalletPct=(text==='-'?'':text);
    if(es.field==='tax'){var tx=text.split('/');b.d.buyTax=(tx[0]||'5').trim();b.d.sellTax=(tx[1]||tx[0]||'5').trim();}
    await pushAndSave(ctx,b,es.field+' updated');
    delete editSessions[uid];
    return;
  }

  // Wizard
  var s=sessions[uid];
  if(!s)return ctx.reply('Use /build or /addbot to start. Type /start for help.');
  try{await ctx.deleteMessage();}catch(_){}
  try{if(s.lastMsgId)await ctx.telegram.deleteMessage(ctx.chat.id,s.lastMsgId);}catch(_){}
  s.lastMsgId=null;

  //  Check URL step for /addbot 
  if(s.step==='check_url'){
    var url=text.trim().replace(/\/+$/,'').replace(/\s/g,'');
    if(!url.startsWith('http')){
      var em=await ctx.reply(E.xmark+' Please paste the full bot URL (starts with https://).');
      s.lastMsgId=em.message_id;return;
    }
    s.d.renderUrl=url;
    s.d.repoName=(url.match(/https?:\/\/([a-z0-9-]+)\.onrender\.com/)||[])[1]||'';
    var norm=function(u){return u.replace(/\/+$/,'').toLowerCase();};
    var existing=registry.findIndex(function(b){return norm(b.url)===norm(url);});
    if(existing>=0){
      var eb=registry[existing];var ed=eb.d||{};
      delete sessions[uid];
      return ctx.reply(
        E.check+' <b>'+eb.ticker+'</b> recognized!\n\n'+
        '<b>All data is stored:</b>\n'+
        E.check+' Name: '+(ed.name||eb.ticker)+'\n'+
        E.check+' CA: '+((ed.ca||'').slice(0,10)+'...')+'\n'+
        E.check+' Supply: '+(ed.supply||'N/A')+'\n'+
        E.check+' Tax: '+(ed.buyTax||'?')+'% / '+(ed.sellTax||'?')+'%\n'+
        E.check+' Contract: '+(ed.renounced||'?')+'\n'+
        E.check+' LP: '+(ed.locked||'?')+'\n\n'+
        E.rocket+' <b>What to do next:</b>\n'+
        '\u2022 /rebuild \u2014 push latest code to bot\n'+
        '\u2022 /edit \u2014 update any details\n'+
        '\u2022 /stats \u2014 check if bot is online',
        {parse_mode:'HTML'}
      );
    }
    // Not found  continue with full wizard
    s.step='chain';
    await say(ctx,s,E.wrench+' Bot not found. Let\'s set it up.\n\nStep 1 \u2014 Select chain:',chainBtns(uid));
    return;
  }

    var btn_steps=['chain','mode','gt','status','pers','rmode','sil','tax','maxwallet','lp'];
  if(btn_steps.includes(s.step)){
    var mb=await ctx.reply('Please tap one of the buttons above.');s.lastMsgId=mb.message_id;return;
  }

  if(s.step==='confirm'){
    if(/^yes$/i.test(text)){return s.isAdd?doRegister(ctx,s,uid):doBuild(ctx,s,uid);}
    delete sessions[uid];return ctx.reply(E.xmark+' Cancelled. Use /build or /addbot to start again.');
  }

  if(s.step==='img'){
    var mi=await ctx.reply('Send a photo, or tap Skip.',{reply_markup:skipBtn(uid,'img')});
    s.lastMsgId=mi.message_id;return;
  }

  // CA step  fetch data
  if(s.step==='ca'){
    s.d.ca=text.trim();
    var fm=await ctx.reply(E.search+' Fetching token data from BSCScan + DexScreener...');
    var data=await fetchAllData(s.d.ca,s.d.chain);
    try{await ctx.telegram.deleteMessage(ctx.chat.id,fm.message_id);}catch(_){}
    s.fetchedData=data;
    if(data.found){
      if(data.name)s.d.name=data.name;
      if(data.ticker&&data.ticker!=='$TOKEN')s.d.ticker=data.ticker;
      if(data.supply)s.d.supply=data.supply;
      if(data.twitter)s.d.twitter=data.twitter;
      if(data.renouncedText)s.d.renounced=data.renouncedText;
      var foundMsg=E.check+' <b>Token data found!</b>\n\n'+
        '<b>Name:</b> '+data.name+'\n'+
        '<b>Ticker:</b> '+data.ticker+'\n'+
        (data.supply?'<b>Supply:</b> '+data.supply+'\n':'')+
        (data.twitter?'<b>Twitter:</b> '+data.twitter+'\n':'')+
        '<b>Contract:</b> '+data.renouncedText+'\n'+
        (data.errors.length?'\n<i>Note: '+data.errors.join(', ')+'</i>':'');
      var fm2=await ctx.reply(foundMsg,{parse_mode:'HTML'});
      await sleep(3000);
      try{await ctx.telegram.deleteMessage(ctx.chat.id,fm2.message_id);}catch(_){}
    } else {
      var nf=await ctx.reply(E.warn+' Token not found yet on BSCScan/DexScreener.\n\nThis could mean:\n\u2022 Token just launched (give it a few minutes)\n\u2022 Wrong CA or wrong chain selected\n\nContinuing with manual entry...',{parse_mode:'HTML'});
      await sleep(3000);try{await ctx.telegram.deleteMessage(ctx.chat.id,nf.message_id);}catch(_){}
      if(!s.d.ticker)s.d.ticker='$TOKEN';
      if(!s.d.name)s.d.name='Token';
    }
    s.step=nextStep(s);
    await showStep(ctx,s,uid);
    return;
  }

  // Twitter
  if(s.step==='twitter'){
    var tw=text.trim();
    // Validate  reject if it looks like a render URL
    if(tw.includes('onrender.com')||tw==='-')tw='';
    s.d.twitter=tw;
    s.step=nextStep(s);await showStep(ctx,s,uid);return;
  }
  // Narrative
  if(s.step==='narrative'){s.d.narrative=text;s.step=nextStep(s);await showStep(ctx,s,uid);return;}
  // Tax manual
  if(s.step==='tax_manual'){
    var tx2=text.split('/');s.d.buyTax=(tx2[0]||'5').trim();s.d.sellTax=(tx2[1]||tx2[0]||'5').trim();
    s.step='maxwallet';await showStep(ctx,s,uid);return;
  }
  // Max wallet manual
  if(s.step==='maxwallet_manual'){
    s.d.maxWalletPct=text.endsWith('%')?text:text+'%';
    s.step='lp';await showStep(ctx,s,uid);return;
  }
  // Bot token
  if(s.step==='bottoken'){s.d.botToken=text.trim();s.step=nextStep(s);await showStep(ctx,s,uid);return;}
  // Render URL
  if(s.step==='renderurl'){
    s.d.renderUrl=text.trim().replace(/\/+$/,'');
    var match=s.d.renderUrl.match(/https?:\/\/([a-z0-9-]+)\.onrender\.com/);
    s.d.repoName=match?match[1]:'';
    s.step=nextStep(s);await showStep(ctx,s,uid);return;
  }
});

//  BUILD + REGISTER 
async function doBuild(ctx,s,uid){
  var d=s.d,ci=CHAIN[d.chain]||CHAIN.bsc;
  var groqKey=d.mode==='full'?nextGroq():'';
  if(d.mode==='full'&&!groqKey)return ctx.reply(E.xmark+' No AI key found. Add one with /addgroq first.');
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
      var imgFile=d.ticker.replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+'.jpg';
      if(s.imgBuf)await githubPush(ghOwner,repoName,imgFile,s.imgBuf);
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
    try{await steps[i].fn();await ctx.reply(E.check+' '+steps[i].n+' done');}
    catch(e){await ctx.reply(E.xmark+' '+steps[i].n+' failed\n<code>'+e.message.slice(0,200)+'</code>',{parse_mode:'HTML'});ok=false;break;}
  }
  if(ok){
    registry.push({ticker:d.ticker,chain:d.chain,mode:d.mode,repoName:repoName,ghOwner:ghOwner,svcId:svcId,url:actualUrl,d:JSON.parse(JSON.stringify(d)),builtAt:Date.now()});
    saveRegistry();delete sessions[uid];
    await ctx.reply(
      E.party+' <b>'+d.ticker+' is live!</b>\n\n'+
      E.link+' Bot URL:\n<code>'+actualUrl+'</code>\n\n'+
      
      E.warn+' <b>Secret commands \u2014 save these:</b>\n'+
      'Reveal CA: <code>/'+d.revealCmd+'</code>\n'+
      'Hide CA:   <code>/'+d.hideCmd+'</code>\n\n'+
      '<b>Next steps:</b>\n'+
      '1. Wait 3-5 min for bot to build\n'+
      '2. Add bot to your Telegram group\n'+
      '3. Make it admin (delete messages + restrict)\n'+
      '4. Use <code>/'+d.revealCmd+'</code> in group to reveal CA',
      {parse_mode:'HTML',disable_web_page_preview:true}
    );
  }else{delete sessions[uid];}
}

async function doRegister(ctx,s,uid){
  var d=s.d;
  var pm=await ctx.reply(E.gear+' Registering <b>'+d.ticker+'</b>...',{parse_mode:'HTML'});
  await sleep(300);try{await ctx.telegram.deleteMessage(ctx.chat.id,pm.message_id);}catch(_){}
  var existing=registry.findIndex(function(b){return b.url===d.renderUrl||b.ticker===d.ticker;});
  if(existing>=0){
    registry[existing].d=JSON.parse(JSON.stringify(d));
    registry[existing].repoName=d.repoName||registry[existing].repoName;
    registry[existing].chain=d.chain;registry[existing].mode=d.mode;
    saveRegistry();delete sessions[uid];
    return ctx.reply(
      E.check+' <b>'+d.ticker+'</b> updated successfully!\n\n'+
      'All token data has been stored.\n\n'+
      E.rocket+' <b>Next step:</b>\n'+
      'Send /rebuild to push fresh code to the bot.',
      {parse_mode:'HTML'}
    );
  }
  registry.push({ticker:d.ticker,chain:d.chain,mode:d.mode,repoName:d.repoName,ghOwner:GH_OWNER,url:d.renderUrl,d:JSON.parse(JSON.stringify(d)),builtAt:Date.now()});
  saveRegistry();delete sessions[uid];
  return ctx.reply(
    E.check+' <b>'+d.ticker+'</b> registered successfully!\n\n'+
    'All token data has been stored.\n\n'+
    E.rocket+' <b>Next steps:</b>\n'+
    '\u2022 /rebuild \u2014 push code to your bot\n'+
    '\u2022 /edit \u2014 update any details\n'+
    '\u2022 /stats \u2014 check if bot is online',
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
    try{
      var r=await fetch('https://api.github.com/repos/'+owner+'/'+repo+'/contents/'+file,{method:'PUT',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify({message:'Add '+file,content:content.toString('base64')})});
      var d=await r.json();if(d.content||d.commit)return d;lastErr=new Error('Push: '+JSON.stringify(d).slice(0,100));
    }catch(e){lastErr=e;}
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
function genBot(d,ci,mode){return mode==='guard'?genGuard(d,ci):genFull(d,ci);}


//  GUARD BOT GENERATOR 
function genGuard(d,ci){
  var TICKER=d.ticker||'$TOKEN';
  var CA=d.ca||'';
  var SUPPLY=d.supply||'N/A';
  var MAXPCT=d.maxWalletPct||'';
  var BUYTAX=d.buyTax||'0';
  var SELLTAX=d.sellTax||'0';
  var TWITTER=d.twitter||'';
  var WEBSITE=d.website||'';
  var RENOUNCED=d.renounced||'NOT RENOUNCED';
  var LOCKED=d.locked||'NOT LOCKED';
  var IS_CTO=d.status==='cto';
  var REVEAL=(d.revealCmd||'revealca').replace(/^\//,'');
  var HIDE=(d.hideCmd||'hideca').replace(/^\//,'');
  var GT=d.guardType||'standard';
  var CHAIN_LBL=ci.label;
  var DEX=ci.dex;
  var CHART=ci.chartBase+CA;
  var BUY_URL=ci.dexUrl+CA;

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
  ln("var app=express();app.use(express.json());");
  ln("var _SF='/tmp/state.json';");
  ln("var caUnlocked=false,groupChatId=null;");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("loadState();");
  ln("var _IMG1=path.join(__dirname,'"+(d.ticker.replace(/\\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase())+".jpg');");
  ln("var _IMG2=path.join(__dirname,'siren.jpg');");
  ln("var IMG=fs.existsSync(_IMG1)?_IMG1:(fs.existsSync(_IMG2)?_IMG2:_IMG1);");
  ln("var IMG_BUF=null;try{if(fs.existsSync(IMG))IMG_BUF=fs.readFileSync(IMG);}catch(_){}");
  // IMG_BUF loaded above
  ln("var imgMsgs=new Map(),strikes=new Map(),spamTracker=new Map();");
  ln("async function delPrevImg(cid){var mid=imgMsgs.get(cid);if(mid){try{await bot.telegram.deleteMessage(cid,mid);}catch(_){}imgMsgs.delete(cid);}}");
  ln("async function sendImg(cid,cap,extra){await delPrevImg(cid);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(cid,{source:IMG_BUF},Object.assign({caption:cap,parse_mode:'HTML'},extra));imgMsgs.set(cid,m.message_id);return m;}catch(e){IMG_BUF=null;}}return bot.telegram.sendMessage(cid,cap,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDel(cid,mid,ms){setTimeout(function(){try{bot.telegram.deleteMessage(cid,mid);}catch(_){}},ms);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var n=Date.now(),s=strikes.get(uid);if(!s||n-s.since>86400000){s={count:0,since:n};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid,reason){var s=getStrike(uid);try{await ctx.deleteMessage();}catch(_){}var mem=ctx.message&&ctx.message.from;var tag=mem&&mem.username?'@'+mem.username:mem&&mem.first_name||'user';var why=reason?' ('+reason+')':'';if(GUARD_TYPE==='soft')return;if(GUARD_TYPE==='strict'){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+86400});}catch(_){}var ms=await ctx.reply('\\u26A0\\uFE0F '+tag+' muted 24h'+why+'.');autoDel(ctx.chat.id,ms.message_id,45000);return;}s.count++;if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+86400});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F '+tag+' muted 24h \\u2014 3 strikes'+why+'.');autoDel(ctx.chat.id,m3.message_id,60000);}else{var mw=await ctx.reply('\\u26A0\\uFE0F '+tag+' warning '+s.count+'/3'+why);autoDel(ctx.chat.id,mw.message_id,45000);}}");
  ln("async function checkSpam(ctx,uid){var n=Date.now(),t=spamTracker.get(uid)||{c:0,s:n};if(n-t.s>60000)t={c:0,s:n};t.c++;spamTracker.set(uid,t);if(t.c>5){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDel(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','fuck','bitch','bastard','asshole','cunt','exit scam','dev ran','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("var NOT_LIVE=['"+TICKER+" hasn\\u2019t launched yet. CA coming soon.','Not yet. Stay ready.','CA drops soon. Hold tight.'];");
  ln("var CTO_REPLIES=['"+TICKER+" is a CTO. Original dev gone. Community owns and runs this completely.','CTO project. Dev walked away. Community stepped up. The holders are the team.','No dev here. "+TICKER+" is 100% community-owned. Original dev left. Community drives this.'];");
  // Commands
  ln("bot.command('ca',async function(ctx){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});});");
  ln("bot.command('x',async function(ctx){return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('twitter',async function(ctx){return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('socials',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('info',function(ctx){return ctx.reply('<b>"+TICKER+"</b> \\u2014 "+CHAIN_LBL+"\\n\\nSupply: "+SUPPLY+"\\n"+(MAXPCT?'Max Wallet: '+MAXPCT+'\\n':'')+"Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\nContract: "+RENOUNCED+"\\nLP: "+LOCKED+"'+(TWITTER?'\\nTwitter: '+TWITTER:''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var a=await isAdmin(ctx,ctx.from.id);if(!a)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDel(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA hidden.');}var a=await isAdmin(ctx,ctx.from.id);if(!a)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDel(ctx.chat.id,m.message_id,10000);});");
  ln("bot.on('new_chat_members',async function(ctx){");
  ln("  if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;");
  ln("  try{await ctx.deleteMessage();}catch(_){}") ;
  ln("  for(var i=0;i<ctx.message.new_chat_members.length;i++){");
  ln("    var mem=ctx.message.new_chat_members[i];");
  ln("    var h=mem.username?'@'+mem.username:mem.first_name;");
  ln("    var wg='Welcome to "+TICKER+", '+h+'! Great to have you here.';");
  ln("    var ws=await ctx.reply(wg);autoDel(ctx.chat.id,ws.message_id,120000);");
  ln("  }");
  ln("});");
  ln("var chatHistory=[];");
  ln("function addHistory(text){chatHistory.push(text);if(chatHistory.length>8)chatHistory.shift();}") ;
  ln("async function isGroupMember(chatId,uid){try{var m=await bot.telegram.getChatMember(chatId,uid);return ['member','administrator','creator','restricted'].includes(m.status);}catch(_){return false;}}");
  ln("function hasExternalMention(text,entities,chatMembers){");
  ln("  if(!entities)return false;");
  ln("  return entities.some(function(e){return e.type==='mention';});");
  ln("}");
  ln("function isPromoSpam(text){");
  ln("  var t=text.toLowerCase();");
  ln("  var promoWords=['dm me','dm:','t.me/','join our','join now','pump call','100x','1000x','send me','contact me','legitimate','serious project','long-term promo','promotion','signal','call group','whale','airdrop only','giveaway','free token'];");
  ln("  return promoWords.some(function(w){return t.includes(w);});");
  ln("}");
  ln("bot.on('message',async function(ctx){");
  ln("  var msg=ctx.message;if(!msg||!ctx.from)return;");
  ln("  var uid=ctx.from.id,isPrivate=ctx.chat.type==='private';");
  ln("  var text=(msg.text||msg.caption||'')\.trim();");
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}") ;
  ln("  if(!isPrivate)resetSil();");
  ln("  var admin=await isAdmin(ctx,uid);");
  ln("  if(!isPrivate){");
  ln("    var isForward=msg.forward_from||msg.forward_sender_name||msg.forward_from_chat||msg.forward_from_message_id;");
  ln("    if(isForward&&!admin){try{await ctx.deleteMessage();}catch(_){}var wf=await ctx.reply('\\u26A0\\uFE0F No forwarded messages.');autoDel(ctx.chat.id,wf.message_id,8000);return;}");
  ln("    if(text&&hasExternalMention(text,msg.entities)&&!admin){");
  ln("      var allMentions=msg.entities.filter(function(e){return e.type==='mention';}).map(function(e){return text.substr(e.offset,e.length);});");
  ln("      var isExternal=allMentions.some(function(m){return m.toLowerCase()!=='@'+ctx.botInfo.username.toLowerCase();});");
  ln("      if(isExternal){try{await ctx.deleteMessage();}catch(_){}var wm2=await ctx.reply('\\u26A0\\uFE0F No external mentions or promotions.');autoDel(ctx.chat.id,wm2.message_id,8000);return;}");
  ln("    }");
  ln("    if(text&&isPromoSpam(text)&&!admin){try{await ctx.deleteMessage();}catch(_){}var wps=await ctx.reply('\\u26A0\\uFE0F Promotional content removed.');autoDel(ctx.chat.id,wps.message_id,8000);return;}");
  ln("    if(text&&hasFud(text)&&!admin)return applyStrike(ctx,uid,'no FUD');");
  ln("    if(text&&!admin){var sp=await checkSpam(ctx,uid);if(sp)return;}");
  ln("  }");
  ln("  if(admin&&!isPrivate){");
  ln("    if(!text)return;");
  ln("    var lower=text.toLowerCase();");
  ln("    var caW=['ca','contract address','contract','token address'];");
  ln("    if(caW.some(function(w){return lower===w||lower.includes(w);})){");
  ln("      if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);");
  ln("      await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("    }");
  ln("    if(lower==='x'||lower==='twitter')return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("    if(lower==='socials'||lower==='links')return ctx.reply('<a href=\\'"+CHART+"\\'> Chart</a> | <a href=\\'"+BUY_URL+"\\'> "+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});");
  ln("    return;");
  ln("  }");
  ln("  if(!text)return;");
  ln("  var lower2=text.toLowerCase();");
  ln("  addHistory(text);");
  ln("  if(lower2.includes('dev')||lower2.includes('cto')||lower2.includes('community takeover')||lower2.includes('who run')||lower2.includes('who own')){");
  ln("    if(IS_CTO)return ctx.reply(CTO_REPLIES[Math.floor(Math.random()*CTO_REPLIES.length)]);");
  ln("    try{var dr=await smartAsk(chatHistory.join('\\n'));if(dr&&dr!=='IGNORE')return ctx.reply(dr);}catch(_){}return;");
  ln("  }");
  ln("  var caWords=['ca','contract address','token address','where is the ca','give ca','show ca','drop ca','contract'];");
  ln("  if(caWords.some(function(w){return lower2===w||lower2.includes(w);})){");
  ln("    if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);");
  ln("    await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("  }");
  ln("  if(lower2==='x'||lower2==='twitter'||lower2.includes('follow on'))return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("  if(lower2==='socials'||lower2==='links')return ctx.reply('<a href=\\'"+CHART+"\\'> Chart</a> | <a href=\\'"+BUY_URL+"\\'> "+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});");
  ln("  if(isPrivate){try{var gr=await smartAsk(chatHistory.join('\\n'));if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}return;}");
  ln("  if(RESPONSE_MODE==='focused'){if(text.indexOf('?')===-1)return;try{var gr2=await smartAsk(chatHistory.join('\\n'));if(gr2&&gr2!=='IGNORE')return ctx.reply(gr2);}catch(_){}return;}");
  ln("  var tkLow=TICKER.toLowerCase().replace('$','');");
  ln("  if(text.indexOf('?')!==-1||lower2.includes(tkLow)){try{var gr3=await smartAsk(chatHistory.join('\\n'));if(gr3&&gr3!=='IGNORE')return ctx.reply(gr3);}catch(_){}}");
  ln("});");

  // Main message handler
  ln("function isPromoSpam(text){var t=text.toLowerCase();var pw=['dm me','dm:','t.me/','join our','join now','pump call','100x','1000x','send me','contact me','legitimate','long-term promo','promotion','signal','call group','whale','airdrop only','giveaway','free token'];return pw.some(function(w){return t.includes(w);});}") ;
  ln("bot.on('message',async function(ctx){");
  ln("  var msg=ctx.message;if(!msg||!ctx.from)return;");
  ln("  var uid=ctx.from.id,isPrivate=ctx.chat.type==='private';");
  ln("  var text=(msg.text||msg.caption||'')\.trim();");
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}");
  ln("  var admin=await isAdmin(ctx,uid);");
  ln("  if(!isPrivate&&!admin){");
  ln("    var isFwd=msg.forward_from||msg.forward_sender_name||msg.forward_from_chat||msg.forward_from_message_id;");
  ln("    if(isFwd){try{await ctx.deleteMessage();}catch(_){}var wf=await ctx.reply('\\u26A0\\uFE0F No forwarded messages.');autoDel(ctx.chat.id,wf.message_id,8000);return;}");
  ln("    if(text&&msg.entities){");
  ln("      var mentions=msg.entities.filter(function(e){return e.type==='mention';});");
  ln("      if(mentions.length>0){try{await ctx.deleteMessage();}catch(_){}var wm=await ctx.reply('\\u26A0\\uFE0F No external mentions or promotions.');autoDel(ctx.chat.id,wm.message_id,8000);return;}");
  ln("    }");
  ln("    if(text&&isPromoSpam(text)){try{await ctx.deleteMessage();}catch(_){}var wps=await ctx.reply('\\u26A0\\uFE0F Promotional content removed.');autoDel(ctx.chat.id,wps.message_id,8000);return;}");
  ln("    if(text&&hasFud(text))return applyStrike(ctx,uid,'no FUD');");
  ln("    var sp=await checkSpam(ctx,uid);if(sp)return;");
  ln("  }");
  ln("  if(admin&&!isPrivate){");
  ln("    if(!text)return;var lower=text.toLowerCase();");
  ln("    var caW=['ca','contract address','contract','token address'];");
  ln("    if(caW.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("    if(lower==='x'||lower==='twitter')return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("    return;");
  ln("  }");
  ln("  if(!text)return;var lower2=text.toLowerCase();");
  ln("  if(lower2.includes('dev')||lower2.includes('cto')||lower2.includes('who run')||lower2.includes('who own')){if(IS_CTO)return ctx.reply(CTO_REPLIES[Math.floor(Math.random()*CTO_REPLIES.length)]);return ctx.reply('Dev is active and building.');}");
  ln("  var caWg=['ca','contract address','token address','where is the ca','give ca','show ca','drop ca','contract'];");
  ln("  if(caWg.some(function(w){return lower2===w||lower2.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("  if(lower2==='x'||lower2==='twitter')return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("  if(lower2.includes('tax'))return ctx.reply('Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell');");
  ln("  if(lower2.includes('supply'))return ctx.reply('Supply: "+SUPPLY+"');");
  ln("});");

  // Server
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function regWH(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{if(await bot.telegram.setWebhook(url)){console.log('Webhook:',url);return;}}catch(e){console.log('WH '+(i+1)+':',e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error(e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error(e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('"+TICKER+" bot port '+PORT);try{await new Promise(function(r){setTimeout(r,2000);});}catch(_){}try{await regWH();}catch(e){console.log(e.message);}if(parseInt(SIL_DELAY||'0')>0)try{resetSil();}catch(_){}try{schedShout();}catch(_){}setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);console.log('"+TICKER+" bot live');});");
  return L.join('\n');
}

//  FACTORY STARTUP 
//  DAILY REPORT 
async function sendDailyReport(){
  if(!registry.length||!ownerChatIds.size)return;
  var lines=[E.chart+' <b>Daily Bot Report</b>\n'];
  var anyOffline=false;
  for(var i=0;i<registry.length;i++){
    var b=registry[i];var ok=false;
    try{
      var r=await Promise.race([
        fetch(b.url+'/health'),
        new Promise(function(_,rej){setTimeout(function(){rej(new Error('t'));},8000);}),
      ]);
      ok=r&&r.ok;
    }catch(_){}
    lines.push((i+1)+'. <b>'+b.ticker+'</b> \u2014 '+(ok?E.check+' Online':E.xmark+' Offline'));
    if(!ok)anyOffline=true;
  }
  lines.push('');
  if(anyOffline){
    lines.push(E.warn+' <b>Action needed:</b>');
    lines.push('One or more bots are offline.');
    lines.push('\u2022 /stats \u2014 see details');
    lines.push('\u2022 /rebuild \u2014 push fresh code');
    lines.push('\u2022 Contact support if issue persists');
  } else {
    lines.push(E.check+' All bots are running smoothly.');
  }
  var msg=lines.join('\n');
  for(var cid of ownerChatIds){
    try{await bot.telegram.sendMessage(cid,msg,{parse_mode:'HTML'});}catch(_){}
  }
}
function scheduleDailyReport(){
  var now=new Date();
  var next=new Date();
  next.setUTCHours(9,0,0,0);
  if(next<=now)next.setUTCDate(next.getUTCDate()+1);
  var wait=next.getTime()-now.getTime();
  setTimeout(function(){
    sendDailyReport();
    setInterval(sendDailyReport,24*60*60*1000);
  },wait);
  console.log('Daily report scheduled in',Math.round(wait/3600000),'hr(s)');
}


//  FULL BOT GENERATOR 
function genFull(d,ci){
  var TICKER=d.ticker||'$TOKEN';
  var CA=d.ca||'';
  var SUPPLY=d.supply||'N/A';
  var MAXPCT=d.maxWalletPct||'';
  var BUYTAX=d.buyTax||'0';
  var SELLTAX=d.sellTax||'0';
  var TWITTER=d.twitter||'';
  var WEBSITE=d.website||'';
  var RENOUNCED=d.renounced||'NOT RENOUNCED';
  var LOCKED=d.locked||'NOT LOCKED';
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
    alpha:'Confident, sharp, crypto-native. Talk like a seasoned degen who believes in the project. Direct and bold.',
    professional:'Clean, informative, professional. Precise answers. Measured tone. Build trust through clarity.',
    hype:'High energy, exciting, bullish. Match community energy. Enthusiastic but genuine.',
    community:'Warm, inclusive, friendly. Make everyone feel welcome. Genuine and supportive.',
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
  ln("var app=express();app.use(express.json());");
  ln("var _SF='/tmp/state.json';");
  ln("var caUnlocked=false,groupChatId=null,silTimer=null;");
  ln("var SIL_DELAY=" + (d.silenceBreaker||"3600000") + ";");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("loadState();");
  ln("var _IMG1=path.join(__dirname,'"+(d.ticker.replace(/\\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase())+".jpg');");
  ln("var _IMG2=path.join(__dirname,'siren.jpg');");
  ln("var IMG=fs.existsSync(_IMG1)?_IMG1:(fs.existsSync(_IMG2)?_IMG2:_IMG1);");
  ln("var IMG_BUF=null;try{if(fs.existsSync(IMG))IMG_BUF=fs.readFileSync(IMG);}catch(_){}");
  // IMG_BUF loaded above
  ln("var imgMsgs=new Map(),strikes=new Map(),spamTracker=new Map(),lastReplies=[];");
  ln("var SHOUTOUT_ON=false,shoutTimer=null;");
  ln("async function delPrevImg(cid){var mid=imgMsgs.get(cid);if(mid){try{await bot.telegram.deleteMessage(cid,mid);}catch(_){}imgMsgs.delete(cid);}}");
  ln("async function sendImg(cid,cap,extra){await delPrevImg(cid);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(cid,{source:IMG_BUF},Object.assign({caption:cap,parse_mode:'HTML'},extra));imgMsgs.set(cid,m.message_id);return m;}catch(e){IMG_BUF=null;}}return bot.telegram.sendMessage(cid,cap,Object.assign({parse_mode:'HTML'},extra));}");
  ln("function autoDel(cid,mid,ms){setTimeout(function(){try{bot.telegram.deleteMessage(cid,mid);}catch(_){}},ms);}");
  ln("async function isAdmin(ctx,uid){var t=ctx.chat&&ctx.chat.type;if(t!=='group'&&t!=='supergroup')return false;try{var m=await ctx.telegram.getChatMember(ctx.chat.id,uid);return m.status==='administrator'||m.status==='creator';}catch(_){return false;}}");
  ln("function getStrike(uid){var n=Date.now(),s=strikes.get(uid);if(!s||n-s.since>86400000){s={count:0,since:n};strikes.set(uid,s);}return s;}");
  ln("async function applyStrike(ctx,uid,reason){var s=getStrike(uid);try{await ctx.deleteMessage();}catch(_){}var mem=ctx.message&&ctx.message.from;var tag=mem&&mem.username?'@'+mem.username:mem&&mem.first_name||'user';var why=reason?' ('+reason+')':'';s.count++;if(s.count>=3){s.count=0;try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+86400});}catch(_){}var m3=await ctx.reply('\\u26A0\\uFE0F '+tag+' muted 24h \\u2014 3 strikes'+why+'.');autoDel(ctx.chat.id,m3.message_id,60000);}else{var mw=await ctx.reply('\\u26A0\\uFE0F '+tag+' warning '+s.count+'/3'+why);autoDel(ctx.chat.id,mw.message_id,45000);}}");
  ln("async function checkSpam(ctx,uid){var n=Date.now(),t=spamTracker.get(uid)||{c:0,s:n};if(n-t.s>60000)t={c:0,s:n};t.c++;spamTracker.set(uid,t);if(t.c>5){try{await ctx.telegram.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+300});}catch(_){}var m=await ctx.reply('Muted 5 min for spam.');autoDel(ctx.chat.id,m.message_id,15000);return true;}return false;}");
  ln("var FUD=['rug','rugpull','scam','ponzi','honeypot','fuck','bitch','bastard','asshole','cunt','exit scam','dev ran','abandoned'];");
  ln("function hasFud(t){var l=t.toLowerCase();return FUD.some(function(w){return l.includes(w);});}");
  ln("var NOT_LIVE=['"+TICKER+" hasn\\u2019t launched yet. CA coming soon.','Not yet. Stay ready.','CA drops soon. Hold tight.'];");
  ln("var CTO_REPLIES=['"+TICKER+" is a CTO. Original dev gone. Community owns and runs this completely. No dev to rug.','CTO project. Dev walked away. Community stepped up and owns "+TICKER+" now. That is the strength.','No dev here. "+TICKER+" is 100% community-owned. Original dev left. Community drives this forward.'];");

  // System prompt
  ln("function sysPrompt(){");
  ln("  return '"+[
    "You are the community bot for "+TICKER+", a "+CHAIN_LBL+" meme token.",
    "Token: "+TICKER+" | Chain: "+CHAIN_LBL,
    "Supply: "+SUPPLY+(MAXPCT?" | Max Wallet: "+MAXPCT:""),
    "Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell",
    "Contract: "+RENOUNCED+" | LP: "+LOCKED,
    (IS_CTO?"DEV: CTO. Original dev gone. Community owns "+TICKER+" completely. Say this clearly when asked.":"DEV: Active, building, present. Never imply dev left."),
  ].join("\\n")+"'+(TWITTER?'\\nTwitter: '+TWITTER:'')+'\\nNarrative: '+"+NARR+"+'\\nPersonality: "+PERS_STYLE.replace(/'/g,"\\'")+"\\nRULES: 2-4 lines max. Natural and professional. Never share TG group link. Never repeat reply. If hype/casual/no question: reply IGNORE exactly.';");
  ln("}");

  ln("async function ask(msg){var r=await groq.chat.completions.create({model:'llama-3.3-70b-versatile',temperature:1.0,max_tokens:160,messages:[{role:'system',content:sysPrompt()},{role:'user',content:msg}]});return r.choices[0].message.content.trim();}");
  ln("async function smartAsk(msg){var r=await ask(msg);if(lastReplies.includes(r))r=await ask(msg+' Give a completely different response.');lastReplies.push(r);if(lastReplies.length>12)lastReplies.shift();return r;}");

  // Silence breaker
  ln("var SIL_ANG=['2-3 lines. Why hold "+TICKER+" right now.','2-3 lines. "+TICKER+" fundamentals: renounced, LP locked.','2-3 lines. Being early to "+TICKER+".','2-3 lines. "+TICKER+" community is building.','2-3 lines. The move in "+TICKER+" is still early.'];");
  ln("var silIdx=0;");
  ln("async function fireSilence(){if(!groupChatId)return resetSil();try{var p=SIL_ANG[silIdx%SIL_ANG.length];silIdx++;var cap=await smartAsk(p);if(cap&&cap!=='IGNORE')await sendImg(groupChatId,cap,{});}catch(_){}resetSil();}");
  ln("function resetSil(){if(silTimer)clearTimeout(silTimer);if(SIL_DELAY===0||SIL_DELAY==='0')return;silTimer=setTimeout(fireSilence,parseInt(SIL_DELAY));}");

  // Shoutout
  ln("async function doShoutout(){if(!groupChatId||!SHOUTOUT_ON)return;try{var admins=await bot.telegram.getChatAdministrators(groupChatId);var humans=admins.filter(function(a){return!a.user.is_bot;});var names=humans.map(function(a){return a.user.username?'@'+a.user.username:a.user.first_name;});if(!names.length)return schedShout();var ppt='1-2 warm lines. Shoutout to admins keeping "+TICKER+" alive: '+names.join(', ')+'. Sound genuine. Tag them.';var msg=await smartAsk(ppt);if(msg&&msg!=='IGNORE'){var sm=await bot.telegram.sendMessage(groupChatId,msg);setTimeout(function(){try{bot.telegram.deleteMessage(groupChatId,sm.message_id);}catch(_){}},7200000);}}catch(_){}schedShout();}");
  ln("function schedShout(){if(shoutTimer)clearTimeout(shoutTimer);if(!SHOUTOUT_ON)return;var slots=[21600000,43200000,61200000,75600000];var now=Date.now()%86400000;var next=slots.find(function(t){return t>now;});var wait=next!==undefined?next-now:86400000-now+slots[0];wait+=Math.floor(Math.random()*1800000);shoutTimer=setTimeout(doShoutout,wait);}");
  ln("bot.command('shoutout',async function(ctx){var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;var arg=(ctx.message.text||'').split(' ')[1]||'';if(arg==='on'){SHOUTOUT_ON=true;schedShout();return ctx.reply('\\u2705 Admin shoutouts enabled. Fires 2-4x daily.');}if(arg==='off'){SHOUTOUT_ON=false;if(shoutTimer)clearTimeout(shoutTimer);return ctx.reply('\\u274C Admin shoutouts disabled.');}if(arg==='now'){await doShoutout();return;}return ctx.reply('Usage: /shoutout on / off / now');});");

  // Commands  CA and X hardcoded
  ln("bot.command('ca',async function(ctx){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});});");
  ln("bot.command('x',async function(ctx){return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('twitter',async function(ctx){return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('socials',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('info',function(ctx){return ctx.reply('<b>"+TICKER+"</b> \\u2014 "+CHAIN_LBL+"\\n\\nSupply: "+SUPPLY+"\\n"+(MAXPCT?'Max Wallet: '+MAXPCT+'\\n':'')+"Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\nContract: "+RENOUNCED+"\\nLP: "+LOCKED+"'+(TWITTER?'\\nTwitter: '+TWITTER:''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var a=await isAdmin(ctx,ctx.from.id);if(!a)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDel(ctx.chat.id,m.message_id,10000);});");
  ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA hidden.');}var a=await isAdmin(ctx,ctx.from.id);if(!a)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDel(ctx.chat.id,m.message_id,10000);});");

  // New members
  ln("bot.on('new_chat_members',async function(ctx){if(ctx.message.new_chat_members.some(function(m){return m.is_bot;}))return;try{await ctx.deleteMessage();}catch(_){}for(var i=0;i<ctx.message.new_chat_members.length;i++){var mem=ctx.message.new_chat_members[i];var h=mem.username?'@'+mem.username:mem.first_name;var opts=[h+' joined "+TICKER+".\\n"+RENOUNCED+" \\u2022 LP "+LOCKED+" \\u2022 "+BUYTAX+"%/"+SELLTAX+"% tax\\n'+(caUnlocked?CA:'CA coming soon.'),'Welcome, '+h+'. "+TICKER+" \\u2022 "+CHAIN_LBL+"\\n'+(caUnlocked?'CA: '+CA:'Launch incoming.')];var msg=opts[Math.floor(Math.random()*opts.length)];var s=await ctx.reply(msg);autoDel(ctx.chat.id,s.message_id,60000);}});");

  // Main message handler
    // context tracking
  ln("var chatHistory=[];"  );
  ln("function addHistory(t){chatHistory.push(t);if(chatHistory.length>8)chatHistory.shift();}");
  ln("function isPromoSpam(text){var t=text.toLowerCase();var pw=['dm me','dm:','t.me/','join our','join now','pump call','100x','1000x','send me','legitimate','long-term promo','promotion','signal','call group','whale','airdrop only','giveaway','free token'];return pw.some(function(w){return t.includes(w);});}");
  ln("bot.on('message',async function(ctx){");
  ln("  var msg=ctx.message;if(!msg||!ctx.from)return;");
  ln("  var uid=ctx.from.id,isPrivate=ctx.chat.type==='private';");
  ln("  var text=(msg.text||msg.caption||'')\.trim();");
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();}");
  ln("  if(!isPrivate)resetSil();");
  ln("  var admin=await isAdmin(ctx,uid);");
  ln("  if(!isPrivate){");
  ln("    var isFwd=msg.forward_from||msg.forward_sender_name||msg.forward_from_chat||msg.forward_from_message_id;");
  ln("    if(isFwd&&!admin){try{await ctx.deleteMessage();}catch(_){}var wf=await ctx.reply('\\u26A0\\uFE0F No forwarded messages.');autoDel(ctx.chat.id,wf.message_id,8000);return;}");
  ln("    if(text&&msg.entities){var mens=msg.entities.filter(function(e){return e.type==='mention';});if(mens.length>0&&!admin){try{await ctx.deleteMessage();}catch(_){}var wm=await ctx.reply('\\u26A0\\uFE0F No external mentions.');autoDel(ctx.chat.id,wm.message_id,8000);return;}}");
  ln("    if(text&&isPromoSpam(text)&&!admin){try{await ctx.deleteMessage();}catch(_){}var wps=await ctx.reply('\\u26A0\\uFE0F Promotional content removed.');autoDel(ctx.chat.id,wps.message_id,8000);return;}");
  ln("    if(text&&hasFud(text)&&!admin)return applyStrike(ctx,uid,'no FUD');");
  ln("    if(text&&!admin){var sp=await checkSpam(ctx,uid);if(sp)return;}");
  ln("  }");
  ln("  if(admin&&!isPrivate){");
  ln("    if(!text)return;var lower=text.toLowerCase();");
  ln("    var caWa=['ca','contract address','contract','token address'];");
  ln("    if(caWa.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("    if(lower==='x'||lower==='twitter')return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("    if(lower==='socials'||lower==='links')return ctx.reply('<a href=\\'"+CHART+"\\'> Chart</a> | <a href=\\'"+BUY_URL+"\\'> "+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});");
  ln("    return;");
  ln("  }");
  ln("  if(!text)return;var lower2=text.toLowerCase();addHistory(text);");
  ln("  if(lower2.includes('dev')||lower2.includes('cto')||lower2.includes('who run')||lower2.includes('who own')){if(IS_CTO)return ctx.reply(CTO_REPLIES[Math.floor(Math.random()*CTO_REPLIES.length)]);try{var dr=await smartAsk(chatHistory.join('\\n'));if(dr&&dr!=='IGNORE')return ctx.reply(dr);}catch(_){}return;}");
  ln("  var caWords=['ca','contract address','token address','where is the ca','give ca','show ca','drop ca','contract'];");
  ln("  if(caWords.some(function(w){return lower2===w||lower2.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendImg(ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("  if(lower2==='x'||lower2==='twitter'||lower2.includes('follow on'))return sendImg(ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("  if(lower2==='socials'||lower2==='links')return ctx.reply('<a href=\\'"+CHART+"\\'> Chart</a> | <a href=\\'"+BUY_URL+"\\'> "+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});");
  ln("  if(isPrivate){try{var gr=await smartAsk(chatHistory.join('\\n'));if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}return;}");
  ln("  if(RESPONSE_MODE==='focused'){if(text.indexOf('?')===-1)return;try{var gr2=await smartAsk(chatHistory.join('\\n'));if(gr2&&gr2!=='IGNORE')return ctx.reply(gr2);}catch(_){}return;}");
  ln("  var tkLow=TICKER.toLowerCase().replace('$','');if(text.indexOf('?')!==-1||lower2.includes(tkLow)){try{var gr3=await smartAsk(chatHistory.join('\\n'));if(gr3&&gr3!=='IGNORE')return ctx.reply(gr3);}catch(_){}}");
  ln("});");


  // Server
  ln("app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});");
  ln("app.get('/',function(req,res){res.end('OK');});");
  ln("app.get('/health',function(req,res){res.end('OK');});");
  ln("async function regWH(){if(!WEBHOOK_URL)return;var url=WEBHOOK_URL+'/webhook';for(var i=0;i<5;i++){try{if(await bot.telegram.setWebhook(url)){console.log('Webhook:',url);return;}}catch(e){console.log('WH '+(i+1)+':',e.message);}await new Promise(function(r){setTimeout(r,3000);});}}");
  ln("process.on('uncaughtException',function(e){console.error(e.message);});");
  ln("process.on('unhandledRejection',function(e){console.error(e&&e.message);});");
  ln("app.listen(PORT,async function(){console.log('"+TICKER+" bot port '+PORT);try{await new Promise(function(r){setTimeout(r,2000);});}catch(_){}try{await regWH();}catch(e){console.log(e.message);}if(parseInt(SIL_DELAY||'0')>0)try{resetSil();}catch(_){}try{schedShout();}catch(_){}setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);console.log('"+TICKER+" bot live');});");
  return L.join('\n');
}

//  FACTORY STARTUP 
//  DAILY REPORT 
async function sendDailyReport(){
  if(!registry.length||!ownerChatIds.size)return;
  var lines=[E.chart+' <b>Daily Bot Report</b>\n'];
  var anyOffline=false;
  for(var i=0;i<registry.length;i++){
    var b=registry[i];var ok=false;
    try{
      var r=await Promise.race([
        fetch(b.url+'/health'),
        new Promise(function(_,rej){setTimeout(function(){rej(new Error('t'));},8000);}),
      ]);
      ok=r&&r.ok;
    }catch(_){}
    lines.push((i+1)+'. <b>'+b.ticker+'</b> \u2014 '+(ok?E.check+' Online':E.xmark+' Offline'));
    if(!ok)anyOffline=true;
  }
  lines.push('');
  if(anyOffline){
    lines.push(E.warn+' <b>Action needed:</b>');
    lines.push('One or more bots are offline.');
    lines.push('\u2022 /stats \u2014 see details');
    lines.push('\u2022 /rebuild \u2014 push fresh code');
    lines.push('\u2022 Contact support if issue persists');
  } else {
    lines.push(E.check+' All bots are running smoothly.');
  }
  var msg=lines.join('\n');
  for(var cid of ownerChatIds){
    try{await bot.telegram.sendMessage(cid,msg,{parse_mode:'HTML'});}catch(_){}
  }
}
function scheduleDailyReport(){
  var now=new Date();
  var next=new Date();
  next.setUTCHours(9,0,0,0);
  if(next<=now)next.setUTCDate(next.getUTCDate()+1);
  var wait=next.getTime()-now.getTime();
  setTimeout(function(){
    sendDailyReport();
    setInterval(sendDailyReport,24*60*60*1000);
  },wait);
  console.log('Daily report scheduled in',Math.round(wait/3600000),'hr(s)');
}

app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});
app.get('/',function(req,res){res.end('OK');});
app.get('/health',function(req,res){res.end('OK');});

async function regWebhook(){
  if(!WEBHOOK_URL){console.log('No WEBHOOK_URL');return;}
  var url=WEBHOOK_URL+'/webhook';
  for(var i=0;i<5;i++){
    try{if(await bot.telegram.setWebhook(url)){console.log('Factory webhook:',url);return;}}
    catch(e){console.log('WH '+(i+1)+':',e.message);}
    await sleep(3000);
  }
}
async function getGhOwner(){
  try{var r=await fetch('https://api.github.com/user',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});var d=await r.json();GH_OWNER=d.login||'';console.log('GH:',GH_OWNER);}
  catch(e){console.log('GH:',e.message);}
}
process.on('uncaughtException',function(e){console.error('Factory:',e.message);});
process.on('unhandledRejection',function(e){console.error('Factory rej:',e&&e.message);});

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
      {command:'rebuild', description:'Full rebuild from stored data'},
      {command:'update',  description:'Push latest code to bot(s)'},
      {command:'stats',   description:'Health check'},
      {command:'addgroq', description:'Add AI key'},
      {command:'cancel',  description:'Cancel current operation'},
    ]);
  }catch(e){console.log('Commands:',e.message);}
  setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);
  try{scheduleDailyReport();}catch(e){console.log('Daily report:',e.message);}
  console.log('Bot Factory is live.');
});
app.post('/webhook',function(req,res){bot.handleUpdate(req.body,res);});
app.get('/',function(req,res){res.end('OK');});
app.get('/health',function(req,res){res.end('OK');});

async function regWebhook(){
  if(!WEBHOOK_URL){console.log('No WEBHOOK_URL');return;}
  var url=WEBHOOK_URL+'/webhook';
  for(var i=0;i<5;i++){
    try{if(await bot.telegram.setWebhook(url)){console.log('Factory webhook:',url);return;}}
    catch(e){console.log('WH '+(i+1)+':',e.message);}
    await sleep(3000);
  }
}
async function getGhOwner(){
  try{var r=await fetch('https://api.github.com/user',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});var d=await r.json();GH_OWNER=d.login||'';console.log('GH:',GH_OWNER);}
  catch(e){console.log('GH:',e.message);}
}
process.on('uncaughtException',function(e){console.error('Factory:',e.message);});
process.on('unhandledRejection',function(e){console.error('Factory rej:',e&&e.message);});

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
      {command:'rebuild', description:'Full rebuild from stored data'},
      {command:'update',  description:'Push latest code to bot(s)'},
      {command:'stats',   description:'Health check'},
      {command:'addgroq', description:'Add AI key'},
      {command:'cancel',  description:'Cancel current operation'},
    ]);
  }catch(e){console.log('Commands:',e.message);}
  setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);
  try{scheduleDailyReport();}catch(e){console.log('Daily report:',e.message);}
  console.log('Bot Factory is live.');
});
