# Usage: powershell -ExecutionPolicy Bypass -File check.ps1 [areas]
Set-Location $PSScriptRoot
if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund --silent }
node setup.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node check.mjs @args
exit $LASTEXITCODE
