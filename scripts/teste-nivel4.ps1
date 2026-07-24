param(
  [switch]$Headed,
  [switch]$SkipInstall
)

$argsList = @("-Nivel4")

if ($Headed) {
  $argsList += "-Headed"
}

if ($SkipInstall) {
  $argsList += "-SkipInstall"
}

& powershell -ExecutionPolicy Bypass -File ".\scripts\teste-telas.ps1" @argsList
exit $LASTEXITCODE
