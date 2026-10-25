# Compile the production helper and check pure matching only. Never call ClockBounds or any desktop operation.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName WindowsBase, UIAutomationClient, UIAutomationTypes
$sourceFile = Join-Path $PSScriptRoot '..\..\src\win\sidecar.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($sourceFile, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Sidecar PowerShell syntax failed' }
$definition = $ast.Find({ param($node)
  $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('namespace Sidecar {')
}, $true)
if (-not $definition) { throw 'Missing production C# definition' }
$refs = @([System.Collections.Generic.HashSet[string]].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Point].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition $definition.Value
$conditions = ([System.Windows.Automation.OrCondition][Sidecar.Desk]::ClockCondition()).GetConditions()
$classes = @($conditions | Where-Object { $_.Property -eq [System.Windows.Automation.AutomationElement]::ClassNameProperty } | ForEach-Object { $_.Value })
if ('SystemTray.DateTimeIconContent' -notin $classes) { throw 'Clock content must match ClassName, not only AutomationId' }
$buttonConditions = ([System.Windows.Automation.AndCondition][Sidecar.Desk]::ClockButtonCondition()).GetConditions()
$buttonClass = @($buttonConditions | Where-Object { $_.Property -eq [System.Windows.Automation.AutomationElement]::ClassNameProperty } | ForEach-Object { $_.Value })
if ('SystemTray.OmniButton' -notin $buttonClass) { throw 'The observed Windows clock peer must match its class, not the shared SystemTrayIcon ID' }
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
$now = [DateTime]::new(2026, 10, 25, 13, 40, 0)
foreach ($name in @('Clock 1:40 PM', '1:40 PM, Sunday, October 25, 2026', ('1:40' + [char]0xA0 + 'PM'), '01:40PM', '13:40', '1:39 PM, Sunday, October 25')) {
  if (-not [Sidecar.Desk]::ClockName($name, $now)) { throw 'Current notification time not recognized' }
}
foreach ($name in @('', '1:41 PM', '11:40 PM', '1:40 AM', 'Notification center', 'Sunday, October 25, 2026')) {
  if ([Sidecar.Desk]::ClockName($name, $now)) { throw 'Non-clock notification must not be selected' }
}
Write-Output 'Clock matching checks passed without desktop queries'
