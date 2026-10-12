-- notes: your own spaces. Beside my, work and joint, notes. lets you add
-- spaces (Settings in notes.), named per person in app_state (app 'notes').
-- A space is kept on each note by a short id, so this lets it be any such id.
-- Spaces you add are private (only joint is shared with the household).
-- Run once in the Supabase SQL editor, after notes.sql. Safe to run again.

alter table public.notes drop constraint if exists notes_space_check;
alter table public.notes add constraint notes_space_check check (space ~ '^[a-z][a-z0-9_]{0,39}$');
