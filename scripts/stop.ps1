$ErrorActionPreference = 'Stop'
$kafkaRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$kafkaRecordPath = Join-Path $kafkaRoot 'data/server-process.json'
if (!(Test-Path -LiteralPath $kafkaRecordPath)) { Write-Output 'No launcher-managed Kafka Workbench process was recorded.'; exit 0 }
$kafkaRecord = Get-Content -LiteralPath $kafkaRecordPath -Raw | ConvertFrom-Json
$kafkaEntry = Join-Path $kafkaRoot 'server/index.mjs'
if ($kafkaRecord.entry -ne $kafkaEntry) { throw 'The process record belongs to another checkout.' }
$kafkaProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$kafkaRecord.processId)"
if (!$kafkaProcess) { Write-Output 'Kafka Workbench is already stopped. Learning progress is retained.'; exit 0 }
$kafkaProcessHandle = Get-Process -Id $kafkaProcess.ProcessId
if ($kafkaProcess.ExecutablePath -ne $kafkaRecord.executable -or !$kafkaProcess.CommandLine.Contains('"' + $kafkaEntry + '"') -or $kafkaProcessHandle.StartTime.ToUniversalTime().Ticks.ToString() -ne $kafkaRecord.startedTicks) {
    throw 'Process identity does not match Kafka Workbench. Refusing to stop another process.'
}
Stop-Process -Id $kafkaProcess.ProcessId
$kafkaProcessHandle.WaitForExit(5000) | Out-Null
Write-Output 'Kafka Workbench stopped. Learning progress and Docker lab resources are retained.'
Write-Output 'Stop the Kafka lab in the application before stopping the app when the lab is no longer needed.'
