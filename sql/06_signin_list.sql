-- ============================================================================
-- Icon Pools Team app: the sign-in list only shows people who have a PIN
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to run again.
--
-- Someone appears on the sign-in screen once an Owner or Administrator sets
-- their PIN in the Admin tab. Exception: during first-time setup (nobody has a
-- PIN yet), Owners are listed so they can create their own.
-- Everyone still appears in the Admin tab as before.
-- ============================================================================

create or replace function public.login_list()
returns jsonb language sql stable security definer
set search_path = public, extensions as $$
  with s as (
    select not exists (select 1 from public.employees where active and pin_hash is not null)
           as needs_setup)
  select jsonb_build_object(
    'needs_setup', s.needs_setup,
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'name', e.name, 'title', e.title,
               'has_pin', e.pin_hash is not null,
               'can_setup', s.needs_setup and 'Owner' = any(e.roles))
             order by lower(e.name))
        from public.employees e
       where e.active
         and (e.pin_hash is not null or (s.needs_setup and 'Owner' = any(e.roles)))), '[]'::jsonb))
  from s
$$;

notify pgrst, 'reload schema';
