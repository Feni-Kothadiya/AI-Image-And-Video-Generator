param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRuntime = Join-Path $taskRoot '.tools\node-v22.23.2-win-x64'
if (Test-Path -LiteralPath (Join-Path $taskRuntime 'node.exe')) { $env:Path = $taskRuntime + ';' + $env:Path }
Push-Location -LiteralPath $PSScriptRoot
try {
  if (-not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Backend package installation failed.' }
  }
  $taskFrontend = Join-Path $taskRoot 'frontend'
  if ($Setup -or -not (Test-Path -LiteralPath (Join-Path $taskFrontend 'dist\index.html'))) {
    Push-Location -LiteralPath $taskFrontend
    try {
      if (-not (Test-Path -LiteralPath 'node_modules')) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Frontend package installation failed.' }
      }
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed.' }
    } finally { Pop-Location }
  }
  & npm.cmd run setup
  if ($LASTEXITCODE -ne 0) { throw 'Backend setup failed.' }
  Write-Host 'Dashboard: http://localhost:4000'
  Write-Host 'Login details: backend\data\admin-credentials.txt'
  & npm.cmd start
} finally { Pop-Location }
