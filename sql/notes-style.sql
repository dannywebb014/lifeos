-- notes: page styles. A note's look, chosen in notes. (Style): its page
-- colour and the backdrop behind it, as { "card": "<preset>", "backdrop":
-- "<preset>" } (names from STYLES in lifeos/notes/embed.js). Run once in the
-- Supabase SQL editor, after notes.sql. Safe to run again.

alter table public.notes add column if not exists style jsonb;
