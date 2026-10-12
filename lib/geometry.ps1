<#
.SYNOPSIS
    Capture / restore the window geometry of one Windows process.

.DESCRIPTION
    DSH Desktop (the packaged Electron shell) never persists its window bounds:
    the main process hard-codes 1280x820 and there is no window-state store, so a
    plain exit + relaunch always loses the user's window position and size. This
    script is the piece that makes a restart geometry-preserving:

      capture  read the target process' main window rectangle, its restore
               rectangle and its show state (normal / minimized / maximized) and
               write them as JSON;
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
# state), and the two setters used to put the window back.
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
    Capture the geometry of one process' main window.
.DESCRIPTION
    rcNormalPosition is what the user actually chose: when the window is
    maximized, the current rectangle is the maximized one and only
    rcNormalPosition holds the size to come back to. It is therefore the primary
    source, with GetWindowRect as the fallback.
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
        capturedAt  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
}

<#
.SYNOPSIS
    Apply a previously captured geometry to the relaunched process' main window.
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

    if ($saved.minimized -eq $true) {
        [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_MINIMIZE)
        Write-Result @{ ok = $true; applied = 'minimize'; hwnd = [int64]$hwnd }
        return
    }

    if ($saved.maximized -eq $true) {
        [void][DshRestartWin.Native]::ShowWindow($hwnd, $SW_MAXIMIZE)
        Write-Result @{ ok = $true; applied = 'maximize'; hwnd = [int64]$hwnd }
        return
    }

    $r = $saved.restoreRect
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
    $flags = $SWP_NOZORDER -bor $SWP_NOACTIVATE
    $applied = [DshRestartWin.Native]::SetWindowPos($hwnd, [IntPtr]::Zero, [int]$r.left, [int]$r.top, $width, $height, $flags)
    if (-not $applied) {
        $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Result @{ ok = $false; reason = "set-window-pos-failed:$code"; hwnd = [int64]$hwnd }
        return
    }

    # Read back what actually landed, so the caller can log a pixel-exact result
    # instead of trusting the request.
    $after = New-Object DshRestartWin.Native+RECT
    $readBack = [DshRestartWin.Native]::GetWindowRect($hwnd, [ref]$after)
    Write-Result @{
        ok      = $true
        applied = 'rect'
        hwnd    = [int64]$hwnd
        wanted  = @{ left = [int]$r.left; top = [int]$r.top; width = $width; height = $height }
        actual  = if ($readBack) {
            $actualRect = ConvertTo-Rect $after
            @{ left = $actualRect.left; top = $actualRect.top; width = ($actualRect.right - $actualRect.left); height = ($actualRect.bottom - $actualRect.top) }
        } else { $null }
    }
}

try {
    if ($Mode -eq 'capture') { Invoke-Capture } else { Invoke-Restore }
}
catch {
    try { Write-Result @{ ok = $false; reason = 'exception'; message = $_.Exception.Message } }
    catch { }
}
