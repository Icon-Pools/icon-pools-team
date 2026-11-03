-- =====================================================================
-- Icon Pools Team app: "What did you do today?" on check-out
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run AFTER 02_construction.sql. Safe to run again.
--
-- Adds a work description to each check-in entry. It's filled in when
-- someone checks out, or when they switch to another pool (which checks
-- them out of the first one). The older app keeps working while the new
-- version is uploaded: the description is optional on the database side,
-- and the app is what asks for it.
-- =====================================================================

alter table public.time_entries add column if not exists work_done text;

create or replace function public._time_json(t public.time_entries)
returns jsonb language sql stable security definer
set search_path to 'public', 'extensions' as $$
  select jsonb_build_object(
    'id', t.id, 'employee_id', t.employee_id,
    'employee', (select name from public.employees where id = t.employee_id),
    'job_id', t.job_id, 'job', coalesce(public._job_name(t.job_id), t.job_name),
    'check_in', t.check_in, 'check_out', t.check_out, 'out_by_hand', t.out_by_hand,
    'work', t.work_done,
    'voided', t.voided_at is not null,
    'changes', (select count(*) from public.time_entry_log l
                 where l.entry_id = t.id and l.action in ('fixed','voided','added','check_out_by_hand','auto_out')))
$$;

-- the description, cleaned up; null when nothing was typed
create or replace function public._work_text(p_work text)
returns text language sql immutable as $$
  select nullif(left(btrim(coalesce(p_work, '')), 2000), '')
$$;

-- check in (or switch pools). p_work describes the pool they're leaving.
drop function if exists public.time_check_in(text, text);
create or replace function public.time_check_in(p_token text, p_job_id text, p_work text default null)
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
    update public.time_entries
       set check_out = greatest(now(), o.check_in + interval '1 second'),
           work_done = coalesce(public._work_text(p_work), work_done), updated_at = now()
     where id = o.id returning * into o2;
    perform public._time_log(o, o2, 'check_out', me.id, 'Checked in to '||v_nm);
  end if;
  insert into public.time_entries (employee_id, job_id, job_name, check_in)
  values (me.id, p_job_id, v_nm, now()) returning * into t;
  perform public._time_log(null, t, 'check_in', me.id);
  return public.time_status(p_token);
end $$;

-- check out. p_at: only when they forgot to tap out (the time they actually left).
drop function if exists public.time_check_out(text, timestamptz);
create or replace function public.time_check_out(p_token text, p_at timestamptz default null, p_work text default null)
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
  update public.time_entries
     set check_out = v_at, out_by_hand = (p_at is not null),
         work_done = coalesce(public._work_text(p_work), work_done), updated_at = now()
   where id = o.id returning * into t;
  perform public._time_log(o, t, case when p_at is null then 'check_out' else 'check_out_by_hand' end, me.id);
  return public.time_status(p_token);
end $$;

revoke execute on function public._work_text(text) from public, anon, authenticated;
revoke execute on function public.time_check_in(text, text, text),
  public.time_check_out(text, timestamptz, text) from public;
grant execute on function public.time_check_in(text, text, text),
  public.time_check_out(text, timestamptz, text) to anon, authenticated;

notify pgrst, 'reload schema';
