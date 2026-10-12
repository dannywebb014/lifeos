-- notes — pages kept by notes. (lifeos/notes/). Each note belongs to a space,
-- 'my', 'work' or 'joint', as tasks do. A joint note carries the food.
-- household it was written in, and everyone in that household can read and
-- change it. Every other note is private to the person who wrote it.
-- Deleted notes wait in the bin (deleted_at) for 30 days, then a nightly job
-- removes them.
-- Run once in the Supabase SQL editor (project myhub.), after tasks.sql (it
-- uses my_household()). Safe to run again.

create table if not exists public.notes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Set only on joint notes shared with a household (text, as in hub_tasks).
  household_id  text,
  space         text not null default 'my' check (space in ('my', 'work', 'joint')),
  -- Pages inside pages (stage 2): the page this one sits under, and its place
  -- among its siblings.
  parent_id     uuid references public.notes(id) on delete set null,
  position      text,
  title         text not null default '' check (length(title) <= 500),
  -- The editor's content (TipTap JSON), and the same as plain text for search.
  body          jsonb not null default '{"type":"doc","content":[]}'::jsonb,
  body_text     text not null default '' check (length(body_text) <= 500000),
  -- Daily notes (stage 3): the day this note is for.
  day           date,
  pinned        boolean not null default false,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists notes_user on public.notes (user_id, updated_at desc);
create index if not exists notes_household on public.notes (household_id, updated_at desc) where household_id is not null;
create index if not exists notes_parent on public.notes (parent_id) where parent_id is not null;
-- One daily note per person per day.
create unique index if not exists notes_one_per_day on public.notes (user_id, day) where day is not null and deleted_at is null;

-- updated_at is how the app spots that another device saved first: it only
-- saves over the version it opened (see lifeos/notes/embed.js).
create or replace function public.notes_touch() returns trigger
  language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before update on public.notes
  for each row execute function public.notes_touch();

alter table public.notes enable row level security;

-- Yours (not shared), or shared with your household. Same rules as hub_tasks.
drop policy if exists "own or household: read"   on public.notes;
drop policy if exists "own or household: insert" on public.notes;
drop policy if exists "own or household: update" on public.notes;
drop policy if exists "own or household: delete" on public.notes;
create policy "own or household: read" on public.notes for select
  using ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()));
create policy "own or household: insert" on public.notes for insert
  with check (user_id = auth.uid() and (household_id is null or household_id = (select public.my_household())));
create policy "own or household: update" on public.notes for update
  using ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()))
  with check ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()));
create policy "own or household: delete" on public.notes for delete
  using ((household_id is null and user_id = auth.uid()) or household_id = (select public.my_household()));

-- Same two-factor rule as every other hub table.
drop policy if exists "require two-factor" on public.notes;
create policy "require two-factor" on public.notes as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');

-- Empty the bin of anything deleted more than 30 days ago, every night.
select cron.unschedule('notes-bin-tidy') where exists (select 1 from cron.job where jobname = 'notes-bin-tidy');
select cron.schedule('notes-bin-tidy', '47 3 * * *', $$delete from public.notes where deleted_at < now() - interval '30 days'$$);
