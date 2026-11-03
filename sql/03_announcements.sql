-- ============================================================================
-- Icon Pools Team app: announcements (General on Home, plus one list per department)
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to run again.
-- Everyone signed in can read them; Owners and Administrators post, edit and delete.
-- Deleting moves an announcement to the archive; every change is kept in its history.
-- ============================================================================

create table if not exists public.announcements (
  id          uuid primary key default gen_random_uuid(),
  dept        text not null check (dept in ('general','construction','service','retail','hottubs')),
  title       text not null,
  body        text not null default '',
  author_id   uuid not null references public.employees(id),
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  archived_at timestamptz,
  archived_by uuid references public.employees(id)
);
create index if not exists announcements_dept on public.announcements(dept, created_at desc);

create table if not exists public.announcement_history (
  id        bigint generated always as identity primary key,
  ann_id    uuid not null references public.announcements(id),
  action    text not null,              -- posted, edited, archived, restored
  by_id     uuid references public.employees(id),
  at        timestamptz not null default now(),
  title     text,
  body      text
);
create index if not exists announcement_history_ann on public.announcement_history(ann_id, at);

alter table public.announcements        enable row level security;
alter table public.announcement_history enable row level security;
revoke all on public.announcements, public.announcement_history from anon, authenticated;

create or replace function public._ann_json(a public.announcements, me public.employees)
returns jsonb language sql stable security definer
set search_path to 'public', 'extensions' as $$
  select jsonb_build_object(
    'id', a.id, 'dept', a.dept, 'title', a.title, 'body', a.body,
    'author', (select name from public.employees where id = a.author_id),
    'created_at', a.created_at, 'edited_at', a.edited_at,
    'archived_at', a.archived_at, 'archived_by', (select name from public.employees where id = a.archived_by),
    'can_manage', coalesce(me.roles && array['Owner','Administrator']::text[], false))
$$;

create or replace function public._ann_check(p_title text, p_body text)
returns void language plpgsql immutable as $$
begin
  if btrim(coalesce(p_title, '')) = '' then raise exception 'Give the announcement a title.'; end if;
  if length(btrim(p_title)) > 120 then raise exception 'Keep the title under 120 characters.'; end if;
  if length(coalesce(p_body, '')) > 4000 then raise exception 'Keep the details under 4,000 characters.'; end if;
end $$;

create or replace function public.ann_list(p_token text, p_dept text, p_archived boolean default false)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare me public.employees := public._require_employee(p_token);
begin
  if coalesce(p_archived, false) then perform public._require_admin(p_token); end if;
  return coalesce((
    select jsonb_agg(public._ann_json(a, me) order by coalesce(a.archived_at, a.created_at) desc)
      from (select * from public.announcements
             where dept = p_dept and (archived_at is not null) = coalesce(p_archived, false)
             order by coalesce(archived_at, created_at) desc limit 200) a), '[]'::jsonb);
end $$;

create or replace function public.ann_add(p_token text, p_dept text, p_title text, p_body text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  a  public.announcements;
begin
  perform public._ann_check(p_title, p_body);
  insert into public.announcements (dept, title, body, author_id)
  values (p_dept, btrim(p_title), btrim(coalesce(p_body, '')), me.id) returning * into a;
  insert into public.announcement_history (ann_id, action, by_id, title, body) values (a.id, 'posted', me.id, a.title, a.body);
  return public._ann_json(a, me);
end $$;

create or replace function public.ann_edit(p_token text, p_id uuid, p_title text, p_body text)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  a  public.announcements;
begin
  perform public._ann_check(p_title, p_body);
  select * into a from public.announcements where id = p_id for update;
  if not found or a.archived_at is not null then raise exception 'That announcement was deleted. Refresh and try again.'; end if;
  if a.title = btrim(p_title) and a.body = btrim(coalesce(p_body, '')) then return public._ann_json(a, me); end if;
  update public.announcements set title = btrim(p_title), body = btrim(coalesce(p_body, '')), edited_at = now()
   where id = a.id returning * into a;
  insert into public.announcement_history (ann_id, action, by_id, title, body) values (a.id, 'edited', me.id, a.title, a.body);
  return public._ann_json(a, me);
end $$;

create or replace function public.ann_archive(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  a  public.announcements;
begin
  select * into a from public.announcements where id = p_id for update;
  if not found then raise exception 'That announcement was not found.'; end if;
  if a.archived_at is null then
    update public.announcements set archived_at = now(), archived_by = me.id where id = a.id returning * into a;
    insert into public.announcement_history (ann_id, action, by_id, title, body) values (a.id, 'archived', me.id, a.title, a.body);
  end if;
  return public._ann_json(a, me);
end $$;

create or replace function public.ann_restore(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  me public.employees := public._require_admin(p_token);
  a  public.announcements;
begin
  select * into a from public.announcements where id = p_id for update;
  if not found then raise exception 'That announcement was not found.'; end if;
  if a.archived_at is not null then
    update public.announcements set archived_at = null, archived_by = null where id = a.id returning * into a;
    insert into public.announcement_history (ann_id, action, by_id, title, body) values (a.id, 'restored', me.id, a.title, a.body);
  end if;
  return public._ann_json(a, me);
end $$;

create or replace function public.ann_history(p_token text, p_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public', 'extensions' as $$
begin
  perform public._require_admin(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object(
            'action', h.action, 'by', (select name from public.employees where id = h.by_id),
            'at', h.at, 'title', h.title, 'body', h.body) order by h.at)
           from public.announcement_history h where h.ann_id = p_id), '[]'::jsonb);
end $$;

revoke execute on function public._ann_json(public.announcements, public.employees),
  public._ann_check(text, text) from public, anon, authenticated;
grant execute on function public.ann_list(text, text, boolean), public.ann_add(text, text, text, text),
  public.ann_edit(text, uuid, text, text), public.ann_archive(text, uuid),
  public.ann_restore(text, uuid), public.ann_history(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
