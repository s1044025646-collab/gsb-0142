# Reproducible end-to-end demo. Uses only project-local files and processes.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== build =="
npm run build

$db = Join-Path $root "data\acoustic.sqlite"
if (Test-Path $db) { Remove-Item $db -Force }

function Run([Parameter(ValueFromRemainingArguments=$true)] $cmdArgs) {
  Write-Host ""
  Write-Host (">> node dist/cli/index.js " + ($cmdArgs -join " ")) -ForegroundColor Cyan
  & node --no-warnings dist/cli/index.js @cmdArgs
}

Run point-add HALL-A main-floor
Run synth-import HALL-A 1000 0.5 0.02 11 demo-hall-a
Run point-add HALL-B balcony
Run synth-import HALL-B 1000 0.8 0.02 22 demo-hall-b
Run point-list
Run onset-preview 1 -20
Run set-window 1 20 0 20 1500 initial-window
Run windows 1
Run analyze 1
Run set-window 2 20 0 20 2200 initial-window
Run analyze 2
Run residuals 1
Run compare 1 2
Run export-decay 1 tmp/decay-hall-a.csv
Run freeze 1
Run show 1

Write-Host "`n== repeat analysis is idempotent (same analysis id) ==" -ForegroundColor Yellow
Run analyze 1

Write-Host "`nDemo complete. DB at $db ; decay CSV at tmp/decay-hall-a.csv" -ForegroundColor Green
