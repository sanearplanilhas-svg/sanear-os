param(
  [switch]$Headed,
  [switch]$Ui,
  [switch]$WriteTests,
  [switch]$SkipInstall,
  [switch]$Nivel2,
  [switch]$Nivel3,
  [switch]$Nivel4,
  [switch]$Nivel5,
  [switch]$OpenReport
)

$ErrorActionPreference = "Stop"

function Write-Title($Text) {
  Write-Host ""
  Write-Host "==== $Text ====" -ForegroundColor Cyan
}

function Get-NpmCommand {
  $npmCmd = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
  if ($npmCmd) {
    return $npmCmd.Source
  }

  $npm = Get-Command "npm" -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  throw "npm nao encontrado no PATH. Instale o Node.js antes de rodar os testes."
}

function Get-NpxCommand {
  $npxCmd = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if ($npxCmd) {
    return $npxCmd.Source
  }

  $npx = Get-Command "npx" -ErrorAction SilentlyContinue
  if ($npx) {
    return $npx.Source
  }

  throw "npx nao encontrado no PATH. Instale o Node.js antes de rodar os testes."
}

if (-not (Test-Path "package.json")) {
  throw "Execute este script na raiz do projeto, onde existe package.json."
}

if (-not (Test-Path ".env.e2e.example")) {
  throw "Arquivo .env.e2e.example nao encontrado. Copie os arquivos de teste para a raiz do projeto."
}

if (-not (Test-Path ".env.e2e.local")) {
  Write-Host "Arquivo .env.e2e.local nao encontrado." -ForegroundColor Yellow
  Write-Host "Criando a partir de .env.e2e.example..."
  Copy-Item ".env.e2e.example" ".env.e2e.local"
  Write-Host "Preencha o arquivo .env.e2e.local e rode o script novamente." -ForegroundColor Yellow
  notepad ".env.e2e.local"
  exit 1
}

$npm = Get-NpmCommand
$npx = Get-NpxCommand

if ($Nivel2 -or $Nivel3 -or $Nivel4 -or $Nivel5) {
  $WriteTests = $true
}

if ((@($Nivel2, $Nivel3, $Nivel4, $Nivel5) | Where-Object { $_ }).Count -gt 1) {
  throw "Use apenas um filtro por vez: -Nivel2, -Nivel3, -Nivel4 ou -Nivel5."
}

if ($WriteTests) {
  $env:E2E_ENABLE_WRITE_TESTS = "true"
}

if ($SkipInstall) {
  Write-Title "Instalacao ignorada"
  Write-Host "Pulando npm install, Playwright e instalacao do Chromium por causa de -SkipInstall."
} else {
  Write-Title "Instalando dependencias"
  & $npm install
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  Write-Title "Garantindo Playwright"
  & $npm install --save-dev "@playwright/test"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  Write-Title "Instalando navegador do Playwright"
  & $npx playwright install chromium
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Write-Title "Rodando testes de tela"
$startedAt = Get-Date
$summaryDir = "test-results-resumos"
New-Item -ItemType Directory -Force -Path $summaryDir | Out-Null
$stamp = $startedAt.ToString("yyyyMMdd-HHmmss")
$logPath = Join-Path $summaryDir "teste-telas-$stamp.log"
$summaryPath = Join-Path $summaryDir "resultado-testes-$stamp.txt"

$playwrightArgs = @("playwright", "test")

if ($Nivel2) {
  if (-not (Test-Path "e2e/level2-crud.spec.ts")) {
    throw "Arquivo e2e/level2-crud.spec.ts nao encontrado. Copie o pacote do Nivel 2 antes de rodar -Nivel2."
  }
  $playwrightArgs += "e2e/level2-crud.spec.ts"
  $playwrightArgs += "--project=chromium-desktop"
}

if ($Nivel3) {
  if (-not (Test-Path "e2e/level3-terceirizada.spec.ts")) {
    throw "Arquivo e2e/level3-terceirizada.spec.ts nao encontrado. Copie o pacote do Nivel 3 antes de rodar -Nivel3."
  }
  $playwrightArgs += "e2e/level3-terceirizada.spec.ts"
  $playwrightArgs += "--project=chromium-desktop"
}

if ($Nivel4) {
  if (-not (Test-Path "e2e/level4-anexos.spec.ts")) {
    throw "Arquivo e2e/level4-anexos.spec.ts nao encontrado. Copie o pacote do Nivel 4 antes de rodar -Nivel4."
  }
  if (-not (Test-Path "e2e/fixtures/e2e-nivel4-os.pdf")) {
    throw "Arquivo e2e/fixtures/e2e-nivel4-os.pdf nao encontrado. Copie o pacote do Nivel 4 completo antes de rodar -Nivel4."
  }
  $playwrightArgs += "e2e/level4-anexos.spec.ts"
  $playwrightArgs += "--project=chromium-desktop"
}


if ($Nivel5) {
  if (-not (Test-Path "e2e/level5-fotos-finalizacao.spec.ts")) {
    throw "Arquivo e2e/level5-fotos-finalizacao.spec.ts nao encontrado. Copie o pacote do Nivel 5 antes de rodar -Nivel5."
  }
  if (-not (Test-Path "e2e/fixtures/e2e-nivel5-foto-1.png")) {
    throw "Arquivos e2e/fixtures/e2e-nivel5-foto-*.png nao encontrados. Copie o pacote do Nivel 5 completo antes de rodar -Nivel5."
  }
  $playwrightArgs += "e2e/level5-fotos-finalizacao.spec.ts"
  $playwrightArgs += "--project=chromium-desktop"
}

if ($Ui) {
  $playwrightArgs += "--ui"
} elseif ($Headed) {
  $playwrightArgs += "--headed"
}

Write-Host "Comando: npx $($playwrightArgs -join ' ')" -ForegroundColor DarkGray
& $npx @playwrightArgs 2>&1 | Tee-Object -FilePath $logPath
$exitCode = $LASTEXITCODE
$finishedAt = Get-Date

$logText = ""
if (Test-Path $logPath) {
  $logText = Get-Content $logPath -Raw
}

function Get-LastCount($Text, $Word) {
  $matches = [regex]::Matches($Text, "(\d+)\s+$Word")
  if ($matches.Count -eq 0) {
    return 0
  }
  return [int]$matches[$matches.Count - 1].Groups[1].Value
}

$passed = Get-LastCount $logText "passed"
$failed = Get-LastCount $logText "failed"
$skipped = Get-LastCount $logText "skipped"
$duration = New-TimeSpan -Start $startedAt -End $finishedAt
$status = if ($exitCode -eq 0) { "PASSOU" } else { "FALHOU" }

$summary = @"
Resultado dos Testes E2E

Status: $status
Inicio: $($startedAt.ToString("dd/MM/yyyy HH:mm:ss"))
Fim:    $($finishedAt.ToString("dd/MM/yyyy HH:mm:ss"))
Tempo:  $($duration.ToString("hh\:mm\:ss"))

Passou:   $passed
Falhou:   $failed
Ignorado: $skipped

WriteTests:  $WriteTests
Nivel2:      $Nivel2
Nivel3:      $Nivel3
Nivel4:      $Nivel4
Nivel5:      $Nivel5
Headed:      $Headed
Ui:          $Ui
SkipInstall: $SkipInstall

Log completo:
$logPath

Relatorio HTML:
playwright-report/index.html
"@

$summary | Set-Content -Path $summaryPath -Encoding UTF8

Write-Title "Resumo"
Write-Host $summary

if ($OpenReport -and (Test-Path "playwright-report")) {
  & $npx playwright show-report
}

exit $exitCode
