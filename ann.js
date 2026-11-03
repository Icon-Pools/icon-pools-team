"use strict";
/* ============================================================================
   Announcements: General on Home, and one list per department.
   Everyone reads them; Owners and Administrators post, edit and delete.
   Deleting moves one to Past announcements; every change keeps a history.
   Uses the database functions in sql/03_announcements.sql.
   ========================================================================== */

async function annBlock(host,dept){
  if(!host) return;
  host.innerHTML=loading();
  let list;
  try{ list=await rpc("ann_list",{p_token:App.token, p_dept:dept, p_archived:false}); }
  catch(e){ if(e.code!=="expired") host.innerHTML='<div class="notice err">'+esc(e.message)+'</div>'; return; }
  if(!host.isConnected) return;
  const admin=isAdmin(App.me);
  let h='';
  if(admin) h+='<div class="row ann-tools"><button class="btn primary sm" data-new>+ New announcement</button>'+
               '<span class="grow"></span><button class="btn ghost sm" data-past>Past announcements</button></div>';
  if(!list.length) h+='<p class="muted" style="margin:4px 0 0">No announcements right now.</p>';
  h+='<ul class="anns">'+list.map(a=>annItem(a)).join("")+'</ul>';
  host.innerHTML=h;
  const refresh=()=>annBlock(host,dept);
  if(admin){
    host.querySelector("[data-new]").onclick=()=>annEditor(dept,null,refresh);
    host.querySelector("[data-past]").onclick=()=>annPast(dept,refresh);
  }
  wireAnns(host,list,refresh);
}
function annItem(a,past){
  return '<li data-a="'+esc(a.id)+'"><div class="ann-title">'+esc(a.title)+'</div>'+
    (a.body?'<div class="nbody">'+esc(a.body)+'</div>':'')+
    '<div class="muted small">'+esc(a.author)+' &middot; '+esc(tWhen(a.created_at))+(a.edited_at?' &middot; edited':'')+'</div>'+
    (past?'<div class="muted small">Deleted by '+esc(a.archived_by||"someone")+' '+esc(tWhen(a.archived_at))+'</div>':'')+
    (a.can_manage?'<div class="nact">'+
      (past?'<button class="btn ghost sm" data-x="restore">Restore</button>':
            '<button class="btn ghost sm" data-x="edit">Edit</button><button class="btn ghost sm" data-x="del">Delete</button>')+
      '<button class="btn ghost sm" data-x="hist">History</button></div>':'')+'</li>';
}
function wireAnns(host,list,refresh){
  host.querySelectorAll(".anns li").forEach(li=>{
    const a=list.find(x=>x.id===li.dataset.a); if(!a) return;
    li.querySelectorAll("[data-x]").forEach(b=>{
      const x=b.dataset.x;
      if(x==="edit") b.onclick=()=>annEditor(a.dept,a,refresh);
      if(x==="del") b.onclick=()=>{
        if(!confirm("Delete \""+a.title+"\"? It moves to Past announcements.")) return;
        withBusy(b,async()=>{ await rpc("ann_archive",{p_token:App.token, p_id:a.id}); toast("Announcement deleted"); refresh(); });
      };
      if(x==="restore") b.onclick=()=>withBusy(b,async()=>{
        await rpc("ann_restore",{p_token:App.token, p_id:a.id}); toast("Announcement restored"); refresh(); });
      if(x==="hist") b.onclick=()=>annHistory(a);
    });
  });
}
function annEditor(dept,a,refresh){
  openSheet(a?"Edit announcement":"New announcement",
    '<label class="f">Title<input id="anTitle" maxlength="120" value="'+esc(a?a.title:"")+'" placeholder="e.g. Safety meeting Friday 7 AM"></label>'+
    '<label class="f">Details (optional)<textarea id="anBody" rows="5" maxlength="4000">'+esc(a?a.body:"")+'</textarea></label>'+
    '<div class="row" style="justify-content:flex-end"><button class="btn ghost" id="anCancel">Cancel</button>'+
    '<button class="btn primary" id="anSave">'+(a?"Save":"Post")+'</button></div>');
  $("anCancel").onclick=closeSheet;
  if(!a) $("anTitle").focus();
  $("anSave").onclick=()=>withBusy($("anSave"),async()=>{
    const title=$("anTitle").value.trim(), body=$("anBody").value;
    if(!title) return alert("Give the announcement a title.");
    let posted=null;
    if(a) await rpc("ann_edit",{p_token:App.token, p_id:a.id, p_title:title, p_body:body});
    else posted=await rpc("ann_add",{p_token:App.token, p_dept:dept, p_title:title, p_body:body});
    closeSheet(); toast(a?"Announcement saved":"Announcement posted"); refresh();
    if(posted && typeof notifyAnnouncement==="function") notifyAnnouncement(posted.id);   // notify.js
  });
}
async function annPast(dept,refreshMain){
  openSheet("Past announcements",'<div id="pastHost">'+loading()+'</div>');
  let list;
  try{ list=await rpc("ann_list",{p_token:App.token, p_dept:dept, p_archived:true}); }
  catch(e){ closeSheet(); return failMsg(e); }
  const host=$("pastHost"); if(!host) return;
  host.innerHTML=list.length?'<ul class="anns">'+list.map(a=>annItem(a,true)).join("")+'</ul>'
                            :'<p class="muted">No deleted announcements.</p>';
  wireAnns(host,list,()=>{ refreshMain(); annPast(dept,refreshMain); });
}
async function annHistory(a){
  openSheet("Announcement history",loading());
  let h;
  try{ h=await rpc("ann_history",{p_token:App.token, p_id:a.id}); }
  catch(e){ closeSheet(); return failMsg(e); }
  const word={posted:"Posted",edited:"Edited",archived:"Deleted",restored:"Restored"};
  const box=document.querySelector("#sheet .sheet"); if(!box) return;
  box.querySelector(".spin").outerHTML='<ol class="hist">'+h.map(x=>
    '<li><div><b>'+esc(word[x.action]||x.action)+'</b> by '+esc(x.by||"someone")+
    ' <span class="muted small">'+esc(tWhen(x.at))+'</span></div>'+
    (x.action==="posted"||x.action==="edited"?'<div><b>'+esc(x.title)+'</b></div>'+(x.body?'<div class="nbody">'+esc(x.body)+'</div>':''):'')+
    '</li>').join("")+'</ol>';
}
