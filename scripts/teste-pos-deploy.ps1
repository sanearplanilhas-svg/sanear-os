param(
  [string]$ProjectId = "",
  [string]$EnvFile = ".env.local",
  [string]$TestEnvFile = ".env.test.local",
  [switch]$SkipNpm,
  [switch]$SkipSupabase
)

$ErrorActionPreference = "Stop"

$script:Passed = 0
$script:Failed = 0
$script:Skipped = 0

function Write-Title($Text) {
  Write-Host ""
  Write-Host "==== $Text ====" -ForegroundColor Cyan
}

function Pass($Text) {
  $script:Passed++
  Write-Host "[OK] $Text" -ForegroundColor Green
}

function Fail($Text) {
  $script:Failed++
  Write-Host "[ERRO] $Text" -ForegroundColor Red
}

function Skip($Text) {
  $script:Skipped++
  Write-Host "[IGNORADO] $Text" -ForegroundColor Yellow
}

function Load-DotEnv($Path) {
  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }

    $idx = $line.IndexOf("=")
    if ($idx -le 0) {
      return
    }

    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    $value = $value.Trim('"').Trim("'")
    $values[$key] = $value
  }

  return $values
}

function Require-Value($Map, $Key, $Label) {
  if (-not $Map.ContainsKey($Key) -or [string]::IsNullOrWhiteSpace($Map[$Key])) {
    Fail "$Label ausente: $Key"
    return $false
  }

  Pass "$Label encontrado: $Key"
  return $true
}

function Run-CommandTest($Name, $File, $Arguments) {
  Write-Host ""
  Write-Host "> $File $Arguments" -ForegroundColor DarkGray

  $command = Get-Command $File -ErrorAction SilentlyContinue
  $filePath = if ($command) { $command.Source } else { $File }

  if ($File -eq "npm") {
    $command = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
    if ($command) {
      $filePath = $command.Source
    }
  }

  $process = Start-Process -FilePath $filePath -ArgumentList $Arguments -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -eq 0) {
    Pass $Name
  } else {
    Fail "$Name falhou com código $($process.ExitCode)"
  }
}

function Invoke-Rest($Method, $Uri, $Headers = @{}, $Body = $null) {
  try {
    $requestHeaders = @{}
    foreach ($key in $Headers.Keys) {
      if ($key -ne "Content-Type") {
        $requestHeaders[$key] = $Headers[$key]
      }
    }

    $params = @{
      Method = $Method
      Uri = $Uri
      Headers = $requestHeaders
      UseBasicParsing = $true
    }

    if ($null -ne $Body) {
      $params["Body"] = $Body
      if ($Headers.ContainsKey("Content-Type")) {
        $params["ContentType"] = $Headers["Content-Type"]
      } else {
        $params["ContentType"] = "application/json"
      }
    }

    $response = Invoke-WebRequest @params
    $json = $null
    if ($response.Content) {
      try {
        $json = $response.Content | ConvertFrom-Json
      } catch {
        $json = $null
      }
    }

    return @{
      Ok = $true
      Status = [int]$response.StatusCode
      Json = $json
      Raw = $response.Content
    }
  } catch {
    $response = $_.Exception.Response
    $status = 0
    $raw = $_.Exception.Message

    if ($response) {
      $status = [int]$response.StatusCode
      $stream = $response.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $raw = $reader.ReadToEnd()
      }
    }

    $json = $null
    if ($raw) {
      try {
        $json = $raw | ConvertFrom-Json
      } catch {
        $json = $null
      }
    }

    return @{
      Ok = $false
      Status = $status
      Json = $json
      Raw = $raw
    }
  }
}

function Expect-Allowed($Name, $Result) {
  if ($Result.Status -ge 200 -and $Result.Status -lt 300) {
    Pass $Name
  } else {
    Fail "$Name deveria permitir, mas retornou HTTP $($Result.Status). $($Result.Raw)"
  }
}

function Expect-Denied($Name, $Result) {
  if ($Result.Status -eq 401 -or $Result.Status -eq 403) {
    Pass $Name
  } else {
    Fail "$Name deveria negar, mas retornou HTTP $($Result.Status). $($Result.Raw)"
  }
}

function Sign-In($Email, $Password, $ApiKey) {
  $uri = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$ApiKey"
  $body = @{
    email = $Email
    password = $Password
    returnSecureToken = $true
  } | ConvertTo-Json -Depth 5

  $result = Invoke-Rest "POST" $uri @{} $body
  if ($result.Status -ge 200 -and $result.Status -lt 300) {
    return @{
      Ok = $true
      Email = $Email
      Uid = $result.Json.localId
      IdToken = $result.Json.idToken
    }
  }

  return @{
    Ok = $false
    Email = $Email
    Error = $result.Raw
    Status = $result.Status
  }
}

function Fs-String($Value) {
  return @{ stringValue = [string]$Value }
}

function Fs-Null() {
  return @{ nullValue = $null }
}

function Fs-Array($Values) {
  return @{ arrayValue = @{ values = $Values } }
}

function Fs-Doc($Fields) {
  return @{ fields = $Fields } | ConvertTo-Json -Depth 20
}

function Firestore-Headers($Token) {
  return @{
    Authorization = "Bearer $Token"
    "Content-Type" = "application/json"
  }
}

function Firestore-Base($ProjectId) {
  return "https://firestore.googleapis.com/v1/projects/$ProjectId/databases/(default)/documents"
}

function Run-Firestore-Tests($ProjectId, $Admin, $Operador, $Terceirizada) {
  Write-Title "Testes de Regras do Firestore"

  if (-not $Admin.Ok) {
    Skip "Sem login admin válido; testes administrativos ignorados."
    return
  }

  $base = Firestore-Base $ProjectId
  $adminHeaders = Firestore-Headers $Admin.IdToken

  $adminRead = Invoke-Rest "GET" "$base/usuarios_sistema/$($Admin.Uid)" $adminHeaders
  Expect-Allowed "Admin consegue ler seu perfil em usuarios_sistema" $adminRead

  if (-not $Operador.Ok) {
    Skip "Sem login operador válido; criação de OS por operador ignorada."
    return
  }

  if (-not $Terceirizada.Ok) {
    Skip "Sem login terceirizada válido; testes de permissão da terceirizada ignorados."
    return
  }

  $docId = "teste_automatizado_$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())"
  $createUri = "$base/ordens_servico?documentId=$docId"
  $operadorHeaders = Firestore-Headers $Operador.IdToken
  $terceirizadaHeaders = Firestore-Headers $Terceirizada.IdToken

  $osBody = Fs-Doc @{
    tipo = Fs-String "BURACO_RUA"
    protocolo = Fs-String $docId
    ordemServico = Fs-String $docId
    bairro = Fs-String "TESTE AUTOMATIZADO"
    rua = Fs-String "RUA TESTE"
    numero = Fs-String "S/N"
    pontoReferencia = Fs-String "CRIADO PELO SCRIPT"
    referencia = Fs-String "CRIADO PELO SCRIPT"
    observacoes = Fs-String "DOCUMENTO TEMPORARIO PARA VALIDAR REGRAS"
    status = Fs-String "ABERTA"
    createdByUid = Fs-String $Operador.Uid
    createdByEmail = Fs-String $Operador.Email
    slaPausas = Fs-Array @()
  }

  $createResult = Invoke-Rest "POST" $createUri $operadorHeaders $osBody
  Expect-Allowed "Operador consegue criar OS com createdByUid correto" $createResult

  $badCreateBody = Fs-Doc @{
    tipo = Fs-String "BURACO_RUA"
    protocolo = Fs-String "$docId-terceirizada"
    ordemServico = Fs-String "$docId-terceirizada"
    bairro = Fs-String "TESTE"
    status = Fs-String "ABERTA"
    createdByUid = Fs-String $Terceirizada.Uid
  }
  $badCreate = Invoke-Rest "POST" "$base/ordens_servico?documentId=$docId-terceirizada" $terceirizadaHeaders $badCreateBody
  Expect-Denied "Terceirizada não consegue criar OS" $badCreate

  if ($createResult.Status -ge 200 -and $createResult.Status -lt 300) {
    $statusBody = Fs-Doc @{ status = Fs-String "CONCLUIDA" }
    $statusUpdate = Invoke-Rest "PATCH" "$base/ordens_servico/$docId`?updateMask.fieldPaths=status" $terceirizadaHeaders $statusBody
    Expect-Allowed "Terceirizada consegue alterar apenas campo operacional permitido" $statusUpdate

    $bairroBody = Fs-Doc @{ bairro = Fs-String "ALTERACAO INDEVIDA" }
    $bairroUpdate = Invoke-Rest "PATCH" "$base/ordens_servico/$docId`?updateMask.fieldPaths=bairro" $terceirizadaHeaders $bairroBody
    Expect-Denied "Terceirizada não consegue alterar campo cadastral da OS" $bairroUpdate

    $deleteByOperator = Invoke-Rest "DELETE" "$base/ordens_servico/$docId" $operadorHeaders
    Expect-Denied "Operador não consegue excluir OS" $deleteByOperator

    $deleteByAdmin = Invoke-Rest "DELETE" "$base/ordens_servico/$docId" $adminHeaders
    Expect-Allowed "Admin consegue excluir OS temporária do teste" $deleteByAdmin
  } else {
    Skip "Documento temporário não foi criado; testes de update/delete ignorados."
  }
}

function Run-Supabase-Test($Env) {
  Write-Title "Teste de Upload Supabase"

  if ($SkipSupabase) {
    Skip "Teste do Supabase ignorado por parâmetro."
    return
  }

  if (-not $Env.ContainsKey("VITE_SUPABASE_URL") -or -not $Env.ContainsKey("VITE_SUPABASE_ANON_KEY")) {
    Skip "Variáveis do Supabase ausentes no .env.local."
    return
  }

  $url = $Env["VITE_SUPABASE_URL"].TrimEnd("/")
  $anon = $Env["VITE_SUPABASE_ANON_KEY"]
  $objectPath = "calcamento/testes-automatizados/teste_$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()).png"
  $uploadUri = "$url/storage/v1/object/os-arquivos/$objectPath"
  $deleteUri = "$url/storage/v1/object/os-arquivos/$objectPath"

  $headers = @{
    apikey = $anon
    Authorization = "Bearer $anon"
    "Content-Type" = "image/png"
  }

  $pngBytes = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")

  $upload = Invoke-Rest "POST" $uploadUri $headers $pngBytes
  Expect-Allowed "Supabase aceita upload de imagem no bucket os-arquivos" $upload

  if ($upload.Status -ge 200 -and $upload.Status -lt 300) {
    $delete = Invoke-Rest "DELETE" $deleteUri $headers
    Expect-Allowed "Supabase permite remover imagem temporária do teste" $delete
  }
}

Write-Title "Preparação"

if (-not (Test-Path "package.json")) {
  Fail "Execute este script na raiz do projeto, onde existe package.json."
  exit 1
}

$envValues = Load-DotEnv $EnvFile
$testValues = Load-DotEnv $TestEnvFile

Require-Value $envValues "VITE_FIREBASE_API_KEY" $EnvFile | Out-Null
Require-Value $envValues "VITE_FIREBASE_PROJECT_ID" $EnvFile | Out-Null

if ([string]::IsNullOrWhiteSpace($ProjectId)) {
  $ProjectId = $envValues["VITE_FIREBASE_PROJECT_ID"]
}

if ([string]::IsNullOrWhiteSpace($ProjectId)) {
  Fail "ProjectId não informado e VITE_FIREBASE_PROJECT_ID ausente."
  exit 1
}

Pass "Projeto Firebase usado nos testes: $ProjectId"

if (-not $SkipNpm) {
  Write-Title "Testes do Projeto"
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Run-CommandTest "Lint do projeto" "npm" "run lint --if-present"
    Run-CommandTest "Build do projeto" "npm" "run build --if-present"
  } else {
    Skip "npm não encontrado no PATH."
  }
}

Write-Title "Login das Contas de Teste"

$apiKey = $envValues["VITE_FIREBASE_API_KEY"]

$admin = @{ Ok = $false }
$operador = @{ Ok = $false }
$terceirizada = @{ Ok = $false }

if ($testValues["TEST_ADMIN_EMAIL"] -and $testValues["TEST_ADMIN_PASSWORD"]) {
  $admin = Sign-In $testValues["TEST_ADMIN_EMAIL"] $testValues["TEST_ADMIN_PASSWORD"] $apiKey
  if ($admin.Ok) { Pass "Login admin realizado" } else { Fail "Login admin falhou: HTTP $($admin.Status) $($admin.Error)" }
} else {
  Skip "TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD não preenchidos."
}

if ($testValues["TEST_OPERADOR_EMAIL"] -and $testValues["TEST_OPERADOR_PASSWORD"]) {
  $operador = Sign-In $testValues["TEST_OPERADOR_EMAIL"] $testValues["TEST_OPERADOR_PASSWORD"] $apiKey
  if ($operador.Ok) { Pass "Login operador realizado" } else { Fail "Login operador falhou: HTTP $($operador.Status) $($operador.Error)" }
} else {
  Skip "TEST_OPERADOR_EMAIL/TEST_OPERADOR_PASSWORD não preenchidos."
}

if ($testValues["TEST_TERCEIRIZADA_EMAIL"] -and $testValues["TEST_TERCEIRIZADA_PASSWORD"]) {
  $terceirizada = Sign-In $testValues["TEST_TERCEIRIZADA_EMAIL"] $testValues["TEST_TERCEIRIZADA_PASSWORD"] $apiKey
  if ($terceirizada.Ok) { Pass "Login terceirizada realizado" } else { Fail "Login terceirizada falhou: HTTP $($terceirizada.Status) $($terceirizada.Error)" }
} else {
  Skip "TEST_TERCEIRIZADA_EMAIL/TEST_TERCEIRIZADA_PASSWORD não preenchidos."
}

Run-Firestore-Tests $ProjectId $admin $operador $terceirizada
Run-Supabase-Test $envValues

Write-Title "Resumo"
Write-Host "Passou:    $script:Passed" -ForegroundColor Green
Write-Host "Falhou:    $script:Failed" -ForegroundColor Red
Write-Host "Ignorado:  $script:Skipped" -ForegroundColor Yellow

if ($script:Failed -gt 0) {
  exit 1
}

exit 0
