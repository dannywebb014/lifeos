-- client_errors — problems the apps hit in the browser, so they can be looked
-- at afterwards (shared/report.js). Crashes, anything an app logs as failed,
-- and every trip to the sign-in page with its reason.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

create table if not exists public.client_errors (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  app      text not null check (length(app) <= 40),
  page     text check (length(page) <= 300),
  kind     text not null check (kind in ('error', 'rejection', 'logged', 'signed-out')),
  message  text not null check (length(message) <= 1000),
  detail   text check (length(detail) <= 4000),
  happened timestamptz,               -- when it happened, if it waited to be sent
  online   boolean,
  agent    text check (length(agent) <= 300)
);
create index if not exists client_errors_at on public.client_errors (at desc);

alter table public.client_errors enable row level security;

-- Each person writes and reads only their own.
drop policy if exists "own rows: insert" on public.client_errors;
drop policy if exists "own rows: read"   on public.client_errors;
create policy "own rows: insert" on public.client_errors for insert with check (auth.uid() = user_id);
create policy "own rows: read"   on public.client_errors for select using (auth.uid() = user_id);

-- Same two-factor rule as every other hub table. Problems from before
-- signing in wait on the device and are sent after.
drop policy if exists "require two-factor" on public.client_errors;
create policy "require two-factor" on public.client_errors as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');

-- Kept for 30 days.
select cron.unschedule('client-errors-tidy') where exists (select 1 from cron.job where jobname = 'client-errors-tidy');
select cron.schedule('client-errors-tidy', '41 3 * * *', $$delete from public.client_errors where at < now() - interval '30 days'$$);
