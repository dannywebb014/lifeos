-- Task priority: the traffic light on tasks. and calendar.
-- 0 none, 1 low (green), 2 medium (amber), 3 high (red).
--   - Tasks kept in lifeOS carry it in hub_tasks.priority.
--   - Todoist has its own priority, which is used as it is (p1 red, p2 amber, p3 green).
--   - Craft has no priority, so a Craft task's light is kept here, in
--     task_priorities, private to the person who set it.
-- Run once in the Supabase SQL editor (project myhub.), after tasks.sql. Safe to run again.

alter table public.hub_tasks add column if not exists priority smallint not null default 0
  check (priority between 0 and 3);

create table if not exists public.task_priorities (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- "craft:<space>:<task id>"
  task_key    text not null check (length(task_key) <= 300),
  priority    smallint not null check (priority between 1 and 3),
  updated_at  timestamptz not null default now(),
  primary key (user_id, task_key)
);

alter table public.task_priorities enable row level security;

drop policy if exists "own rows: read"   on public.task_priorities;
drop policy if exists "own rows: insert" on public.task_priorities;
drop policy if exists "own rows: update" on public.task_priorities;
drop policy if exists "own rows: delete" on public.task_priorities;
create policy "own rows: read"   on public.task_priorities for select using (auth.uid() = user_id);
create policy "own rows: insert" on public.task_priorities for insert with check (auth.uid() = user_id);
create policy "own rows: update" on public.task_priorities for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.task_priorities for delete using (auth.uid() = user_id);

-- Same two-factor rule as every other hub table.
drop policy if exists "require two-factor" on public.task_priorities;
create policy "require two-factor" on public.task_priorities as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
