-- Correção para o Nível 4 seguro dos testes E2E.
-- Execute no Supabase: SQL Editor -> New query -> cole tudo -> Run.
-- Objetivo: permitir upload/leitura/exclusão de ZIP/PDF/imagens no bucket os-arquivos.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'os-arquivos',
  'os-arquivos',
  true,
  31457280,
  array[
    'application/zip',
    'application/x-zip-compressed',
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/heic',
    'image/heif'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "SANEAR anon pode listar imagens" on storage.objects;
drop policy if exists "SANEAR anon pode enviar imagens" on storage.objects;
drop policy if exists "SANEAR anon pode substituir imagens" on storage.objects;
drop policy if exists "SANEAR anon pode excluir imagens" on storage.objects;
drop policy if exists "SANEAR anon pode listar arquivos operacionais" on storage.objects;
drop policy if exists "SANEAR anon pode enviar arquivos operacionais" on storage.objects;
drop policy if exists "SANEAR anon pode substituir arquivos operacionais" on storage.objects;
drop policy if exists "SANEAR anon pode excluir arquivos operacionais" on storage.objects;

create policy "SANEAR anon pode listar arquivos operacionais"
on storage.objects
for select
to anon
using (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua', 'hidrojato')
);

create policy "SANEAR anon pode enviar arquivos operacionais"
on storage.objects
for insert
to anon
with check (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua', 'hidrojato')
  and lower(storage.extension(name)) in ('zip', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif')
);

create policy "SANEAR anon pode excluir arquivos operacionais"
on storage.objects
for delete
to anon
using (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua', 'hidrojato')
);
