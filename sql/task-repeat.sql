-- Repeating tasks kept in lifeOS, and a log of every tick.
--   - hub_tasks.repeat: the rule (shared/repeat.js), e.g.
--       {"every":1,"unit":"week","days":[1],"anchor":"2026-10-13","text":"every Monday"}
--     Ticking a repeating task moves it to its next date instead of closing it.
--   - hub_task_done: one row per tick, repeating or not, so week. can count
--     them (a repeating task never gets a done_at of its own).
-- Run once in the Supabase SQL editor (project myhub.), after tasks.sql. Safe to run again.

alter table public.hub_tasks add column if not exists repeat jsonb;

create table if not exists public.hub_task_done (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.hub_tasks(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  household_id  text,
  done_at       timestamptz not null default now()
);
create index if not exists hub_task_done_when on public.hub_task_done (user_id, done_at);

alter table public.hub_task_done enable row level security;

-- Your ticks, and ticks on tasks shared with your household.
drop policy if exists "own or household: read"   on public.hub_task_done;
drop policy if exists "own: insert"              on public.hub_task_done;
drop policy if exists "own: delete"              on public.hub_task_done;
create policy "own or household: read" on public.hub_task_done for select
  using (user_id = auth.uid() or household_id = (select public.my_household()));
create policy "own: insert" on public.hub_task_done for insert
  with check (user_id = auth.uid() and (household_id is null or household_id = (select public.my_household())));
create policy "own: delete" on public.hub_task_done for delete using (user_id = auth.uid());

drop policy if exists "require two-factor" on public.hub_task_done;
create policy "require two-factor" on public.hub_task_done as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');

-- Ticks made before the log existed.
insert into public.hub_task_done (task_id, user_id, household_id, done_at)
select t.id, t.user_id, t.household_id, t.done_at
  from public.hub_tasks t
 where t.done_at is not null
   and not exists (select 1 from public.hub_task_done d where d.task_id = t.id);
