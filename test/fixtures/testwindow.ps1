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

$ssn = New-Object System.Windows.Controls.TextBox
$ssn.Width = 240; $ssn.HorizontalAlignment = 'Left'; $ssn.Margin = New-Object System.Windows.Thickness(0, 12, 0, 0)
$ssn.Text = '123-45-6789'
[System.Windows.Automation.AutomationProperties]::SetName($ssn, 'SSN')

$otp = New-Object System.Windows.Controls.TextBox
$otp.Width = 240; $otp.HorizontalAlignment = 'Left'; $otp.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
$otp.Text = '482910'
[System.Windows.Automation.AutomationProperties]::SetName($otp, 'OTP')

$cvc = New-Object System.Windows.Controls.TextBox
$cvc.Width = 240; $cvc.HorizontalAlignment = 'Left'; $cvc.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
$cvc.Text = '737'
[System.Windows.Automation.AutomationProperties]::SetName($cvc, 'CVC')

[void]$panel.Children.Add($tb); [void]$panel.Children.Add($btn); [void]$panel.Children.Add($pw)
[void]$panel.Children.Add($ssn); [void]$panel.Children.Add($otp); [void]$panel.Children.Add($cvc)
$win.Content = $panel
$win.Height = 560

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
