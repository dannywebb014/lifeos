-- notes: folders. A folder is a row in notes with kind 'folder' (its name is
-- the title); notes and folders sit in one through parent_id. Run once in the
-- Supabase SQL editor, after notes.sql. Safe to run again.

alter table public.notes add column if not exists kind text not null default 'page';
alter table public.notes drop constraint if exists notes_kind_check;
alter table public.notes add constraint notes_kind_check check (kind in ('page', 'folder'));
