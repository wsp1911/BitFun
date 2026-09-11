<#
.SYNOPSIS
Sample selected Windows process trees using CIM performance counters.
.DESCRIPTION
Writes standalone timestamped JSONL. No server or application integration is required.
No command lines or executable paths are logged. All memory values are bytes.
Name-based discovery waits for matching processes and follows app restarts.
An explicit PID binds to that process incarnation, not future reuse of its PID.
.EXAMPLE
pwsh -File scripts/diagnostics/sample-process-memory.ps1 -ProcessName openbitfun-desktop.exe
.EXAMPLE
pwsh -File scripts/diagnostics/sample-process-memory.ps1 -RootProcessId 1234 -DurationSec 120 -OutputPath memory.jsonl
.EXAMPLE
pwsh -File scripts/diagnostics/sample-process-memory.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 60)][int]$IntervalSec = 2,
    [ValidateRange(1, 43200)][int]$DurationSec = 1800,
    [ValidateRange(1, 2147483647)][int[]]$RootProcessId = @(),
    [string[]]$ProcessName = @(),
    [string]$OutputPath,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Identity($Process) {
    '{0}@{1}' -f $Process.ProcessId, $Process.CreationDate.ToUniversalTime().Ticks
}

function Select-ProcessTree($Processes, $Previous, $ExplicitRoots, $Names) {
    $current = @{}
    foreach ($process in $Processes) { $current[[int]$process.ProcessId] = $process }
    $selected = @{}
    foreach ($process in $Processes) {
        $processNumber = [int]$process.ProcessId
        $identity = Get-Identity $process
        $isRoot = if ($ExplicitRoots.Count -gt 0) {
            $ExplicitRoots.ContainsKey($identity)
        } else { $Names -icontains $process.Name }
        if ($isRoot) {
            $selected[$processNumber] = @{ identity = $identity; rootIdentity = $identity }
        } elseif ($Previous.ContainsKey($processNumber) -and $Previous[$processNumber].identity -eq $identity) {
            # Preserve surviving children after their original parent exits.
            $selected[$processNumber] = $Previous[$processNumber]
        }
    }
    do {
        $changed = $false
        foreach ($process in $Processes) {
            $processNumber = [int]$process.ProcessId
            $parentNumber = [int]$process.ParentProcessId
            if ($selected.ContainsKey($processNumber) -or -not $selected.ContainsKey($parentNumber)) { continue }
            # The parent PID may have been recycled since this child was born.
            if ($current[$parentNumber].CreationDate -gt $process.CreationDate) { continue }
            $selected[$processNumber] = @{
                identity = Get-Identity $process
                rootIdentity = $selected[$parentNumber].rootIdentity
            }
            $changed = $true
        }
    } while ($changed)
    return $selected
}

function Get-ProcessRole($Process, $Attribution) {
    if ((Get-Identity $Process) -eq $Attribution.rootIdentity) { return 'root' }
    $prefix = if ($Process.Name -ieq 'msedgewebview2.exe') { 'webview2' } else { 'child' }
    if ($null -eq $Process.CommandLine) { return "$prefix-unknown" }
    if ($Process.CommandLine -match '--type=([^\s"]+)') {
        $role = $Matches[1]
        if ($role -eq 'utility' -and $Process.CommandLine -match '--utility-sub-type=([^\s"]+)') {
            return "$prefix-utility:$($Matches[1])"
        }
        return "$prefix-$role"
    }
    if ($prefix -eq 'webview2') { return 'webview2-browser' }
    return 'child'
}

if ($SelfTest) {
    $testNames = @('sample-app.exe')
    function Fixture([int]$Number, [int]$Parent, [int]$Seconds, [string]$Name = 'msedgewebview2.exe') {
        [pscustomobject]@{ ProcessId = $Number; ParentProcessId = $Parent; Name = $Name
            CreationDate = [datetime]'2026-01-01T00:00:00Z' + [timespan]::FromSeconds($Seconds)
            CommandLine = '--type=renderer' }
    }
    $app = Fixture 10 1 0 'sample-app.exe'
    $child = Fixture 11 10 1
    $grandchild = Fixture 12 11 2
    $unrelated = Fixture 20 1 0
    $tree = Select-ProcessTree @($app, $child, $grandchild, $unrelated) @{} @{} $testNames
    if ($tree.Count -ne 3 -or $tree.ContainsKey(20)) { throw 'Tree isolation failed' }
    $tree = Select-ProcessTree @($child, $grandchild, $unrelated) $tree @{} $testNames
    if ($tree.Count -ne 2) { throw 'Parent exit retention failed' }
    $reused = Fixture 11 1 10
    $tree = Select-ProcessTree @($reused, $grandchild, $unrelated) $tree @{} $testNames
    if ($tree.ContainsKey(11) -or -not $tree.ContainsKey(12)) { throw 'PID reuse isolation failed' }
    $roots = @{ (Get-Identity $app) = $true }
    $reusedApp = Fixture 10 1 20 'sample-app.exe'
    $tree = Select-ProcessTree @($reusedApp, $child) @{} $roots $testNames
    if ($tree.Count -ne 0) { throw 'Explicit root incarnation isolation failed' }
    if ((Get-ProcessRole $child @{ rootIdentity = Get-Identity $app }) -ne 'webview2-renderer') {
        throw 'Role classification failed'
    }
    Write-Host 'Self-test passed: tree isolation, parent exit, PID reuse, explicit roots, renderer role.'
    return
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This sampler requires Windows' }
if (($RootProcessId.Count -eq 0) -eq ($ProcessName.Count -eq 0)) {
    throw 'Specify either -ProcessName or -RootProcessId (not both)'
}
$ProcessName = @($ProcessName | ForEach-Object {
    if ([string]::IsNullOrWhiteSpace($_)) { throw 'Process names cannot be empty' }
    if ($_ -match '[\\/*?]') { throw 'Use exact executable names, not paths or wildcards' }
    if ($_ -match '\.exe$') { $_ } else { "$_.exe" }
})
$runId = [guid]::NewGuid().ToString()
$explicitRoots = @{}
if ($RootProcessId.Count -gt 0) {
    $initial = @(Get-CimInstance Win32_Process)
    foreach ($number in $RootProcessId) {
        $process = $initial | Where-Object { $_.ProcessId -eq $number } | Select-Object -First 1
        if (-not $process) { throw "Root process $number does not exist" }
        $explicitRoots[(Get-Identity $process)] = $true
    }
}

if (-not $OutputPath) {
    $OutputPath = Join-Path (Get-Location) ("process-memory-{0}-{1}.jsonl" -f [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'), $PID)
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath))
# CreateNew prevents accidentally overwriting or mixing an existing capture.
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
function Write-Sample([string]$EventName, $Data) {
    $entry = @{ schemaVersion = 1; event = $EventName; runId = $runId
        timestamp = [datetime]::UtcNow.ToString('o'); data = $Data }
    $json = $entry | ConvertTo-Json -Depth 8 -Compress
    $writer.WriteLine($json)
}

Write-Host "Sampling every $IntervalSec seconds for $DurationSec seconds. Ctrl+C stops sampling."
Write-Host "Output: $OutputPath"
Write-Sample 'started' @{ intervalSec = $IntervalSec; durationSec = $DurationSec
    samplerPid = $PID; automaticDiscovery = ($explicitRoots.Count -eq 0); processNames = $ProcessName
    definitions = @{ workingSetBytes = 'Resident memory including shared pages'
        privateWorkingSetBytes = 'Resident private memory'; privateBytes = 'Private committed memory' } }
$previous = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    while ($clock.Elapsed.TotalSeconds -lt $DurationSec) {
        $sampleClock = [Diagnostics.Stopwatch]::StartNew()
        $inventoryAt = [datetime]::UtcNow.ToString('o')
        $processes = @(Get-CimInstance Win32_Process)
        $selected = Select-ProcessTree $processes $previous $explicitRoots $ProcessName
        $counters = @{}
        $counterError = $null
        if ($selected.Count -gt 0) {
            $filter = ($selected.Keys | ForEach-Object { "IDProcess = $_" }) -join ' OR '
            try {
                foreach ($counter in Get-CimInstance Win32_PerfRawData_PerfProc_Process -Filter $filter) {
                    $counters[[int]$counter.IDProcess] = $counter
                }
            } catch { $counterError = $_.Exception.Message }
        }
        $counterReadAt = [datetime]::UtcNow.ToString('o')
        # A process may exit or its PID may be reused during the counter query.
        $validated = @{}
        if ($selected.Count -gt 0) {
            $filter = ($selected.Keys | ForEach-Object { "ProcessId = $_" }) -join ' OR '
            foreach ($process in Get-CimInstance Win32_Process -Filter $filter) {
                $validated[[int]$process.ProcessId] = Get-Identity $process
            }
        }
        $rows = @(
            foreach ($process in $processes) {
                $number = [int]$process.ProcessId
                if (-not $selected.ContainsKey($number)) { continue }
                $counter = $counters[$number]
                $available = $null -ne $counter -and $validated[$number] -eq $selected[$number].identity
                [pscustomobject]@{
                    pid = $number; parentPid = [int]$process.ParentProcessId; name = $process.Name
                    identity = $selected[$number].identity; rootIdentity = $selected[$number].rootIdentity
                    role = Get-ProcessRole $process $selected[$number]
                    status = $(if ($available) { 'ok' } else { 'counter-unavailable-or-process-changed' })
                    workingSetBytes = $(if ($available) { [long]$counter.WorkingSet } else { $null })
                    privateWorkingSetBytes = $(if ($available) { [long]$counter.WorkingSetPrivate } else { $null })
                    privateBytes = $(if ($available) { [long]$counter.PrivateBytes } else { $null })
                }
            }
        )
        Write-Sample 'sample' @{ inventoryAt = $inventoryAt; counterReadAt = $counterReadAt; processes = $rows
            processCount = $rows.Count; state = $(if ($rows.Count) { 'tracking' } else { 'waiting-for-process' })
            counterError = $counterError; sampleDurationMs = $sampleClock.Elapsed.TotalMilliseconds }
        $previous = $selected
        # Do not queue catch-up samples when CIM is slower than the requested interval.
        $remaining = [Math]::Min($IntervalSec - $sampleClock.Elapsed.TotalSeconds, $DurationSec - $clock.Elapsed.TotalSeconds)
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int]($remaining * 1000)) }
    }
} catch {
    Write-Sample 'error' @{ message = $_.Exception.Message }
    throw
} finally {
    try { Write-Sample 'stopped' @{ elapsedSec = $clock.Elapsed.TotalSeconds } }
    finally { $writer.Dispose() }
}
