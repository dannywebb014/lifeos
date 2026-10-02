-- week. — one row per person per week: the rating and answers from the weekly review.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

create table if not exists public.week_reviews (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  week_start  date not null,                      -- the Monday
  rating      smallint check (rating between 1 and 10),
  went_well   text not null default '',
  didnt       text not null default '',
  next_three  text not null default '',
  stats       jsonb not null default '{}',        -- the week's numbers, as shown when last saved
  updated_at  timestamptz not null default now(),
  primary key (user_id, week_start)
);

alter table public.week_reviews enable row level security;

drop policy if exists "own rows: read"   on public.week_reviews;
drop policy if exists "own rows: insert" on public.week_reviews;
drop policy if exists "own rows: update" on public.week_reviews;
drop policy if exists "own rows: delete" on public.week_reviews;
create policy "own rows: read"   on public.week_reviews for select using (auth.uid() = user_id);
create policy "own rows: insert" on public.week_reviews for insert with check (auth.uid() = user_id);
create policy "own rows: update" on public.week_reviews for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.week_reviews for delete using (auth.uid() = user_id);

-- Same two-factor rule as every other hub table (see food-hub/supabase/sql/require-two-factor.sql).
drop policy if exists "require two-factor" on public.week_reviews;
create policy "require two-factor" on public.week_reviews as restrictive for all to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2')
  with check ((select auth.jwt() ->> 'aal') = 'aal2');
