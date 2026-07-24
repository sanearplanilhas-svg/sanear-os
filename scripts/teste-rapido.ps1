param(
  [switch]$Headed
)

$argsList = @("-SkipInstall")

if ($Headed) {
  $argsList += "-Headed"
}

& powershell -ExecutionPolicy Bypass -File ".\scripts\teste-telas.ps1" @argsList
exit $LASTEXITCODE
