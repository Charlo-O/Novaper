param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("Novaper.NativeMethods" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Novaper {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  public static class NativeMethods {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  }
}
"@
}

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002
$SW_RESTORE = 9

function Get-PropValue {
  param(
    [object]$Object,
    [string]$Name,
    $Default = $null
  )

  if ($null -eq $Object) {
    return $Default
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $Default
  }

  if ($null -eq $property.Value) {
    return $Default
  }

  return $property.Value
}

function ConvertTo-HandleString {
  param([System.IntPtr]$Handle)
  return ("0x{0}" -f $Handle.ToInt64().ToString("X"))
}

function ConvertFrom-HandleString {
  param([string]$Handle)
  if ([string]::IsNullOrWhiteSpace($Handle)) {
    return [System.IntPtr]::Zero
  }

  if ($Handle.StartsWith("0x")) {
    return [System.IntPtr]::new([Convert]::ToInt64($Handle, 16))
  }

  return [System.IntPtr]::new([int64]$Handle)
}

function ConvertTo-SafeRoundedNumber {
  param(
    [double]$Value,
    [int]$Fallback = 0,
    [switch]$NonNegative
  )

  if ([double]::IsNaN($Value) -or [double]::IsInfinity($Value)) {
    return $Fallback
  }

  $rounded = [int][math]::Round($Value)
  if ($NonNegative -and $rounded -lt 0) {
    return 0
  }

  return $rounded
}

function ConvertTo-BoundingRectInfo {
  param($Rect)

  return @{
    x = ConvertTo-SafeRoundedNumber -Value $Rect.X
    y = ConvertTo-SafeRoundedNumber -Value $Rect.Y
    width = ConvertTo-SafeRoundedNumber -Value $Rect.Width -NonNegative
    height = ConvertTo-SafeRoundedNumber -Value $Rect.Height -NonNegative
  }
}

function Get-PrimaryDisplayInfo {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  return @{
    width = $bounds.Width
    height = $bounds.Height
    scale = 100
  }
}

function Capture-ScreenshotData {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $memory = [System.IO.MemoryStream]::new()
    try {
      $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
      return @{
        imageBase64 = [Convert]::ToBase64String($memory.ToArray())
        width = $bounds.Width
        height = $bounds.Height
      }
    } finally {
      $memory.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-WindowList {
  $foreground = [Novaper.NativeMethods]::GetForegroundWindow()
  $windows = [System.Collections.Generic.List[object]]::new()
  $callback = [Novaper.EnumWindowsProc]{
    param([System.IntPtr]$hWnd, [System.IntPtr]$lParam)

    if (-not [Novaper.NativeMethods]::IsWindowVisible($hWnd)) {
      return $true
    }

    $length = [Novaper.NativeMethods]::GetWindowTextLength($hWnd)
    if ($length -le 0) {
      return $true
    }

    $builder = [System.Text.StringBuilder]::new($length + 1)
    [void][Novaper.NativeMethods]::GetWindowText($hWnd, $builder, $builder.Capacity)
    $title = $builder.ToString()

    [uint32]$processId = 0
    [void][Novaper.NativeMethods]::GetWindowThreadProcessId($hWnd, [ref]$processId)
    $processName = ""
    try {
      $processName = (Get-Process -Id $processId).ProcessName
    } catch {
      $processName = ""
    }

    $windows.Add([pscustomobject]@{
      handle = ConvertTo-HandleString $hWnd
      title = $title
      processId = [int]$processId
      processName = $processName
      isForeground = ($hWnd -eq $foreground)
    }) | Out-Null

    return $true
  }

  [void][Novaper.NativeMethods]::EnumWindows($callback, [System.IntPtr]::Zero)
  return $windows
}

function Resolve-WindowHandle {
  param(
    [string]$Handle,
    [string]$TitleContains
  )

  if ($Handle) {
    return ConvertFrom-HandleString $Handle
  }

  if ($TitleContains) {
    $window = Get-WindowList | Where-Object { $_.title -like "*$TitleContains*" } | Select-Object -First 1
    if ($null -eq $window) {
      throw "Window not found for title match: $TitleContains"
    }
    return ConvertFrom-HandleString $window.handle
  }

  throw "Either handle or titleContains is required."
}

function Focus-Window {
  param(
    [string]$Handle,
    [string]$TitleContains
  )

  $hWnd = Resolve-WindowHandle -Handle $Handle -TitleContains $TitleContains
  [void][Novaper.NativeMethods]::ShowWindowAsync($hWnd, $SW_RESTORE)
  $result = [Novaper.NativeMethods]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 150
  return @{
    focused = [bool]$result
  }
}

function Get-ControlTypeValue {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $null
  }

  $normalized = $Name.Trim().ToLowerInvariant()
  switch ($normalized) {
    "button" { return [System.Windows.Automation.ControlType]::Button }
    "edit" { return [System.Windows.Automation.ControlType]::Edit }
    "window" { return [System.Windows.Automation.ControlType]::Window }
    "menuitem" { return [System.Windows.Automation.ControlType]::MenuItem }
    "menu" { return [System.Windows.Automation.ControlType]::Menu }
    "checkbox" { return [System.Windows.Automation.ControlType]::CheckBox }
    "combobox" { return [System.Windows.Automation.ControlType]::ComboBox }
    "list" { return [System.Windows.Automation.ControlType]::List }
    "listitem" { return [System.Windows.Automation.ControlType]::ListItem }
    "tab" { return [System.Windows.Automation.ControlType]::Tab }
    "tabitem" { return [System.Windows.Automation.ControlType]::TabItem }
    "text" { return [System.Windows.Automation.ControlType]::Text }
    "document" { return [System.Windows.Automation.ControlType]::Document }
    default { return $null }
  }
}

function New-Condition {
  param([pscustomobject]$Selector)

  $conditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
  $name = Get-PropValue -Object $Selector -Name "name"
  $automationId = Get-PropValue -Object $Selector -Name "automationId"
  $className = Get-PropValue -Object $Selector -Name "className"
  $processId = Get-PropValue -Object $Selector -Name "processId"
  $processName = Get-PropValue -Object $Selector -Name "processName"
  $controlTypeName = Get-PropValue -Object $Selector -Name "controlType"

  if ($name) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$name))
  }
  if ($automationId) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$automationId))
  }
  if ($className) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, [string]$className))
  }
  if ($processId) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$processId))
  }
  if ($processName) {
    $processes = Get-Process -Name ([string]$processName) -ErrorAction SilentlyContinue
    if ($processes) {
      $ids = $processes | ForEach-Object { [int]$_.Id }
      if ($ids.Count -eq 1) {
        $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ids[0]))
      }
    }
  }

  $controlType = Get-ControlTypeValue -Name $controlTypeName
  if ($null -ne $controlType) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType))
  }

  if ($conditions.Count -eq 0) {
    return [System.Windows.Automation.Condition]::TrueCondition
  }

  if ($conditions.Count -eq 1) {
    return $conditions[0]
  }

  return [System.Windows.Automation.AndCondition]::new($conditions.ToArray())
}

function Get-RootElement {
  param([pscustomobject]$Selector)

  $windowTitleContains = Get-PropValue -Object $Selector -Name "windowTitleContains"
  if ($windowTitleContains) {
    $window = Get-WindowList | Where-Object { $_.title -like "*$windowTitleContains*" } | Select-Object -First 1
    if ($null -ne $window) {
      return [System.Windows.Automation.AutomationElement]::FromHandle((ConvertFrom-HandleString $window.handle))
    }
  }

  return [System.Windows.Automation.AutomationElement]::RootElement
}

function ConvertTo-ElementInfo {
  param([System.Windows.Automation.AutomationElement]$Element)

  $rect = $Element.Current.BoundingRectangle
  return [pscustomobject]@{
    name = $Element.Current.Name
    automationId = $Element.Current.AutomationId
    className = $Element.Current.ClassName
    controlType = $Element.Current.ControlType.ProgrammaticName.Split(".")[-1]
    processId = $Element.Current.ProcessId
    isOffscreen = $Element.Current.IsOffscreen
    boundingRect = ConvertTo-BoundingRectInfo -Rect $rect
  }
}

function Find-UiElements {
  param([pscustomobject]$Selector)

  $root = Get-RootElement -Selector $Selector
  $condition = New-Condition -Selector $Selector
  $scopeName = Get-PropValue -Object $Selector -Name "scope"
  $scope = if ($scopeName -eq "children") { [System.Windows.Automation.TreeScope]::Children } else { [System.Windows.Automation.TreeScope]::Descendants }
  $elements = $root.FindAll($scope, $condition)
  $maxResultsValue = Get-PropValue -Object $Selector -Name "maxResults"
  $maxResults = if ($maxResultsValue) { [int]$maxResultsValue } else { 10 }

  $results = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt [Math]::Min($elements.Count, $maxResults); $index++) {
    $results.Add((ConvertTo-ElementInfo -Element $elements.Item($index))) | Out-Null
  }
  return $results
}

function Get-UiElement {
  param([pscustomobject]$Selector)

  $root = Get-RootElement -Selector $Selector
  $condition = New-Condition -Selector $Selector
  $scopeName = Get-PropValue -Object $Selector -Name "scope"
  $scope = if ($scopeName -eq "children") { [System.Windows.Automation.TreeScope]::Children } else { [System.Windows.Automation.TreeScope]::Descendants }
  $element = $root.FindFirst($scope, $condition)
  if ($null -eq $element) {
    throw "UI element not found."
  }
  return $element
}

function Escape-SendKeysText {
  param([string]$Text)

  $escaped = $Text.Replace("{", "{{}").Replace("}", "{}}")
  foreach ($char in @("+", "^", "%", "~", "(", ")", "[", "]")) {
    $escaped = $escaped.Replace($char, "{$char}")
  }
  return $escaped
}

function Get-KeyMap {
  return @{
    "CTRL" = 0x11
    "CONTROL" = 0x11
    "SHIFT" = 0x10
    "ALT" = 0x12
    "ENTER" = 0x0D
    "TAB" = 0x09
    "ESC" = 0x1B
    "ESCAPE" = 0x1B
    "BACKSPACE" = 0x08
    "DELETE" = 0x2E
    "SPACE" = 0x20
    "UP" = 0x26
    "DOWN" = 0x28
    "LEFT" = 0x25
    "RIGHT" = 0x27
    "HOME" = 0x24
    "END" = 0x23
    "PAGEUP" = 0x21
    "PAGEDOWN" = 0x22
    "F1" = 0x70
    "F2" = 0x71
    "F3" = 0x72
    "F4" = 0x73
    "F5" = 0x74
    "F6" = 0x75
    "F7" = 0x76
    "F8" = 0x77
    "F9" = 0x78
    "F10" = 0x79
    "F11" = 0x7A
    "F12" = 0x7B
    "WIN" = 0x5B
    "META" = 0x5B
    "SUPER" = 0x5B
    "COMMAND" = 0x5B
    "CMD" = 0x5B
    "LWIN" = 0x5B
    "RWIN" = 0x5C
    "INSERT" = 0x2D
    "INS" = 0x2D
    "CAPSLOCK" = 0x14
    "NUMLOCK" = 0x90
    "SCROLLLOCK" = 0x91
    "PRINTSCREEN" = 0x2C
    "PRTSC" = 0x2C
    "PAUSE" = 0x13
    "APPS" = 0x5D
    "MENU" = 0x5D
  }
}

function Resolve-KeyCode {
  param([string]$Key)

  $map = Get-KeyMap
  $upper = $Key.Trim().ToUpperInvariant()
  if ($map.ContainsKey($upper)) {
    return [byte]$map[$upper]
  }
  if ($upper.Length -eq 1) {
    return [byte][char]$upper
  }
  throw "Unsupported key: $Key"
}

function Send-KeyCombo {
  param([string[]]$Keys)

  if (-not $Keys -or $Keys.Count -eq 0) {
    return
  }

  $modifierNames = @("CTRL", "CONTROL", "SHIFT", "ALT", "WIN", "META", "SUPER", "COMMAND", "CMD", "LWIN", "RWIN")
  $modifierCodes = [System.Collections.Generic.List[byte]]::new()
  $mainCodes = [System.Collections.Generic.List[byte]]::new()

  foreach ($key in $Keys) {
    $code = Resolve-KeyCode -Key $key
    if ($modifierNames -contains $key.Trim().ToUpperInvariant()) {
      $modifierCodes.Add($code)
    } else {
      $mainCodes.Add($code)
    }
  }

  foreach ($code in $modifierCodes) {
    [Novaper.NativeMethods]::keybd_event($code, 0, 0, [UIntPtr]::Zero)
  }
  foreach ($code in $mainCodes) {
    [Novaper.NativeMethods]::keybd_event($code, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [Novaper.NativeMethods]::keybd_event($code, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  }
  for ($index = $modifierCodes.Count - 1; $index -ge 0; $index--) {
    [Novaper.NativeMethods]::keybd_event($modifierCodes[$index], 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  }
}

function Invoke-WithRetry {
  param(
    [scriptblock]$Action,
    [int]$Attempts = 5,
    [int]$DelayMs = 80,
    [string]$ErrorMessage = "Operation failed."
  )

  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      return & $Action
    } catch {
      if ($attempt -ge $Attempts) {
        $detail = $_.Exception.Message
        if ([string]::IsNullOrWhiteSpace($detail)) {
          throw $ErrorMessage
        }
        throw "${ErrorMessage} ${detail}"
      }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Get-ClipboardSnapshot {
  try {
    $dataObject = Invoke-WithRetry -ErrorMessage "Failed to read clipboard." -Action {
      [System.Windows.Forms.Clipboard]::GetDataObject()
    }
    return @{
      hasData = ($null -ne $dataObject)
      dataObject = $dataObject
    }
  } catch {
    return @{
      hasData = $false
      dataObject = $null
    }
  }
}

function Restore-ClipboardSnapshot {
  param($Snapshot)

  if ($null -eq $Snapshot) {
    return
  }

  try {
    if (-not $Snapshot.hasData -or $null -eq $Snapshot.dataObject) {
      Invoke-WithRetry -ErrorMessage "Failed to clear clipboard." -Action {
        [System.Windows.Forms.Clipboard]::Clear()
      } | Out-Null
      return
    }

    Invoke-WithRetry -ErrorMessage "Failed to restore clipboard." -Action {
      [System.Windows.Forms.Clipboard]::SetDataObject($Snapshot.dataObject, $true)
    } | Out-Null
  } catch {
    # Best-effort restore. Input reliability is more important than surfacing clipboard restore failures.
  }
}

function Send-TextInput {
  param(
    [string]$Text,
    [switch]$SelectAllFirst
  )

  if ($SelectAllFirst) {
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 80
  }

  if ([string]::IsNullOrEmpty($Text)) {
    if ($SelectAllFirst) {
      Send-KeyCombo -Keys @("DELETE")
    }
    return
  }

  $clipboardSnapshot = $null
  try {
    $clipboardSnapshot = Get-ClipboardSnapshot
    Invoke-WithRetry -ErrorMessage "Failed to write clipboard text." -Action {
      [System.Windows.Forms.Clipboard]::SetText($Text)
    } | Out-Null
    Start-Sleep -Milliseconds 60
    Send-KeyCombo -Keys @("CTRL", "V")
  } catch {
    [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeysText -Text $Text))
  } finally {
    Restore-ClipboardSnapshot -Snapshot $clipboardSnapshot
  }
}

function Invoke-Click {
  param(
    [int]$X,
    [int]$Y,
    [switch]$DoubleClick,
    [string]$Button = "left"
  )

  [void][Novaper.NativeMethods]::SetCursorPos($X, $Y)
  Start-Sleep -Milliseconds 50

  $down = if ($Button -eq "right") { $MOUSEEVENTF_RIGHTDOWN } else { $MOUSEEVENTF_LEFTDOWN }
  $up = if ($Button -eq "right") { $MOUSEEVENTF_RIGHTUP } else { $MOUSEEVENTF_LEFTUP }
  $repeat = if ($DoubleClick) { 2 } else { 1 }

  for ($index = 0; $index -lt $repeat; $index++) {
    [Novaper.NativeMethods]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [Novaper.NativeMethods]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
  }
}

function Invoke-UiElementAction {
  param([pscustomobject]$Selector)

  $element = Get-UiElement -Selector $Selector
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $invoke = [System.Windows.Automation.InvokePattern]$pattern
    $invoke.Invoke()
  } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    $selection = [System.Windows.Automation.SelectionItemPattern]$pattern
    $selection.Select()
  } else {
    $rect = $element.Current.BoundingRectangle
    Invoke-Click -X ([int]($rect.X + ($rect.Width / 2))) -Y ([int]($rect.Y + ($rect.Height / 2)))
  }

  return @{
    invoked = $true
    element = ConvertTo-ElementInfo -Element $element
  }
}

function Set-UiElementText {
  param(
    [pscustomobject]$Selector,
    [string]$Value
  )

  $element = Get-UiElement -Selector $Selector
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    $valuePattern = [System.Windows.Automation.ValuePattern]$pattern
    $valuePattern.SetValue($Value)
  } else {
    $rect = $element.Current.BoundingRectangle
    Invoke-Click -X ([int]($rect.X + ($rect.Width / 2))) -Y ([int]($rect.Y + ($rect.Height / 2)))
    Start-Sleep -Milliseconds 100
    Send-TextInput -Text $Value -SelectAllFirst
  }

  return @{
    updated = $true
    element = ConvertTo-ElementInfo -Element $element
  }
}

function Invoke-ExecActions {
  param([object[]]$Actions)

  $executed = [System.Collections.Generic.List[object]]::new()

  foreach ($action in $Actions) {
    $buttonValue = Get-PropValue -Object $action -Name "button"
    $button = if ($buttonValue -and -not [string]::IsNullOrWhiteSpace([string]$buttonValue)) { [string]$buttonValue } else { "left" }
    switch ($action.type) {
      "click" {
        Invoke-Click -X ([int]$action.x) -Y ([int]$action.y) -Button $button
      }
      "double_click" {
        Invoke-Click -X ([int]$action.x) -Y ([int]$action.y) -Button $button -DoubleClick
      }
      "drag" {
        if (-not $action.path -or $action.path.Count -lt 2) {
          throw "Drag action requires at least two path points."
        }
        $start = $action.path[0]
        [void][Novaper.NativeMethods]::SetCursorPos([int]$start.x, [int]$start.y)
        Start-Sleep -Milliseconds 50
        [Novaper.NativeMethods]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        for ($index = 1; $index -lt $action.path.Count; $index++) {
          $point = $action.path[$index]
          [void][Novaper.NativeMethods]::SetCursorPos([int]$point.x, [int]$point.y)
          Start-Sleep -Milliseconds 25
        }
        [Novaper.NativeMethods]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      }
      "move" {
        [void][Novaper.NativeMethods]::SetCursorPos([int]$action.x, [int]$action.y)
      }
      "scroll" {
        $x = Get-PropValue -Object $action -Name "x"
        $y = Get-PropValue -Object $action -Name "y"
        if ($null -ne $x -and $null -ne $y) {
          [void][Novaper.NativeMethods]::SetCursorPos([int]$x, [int]$y)
        }
        $scrollY = Get-PropValue -Object $action -Name "scroll_y" -Default 0
        $delta = [int]$scrollY
        [Novaper.NativeMethods]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, [uint32]$delta, [UIntPtr]::Zero)
      }
      "type" {
        Send-TextInput -Text ([string]$action.text)
      }
      "keypress" {
        Send-KeyCombo -Keys ([string[]]$action.keys)
      }
      "wait" {
        $durationValue = Get-PropValue -Object $action -Name "duration_ms" -Default 1000
        $duration = [int]$durationValue
        Start-Sleep -Milliseconds $duration
      }
      "screenshot" {
        # No-op here. A fresh screenshot is always taken after the batch.
      }
      default {
        throw "Unsupported action type: $($action.type)"
      }
    }

    $executed.Add($action) | Out-Null
    Start-Sleep -Milliseconds 120
  }

  return @{
    actions = $executed
    screenshot = Capture-ScreenshotData
  }
}

function Invoke-Command {
  param([pscustomobject]$Envelope)

  $argsObject = Get-PropValue -Object $Envelope -Name "args"

  switch ($Envelope.command) {
    "capture_screenshot" {
      return Capture-ScreenshotData
    }
    "list_windows" {
      return Get-WindowList
    }
    "focus_window" {
      return Focus-Window -Handle (Get-PropValue -Object $argsObject -Name "handle") -TitleContains (Get-PropValue -Object $argsObject -Name "titleContains")
    }
    "launch_process" {
      $argumentsValue = Get-PropValue -Object $argsObject -Name "args"
      $arguments = if ($argumentsValue) { [string[]]$argumentsValue } else { @() }
      $startProcessArgs = @{
        FilePath = [string](Get-PropValue -Object $argsObject -Name "command")
        PassThru = $true
      }
      if (@($arguments).Count -gt 0) {
        $startProcessArgs["ArgumentList"] = $arguments
      }
      $cwd = Get-PropValue -Object $argsObject -Name "cwd"
      if ($cwd) {
        $startProcessArgs["WorkingDirectory"] = [string]$cwd
      }
      $process = Start-Process @startProcessArgs
      return @{ pid = $process.Id }
    }
    "kill_process" {
      $requestedPid = Get-PropValue -Object $argsObject -Name "pid"
      $processName = Get-PropValue -Object $argsObject -Name "processName"
      if ($requestedPid) {
        Stop-Process -Id ([int]$requestedPid) -Force
      } elseif ($processName) {
        Get-Process -Name ([string]$processName) -ErrorAction Stop | Stop-Process -Force
      } else {
        throw "kill_process requires pid or processName."
      }
      return @{ killed = $true }
    }
    "heartbeat" {
      $windows = Get-WindowList
      $foreground = $windows | Where-Object { $_.isForeground } | Select-Object -First 1
      return @{
        machineId = $env:COMPUTERNAME
        userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        interactiveSession = $true
        foregroundWindow = $foreground
        display = Get-PrimaryDisplayInfo
      }
    }
    "check_file" {
      $path = [string](Get-PropValue -Object $argsObject -Name "path")
      $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
      if ($null -eq $item) {
        return @{
          exists = $false
          path = $path
        }
      }

      $result = @{
        exists = $true
        path = $item.FullName
        isDirectory = $item.PSIsContainer
        size = if ($item.PSIsContainer) { $null } else { $item.Length }
        lastWriteTime = $item.LastWriteTimeUtc.ToString("o")
      }
      if ((Get-PropValue -Object $argsObject -Name "readText" -Default $false) -and -not $item.PSIsContainer) {
        $result["text"] = Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8
      }
      return $result
    }
    "move_file" {
      $sourcePath = [string](Get-PropValue -Object $argsObject -Name "path")
      $destinationPath = [string](Get-PropValue -Object $argsObject -Name "destination")
      Move-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
      return @{
        moved = $true
        destination = $destinationPath
      }
    }
    "rename_file" {
      $path = [string](Get-PropValue -Object $argsObject -Name "path")
      $newName = [string](Get-PropValue -Object $argsObject -Name "newName")
      $destination = Join-Path -Path (Split-Path -Parent $path) -ChildPath $newName
      Rename-Item -LiteralPath $path -NewName $newName -Force
      return @{
        renamed = $true
        destination = $destination
      }
    }
    "uia_find" {
      return Find-UiElements -Selector ([pscustomobject](Get-PropValue -Object $argsObject -Name "selector"))
    }
    "uia_invoke" {
      return Invoke-UiElementAction -Selector ([pscustomobject](Get-PropValue -Object $argsObject -Name "selector"))
    }
    "uia_set_value" {
      return Set-UiElementText -Selector ([pscustomobject](Get-PropValue -Object $argsObject -Name "selector")) -Value ([string](Get-PropValue -Object $argsObject -Name "value"))
    }
    "exec_actions" {
      return Invoke-ExecActions -Actions ([object[]](Get-PropValue -Object $argsObject -Name "actions" -Default @()))
    }
    "set_display_profile" {
      $display = Get-PrimaryDisplayInfo
      $requestedWidth = [int](Get-PropValue -Object $argsObject -Name "width")
      $requestedHeight = [int](Get-PropValue -Object $argsObject -Name "height")
      $requestedScale = [int](Get-PropValue -Object $argsObject -Name "scale")
      $matches = ($display.width -eq $requestedWidth) -and ($display.height -eq $requestedHeight) -and ($display.scale -eq $requestedScale)
      return @{
        supported = $false
        current = $display
        requested = @{
          width = $requestedWidth
          height = $requestedHeight
          scale = $requestedScale
        }
        matches = $matches
        message = "MVP currently validates display baseline but does not mutate system display settings."
      }
    }
    default {
      throw "Unknown sidecar command: $($Envelope.command)"
    }
  }
}

try {
  $payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  $payload = $payloadJson | ConvertFrom-Json
  $result = Invoke-Command -Envelope $payload
  @{
    ok = $true
    data = $result
  } | ConvertTo-Json -Depth 20 -Compress
} catch {
  @{
    ok = $false
    error = @{
      message = $_.Exception.Message
      stack = $_.ScriptStackTrace
    }
  } | ConvertTo-Json -Depth 20 -Compress
  exit 1
}
