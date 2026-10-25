param([string]$Folder)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @([System.Collections.Generic.HashSet[string]].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Point].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../src/win/upload-picker.cs')))
$name = 'R' + [char]0xE9 + 'sum' + [char]0xE9 + '.pdf'
$expected = Join-Path $Folder $name
if ([RougeUploads.Picker]::ResolvePath($Folder, $name) -ne $expected) { throw 'relative filename failed' }
if ([RougeUploads.Picker]::ResolvePath($null, $expected) -ne $expected) { throw 'absolute filename failed' }
if ([RougeUploads.Picker]::ResolvePath($Folder, ('"' + $name + '"')) -ne $expected) { throw 'quoted filename failed' }
foreach ($invalid in @('missing.pdf', 'x.txt', '*.pdf', '"a.pdf" "b.pdf"', 'C:\fakepath\a.pdf', '\\server\share\a.pdf', ($expected + ':data'))) {
  if ($null -ne [RougeUploads.Picker]::ResolvePath($Folder, $invalid)) { throw 'unsafe path accepted' }
}
if ($null -ne [RougeUploads.Picker]::ResolvePath($null, $name)) { throw 'unresolved folder accepted' }
$before = New-Object 'System.Collections.Generic.HashSet[string]'
$after = New-Object 'System.Collections.Generic.Dictionary[string,string]'
$after.Add('upload-1', 'resume.pdf')
if ([RougeUploads.Picker]::FindNewField($before, $after, 'resume.pdf') -ne 'upload-1') { throw 'new selection not matched' }
$before.Add('resume.pdf') | Out-Null
if ($null -ne [RougeUploads.Picker]::FindNewField($before, $after, 'resume.pdf')) { throw 'stale selection accepted' }
$before.Clear()
$after.Add('upload-2', 'resume.pdf')
if ($null -ne [RougeUploads.Picker]::FindNewField($before, $after, 'resume.pdf')) { throw 'ambiguous selection accepted' }
Write-Output 'PATH_CHECKS_OK'
