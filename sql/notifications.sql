-- Notifications: a reminder before each calendar event and time block.
--   - push_subscriptions: each device that turned notifications on (connections.)
--   - reminders: what to send and when. lifeOS and calendar. write the next
--     36 hours of events here (shared/reminders.js); the send-reminders
--     function sends what's due, once a minute.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.
-- The once-a-minute schedule is set up separately (notifications-cron.sql),
-- because it carries a secret.

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  device      text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.reminders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text not null,                 -- 'event' or 'test'
  source_key  text not null,                 -- e.g. event:<id>:<start>, so a reminder is made once
  title       text not null,
  body        text not null default '',
  url         text not null default '/lifeos/',
  fire_at     timestamptz not null,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, source_key)
);
create index if not exists reminders_due on public.reminders (fire_at) where sent_at is null;

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'reminders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows: read" on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);
    execute format('create policy "own rows: read" on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy "own rows: insert" on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows: update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows: delete" on public.%I for delete using (auth.uid() = user_id)', t);
    execute format('drop policy if exists "require two-factor" on public.%I', t);
    execute format('create policy "require two-factor" on public.%I as restrictive for all to authenticated '
      'using ((select auth.jwt() ->> ''aal'') = ''aal2'') with check ((select auth.jwt() ->> ''aal'') = ''aal2'')', t);
  end loop;
end $$;

-- Sent reminders are only kept a week.
create or replace function public.reminders_tidy() returns void language sql as $$
  delete from public.reminders where coalesce(sent_at, fire_at) < now() - interval '7 days';
$$;

create extension if not exists pg_cron;
create extension if not exists pg_net;
