-- app_state — whole-app data for apps that keep everything in one document:
-- train. (app = 'train') and breathe. (app = 'breathe').
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

create table if not exists public.app_state (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  app         text not null,
  data        jsonb not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (user_id, app)
);

alter table public.app_state enable row level security;

drop policy if exists "own rows: read"   on public.app_state;
drop policy if exists "own rows: insert" on public.app_state;
drop policy if exists "own rows: update" on public.app_state;
drop policy if exists "own rows: delete" on public.app_state;
create policy "own rows: read"   on public.app_state for select using (auth.uid() = user_id);
create policy "own rows: insert" on public.app_state for insert with check (auth.uid() = user_id);
create policy "own rows: update" on public.app_state for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.app_state for delete using (auth.uid() = user_id);

-- Same two-factor rule as every other hub table.
drop policy if exists "require two-factor" on public.app_state;
create policy "require two-factor" on public.app_state as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
