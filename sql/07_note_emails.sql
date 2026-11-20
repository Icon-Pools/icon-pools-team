-- ============================================================================
-- Icon Pools Team app: email every new pool note
-- Run in Supabase: SQL Editor > New query > paste > Run. Safe to run again.
-- Set up email/note-emails.gs in Google Apps Script first (it gives you the URL).
--
-- BEFORE RUNNING, fill in the two values in step 1:
--   * the Web app URL from Google Apps Script (ends in /exec)
--   * a secret word: any long random text, the SAME as the SECRET script
--     property in Apps Script. It stops anyone else from using the URL.
--
-- Only notes on a pool are emailed (not General notes), and only when first
-- posted (not edits or deletes). If emailing ever fails, the note still saves.
-- ============================================================================

-- ---------- step 1: your values (edit these two lines) ----------
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

insert into public.app_settings (key, value) values
  ('note_email_url',    'PASTE_THE_WEB_APP_URL_HERE'),
  ('note_email_secret', 'PASTE_THE_SECRET_WORD_HERE')
on conflict (key) do update set value = excluded.value
  where excluded.value not like 'PASTE_%';            -- re-running with placeholders keeps saved values

-- ---------- step 2: send each new pool note ----------
create extension if not exists pg_net;

create or replace function public._email_new_note()
returns trigger language plpgsql security definer
set search_path to 'public', 'extensions' as $$
declare
  v_url    text := (select value from public.app_settings where key = 'note_email_url');
  v_secret text := (select value from public.app_settings where key = 'note_email_secret');
begin
  if new.job_id is null then return new; end if;                    -- General notes: no email
  if v_url is null or v_url not like 'https://script.google.com/%' then return new; end if;
  begin
    perform net.http_post(
      url     := v_url,
      body    := jsonb_build_object(
                   'secret', v_secret,
                   'pool', coalesce(public._job_name(new.job_id), new.job_name),
                   'author', (select name from public.employees where id = new.author_id),
                   'body', new.body,
                   'created_at', new.created_at),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  exception when others then
    null;                                                            -- never block the note
  end;
  return new;
end $$;

revoke execute on function public._email_new_note() from public, anon, authenticated;

drop trigger if exists email_new_note on public.notes;
create trigger email_new_note after insert on public.notes
  for each row execute function public._email_new_note();
