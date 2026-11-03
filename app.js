"use strict";
/* ============================================================================
   Icon Pools Team app - Version 1
   Sign in by name + 6 digit PIN, stay signed in on the device, and an Admin
   tab for Owners and Administrators to manage employees and PINs.
   All data goes through the locked-down database functions in setup.sql.
   ========================================================================== */

const CFG = window.APP_CONFIG || {};
const TOKEN_KEY = "ipt.token", ME_KEY = "ipt.me";
const ALL_ROLES = ["Owner","Administrator","Office Staff","Service Lead",
                   "Service Tech","Construction Crew","Retail Associate"];
const PIN_LEN = 6;

const App = {
  token:null, me:null, screen:"boot", tab:"home", subs:{},
  names:null, needsSetup:false, picked:null,
  pin:"", pinMode:"login", firstPin:"", busy:false, lockEnd:0, lockTimer:null,
  staff:null, installEvt:null
};

/* ---------- small helpers ---------- */
const $ = id => document.getElementById(id);
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function initials(n){
  return String(n||"").split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join("").toUpperCase();
}
function firstName(n){ return String(n||"").split(/\s+/)[0]; }
function save(k,v){ try{ v==null ? localStorage.removeItem(k) : localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
function load(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } }
let toastTimer=null;
function toast(msg){
  const t=$("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove("show"),2800);
}
function isAdmin(e){ return !!e && (e.roles||[]).some(r=>r==="Owner"||r==="Administrator"); }
function isOwner(e){ return !!e && (e.roles||[]).indexOf("Owner")>=0; }
function deviceName(){
  const ua=navigator.userAgent;
  return /iPhone/.test(ua)?"iPhone":/iPad/.test(ua)?"iPad":/Android/.test(ua)?"Android":
         /Windows/.test(ua)?"Windows":/Mac/.test(ua)?"Mac":"Other";
}
function setView(html){ $("view").innerHTML=html; window.scrollTo(0,0); }

/* ---------- talking to Supabase ---------- */
class ApiError extends Error{ constructor(msg,code){ super(msg); this.code=code; } }
function configured(){
  return /^https:\/\//.test(CFG.supabaseUrl||"") && !!CFG.supabaseKey && !/PASTE/.test(CFG.supabaseKey);
}
async function rpc(fn,args){
  const headers={"Content-Type":"application/json","apikey":CFG.supabaseKey};
  // older "anon" keys are JWTs and also go in Authorization; new publishable keys don't
  if(/^eyJ/.test(CFG.supabaseKey)) headers.Authorization="Bearer "+CFG.supabaseKey;
  let res;
  try{
    res=await fetch(CFG.supabaseUrl.replace(/\/+$/,"")+"/rest/v1/rpc/"+fn,
      {method:"POST", headers, body:JSON.stringify(args||{})});
  }catch(e){
    setOffline(true);
    throw new ApiError("Can't reach the server. Check your connection and try again.","offline");
  }
  setOffline(false);
  const text=await res.text();
  let data=null; try{ data=text?JSON.parse(text):null; }catch(e){}
  if(!res.ok){
    const msg=(data && data.message) || ("Server error ("+res.status+")");
    if(msg==="SESSION_EXPIRED"){
      signedOut("You were signed out. Please sign in again.");
      throw new ApiError("You were signed out.","expired");
    }
    throw new ApiError(msg,"server");
  }
  return data;
}
function setOffline(off){ $("offline").hidden=!off; }
window.addEventListener("online",()=>setOffline(false));
window.addEventListener("offline",()=>setOffline(true));

/* ============================================================================
   SIGN IN
   ========================================================================== */
function chrome(signedIn){
  $("tabs").hidden=!signedIn;
  $("who").innerHTML = signedIn
    ? esc(App.me.name)+' <button class="btn ghost sm" id="hdrOut">Log out</button>' : "";
  if(signedIn) $("hdrOut").onclick=logOut;
}

function showNotConfigured(){
  App.screen="setup"; chrome(false);
  setView('<h2>Almost there</h2><div class="notice warn">This app isn\'t connected to the '+
    'database yet. Open <b>config.js</b> and paste in your Supabase Project URL and '+
    'publishable key, then upload the website again.</div>');
}

async function showNames(msg){
  App.screen="names"; App.picked=null; chrome(false); stopLockTimer();
  setView('<span class="spin" aria-label="Loading"></span>');
  let data;
  try{ data=await rpc("login_list"); }
  catch(e){
    setView('<div class="notice err">'+esc(e.message)+'</div>'+
      '<button class="btn primary" id="retry">Try again</button>');
    $("retry").onclick=()=>showNames(msg);
    return;
  }
  if(App.screen!=="names") return;
  App.names=data.employees||[]; App.needsSetup=!!data.needs_setup;
  let h='';
  if(msg) h+='<div class="notice">'+esc(msg)+'</div>';
  if(App.needsSetup) h+='<div class="notice warn"><b>First-time setup.</b> Owners, tap your '+
    'name to create your PIN. After that, PINs are set from the Admin tab.</div>';
  h+='<h2>Who\'s signing in?</h2><p class="sub">Tap your name.</p><ul class="names">';
  App.names.forEach((e,i)=>{
    h+='<li><button data-i="'+i+'"><span class="avatar">'+esc(initials(e.name))+'</span>'+
       '<span><span class="nm">'+esc(e.name)+'</span>'+
       (e.title?'<span class="tt">'+esc(e.title)+'</span>':'')+'</span>'+
       '<span class="chev" aria-hidden="true">&rsaquo;</span></button></li>';
  });
  h+='</ul>';
  if(!App.names.length) h+='<p class="muted">No employees yet.</p>';
  setView(h);
  $("view").querySelectorAll(".names button").forEach(b=>{
    b.onclick=()=>pickName(App.names[+b.dataset.i]);
  });
}

function pickName(emp){
  App.picked=emp;
  if(emp.has_pin) return showPin("login");
  if(emp.can_setup) return showPin("setup1");
  App.screen="nopin";
  setView('<button class="btn ghost sm" id="back">&lsaquo; Back</button>'+
    '<div class="pinwrap"><div class="avatar">'+esc(initials(emp.name))+'</div>'+
    '<h2>'+esc(emp.name)+'</h2><div class="notice warn" style="text-align:left;margin-top:16px">'+
    'You don\'t have a PIN yet. Ask an Owner or Administrator to set one for you.</div></div>');
  $("back").onclick=()=>showNames();
}

function showPin(mode,msg,isErr){
  App.screen="pin"; App.pinMode=mode; App.pin=""; App.busy=false;
  const emp=App.picked;
  const sub = mode==="login" ? "Enter your 6-digit PIN"
            : mode==="setup1" ? "First-time setup: create your 6-digit Owner PIN"
            : "Enter the same PIN again to confirm";
  let pad='';
  ["1","2","3","4","5","6","7","8","9"].forEach(k=>{ pad+='<button data-k="'+k+'">'+k+'</button>'; });
  pad+='<button class="txt" data-k="clear">Clear</button><button data-k="0">0</button>'+
       '<button class="txt" data-k="del" aria-label="Delete last digit">&#9003;</button>';
  setView('<button class="btn ghost sm" id="back">&lsaquo; Back</button>'+
    '<div class="pinwrap"><div class="avatar">'+esc(initials(emp.name))+'</div>'+
    '<h2>'+esc(emp.name)+'</h2><p class="sub">'+sub+'</p>'+
    '<div class="dots" id="dots" aria-hidden="true">'+'<i></i>'.repeat(PIN_LEN)+'</div>'+
    '<div class="pinmsg" id="pinmsg" role="alert"></div>'+
    '<div class="pad" id="pad">'+pad+'</div></div>');
  $("back").onclick=()=>showNames();
  $("pad").querySelectorAll("button").forEach(b=>{ b.onclick=()=>pinKey(b.dataset.k); });
  if(msg) pinMsg(msg,isErr);
  if(mode==="login" && App.lockEnd>Date.now() && App.lockFor===emp.id) startLock(0);
}
function pinMsg(text,isErr){ const m=$("pinmsg"); if(!m) return; m.textContent=text||""; m.className="pinmsg"+(isErr?" err":""); }
function drawDots(){
  const d=$("dots"); if(!d) return;
  d.querySelectorAll("i").forEach((i,n)=>i.classList.toggle("on",n<App.pin.length));
}
function shake(){ const d=$("dots"); if(!d) return; d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake"); }
function padEnabled(on){ const p=$("pad"); if(p) p.querySelectorAll("button").forEach(b=>b.disabled=!on); }

function pinKey(k){
  if(App.screen!=="pin" || App.busy || App.lockEnd>Date.now()) return;
  if(k==="del") App.pin=App.pin.slice(0,-1);
  else if(k==="clear") App.pin="";
  else if(/^[0-9]$/.test(k) && App.pin.length<PIN_LEN){ App.pin+=k; if(App.pin.length===1) pinMsg(""); }
  drawDots();
  if(App.pin.length===PIN_LEN) submitPin();
}
document.addEventListener("keydown",e=>{
  if(App.screen!=="pin" || e.metaKey || e.ctrlKey || e.altKey) return;
  if(/^[0-9]$/.test(e.key)) pinKey(e.key);
  else if(e.key==="Backspace") pinKey("del");
  else if(e.key==="Escape") showNames();
});

async function submitPin(){
  const emp=App.picked, pin=App.pin, mode=App.pinMode;
  if(mode==="setup1"){
    App.firstPin=pin;
    return showPin("setup2");
  }
  if(mode==="setup2" && pin!==App.firstPin){
    App.firstPin="";
    return showPin("setup1","Those didn't match. Let's start over.",true);
  }
  App.busy=true; padEnabled(false); pinMsg("Checking…");
  let r;
  try{
    r = mode==="login"
      ? await rpc("login",{p_employee_id:emp.id, p_pin:pin, p_device:deviceName()})
      : await rpc("setup_owner_pin",{p_employee_id:emp.id, p_pin:pin, p_device:deviceName()});
  }catch(e){
    App.busy=false; App.pin=""; drawDots(); padEnabled(true); pinMsg(e.message,true);
    return;
  }
  App.busy=false;
  if(r.ok){
    App.firstPin="";
    App.token=r.token; App.me=r.employee;
    save(TOKEN_KEY,App.token); save(ME_KEY,App.me);
    App.tab="home"; showApp();
    toast(mode==="login" ? "Welcome, "+firstName(App.me.name)+"!" : "Your PIN is set. Welcome!");
    return;
  }
  App.pin=""; drawDots(); shake(); padEnabled(true);
  if(r.error==="wrong_pin"){
    pinMsg("Wrong PIN. "+r.attempts_left+(r.attempts_left===1?" try":" tries")+" left.",true);
  }else if(r.error==="locked"){
    App.lockFor=emp.id; App.lockEnd=Date.now()+(+r.seconds||300)*1000; startLock();
  }else if(r.error==="no_pin"){
    pinMsg("You don't have a PIN yet. Ask an Owner or Administrator.",true); padEnabled(false);
  }else if(r.error==="already_setup"){
    showNames("Setup is already done. Ask an Owner to set your PIN from the Admin tab.");
  }else{
    showNames("Something changed. Please pick your name again.");
  }
}

function startLock(){
  stopLockTimer(); padEnabled(false);
  const tick=()=>{
    const left=Math.ceil((App.lockEnd-Date.now())/1000);
    if(left<=0 || App.screen!=="pin"){
      stopLockTimer();
      if(App.screen==="pin"){ padEnabled(true); pinMsg("You can try again now."); }
      return;
    }
    pinMsg("Too many wrong tries. Try again in "+Math.floor(left/60)+":"+String(left%60).padStart(2,"0")+".",true);
  };
  tick(); App.lockTimer=setInterval(tick,1000);
}
function stopLockTimer(){ if(App.lockTimer){ clearInterval(App.lockTimer); App.lockTimer=null; } }

/* ---------- signing out ---------- */
async function logOut(){
  if(!confirm("Log out on this device? You'll need your PIN to sign back in.")) return;
  const tok=App.token;
  signedOut("You're logged out.");
  try{ await rpc("logout",{p_token:tok}); }catch(e){}
}
function signedOut(msg){
  App.token=null; App.me=null; App.staff=null;
  save(TOKEN_KEY,null); save(ME_KEY,null);
  closeSheet(); dropBoard(); $("view").hidden=false; showNames(msg);
}

/* ============================================================================
   SIGNED IN
   ========================================================================== */
const TABS=[["home","Home"],["construction","Construction"],["service","Service"],
            ["retail","Retail"],["hottubs","Hot Tubs"]];
function showApp(){
  App.screen="app"; chrome(true);
  const tabs=TABS.slice();
  if(isAdmin(App.me)) tabs.push(["admin","Admin"]);
  if(!tabs.some(t=>t[0]===App.tab)) App.tab="home";
  $("tabs").innerHTML=tabs.map(t=>'<button role="tab" data-t="'+t[0]+'" aria-selected="'+
    (App.tab===t[0])+'">'+t[1]+'</button>').join("");
  $("tabs").querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{ App.tab=b.dataset.t; showApp(); };
  });
  const inDept=DEPTS.indexOf(App.tab)>=0;
  drawSubtabs(inDept);
  const onBoard=App.tab==="construction" && sub()==="schedule";
  showBoard(onBoard);
  $("view").hidden=onBoard;
  const sel=$("tabs").querySelector('[aria-selected="true"]');
  if(sel) sel.scrollIntoView({block:"nearest",inline:"nearest"});
  if(onBoard) return;
  if(inDept) viewDept();
  else if(App.tab==="admin") viewAdmin(); else viewHome();
}

/* ---------- Departments: a row of tabs, opening on that department's announcements ----------
   Construction's other tabs (and conTabs, viewConstruction) live in construction.js */
const DEPTS=["construction","service","retail","hottubs"];
function deptTabs(){
  return [["ann","Announcements"]].concat(App.tab==="construction"?conTabs():[]);
}
function sub(){ return App.subs[App.tab]||"ann"; }
function drawSubtabs(on){
  const nav=$("subtabs");
  nav.hidden=!on;
  if(!on){ nav.innerHTML=""; return; }
  const tabs=deptTabs();
  if(!tabs.some(t=>t[0]===sub())) App.subs[App.tab]="ann";
  nav.innerHTML=tabs.map(t=>'<button role="tab" data-c="'+t[0]+'" aria-selected="'+
    (sub()===t[0])+'">'+t[1]+'</button>').join("");
  nav.querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{ App.subs[App.tab]=b.dataset.c; showApp(); };
  });
}
function viewDept(){
  if(sub()==="ann"){ setView('<div id="annHost"></div>'); annBlock($("annHost"),App.tab); return; }
  viewConstruction();
}


/* ---------- Construction tab: the Production Board ----------
   board.html runs inside the tab. It's created once and only hidden when you
   switch tabs, so unapproved schedule changes survive a trip to another tab. */
function showBoard(on){
  let host=$("boardHost");
  if(on && !host){
    host=document.createElement("div"); host.id="boardHost";
    host.innerHTML='<iframe src="board.html" title="Production Board"></iframe>';
    document.body.insertBefore(host,$("toast"));
  }
  if(host) host.hidden=!on;
  sizeBoard();
}
function sizeBoard(){
  const host=$("boardHost"); if(!host || host.hidden) return;
  const top=document.querySelector(".topbar").getBoundingClientRect().bottom;
  host.firstChild.style.height=Math.max(300,window.innerHeight-top)+"px";
}
window.addEventListener("resize",sizeBoard);
function dropBoard(){ const host=$("boardHost"); if(host) host.remove(); }

function isInstalled(){
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone===true;
}
function installCard(){
  if(isInstalled()) return "";
  const ios=/iPhone|iPad|iPod/.test(navigator.userAgent);
  let body;
  if(App.installEvt) body='<p class="muted small" style="margin:0 0 10px">Add this app to your '+
    'home screen so it opens like a regular app.</p><button class="btn primary" id="installBtn">Install app</button>';
  else if(ios) body='<p class="muted small" style="margin:0">In Safari, tap the <b>Share</b> button '+
    '(the square with an arrow), then <b>Add to Home Screen</b>.</p>';
  else body='<p class="muted small" style="margin:0">Open your browser menu (&#8942;) and tap '+
    '<b>Install app</b> or <b>Add to Home screen</b>.</p>';
  return '<div class="card"><h3>Put this app on your home screen</h3>'+body+'</div>';
}

// Home: the general announcements, and nothing else (plus how to install, until it is)
function viewHome(){
  setView('<h2>Announcements</h2><div id="annHost"></div>'+installCard());
  annBlock($("annHost"),"general");
  const ib=$("installBtn");
  if(ib) ib.onclick=async()=>{
    const ev=App.installEvt; if(!ev) return;
    App.installEvt=null; ev.prompt();
    try{ await ev.userChoice; }catch(e){}
    if(App.screen==="app" && App.tab==="home") viewHome();
  };
}
window.addEventListener("beforeinstallprompt",e=>{
  e.preventDefault(); App.installEvt=e;
  if(App.screen==="app" && App.tab==="home") viewHome();
});
window.addEventListener("appinstalled",()=>{
  App.installEvt=null; toast("Installed! Look for Icon Pools on your home screen.");
});

/* ---------- Admin tab ---------- */
async function viewAdmin(){
  setView('<div class="row" style="margin-bottom:4px"><h2 style="flex:1;margin:0">Employees</h2>'+
    '<button class="btn primary sm" id="addEmp">+ Add employee</button></div>'+
    '<p class="sub">Tap someone to edit them, set or reset their PIN, or remove them.</p>'+
    '<div id="staff"><span class="spin" aria-label="Loading"></span></div>');
  $("addEmp").onclick=()=>openEditor(null);
  try{ App.staff=await rpc("admin_list",{p_token:App.token}); }
  catch(e){
    if(e.code==="expired") return;
    if($("staff")) $("staff").innerHTML='<div class="notice err">'+esc(e.message)+'</div>';
    return;
  }
  drawStaff();
}
function drawStaff(){
  const host=$("staff"); if(!host || App.tab!=="admin") return;
  let h='<ul class="emps">';
  App.staff.forEach((e,i)=>{
    const st = e.locked ? '<span class="pill bad">Locked</span>'
             : e.has_pin ? '<span class="pill ok">PIN set</span>'
             : '<span class="pill warn">No PIN</span>';
    h+='<li><button data-i="'+i+'"><div class="top"><span class="nm">'+esc(e.name)+'</span>'+
       (e.title?'<span class="tt">'+esc(e.title)+'</span>':'')+st+'</div>'+
       '<div class="roles">'+e.roles.map(r=>'<span class="pill role">'+esc(r)+'</span>').join("")+
       '</div></button></li>';
  });
  h+='</ul><p class="muted small">'+App.staff.length+' employees. '+
     'Locked accounts unlock on their own after 5 minutes, or right away when you set a new PIN.</p>';
  host.innerHTML=h;
  host.querySelectorAll(".emps button").forEach(b=>{ b.onclick=()=>openEditor(App.staff[+b.dataset.i]); });
}

function closeSheet(){ const s=$("sheet"); if(s) s.remove(); }
function openEditor(emp){
  closeSheet();
  const iOwn=isOwner(App.me);
  const isNew=!emp;
  const readOnly=!isNew && isOwner(emp) && !iOwn;
  const isMe=!isNew && emp.id===App.me.id;
  const roles=isNew?[]:emp.roles;
  const dis=readOnly?" disabled":"";
  let checks='';
  ALL_ROLES.forEach(r=>{
    const off=readOnly || (r==="Owner" && !iOwn);
    checks+='<label class="'+(off?"dis":"")+'"><input type="checkbox" value="'+esc(r)+'"'+
      (roles.indexOf(r)>=0?" checked":"")+(off?" disabled":"")+'>'+esc(r)+'</label>';
  });
  let h='<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">'+
    '<h3 id="sheetTitle"><span style="flex:1">'+(isNew?"Add employee":esc(emp.name))+'</span>'+
    '<button class="btn ghost sm" id="sx" aria-label="Close">Close</button></h3>';
  if(readOnly) h+='<div class="notice warn">Only an Owner can change an Owner\'s details or PIN.</div>';
  h+='<label class="f">Name<input id="fName" autocomplete="off" maxlength="60" value="'+
       esc(isNew?"":emp.name)+'" placeholder="First name and last initial"'+dis+'></label>'+
     '<label class="f">Title<input id="fTitle" autocomplete="off" maxlength="80" value="'+
       esc(isNew?"":emp.title)+'" placeholder="e.g. Service Tech"'+dis+'></label>'+
     '<fieldset><legend>Roles (pick one or more)</legend><div class="checks" id="fRoles">'+checks+'</div></fieldset>';
  if(isNew){
    h+=pinField("Starting PIN (optional)");
    h+='<div class="row" style="justify-content:flex-end;margin-top:6px">'+
       '<button class="btn ghost" id="sCancel">Cancel</button>'+
       '<button class="btn primary" id="sSave">Add employee</button></div>';
  }else if(!readOnly){
    h+='<div class="row" style="justify-content:flex-end"><button class="btn primary" id="sSave">Save changes</button></div>'+
       '<hr><h3 style="font-size:16px;margin-bottom:6px">PIN</h3>'+
       '<p class="muted small" style="margin:0 0 10px">'+
       (emp.locked?"<b>Locked</b> after too many wrong tries. Setting a new PIN unlocks it. ":
        emp.has_pin?"A PIN is set. ":"No PIN yet. ")+
       (isMe?"":"Setting a new PIN signs them out of their other devices. ")+
       'Tell them the new PIN in person.</p>'+
       pinField("New PIN")+
       '<button class="btn" id="sPin">'+(emp.has_pin?"Reset PIN":"Set PIN")+'</button>';
    if(!isMe) h+='<hr><button class="btn danger block" id="sRemove">Remove '+esc(firstName(emp.name))+' from the team</button>'+
       '<p class="muted small" style="margin:8px 0 0">They\'ll be signed out and taken off the sign-in list.</p>';
  }
  h+='</div>';
  const scrim=document.createElement("div");
  scrim.className="scrim"; scrim.id="sheet"; scrim.innerHTML=h;
  scrim.addEventListener("click",e=>{ if(e.target===scrim) closeSheet(); });
  document.body.appendChild(scrim);

  $("sx").onclick=closeSheet;
  if($("sCancel")) $("sCancel").onclick=closeSheet;
  const pinInput=$("fPin");
  if(pinInput){
    pinInput.oninput=()=>{ pinInput.value=pinInput.value.replace(/\D/g,"").slice(0,PIN_LEN); };
    $("fPinGen").onclick=()=>{
      const a=new Uint32Array(1); crypto.getRandomValues(a);
      pinInput.value=String(a[0]%1000000).padStart(PIN_LEN,"0");
    };
  }
  if($("sSave")) $("sSave").onclick=()=>saveEmployee(emp);
  if($("sPin")) $("sPin").onclick=()=>setPin(emp);
  if($("sRemove")) $("sRemove").onclick=()=>removeEmployee(emp);
  if(isNew) $("fName").focus();
}
function pinField(label){
  return '<label class="f">'+label+'<span class="pinrow">'+
    '<input id="fPin" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="6 digits">'+
    '<button type="button" class="btn sm" id="fPinGen">Make one up</button></span></label>';
}
function formRoles(){
  return Array.from(document.querySelectorAll("#fRoles input:checked")).map(i=>i.value);
}
async function withBusy(btn,fn){
  if(btn.disabled) return; btn.disabled=true;
  try{ await fn(); }
  catch(e){ if(e.code!=="expired") alert(e.message); }
  finally{ btn.disabled=false; }
}
async function refreshMe(){
  try{ const r=await rpc("me",{p_token:App.token}); if(r.ok){ App.me=r.employee; save(ME_KEY,App.me); } }catch(e){}
}

function saveEmployee(emp){
  const btn=$("sSave");
  return withBusy(btn,async()=>{
    const name=$("fName").value.trim(), title=$("fTitle").value.trim(), roles=formRoles();
    if(!name) return alert("Please enter a name.");
    if(!roles.length) return alert("Pick at least one role.");
    const pinEl=$("fPin"), pin=(!emp && pinEl) ? pinEl.value : "";
    if(pin && pin.length!==PIN_LEN) return alert("A PIN must be exactly 6 digits, or leave it blank.");
    const saved=await rpc("admin_save_employee",
      {p_token:App.token, p_id:emp?emp.id:null, p_name:name, p_title:title, p_roles:roles});
    if(pin) await rpc("admin_set_pin",{p_token:App.token, p_id:saved.id, p_pin:pin});
    closeSheet();
    toast(emp ? "Saved." : name+" added"+(pin?" with a PIN.":". Set a PIN when you're ready."));
    if(emp && emp.id===App.me.id){ await refreshMe(); chrome(true); }
    viewAdmin();
  });
}
function setPin(emp){
  const btn=$("sPin");
  return withBusy(btn,async()=>{
    const pin=$("fPin").value;
    if(pin.length!==PIN_LEN) return alert("Enter exactly 6 digits, or tap “Make one up”.");
    await rpc("admin_set_pin",{p_token:App.token, p_id:emp.id, p_pin:pin});
    closeSheet();
    toast(firstName(emp.name)+"'s PIN is set to "+pin+". Tell them in person.");
    viewAdmin();
  });
}
function removeEmployee(emp){
  if(!confirm("Remove "+emp.name+" from the team?\n\nThey'll be signed out and won't appear on the sign-in list.")) return;
  const btn=$("sRemove");
  return withBusy(btn,async()=>{
    await rpc("admin_remove_employee",{p_token:App.token, p_id:emp.id});
    closeSheet(); toast(emp.name+" was removed."); viewAdmin();
  });
}

/* ============================================================================
   START
   ========================================================================== */
async function boot(){
  if(!configured()) return showNotConfigured();
  App.token=load(TOKEN_KEY); App.me=load(ME_KEY);
  if(!App.token) return showNames();
  if(App.me) showApp();                         // show right away from this device's memory
  try{
    const r=await rpc("me",{p_token:App.token});
    if(!r.ok) return signedOut("You were signed out. Please sign in again.");
    App.me=r.employee; save(ME_KEY,App.me);
    if(!$("sheet")) showApp();
  }catch(e){
    if(!App.me) setView('<div class="notice err">'+esc(e.message)+'</div>'+
      '<button class="btn primary" onclick="location.reload()">Try again</button>');
  }
}

if("serviceWorker" in navigator && location.protocol==="https:"){
  window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
}
boot();
