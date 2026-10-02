-- wish. — my wishlist and gift lists for other people.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

create table if not exists public.wish_people (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.wish_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id   uuid references public.wish_people(id) on delete cascade,  -- null: my own wishlist
  name        text not null,
  url         text not null default '',
  price       numeric(10,2),
  priority    text check (priority in ('green','amber','red')),         -- green: really want; amber: would like; red: not fussed
  status      text not null default 'open' check (status in ('open','bought','given')),
  notes       text not null default '',
  image_url   text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists wish_items_user_person on public.wish_items (user_id, person_id);

do $$
declare t text;
begin
  foreach t in array array['wish_people','wish_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows: read"   on public.%I', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);
    execute format('create policy "own rows: read"   on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy "own rows: insert" on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows: update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows: delete" on public.%I for delete using (auth.uid() = user_id)', t);
    -- Same two-factor rule as every other hub table.
    execute format('drop policy if exists "require two-factor" on public.%I', t);
    execute format('create policy "require two-factor" on public.%I as restrictive for all to authenticated '
                   'using ((select auth.jwt() ->> ''aal'') = ''aal2'') with check ((select auth.jwt() ->> ''aal'') = ''aal2'')', t);
  end loop;
end $$;
