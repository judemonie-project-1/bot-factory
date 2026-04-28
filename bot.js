'use strict';
var Telegraf=require('telegraf').Telegraf;
// Telegram user client for BotFather automation
var TelegramClient,StringSession;
try{
  var tg=require('telegram');
  TelegramClient=tg.TelegramClient;
  StringSession=tg.sessions.StringSession;
}catch(_){console.log('gramjs not installed  BotFather automation disabled');}
var express=require('express');
var fs=require('fs');
var path=require('path');

var BOT_TOKEN=process.env.BOT_TOKEN;
var GITHUB_TOKEN=process.env.GITHUB_TOKEN;
var RENDER_KEY=process.env.RENDER_API_KEY;
var TG_API_ID=parseInt(process.env.TG_API_ID||'0');
var TG_API_HASH=process.env.TG_API_HASH||'';
var TG_SESSION=process.env.TG_SESSION||'';
var TG_PHONE=process.env.TG_PHONE||'';
var tgClient=null;
var tgLoginSessions={};  // uid -> pending login state

var SUPERVISOR_URL=(process.env.SUPERVISOR_URL||'').replace(/\/+$/,'');
var RELOAD_SECRET=process.env.RELOAD_SECRET||'sup-reload-secret';
var CRON_KEY=process.env.CRONJOB_API_KEY;
var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();
var PORT=process.env.PORT||3000;
var BSCSCAN_KEY=process.env.BSCSCAN_API_KEY||'';
var GH_OWNER=process.env.GH_ORG||process.env.GH_OWNER||'';

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
  eth:{label:'Ethereum',dex:'Uniswap',dexUrl:'https://app.uniswap.org/#/swap?outputCurrency=',chartBase:'https://dexscreener.com/ethereum/',explorer:'https://etherscan.io/token/',dsNetwork:'ethereum'},
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
var registry=[],registryReady=false,sessions={},editSessions={},groqSessions={},ownerChatIds=new Set();

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
    renounced:false,renouncedText:'',
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

  // 2. DexScreener  main source for ticker, name, socials
  try{
    var dsNet=CHAIN[chain]&&CHAIN[chain].dsNetwork||chain;
    var dsUrl='https://api.dexscreener.com/latest/dex/tokens/'+ca;
    var dr=await Promise.race([fetch(dsUrl),new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},10000);})]);
    var dd=await dr.json();
    var allPairs=dd.pairs||[];
    // Prefer pairs on the correct chain
    var pairs=allPairs.filter(function(p){return p.chainId===dsNet;});
    if(!pairs.length)pairs=allPairs; // fallback: any chain
    // Sort by liquidity descending
    pairs.sort(function(a,b){return ((b.liquidity&&b.liquidity.usd)||0)-((a.liquidity&&a.liquidity.usd)||0);});
    if(pairs.length){
      var p=pairs[0];
      var bt=p.baseToken||{};
      // Only use baseToken if CA matches (avoid quoteToken mixup)
      var isBase=bt.address&&bt.address.toLowerCase()===ca.toLowerCase();
      var tok=isBase?bt:(p.quoteToken&&p.quoteToken.address&&p.quoteToken.address.toLowerCase()===ca.toLowerCase()?p.quoteToken:bt);
      if(!result.name&&tok.name)result.name=tok.name;
      if((!result.ticker||result.ticker==='$TOKEN')&&tok.symbol)result.ticker='$'+tok.symbol.replace(/^\$/,'');
      result.found=true;
      // Socials  only set twitter if it's actually a twitter URL
      if(p.info&&p.info.socials){
        var tw=p.info.socials.find(function(s){return s.type==='twitter';});
        if(tw&&tw.url&&tw.url.includes('x.com'||'twitter.com'))result.twitter=tw.url;
        var ws=p.info.websites&&p.info.websites[0];
        if(ws&&!result.website)result.website=ws.url||ws;
      }
      // Supply from FDV if BSCScan failed
      if(!result.supply&&p.fdv&&p.priceUsd){
        var estSupply=Math.round(p.fdv/parseFloat(p.priceUsd));
        result.supply=fmtNum(estSupply);
      }
    }
  }catch(e){result.errors.push('DexScreener: '+e.message);}

  return result;
}

//  REGISTRY 
function obfuscateToken(t){
  if(!t||typeof t!=='string')return t;
  var p=t.indexOf(':');
  if(p<0)return{_t:t};
  return{_a:t.slice(0,p),_b:t.slice(p+1)};
}
function deobfuscateToken(o){
  if(!o)return'';
  if(typeof o==='string')return o;
  if(o._a&&o._b)return o._a+':'+o._b;
  return o._t||'';
}
function saveRegistry(){
  if(!GH_OWNER||!registry.length||!registryReady)return;
  try{
    var safe=registry.map(function(b){
      // Only keep known safe fields  never save Buffer or code
      var c={
        id:b.id||b.repoName,ticker:b.ticker,chain:b.chain,mode:b.mode,
        repoName:b.repoName,ghOwner:b.ghOwner,status:b.status,builtAt:b.builtAt,
        state:b.state||{},analytics:b.analytics||{},
        d:b.d?{
          botToken:b.d.botToken,chain:b.d.chain,mode:b.d.mode,status:b.d.status,
          stage:b.d.stage,personality:b.d.personality,responseMode:b.d.responseMode,
          name:b.d.name,ticker:b.d.ticker,ca:b.d.ca,twitter:b.d.twitter,tg:b.d.tg,
          website:b.d.website,narrative:b.d.narrative,supply:b.d.supply,
          buyTax:b.d.buyTax,sellTax:b.d.sellTax,maxWalletPct:b.d.maxWalletPct,
          renounced:b.d.renounced,locked:b.d.locked,silenceBreaker:b.d.silenceBreaker,
          revealCmd:b.d.revealCmd,hideCmd:b.d.hideCmd
        }:{}
      };
      if(c.d.botToken&&typeof c.d.botToken==='string')c.d.botToken=obfuscateToken(c.d.botToken);
      return c;
    });
    var json=JSON.stringify(safe,null,2);
    if(json.length>500000){console.error('saveRegistry: output too large, aborting');return;}
    githubUpdate(GH_OWNER,'bot-factory','registry.json',Buffer.from(json)).catch(function(e){console.error('saveRegistry:',e.message);});
  }catch(e){console.error('saveRegistry error:',e.message);}
}
async function loadRegistry(){
  // Try all possible env var names
  if(!GH_OWNER)GH_OWNER=process.env.GH_ORG||process.env.GH_OWNER||process.env.GITHUB_ORG||'';
  if(!GH_OWNER){
    // Last resort: extract from GITHUB_TOKEN owner via API
    try{
      var ur=await fetch('https://api.github.com/user',{headers:{'Authorization':'token '+GITHUB_TOKEN}});
      var ud=await ur.json();
      // Check orgs
      var or2=await fetch('https://api.github.com/user/orgs',{headers:{'Authorization':'token '+GITHUB_TOKEN}});
      var od=await or2.json();
      if(Array.isArray(od)&&od.length)GH_OWNER=od[0].login;
      else GH_OWNER=ud.login||'';
    }catch(e){console.log('loadRegistry: cannot determine GH_OWNER:',e.message);return;}
  }
  if(!GH_OWNER){console.log('loadRegistry: GH_OWNER still not set');return;}
  try{
    var r=await fetch('https://api.github.com/repos/'+GH_OWNER+'/bot-factory/contents/registry.json',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
    if(r.ok){var d=await r.json();if(d.content){
      var raw=JSON.parse(Buffer.from(d.content,'base64').toString('utf8'));
      registry=raw.map(function(b){
        if(b.d&&b.d.botToken&&typeof b.d.botToken==='object')b.d.botToken=deobfuscateToken(b.d.botToken);
        if(!b.ticker&&b.d)b.ticker=b.d.ticker||'';
        return b;
      });
      console.log('Registry:',registry.length,'bots');
    registryReady=true;
    }}
  }catch(e){console.log('Registry:',e.message);}
}

//  SESSION 
function newSession(isAdd){
  return{isAdd:!!isAdd,step:'chain',lastMsgId:null,
    d:{chain:'bsc',mode:'full',status:'launch',guardType:'standard',
       personality:'alpha',responseMode:'focused',silenceBreaker:'3600000',stage:'live',
       name:'',ticker:'',ca:'',twitter:'',narrative:'',
       supply:'N/A',buyTax:'5',sellTax:'5',
       maxWalletPct:'',maxWalletTokens:'',
       renounced:'',locked:'',
       revealCmd:'',hideCmd:'',botToken:'',renderUrl:'',repoName:''},
    imgBuf:null,fetchedData:null};
}

//  BUTTON HELPERS 
function chainBtns(uid){return{inline_keyboard:[
  [{text:'\u{1F7E1} BNB Smart Chain (BSC)',callback_data:'w_chain_bsc_'+uid}],
  [{text:'\u{1F535} Ethereum (ETH)',        callback_data:'w_chain_eth_'+uid}],
  [{text:'\u{1F7E3} Solana (SOL)',           callback_data:'w_chain_sol_'+uid}],
]};}
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
function lpBtns(uid){return{inline_keyboard:[
  [{text:'\u2705 Locked \u2014 LP is locked',callback_data:'w_lp_locked_'+uid}],
  [{text:'\u{1F525} Burned \u2014 LP is burned (stronger)',callback_data:'w_lp_burned_'+uid}],
  [{text:'\u274C Not locked \u2014 no lock or burn',callback_data:'w_lp_no_'+uid}],
]};}
function skipBtn(uid,step){return{inline_keyboard:[[{text:'Skip',callback_data:'w_skip_'+step+'_'+uid}]]};}
function stageBtns(uid){return{inline_keyboard:[
  [{text:'\u{1F7E2} Already live \u2014 CA is public, token is trading',callback_data:'w_stage_live_'+uid}],
  [{text:'\u{1F7E1} About to launch \u2014 CA ready, not dropped yet',callback_data:'w_stage_prelaunch_'+uid}],
  [{text:'\u26AA Pre-launch \u2014 no CA yet, just need group management',callback_data:'w_stage_noCA_'+uid}],
]};}

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
function addBack(kb,uid,step){
  if(!kb)return kb;
  var flow=['chain','mode','gt','status','stage','pers','rmode','sil','ca','ticker_manual','twitter','tg','tax','maxwallet','lp','narrative','img','bottoken'];
  var idx=flow.indexOf(step);
  if(idx<=0)return kb;
  var prevStep=flow[idx-1];
  var backBtn=[{text:'\u2190 Back',callback_data:'w_back_'+uid+'_'+prevStep}];
  var rows=kb.inline_keyboard||[];
  return{inline_keyboard:[...rows,[backBtn[0]]]};
}

async function say(ctx,s,text,kb){
  await delMsg(ctx,s.lastMsgId);
  var kbWithBack=kb?addBack(kb,String(ctx.from.id),s.step):undefined;
  var m=await ctx.reply(text,{parse_mode:'HTML',reply_markup:kbWithBack,disable_web_page_preview:true});
  s.lastMsgId=m.message_id;
}


//  WIZARD STEP MANAGER 
// Steps for full bot build:
// chain > mode > status > pers > rmode > ca > twitter > tax > maxwallet > lp > narrative > img > bottoken [> renderurl if addbot] > confirm
// Steps for guard bot:
// chain > mode > gt > status > ca > twitter > tax > maxwallet > lp > narrative > img > bottoken [> renderurl] > confirm

function nextStep(s){
  var step=s.step,d=s.d,isAdd=s.isAdd;
  // noCA stage: skip CA data steps, go straight to narrative
  var skipSteps=(d.stage==='noCA')?['ca','tax','maxwallet','lp']:[];
  var flow=[];
  if(d.mode==='full')
    flow=['chain','mode','status','stage','pers','rmode','sil','ca','ticker_manual','twitter','tg','tax','maxwallet','lp','narrative','img','bottoken'];
  else
    flow=['chain','mode','gt','status','stage','sil','ca','ticker_manual','twitter','tg','tax','maxwallet','lp','narrative','img','bottoken'];
  if(isAdd&&!d.renderUrl)flow.push('renderurl');
  flow.push('confirm');
  if(skipSteps.length)flow=flow.filter(function(f){return!skipSteps.includes(f);});
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
  if(step==='sil')    return say(ctx,s,E.bell+' <b>Silence breaker?</b>\nBot posts when group is quiet for:',silBtns(uid));
  if(step==='stage')  return say(ctx,s,E.rocket+' <b>Project stage?</b>',stageBtns(uid));
  if(step==='ca')      return say(ctx,s,E.search+' <b>Contract address?</b>\n<i>Paste the CA and I will auto-fetch token data from BSCScan + DexScreener</i>');
  if(step==='twitter') return say(ctx,s,E.pencil+' Twitter/X link?'+(d.twitter?'\n<i>Auto-fetched: '+d.twitter+' \u2014 send new one to change, or tap Skip</i>':'\n<i>Paste the link or tap Skip</i>'),skipBtn(uid,'twitter'));
  if(step==='tg')     return say(ctx,s,E.link+' <b>Telegram group link?</b>\n<i>e.g. https://t.me/yourgroup (or skip)</i>');
  if(step==='tax')     return say(ctx,s,E.pencil+' Buy / sell tax?'+(d.buyTax&&d.sellTax&&d.buyTax!=='5'?'\n<i>Auto-detected: '+d.buyTax+'% / '+d.sellTax+'%</i>':''),taxBtns(uid));
  if(step==='maxwallet')return say(ctx,s,E.pencil+' Max wallet limit?',mwBtns(uid));
  if(step==='lp')      return say(ctx,s,E.pencil+' Is LP (liquidity) locked?',lpBtns(uid));
  if(step==='narrative')return say(ctx,s,E.pencil+' Token narrative?\n<i>1-2 sentences. What makes it unique. Used for AI personality.</i>',skipBtn(uid,'narrative'));
  if(step==='img')     return say(ctx,s,E.pencil+' Send bot image (JPG/PNG)\n<i>This is the image shown with CA and X replies</i>',skipBtn(uid,'img'));
  if(step==='bottoken'){
    if(tgClient){
      return say(ctx,s,E.rocket+' <b>Create bot automatically?</b>\n\nBotFather is connected. I can create the token for you.',{
        inline_keyboard:[
          [{text:E.check+' Auto-create (recommended)',callback_data:'w_autocreate_'+uid}],
          [{text:E.pencil+' Enter token manually',callback_data:'w_manualtoken_'+uid}],
        ]
      });
    }
    return say(ctx,s,E.pencil+' <b>Bot token?</b>\n\n<i>1. Open @BotFather\n2. /newbot\n3. Enter name + username ending in _bot\n4. Paste token here</i>');
  }
  if(step==='renderurl')return say(ctx,s,E.pencil+' <b>Render URL?</b>\n<i>e.g. https://mpc-bot.onrender.com</i>');
  if(step==='confirm') return say(ctx,s,buildSummary(s));
}

function buildSummary(s){
  var d=s.d,ci=CHAIN[d.chain]||CHAIN.bsc;
  return (s.isAdd?E.wrench:E.fire)+' <b>Confirm '+(s.isAdd?'registration':'deployment')+'</b>\n\n'+
    '<b>Chain:</b> '+ci.label+'\n'+
    '<b>Mode:</b> '+(d.mode==='guard'?E.shield+' Guard':E.robot+' Full')+'\n'+
    '<b>Status:</b> '+(d.status==='cto'?'\u{1F91D} CTO':E.rocket+' Active dev')+'\n'+
    '<b>Stage:</b> '+(d.stage==='live'?'\u{1F7E2} Already live':(d.stage==='prelaunch'?'\u{1F7E1} About to launch':'\u26AA Pre-launch (no CA yet)'))+'\n'+
    (d.mode==='full'?'<b>Personality:</b> '+(PERS_LABELS[d.personality]||d.personality)+'\n':'')+
    '<b>Token:</b> '+d.name+' '+d.ticker+'\n'+
    '<b>CA:</b> <code>'+d.ca+'</code>\n'+
    '<b>Supply:</b> '+d.supply+'\n'+
    (d.maxWalletPct?'<b>Max Wallet:</b> '+d.maxWalletPct+'\n':'')+
    '<b>Tax:</b> '+d.buyTax+'% buy / '+d.sellTax+'% sell\n'+
    '<b>Contract:</b> '+d.renounced+'\n'+
    '<b>LP:</b> '+d.locked+'\n'+
    (d.twitter?'<b>Twitter:</b> '+d.twitter+'\n':'')+
    (d.tg?'<b>TG Group:</b> '+d.tg+'\n':'')+
    '<b>Image:</b> '+(s.imgBuf?E.check+' ready':'\u2014 none')+'\n'+
    (s.isAdd&&d.renderUrl?'<b>Bot URL:</b> '+d.renderUrl+'\n':'')+
    '\nType <b>yes</b> to '+(s.isAdd?'register':'deploy')+' \u2014 <b>no</b> to cancel.';
}

//  COMMANDS 
bot.command('start',function(ctx){
  ownerChatIds.add(ctx.chat.id);
  return ctx.reply(
    E.rocket+' <b>Bot Factory</b>\n'+
    '<i>Build and manage Telegram community bots for your token.</i>\n\n'+
    E.shield+' <b>Two bot types</b>\n'+
    '\u2022 <b>Full</b> \u2014 AI replies, moderation, silence breaker, /shill\n'+
    '\u2022 <b>Guard</b> \u2014 moderation only, no AI',
    {parse_mode:'HTML', reply_markup:{inline_keyboard:[
      [{text:E.rocket+' Build a new bot',callback_data:'sb_build'}],
      [{text:E.list+' List your bots',callback_data:'sb_bots'},{text:E.chart+' Live stats',callback_data:'sb_stats'}],
      [{text:E.pencil+' Edit a bot',callback_data:'sb_edit'},{text:E.gear+' Rebuild',callback_data:'sb_rebuild'}],
      [{text:E.shield+' Cleanup',callback_data:'sb_cleanup'},{text:E.gem+' Add AI key',callback_data:'sb_addgroq'}],
    ]}}
  );
});
bot.action('sb_build',async function(ctx){await ctx.answerCbQuery();return ctx.reply(E.rocket+' Starting build...\n\nSend /build to begin.')});
bot.action('sb_bots',async function(ctx){
  await ctx.answerCbQuery();
  if(!registry.length)return ctx.reply(E.list+' No bots yet. Use /build.');
  return ctx.reply(E.list+' <b>Your Bots</b>\n\n'+registry.map(function(b,i){return (i+1)+'. '+E.rocket+' <b>'+(b.ticker||'Bot '+(i+1))+'</b> ('+(b.chain||'bsc').toUpperCase()+')\n   '+(b.mode==='guard'?E.shield+' Guard':E.robot+' Full')+' \u2022 '+(b.d&&b.d.status==='cto'?'CTO':'Active dev')+'\n   '+E.link+' '+(b.url||'no url');}).join('\n\n'),{parse_mode:'HTML',disable_web_page_preview:true});
});
bot.action('sb_stats',async function(ctx){await ctx.answerCbQuery();return ctx.reply(E.chart+' Fetching stats...')});
bot.action('sb_edit',async function(ctx){await ctx.answerCbQuery();return ctx.reply(E.pencil+' Send /edit to choose which bot to edit.')});
bot.action('sb_rebuild',async function(ctx){await ctx.answerCbQuery();return ctx.reply(E.gear+' Send /rebuild to choose which bot to redeploy.')});
bot.action('sb_cleanup',async function(ctx){await ctx.answerCbQuery();return ctx.reply(E.shield+' Send /cleanup to manage unused services.')});
bot.action('sb_addgroq',async function(ctx){await ctx.answerCbQuery();return ctx.reply(E.gem+' Send /addgroq to add or update your AI key.')});
// Edit image done button
bot.action(/^ef_imgdone_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery('Images saved!');
  var uid=String(ctx.from.id);
  delete editSessions[uid];
  try{await ctx.deleteMessage();}catch(_){}
  scheduleReload(ctx);
  return ctx.reply(E.check+' Images saved.\n\n'+E.clock+' Deploying in ~8s. Wait for this before next edit.',{parse_mode:'HTML'});
});

// Auto-create bot via BotFather
bot.action(/^w_autocreate_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery('Creating bot...');
  var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  try{await ctx.deleteMessage();}catch(_){}
  var msg=await ctx.reply(E.gear+' Creating bot on BotFather... please wait ~10 seconds.');
  var name=(s.d.name||s.d.ticker||'My').replace(/[^a-zA-Z0-9 ]/g,' ').trim()+' Bot';
  var result=await createBotOnBotFather(name,s.d.ticker||'token');
  try{await bot.telegram.deleteMessage(ctx.chat.id,msg.message_id);}catch(_){}
  if(!result||!result.token){
    return ctx.reply(E.xmark+' Auto-create failed. Please enter token manually:',
      {reply_markup:{inline_keyboard:[[{text:E.pencil+' Enter manually',callback_data:'w_manualtoken_'+uid}]]}});
  }
  s.d.botToken=result.token;
  s.d.botUsername=result.username;
  s.step=nextStep(s);
  await ctx.reply(E.check+' Bot created!\n<b>@'+result.username+'</b>\n\nMoving on...',{parse_mode:'HTML'});
  await showStep(ctx,s,uid);
});

// Manual token entry
bot.action(/^w_manualtoken_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=ctx.match[1],s=sessions[uid];if(!s)return;
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.pencil+' Paste your BotFather token:');
});

// Auto-create bot via BotFather
bot.action(/^w_autocreate_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=ctx.match[1],s=sessions[uid];
  if(!s)return ctx.reply('Session expired. Use /build to start over.');
  try{await ctx.deleteMessage();}catch(_){}
  var creating=await ctx.reply(E.rocket+' Creating bot on BotFather...\n\n<i>This takes ~10 seconds</i>',{parse_mode:'HTML'});
  try{
    var ticker=s.d.ticker||'TOKEN';
    var botName=(s.d.name||ticker.replace(/\$/g,''))+' Bot';
    var result=await createBotOnBotFather(botName,ticker);
    try{await bot.telegram.deleteMessage(ctx.chat.id,creating.message_id);}catch(_){}
    if(!result||!result.token){
      return ctx.reply(E.xmark+' Auto-create failed. BotFather may be busy.\n\nPlease enter token manually:');
    }
    s.d.botToken=result.token;
    s.d.botUsername=result.username;
    s.step=nextStep(s);
    await ctx.reply(E.check+' <b>Bot created!</b>\n\nUsername: @'+result.username+'\nToken: saved automatically.\n\n<i>Proceeding to next step...</i>',{parse_mode:'HTML'});
    await sleep(1000);
    await showStep(ctx,s,uid);
  }catch(e){
    try{await bot.telegram.deleteMessage(ctx.chat.id,creating.message_id);}catch(_){}
    return ctx.reply(E.xmark+' Error: '+e.message+'\n\nPlease enter token manually:');
  }
});

bot.action(/^w_manualtoken_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=ctx.match[1],s=sessions[uid];
  if(!s)return;
  try{await ctx.deleteMessage();}catch(_){}
  await showStep(ctx,s,uid);
});

// Back button in wizard
bot.action(/^w_back_(\w+)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var uid=ctx.match[1],prevStep=ctx.match[2];
  var s=sessions[uid]; if(!s)return;
  s.step=prevStep;
  await showStep(ctx,s,uid);
});

bot.command('refresh',async function(ctx){
  await ctx.reply(E.search+' Reloading registry from GitHub...');
  if(!GH_OWNER){await getGhOwner().catch(function(){});}
  if(!GH_OWNER){return ctx.reply(E.xmark+' GH_OWNER not set. Check GH_ORG env var.');}
  await loadRegistry().catch(function(e){ctx.reply(E.xmark+' Load failed: '+e.message);});
  return ctx.reply(E.check+' Registry loaded: '+registry.length+' bots.\n\n'+
    registry.map(function(b,i){return (i+1)+'. '+(b.ticker||'Bot '+(i+1))+' ('+b.repoName+')';}).join('\n')||'No bots found.');
});

// Build success quick actions
bot.action('show_bots',async function(ctx){
  await ctx.answerCbQuery();
  return ctx.reply(E.list+' <b>Your Bots</b>\n\n'+
    registry.map(function(b,i){return (i+1)+'. '+E.rocket+' <b>'+(b.ticker||'Bot '+(i+1))+'</b> ('+(b.chain||'bsc').toUpperCase()+')'+'\n'+'   '+(b.mode==='guard'?E.shield+' Guard':E.robot+' Full')+' \u2022 '+(b.d&&b.d.status==='cto'?'CTO':'Active dev')+'\n'+'   '+E.link+' '+b.url;}).join('\n\n'),
    {parse_mode:'HTML',disable_web_page_preview:true});
});
bot.action('build_another',async function(ctx){
  await ctx.answerCbQuery();
  return ctx.reply(E.rocket+' Starting new build...\n\nSend /build to begin.',{parse_mode:'HTML'});
});
bot.action(/^show_edit_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var repoName2=ctx.match[1];
  var idx2=registry.findIndex(function(b){return b.repoName===repoName2;});
  if(idx2<0)return ctx.reply('Bot not found. Use /edit');
  // Simulate /edit selection
  var uid=String(ctx.from.id);
  delete sessions[uid];
  editSessions[uid]={idx:idx2};
  var b=registry[idx2],d=b.d||{};
  return ctx.reply(E.wrench+' Edit <b>'+b.ticker+'</b>\nWhat to change?',{
    parse_mode:'HTML',
    reply_markup:{inline_keyboard:[
      [{text:'\u{1F3AF} Quick Setup',callback_data:'ef_setup_'+idx2}],
      [{text:'Ticker: '+(d.ticker||'not set'),callback_data:'ef_ticker_'+idx2},{text:'CA: '+((d.ca||'not set').slice(0,8)+'...'),callback_data:'ef_ca_'+idx2}],
      [{text:'Twitter/X: '+(d.twitter?'set':'not set'),callback_data:'ef_twitter_'+idx2},{text:'TG: '+(d.tg?'set':'not set'),callback_data:'ef_tg_'+idx2}],
      [{text:'Narrative',callback_data:'ef_narrative_'+idx2},{text:'Supply',callback_data:'ef_supply_'+idx2}],
      [{text:'Tax',callback_data:'ef_tax_'+idx2},{text:'Max wallet',callback_data:'ef_maxwallet_'+idx2}],
      [{text:'Renounced: '+(d.renounced||'?'),callback_data:'ef_ren_'+idx2}],
      [{text:(d.locked==='LOCKED'?'\u2705':'')+' LOCKED',callback_data:'eflp_LOCKED_'+idx2},{text:(d.locked==='BURNED'?'\u2705':'')+' BURNED',callback_data:'eflp_BURNED_'+idx2},{text:((!d.locked||d.locked==='NOT LOCKED')?'\u2705':'')+' NOT LOCKED',callback_data:'eflp_NOTLOCKED_'+idx2}],
      [{text:'Bot image',callback_data:'ef_image_'+idx2},{text:'Silence Breaker',callback_data:'ef_sil_'+idx2}],
      [{text:'Stage',callback_data:'ef_stage_'+idx2},{text:'CTO/Launch',callback_data:'ef_cto_'+idx2}],
      [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
    ]}
  });
});

// TG Login commands
bot.command('tglogin',async function(ctx){
  var phone=(ctx.message.text.split(/\s+/)[1]||TG_PHONE).trim();
  if(!phone)return ctx.reply('Usage: /tglogin +2349xxxxxxx');
  return startTgLogin(ctx,phone);
});

bot.command('tgcode',async function(ctx){
  var code=(ctx.message.text.split(/\s+/)[1]||'').trim();
  if(!code)return ctx.reply('Usage: /tgcode 12345');
  return completeTgLogin(ctx,code);
});

bot.command('tgstatus',async function(ctx){
  if(!tgClient){return ctx.reply('\u274C TG client not connected.\n\nUse /tglogin to connect.');}
  try{
    var me=await tgClient.getMe();
    return ctx.reply('\u2705 TG client connected as @'+(me.username||me.firstName)+'\n\nBotFather automation is ready.');
  }catch(e){return ctx.reply('\u274C Client error: '+e.message);}
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
    msg+=(i+1)+'. '+E.rocket+' <b>'+(b.ticker||b.d&&b.d.ticker||b.d&&b.d.name||'Bot '+(i+1))+'</b> ('+(b.chain||'bsc').toUpperCase()+')\n'+
      '   '+(b.mode==='guard'?E.shield+' Guard':E.robot+' Full')+
      ' \u2022 '+(b.d&&b.d.status==='cto'?'CTO':'Active dev')+'\n'+
      '   '+E.link+' '+b.url+'\n\n';
  });
  return ctx.reply(msg,{parse_mode:'HTML',disable_web_page_preview:true});
});

bot.command('stats',async function(ctx){
  ownerChatIds.add(ctx.chat.id);
  if(!registry.length)return ctx.reply(E.chart+' No bots yet. Use /build.');
  // Try supervisor /health first for real-time data
  if(SUPERVISOR_URL){
    try{
      var sr=await Promise.race([fetch(SUPERVISOR_URL+'/health'),new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},8000);})]);
      var sd=await sr.json();
      if(sd.ok&&sd.details){
        var d2=new Date();
        var utcH=d2.getUTCHours().toString().padStart(2,'0'),utcM=d2.getUTCMinutes().toString().padStart(2,'0');
        var watH=((d2.getUTCHours()+1)%24).toString().padStart(2,'0');
        var lines=[E.chart+' <b>Bot Status Report</b>'];
        lines.push('<i>'+utcH+':'+utcM+' UTC / '+watH+':'+utcM+' WAT</i>');
        lines.push('Supervisor uptime: '+Math.floor(sd.uptime/3600)+'h '+Math.floor((sd.uptime%3600)/60)+'m');
        lines.push('');
        sd.details.forEach(function(b,i){
          var ok=b.status==='online';
          lines.push((i+1)+'. <b>'+(b.ticker||'Bot '+(i+1))+'</b> ('+(b.chain||'bsc').toUpperCase()+')');
          lines.push('   '+(ok?E.check:'\u274C')+' '+(ok?'Online':'Offline')+' \u2022 '+(b.mode==='guard'?'Guard':'Full AI'));
          if(b.analytics){lines.push('   Messages: '+(b.analytics.messages||0)+' \u2022 Shills: '+(b.analytics.shills||0)+' \u2022 CA reqs: '+(b.analytics.caReqs||0));}
          lines.push('');
        });
        var allOk=sd.details.every(function(b){return b.status==='online';});
        lines.push(allOk?E.check+' All bots running.':E.warn+' Some bots need attention.');
        return ctx.reply(lines.join('\n'),{parse_mode:'HTML'});
      }
    }catch(e){console.log('Supervisor health fail:',e.message);}
  }
  // Fallback: old report
  await ctx.reply(E.chart+' Checking all bots...');
  await sendDailyReport(ctx.chat.id);
});;


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
bot.action(/^w_lp_(locked|burned|no)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var val=ctx.match[1],uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.locked=val==='locked'?'LOCKED':val==='burned'?'BURNED':'NOT LOCKED';
  s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}
  await showStep(ctx,s,uid);
});

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
bot.action(/^w_stage_(live|prelaunch|noCA)_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var stage=ctx.match[1],uid=ctx.match[2],s=sessions[uid];
  if(!s)return ctx.reply(E.xmark+' Session expired.');
  s.d.stage=stage;
  // noCA  skip CA, twitter, tax, maxwallet, lp steps
  if(stage==='noCA'){
    s.d.ca='TBA';
    // Keep twitter  X is still visible even with no CA
    s.d.buyTax='0';
    s.d.sellTax='0';
    s.d.renounced='PENDING';
    s.d.locked='PENDING';
  }
  s.step=nextStep(s);
  try{await ctx.deleteMessage();}catch(_){}
  await showStep(ctx,s,uid);
});

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
  if(field==='img'){/* keep imgBufs, just move on */}
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
  var uid=String(ctx.from.id);delete sessions[uid];editSessions[uid]={idx:i};
  var d=b.d||{};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.wrench+' <b>Edit '+b.ticker+'</b>\nWhat to change?',{parse_mode:'HTML',reply_markup:{inline_keyboard:[
    [{text:'\u{1F3AF} Quick Setup (fill missing)',callback_data:'ef_setup_'+i}],
    [{text:(d.ticker&&d.ticker!=='$TOKEN'?'\u2705 ':'')+' Ticker: '+(d.ticker&&d.ticker!=='$TOKEN'?d.ticker:'not set'),callback_data:'ef_ticker_'+i},
     {text:(d.ca?'\u2705 ':'')+' CA: '+(d.ca?d.ca.slice(0,6)+'...':'not set'),callback_data:'ef_ca_'+i}],
    [{text:(d.twitter?'\u2705 ':'')+' Twitter/X: '+(d.twitter?'set':'not set'),callback_data:'ef_twitter_'+i},
     {text:(d.tg?'\u2705 ':'')+' TG: '+(d.tg?'set':'not set'),callback_data:'ef_tg_'+i}],
    [{text:(d.narrative?'\u2705 ':'')+' Narrative',callback_data:'ef_narrative_'+i},
     {text:(d.supply&&d.supply!=='N/A'?'\u2705 ':'')+' Supply',callback_data:'ef_supply_'+i}],
    [{text:(d.buyTax&&d.buyTax!=='?'?'\u2705 ':'')+' Tax: '+(d.buyTax||'?')+'/'+(d.sellTax||'?')+'%',callback_data:'ef_tax_'+i},
     {text:(d.maxWalletPct?'\u2705 ':'')+' Max Wallet: '+(d.maxWalletPct||'not set'),callback_data:'ef_maxwallet_'+i}],
    [{text:(d.renounced?'\u2705 ':'')+' Renounced: '+(d.renounced||'not set'),callback_data:'ef_ren_'+i}],
    [{text:(d.locked==='LOCKED'?'\u2705':'')+' LOCKED',callback_data:'eflp_LOCKED_'+i},
     {text:(d.locked==='BURNED'?'\u2705':'')+' BURNED',callback_data:'eflp_BURNED_'+i},
     {text:(!d.locked||d.locked==='NOT LOCKED'?'\u2705':'')+' NOT LOCKED',callback_data:'eflp_NOTLOCKED_'+i}],
    [{text:'\u{1F4F7} Bot image',callback_data:'ef_image_'+i},
     {text:'\u{1F514} Silence: '+({'0':'Off','600000':'10m','1800000':'30m','3600000':'1h','7200000':'2h','10800000':'3h'}[String(d.silenceBreaker||'3600000')]||'1h'),callback_data:'ef_sil_'+i}],
    [{text:'Stage: '+({'live':'\u{1F7E2} Live','prelaunch':'\u{1F7E1} Pre-launch','noCA':'\u26AA No CA'}[(b.d&&b.d.stage)||'live']||'Live'),callback_data:'ef_stage_'+i},
    ],
    [{text:(d.stage==='live'?'\u2705':'')+' Live',callback_data:'esg_live_'+i},
     {text:(d.stage==='prelaunch'?'\u2705':'')+' Pre-launch',callback_data:'esg_prelaunch_'+i},
     {text:(d.stage==='noCA'?'\u2705':'')+' No CA',callback_data:'esg_noCA_'+i}],
    [{text:(d.status==='cto'?'\u2705':'')+' CTO',callback_data:'ecto_cto_'+i},
     {text:(d.status!=='cto'?'\u2705':'')+' Active Dev',callback_data:'ecto_dev_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
  ]}});
});

bot.action(/^ef_(ticker|ca|twitter|tg|narrative|supply|tax|maxwallet)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var field=ctx.match[1],i=parseInt(ctx.match[2]),uid=String(ctx.from.id);
  editSessions[uid]={idx:i,field:field};
  var asks={ticker:'New ticker symbol (e.g. $MPC  include the $):',ca:'New contract address (CA):',twitter:'New Twitter/X link:',tg:'New Telegram group link (e.g. https://t.me/yourgroup):',narrative:'New narrative (1-2 sentences):',supply:'New supply (e.g. 1B or 1,000,000,000):',tax:'New tax as buy/sell (e.g. 5/5):',maxwallet:'New max wallet % (e.g. 4.9 or - to remove):'};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.pencil+' '+asks[field]);
});
// Quick setup  fills empty fields one by one
bot.action(/^ef_setup_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return;
  var uid=String(ctx.from.id);
  var d=b.d||{};
  // Find first missing required field
  var missing=[];
  if(!d.ticker||d.ticker==='$TOKEN')missing.push('ticker');
  if(!d.ca)missing.push('ca');
  if(!d.twitter)missing.push('twitter');
  if(!d.tg)missing.push('tg');
  if(!d.narrative)missing.push('narrative');
  if(!d.supply||d.supply==='N/A')missing.push('supply');
  if(!missing.length){try{await ctx.deleteMessage();}catch(_){}return ctx.reply(E.check+' All fields are filled! Use /edit to make changes.');}
  var field=missing[0];
  var asks={ticker:'Ticker symbol (e.g. $NRISE  include the $):',ca:'Contract address (CA):',
    twitter:'Twitter/X link:',tg:'Telegram group link:',
    narrative:'Short narrative (1-2 sentences about the project):',
    supply:'Total supply (e.g. 1,000,000,000):'};
  editSessions[uid]={idx:i,field:field,setupMode:true,setupQueue:missing};
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(
    E.pencil+' <b>Quick Setup ('+missing.length+' fields missing)</b>\n\n'+
    'Field '+1+'/'+missing.length+': <b>'+field.toUpperCase()+'</b>\n\n'+asks[field]+'\n\n<i>Type your answer and send</i>',
    {parse_mode:'HTML'}
  );
});

bot.action(/^ef_image_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),uid=String(ctx.from.id);
  editSessions[uid]={idx:i,field:'image'};try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.pencil+' Send new bot image (photo):');
});
bot.action(/^ectos_(cto|launch)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var val=ctx.match[1],i=parseInt(ctx.match[2]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.status=val;
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'Status set to '+(val==='cto'?'CTO':'Active Dev'));
});

bot.action(/^ef_stage_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return ctx.reply('Not found.');
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply('\u{1F7E2} Project stage:',{reply_markup:{inline_keyboard:[
    [{text:'\u{1F7E2} Already live \u2014 CA is public',callback_data:'esg_live_'+i}],
    [{text:'\u{1F7E1} About to launch \u2014 CA ready, not dropped',callback_data:'esg_prelaunch_'+i}],
    [{text:'\u26AA Pre-launch \u2014 no CA yet',callback_data:'esg_noCA_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
  ]}});
});

bot.action(/^esg_(live|prelaunch|noCA)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var stage=ctx.match[1],i=parseInt(ctx.match[2]),b=registry[i];if(!b)return ctx.reply('Not found.');
  b.d=b.d||{};b.d.stage=stage;
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'stage updated to '+stage);
});

bot.action(/^ef_sil_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return;
  try{await ctx.deleteMessage();}catch(_){}
  var cur=String(b.d&&b.d.silenceBreaker||'3600000');
  var opts={
    '0':'Off','600000':'10 min','1800000':'30 min',
    '3600000':'1 hr','7200000':'2 hr','10800000':'3 hr'
  };
  var kb=Object.keys(opts).map(function(v){
    return [{text:(v===cur?'\u2705 ':'')+opts[v],callback_data:'esil_'+v+'_'+i}];
  });
  kb.push([{text:E.xmark+' Cancel',callback_data:'ecancel'}]);
  return ctx.reply(E.bell+' <b>Silence Breaker</b>\nBot posts when group is quiet for this long:',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});

bot.action(/^esil_([0-9]+)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();var val=ctx.match[1],i=parseInt(ctx.match[2]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.silenceBreaker=val;
  try{await ctx.deleteMessage();}catch(_){}
  var labels={'0':'Off','600000':'10 min','1800000':'30 min','3600000':'1 hr','7200000':'2 hr','10800000':'3 hr'};
  await pushAndSave(ctx,b,'Silence breaker set to '+(labels[val]||val));
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
bot.action(/^eflp_([A-Z]+)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var val=ctx.match[1]==='NOTLOCKED'?'NOT LOCKED':ctx.match[1];
  var i=parseInt(ctx.match[2]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.locked=val;
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'LP set to '+val);
});
bot.action(/^ef_cto_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var i=parseInt(ctx.match[1]),b=registry[i];if(!b)return;
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply('\u{1F3AF} <b>Project Status</b>\nSelect:',{parse_mode:'HTML',reply_markup:{inline_keyboard:[
    [{text:(b.d&&b.d.status==='cto'?'\u2705 ':'')+' CTO (Community Takeover)',callback_data:'ectos_cto_'+i}],
    [{text:(b.d&&b.d.status!=='cto'?'\u2705 ':'')+' Active Dev',callback_data:'ectos_launch_'+i}],
    [{text:E.xmark+' Cancel',callback_data:'ecancel'}],
  ]}});
});
// Status select buttons
bot.action(/^ecto_(cto|dev)_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();
  var i=parseInt(ctx.match[2]),b=registry[i];if(!b)return;
  b.d=b.d||{};b.d.status=ctx.match[1]==='cto'?'cto':'launch';
  try{await ctx.deleteMessage();}catch(_){}
  await pushAndSave(ctx,b,'Status set to '+(b.d.status==='cto'?'CTO':'Active Dev'));
});

bot.action('ecancel',async function(ctx){
  await ctx.answerCbQuery();delete editSessions[String(ctx.from.id)];
  try{await ctx.deleteMessage();}catch(_){}return ctx.reply(E.xmark+' Cancelled.');
});

async function pushAndSave(ctx,b,what){
  await ctx.reply(E.gear+' Saving...');
  try{
    if(b.repoName&&b.ghOwner){
      var botCode=genBot(b.d,CHAIN[b.chain]||CHAIN.bsc,b.mode);
      botCode='// build:'+Date.now()+'\n'+botCode;
      await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(botCode));
    }
    saveRegistry();
    var editEntry2=registry.find(function(x){return x.repoName===b.repoName;});
    if(editEntry2)syncToBotsJson(editEntry2).catch(function(){});
    scheduleReload(ctx);
    return ctx.reply(
      E.check+' <b>'+b.ticker+'</b> \u2014 '+what+'!\n\n'
      +E.clock+' Deploying in ~8s. Wait for this before next edit.',
      {parse_mode:'HTML', reply_markup:{inline_keyboard:[
        [{text:E.chart+' View bots',callback_data:'show_bots'},{text:E.pencil+' Edit this bot',callback_data:'show_edit_'+(b.repoName||'')}],
        [{text:E.rocket+' Build another',callback_data:'build_another'}],
      ]}}
    );
  }catch(e){return ctx.reply(E.xmark+' Failed: '+e.message);}
}

//  REBUILD / UPDATE 
//  CLEANUP SYSTEM 
var cleanupSessions={}; // uid -> {renderOrphans, ghOrphans}

async function getRenderServices(){
  var all=[];
  try{
    var r=await fetch('https://api.render.com/v1/services?limit=100',{headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json'}});
    var d=await r.json();
    if(Array.isArray(d))all=d.map(function(s){return{id:(s.service||s).id,name:(s.service||s).name,url:'https://'+(s.service||s).name+'.onrender.com'};});
  }catch(e){console.log('Render list:',e.message);}
  return all;
}

async function getGithubRepos(){
  var all=[];
  try{
    var r=await fetch('https://api.github.com/user/repos?per_page=100&sort=updated',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
    var d=await r.json();
    if(Array.isArray(d))all=d.filter(function(r){return r.name.match(/-bot-[a-z0-9]{4}$/);}).map(function(r){return{name:r.name,full_name:r.full_name};});
  }catch(e){console.log('GH list:',e.message);}
  return all;
}

async function deleteRenderService(svcId){
  await fetch('https://api.render.com/v1/services/'+svcId,{method:'DELETE',headers:{'Authorization':'Bearer '+RENDER_KEY,'Accept':'application/json'}});
}

async function deleteGithubRepo(fullName){
  await fetch('https://api.github.com/repos/'+fullName,{method:'DELETE',headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
}

bot.command('cleanup',async function(ctx){
  ownerChatIds.add(ctx.chat.id);
  var pm=await ctx.reply(E.search+' Scanning all services...');
  var renderSvcs=await getRenderServices();
  var ghRepos=await getGithubRepos();
  // Registry URLs and repo names
  var regUrls=new Set(registry.map(function(b){return(b.url||'').replace(/\/+$/,'').toLowerCase();}));
  var regRepos=new Set(registry.map(function(b){return(b.repoName||'').toLowerCase();}));
  regRepos.add('bot-factory'); // never delete the factory
  // Find orphans
  // Only target render services built by factory (pattern: name-bot-XXXX)
  var rOrphans=renderSvcs.filter(function(s){
    var u=s.url.toLowerCase();
    var isFactoryBot=s.name.match(/^.+-bot-[a-z0-9]{4}$/)&&s.name!=='bot-factory';
    return isFactoryBot&&!regUrls.has(u);
  });
  // Only target repos built by factory (pattern: name-bot-XXXX)
  var gOrphans=ghRepos.filter(function(r){
    var isFactoryBot=r.name.match(/^.+-bot-[a-z0-9]{4}$/);
    return isFactoryBot&&!regRepos.has(r.name.toLowerCase());
  });
  try{await ctx.telegram.deleteMessage(ctx.chat.id,pm.message_id);}catch(_){}
  if(!rOrphans.length&&!gOrphans.length){
    return ctx.reply(E.check+' Nothing to clean up! All services match your registered bots.');
  }
  var uid=String(ctx.from.id);
  // Also find orphan cron jobs
  var cronJobs=await getCronJobs();
  var regNames=new Set(registry.map(function(b){return(b.repoName||'').toLowerCase();}));
  // Only target cron jobs for factory-built bots (URL matches registry bot or factory bot pattern)
  var factoryUrls=new Set(registry.map(function(b){return(b.url||'').replace(/\/health\/?$/,'').replace(/\/+$/,'').toLowerCase();}));
  var cOrphans=cronJobs.filter(function(j){
    if(!j.url)return false;
    var jBase=j.url.replace(/\/health\/?$/,'').replace(/\/+$/,'').toLowerCase();
    var jHost=(jBase.match(/https?:\/\/([a-z0-9-]+)\.onrender\.com/)||[])[1]||'';
    // Must match factory bot pattern AND not be in registry
    var isFactoryBot=jHost.match(/^.+-bot-[a-z0-9]{4}$/)&&!jHost.includes('factory');
    return isFactoryBot&&!factoryUrls.has(jBase);
  })
  cleanupSessions[uid]={renderOrphans:rOrphans,ghOrphans:gOrphans,cronOrphans:cOrphans};
  var msg=E.warn+' <b>Orphaned services found</b>\n\n';
  if(rOrphans.length){
    msg+='<b>Hosting services ('+rOrphans.length+'):</b>\n';
    rOrphans.forEach(function(s,i){msg+=(i+1)+'. '+s.name+'\n';});
    msg+='\n';
  }
  if(gOrphans.length){
    msg+='<b>Code repositories ('+gOrphans.length+'):</b>\n';
    gOrphans.forEach(function(r,i){msg+=(i+1)+'. '+r.name+'\n';});
    msg+='\n';
  }
  if(cOrphans.length){
    msg+='<b>Scheduled jobs ('+cOrphans.length+'):</b>\n';
    cOrphans.forEach(function(j,i){msg+=(i+1)+'. '+j.title+'\n';});
    msg+='\n';
  }
  msg+='These are NOT in your bot registry.\n<i>Your active bots are safe.</i>';
  var kb={inline_keyboard:[
    [{text:E.xmark+' Delete ALL orphans',callback_data:'cln_all_'+uid}],
    [{text:E.check+' Keep everything',callback_data:'cln_cancel_'+uid}],
  ]};
  if(rOrphans.length)kb.inline_keyboard.splice(1,0,[{text:'\u{1F5D1}\uFE0F Delete hosting only',callback_data:'cln_render_'+uid}]);
  if(gOrphans.length)kb.inline_keyboard.splice(1,0,[{text:'\u{1F5C4}\uFE0F Delete repos only',callback_data:'cln_gh_'+uid}]);
  return ctx.reply(msg,{parse_mode:'HTML',reply_markup:kb});
});

async function getCronJobs(){
  var all=[];
  try{
    var r=await fetch('https://api.cron-job.org/jobs',{
      headers:{'Authorization':'Bearer '+CRON_KEY,'Accept':'application/json','Content-Type':'application/json'}
    });
    if(!r.ok){console.log('Cron list HTTP:',r.status);return all;}
    var txt=await r.text();
    var d=JSON.parse(txt);
    // API returns {jobs:[...]} or array directly
    var jobs=Array.isArray(d)?d:(d.jobs||[]);
    all=jobs.map(function(j){
      // API may use jobId or identifier
      var id=j.jobId||j.identifier||j.id;
      var url=(j.url&&j.url.url)||j.url||'';
      return{id:id,title:j.title||('Job '+id),url:url};
    }).filter(function(j){return j.id;});
    console.log('Cron jobs found:',all.length);
  }catch(e){console.log('Cron list error:',e.message);}
  return all;
}

async function deleteCronJob(jobId){
  var r=await fetch('https://api.cron-job.org/jobs/'+jobId,{
    method:'DELETE',
    headers:{'Authorization':'Bearer '+CRON_KEY,'Accept':'application/json','Content-Type':'application/json'}
  });
  console.log('Delete cron',jobId,':',r.status);
  return r.ok||r.status===204||r.status===200;
}

async function doCleanup(ctx,uid,renderOnly,ghOnly){
  var cs=cleanupSessions[uid];if(!cs)return ctx.reply('Session expired.');
  delete cleanupSessions[uid];
  try{await ctx.deleteMessage();}catch(_){}
  var pm=await ctx.reply(E.gear+' Cleaning up...');
  var deleted=[],failed=[];
  if(!ghOnly){
    for(var i=0;i<cs.renderOrphans.length;i++){
      var s=cs.renderOrphans[i];
      try{await deleteRenderService(s.id);deleted.push('Hosting: '+s.name);}
      catch(e){failed.push('Hosting: '+s.name+' ('+e.message.slice(0,40)+')');}
    }
  }
  if(!renderOnly){
    for(var j=0;j<cs.ghOrphans.length;j++){
      var r=cs.ghOrphans[j];
      try{await deleteGithubRepo(r.full_name);deleted.push('Repo: '+r.name);}
      catch(e){failed.push('Repo: '+r.name+' ('+e.message.slice(0,40)+')');}
    }
  }
  // Always delete orphan cron jobs regardless of renderOnly/ghOnly
  if(cs.cronOrphans&&cs.cronOrphans.length){
    for(var k=0;k<cs.cronOrphans.length;k++){
      var cj=cs.cronOrphans[k];
      try{await deleteCronJob(cj.id);deleted.push('Cron job: '+cj.title);}
      catch(e){failed.push('Cron job: '+cj.title+' ('+e.message.slice(0,40)+')');}
    }
  }
  try{await ctx.telegram.deleteMessage(ctx.chat.id,pm.message_id);}catch(_){}
  var msg='';
  if(deleted.length)msg+=E.check+' <b>Deleted ('+deleted.length+'):</b>\n'+deleted.map(function(d){return'\u2022 '+d;}).join('\n')+'\n\n';
  if(failed.length)msg+=E.xmark+' <b>Failed ('+failed.length+'):</b>\n'+failed.map(function(f){return'\u2022 '+f;}).join('\n')+'\n\n';
  if(!msg)msg='Nothing was deleted.';
  return ctx.reply(msg.trim(),{parse_mode:'HTML'});
}

bot.action(/^cln_all_(.+)$/,async function(ctx){await ctx.answerCbQuery();await doCleanup(ctx,ctx.match[1],false,false);});
bot.action(/^cln_render_(.+)$/,async function(ctx){await ctx.answerCbQuery();await doCleanup(ctx,ctx.match[1],true,false);});
bot.action(/^cln_gh_(.+)$/,async function(ctx){await ctx.answerCbQuery();await doCleanup(ctx,ctx.match[1],false,true);});
bot.action(/^cln_cancel_(.+)$/,async function(ctx){
  await ctx.answerCbQuery();
  delete cleanupSessions[ctx.match[1]];
  try{await ctx.deleteMessage();}catch(_){}
  return ctx.reply(E.check+' Cancelled. Nothing was deleted.');
});

bot.command('fixgroq',async function(ctx){
  if(!groqPool.length)return ctx.reply(E.xmark+' No AI keys in pool. Use /addgroq first.');
  var eligible=registry.filter(function(b){return b.svcId&&b.mode==='full';});
  if(!eligible.length)return ctx.reply(E.xmark+' No bots with service IDs found. Try /rebuild instead.');
  await ctx.reply(E.gear+' Updating AI keys on '+eligible.length+' bot(s)...');
  var results=[];
  for(var i=0;i<eligible.length;i++){
    var b=eligible[i];
    try{
      var ev=[{key:'GROQ_API_KEY',value:groqPool[0]}];
      groqPool.forEach(function(k,idx){ev.push({key:'GROQ_KEY_'+(idx+1),value:k});});
      await renderEnv(b.svcId,ev);
      results.push(E.check+' <b>'+b.ticker+'</b>');
    }catch(e){results.push(E.xmark+' <b>'+b.ticker+'</b>: '+e.message.slice(0,50));}
  }
  return ctx.reply(results.join('\n')+'\n\nAI keys updated. Bots restart in ~1 min.',{parse_mode:'HTML'});
});

bot.command('rebuild',async function(ctx){
  var el=registry.filter(function(b){return b.repoName;});
  if(!el.length)return ctx.reply(E.wrench+' No bots registered yet. Use /build.');
  var kb=el.map(function(b){var i=registry.indexOf(b);var tk=b.ticker||b.d&&b.d.ticker||b.d&&b.d.name||'Bot '+(i+1);var warn=(!b.ticker||b.ticker==='$TOKEN')?'  \u26A0\uFE0F':'';return[{text:tk+' ('+(b.chain||'bsc').toUpperCase()+')'+warn,callback_data:'rbd_'+i}];});
  return ctx.reply(E.gear+' <b>Full rebuild from stored data:</b>\n<i>Use after changing personality, CTO mode, silence breaker etc via /edit</i>',{parse_mode:'HTML',reply_markup:{inline_keyboard:kb}});
});
bot.action(/^rbd_(\d+)$/,async function(ctx){
  await ctx.answerCbQuery();try{await ctx.deleteMessage();}catch(_){}
  var i=parseInt(ctx.match[1]),b=registry[i];
  if(!b||!b.repoName||!b.ghOwner)return ctx.reply(E.xmark+' No repo linked.');
  await ctx.reply(E.gear+' Rebuilding <b>'+(b.ticker||'bot')+'</b>...',{parse_mode:'HTML'});
  try{
    // Push updated code to GitHub
    var botCode=genBot(b.d,CHAIN[b.chain]||CHAIN.bsc,b.mode);
    botCode='// build:'+Date.now()+'\n'+botCode;
    await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(botCode));
    await githubUpdate(b.ghOwner,b.repoName,'package.json',Buffer.from(genPkg(b.d&&b.d.name||b.ticker,b.mode)));
    // Update registry and signal supervisor
    registry[i]=Object.assign({},b,{status:'active'});
    saveRegistry();
    await sleep(2000);
    await signalReload();
    await ctx.reply(E.check+' <b>'+(b.ticker||'Bot')+'</b> redeployed!\n\nSupervisor is restarting the bot now.',{parse_mode:'HTML'});
  }catch(e){
    await ctx.reply(E.xmark+' Rebuild failed\n<code>'+e.message.slice(0,200)+'</code>',{parse_mode:'HTML'});
  }
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
    try{var botCode=genBot(b.d,CHAIN[b.chain]||CHAIN.bsc,b.mode);
    botCode='// build:'+Date.now()+'\n'+botCode;
    await githubUpdate(b.ghOwner,b.repoName,'bot.js',Buffer.from(botCode));results.push(E.check+' <b>'+b.ticker+'</b>');}
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
      var eBase=(b.ticker||'token').replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
      if(!es.imgCount)es.imgCount=0;
      var eImgFile=eBase+(es.imgCount===0?'':es.imgCount+1)+'.jpg';
      await githubUpdate(b.ghOwner,b.repoName,eImgFile,buf);
      es.imgCount++;
      if(es.imgCount<5){
        return ctx.reply(E.check+' Image '+es.imgCount+' uploaded. Send another or tap Done.',
          {reply_markup:{inline_keyboard:[[{text:E.check+' Done',callback_data:'ef_imgdone_'+es.idx}]]}});
      }
      delete editSessions[uid];return ctx.reply(E.check+' Images updated! Supervisor reloading.');
    }catch(e){delete editSessions[uid];return ctx.reply(E.xmark+' Failed: '+e.message);}
  }
  // Wizard image  accumulate up to 5
  var s=sessions[uid];
  if(!s||s.step!=='img')return;
  var ph2=ctx.message.photo[ctx.message.photo.length-1];
  try{
    var lnk2=await ctx.telegram.getFileLink(ph2.file_id);
    var rb2=await fetch(lnk2.href);
    var imgData=Buffer.from(await rb2.arrayBuffer());
    if(!s.imgBufs)s.imgBufs=[];
    s.imgBufs.push(imgData);
    s.imgBuf=s.imgBufs[0]; // keep first as primary
    try{await ctx.deleteMessage();}catch(_){}
    if(s.imgBufs.length<5){
      // Ask for more or skip
      var m2=await ctx.reply(
        E.check+' Image '+s.imgBufs.length+' saved. Send another photo to add more (up to 5), or tap Done.',
        {reply_markup:{inline_keyboard:[[{text:E.check+' Done',callback_data:'w_skip_img_'+uid}]]}}
      );
      s.lastMsgId=m2.message_id;
    } else {
      var m3=await ctx.reply(E.check+' 5 images saved! Moving on...');
      s.lastMsgId=m3.message_id;
      s.step=nextStep(s);
      await showStep(ctx,s,uid);
    }
  } catch(e){return ctx.reply(E.xmark+' Image error: '+e.message);}
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
    var newKey=text.trim();
    if(!groqPool.includes(newKey))groqPool.push(newKey);
    await ctx.reply(E.check+' AI key added! Pool: '+groqPool.length+' key(s).\n'+E.gear+' Pushing to all bots...');
    // Auto-push all keys to every bot that has a svcId
    var pushed=0,failed=0;
    for(var _bi=0;_bi<registry.length;_bi++){
      var _b=registry[_bi];
      if(!_b.svcId||_b.mode!=='full')continue;
      try{
        var _ev=[{key:'GROQ_API_KEY',value:groqPool[0]}];
        groqPool.forEach(function(k,i){_ev.push({key:'GROQ_KEY_'+(i+1),value:k});});
        await renderEnv(_b.svcId,_ev);
        pushed++;
      }catch(_){failed++;}
    }
    var summary=pushed?E.check+' Pushed to '+pushed+' bot(s).':'';
    var failNote=failed?' '+failed+' skipped (no service ID).':'';
    var skipNote=(registry.filter(function(b){return b.mode==='full'&&!b.svcId;}).length)?' Use /rebuild for bots without service ID.':'';
    return ctx.reply(summary+(failNote||skipNote||' All bots updated!'));
  }

  // Edit text fields
  var es=editSessions[uid];
  if(es&&es.field&&es.field!=='image'){
    var b=registry[es.idx];if(!b){delete editSessions[uid];return;}
    try{await ctx.deleteMessage();}catch(_){}
    b.d=b.d||{};
    if(es.field==='ticker'){var tk=text.trim();if(!tk.startsWith('$'))tk='$'+tk;b.d.ticker=tk.toUpperCase();b.ticker=b.d.ticker;}
    if(es.field==='ticker'){var tk2=text.trim();if(!tk2.startsWith('$'))tk2='$'+tk2;b.d.ticker=tk2.toUpperCase();b.ticker=b.d.ticker;}
    if(es.field==='ca')        b.d.ca=text.trim();
        if(es.field==='twitter')  b.d.twitter=text;
    if(es.field==='tg')       b.d.tg=text.startsWith('http')||text.startsWith('@')?text:'';
    if(es.field==='narrative')b.d.narrative=text;
    if(es.field==='supply')   b.d.supply=text;
    if(es.field==='maxwallet')b.d.maxWalletPct=(text==='-'?'':text);
    if(es.field==='tax'){var tx=text.split('/');b.d.buyTax=(tx[0]||'5').trim();b.d.sellTax=(tx[1]||tx[0]||'5').trim();}
    // Setup mode  continue to next missing field
    if(es.setupMode&&es.setupQueue&&es.setupQueue.length>1){
      es.setupQueue.shift(); // remove current field
      var nextField=es.setupQueue[0];
      var asks2={ticker:'Ticker symbol (e.g. $NRISE):',ca:'Contract address (CA):',
        twitter:'Twitter/X link:',tg:'Telegram group link:',
        narrative:'Short narrative (1-2 sentences):',supply:'Total supply:'};
      var done=Object.keys(b.d).filter(function(k){return asks2[k]&&b.d[k];}).length;
      saveRegistry();
      var editEntry3=registry.find(function(x){return x.repoName===b.repoName;});
      if(editEntry3)syncToBotsJson(editEntry3).catch(function(){});
      editSessions[uid]={idx:es.idx,field:nextField,setupMode:true,setupQueue:es.setupQueue};
      try{await ctx.deleteMessage();}catch(_){}
      return ctx.reply(
        E.check+' Saved! Now '+es.setupQueue.length+' left.\n\n'+
        'Next: <b>'+nextField.toUpperCase()+'</b>\n\n'+asks2[nextField]+'\n\n<i>Type your answer and send</i>',
        {parse_mode:'HTML'}
      );
    }
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

    var btn_steps=['chain','mode','gt','status','stage','pers','rmode','sil','tax','maxwallet','lp'];
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
      if(data.renounced===true){
        s.d.renounced='RENOUNCED';
      } else {
        // Could not verify on-chain  leave blank so user confirms in wizard step
        s.d.renounced=s.d.renounced||'';
      }
      var foundMsg=E.check+' <b>Token data found!</b>\n\n'+
        '<b>Name:</b> '+data.name+'\n'+
        '<b>Ticker:</b> '+data.ticker+'\n'+
        (data.supply?'<b>Supply:</b> '+data.supply+'\n':'')+
        (data.twitter?'<b>Twitter:</b> '+data.twitter+'\n':'')+
        '<b>Contract:</b> '+data.renouncedText+'\n'+
        (data.errors.length?'\n<i>Note: '+data.errors.join(', ')+'</i>':'');
      var fm2=await ctx.reply(foundMsg,{parse_mode:'HTML'});
      await sleep(1500); // Brief pause so user can see what was fetched
      try{await ctx.telegram.deleteMessage(ctx.chat.id,fm2.message_id);}catch(_){}
    } else {
      var nf=await ctx.reply(E.warn+' Could not auto-fetch token data.\n\nEnter your token ticker (e.g. $MPC):');
      s.lastMsgId=nf.message_id;
      s.step='ticker_manual';
      return;
    }
    s.step=nextStep(s);
    await showStep(ctx,s,uid);
    return;
  }

  // Twitter
  if(s.step==='ticker_manual'){
    var parts=text.trim().split(/\s+/);
    var tk=parts[0]||'';
    if(!tk.startsWith('\$'))tk='\$'+tk;
    s.d.ticker=tk.toUpperCase();
    if(parts[1])s.d.name=parts.slice(1).join(' ');
    else if(!s.d.name||s.d.name==='Token')s.d.name=tk.replace('\$','');
    s.step=nextStep(s);await showStep(ctx,s,uid);return;
  }
  if(s.step==='twitter'){
    var tw=text.trim();
    if(tw.includes('onrender.com')||tw==='-')tw='';
    s.d.twitter=tw;
    s.step=nextStep(s);await showStep(ctx,s,uid);return;
  }
  if(s.step==='tg'){
    var tg=text.trim();
    s.d.tg=(tg.startsWith('http')||tg.startsWith('@')||tg==='-'||tg.toLowerCase()==='skip')?tg.toLowerCase()==='skip'||tg==='-'?'':tg:'';
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
  if(d.stage==='prelaunch'){d.revealCmd=d.revealCmd||rndCmd();d.hideCmd=d.hideCmd||rndCmd();}else{d.revealCmd='';d.hideCmd='';}
  d.name=d.name||d.ticker.replace('$','');
  var repoName=d.ticker.replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase()+'-bot-'+rnd(4);
  var guessUrl='';
  await ctx.reply(E.gear+' Deploying <b>'+d.ticker+'</b>...',{parse_mode:'HTML'});
  var ghOwner='',svcId='',actualUrl='';
  var steps=[
    {n:'Setting up',fn:async function(){
      var g=await githubCreateRepo(repoName);
      ghOwner=g.full_name.split('/')[0];GH_OWNER=GH_OWNER||ghOwner;
      await sleep(4000);
      await githubPush(ghOwner,repoName,'bot.js',Buffer.from(genBot(d,ci,d.mode)));
      await githubPush(ghOwner,repoName,'package.json',Buffer.from(genPkg(d.name,d.mode)));
      var imgBase=d.ticker.replace(/\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
      var imgBufs=s.imgBufs&&s.imgBufs.length?s.imgBufs:(s.imgBuf?[s.imgBuf]:[]);
      for(var ii=0;ii<imgBufs.length;ii++){
        var imgFile=imgBase+(ii===0?'':ii+1)+'.jpg';
        await githubPush(ghOwner,repoName,imgFile,imgBufs[ii]);
      }
    }},
    {n:'Deploying bot',fn:async function(){
      var botId=repoName;
      var existing=registry.findIndex(function(b){return b.repoName===repoName;});
      var entry={id:botId,ticker:d.ticker,chain:d.chain,mode:d.mode,repoName:repoName,ghOwner:ghOwner,
        d:JSON.parse(JSON.stringify(d)),
        state:{caUnlocked:d.stage==='live',groupChatId:null,shoutoutOn:true},
        analytics:{messages:0,shills:0,caReqs:0,priceReqs:0,joinedAt:Date.now()},
        status:'active',builtAt:Date.now()};
      if(existing>=0){registry[existing]=entry;}else{registry.push(entry);}
      saveRegistry();
      await syncToBotsJson(entry);
      await sleep(2000);
      await signalReload();
    }},
  ];
  var ok=true;
  for(var i=0;i<steps.length;i++){
    try{await steps[i].fn();await ctx.reply(E.check+' '+steps[i].n+' done');}
    catch(e){await ctx.reply(E.xmark+' '+steps[i].n+' failed\n<code>'+e.message.slice(0,200)+'</code>',{parse_mode:'HTML'});ok=false;break;}
  }
  if(ok){
    delete sessions[uid];
    await ctx.reply(
      E.party+' <b>'+d.ticker+' is live!</b>\n\n'+
      E.check+' Bot is registered and starting up.\n'+
      E.check+' Add it to your group and make it admin.\n'+
      E.check+' AI, moderation, shill and price all active.\n\n'+
      (d.stage==='prelaunch'&&d.revealCmd?E.warn+' <b>Secret commands:</b>\n'+'Reveal CA: <code>/'+d.revealCmd+'</code>\nHide CA: <code>/'+d.hideCmd+'</code>\n\n':'')+
      '<b>Next steps:</b>\n'+
      '1. Wait 3-5 min for bot to build\n'+
      '2. Add bot to your Telegram group\n'+
      '3. Make it admin (delete messages + restrict)\n'+
      '4. Use <code>/'+d.revealCmd+'</code> in group to reveal CA'+
      (d.stage==='noCA'?'\n\n'+
        E.warn+' <b>When your CA is ready:</b>\n'+
        '1. Come back to this bot\n'+
        '2. Send /edit \u2192 select '+d.ticker+'\n'+
        '3. Tap CA \u2192 paste your contract address\n'+
        '4. Send /rebuild \u2192 select '+d.ticker+'\n'+
        '5. Your bot will immediately handle CA requests':''),
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
var reloadTimer=null;
var pendingReloadCtx=null;
function scheduleReload(ctx){
  if(ctx)pendingReloadCtx=ctx;
  if(reloadTimer)clearTimeout(reloadTimer);
  reloadTimer=setTimeout(async function(){
    reloadTimer=null;
    await signalReload();
    // Wait for supervisor to reload then confirm
    if(pendingReloadCtx&&SUPERVISOR_URL){
      var rCtx=pendingReloadCtx;
      pendingReloadCtx=null;
      setTimeout(async function(){
        try{
          var hr=await fetch(SUPERVISOR_URL+'/health');
          var hd=await hr.json();
          var online=hd.details?hd.details.filter(function(b){return b.status==='online';}).length:0;
          await rCtx.reply(
            E.check+' <b>All done!</b>\n\n'
            +E.rocket+' Bots online: '+online+'/'+hd.bots+'\n'
            +E.check+' Ready for next edit.',
            {parse_mode:'HTML'}
          );
        }catch(_){}
      },20000); // Check after 20s
    }
  },8000);
}

// Sync one bot entry to bots.json (supervisor's file) additively
async function syncToBotsJson(entry){
  if(!GH_OWNER||!entry)return;
  try{
    // Read current bots.json
    var r=await fetch('https://api.github.com/repos/'+GH_OWNER+'/bot-factory/contents/bots.json',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
    var current=[];
    var sha='';
    if(r.ok){var d=await r.json();sha=d.sha||'';if(d.content){try{current=JSON.parse(Buffer.from(d.content.replace(/\s/g,''),'base64').toString());}catch(_){}}}
    // Add or update this entry
    var idx2=current.findIndex(function(b){return b.id===entry.id||b.repoName===entry.repoName;});
    if(idx2>=0)current[idx2]=entry;else current.push(entry);
    // Write back  only safe fields
    var safe=current.map(function(b){return{
      id:b.id||b.repoName,ticker:b.ticker,chain:b.chain,mode:b.mode,
      repoName:b.repoName,ghOwner:b.ghOwner,status:b.status,builtAt:b.builtAt,
      state:b.state||{},analytics:b.analytics||{},
      d:b.d?{botToken:b.d.botToken,chain:b.d.chain,mode:b.d.mode,status:b.d.status,
        stage:b.d.stage,personality:b.d.personality,responseMode:b.d.responseMode,
        name:b.d.name,ticker:b.d.ticker,ca:b.d.ca,twitter:b.d.twitter,tg:b.d.tg,
        website:b.d.website,narrative:b.d.narrative,supply:b.d.supply,
        buyTax:b.d.buyTax,sellTax:b.d.sellTax,maxWalletPct:b.d.maxWalletPct,
        renounced:b.d.renounced,locked:b.d.locked,silenceBreaker:b.d.silenceBreaker,
        revealCmd:b.d.revealCmd,hideCmd:b.d.hideCmd
      }:{}
    };});
    // Re-obfuscate tokens
    safe.forEach(function(b){if(b.d&&b.d.botToken&&typeof b.d.botToken==='string')b.d.botToken=obfuscateToken(b.d.botToken);});
    var json=JSON.stringify(safe,null,2);
    if(json.length>200000){console.error('syncToBotsJson: too large, abort');return;}
    await githubUpdate(GH_OWNER,'bot-factory','bots.json',Buffer.from(json));
    console.log('bots.json synced:',safe.length,'bots');
  }catch(e){console.error('syncToBotsJson:',e.message);}
}

//  TELEGRAM USER CLIENT (BotFather automation) 
async function connectTgClient(){
  if(!TelegramClient||!TG_API_ID||!TG_API_HASH)return false;
  try{
    var session=new StringSession(TG_SESSION||'');
    tgClient=new TelegramClient(session,TG_API_ID,TG_API_HASH,{connectionRetries:3});
    await tgClient.connect();
    if(!await tgClient.isUserAuthorized()){
      console.log('TG client: not authorized');
      tgClient=null; return false;
    }
    console.log('TG client: connected');
    return true;
  }catch(e){console.log('TG client error:',e.message);tgClient=null;return false;}
}

async function tgSend(peer,text){
  if(!tgClient)return null;
  await tgClient.sendMessage(peer,{message:text});
  await sleep(2000);
  var msgs=await tgClient.getMessages(peer,{limit:1});
  return msgs&&msgs[0]?msgs[0].text:null;
}

async function createBotOnBotFather(botName,ticker){
  if(!tgClient)return null;
  try{
    var peer='@BotFather';
    // Start fresh
    await tgClient.sendMessage(peer,{message:'/cancel'});
    await sleep(1500);
    await tgClient.sendMessage(peer,{message:'/newbot'});
    await sleep(2500);
    // Send bot display name
    var cleanName=botName.replace(/[^a-zA-Z0-9 ]/g,'').trim().slice(0,50)||ticker.replace(/\$/g,'');
    await tgClient.sendMessage(peer,{message:cleanName});
    await sleep(2500);
    // Send username (must end in _bot)
    var base=ticker.replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
    // Try up to 5 username variants to avoid collision
    var token=null,username=null;
    for(var attempt=0;attempt<5;attempt++){
      var stamp=Date.now().toString().slice(-4)+(attempt>0?String(attempt):'');
      username=base+'_'+stamp+'_bot';
      await tgClient.sendMessage(peer,{message:username});
      await sleep(3000);
      var msgs=await tgClient.getMessages(peer,{limit:1});
      var reply=msgs&&msgs[0]?msgs[0].text:'';
      var tokenMatch=reply.match(/(\d{8,12}:[A-Za-z0-9_-]{35,})/);
      if(tokenMatch){token=tokenMatch[1];break;}
      // Username taken  try again with new timestamp
      if(reply.includes('Sorry')||reply.includes('already')||reply.includes('taken')){
        await tgClient.sendMessage(peer,{message:'/newbot'});
        await sleep(2000);
        await tgClient.sendMessage(peer,{message:cleanName});
        await sleep(2000);
        continue;
      }
      break;
    }
    if(!token){console.log('BotFather: no token after 5 attempts');return null;}
    return {token:token,username:username,name:cleanName};
  }catch(e){console.log('createBot error:',e.message);return null;}
}

// One-time login flow
async function startTgLogin(ctx,phone){
  if(!TelegramClient||!TG_API_ID){return ctx.reply('\u274C TG_API_ID or gramjs not configured.');}
  try{
    var session=new StringSession('');
    tgClient=new TelegramClient(session,TG_API_ID,TG_API_HASH,{connectionRetries:3});
    await tgClient.connect();
    var result=await tgClient.sendCode({apiId:TG_API_ID,apiHash:TG_API_HASH},phone);
    tgLoginSessions[String(ctx.from.id)]={phoneCodeHash:result.phoneCodeHash,phone:phone};
    return ctx.reply('\u2705 Code sent to '+phone+'\n\nSend /tgcode XXXXXX with the code you received.');
  }catch(e){tgClient=null;return ctx.reply('\u274C Login failed: '+e.message);}
}

async function completeTgLogin(ctx,code){
  var uid=String(ctx.from.id);
  var ls=tgLoginSessions[uid];
  if(!ls)return ctx.reply('\u274C No login in progress. Use /tglogin first.');
  try{
    var Api=require('telegram').Api;
    // gramjs v2 correct sign-in
    var result=await tgClient.invoke(new Api.auth.SignIn({
      phoneNumber:ls.phone,
      phoneCodeHash:ls.phoneCodeHash,
      phoneCode:code.trim()
    }));
    if(!result)throw new Error('Sign in returned empty result');
    var sessionStr=tgClient.session.save();
    delete tgLoginSessions[uid];
    tgReady=true;
    await ctx.reply(
      '\u2705 BotFather access granted!\n\n'+
      'Now add this to Render env vars (bot-factory service):\n\n'+
      '<b>TG_SESSION</b>\n<code>'+sessionStr+'</code>\n\n'+
      'Save + redeploy. After that, /build will auto-create bot tokens.',
      {parse_mode:'HTML'}
    );
  }catch(e){
    var msg=e.message||'';
    if(msg.includes('SESSION_PASSWORD_NEEDED')){
      return ctx.reply('\u274C 2FA is enabled on this account.\n\nDisable 2FA on Telegram settings first, then try /tglogin again.');
    }
    return ctx.reply('\u274C Login failed: '+msg+'\n\nTry /tglogin again.');
  }
}

async function signalReload(){
  if(!SUPERVISOR_URL){console.log('No SUPERVISOR_URL set');return;}
  try{
    var r=await fetch(SUPERVISOR_URL+'/reload',{
      method:'POST',headers:{'Content-Type':'application/json','x-reload-secret':RELOAD_SECRET},
      body:JSON.stringify({secret:RELOAD_SECRET})
    });
    console.log('Supervisor reload:',r.status);
  }catch(e){console.log('Reload signal failed:',e.message);}
}

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
  var TG=d.tg||'';
  var WEBSITE=d.website||'';
  var RENOUNCED=d.renounced||'NOT RENOUNCED';
  var LOCKED=d.locked||'NOT LOCKED';
  var IS_CTO=d.status==='cto';
  var STAGE=d.stage||'live';
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
  ln("var TG='"+TG+"';");
  ln("var WEBSITE='"+WEBSITE+"';");
  ln("var IS_CTO="+IS_CTO+";");
  ln("var GUARD_TYPE='"+GT+"';");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  ln("var app=express();app.use(express.json());");
  ln("var _SF='/tmp/state.json';");
  ln("var caUnlocked="+(STAGE==='live'?'true':'false')+",groupChatId=null;");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("loadState();");
  ln("var _IMG1=path.join(__dirname,'"+(d.ticker.replace(/\\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase())+".jpg');");
  ln("var _IMG2=path.join(__dirname,'siren.jpg');");
  ln("var IMG=fs.existsSync(_IMG1)?_IMG1:(fs.existsSync(_IMG2)?_IMG2:_IMG1);");
  ln("var IMG_BUF=null;try{if(fs.existsSync(IMG)){IMG_BUF=fs.readFileSync(IMG);console.log('Image loaded:',path.basename(IMG));}else{console.log('No image file found:',IMG);}}catch(e){console.log('Image error:',e.message);}");
  // IMG_BUF loaded above
  ln("var caMsg=new Map(),xMsg=new Map(),shillMsg=new Map(),strikes=new Map(),spamTracker=new Map();");
  ln("async function delPrev(map,cid){var mid=map.get(cid);if(mid){try{await bot.telegram.deleteMessage(cid,mid);}catch(_){}map.delete(cid);}}");
  // Silence breaker has its own tracker  never deleted by CA/X
  ln("var silImgId=null;");
  // Generic photo sender used by shill/x/ca with their own tracker map
  ln("async function sendWithTracker(map,cid,cap,extra){await delPrev(map,cid);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(cid,{source:IMG_BUF},Object.assign({caption:cap,parse_mode:'HTML'},extra));map.set(cid,m.message_id);return m;}catch(e){console.log('Photo send failed:',e.message);}}var m2=await bot.telegram.sendMessage(cid,cap,Object.assign({parse_mode:'HTML'},extra));map.set(cid,m2.message_id);return m2;}");
  // Keep sendImg as alias for backwards compat (used by silence breaker separately)
  ln("async function sendImg(cid,cap,extra){return sendWithTracker(shillMsg,cid,cap,extra);}");
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
  ln("bot.command('ca',async function(ctx){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});});");
  ln("bot.command('x',async function(ctx){return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('twitter',async function(ctx){return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('socials',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('info',function(ctx){return ctx.reply('<b>"+TICKER+"</b> \\u2014 "+CHAIN_LBL+"\\n\\nSupply: "+SUPPLY+"\\n"+(MAXPCT?'Max Wallet: '+MAXPCT+'\\n':'')+"Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\nContract: "+RENOUNCED+"\\nLP: "+LOCKED+"'+(TWITTER?'\\nTwitter: '+TWITTER:''),{parse_mode:'HTML',disable_web_page_preview:true});});");
    ln("var SHILL_MSGS=[");
  ln("  'Looking for a community-driven token on "+CHAIN_LBL+" with real conviction?\\n\\n"+TICKER+" is the answer!\\n\\nFully renounced. LP locked. Community owns this completely.\\n\\n'+(caUnlocked?'CA:\\n'+CA:'CA coming soon. Watch this space.'),");
  ln("  'Don\\'t sleep on "+TICKER+".\\n\\nNo dev. No rug. Just holders who believe.\\n\\nCommunity-owned. Renounced. Locked.\\n\\n'+(caUnlocked?'CA:\\n'+CA:'CA dropping soon. Stay close.'),");
  ln("  'Are you early to "+TICKER+"?\\n\\nStrong narrative. Strong community. No games.\\n\\nThis is the move.\\n\\n'+(caUnlocked?'CA:\\n'+CA:'CA incoming.'),");
  ln("];");
  ln("bot.command('shill',function(ctx){");
  ln("  var base=SHILL_MSGS[Math.floor(Math.random()*SHILL_MSGS.length)];");
  ln("  var caLine=caUnlocked?'\\n\\nCA:\\n'+CA:'\\n\\nCA dropping soon.';");
  ln("  var tgLine=TG?'\\n\\nJoin: '+TG:'';");
  ln("  return sendWithTracker(shillMsg,ctx.chat.id,base+caLine+tgLine,{});");
  ln("});");
  if(STAGE==='prelaunch'){
    ln("bot.command('"+REVEAL+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=true;saveState();return ctx.reply('CA is now REVEALED.');}var a=await isAdmin(ctx,ctx.from.id);if(!a)return;caUnlocked=true;saveState();var m=await ctx.reply('CA is now live.');autoDel(ctx.chat.id,m.message_id,10000);});");
    ln("bot.command('"+HIDE+"',async function(ctx){var t=ctx.chat&&ctx.chat.type;if(t==='private'){caUnlocked=false;saveState();return ctx.reply('CA hidden.');}var a=await isAdmin(ctx,ctx.from.id);if(!a)return;caUnlocked=false;saveState();var m=await ctx.reply('CA is now hidden.');autoDel(ctx.chat.id,m.message_id,10000);});");
  }
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
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();if(parseInt(SIL_DELAY||'0')>0){try{resetSil();}catch(_){}}try{schedShout();}catch(_){}}") ;
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
  ln("      await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("    }");
  ln("    if(lower==='x'||lower==='twitter')return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
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
  ln("    await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("  }");
  ln("  if(lower2==='x'||lower2==='twitter'||lower2.includes('follow on'))return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
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
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();if(parseInt(SIL_DELAY||'0')>0){try{resetSil();}catch(_){}}try{schedShout();}catch(_){}}") ;
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
  ln("    if(caW.some(function(w){return lower===w||lower.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("    if(lower==='x'||lower==='twitter')return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("    return;");
  ln("  }");
  ln("  if(!text)return;var lower2=text.toLowerCase();");
  ln("  if(lower2.includes('dev')||lower2.includes('cto')||lower2.includes('who run')||lower2.includes('who own')){if(IS_CTO)return ctx.reply(CTO_REPLIES[Math.floor(Math.random()*CTO_REPLIES.length)]);return ctx.reply('Dev is active and building.');}");
  ln("  var caWg=['ca','contract address','token address','where is the ca','give ca','show ca','drop ca','contract'];");
  ln("  if(caWg.some(function(w){return lower2===w||lower2.includes(w);})){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});}");
  ln("  if(lower2==='x'||lower2==='twitter')return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
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
// Track bot uptime  persisted to file
var _UPTIME_FILE='/tmp/uptime.json';
var botUptimeTracker={};
function loadUptime(){
  try{botUptimeTracker=JSON.parse(require('fs').readFileSync(_UPTIME_FILE,'utf8'));}catch(_){}
}
function saveUptime(){
  try{require('fs').writeFileSync(_UPTIME_FILE,JSON.stringify(botUptimeTracker));}catch(_){}
}
loadUptime();

async function sendDailyReport(targetChatId){
  if(!registry.length)return;
  var targets=targetChatId?[targetChatId]:Array.from(ownerChatIds);
  if(!targets.length)return;
  var now=Date.now();
  var d=new Date(now);
  var utcH=d.getUTCHours().toString().padStart(2,'0');
  var utcM=d.getUTCMinutes().toString().padStart(2,'0');
  var watH=((d.getUTCHours()+1)%24).toString().padStart(2,'0');
  var timeStr=utcH+':'+utcM+' UTC / '+watH+':'+utcM+' WAT';
  var lines=[];
  lines.push(E.chart+' <b>Bot Status Report</b>');
  lines.push('<i>'+timeStr+'</i>');
  lines.push('');
  var anyOffline=false;
  for(var i=0;i<registry.length;i++){
    var b=registry[i];
    var ok=false,ping=-1;
    var t=botUptimeTracker[b.url]||{firstSeen:now,lastOnline:null,downSince:null};
    botUptimeTracker[b.url]=t;
    if(!t.firstSeen)t.firstSeen=now;
    try{
      var t0=Date.now();
      var r=await Promise.race([
        fetch(b.url+'/health'),
        new Promise(function(_,rej){setTimeout(function(){rej(new Error('timeout'));},8000);})
      ]);
      ok=r&&r.ok;
      ping=ok?Date.now()-t0:-1;
    }catch(_){}
    if(ok){t.lastOnline=now;if(t.downSince)t.downSince=null;}
    else{if(!t.downSince)t.downSince=now;anyOffline=true;}
    var statusIcon=ok?'\u2705':'\u274C';
    var statusWord=ok?'Online':'Offline';
    // uptime
    var upStr='';
    if(ok&&t.firstSeen){
      var upMs=now-t.firstSeen;
      var upH=Math.floor(upMs/3600000);
      var upD=Math.floor(upH/24);
      if(upD>0)upStr=upD+'d '+(upH%24)+'h';
      else if(upH>0)upStr=upH+'h '+(Math.floor((upMs%3600000)/60000))+'m';
      else upStr=Math.floor(upMs/60000)+'m';
    }
    // down time
    var downStr='';
    if(!ok&&t.downSince){
      var downMs=now-t.downSince;
      var downM=Math.round(downMs/60000);
      downStr='down '+downM+'m';
    }
    var d2=b.d||{};
    var modeStr=b.mode==='guard'?'Guard':'Full AI';
    var stageStr={'live':'Live','prelaunch':'Pre-launch','noCA':'No CA yet'}[d2.stage||'live']||'Live';
    lines.push((i+1)+'. <b>'+(b.ticker||b.d&&b.d.ticker||b.d&&b.d.name||'Bot '+i)+'</b> ('+(b.chain||'bsc').toUpperCase()+')');
    lines.push('   '+statusIcon+' '+statusWord+(upStr?' \u2022 Uptime: '+upStr:'')+(downStr?' \u2022 '+downStr:'')+(ping>0?' \u2022 Response: '+ping+'ms':''));
    lines.push('   '+modeStr+' \u2022 '+(d2.status==='cto'?'CTO':'Active dev')+' \u2022 '+stageStr);
    lines.push('');
  }
  saveUptime();
  if(anyOffline){
    lines.push(E.warn+' <b>Action needed:</b>');
    lines.push('Use /rebuild to push fresh code to offline bots.');
  }else{
    lines.push(E.check+' All bots are online and running.');
  }
  var msg=lines.join('\n');
  for(var ci2=0;ci2<targets.length;ci2++){
    try{await bot.telegram.sendMessage(targets[ci2],msg,{parse_mode:'HTML',disable_web_page_preview:true});}catch(_){}
  }
  console.log('Stats sent to',targets.length,'chat(s)');
}

function scheduleDailyReport(){
  // Fire at 9am UTC and 9pm UTC (10am WAT + 10pm WAT) every day
  var slots=[9*3600000, 21*3600000]; // 9:00 UTC and 21:00 UTC
  function scheduleNext(){
    var now=new Date();
    var nowMs=now.getUTCHours()*3600000+now.getUTCMinutes()*60000+now.getUTCSeconds()*1000;
    var next=slots.find(function(t){return t>nowMs;});
    var wait=next!==undefined?next-nowMs:(86400000-nowMs+slots[0]);
    console.log('Next report in',Math.round(wait/3600000*10)/10,'hr(s) at',(next!==undefined?(next/3600000)+'00':slots[0]/3600000+'00')+'UTC');
    setTimeout(function(){
      sendDailyReport();
      scheduleNext();
    },wait);
  }
  scheduleNext();
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
  var TG=d.tg||'';
  var WEBSITE=d.website||'';
  var RENOUNCED=d.renounced||'NOT RENOUNCED';
  var LOCKED=d.locked||'NOT LOCKED';
  var IS_CTO=d.status==='cto';
  var STAGE=d.stage||'live';
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
  ln("var _groqPool=[];");
  ln("if(process.env.GROQ_API_KEY)_groqPool.push(process.env.GROQ_API_KEY.trim());");
  ln("for(var _gi=1;_gi<=10;_gi++){var _gk=process.env['GROQ_KEY_'+_gi];if(_gk&&_groqPool.indexOf(_gk.trim())===-1)_groqPool.push(_gk.trim());}"); 
  ln("var _groqIdx=0;");
  ln("function nextGroqKey(){if(!_groqPool.length)return'';var k=_groqPool[_groqIdx%_groqPool.length];_groqIdx++;return k;}");

  ln("var WEBHOOK_URL=(process.env.WEBHOOK_URL||'').trim();");
  ln("var PORT=process.env.PORT||3000;");
  ln("var TICKER='"+TICKER+"';");
  ln("var CA='"+CA+"';");
  ln("var TWITTER='"+TWITTER+"';");
  ln("var TG='"+TG+"';");
  ln("var WEBSITE='"+WEBSITE+"';");
  ln("var IS_CTO="+IS_CTO+";");
  ln("var RESPONSE_MODE='"+RMODE+"';");
  ln("var bot=new Telegraf(BOT_TOKEN);");
  // groq client created per request in ask()
  ln("var app=express();app.use(express.json());");
  ln("var _SF='/tmp/state.json';");
  ln("var caUnlocked="+(STAGE==='live'?'true':'false')+",groupChatId=null,silTimer=null;");
  ln("var SIL_DELAY=" + (d.silenceBreaker||"3600000") + ";");
  ln("function loadState(){try{var s=JSON.parse(fs.readFileSync(_SF,'utf8'));caUnlocked=!!s.u;groupChatId=s.g||null;}catch(_){}}");
  ln("function saveState(){try{fs.writeFileSync(_SF,JSON.stringify({u:caUnlocked,g:groupChatId}));}catch(_){}}");
  ln("loadState();");
  ln("var _IMG1=path.join(__dirname,'"+(d.ticker.replace(/\\$/g,'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase())+".jpg');");
  ln("var _IMG2=path.join(__dirname,'siren.jpg');");
  ln("var IMG=fs.existsSync(_IMG1)?_IMG1:(fs.existsSync(_IMG2)?_IMG2:_IMG1);");
  ln("var IMG_BUF=null;try{if(fs.existsSync(IMG)){IMG_BUF=fs.readFileSync(IMG);console.log('Image loaded:',path.basename(IMG));}else{console.log('No image file found:',IMG);}}catch(e){console.log('Image error:',e.message);}");
  // IMG_BUF loaded above
  ln("var caMsg=new Map(),xMsg=new Map(),shillMsg=new Map();");
  ln("var silImgId=null,strikes=new Map(),spamTracker=new Map(),lastReplies=[];");
  ln("var SHOUTOUT_ON=true,shoutTimer=null;");
  ln("async function delPrev(map,cid){var mid=map.get(cid);if(mid){try{await bot.telegram.deleteMessage(cid,mid);}catch(_){}map.delete(cid);}}");
  ln("async function sendWithTracker(map,cid,cap,extra){await delPrev(map,cid);extra=extra||{};if(IMG_BUF){try{var m=await bot.telegram.sendPhoto(cid,{source:IMG_BUF},Object.assign({caption:cap,parse_mode:'HTML'},extra));map.set(cid,m.message_id);return m;}catch(e){console.log('Photo send failed:',e.message);}}var m2=await bot.telegram.sendMessage(cid,cap,Object.assign({parse_mode:'HTML'},extra));map.set(cid,m2.message_id);return m2;}");
  ln("async function sendImg(cid,cap,extra){return sendWithTracker(shillMsg,cid,cap,extra);}");
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

  ln("async function ask(msg){");
  ln("  if(!_groqPool.length)throw new Error('No AI key configured. Add one with /addgroq in factory.');");  
  ln("  var lastErr,attempts=_groqPool.length;");
  ln("  for(var _ai=0;_ai<attempts;_ai++){");
  ln("    try{");
  ln("      var _gc=new Groq({apiKey:nextGroqKey()});");
  ln("      var r=await _gc.chat.completions.create({model:'llama-3.3-70b-versatile',temperature:1.0,max_tokens:160,messages:[{role:'system',content:sysPrompt()},{role:'user',content:msg}]});");
  ln("      return r.choices[0].message.content.trim();");
  ln("    }catch(e){lastErr=e;console.log('Groq attempt '+(_ai+1)+' failed:',e.message);}");
  ln("  }");
  ln("  throw lastErr||new Error('All Groq keys failed');");
  ln("}");

  ln("async function smartAsk(msg){var r=await ask(msg);if(lastReplies.includes(r))r=await ask(msg+' Give a completely different response.');lastReplies.push(r);if(lastReplies.length>12)lastReplies.shift();return r;}");

  // Silence breaker
  ln("var SIL_ANG=['2-3 lines. Why hold "+TICKER+" right now.','2-3 lines. "+TICKER+" fundamentals: renounced, LP locked.','2-3 lines. Being early to "+TICKER+".','2-3 lines. "+TICKER+" community is building.','2-3 lines. The move in "+TICKER+" is still early.'];");
  ln("var silIdx=0;");
  ln("async function fireSilence(){if(!groupChatId)return resetSil();");
  ln("  try{");
  ln("    // Delete previous silence breaker first");
  ln("    // Previous silence breaker stays  new one adds below it naturally");
  ln("    var p=SIL_ANG[silIdx%SIL_ANG.length];silIdx++;");
  ln("    var cap=await smartAsk(p);");
  ln("    if(cap&&cap!=='IGNORE'){");
  ln("      // Send with image, store ID separately from CA tracker");
  ln("      var silM;");
  ln("      if(IMG_BUF){try{silM=await bot.telegram.sendPhoto(groupChatId,{source:IMG_BUF},{caption:cap,parse_mode:'HTML'});}catch(_){}}");
  ln("      if(!silM)silM=await bot.telegram.sendMessage(groupChatId,cap,{parse_mode:'HTML'});");
  ln("      silImgId=silM.message_id;");
  ln("      // Pin and notify all");
  
  ln("    }");
  ln("  }catch(e){console.log('Silence breaker error:',e.message);}");
  ln("  resetSil();");
  ln("}");
  ln("function resetSil(){if(silTimer)clearTimeout(silTimer);if(SIL_DELAY===0||SIL_DELAY==='0')return;silTimer=setTimeout(fireSilence,parseInt(SIL_DELAY));}");

  // Shoutout
  ln("async function doShoutout(){");
  ln("  if(!groupChatId||!SHOUTOUT_ON){schedShout();return;}");
  ln("  try{");
  ln("    var admins=await bot.telegram.getChatAdministrators(groupChatId);");
  ln("    var humans=admins.filter(function(a){return!a.user.is_bot;});");
  ln("    var names=humans.map(function(a){return a.user.username?'@'+a.user.username:a.user.first_name;});");
  ln("    if(!names.length){schedShout();return;}");
  ln("    var ppt='Write 1-2 warm genuine lines appreciating these "+TICKER+" admins for keeping the community alive: '+names.join(', ')+'. Be specific, sound human, tag them by name.';");
  ln("    var msg=await smartAsk(ppt);");
  ln("    if(msg&&msg!=='IGNORE'&&msg.length>5){");
  ln("      var sm=await bot.telegram.sendMessage(groupChatId,msg);");
  ln("      setTimeout(function(){try{bot.telegram.deleteMessage(groupChatId,sm.message_id);}catch(_){}},7200000);");
  ln("      console.log('Shoutout sent to '+groupChatId);");
  ln("    }");
  ln("  }catch(e){console.log('Shoutout error:',e.message);}");
  ln("  schedShout();");
  ln("}");

  ln("function schedShout(){");
  ln("  if(shoutTimer)clearTimeout(shoutTimer);");
  ln("  if(!SHOUTOUT_ON||!groupChatId)return;");
  ln("  // Fire at 6am, 12pm, 5pm, 9pm WAT (5,11,16,20 UTC) + random offset");
  ln("  var slots=[18000000,39600000,57600000,72000000];");
  ln("  var now=Date.now()%86400000;");
  ln("  var next=slots.find(function(t){return t>now;});");
  ln("  var wait=next!==undefined?next-now:(86400000-now+slots[0]);");
  ln("  wait+=Math.floor(Math.random()*3600000);");
  ln("  shoutTimer=setTimeout(doShoutout,wait);");
  ln("  console.log('Next shoutout in',Math.round(wait/60000),'min');");
  ln("}");

  ln("bot.command('shoutout',async function(ctx){var admin=await isAdmin(ctx,ctx.from.id);if(!admin)return;var arg=(ctx.message.text||'').split(' ')[1]||'';if(arg==='on'){SHOUTOUT_ON=true;schedShout();return ctx.reply('\\u2705 Admin shoutouts enabled. Fires 2-4x daily.');}if(arg==='off'){SHOUTOUT_ON=false;if(shoutTimer)clearTimeout(shoutTimer);return ctx.reply('\\u274C Admin shoutouts disabled.');}if(arg==='now'){await doShoutout();return;}return ctx.reply('Usage: /shoutout on / off / now');});");

  // Commands  CA and X hardcoded
  ln("bot.command('ca',async function(ctx){if(!caUnlocked)return ctx.reply(NOT_LIVE[Math.floor(Math.random()*NOT_LIVE.length)]);await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});});");
  ln("bot.command('x',async function(ctx){return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('twitter',async function(ctx){return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});});");
  ln("bot.command('socials',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('links',function(ctx){return ctx.reply('<a href=\\'"+CHART+"\\'>Chart</a> | <a href=\\'"+BUY_URL+"\\'>"+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':'')+(WEBSITE?' | <a href=\\''+WEBSITE+'\\'>Website</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});});");
  ln("bot.command('info',function(ctx){return ctx.reply('<b>"+TICKER+"</b> \\u2014 "+CHAIN_LBL+"\\n\\nSupply: "+SUPPLY+"\\n"+(MAXPCT?'Max Wallet: '+MAXPCT+'\\n':'')+"Tax: "+BUYTAX+"% buy / "+SELLTAX+"% sell\\nContract: "+RENOUNCED+"\\nLP: "+LOCKED+"'+(TWITTER?'\\nTwitter: '+TWITTER:''),{parse_mode:'HTML',disable_web_page_preview:true});});");
    ln("bot.command('shill',async function(ctx){");
  ln("  var shillMsgs=[");
  ln("    'Have you heard about "+TICKER+"?\\n\\n"+TICKER+" \\u2014 community-owned on BSC.\\nRenounced. LP "+LOCKED+". No dev games.\\nThis is the quiet move. Load up.',");
  ln("    'Looking for a BSC token built by real people?\\n\\n"+TICKER+" \\u2014 fully community-owned.\\nRenounced contract. LP "+LOCKED+". Real narrative.\\nGet in early \\u261d',");
  ln("    'The move others will regret missing.\\n\\n"+TICKER+" on BSC \\u2014 community takeover.\\nRenounced. LP "+LOCKED+". No rug possible.\\nLoad up before it runs.',");
  ln("    'What if the next gem was right here?\\n\\n"+TICKER+" \\u2014 zero dev, 100% community.\\nRenounced. LP "+LOCKED+". Low cap. Real conviction.',");
  ln("    'Don\\u2019t sleep on "+TICKER+".\\nCommunity took over. Dev is gone. LP "+LOCKED+".\\nThis is what conviction looks like. Load up.',");
  ln("  ];");
  ln("  var base=shillMsgs[Math.floor(Math.random()*shillMsgs.length)];");
  ln("  var caLine=caUnlocked?'\\n\\nCA:\\n'+CA:'\\n\\nCA dropping soon.';");
  ln("  var tgLine=TG?'\\n\\nJoin: '+TG:'';");
  ln("  try{");
  ln("    var aiShill=await smartAsk('Rewrite this shill naturally in 3-4 lines, keep the facts, sound like a real person not a bot: '+base);");
  ln("    if(aiShill&&aiShill!=='IGNORE'&&aiShill.length>10&&aiShill.split('\\n').length<=6)base=aiShill;");
  ln("  }catch(_){}"); 
  ln("  await sendWithTracker(shillMsg,ctx.chat.id,base+caLine+tgLine,{});");
  ln("});");


  //  Message Handler 
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
  ln("  if(!isPrivate&&groupChatId!==ctx.chat.id){groupChatId=ctx.chat.id;saveState();if(parseInt(SIL_DELAY||'0')>0){try{resetSil();}catch(_){}}try{schedShout();}catch(_){}}") ;
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
  ln("      await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("    }");
  ln("    if(lower==='x'||lower==='twitter')return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
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
  ln("    await sendWithTracker(caMsg,ctx.chat.id,'"+TICKER+" Contract Address',{});return ctx.reply('<code>'+CA+'</code>',{parse_mode:'HTML'});");
  ln("  }");
  ln("  if(lower2==='x'||lower2==='twitter'||lower2.includes('follow on'))return sendWithTracker(xMsg,ctx.chat.id,'Follow "+TICKER+" on X',{reply_markup:{inline_keyboard:[[{text:'Follow on X',url:TWITTER}]]}});");
  ln("  if(lower2==='socials'||lower2==='links')return ctx.reply('<a href=\\'"+CHART+"\\'> Chart</a> | <a href=\\'"+BUY_URL+"\\'> "+DEX+"</a>'+(TWITTER?' | <a href=\\''+TWITTER+'\\'>Twitter</a>':''),{parse_mode:'HTML',disable_web_page_preview:true});");
  ln("  if(isPrivate){try{var gr=await smartAsk(chatHistory.join('\\n'));if(gr&&gr!=='IGNORE')return ctx.reply(gr);}catch(_){}return;}");
  ln("  if(RESPONSE_MODE==='focused'){if(text.indexOf('?')===-1)return;try{var gr2=await smartAsk(chatHistory.join('\\n'));if(gr2&&gr2!=='IGNORE')return ctx.reply(gr2);}catch(_){}return;}");
  ln("  var tkLow=TICKER.toLowerCase().replace('$','');");
  ln("  if(text.indexOf('?')!==-1||lower2.includes(tkLow)){try{var gr3=await smartAsk(chatHistory.join('\\n'));if(gr3&&gr3!=='IGNORE')return ctx.reply(gr3);}catch(_){}}");
  ln("});");
;


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
  if(GH_OWNER){console.log('GH_OWNER from env:',GH_OWNER);return;}
  try{
    // Try org memberships first
    var r=await fetch('https://api.github.com/user/orgs',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
    var orgs=await r.json();
    if(Array.isArray(orgs)&&orgs.length){
      GH_OWNER=orgs[0].login;
      console.log('GH_OWNER from org:',GH_OWNER);
      return;
    }
    // Fallback to user login
    var r2=await fetch('https://api.github.com/user',{headers:{'Authorization':'token '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}});
    var d=await r2.json();
    GH_OWNER=d.login||'';
    console.log('GH_OWNER from user:',GH_OWNER);
  }catch(e){console.log('GH:',e.message);}
}
process.on('uncaughtException',function(e){console.error('Factory:',e.message);});
process.on('unhandledRejection',function(e){console.error('Factory rej:',e&&e.message);});

app.listen(PORT,async function(){
  console.log('Bot Factory starting on port',PORT);
  try{await sleep(2000);}catch(_){}
  try{await getGhOwner();}catch(e){console.log('GH:',e.message);}
  try{await loadRegistry();}catch(e){console.log('Reg:',e.message);}
  // Connect TG user client for BotFather automation
  if(TG_API_ID&&TG_API_HASH&&TG_SESSION){
    connectTgClient().then(function(ok){
      if(ok)console.log('TG client ready for BotFather automation');
      else console.log('TG client: session invalid, use /tglogin');
    });
  }
  // Connect TG client for BotFather automation
  if(TG_API_ID&&TG_API_HASH&&TG_SESSION){
    connectTgClient().then(function(ok){
      if(ok)console.log('BotFather automation: READY');
      else console.log('BotFather automation: not connected (use /tglogin)');
    }).catch(function(){});
  }
  try{await regWebhook();}catch(e){console.log('Hook:',e.message);}
  try{
    await bot.command('setsupervisor',async function(ctx){
  var args=ctx.message.text.split(/\s+/);
  if(args.length<3)return ctx.reply('Usage: /setsupervisor [url] [reload_secret]');
  SUPERVISOR_URL=args[1].replace(/\/+$/,'');
  RELOAD_SECRET=args[2];
  try{
    var r=await fetch(SUPERVISOR_URL+'/health');
    var d=await r.json();
    return ctx.reply(E.check+' Supervisor connected!\n\nBots running: '+d.bots+'\nUptime: '+Math.floor((d.uptime||0)/60)+'m',{parse_mode:'HTML'});
  }catch(e){
    return ctx.reply(E.warn+' Supervisor URL saved but could not ping it: '+e.message+'\n\nCheck the URL is correct and supervisor is running.');
  }
});

bot.telegram.setMyCommands([
      {command:'build',    description:'Build a new community bot'},
      {command:'bots',     description:'List all your bots'},
      {command:'edit',     description:'Edit bot details'},
      {command:'rebuild',  description:'Redeploy a bot with latest code'},
      {command:'stats',    description:'Live status report for all bots'},
      {command:'cleanup',  description:'Delete unused services and repos'},
      {command:'addgroq',  description:'Add AI key (auto-pushes to all bots)'},
      {command:'cancel',      description:'Cancel current operation'},
      {command:'refresh',   description:'Reload bot registry from GitHub'},
      {command:'tglogin',   description:'Connect Telegram account for auto bot creation'},
      {command:'tgcode',    description:'Enter verification code after /tglogin'},
      {command:'tgstatus',  description:'Check Telegram client connection status'},
      {command:'tglogin',     description:'Connect Telegram account for auto bot creation'},
      {command:'tgcode',      description:'Complete Telegram login with code'},
      {command:'tgstatus',    description:'Check Telegram client status'},
      {command:'setsupervisor',description:'Connect to bot supervisor'},
    ]);
  }catch(e){console.log('Commands:',e.message);}
  setInterval(function(){if(WEBHOOK_URL)try{fetch(WEBHOOK_URL+'/health').catch(function(){});}catch(_){}},4*60*1000);
  try{scheduleDailyReport();}catch(e){console.log('Daily report:',e.message);}
  try{loadUptime();}catch(_){}
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
