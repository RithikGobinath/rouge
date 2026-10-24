# A small WPF window the sidecar tests drive, so typing, chords and clicks are
# checked against real controls (a text box, a button, a password box) that
# expose the same UI Automation types real apps do, instead of someone's open
# app. Everything it learns is written to files named by environment variables.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
$title = $env:CLIPPY_TEST_TITLE
$out = $env:CLIPPY_TEST_TEXT
$ready = $env:CLIPPY_TEST_READY
$stateFile = $env:CLIPPY_TEST_STATE

$win = New-Object System.Windows.Window
$win.Title = $title
$win.Width = 520; $win.Height = 420
$win.WindowStartupLocation = 'CenterScreen'
$win.Topmost = $true

$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = New-Object System.Windows.Thickness(12)

$tb = New-Object System.Windows.Controls.TextBox
$tb.AcceptsReturn = $true; $tb.AcceptsTab = $true
$tb.Height = 160; $tb.Margin = New-Object System.Windows.Thickness(0, 0, 0, 12)
[System.Windows.Automation.AutomationProperties]::SetName($tb, 'Notes')

$btn = New-Object System.Windows.Controls.Button
$btn.Content = 'Send now'; $btn.Width = 140; $btn.Height = 40
$btn.HorizontalAlignment = 'Left'; $btn.Margin = New-Object System.Windows.Thickness(0, 0, 0, 12)

$pw = New-Object System.Windows.Controls.PasswordBox
$pw.Width = 240; $pw.HorizontalAlignment = 'Left'
[System.Windows.Automation.AutomationProperties]::SetName($pw, 'Secret code')

[void]$panel.Children.Add($tb); [void]$panel.Children.Add($btn); [void]$panel.Children.Add($pw)
$win.Content = $panel

$tb.Add_TextChanged({ [System.IO.File]::WriteAllText($out, $tb.Text) })
$btn.Add_Click({ $tb.AppendText('[clicked]') })
$win.Add_StateChanged({ [System.IO.File]::WriteAllText($stateFile, $win.WindowState.ToString()) })
$win.Add_ContentRendered({
  [void]$win.Activate(); [void]$tb.Focus()
  [System.IO.File]::WriteAllText($stateFile, $win.WindowState.ToString())
  [System.IO.File]::WriteAllText($ready, '1')
})
[System.IO.File]::WriteAllText($out, '')
[void]$win.ShowDialog()
