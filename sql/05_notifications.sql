-- ============================================================================
-- Icon Pools Team app: notifications for new announcements
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run AFTER 03_announcements.sql. Safe to run again.
--
-- * Each phone that taps "Turn on notifications" is saved here.
-- * General announcements go to everyone. Department ones go by role:
--     Owners and Administrators  every department
--     Construction Crew          Construction
--     Service Lead / Tech        Service
--     Retail Associate           Retail
--     Office Staff               Service and Retail
--   An Owner or Admin can change any person's list in the Admin tab.
-- * The person who posts isn't notified about their own announcement.
-- * Each announcement can only be sent out once.
-- ============================================================================

alter table public.employees add column if not exists notify_depts text[];   -- null = go by roles
alter table public.announcements add column if not exists notified_at timestamptz;

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_emp on public.push_subscriptions(employee_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- Jayce gets Hot Tubs (plus Office Staff's Service and Retail); only set if nobody has changed it yet
update public.employees set notify_depts = array['service','retail','hottubs']
 where lower(name) = 'jayce b' and notify_depts is null;

-- the departments a person hears about
create or replace function public._notify_depts(e public.employees)
returns text[] language sql immutable as $$
  select case
    when e.notify_depts is not null then e.notify_depts
    when e.roles && array['Owner','Administrator']::text[] then array['construction','service','retail','hottubs']
    else array(select distinct d from unnest(array[
      case when 'Construction Crew' = any(e.roles) then 'construction' end,
      case when e.roles && array['Service Lead','Service Tech','Office Staff']::text[] then 'service' end,
      case when e.roles && array['Retail Associate','Office Staff']::text[] then 'retail' end]) d
      where d is not null order by d)
  end
$$;

-- ---------- this phone ----------
create or replace function public.push_subscribe(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare me public.employees := public._require_employee(p_token);
begin
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'This phone didn''t give a usable notification address.';
  end if;
  -- the same phone signing in as someone else moves to that person
  insert into public.push_subscriptions (employee_id, endpoint, p256dh, auth)
  values (me.id, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set employee_id = excluded.employee_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  return jsonb_build_object('ok', true, 'depts', to_jsonb(public._notify_depts(me)));
end $$;

create or replace function public.push_unsubscribe(p_token text, p_endpoint text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare me public.employees := public._require_employee(p_token);
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and employee_id = me.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- sending (called by the notify-announcement function) ----------
-- Marks the announcement as sent and returns who should get it. Returns
-- {"send": false} if it was already sent, deleted, or is more than an hour old.
create or replace function public.push_claim_announcement(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  a  public.announcements;
begin
  update public.announcements set notified_at = now()
   where id = p_id and notified_at is null and archived_at is null and created_at > now() - interval '1 hour'
  returning * into a;
  if not found then return jsonb_build_object('send', false); end if;
  return jsonb_build_object('send', true, 'dept', a.dept, 'title', a.title, 'body', left(a.body, 300),
    'subs', coalesce((
      select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
        from public.push_subscriptions s join public.employees e on e.id = s.employee_id
       where e.active and e.id <> me.id
         and (a.dept = 'general' or a.dept = any(public._notify_depts(e)))), '[]'::jsonb));
end $$;

-- phones the push service says are gone (app deleted, notifications turned off)
create or replace function public.push_forget(p_token text, p_endpoints text[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_admin(p_token);
  delete from public.push_subscriptions where endpoint = any(p_endpoints);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- "new" badges: when each list last got an announcement ----------
create or replace function public.ann_latest(p_token text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_employee(p_token);
  return coalesce((select jsonb_object_agg(dept, latest) from (
    select dept, max(created_at) as latest from public.announcements
     where archived_at is null group by dept) x), '{}'::jsonb);
end $$;

-- ---------- Admin tab: who hears about which departments ----------
create or replace function public.admin_notify_get(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare e public.employees;
begin
  perform public._require_admin(p_token);
  select * into e from public.employees where id = p_id and active;
  if not found then raise exception 'That employee was not found.'; end if;
  return jsonb_build_object('depts', to_jsonb(public._notify_depts(e)), 'custom', e.notify_depts is not null,
    'phones', (select count(*) from public.push_subscriptions where employee_id = e.id));
end $$;

-- p_depts null = go back to "by roles"
create or replace function public.admin_notify_set(p_token text, p_id uuid, p_depts text[])
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  e  public.employees;
begin
  select * into e from public.employees where id = p_id and active for update;
  if not found then raise exception 'That employee was not found.'; end if;
  if 'Owner' = any(e.roles) and not 'Owner' = any(me.roles) then
    raise exception 'Only an Owner can change an Owner''s settings.';
  end if;
  if p_depts is not null and not p_depts <@ array['construction','service','retail','hottubs']::text[] then
    raise exception 'Unknown department.';
  end if;
  update public.employees set notify_depts = p_depts, updated_at = now() where id = e.id returning * into e;
  return jsonb_build_object('depts', to_jsonb(public._notify_depts(e)), 'custom', e.notify_depts is not null);
end $$;

revoke execute on function public._notify_depts(public.employees) from public, anon, authenticated;
revoke execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text, text),
  public.push_claim_announcement(text, uuid), public.push_forget(text, text[]), public.ann_latest(text),
  public.admin_notify_get(text, uuid), public.admin_notify_set(text, uuid, text[]) from public;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text, text),
  public.push_claim_announcement(text, uuid), public.push_forget(text, text[]), public.ann_latest(text),
  public.admin_notify_get(text, uuid), public.admin_notify_set(text, uuid, text[]) to anon, authenticated;

notify pgrst, 'reload schema';
