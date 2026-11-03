"use strict";
/* ============================================================================
   Construction: check in / out, hours, and notes.
   Uses the database functions in sql/02_construction.sql.
   Loaded after app.js and uses its helpers ($, esc, rpc, toast, App, ...).
   ========================================================================== */

const CREW_ROLES=["Owner","Administrator","Construction Crew"];
function isCrew(e){ return !!e && (e.roles||[]).some(r=>CREW_ROLES.indexOf(r)>=0); }
const FORGOT_HOURS=14;        // still checked in after this long: ask if they forgot

/* ---------- time helpers ---------- */
const DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function tClock(iso){ return new Date(iso).toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}); }
function tDay(iso){ const d=new Date(iso); return DAYS[d.getDay()]+" "+MONS[d.getMonth()]+" "+d.getDate(); }
function tWhen(iso){
  const d=new Date(iso), now=new Date();
  const same=d.toDateString()===now.toDateString();
  const yest=new Date(now); yest.setDate(now.getDate()-1);
  return (same?"Today":d.toDateString()===yest.toDateString()?"Yesterday":tDay(iso))+" "+tClock(iso);
}
function hoursBetween(a,b){ return Math.max(0,(new Date(b||Date.now())-new Date(a))/3600000); }
function fmtH(h){ const m=Math.round(h*60); return Math.floor(m/60)+"h "+String(m%60).padStart(2,"0")+"m"; }
function decH(h){ return (Math.round(h*100)/100).toFixed(2); }
function toInput(iso){            // ISO -> value for <input type="datetime-local">
  if(!iso) return "";
  const d=new Date(iso), p=n=>String(n).padStart(2,"0");
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes());
}
function fromInput(v){ return v ? new Date(v).toISOString() : null; }
function weekStart(d){ const x=new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; }

/* ---------- a pop-up sheet, same look as the Admin editor ---------- */
function openSheet(title,body){
  closeSheet();
  const scrim=document.createElement("div");
  scrim.className="scrim"; scrim.id="sheet";
  scrim.innerHTML='<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">'+
    '<h3 id="sheetTitle"><span style="flex:1">'+esc(title)+'</span>'+
    '<button class="btn ghost sm" id="sx">Close</button></h3>'+body+'</div>';
  scrim.addEventListener("click",e=>{ if(e.target===scrim) closeSheet(); });
  document.body.appendChild(scrim);
  $("sx").onclick=closeSheet;
}
function failMsg(e){ if(e && e.code!=="expired") alert(e.message); }
function loading(){ return '<span class="spin" aria-label="Loading"></span>'; }
function stillOn(tab){ return App.screen==="app" && App.tab==="construction" && App.subs.construction===tab; }

/* ---------- Construction sub-tab routing ---------- */
function conTabs(){            // after Announcements, which every department has
  const t=[["schedule","Schedule"]];
  if(isCrew(App.me)) t.push(["checkin","Check in"],["notes","Notes"]);
  if(isAdmin(App.me)) t.push(["hours","Hours"]);
  return t;
}
function viewConstruction(){
  const s=App.subs.construction;
  if(s==="checkin") return viewCheckin();
  if(s==="notes") return viewNotes();
  if(s==="hours") return viewHours();
}
let jobsCache=null;
async function conJobs(force){
  if(!jobsCache || force) jobsCache=await rpc("con_jobs",{p_token:App.token});
  return jobsCache;
}

/* ============================================================================
   CHECK IN / OUT
   ========================================================================== */
async function viewCheckin(){
  setView('<div id="ci">'+loading()+'</div>');
  let st, jobs;
  try{ [st,jobs]=await Promise.all([rpc("time_status",{p_token:App.token}), conJobs(true)]); }
  catch(e){ if(e.code!=="expired" && $("ci")) $("ci").innerHTML='<div class="notice err">'+esc(e.message)+'</div>'; return; }
  if(!stillOn("checkin")) return;
  drawCheckin(st,jobs);
}
function drawCheckin(st,jobs){
  const host=$("ci"); if(!host) return;
  const o=st.open;
  let h='';
  if(o){
    const hrs=hoursBetween(o.check_in);
    const forgot=hrs>=FORGOT_HOURS;
    h+='<div class="card clock on"><div class="muted small">You\'re checked in at</div>'+
       '<div class="big">'+esc(o.job)+'</div>'+
       '<div class="muted">Since '+esc(tWhen(o.check_in))+' &middot; '+fmtH(hrs)+'</div>';
    if(forgot){
      h+='<div class="notice warn" style="margin:12px 0 0">Did you forget to check out? Enter when you '+
         'actually left. The office will see that you entered it by hand.'+
         '<label class="f" style="margin:10px 0 8px">I left at<input type="datetime-local" id="leftAt" '+
         'min="'+toInput(o.check_in)+'" max="'+toInput(new Date().toISOString())+'"></label>'+
         '<button class="btn primary block" id="outAt">Check out at that time</button></div>';
    }else{
      h+='<button class="btn primary block big-btn" id="outNow" style="margin-top:12px">Check out</button>';
    }
    h+='</div>';
  }
  h+='<div class="card"><h3>'+(o?"Switch to another pool":"Which pool are you at?")+'</h3>';
  if(o) h+='<p class="muted small" style="margin:0 0 8px">Checks you out of '+esc(o.job)+' and into the new pool.</p>';
  const others=jobs.filter(j=>!o || j.id!==o.job_id);
  if(!others.length) h+='<p class="muted" style="margin:0">No pools on the schedule.</p>';
  else h+='<div class="joblist">'+others.map(j=>'<button class="btn" data-j="'+esc(j.id)+'">'+esc(j.name)+'</button>').join("")+'</div>';
  h+='</div>';
  if(o) h+='<div class="card"><h3>'+esc(o.job)+' notes</h3><div id="jobNotes">'+loading()+'</div></div>';
  // the last 7 days, by day
  const byDay={};
  (st.recent||[]).forEach(r=>{ const k=new Date(r.check_in).toDateString(); (byDay[k]=byDay[k]||[]).push(r); });
  const days=Object.keys(byDay);
  if(days.length){
    h+='<div class="card"><h3>Your last 7 days</h3><table class="tbl"><tbody>';
    days.forEach(k=>{
      const rows=byDay[k], tot=rows.reduce((s,r)=>s+hoursBetween(r.check_in,r.check_out),0);
      h+='<tr class="dayrow"><td colspan="2">'+esc(tDay(rows[0].check_in))+'</td><td class="n">'+fmtH(tot)+'</td></tr>';
      rows.slice().reverse().forEach(r=>{
        h+='<tr><td>'+esc(r.job)+'</td><td class="muted">'+esc(tClock(r.check_in))+' – '+
           (r.check_out?esc(tClock(r.check_out)):'<b>now</b>')+'</td><td class="n">'+fmtH(hoursBetween(r.check_in,r.check_out))+'</td></tr>';
      });
    });
    h+='</tbody></table></div>';
  }
  host.innerHTML=h;
  host.querySelectorAll("[data-j]").forEach(b=>{
    b.onclick=()=>withBusy(b,async()=>{
      const j=jobs.find(x=>x.id===b.dataset.j);
      if(o && !confirm("Check out of "+o.job+" and into "+j.name+"?")) return;
      const s=await rpc("time_check_in",{p_token:App.token, p_job_id:j.id});
      toast("Checked in at "+j.name); drawCheckin(s,jobs);
    });
  });
  if($("outNow")) $("outNow").onclick=()=>withBusy($("outNow"),async()=>{
    const s=await rpc("time_check_out",{p_token:App.token}); toast("Checked out. Thanks!"); drawCheckin(s,jobs);
  });
  if($("outAt")) $("outAt").onclick=()=>withBusy($("outAt"),async()=>{
    const v=$("leftAt").value; if(!v) return alert("Enter the time you left.");
    const s=await rpc("time_check_out",{p_token:App.token, p_at:fromInput(v)}); toast("Checked out."); drawCheckin(s,jobs);
  });
  if(o) notesBlock($("jobNotes"),o.job_id,{compact:true});
}

/* ============================================================================
   NOTES
   General notes (job_id null) show on Home; each pool has its own.
   "Delete" moves a note to the Archive; every change keeps a history.
   ========================================================================== */
App.notesJob = App.notesJob===undefined ? "" : App.notesJob;   // "" = general
async function viewNotes(){
  setView('<div class="row" style="margin-bottom:12px;flex-wrap:nowrap">'+
    '<select id="noteJob" class="pick" aria-label="Show notes for"><option value="">General</option></select>'+
    '<button class="btn ghost sm" id="toArchive">Archive</button></div>'+
    '<div id="notesHost">'+loading()+'</div>');
  $("toArchive").onclick=viewArchive;
  let jobs=[];
  try{ jobs=await conJobs(); }catch(e){ if(e.code==="expired") return; }
  if(!stillOn("notes")) return;
  const sel=$("noteJob");
  jobs.forEach(j=>{ const op=document.createElement("option"); op.value=j.id; op.textContent=j.name; sel.appendChild(op); });
  if(App.notesJob && !jobs.some(j=>j.id===App.notesJob)) App.notesJob="";
  sel.value=App.notesJob;
  sel.onchange=()=>{ App.notesJob=sel.value; notesBlock($("notesHost"),App.notesJob||null); };
  notesBlock($("notesHost"),App.notesJob||null);
}

// a note list with an add box, for General (jobId null) or one pool
async function notesBlock(host,jobId,opt){
  opt=opt||{};
  if(!host) return;
  host.innerHTML=loading();
  let list;
  try{ list=await rpc("notes_list",{p_token:App.token, p_job_id:jobId, p_archived:false}); }
  catch(e){ if(e.code!=="expired") host.innerHTML='<div class="notice err">'+esc(e.message)+'</div>'; return; }
  if(!host.isConnected) return;
  const shown=opt.limit?list.slice(0,opt.limit):list;
  let h='<div class="addnote"><textarea rows="2" maxlength="4000" placeholder="'+
        (jobId?"Add a note for this pool":"Add a note for everyone")+'"></textarea>'+
        '<button class="btn primary sm">Post</button></div>';
  if(!list.length) h+='<p class="muted small" style="margin:6px 0 0">No notes yet.</p>';
  h+='<ul class="notes">'+shown.map(n=>noteItem(n)).join("")+'</ul>';
  if(opt.limit && list.length>opt.limit) h+='<button class="btn ghost sm" data-more>See all '+list.length+' notes</button>';
  host.innerHTML=h;
  const ta=host.querySelector("textarea"), post=host.querySelector(".addnote button");
  post.onclick=()=>withBusy(post,async()=>{
    const body=ta.value.trim(); if(!body) return ta.focus();
    await rpc("note_add",{p_token:App.token, p_job_id:jobId, p_body:body});
    toast("Note posted"); notesBlock(host,jobId,opt);
  });
  const more=host.querySelector("[data-more]");
  if(more) more.onclick=()=>{ App.tab="construction"; App.subs.construction="notes"; App.notesJob=jobId||""; showApp(); };
  wireNotes(host,list,()=>notesBlock(host,jobId,opt));
}
function noteItem(n,archived){
  return '<li data-n="'+esc(n.id)+'"><div class="nhead"><b>'+esc(n.author)+'</b>'+
    '<span class="muted small">'+esc(tWhen(n.created_at))+(n.edited_at?' &middot; edited':'')+'</span></div>'+
    '<div class="nbody">'+esc(n.body)+'</div>'+
    (archived?'<div class="muted small">Deleted by '+esc(n.archived_by||"someone")+' '+esc(tWhen(n.archived_at))+'</div>':'')+
    '<div class="nact">'+
      (n.can_edit?'<button class="btn ghost sm" data-a="edit">Edit</button>':'')+
      (n.can_archive?'<button class="btn ghost sm" data-a="del">Delete</button>':'')+
      (n.can_restore?'<button class="btn ghost sm" data-a="restore">Restore</button>':'')+
      '<button class="btn ghost sm" data-a="hist">History</button></div></li>';
}
function wireNotes(host,list,refresh){
  host.querySelectorAll(".notes li").forEach(li=>{
    const n=list.find(x=>x.id===li.dataset.n); if(!n) return;
    li.querySelectorAll("[data-a]").forEach(b=>{
      const a=b.dataset.a;
      if(a==="edit") b.onclick=()=>editNote(n,refresh);
      if(a==="del") b.onclick=()=>{
        if(!confirm("Delete this note? It moves to the Archive, where it can still be read.")) return;
        withBusy(b,async()=>{ await rpc("note_archive",{p_token:App.token, p_id:n.id}); toast("Moved to the Archive"); refresh(); });
      };
      if(a==="restore") b.onclick=()=>withBusy(b,async()=>{
        await rpc("note_restore",{p_token:App.token, p_id:n.id}); toast("Note restored"); refresh(); });
      if(a==="hist") b.onclick=()=>noteHistory(n);
    });
  });
}
function editNote(n,refresh){
  openSheet("Edit note",'<label class="f">Note<textarea id="eBody" rows="6" maxlength="4000">'+esc(n.body)+'</textarea></label>'+
    '<p class="muted small" style="margin:0 0 12px">The earlier version is kept in the note\'s history.</p>'+
    '<div class="row" style="justify-content:flex-end"><button class="btn ghost" id="eCancel">Cancel</button>'+
    '<button class="btn primary" id="eSave">Save</button></div>');
  $("eCancel").onclick=closeSheet;
  $("eSave").onclick=()=>withBusy($("eSave"),async()=>{
    await rpc("note_edit",{p_token:App.token, p_id:n.id, p_body:$("eBody").value});
    closeSheet(); toast("Note saved"); refresh();
  });
}
async function noteHistory(n){
  openSheet("Note history",loading());
  let h;
  try{ h=await rpc("note_history_list",{p_token:App.token, p_id:n.id}); }
  catch(e){ closeSheet(); return failMsg(e); }
  const word={created:"Posted",edited:"Edited",archived:"Deleted",restored:"Restored"};
  const box=document.querySelector("#sheet .sheet");
  if(!box) return;
  box.querySelector(".spin").outerHTML='<ol class="hist">'+h.map(x=>
    '<li><div><b>'+esc(word[x.action]||x.action)+'</b> by '+esc(x.by||"someone")+
    ' <span class="muted small">'+esc(tWhen(x.at))+'</span></div>'+
    (x.action==="created"||x.action==="edited"?'<div class="nbody">'+esc(x.body)+'</div>':'')+'</li>').join("")+'</ol>';
}

// Archive: every deleted note, grouped by pool, then by month
async function viewArchive(){
  setView('<button class="btn ghost sm" id="back">&lsaquo; Notes</button>'+
    '<h2>Notes archive</h2><div id="arch">'+loading()+'</div>');
  $("back").onclick=viewNotes;
  let list;
  try{ list=await rpc("notes_list",{p_token:App.token, p_job_id:"*", p_archived:true}); }
  catch(e){ if(e.code!=="expired" && $("arch")) $("arch").innerHTML='<div class="notice err">'+esc(e.message)+'</div>'; return; }
  const host=$("arch"); if(!host) return;
  if(!list.length){ host.innerHTML='<p class="muted">Nothing in the Archive.</p>'; return; }
  const groups={};
  list.forEach(n=>{ const k=n.job_id?n.job:"General"; (groups[k]=groups[k]||[]).push(n); });
  const names=Object.keys(groups).sort((a,b)=>a==="General"?-1:b==="General"?1:a.localeCompare(b));
  let h='';
  names.forEach(g=>{
    h+='<details class="card arch" open><summary><b>'+esc(g)+'</b> <span class="muted small">'+groups[g].length+'</span></summary>';
    let month="";
    groups[g].sort((a,b)=>b.created_at.localeCompare(a.created_at)).forEach(n=>{
      const d=new Date(n.created_at), m=MONS[d.getMonth()]+" "+d.getFullYear();
      if(m!==month){ if(month) h+='</ul>'; month=m; h+='<div class="muted small arch-m">'+esc(m)+'</div><ul class="notes">'; }
      h+=noteItem(n,true);
    });
    h+='</ul></details>';
  });
  host.innerHTML=h;
  wireNotes(host,list,viewArchive);
}


/* ============================================================================
   HOURS (Owners and Administrators)
   ========================================================================== */
App.hoursFrom = App.hoursFrom || weekStart(new Date());
async function viewHours(){
  const from=new Date(App.hoursFrom), to=new Date(from); to.setDate(from.getDate()+7);
  const last=new Date(to); last.setDate(to.getDate()-1);
  setView('<div class="row" style="margin-bottom:12px">'+
      '<button class="btn sm" id="wPrev" aria-label="Previous week">&lsaquo;</button>'+
      '<b style="min-width:150px;text-align:center">'+esc(MONS[from.getMonth()]+" "+from.getDate()+" – "+MONS[last.getMonth()]+" "+last.getDate())+'</b>'+
      '<button class="btn sm" id="wNext" aria-label="Next week">&rsaquo;</button>'+
      '<button class="btn ghost sm" id="wNow">This week</button><span class="grow"></span>'+
      '<button class="btn sm" id="hAdd">+ Add hours</button>'+
      '<button class="btn primary sm" id="hCsv">Download spreadsheet</button></div>'+
    '<div id="hrs">'+loading()+'</div>');
  const shift=n=>{ const d=new Date(App.hoursFrom); d.setDate(d.getDate()+n); App.hoursFrom=d; viewHours(); };
  $("wPrev").onclick=()=>shift(-7); $("wNext").onclick=()=>shift(7);
  $("wNow").onclick=()=>{ App.hoursFrom=weekStart(new Date()); viewHours(); };
  let rep;
  try{ rep=await rpc("time_report",{p_token:App.token, p_from:from.toISOString(), p_to:to.toISOString()}); }
  catch(e){ if(e.code!=="expired" && $("hrs")) $("hrs").innerHTML='<div class="notice err">'+esc(e.message)+'</div>'; return; }
  if(!stillOn("hours")) return;
  $("hAdd").onclick=()=>addHours(rep.people);
  $("hCsv").onclick=()=>downloadHours(rep.entries,from,last);
  drawHours(rep);
}
function entryHours(t){ return t.voided?0:hoursBetween(t.check_in,t.check_out); }
function entryFlags(t){
  const f=[];
  if(t.voided) f.push('<span class="pill bad">Removed</span>');
  else if(!t.check_out) f.push('<span class="pill warn">Still checked in</span>');
  if(t.out_by_hand) f.push('<span class="pill warn">Out time typed</span>');
  if(t.changes>0 && !t.voided) f.push('<span class="pill">Changed</span>');
  return f.join(" ");
}
function drawHours(rep){
  const host=$("hrs"); if(!host) return;
  const ents=rep.entries;
  if(!ents.length){ host.innerHTML='<p class="muted">No check-ins this week.</p>'; return; }
  const byP={}, byJ={};
  ents.forEach(t=>{ (byP[t.employee]=byP[t.employee]||[]).push(t);
    if(!t.voided) byJ[t.job]=(byJ[t.job]||0)+entryHours(t); });
  const people=Object.keys(byP).sort();
  let h='<div class="card"><h3>Totals</h3><table class="tbl"><thead><tr><th>Person</th><th class="n">Hours</th></tr></thead><tbody>'+
    people.map(p=>'<tr><td>'+esc(p)+'</td><td class="n">'+fmtH(byP[p].reduce((s,t)=>s+entryHours(t),0))+'</td></tr>').join("")+
    '</tbody></table><table class="tbl" style="margin-top:12px"><thead><tr><th>Pool</th><th class="n">Hours</th></tr></thead><tbody>'+
    Object.keys(byJ).sort().map(j=>'<tr><td>'+esc(j)+'</td><td class="n">'+fmtH(byJ[j])+'</td></tr>').join("")+
    '</tbody></table></div>';
  people.forEach(p=>{
    h+='<div class="card"><h3>'+esc(p)+'</h3><table class="tbl click"><tbody>';
    byP[p].forEach(t=>{
      h+='<tr data-t="'+esc(t.id)+'" class="'+(t.voided?"void":"")+'"><td>'+esc(tDay(t.check_in))+'<div class="muted small">'+esc(t.job)+'</div></td>'+
         '<td>'+esc(tClock(t.check_in))+' – '+(t.check_out?esc(tClock(t.check_out)):'now')+'<div>'+entryFlags(t)+'</div></td>'+
         '<td class="n">'+fmtH(hoursBetween(t.check_in,t.check_out))+'</td></tr>';
    });
    h+='</tbody></table></div>';
  });
  host.innerHTML=h;
  host.querySelectorAll("[data-t]").forEach(tr=>{
    tr.onclick=()=>fixEntry(ents.find(t=>t.id===tr.dataset.t));
  });
}
async function fixEntry(t){
  const ro=t.voided;
  openSheet(t.employee+" · "+t.job,
    (ro?'<div class="notice warn">This entry was removed and doesn\'t count toward hours.</div>':
    '<label class="f">Checked in<input type="datetime-local" id="fIn" value="'+toInput(t.check_in)+'"></label>'+
    '<label class="f">Checked out<input type="datetime-local" id="fOut" value="'+toInput(t.check_out)+'"></label>'+
    '<label class="f">Reason for the change<input id="fWhy" maxlength="200" placeholder="e.g. Forgot to check out"></label>'+
    '<div class="row" style="justify-content:space-between"><button class="btn danger" id="fVoid">Remove entry</button>'+
    '<button class="btn primary" id="fSave">Save</button></div>')+
    '<hr><h3 style="font-size:16px;margin-bottom:6px">History</h3><div id="fHist">'+loading()+'</div>');
  if(!ro){
    $("fSave").onclick=()=>withBusy($("fSave"),async()=>{
      const why=$("fWhy").value.trim(); if(!why) return alert("Add a short reason for the change.");
      if(!$("fIn").value) return alert("Enter the check-in time.");
      await rpc("time_fix",{p_token:App.token, p_id:t.id, p_in:fromInput($("fIn").value), p_out:fromInput($("fOut").value), p_note:why});
      closeSheet(); toast("Entry fixed"); viewHours();
    });
    $("fVoid").onclick=()=>withBusy($("fVoid"),async()=>{
      const why=$("fWhy").value.trim(); if(!why) return alert("Add a short reason for removing it.");
      if(!confirm("Remove this entry? It stops counting toward hours but stays in the history.")) return;
      await rpc("time_void",{p_token:App.token, p_id:t.id, p_note:why});
      closeSheet(); toast("Entry removed"); viewHours();
    });
  }
  let hist;
  try{ hist=await rpc("time_history",{p_token:App.token, p_id:t.id}); }catch(e){ return; }
  const word={check_in:"Checked in",check_out:"Checked out",check_out_by_hand:"Typed their leave time",
              fixed:"Fixed",added:"Added by hand",voided:"Removed"};
  const span=x=>x?(tWhen(x.check_in)+" – "+(x.check_out?tWhen(x.check_out):"open")):"";
  if($("fHist")) $("fHist").innerHTML='<ol class="hist">'+hist.map(x=>
    '<li><b>'+esc(word[x.action]||x.action)+'</b> by '+esc(x.by||"someone")+' <span class="muted small">'+esc(tWhen(x.at))+'</span>'+
    (x.action==="fixed"?'<div class="small">'+esc(span(x.before))+' &rarr; '+esc(span(x.after))+'</div>':'')+
    (x.note?'<div class="small muted">'+esc(x.note)+'</div>':'')+'</li>').join("")+'</ol>';
}
async function addHours(people){
  let jobs=[];
  try{ jobs=await conJobs(true); }catch(e){ return failMsg(e); }
  openSheet("Add hours",
    '<label class="f">Person<select id="aWho"><option value="">Pick a person</option>'+
      people.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("")+'</select></label>'+
    '<label class="f">Pool<select id="aJob"><option value="">Pick a pool</option>'+
      jobs.map(j=>'<option value="'+esc(j.id)+'">'+esc(j.name)+'</option>').join("")+'</select></label>'+
    '<label class="f">Checked in<input type="datetime-local" id="aIn"></label>'+
    '<label class="f">Checked out<input type="datetime-local" id="aOut"></label>'+
    '<label class="f">Reason<input id="aWhy" maxlength="200" placeholder="e.g. Phone was dead"></label>'+
    '<div class="row" style="justify-content:flex-end"><button class="btn primary" id="aSave">Add hours</button></div>');
  $("aSave").onclick=()=>withBusy($("aSave"),async()=>{
    const v=id=>$(id).value;
    if(!v("aWho")||!v("aJob")||!v("aIn")||!v("aOut")) return alert("Fill in the person, pool and both times.");
    if(!v("aWhy").trim()) return alert("Add a short reason.");
    await rpc("time_add",{p_token:App.token, p_employee:v("aWho"), p_job_id:v("aJob"),
      p_in:fromInput(v("aIn")), p_out:fromInput(v("aOut")), p_note:v("aWhy")});
    closeSheet(); toast("Hours added"); viewHours();
  });
}
function downloadHours(ents,from,last){
  const q=v=>{ v=String(v==null?"":v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const lines=[["Person","Date","Pool","Check in","Check out","Hours","Notes"].join(",")];
  ents.filter(t=>!t.voided).sort((a,b)=>a.employee.localeCompare(b.employee)||a.check_in.localeCompare(b.check_in)).forEach(t=>{
    const notes=[]; if(!t.check_out) notes.push("Still checked in"); if(t.out_by_hand) notes.push("Out time typed by hand");
    if(t.changes>0) notes.push("Changed by office");
    const d=new Date(t.check_in);
    lines.push([t.employee, (d.getMonth()+1)+"/"+d.getDate()+"/"+d.getFullYear(), t.job, tClock(t.check_in),
      t.check_out?tClock(t.check_out):"", decH(hoursBetween(t.check_in,t.check_out)), notes.join("; ")].map(q).join(","));
  });
  const p=n=>String(n).padStart(2,"0");
  const name="hours-"+from.getFullYear()+"-"+p(from.getMonth()+1)+"-"+p(from.getDate())+".csv";
  const url=URL.createObjectURL(new Blob(["﻿"+lines.join("\r\n")],{type:"text/csv"}));
  const a=document.createElement("a"); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
