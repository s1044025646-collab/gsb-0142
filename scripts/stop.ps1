# Stop only the project's API server, identified by tmp/server.port.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$portFile = Join-Path $root "tmp\server.port"
if (-not (Test-Path $portFile)) {
  Write-Host "no port file ($portFile); server does not appear to be running."
  exit 0
}
$port = (Get-Content $portFile -Raw).Trim()
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force
    Write-Host "stopped PID $($c.OwningProcess) on port $port"
  }
} else {
  Write-Host "nothing listening on project port $port"
}
Remove-Item $portFile -Force -ErrorAction SilentlyContinue
