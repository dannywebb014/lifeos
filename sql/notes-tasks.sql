-- notes: tasks written in notes. Each checklist line in a note is a row in
-- hub_tasks, so it shows in tasks., today. and the calendar like any other;
-- note_id is the note it was written in (the line holds the task's id).
-- Deleting a note for good leaves its tasks. Run once in the Supabase SQL
-- editor, after notes.sql and tasks.sql. Safe to run again.

alter table public.hub_tasks add column if not exists note_id uuid references public.notes(id) on delete set null;
create index if not exists hub_tasks_note on public.hub_tasks (note_id) where note_id is not null;
