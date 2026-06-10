-- Execute este arquivo no Supabase:
-- SQL Editor -> New query -> cole tudo -> Run.
--
-- O frontend atual autentica usuários pelo Firebase, não pelo Supabase.
-- Por isso, estas políticas liberam o bucket para a chave ANON usada pelo app.
-- O bucket fica público para que getPublicUrl() continue funcionando.

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
  15728640,
  array[
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

-- Remove versões anteriores com os mesmos nomes, caso o script seja executado novamente.
drop policy if exists "SANEAR anon pode listar imagens" on storage.objects;
drop policy if exists "SANEAR anon pode enviar imagens" on storage.objects;
drop policy if exists "SANEAR anon pode substituir imagens" on storage.objects;
drop policy if exists "SANEAR anon pode excluir imagens" on storage.objects;

create policy "SANEAR anon pode listar imagens"
on storage.objects
for select
to anon
using (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua')
);

create policy "SANEAR anon pode enviar imagens"
on storage.objects
for insert
to anon
with check (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua')
);

create policy "SANEAR anon pode substituir imagens"
on storage.objects
for update
to anon
using (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua')
)
with check (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua')
);

create policy "SANEAR anon pode excluir imagens"
on storage.objects
for delete
to anon
using (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua')
);
