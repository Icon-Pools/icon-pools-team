-- ============================================================================
-- Icon Pools Team app: Construction check-in/out, hours and notes
-- Run this once in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run again; it only adds what is missing and updates its own functions.
-- Like the rest of the app, the tables are locked; the app can only reach them
-- through the functions below, which check the sign-in and the person's roles.
-- ============================================================================

-- ---------- tables ----------
create table if not exists public.time_entries (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  job_id      text not null,            -- the pool's id on the Production Board
  job_name    text not null,            -- its name at check-in, kept in case the pool is renamed or removed
  check_in    timestamptz not null,
  check_out   timestamptz,
  out_by_hand boolean not null default false,   -- the person typed their leave time instead of tapping out
  voided_at   timestamptz,
  voided_by   uuid references public.employees(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint time_order check (check_out is null or check_out > check_in)
);
-- one open check-in per person at a time
create unique index if not exists time_entries_one_open
  on public.time_entries(employee_id) where check_out is null and voided_at is null;
create index if not exists time_entries_in on public.time_entries(check_in);

-- every change to an entry: who, when, and what it was before and after
create table if not exists public.time_entry_log (
  id        bigint generated always as identity primary key,
  entry_id  uuid not null references public.time_entries(id),
  action    text not null,              -- check_in, check_out, check_out_by_hand, auto_out, fixed, added, voided
  by_id     uuid references public.employees(id),
  at        timestamptz not null default now(),
  before    jsonb,
  after     jsonb,
  note      text
);
create index if not exists time_entry_log_entry on public.time_entry_log(entry_id);

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  job_id      text,                     -- null = general note (Home screen)
  job_name    text,
  body        text not null,
  author_id   uuid not null references public.employees(id),
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  archived_at timestamptz,              -- "deleted" notes are archived, never erased
  archived_by uuid references public.employees(id)
);
create index if not exists notes_job on public.notes(job_id, created_at desc);

-- every version of every note, plus who archived or restored it
create table if not exists public.note_history (
  id       bigint generated always as identity primary key,
  note_id  uuid not null references public.notes(id),
  action   text not null,               -- created, edited, archived, restored
  by_id    uuid references public.employees(id),
  at       timestamptz not null default now(),
  body     text                         -- the note's text after this action
);
create index if not exists note_history_note on public.note_history(note_id, at);

alter table public.time_entries   enable row level security;
alter table public.time_entry_log enable row level security;
alter table public.notes          enable row level security;
alter table public.note_history   enable row level security;
revoke all on public.time_entries, public.time_entry_log, public.notes, public.note_history
  from anon, authenticated;

-- ---------- helpers ----------
create or replace function public._require_crew(p_token text)
returns public.employees language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare e public.employees := public._require_employee(p_token);
begin
  if not (e.roles && array['Owner','Administrator','Construction Crew']::text[]) then
    raise exception 'This is for the construction crew, Owners and Administrators.';
  end if;
  return e;
end $$;

create or replace function public._is_admin(e public.employees)
returns boolean language sql immutable as $$
  select coalesce(e.roles && array['Owner','Administrator']::text[], false)
$$;

-- current name of a pool on the board, or null if it is gone
create or replace function public._job_name(p_job_id text)
returns text language sql stable security definer
set search_path to 'public', 'extensions' as $$
  select nullif(btrim(data->>'name'), '') from public.board_docs where path = 'jobs/' || p_job_id
$$;

create or replace function public._time_json(t public.time_entries)
returns jsonb language sql stable security definer
set search_path to 'public', 'extensions' as $$
  select jsonb_build_object(
    'id', t.id, 'employee_id', t.employee_id,
    'employee', (select name from public.employees where id = t.employee_id),
    'job_id', t.job_id, 'job', coalesce(public._job_name(t.job_id), t.job_name),
    'check_in', t.check_in, 'check_out', t.check_out, 'out_by_hand', t.out_by_hand,
    'voided', t.voided_at is not null,
    'changes', (select count(*) from public.time_entry_log l
                 where l.entry_id = t.id and l.action in ('fixed','voided','added','check_out_by_hand','auto_out')))
$$;

create or replace function public._time_log(t_before public.time_entries, t_after public.time_entries,
                                             p_action text, p_by uuid, p_note text default null)
returns void language sql security definer
set search_path to 'public', 'extensions' as $$
  insert into public.time_entry_log (entry_id, action, by_id, before, after, note)
  values (coalesce(t_after.id, t_before.id), p_action, p_by,
          case when t_before.id is null then null else
            jsonb_build_object('check_in', t_before.check_in, 'check_out', t_before.check_out, 'job_id', t_before.job_id) end,
          case when t_after.id is null then null else
            jsonb_build_object('check_in', t_after.check_in, 'check_out', t_after.check_out, 'job_id', t_after.job_id) end,
          nullif(btrim(coalesce(p_note, '')), ''))
$$;

create or replace function public._note_json(n public.notes, me public.employees)
returns jsonb language sql stable security definer
set search_path to 'public', 'extensions' as $$
  select jsonb_build_object(
    'id', n.id, 'job_id', n.job_id,
    'job', case when n.job_id is null then null else coalesce(public._job_name(n.job_id), n.job_name) end,
    'body', n.body, 'author', (select name from public.employees where id = n.author_id),
    'created_at', n.created_at, 'edited_at', n.edited_at,
    'archived_at', n.archived_at, 'archived_by', (select name from public.employees where id = n.archived_by),
    'mine', n.author_id = me.id,
    'can_edit', n.archived_at is null and n.author_id = me.id,
    'can_archive', n.archived_at is null and (n.author_id = me.id or public._is_admin(me)),
    'can_restore', n.archived_at is not null and public._is_admin(me))
$$;

-- ---------- jobs to check in to ----------
create or replace function public.con_jobs(p_token text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_crew(p_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', substr(path, 6), 'name', data->>'name', 'type', data->>'type')
                     order by lower(data->>'name'))
      from public.board_docs
     where path like 'jobs/%' and coalesce(data->>'status', '') <> 'archived'
       and coalesce(btrim(data->>'name'), '') <> ''), '[]'::jsonb);
end $$;

-- ---------- check in / out ----------
create or replace function public.time_status(p_token text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_crew(p_token);
  t  public.time_entries;
begin
  select * into t from public.time_entries
   where employee_id = me.id and check_out is null and voided_at is null;
  return jsonb_build_object(
    'open', case when t.id is null then null else public._time_json(t) end,
    'recent', coalesce((select jsonb_agg(public._time_json(r) order by r.check_in desc)
                          from public.time_entries r
                         where r.employee_id = me.id and r.voided_at is null
                           and r.check_in > now() - interval '7 days'), '[]'::jsonb));
end $$;

create or replace function public.time_check_in(p_token text, p_job_id text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me   public.employees := public._require_crew(p_token);
  v_nm text := public._job_name(p_job_id);
  o    public.time_entries;
  o2   public.time_entries;
  t    public.time_entries;
begin
  if v_nm is null then raise exception 'That pool is not on the schedule any more. Refresh and try again.'; end if;
  -- switching pools: close the one they are on now
  select * into o from public.time_entries
   where employee_id = me.id and check_out is null and voided_at is null for update;
  if found then
    if o.job_id = p_job_id then return public.time_status(p_token); end if;
    update public.time_entries set check_out = greatest(now(), o.check_in + interval '1 second'), updated_at = now()
     where id = o.id returning * into o2;
    perform public._time_log(o, o2, 'check_out', me.id, 'Checked in to '||v_nm);
  end if;
  insert into public.time_entries (employee_id, job_id, job_name, check_in)
  values (me.id, p_job_id, v_nm, now()) returning * into t;
  perform public._time_log(null, t, 'check_in', me.id);
  return public.time_status(p_token);
end $$;

-- p_at: only when they forgot to tap out; the time they actually left (between check-in and now)
create or replace function public.time_check_out(p_token text, p_at timestamptz default null)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_crew(p_token);
  o  public.time_entries;
  t  public.time_entries;
  v_at timestamptz := coalesce(p_at, now());
begin
  select * into o from public.time_entries
   where employee_id = me.id and check_out is null and voided_at is null for update;
  if not found then return public.time_status(p_token); end if;
  if v_at <= o.check_in then raise exception 'The leave time has to be after you checked in.'; end if;
  if v_at > now() + interval '2 minutes' then raise exception 'The leave time can''t be in the future.'; end if;
  update public.time_entries set check_out = v_at, out_by_hand = (p_at is not null), updated_at = now()
   where id = o.id returning * into t;
  perform public._time_log(o, t, case when p_at is null then 'check_out' else 'check_out_by_hand' end, me.id);
  return public.time_status(p_token);
end $$;

-- ---------- hours (Owners and Administrators) ----------
create or replace function public.time_report(p_token text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_admin(p_token);
  return jsonb_build_object(
    'entries', coalesce((select jsonb_agg(public._time_json(t) order by t.check_in)
                           from public.time_entries t
                          where t.check_in < p_to and coalesce(t.check_out, now()) > p_from), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name) order by lower(e.name))
                          from public.employees e
                         where e.active and e.roles && array['Owner','Administrator','Construction Crew']::text[]), '[]'::jsonb));
end $$;

create or replace function public.time_history(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object(
            'action', l.action, 'by', (select name from public.employees where id = l.by_id),
            'at', l.at, 'before', l.before, 'after', l.after, 'note', l.note) order by l.at)
           from public.time_entry_log l where l.entry_id = p_id), '[]'::jsonb);
end $$;

create or replace function public.time_fix(p_token text, p_id uuid, p_in timestamptz, p_out timestamptz, p_note text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  o  public.time_entries;
  t  public.time_entries;
begin
  if btrim(coalesce(p_note, '')) = '' then raise exception 'Add a short reason for the change.'; end if;
  if p_out is not null and p_out <= p_in then raise exception 'Check-out has to be after check-in.'; end if;
  select * into o from public.time_entries where id = p_id for update;
  if not found then raise exception 'That entry was not found.'; end if;
  if o.voided_at is not null then raise exception 'That entry was removed.'; end if;
  update public.time_entries set check_in = p_in, check_out = p_out, updated_at = now()
   where id = o.id returning * into t;
  perform public._time_log(o, t, 'fixed', me.id, p_note);
  return public._time_json(t);
end $$;

create or replace function public.time_add(p_token text, p_employee uuid, p_job_id text,
                                           p_in timestamptz, p_out timestamptz, p_note text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me   public.employees := public._require_admin(p_token);
  v_nm text := public._job_name(p_job_id);
  t    public.time_entries;
begin
  if btrim(coalesce(p_note, '')) = '' then raise exception 'Add a short reason for the change.'; end if;
  if v_nm is null then raise exception 'Pick a pool.'; end if;
  if p_out is null or p_out <= p_in then raise exception 'Check-out has to be after check-in.'; end if;
  if not exists (select 1 from public.employees where id = p_employee and active) then
    raise exception 'Pick a person.'; end if;
  insert into public.time_entries (employee_id, job_id, job_name, check_in, check_out)
  values (p_employee, p_job_id, v_nm, p_in, p_out) returning * into t;
  perform public._time_log(null, t, 'added', me.id, p_note);
  return public._time_json(t);
end $$;

create or replace function public.time_void(p_token text, p_id uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  o  public.time_entries;
  t  public.time_entries;
begin
  if btrim(coalesce(p_note, '')) = '' then raise exception 'Add a short reason for the change.'; end if;
  select * into o from public.time_entries where id = p_id for update;
  if not found then raise exception 'That entry was not found.'; end if;
  update public.time_entries set voided_at = now(), voided_by = me.id, updated_at = now()
   where id = o.id returning * into t;
  perform public._time_log(o, t, 'voided', me.id, p_note);
  return public._time_json(t);
end $$;

-- ---------- notes ----------
-- p_job_id: null for general notes, a pool id for that pool, '*' for every pool's notes
create or replace function public.notes_list(p_token text, p_job_id text, p_archived boolean default false)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare me public.employees := public._require_crew(p_token);
begin
  return coalesce((
    select jsonb_agg(public._note_json(n, me) order by coalesce(n.archived_at, n.created_at) desc)
      from public.notes n
     where (case when p_job_id is null then n.job_id is null
                 when p_job_id = '*' then true
                 else n.job_id = p_job_id end)
       and (n.archived_at is not null) = coalesce(p_archived, false)
     limit 500), '[]'::jsonb);
end $$;

create or replace function public.note_add(p_token text, p_job_id text, p_body text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_crew(p_token);
  v_body text := btrim(coalesce(p_body, ''));
  v_nm text;
  n public.notes;
begin
  if v_body = '' then raise exception 'Write something first.'; end if;
  if length(v_body) > 4000 then raise exception 'That note is too long. Keep it under 4,000 characters.'; end if;
  if p_job_id is not null then
    v_nm := public._job_name(p_job_id);
    if v_nm is null then raise exception 'That pool is not on the schedule any more.'; end if;
  end if;
  insert into public.notes (job_id, job_name, body, author_id)
  values (p_job_id, v_nm, v_body, me.id) returning * into n;
  insert into public.note_history (note_id, action, by_id, body) values (n.id, 'created', me.id, v_body);
  return public._note_json(n, me);
end $$;

create or replace function public.note_edit(p_token text, p_id uuid, p_body text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_crew(p_token);
  v_body text := btrim(coalesce(p_body, ''));
  n public.notes;
begin
  if v_body = '' then raise exception 'A note can''t be empty. Delete it instead.'; end if;
  if length(v_body) > 4000 then raise exception 'That note is too long. Keep it under 4,000 characters.'; end if;
  select * into n from public.notes where id = p_id for update;
  if not found or n.archived_at is not null then raise exception 'That note was deleted. Refresh and try again.'; end if;
  if n.author_id <> me.id then raise exception 'Only the person who wrote a note can edit it.'; end if;
  if n.body = v_body then return public._note_json(n, me); end if;
  update public.notes set body = v_body, edited_at = now() where id = n.id returning * into n;
  insert into public.note_history (note_id, action, by_id, body) values (n.id, 'edited', me.id, v_body);
  return public._note_json(n, me);
end $$;

create or replace function public.note_archive(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_crew(p_token);
  n public.notes;
begin
  select * into n from public.notes where id = p_id for update;
  if not found then raise exception 'That note was not found.'; end if;
  if n.archived_at is not null then return public._note_json(n, me); end if;
  if n.author_id <> me.id and not public._is_admin(me) then
    raise exception 'Only the person who wrote a note, an Owner or an Administrator can delete it.';
  end if;
  update public.notes set archived_at = now(), archived_by = me.id where id = n.id returning * into n;
  insert into public.note_history (note_id, action, by_id, body) values (n.id, 'archived', me.id, n.body);
  return public._note_json(n, me);
end $$;

create or replace function public.note_restore(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  n public.notes;
begin
  select * into n from public.notes where id = p_id for update;
  if not found then raise exception 'That note was not found.'; end if;
  if n.archived_at is null then return public._note_json(n, me); end if;
  update public.notes set archived_at = null, archived_by = null where id = n.id returning * into n;
  insert into public.note_history (note_id, action, by_id, body) values (n.id, 'restored', me.id, n.body);
  return public._note_json(n, me);
end $$;

create or replace function public.note_history_list(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_crew(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object(
            'action', h.action, 'by', (select name from public.employees where id = h.by_id),
            'at', h.at, 'body', h.body) order by h.at)
           from public.note_history h where h.note_id = p_id), '[]'::jsonb);
end $$;

-- ---------- who may call what ----------
-- helpers: only the functions above may use them
revoke execute on function public._require_crew(text), public._is_admin(public.employees),
  public._job_name(text), public._time_json(public.time_entries),
  public._time_log(public.time_entries, public.time_entries, text, uuid, text),
  public._note_json(public.notes, public.employees)
  from public, anon, authenticated;
-- the app's calls: each one checks the sign-in itself
grant execute on function public.con_jobs(text), public.time_status(text),
  public.time_check_in(text, text), public.time_check_out(text, timestamptz),
  public.time_report(text, timestamptz, timestamptz), public.time_history(text, uuid),
  public.time_fix(text, uuid, timestamptz, timestamptz, text),
  public.time_add(text, uuid, text, timestamptz, timestamptz, text),
  public.time_void(text, uuid, text),
  public.notes_list(text, text, boolean), public.note_add(text, text, text),
  public.note_edit(text, uuid, text), public.note_archive(text, uuid),
  public.note_restore(text, uuid), public.note_history_list(text, uuid)
  to anon, authenticated;

notify pgrst, 'reload schema';
