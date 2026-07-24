# Testes Pós-Deploy

Este projeto possui um script PowerShell para validar rapidamente os pontos mais
importantes depois de alterar regras, publicar no Firebase ou mexer em
permissões.

## 1. Criar arquivo de contas de teste

Copie:

```powershell
copy .env.test.example .env.test.local
```

Preencha o `.env.test.local` com contas de teste:

```env
TEST_ADMIN_EMAIL=
TEST_ADMIN_PASSWORD=

TEST_OPERADOR_EMAIL=
TEST_OPERADOR_PASSWORD=

TEST_TERCEIRIZADA_EMAIL=
TEST_TERCEIRIZADA_PASSWORD=
```

Use contas de teste. Não coloque senha pessoal importante nesse arquivo.

## 2. Rodar o teste completo

Na raiz do projeto:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-pos-deploy.ps1
```

## O que o script testa

- Variáveis obrigatórias do Firebase no `.env.local`.
- `npm run lint`, se o npm estiver disponível.
- `npm run build`, se o npm estiver disponível.
- Login das contas de teste no Firebase Auth.
- Admin lendo seu perfil em `usuarios_sistema`.
- Operador criando uma OS temporária.
- Terceirizada sendo bloqueada ao tentar criar OS.
- Terceirizada conseguindo alterar apenas campo operacional permitido.
- Terceirizada sendo bloqueada ao tentar alterar campo cadastral.
- Operador sendo bloqueado ao tentar excluir OS.
- Admin excluindo a OS temporária criada pelo teste.
- Upload e remoção de uma imagem temporária no Supabase Storage.

## Opções úteis

Ignorar build/lint:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-pos-deploy.ps1 -SkipNpm
```

Ignorar Supabase:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-pos-deploy.ps1 -SkipSupabase
```

Informar projeto manualmente:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-pos-deploy.ps1 -ProjectId sanear-operacional-7e1d2
```

## Observação

O teste do Supabase usa a política atual de upload direto pelo frontend. Se você
migrar para o modelo de produção com API/Cloud Function, esse teste deverá ser
adaptado para chamar a API protegida.
