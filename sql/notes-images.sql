-- notes: pictures in notes (stage 7). A private bucket, note-images, where
-- each picture is <user id>/<note id>/<random name>. You can add pictures to
-- a note you can see, in your own folder, and see the pictures of any note
-- you can see, so a joint note's pictures show for the household. Only the
-- person who added a picture can delete it. Like notes, it needs two-factor
-- sign-in. Run once in the Supabase SQL editor, after notes.sql. Safe to run
-- again.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 10485760, array['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "note images: read" on storage.objects;
create policy "note images: read" on storage.objects for select to authenticated
  using (bucket_id = 'note-images'
    and (select auth.jwt() ->> 'aal') = 'aal2'
    and exists (select 1 from public.notes n where n.id::text = (storage.foldername(name))[2]));

drop policy if exists "note images: add" on storage.objects;
create policy "note images: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'note-images'
    and (select auth.jwt() ->> 'aal') = 'aal2'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.notes n where n.id::text = (storage.foldername(name))[2]));

drop policy if exists "note images: delete" on storage.objects;
create policy "note images: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'note-images'
    and (select auth.jwt() ->> 'aal') = 'aal2'
    and (storage.foldername(name))[1] = (select auth.uid())::text);
