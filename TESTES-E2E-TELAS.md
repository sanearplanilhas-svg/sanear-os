# Testes E2E de Telas com Playwright

Esses testes abrem o navegador de verdade e clicam no sistema. Eles servem para
validar login, menus, telas principais e, opcionalmente, cadastro real de OS.

## 1. Instalar dependencias

Na raiz do projeto:

O caminho recomendado e usar o script automatico:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-telas.ps1
```

Ele instala dependencias, garante o Playwright, baixa o navegador Chromium e roda os testes.

Depois que ja estiver tudo instalado, use `-SkipInstall` para rodar mais rapido:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-telas.ps1 -SkipInstall
```

## 2. Criar arquivo de ambiente dos testes

Copie:

```powershell
copy .env.e2e.example .env.e2e.local
```

Abra:

```powershell
notepad .env.e2e.local
```

Preencha com contas de teste:

```env
E2E_BASE_URL=http://127.0.0.1:5173

E2E_ADMIN_EMAIL=
E2E_ADMIN_PASSWORD=

E2E_OPERADOR_EMAIL=
E2E_OPERADOR_PASSWORD=

E2E_TERCEIRIZADA_EMAIL=
E2E_TERCEIRIZADA_PASSWORD=

E2E_ENABLE_WRITE_TESTS=false
```

Use contas de teste, não senha pessoal importante.

## 3. Rodar os testes de tela

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-telas.ps1
```

Para ver o navegador abrindo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-telas.ps1 -Headed
```

Para abrir a interface visual do Playwright:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-telas.ps1 -Ui
```

## 3.1. Atalhos novos

Teste rapido, sem reinstalar dependencias:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-rapido.ps1
```

Teste rapido mostrando o navegador:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-rapido.ps1 -Headed
```

Teste completo com cadastros reais temporarios:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-completo.ps1 -Headed -SkipInstall
```

Teste somente Nivel 2:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-nivel2.ps1 -Headed -SkipInstall
```

Teste somente Nivel 3, fluxo da terceirizada:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-nivel3.ps1 -Headed -SkipInstall
```

Teste somente Nivel 4 seguro, PDF da OS:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-nivel4.ps1 -Headed -SkipInstall
```

## 4. Testar cadastro real de OS

Por segurança, os testes que criam OS real ficam desligados.

Para ligar, altere no `.env.e2e.local`:

```env
E2E_ENABLE_WRITE_TESTS=true
```

Depois rode:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-telas.ps1 -WriteTests
```

Com `-WriteTests`, agora entram os testes de Nivel 2:

- valida modal de campos obrigatorios antes de gravar;
- cadastra OS temporaria de Calçamento;
- cadastra OS temporaria de Asfalto;
- cadastra OS temporaria de Caminhão Hidrojato;
- pesquisa cada OS criada na Lista de OS;
- testa bloqueio de cadastro duplicado;
- remove as OS temporarias pelo Firebase ao final.

Esses cadastros rodam com a conta admin configurada em `E2E_ADMIN_EMAIL` e
`E2E_ADMIN_PASSWORD`, porque no seu ambiente a conta operador pode nao ter o
formulario de cadastro liberado na interface.

Quando a tela pedir PDF primeiro, o teste clica automaticamente em
`Preencher manualmente` para liberar os campos antes de salvar.

Quando a tela avisar que falta `OS em PDF`, o teste clica em
`Continuar mesmo assim`, porque as OS criadas sao temporarias e servem apenas
para validar o fluxo de cadastro.

Se o formulario de cadastro nao aparecer para a conta usada, o teste de Nivel 2
fica como ignorado e mostra no terminal um resumo do texto visivel na tela. Isso
evita ficar travado esperando `Salvar OS` por 60 segundos.

Se o salvamento abrir um modal de erro, o teste agora mostra a mensagem real do
modal. Isso ajuda a diferenciar erro de permissao, duplicidade ou campo faltando.

As OS criadas usam prefixo `E2E-N2-`.

Para rodar somente o Nivel 2 durante ajustes:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-nivel2.ps1 -Headed -SkipInstall
```

## 5. Testar fluxo operacional da terceirizada

O Nivel 3 cria uma OS temporaria de Calçamento, entra com a conta terceirizada,
abre a OS na área da terceirizada, marca como `Aguardando SANEAR`, valida no
Firestore que o status mudou e depois clica em `SANEAR liberou (retomar)` para
voltar a OS para `ABERTA`.

Para rodar somente esse fluxo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-nivel3.ps1 -Headed -SkipInstall
```

Esse teste tambem remove a OS temporaria ao final.

## 6. Testar PDF da OS com upload real

O Nivel 4 seguro cria uma OS temporaria de Calçamento anexando um PDF pequeno
de teste. Ele valida no Firestore que o PDF ficou com status `OK`, confirma na
Lista de OS que o PDF anexado aparece e depois remove:

- o arquivo enviado ao Supabase;
- a OS temporaria no Firestore.

Para rodar somente esse fluxo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\teste-nivel4.ps1 -Headed -SkipInstall
```

Esse teste usa o arquivo:

```text
e2e/fixtures/e2e-nivel4-os.pdf
```

Se a limpeza do Supabase falhar, o erro mostra o caminho do arquivo para limpeza manual.

## O que ja esta coberto

- Tela de login.
- Modal "Esqueceu sua senha?".
- Modal "Solicitar acesso".
- Login admin.
- Navegacao admin por Dashboard, Lista de OS, Calçamento, Asfalto, Hidrojato,
  Serviço SANEAR, Terceirizada, Usuario e Backup.
- Login terceirizada e bloqueio visual dos menus que ela nao deve usar.
- Cadastro real de OS de Calçamento, Asfalto e Caminhão Hidrojato, quando habilitado.
- Validação de campos obrigatorios e duplicidade, quando habilitado.
- Fluxo operacional da terceirizada: Aguardando SANEAR e retomada, quando habilitado.
- Upload real de PDF pequeno, validação na Lista de OS e limpeza no Supabase, quando habilitado.

## Resultado dos testes

Se algum teste falhar, o Playwright salva:

- screenshot;
- video;
- trace para investigar clique a clique.

Abra o relatorio com:

```powershell
npx playwright show-report
```

O script tambem salva um resumo e um log completo em:

```text
test-results-resumos/
```

Os arquivos ficam com nomes parecidos com:

```text
resultado-testes-20260709-103000.txt
teste-telas-20260709-103000.log
```
