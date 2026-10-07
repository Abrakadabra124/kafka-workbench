param(
    [ValidateRange(1024, 65535)][int]$Port = 4184,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$kafkaRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$kafkaData = Join-Path $kafkaRoot 'data'
$kafkaEntry = Join-Path $kafkaRoot 'server/index.mjs'
$kafkaRecordPath = Join-Path $kafkaData 'server-process.json'
$kafkaUrl = "http://127.0.0.1:$Port"
$kafkaCandidates = @()
if ($env:KAFKA_WORKBENCH_NODE) { $kafkaCandidates += $env:KAFKA_WORKBENCH_NODE }
$kafkaOnPath = Get-Command node.exe -ErrorAction SilentlyContinue
if ($kafkaOnPath) { $kafkaCandidates += $kafkaOnPath.Source }
$kafkaCandidates += Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$kafkaNode = $null
foreach ($kafkaCandidate in $kafkaCandidates) {
    if (Test-Path -LiteralPath $kafkaCandidate -PathType Leaf) {
        $kafkaVersion = (& $kafkaCandidate --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $kafkaVersion -match '^v(24\.\d+\.\d+)$' -and [version]$Matches[1] -ge [version]'24.19.0') {
            $kafkaNode = (Resolve-Path -LiteralPath $kafkaCandidate).Path
            break
        }
    }
}
if (!$kafkaNode) { throw 'Node.js 24.19+ (24.x LTS) is required. Install it from https://nodejs.org/ or set KAFKA_WORKBENCH_NODE to its executable.' }
if (!(Test-Path -LiteralPath $kafkaEntry)) { throw 'server/index.mjs is missing. Run this script from a complete Kafka Workbench checkout.' }
if (Test-Path -LiteralPath $kafkaRecordPath) {
    $kafkaRecord = Get-Content -LiteralPath $kafkaRecordPath -Raw | ConvertFrom-Json
    if ($kafkaRecord.entry -ne $kafkaEntry) { throw 'The process record belongs to another checkout.' }
    $kafkaExisting = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$kafkaRecord.processId)"
    if ($kafkaExisting) {
        $kafkaExistingProcess = Get-Process -Id $kafkaExisting.ProcessId
        if ($kafkaExisting.ExecutablePath -ne $kafkaRecord.executable -or !$kafkaExisting.CommandLine.Contains('"' + $kafkaEntry + '"') -or $kafkaExistingProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $kafkaRecord.startedTicks) {
            throw 'The recorded process identity changed. Refusing to overwrite its record or stop another process.'
        }
        if ([int]$kafkaRecord.port -ne $Port) { throw "This checkout is already running on port $($kafkaRecord.port). Stop it before changing the port." }
        $kafkaHealth = $null
        try { $kafkaHealth = Invoke-RestMethod -Uri "$kafkaUrl/api/health" -TimeoutSec 3 } catch {}
        $kafkaOwnedListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $kafkaExisting.ProcessId }
        if (!$kafkaHealth.ok -or !$kafkaOwnedListener) { throw 'The recorded server is running but unhealthy. Inspect data/server-error.log and run scripts/stop.ps1 before retrying.' }
        Write-Output "Kafka Workbench is already running: $kafkaUrl"
        if (!$NoBrowser) { Start-Process $kafkaUrl }
        exit 0
    }
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is occupied. Choose another port with -Port." }
$kafkaNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$kafkaNpm) { throw 'npm is required. Install Node.js 24 LTS with npm.' }
$kafkaNpmCli = Join-Path (Split-Path -Parent $kafkaNpm.Source) 'node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $kafkaNpmCli)) { throw 'Cannot locate npm CLI. Install Node.js 24 LTS with npm.' }
$env:PATH = (Split-Path -Parent $kafkaNode) + ';' + $env:PATH
Push-Location $kafkaRoot
try {
    & $kafkaNode $kafkaNpmCli ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. The server was not started.' }
    & $kafkaNode $kafkaNpmCli run build
    if ($LASTEXITCODE -ne 0) { throw 'The production build failed. The server was not started.' }
} finally {
    Pop-Location
}
New-Item -ItemType Directory -Path $kafkaData -Force | Out-Null
$env:PORT = "$Port"
$env:DATA_DIR = $kafkaData
$kafkaProcess = $null
try {
    $kafkaProcess = Start-Process -FilePath $kafkaNode -ArgumentList ('"' + $kafkaEntry + '"') -WorkingDirectory $kafkaRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $kafkaData 'server.log') -RedirectStandardError (Join-Path $kafkaData 'server-error.log') -PassThru
    $kafkaPendingRecord = Join-Path $kafkaData 'server-process.pending.json'
    @{
        processId = $kafkaProcess.Id
        executable = $kafkaNode
        entry = $kafkaEntry
        port = $Port
        startedTicks = $kafkaProcess.StartTime.ToUniversalTime().Ticks.ToString()
    } | ConvertTo-Json | Set-Content -LiteralPath $kafkaPendingRecord -Encoding UTF8
    Move-Item -LiteralPath $kafkaPendingRecord -Destination $kafkaRecordPath -Force
    for ($kafkaAttempt = 0; $kafkaAttempt -lt 60; $kafkaAttempt++) {
        $kafkaProcess.Refresh()
        if ($kafkaProcess.HasExited) { throw 'Kafka Workbench stopped during startup. Inspect data/server-error.log.' }
        $kafkaHealth = $null
        try { $kafkaHealth = Invoke-RestMethod -Uri "$kafkaUrl/api/health" -TimeoutSec 2 } catch {}
        $kafkaOwnedListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $kafkaProcess.Id }
        if ($kafkaHealth.ok -and $kafkaOwnedListener) {
            Write-Output "Kafka Workbench is ready: $kafkaUrl"
            if (!$NoBrowser) { Start-Process $kafkaUrl }
            exit 0
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Kafka Workbench did not become ready. Inspect data/server-error.log.'
} catch {
    if ($kafkaProcess -and !$kafkaProcess.HasExited) {
        $kafkaProcess.Kill()
        $kafkaProcess.WaitForExit(5000) | Out-Null
    }
    throw
}
