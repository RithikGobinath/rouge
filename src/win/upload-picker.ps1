# Read-only upload picker observer. Runs separately from the input sidecar.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @(
  [System.Collections.Generic.HashSet[string]].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [System.Windows.Point].Assembly.Location
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'upload-picker.cs')))
function Send($value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 4))
  [Console]::Out.Flush()
}
$lines = New-Object RougeUploads.Lines
$picker = New-Object RougeUploads.Picker
$watching = $false
try {
  while (-not $lines.Closed) {
    $line = $lines.Next(100)
    if ($line) {
      $request = $null
      try {
        $request = ConvertFrom-Json -InputObject $line
        switch ($request.op) {
          'ping' { Send @{ id = $request.id; ok = $true; pid = $PID } }
          'watch.start' { $picker.Clear(); $watching = $true; Send @{ id = $request.id; ok = $true } }
          'selection.current' { Send @{ id = $request.id; ok = ($watching -and $picker.Current([string]$request.selectionId)) } }
          default { Send @{ id = $request.id; error = 'unknown_upload_operation' } }
        }
      } catch { if ($request) { Send @{ id = $request.id; error = 'upload_observation_failed' } } }
    }
    if ($watching) {
      try {
        $uploadEvent = $picker.Poll()
        if ($uploadEvent) { Send $uploadEvent }
      } catch { $picker.Clear(); Send @{ ev = 'upload.pending' } }
    }
  }
} finally { $picker.Clear() }
