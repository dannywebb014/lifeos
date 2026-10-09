-- Accounts for anyone: household invites, leaving a household, deleting an account.
--
-- Until now a household's code was its id, and anyone could point their own
-- profile at any household id. Fine for two people who trust each other, not
-- once strangers can sign up. Now:
--   * joining takes an invite: a short code made by someone in the household,
--     good for one person within 7 days (create_invite / join_household)
--   * nobody can set their own household_id, and signing up can't pick one
--   * leave_household and delete_my_account tidy up shared things properly
-- Every function here needs a two-factor (aal2) session, like the tables.
-- Run once in the Supabase SQL editor (project myhub.). Safe to run again.

-- ── Lock down profiles and households ───────────────────────────────────
-- A profile's household only changes through the functions below; people
-- can still rename themselves. Households can be renamed, not made or removed.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;
revoke insert, update, delete on public.households from anon, authenticated;
grant update (name) on public.households to authenticated;

-- Every new account gets a household of its own. What a sign-up sends
-- (raw_user_meta_data) is up to whoever signs up, so a household_id there is
-- ignored: joining someone else's takes an invite.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  hid uuid := gen_random_uuid();
begin
  insert into public.households (id, name) values (hid, 'My Household');
  insert into public.profiles (id, display_name, household_id)
    values (new.id, nullif(trim(new.raw_user_meta_data->>'display_name'), ''), hid);
  return new;
end $$;

-- ── Invites ─────────────────────────────────────────────────────────────
create table if not exists public.household_invites (
  code          text primary key,
  household_id  uuid not null references public.households(id) on delete cascade,
  created_by    uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  used_by       uuid references auth.users(id) on delete set null,
  used_at       timestamptz
);
alter table public.household_invites enable row level security;
-- Everyone in a household sees its invites; making, using and cancelling them
-- goes through the functions.
drop policy if exists "household: read" on public.household_invites;
create policy "household: read" on public.household_invites for select
  using (household_id::text = (select public.my_household()));
drop policy if exists "require two-factor" on public.household_invites;
create policy "require two-factor" on public.household_invites as restrictive for all
  using ((select auth.jwt() ->> 'aal') = 'aal2') with check ((select auth.jwt() ->> 'aal') = 'aal2');
revoke insert, update, delete on public.household_invites from anon, authenticated;

create or replace function public.require_aal2() returns uuid
  language plpgsql stable as $$
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Two-factor sign-in needed' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- A new invite to the caller's household, as an 8-character code like
-- K7PM4QXR (no 0/O, 1/I/L). At most 10 open at once.
create or replace function public.create_invite() returns text
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
  hid uuid := (select household_id from profiles where id = me);
  letters text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  c text;
begin
  if (select count(*) from household_invites where household_id = hid and used_at is null and expires_at > now()) >= 10 then
    raise exception 'Too many open invites. Cancel one first.';
  end if;
  loop
    c := '';
    for i in 1..8 loop
      c := c || substr(letters, 1 + floor(random() * length(letters))::int, 1);
    end loop;
    begin
      insert into household_invites (code, household_id, created_by) values (c, hid, me);
      return c;
    exception when unique_violation then -- vanishingly rare: try another
    end;
  end loop;
end $$;

-- Typed codes are forgiving: any case, spaces and dashes ignored.
create or replace function public.clean_invite(code text) returns text
  language sql immutable as $$ select upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- What an invite is for, before accepting it: who sent it, and whether it
-- can still be used. Nothing is returned for a code that doesn't exist.
create or replace function public.invite_info(code text) returns table (
  inviter text, household_name text, members int, usable boolean, already_in boolean
) language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
  inv household_invites;
begin
  select * into inv from household_invites i where i.code = public.clean_invite(invite_info.code);
  if not found then return; end if;
  return query select
    coalesce(p.display_name, u.email)::text,
    h.name,
    (select count(*)::int from profiles x where x.household_id = inv.household_id),
    inv.used_at is null and inv.expires_at > now(),
    (select household_id from profiles where id = me) = inv.household_id
  from households h
  left join profiles p on p.id = inv.created_by
  left join auth.users u on u.id = inv.created_by
  where h.id = inv.household_id;
end $$;

-- Someone (other than me) still in a household, to hand my joint tasks to.
create or replace function public.household_heir(hid uuid, me uuid) returns uuid
  language sql stable security definer set search_path = public as $$
  select id from profiles where household_id = hid and id <> me order by created_at limit 1 $$;

-- Moving out of a household: my joint tasks stay with the people still in
-- it, and a household nobody is left in is deleted along with its food.
create or replace function public.move_out(me uuid, old_hid uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  heir uuid := public.household_heir(old_hid, me);
begin
  if old_hid is null then return; end if;
  if heir is null then
    delete from hub_tasks where household_id = old_hid::text;
    delete from households where id = old_hid;
  else
    update hub_tasks set user_id = heir where household_id = old_hid::text and user_id = me;
  end if;
end $$;

-- Accept an invite: the caller moves into its household. Returns the
-- household id. Their old household's food goes if nobody else is in it,
-- so the app warns first (invite_info + my_household_size).
create or replace function public.join_household(code text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
  inv household_invites;
  old_hid uuid := (select household_id from profiles where id = me);
begin
  select * into inv from household_invites i where i.code = public.clean_invite(join_household.code) for update;
  if not found or inv.used_at is not null or inv.expires_at <= now() then
    raise exception 'That invite code isn''t valid. It may have been used or be more than 7 days old.';
  end if;
  if old_hid = inv.household_id then return old_hid; end if;
  update household_invites set used_by = me, used_at = now() where household_invites.code = inv.code;
  update profiles set household_id = inv.household_id where id = me;
  perform public.move_out(me, old_hid);
  return inv.household_id;
end $$;

-- Leave a household others are still in, for a new empty one of your own.
create or replace function public.leave_household() returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
  old_hid uuid := (select household_id from profiles where id = me);
  hid uuid := gen_random_uuid();
begin
  if public.household_heir(old_hid, me) is null then
    raise exception 'You''re the only one in this household.';
  end if;
  insert into households (id, name) values (hid, 'My Household');
  update profiles set household_id = hid where id = me;
  perform public.move_out(me, old_hid);
  return hid;
end $$;

-- For someone with no household at all (accounts made before households
-- were automatic): start one.
create or replace function public.start_household() returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
  hid uuid := (select household_id from profiles where id = me);
begin
  if hid is not null then return hid; end if;
  hid := gen_random_uuid();
  insert into households (id, name) values (hid, 'My Household');
  insert into profiles (id, household_id) values (me, hid)
    on conflict (id) do update set household_id = excluded.household_id;
  return hid;
end $$;

-- Who's in my household: name and email, me first.
create or replace function public.household_members() returns table (
  id uuid, name text, email text, is_me boolean, joined timestamptz
) language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
begin
  return query
    select p.id, p.display_name, u.email::text, p.id = me, p.created_at
    from profiles p join auth.users u on u.id = p.id
    where p.household_id = (select household_id from profiles where profiles.id = me)
    order by p.id = me desc, p.created_at;
end $$;

-- How much is in my household, for the warning before joining another.
create or replace function public.my_household_size() returns table (members int, recipes int)
  language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
  hid uuid := (select household_id from profiles where id = me);
begin
  return query select
    (select count(*)::int from profiles where household_id = hid),
    (select count(*)::int from recipes where household_id = hid);
end $$;

create or replace function public.cancel_invite(code text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.require_aal2();
begin
  delete from household_invites i
   where i.code = public.clean_invite(cancel_invite.code) and i.used_at is null
     and i.household_id = (select household_id from profiles where id = me);
end $$;

-- ── Delete my account ───────────────────────────────────────────────────
-- Everything personal goes with the account (every table's user_id cascades).
-- Shared things: joint tasks pass to someone still in the household, and a
-- household with nobody left is deleted with its recipes, plan and list.
-- Recipe photos stay in storage (not linked to a household); tidy by hand.
create or replace function public.delete_my_account() returns void
  language plpgsql security definer set search_path = public, auth as $$
declare
  me uuid := public.require_aal2();
  hid uuid := (select household_id from profiles where id = me);
begin
  perform public.move_out(me, hid);
  delete from auth.users where id = me;
end $$;

-- Only signed-in people may call these (and they check for two-factor).
do $$
declare f text;
begin
  foreach f in array array[
    'create_invite()', 'invite_info(text)', 'join_household(text)', 'leave_household()',
    'start_household()', 'household_members()', 'my_household_size()', 'cancel_invite(text)',
    'delete_my_account()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Helpers used inside the functions above, not called directly.
  foreach f in array array['household_heir(uuid, uuid)', 'move_out(uuid, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
