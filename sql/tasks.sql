-- hub_tasks — tasks kept in lifeOS itself, for anyone not using Craft or Todoist.
-- Each task belongs to a space: 'my', 'work' or 'joint'. A joint task carries
-- the food. household it was added in, and everyone in that household (the
-- household code in food.) can see, tick off and change it. Every other task
-- is private to the person who added it.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

create table if not exists public.hub_tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Set only on joint tasks shared with a household. Text, so it matches
  -- profiles.household_id whatever type that column is.
  household_id  text,
  space         text not null default 'my' check (space in ('my', 'work', 'joint')),
  text          text not null check (length(text) between 1 and 2000),
  date          date,
  done_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists hub_tasks_open_user on public.hub_tasks (user_id) where done_at is null;
create index if not exists hub_tasks_open_household on public.hub_tasks (household_id) where done_at is null;

-- The signed-in person's household, read past profiles' own row-level security
-- (which only ever shows them their own row anyway).
create or replace function public.my_household() returns text
  language sql stable security definer set search_path = public
  as $$ select household_id::text from public.profiles where id = auth.uid() $$;
revoke all on function public.my_household() from public;
grant execute on function public.my_household() to authenticated;

create or replace function public.hub_tasks_touch() returns trigger
  language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists hub_tasks_touch on public.hub_tasks;
create trigger hub_tasks_touch before update on public.hub_tasks
  for each row execute function public.hub_tasks_touch();

alter table public.hub_tasks enable row level security;

-- Yours (not shared), or shared with your household.
drop policy if exists "own or household: read"   on public.hub_tasks;
drop policy if exists "own or household: insert" on public.hub_tasks;
drop policy if exists "own or household: update" on public.hub_tasks;
drop policy if exists "own or household: delete" on public.hub_tasks;
create policy "own or household: read" on public.hub_tasks for select
  using ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()));
create policy "own or household: insert" on public.hub_tasks for insert
  with check (user_id = auth.uid() and (household_id is null or household_id = (select public.my_household())));
create policy "own or household: update" on public.hub_tasks for update
  using ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()))
  with check ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()));
create policy "own or household: delete" on public.hub_tasks for delete
  using ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()));

-- Same two-factor rule as every other hub table.
drop policy if exists "require two-factor" on public.hub_tasks;
create policy "require two-factor" on public.hub_tasks as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
