# Windows process memory sampler

`sample-process-memory.ps1` runs independently of the target application and any
logging server. Requires Windows and PowerShell with `Get-CimInstance`; tested
with PowerShell 7. It does not terminate or modify target processes.

```powershell
# Wait for the app, then follow its process tree and subsequent restarts.
pwsh -NoProfile -File scripts/diagnostics/sample-process-memory.ps1 -ProcessName openbitfun-desktop.exe

# Another application; .exe may be omitted. Names match exactly, ignoring case.
pwsh -NoProfile -File scripts/diagnostics/sample-process-memory.ps1 -ProcessName notepad -DurationSec 120

# Bind to this specific process incarnation and its descendants.
pwsh -NoProfile -File scripts/diagnostics/sample-process-memory.ps1 -RootProcessId 1234 -IntervalSec 2 -DurationSec 600 -OutputPath E:/captures/memory.jsonl

# Multiple roots when invoking from PowerShell.
& ./scripts/diagnostics/sample-process-memory.ps1 -RootProcessId 1234,5678

# Deterministic attribution checks; no processes are launched.
pwsh -NoProfile -File scripts/diagnostics/sample-process-memory.ps1 -SelfTest
```

Specify either process names or root PIDs. Defaults: 2-second intervals and
30-minute duration. Ctrl+C stops the sampler. By default, output goes to a new
`process-memory-<UTC timestamp>-<sampler PID>.jsonl` file in the current directory.
`-OutputPath` also creates a new file and refuses to overwrite existing captures.
Parent directories are created when needed.

Each JSON line has `schemaVersion`, `runId`, UTC `timestamp`, `event`, and `data`.
Events are `started`, `sample`, `error`, and `stopped`. Samples retain individual
process records rather than summing potentially shared memory:

| Field | Meaning |
| --- | --- |
| `pid`, `parentPid`, `name` | Process inventory identity |
| `identity`, `rootIdentity` | PID plus creation-time ticks, protecting against PID reuse |
| `role` | Root, child, or Chromium/WebView2 browser, renderer, GPU, utility role when readable |
| `workingSetBytes` | Resident memory, including shared pages |
| `privateWorkingSetBytes` | Resident private memory |
| `privateBytes` | Private committed memory, including pages that may not be resident |
| `status` | `ok`, or unavailable/changed process with null memory values |

Memory counters come from `Win32_PerfRawData_PerfProc_Process`. Process inventory
comes from `Win32_Process`. Command lines are used only to classify roles; command
lines and executable paths are not written to the capture. Without sufficient
access, a role may be unknown. Dedicated/shared GPU memory is not measured:
`gpu-process` records describe that process's CPU-side memory.

Snapshots are not atomic. `inventoryAt`, `counterReadAt`, and `sampleDurationMs`
describe the measurement window. Process identity is rechecked after reading
counters; missing counters or exited/reused PIDs yield null values rather than
zero. If CIM is slower than the interval, sampling slows down without accumulating
catch-up requests. Short-lived processes between samples may be missed. Surviving
previously identified children remain tracked after a parent exits.

Task Manager columns may use different accounting. Avoid summing working sets
as unique physical memory because shared pages can occur in several processes.

To inspect or convert a capture:

```powershell
Get-Content E:/captures/memory.jsonl | ConvertFrom-Json |
  Where-Object event -eq sample | ForEach-Object {
    $stamp = $_.timestamp
    $_.data.processes | Select-Object @{n='timestamp';e={$stamp}}, pid, role,
      workingSetBytes, privateWorkingSetBytes, privateBytes, status
  } | Export-Csv E:/captures/memory.csv -NoTypeInformation -Encoding utf8
```
