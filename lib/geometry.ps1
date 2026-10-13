<#
.SYNOPSIS
    Capture / restore the window geometry of one Windows process.

.DESCRIPTION
    DSH Desktop (the packaged Electron shell) never persists its window bounds:
    the main process hard-codes 1280x820 and there is no window-state store, so a
    plain exit + relaunch always loses the user's window position and size. This
    script is the piece that makes a restart geometry-preserving:

      capture  read the target process' main window rectangle, its restore
               rectangle, its show state (normal / minimized / maximized) and the
               monitor it sits on, then write them as JSON;
      restore  wait for the relaunched process to own a visible main window, then
               apply the captured state with SetWindowPos / ShowWindow.

    It is deliberately ASCII-only. Windows PowerShell 5.1 decodes a -File script
    as ANSI when the file has no BOM, so non-ASCII comments or string literals
    would be mangled on a Chinese-locale system. Keep this file ASCII.

    Every failure is reported through the -Out JSON document, never as a
    terminating error: the caller (lib/helper.mjs) must be able to tell
    "geometry unavailable" from "the restart itself failed".

.PARAMETER Mode
    capture or restore.

.PARAMETER ProcessId
    capture: the process whose main window is read.
    restore: the freshly relaunched process whose main window receives the state.

.PARAMETER Out
    Path of the JSON result document. Required.

.PARAMETER State
    restore only: path of the JSON document produced by an earlier capture.

.PARAMETER TimeoutSeconds
    restore only: how long to wait for the new main window to appear.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File geometry.ps1 -Mode capture -ProcessId 1234 -Out C:\tmp\g.json

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File geometry.ps1 -Mode restore -ProcessId 4321 -State C:\tmp\g.json -Out C:\tmp\r.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('capture', 'restore')][string]$Mode,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$State,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Win32 bindings: window rectangle, window placement (restore rect + show
# state), the monitor a window sits on, and the setters used to put the window
# back.
#
# The monitor bindings exist because of a real multi-monitor defect: a maximized
# window is maximized *on the monitor it currently occupies*, and the relaunched
# app creates its window on the primary (laptop) screen. Calling
# ShowWindow(SW_MAXIMIZE) straight away therefore drags a window that lived on a
# second display back to the laptop screen. Knowing which monitor the window was
# on (and which one it landed on) is what makes the restore verifiable.
# ---------------------------------------------------------------------------
if (-not ('DshRestartWin.Native' -as [type])) {
    Add-Type -Namespace DshRestartWin -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")]
public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
[DllImport("user32.dll")]
public static extern IntPtr MonitorFromRect(ref RECT lprc, uint dwFlags);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }

[StructLayout(LayoutKind.Sequential)]
public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public int dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szDevice;
}
'@
}

# ShowWindow commands and SetWindowPos flags. SW_SHOWMINIMIZED (2) is the value
# GetWindowPlacement reports for a minimized window; SW_MINIMIZE (6) is the
# request ShowWindow expects.
$SW_NORMAL = 1
$SW_SHOWMINIMIZED = 2
$SW_MAXIMIZE = 3
$SW_MINIMIZE = 6
$SW_RESTORE = 9
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010

# MonitorFromWindow / MonitorFromRect flags and MONITORINFOF_PRIMARY.
$MONITOR_DEFAULTTONULL = 0x00000000
$MONITOR_DEFAULTTONEAREST = 0x00000002
$MONITORINFOF_PRIMARY = 0x00000001

<#
.SYNOPSIS
    Write a JSON result document (UTF-8, no BOM handling needed by the caller).
#>
function Write-Result {
    param([Parameter(Mandatory = $true)]$Value)
    $json = $Value | ConvertTo-Json -Depth 8 -Compress
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Out, $json, $encoding)
}

<#
.SYNOPSIS
    Read one RECT struct into a plain hashtable.
#>
function ConvertTo-Rect {
    param($Rect)
    return @{
        left   = [int]$Rect.Left
        top    = [int]$Rect.Top
        right  = [int]$Rect.Right
        bottom = [int]$Rect.Bottom
    }
}

<#
.SYNOPSIS
    The process' main window handle, or [IntPtr]::Zero when it has none yet.
#>
function Get-MainWindow {
    param([int]$Id)
    $process = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if (-not $process) { return [IntPtr]::Zero }
    try { $process.Refresh() } catch { }
    return $process.MainWindowHandle
}

<#
.SYNOPSIS
    The monitor a window currently sits on.
.DESCRIPTION
    Returns $null when the monitor cannot be read. The device name is the stable
    identity across a restart (for example "\\.\DISPLAY3"), which is what makes
    "same display as before" checkable instead of merely "same rectangle".
#>
function Get-MonitorOf {
    param([IntPtr]$Hwnd)
    $handle = [DshRestartWin.Native]::MonitorFromWindow($Hwnd, $MONITOR_DEFAULTTONEAREST)
    if ($handle -eq [IntPtr]::Zero) { return $null }
    $info = New-Object DshRestartWin.Native+MONITORINFOEX
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [DshRestartWin.Native]::GetMonitorInfo($handle, [ref]$info)) { return $null }
    return @{
        device  = $info.szDevice
        left    = [int]$info.rcMonitor.Left
        top     = [int]$info.rcMonitor.Top
        right   = [int]$info.rcMonitor.Right
        bottom  = [int]$info.rcMonitor.Bottom
        primary = (($info.dwFlags -band $MONITORINFOF_PRIMARY) -ne 0)
    }
}

<#
.SYNOPSIS
    Normalize a monitor description, whichever shape it comes in.
.DESCRIPTION
    A live reading (Get-MonitorOf) is flat; a saved state file holds the shaped
    form (device / primary / rect). Both must end up flat, because a restored
    state is what the re-centring logic has to reason about - reading the wrong
    shape silently yields $null edges, which would disable that logic.
#>
function ConvertTo-Monitor {
    param($Monitor)
    if (-not $Monitor) { return $null }
    $rect = $Monitor.rect
    $left = if ($null -ne $Monitor.left) { $Monitor.left } elseif ($rect) { $rect.left } else { $null }
    $top = if ($null -ne $Monitor.top) { $Monitor.top } elseif ($rect) { $rect.top } else { $null }
    $right = if ($null -ne $Monitor.right) { $Monitor.right } elseif ($rect) { $rect.right } else { $null }
    $bottom = if ($null -ne $Monitor.bottom) { $Monitor.bottom } elseif ($rect) { $rect.bottom } else { $null }
    if ($null -eq $left -or $null -eq $top -or $null -eq $right -or $null -eq $bottom) { return $null }
    return @{
        device  = if ($Monitor.device) { [string]$Monitor.device } else { '' }
        left    = [int]$left
        top     = [int]$top
        right   = [int]$right
        bottom  = [int]$bottom
        primary = [bool]$Monitor.primary
    }
}

<#
.SYNOPSIS
    Shape a monitor description for the JSON result.
#>
function Format-Monitor {
    param($Monitor)
    $flat = ConvertTo-Monitor $Monitor
    if (-not $flat) { return $null }
    return @{
        device  = $flat.device
        primary = $flat.primary
        rect    = @{
            left   = $flat.left
            top    = $flat.top
            right  = $flat.right
            bottom = $flat.bottom
        }
    }
}

<#
.SYNOPSIS
    Does a saved rectangle still lie on a monitor that is currently attached?
.DESCRIPTION
    Tells "the window was on a display that is still here" from "that display is
    gone" (unplugged dock, undocked laptop). The latter must not make the script
    shove the window at coordinates nobody can see.
#>
function Test-RectOnMonitor {
    param($Rect)
    if (-not $Rect) { return $false }
    if ($null -eq $Rect.left -or $null -eq $Rect.right) { return $false }
    $r = New-Object DshRestartWin.Native+RECT
    $r.Left = [int]$Rect.left
    $r.Top = [int]$Rect.top
    $r.Right = [int]$Rect.right
    $r.Bottom = [int]$Rect.bottom
    return ([DshRestartWin.Native]::MonitorFromRect([ref]$r, $MONITOR_DEFAULTTONULL) -ne [IntPtr]::Zero)
}

<#
.SYNOPSIS
    Are two monitor descriptions the same display?
#>
function Test-SameMonitor {
    param($Wanted, $Actual)
    if (-not $Wanted -or -not $Actual) { return $false }
    if ($Wanted.device -and $Actual.device) { return ($Wanted.device -eq $Actual.device) }
    return ($Wanted.left -eq $Actual.left -and $Wanted.top -eq $Actual.top -and $Wanted.right -eq $Actual.right -and $Wanted.bottom -eq $Actual.bottom)
}

<#
.SYNOPSIS
    Move a window to an explicit rectangle (no z-order change, no activation).
#>
function Set-WindowRect {
    param([IntPtr]$Hwnd, [int]$Left, [int]$Top, [int]$Width, [int]$Height)
    $flags = $SWP_NOZORDER -bor $SWP_NOACTIVATE
    return [DshRestartWin.Native]::SetWindowPos($Hwnd, [IntPtr]::Zero, $Left, $Top, $Width, $Height, $flags)
}

<#
.SYNOPSIS
    Capture the geometry of one process' main window.
.DESCRIPTION
    rcNormalPosition is what the user actually chose: when the window is
    maximized, the current rectangle is the maximized one and only
    rcNormalPosition holds the size to come back to. It is therefore the primary
    source, with GetWindowRect as the fallback. The window's monitor is recorded
    too - see Get-MonitorOf.
#>
function Invoke-Capture {
    $hwnd = Get-MainWindow -Id $ProcessId
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Result @{ ok = $false; reason = 'no-main-window'; pid = $ProcessId }
        return
    }

    $rect = New-Object DshRestartWin.Native+RECT
    $okRect = [DshRestartWin.Native]::GetWindowRect($hwnd, [ref]$rect)

    $placement = New-Object DshRestartWin.Native+WINDOWPLACEMENT
    $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf($placement)
    $okPlacement = [DshRestartWin.Native]::GetWindowPlacement($hwnd, [ref]$placement)

    $showCmd = if ($okPlacement) { [int]$placement.showCmd } else { $SW_NORMAL }

    $normal = if ($okPlacement) { ConvertTo-Rect $placement.rcNormalPosition } else { $null }
    $restoreRect = if ($normal -and ($normal.right - $normal.left) -gt 0 -and ($normal.bottom - $normal.top) -gt 0) {
        $normal
    }
    elseif ($okRect) { ConvertTo-Rect $rect }
    else { $null }

    $monitor = Format-Monitor (Get-MonitorOf -Hwnd $hwnd)

    Write-Result @{
        ok          = $true
        pid         = $ProcessId
        hwnd        = [int64]$hwnd
        showCmd     = $showCmd
        maximized   = ($showCmd -eq $SW_MAXIMIZE)
        minimized   = ($showCmd -eq $SW_SHOWMINIMIZED)
        visible     = [bool][DshRestartWin.Native]::IsWindowVisible($hwnd)
        rect        = if ($okRect) { ConvertTo-Rect $rect } else { $null }
        restoreRect = $restoreRect
        monitor     = $monitor
        capturedAt  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
}

<#
.SYNOPSIS
    Apply a previously captured geometry to the relaunched process' main window.
.DESCRIPTION
    The subtlety is *which monitor* the window ends up on. The relaunched app
    creates its window wherever the shell puts it (in practice the primary
    display), and both maximize and minimize act on the monitor the window
    currently occupies. So the captured normal rectangle is applied first - it is
    the rectangle the user themselves chose and therefore marks the display they
    were working on - and only then is the show state applied. The window's
    monitor is read back and compared with the captured one; if it still landed
    elsewhere while the captured display is attached, the window is re-centred on
    that display once and the state re-applied.
#>
function Invoke-Restore {
    if (-not $State -or -not (Test-Path -LiteralPath $State)) {
        Write-Result @{ ok = $false; reason = 'no-state-file' }
        return
    }

    $raw = Get-Content -LiteralPath $State -Raw -Encoding UTF8
    $saved = $raw | ConvertFrom-Json
    if (-not $saved -or $saved.ok -ne $true) {
        Write-Result @{ ok = $false; reason = 'state-not-captured' }
        return
    }

    # Wait for the relaunched process to own a visible main window. Electron
    # creates the BrowserWindow a moment after the process starts.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $hwnd = [IntPtr]::Zero
    while ((Get-Date) -lt $deadline) {
        $hwnd = Get-MainWindow -Id $ProcessId
        if ($hwnd -ne [IntPtr]::Zero -and [DshRestartWin.Native]::IsWindowVisible($hwnd)) { break }
        $hwnd = [IntPtr]::Zero
        Start-Sleep -Milliseconds 300
    }
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Result @{ ok = $false; reason = 'no-main-window'; pid = $ProcessId }
        return
    }

    # Give the renderer a moment to finish its first layout, otherwise the
    # window manager can re-apply the app's own default geometry afterwards.
    Start-Sleep -Milliseconds 1200

    # The captured monitor, normalized to the flat shape. A state file holds the
    # shaped form, and reading the wrong shape yields $null edges - which would
    # silently disable the re-centring below. Keep this file ASCII-only: Windows
    # PowerShell 5.1 decodes a BOM-less -File script as ANSI, and a mangled
    # non-ASCII comment can swallow the line break after it (found the hard way).
    $wantedMonitor = ConvertTo-Monitor $saved.monitor
    $r = $saved.restoreRect

    if ($saved.minimized -eq $true) {
        # Put it on the captured display before minimizing: otherwise restoring it
        # from the taskbar pops it back on the laptop screen.
        if ($r -and (Test-RectOnMonitor -Rect $r)) {
            [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_RESTORE)
            [void](Set-WindowRect -Hwnd $hwnd -Left ([int]$r.left) -Top ([int]$r.top) -Width ([int]$r.right - [int]$r.left) -Height ([int]$r.bottom - [int]$r.top))
        }
        [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_MINIMIZE)
        $actual = Get-MonitorOf -Hwnd $hwnd
        Write-Result @{
            ok       = $true
            applied  = 'minimize'
            hwnd     = [int64]$hwnd
            wanted   = Format-Monitor $wantedMonitor
            actual   = Format-Monitor $actual
            onTarget = (Test-SameMonitor -Wanted $wantedMonitor -Actual $actual)
        }
        return
    }

    if ($saved.maximized -eq $true) {
        # Step 1: back to the captured normal rectangle - that is what decides the
        # display. Step 2: maximize, which now happens on that same display.
        [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_RESTORE)
        if ($r) {
            [void](Set-WindowRect -Hwnd $hwnd -Left ([int]$r.left) -Top ([int]$r.top) -Width ([int]$r.right - [int]$r.left) -Height ([int]$r.bottom - [int]$r.top))
        }
        [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_MAXIMIZE)
        $actual = Get-MonitorOf -Hwnd $hwnd
        $corrected = $false

        # The captured normal rectangle can straddle two displays (a maximized
        # window often keeps an odd restore rectangle) or sit on a display that is
        # no longer attached. Only when the captured display is still here and the
        # window missed it do we re-centre once - never guess otherwise.
        if ($wantedMonitor -and -not (Test-SameMonitor -Wanted $wantedMonitor -Actual $actual) -and (Test-RectOnMonitor -Rect $wantedMonitor)) {
            $monitorWidth = [int]$wantedMonitor.right - [int]$wantedMonitor.left
            $monitorHeight = [int]$wantedMonitor.bottom - [int]$wantedMonitor.top
            $width = if ($r) { [int]$r.right - [int]$r.left } else { 1280 }
            $height = if ($r) { [int]$r.bottom - [int]$r.top } else { 820 }
            if ($width -gt $monitorWidth) { $width = $monitorWidth }
            if ($height -gt $monitorHeight) { $height = $monitorHeight }
            $centerX = [int](([int]$wantedMonitor.left + [int]$wantedMonitor.right) / 2)
            $centerY = [int](([int]$wantedMonitor.top + [int]$wantedMonitor.bottom) / 2)
            [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_RESTORE)
            [void](Set-WindowRect -Hwnd $hwnd -Left ($centerX - [int]($width / 2)) -Top ($centerY - [int]($height / 2)) -Width $width -Height $height)
            [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_MAXIMIZE)
            $actual = Get-MonitorOf -Hwnd $hwnd
            $corrected = $true
        }

        $after = New-Object DshRestartWin.Native+RECT
        $readBack = [DshRestartWin.Native]::GetWindowRect($hwnd, [ref]$after)
        Write-Result @{
            ok        = $true
            applied   = 'maximize'
            hwnd      = [int64]$hwnd
            wanted    = Format-Monitor $wantedMonitor
            actual    = Format-Monitor $actual
            onTarget  = (Test-SameMonitor -Wanted $wantedMonitor -Actual $actual)
            corrected = $corrected
            rect      = if ($readBack) { ConvertTo-Rect $after } else { $null }
        }
        return
    }

    if (-not $r) {
        Write-Result @{ ok = $false; reason = 'no-restore-rect'; hwnd = [int64]$hwnd }
        return
    }

    $width = [int]$r.right - [int]$r.left
    $height = [int]$r.bottom - [int]$r.top
    if ($width -le 0 -or $height -le 0) {
        Write-Result @{ ok = $false; reason = 'invalid-restore-rect'; hwnd = [int64]$hwnd }
        return
    }

    [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_RESTORE)
    $applied = Set-WindowRect -Hwnd $hwnd -Left ([int]$r.left) -Top ([int]$r.top) -Width $width -Height $height
    if (-not $applied) {
        $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Result @{ ok = $false; reason = "set-window-pos-failed:$code"; hwnd = [int64]$hwnd }
        return
    }

    # Read back what actually landed, so the caller can log a pixel-exact result
    # instead of trusting the request.
    $after = New-Object DshRestartWin.Native+RECT
    $readBack = [DshRestartWin.Native]::GetWindowRect($hwnd, [ref]$after)
    $actualMonitor = Get-MonitorOf -Hwnd $hwnd
    Write-Result @{
        ok            = $true
        applied       = 'rect'
        hwnd          = [int64]$hwnd
        wanted        = @{ left = [int]$r.left; top = [int]$r.top; width = $width; height = $height }
        actual        = if ($readBack) {
            $actualRect = ConvertTo-Rect $after
            @{ left = $actualRect.left; top = $actualRect.top; width = ($actualRect.right - $actualRect.left); height = ($actualRect.bottom - $actualRect.top) }
        } else { $null }
        wantedMonitor = Format-Monitor $wantedMonitor
        actualMonitor = Format-Monitor $actualMonitor
        onTarget      = (Test-SameMonitor -Wanted $wantedMonitor -Actual $actualMonitor)
    }
}

try {
    if ($Mode -eq 'capture') { Invoke-Capture } else { Invoke-Restore }
}
catch {
    try { Write-Result @{ ok = $false; reason = 'exception'; message = $_.Exception.Message } }
    catch { }
}
