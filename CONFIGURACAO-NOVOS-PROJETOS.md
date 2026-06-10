# Configuração dos novos projetos — SANEAR Operacional

## 1. Firebase Authentication

No Console Firebase do projeto `sanear-operacional-7e1d2`:

1. Abra **Authentication**.
2. Clique em **Começar**.
3. Em **Sign-in method**, habilite **E-mail/senha**.
4. Em **Users**, crie o primeiro usuário administrador.
5. Copie o UID criado.

## 2. Cloud Firestore

1. Abra **Firestore Database**.
2. Crie o banco no modo de produção.
3. Escolha a região apropriada.
4. Publique o arquivo `firestore.rules` pelo Firebase CLI ou copie seu conteúdo para a aba **Rules**.
5. Crie manualmente a coleção `usuarios_sistema`.
6. Use o UID do usuário administrador como ID do documento.

Campos do primeiro administrador:

- `uid`: string com o UID do Authentication
- `nome`: string com o nome do administrador
- `email`: string com o e-mail em letras minúsculas
- `role`: string exatamente `adm`
- `createdAt`: timestamp atual
- `createdBy`: string com o mesmo UID

As coleções `ordens_servico` e `ordensServico` serão criadas automaticamente ao cadastrar as primeiras ordens.

### Publicar regras com Firebase CLI

```bash
npm install -g firebase-tools
firebase login
firebase use --add sanear-operacional-7e1d2
firebase deploy --only firestore:rules,firestore:indexes
```

## 3. Supabase Storage

1. Abra o projeto Supabase `fajeqeldusbzncmhgyvk`.
2. Entre em **SQL Editor**.
3. Execute todo o conteúdo de `supabase-storage-policies.sql`.
4. Confirme em **Storage** que o bucket `os-arquivos` foi criado como público.

## 4. Teste local

```bash
npm install
npm run build
npm run dev
```

Acesse o endereço mostrado pelo Vite e entre com o administrador criado.

## 5. Vercel

Cadastre todas as variáveis do arquivo `.env.local` em:

**Project Settings -> Environment Variables**

Depois faça um novo deploy de produção.

## Observação de segurança do Storage

O aplicativo usa Firebase Authentication, mas envia fotos diretamente ao Supabase com a chave pública ANON. Assim, o Supabase não conhece o perfil Firebase do usuário. As políticas incluídas mantêm o funcionamento atual, mas permitem operações no bucket a quem tiver a chave pública. Para segurança institucional mais forte, o upload deve passar futuramente por uma API ou função de backend.
