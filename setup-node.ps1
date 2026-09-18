$ErrorActionPreference = 'Stop'
$taskTools = 'D:\Startup\.tools'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
$taskChecksums = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt').Content
$taskLine = ($taskChecksums -split "`n" | Where-Object { $_ -match 'node-v22\.[0-9]+\.[0-9]+-win-x64.zip$' } | Select-Object -First 1).Trim()
if (!$taskLine) { throw 'Node archive checksum not found.' }
$taskFields = $taskLine -split '\s+'
$taskZipName = $taskFields[1]
$taskZip = Join-Path $taskTools $taskZipName
Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v22.x/$taskZipName" -OutFile $taskZip
if ((Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLower() -ne $taskFields[0]) { throw 'Checksum mismatch.' }
Expand-Archive -LiteralPath $taskZip -DestinationPath $taskTools -Force
Write-Output (Join-Path $taskTools ($taskZipName -replace '\.zip$', ''))
