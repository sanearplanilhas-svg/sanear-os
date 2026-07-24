-- Execute este arquivo no Supabase:
-- SQL Editor -> New query -> cole tudo -> Run.
--
-- IMPORTANTE:
-- O frontend autentica usuários pelo Firebase, não pelo Supabase.
-- Por isso, ainda existe acesso pela chave ANON usada pelo app.
-- Esta versão reduz o risco removendo a permissão de SUBSTITUIR arquivos.
--
-- Regra prática deste passo:
-- 1. O app pode ENVIAR arquivos novos.
-- 2. O app pode LER arquivos das pastas operacionais.
-- 3. O app ainda pode EXCLUIR arquivos porque o backup/limpeza atual depende disso.
-- 4. O app NÃO pode mais SOBRESCREVER arquivos existentes.
--
-- Para segurança máxima em produção, a exclusão deve ir para uma API/Cloud Function
-- protegida por Firebase Auth + role adm/admin no Firestore.

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

-- Remove versões anteriores com os mesmos nomes, caso o script seja executado novamente.
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

-- ATENÇÃO:
-- Não existe mais policy de UPDATE.
-- Isso impede sobrescrever um arquivo já existente no bucket.
-- O app também foi ajustado para usar upsert: false em todos os uploads.

create policy "SANEAR anon pode excluir arquivos operacionais"
on storage.objects
for delete
to anon
using (
  bucket_id = 'os-arquivos'
  and (storage.foldername(name))[1] in ('asfalto', 'calcamento', 'buraco-rua', 'hidrojato')
);
