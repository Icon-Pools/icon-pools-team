"use strict";
/* ============================================================================
   Notifications for new announcements.
   - Phone banners: "Turn on notifications" on Home saves this phone; posting an
     announcement asks the notify-announcement Edge Function to send them.
   - "New" dots on tabs for announcements this device hasn't looked at yet.
   - Admin: which departments each person hears about.
   Uses sql/05_notifications.sql and supabase/notify-announcement.ts.
   Loaded after app.js and ann.js and uses their helpers.
   ========================================================================== */

// public half of the notification key pair (the private half lives only in Supabase)
const VAPID_PUBLIC_KEY = "BDFOwT2Fjy8h8V_v9ZJ-2LmSny_ZcVgUNRkFjrfzK7X1mI0dIWBO5qzbGxqRILRPiH6zzSwgU5WdVL8n2VNQT-E";
const NOTIFY_DEPTS = [["construction","Construction"],["service","Service"],["retail","Retail"],["hottubs","Hot Tubs"]];

/* ---------- phone notifications ---------- */
function pushSupported(){ return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function onIOS(){ return /iPhone|iPad|iPod/.test(navigator.userAgent); }
function keyBytes(s){
  const t=s.replace(/-/g,"+").replace(/_/g,"/"), bin=atob(t+"=".repeat((4-t.length%4)%4));
  return Uint8Array.from(bin,c=>c.charCodeAt(0));
}
async function pushSubscription(){
  if(!pushSupported()) return null;
  const reg=await navigator.serviceWorker.getRegistration(); if(!reg) return null;
  return reg.pushManager.getSubscription();
}
async function pushSave(sub){
  const j=sub.toJSON();
  await rpc("push_subscribe",{p_token:App.token, p_endpoint:j.endpoint, p_p256dh:j.keys.p256dh, p_auth:j.keys.auth});
}
async function pushTurnOn(){
  if(Notification.permission==="denied")
    throw new Error("Notifications are blocked for this app. Allow them in your phone's Settings, then try again.");
  if(await Notification.requestPermission()!=="granted") throw new Error("Notifications weren't allowed.");
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:keyBytes(VAPID_PUBLIC_KEY)});
  await pushSave(sub);
}
async function pushTurnOff(){
  const sub=await pushSubscription(); if(!sub) return;
  try{ await rpc("push_unsubscribe",{p_token:App.token, p_endpoint:sub.endpoint}); }catch(e){}
  await sub.unsubscribe();
}
// on log out, this phone stops getting that person's notifications
async function pushForgetDevice(token){
  const sub=await pushSubscription().catch(()=>null);
  if(sub) await rpc("push_unsubscribe",{p_token:token, p_endpoint:sub.endpoint}).catch(()=>{});
}
// once per visit, re-save this phone (its address can change, or someone else may have signed in)
let pushSynced=false;
async function pushSync(){
  if(pushSynced || !pushSupported() || Notification.permission!=="granted") return;
  pushSynced=true;
  try{ const sub=await pushSubscription(); if(sub) await pushSave(sub); }catch(e){}
}

// the card on Home
async function notifyCard(host){
  if(!host) return;
  if(!pushSupported()){
    if(onIOS() && !isInstalled()) host.innerHTML='<div class="card"><h3>Get notifications</h3>'+
      '<p class="muted small" style="margin:0">To get a notification when there\'s a new announcement, first put this app '+
      'on your home screen (in Safari: <b>Share</b>, then <b>Add to Home Screen</b>), then open it from there.</p></div>';
    return;
  }
  const sub=await pushSubscription().catch(()=>null);
  if(!host.isConnected) return;
  if(sub && Notification.permission==="granted"){
    host.innerHTML='<p class="muted small notify-on">Notifications are on for this phone. '+
      '<button class="btn ghost sm" id="pushOff">Turn off</button></p>';
    $("pushOff").onclick=()=>withBusy($("pushOff"),async()=>{ await pushTurnOff(); toast("Notifications turned off"); notifyCard(host); });
    return;
  }
  const blocked=Notification.permission==="denied";
  host.innerHTML='<div class="card"><h3>Get notifications</h3><p class="muted small" style="margin:0 0 10px">'+
    (blocked?"Notifications are blocked for this app. Allow them in your phone's Settings, then tap below."
            :"Get a notification on this phone when there's a new announcement.")+'</p>'+
    '<button class="btn primary" id="pushOn">Turn on notifications</button></div>';
  $("pushOn").onclick=()=>withBusy($("pushOn"),async()=>{ await pushTurnOn(); toast("Notifications are on"); notifyCard(host); });
}

// after an Owner or Admin posts: ask the Edge Function to send it out
async function notifyAnnouncement(id){
  try{
    const h={"Content-Type":"application/json","apikey":CFG.supabaseKey};
    if(/^eyJ/.test(CFG.supabaseKey)) h.Authorization="Bearer "+CFG.supabaseKey;
    const r=await fetch(CFG.supabaseUrl.replace(/\/+$/,"")+"/functions/v1/notify-announcement",
      {method:"POST", headers:h, body:JSON.stringify({token:App.token, id})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.error||("error "+r.status));
    if(d.skipped) return;
    toast(d.sent ? "Posted and sent to "+d.sent+" phone"+(d.sent===1?"":"s")
                 : "Posted. Nobody it applies to has notifications on yet.");
  }catch(e){ toast("Posted, but the notification didn't send: "+e.message); }
}

/* ---------- "new" dots ----------
   Remembers, per person on this device, when each list was last looked at. */
let annLatest=null;
function seenKey(){ return "ipt.seen."+(App.me?App.me.id:""); }
function seenMap(){
  let m=load(seenKey());
  if(!m){                           // first time on this device: don't flag old announcements
    m={}; const now=Date.now(); ["general"].concat(DEPTS).forEach(d=>m[d]=now); save(seenKey(),m);
  }
  return m;
}
function viewingDept(){
  if(App.screen!=="app") return null;
  if(App.tab==="home") return "general";
  if(DEPTS.indexOf(App.tab)>=0 && sub()==="ann") return App.tab;
  return null;
}
function paintBadges(){
  if(!annLatest || !App.me) return;
  const seen=seenMap(), d=viewingDept();
  if(d && annLatest[d] && Date.parse(annLatest[d])>(seen[d]||0)){ seen[d]=Date.parse(annLatest[d]); save(seenKey(),seen); }
  const isNew=k=>!!annLatest[k] && Date.parse(annLatest[k])>(seen[k]||0);
  document.querySelectorAll("#tabs button").forEach(b=>{
    const t=b.dataset.t; b.classList.toggle("has-new", isNew(t==="home"?"general":t));
  });
  const ann=document.querySelector('#subtabs button[data-c="ann"]');
  if(ann) ann.classList.toggle("has-new", isNew(App.tab));
}
async function refreshLatest(){
  if(!App.token || App.screen!=="app" || document.hidden) return;
  try{ annLatest=await rpc("ann_latest",{p_token:App.token})||{}; }catch(e){ return; }
  paintBadges();
}

// app.js calls this every time it draws a tab
let notifyStarted=false;
function afterShowApp(){
  paintBadges();
  if(App.tab==="home") notifyCard($("notifyHost"));
  if(notifyStarted) return;
  notifyStarted=true;
  pushSync(); refreshLatest();
  setInterval(refreshLatest,60000);
  document.addEventListener("visibilitychange",refreshLatest);
}

/* ---------- opening the app from a notification ---------- */
function openTabFromNotification(t){
  if(!t) return;
  App.tab=t; if(DEPTS.indexOf(t)>=0) App.subs[t]="ann";
  if(App.screen==="app") showApp();
}
(function(){
  const q=new URLSearchParams(location.search), t=q.get("tab");
  if(t){ history.replaceState(null,"",location.pathname); openTabFromNotification(t); }
  if("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message",e=>{
    if(e.data && e.data.openTab) openTabFromNotification(e.data.openTab);
  });
})();

/* ---------- Admin: which departments a person hears about ---------- */
async function notifyEditor(emp,host){
  if(!host) return;
  host.innerHTML='<hr><h3 style="font-size:16px;margin-bottom:6px">Notifications</h3>'+loading();
  let st;
  try{ st=await rpc("admin_notify_get",{p_token:App.token, p_id:emp.id}); }
  catch(e){ host.innerHTML=''; return; }
  if(!host.isConnected) return;
  host.innerHTML='<hr><h3 style="font-size:16px;margin-bottom:6px">Notifications</h3>'+
    '<p class="muted small" style="margin:0 0 8px">General announcements go to everyone. '+
    (st.custom?"These were picked by hand.":"These come from their roles.")+' '+
    (st.phones?st.phones+' phone'+(st.phones===1?' has':'s have')+' notifications on.':'No phone has notifications on yet.')+'</p>'+
    '<div class="checks" id="nDepts">'+NOTIFY_DEPTS.map(d=>'<label><input type="checkbox" value="'+d[0]+'"'+
      (st.depts.indexOf(d[0])>=0?" checked":"")+'>'+d[1]+'</label>').join("")+'</div>'+
    '<div class="row" style="justify-content:flex-end;margin-top:10px">'+
      (st.custom?'<button class="btn ghost sm" id="nReset">Go by roles</button>':'')+
      '<button class="btn sm" id="nSave">Save notifications</button></div>';
  const done=r=>{ toast("Notification settings saved"); notifyEditor(emp,host); return r; };
  $("nSave").onclick=()=>withBusy($("nSave"),async()=>{
    const picked=Array.from(host.querySelectorAll("#nDepts input:checked")).map(i=>i.value);
    done(await rpc("admin_notify_set",{p_token:App.token, p_id:emp.id, p_depts:picked}));
  });
  if($("nReset")) $("nReset").onclick=()=>withBusy($("nReset"),async()=>{
    done(await rpc("admin_notify_set",{p_token:App.token, p_id:emp.id, p_depts:null}));
  });
}
