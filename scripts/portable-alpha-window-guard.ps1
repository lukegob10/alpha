param(
	[Parameter(Mandatory = $true)][ValidateSet('snapshot', 'close')][string]$Mode,
	[Parameter(Mandatory = $true)][string]$HostPath,
	[Parameter(Mandatory = $true)][string]$SnapshotPath,
	[string]$AllowDiscard = 'false'
)

$ErrorActionPreference = 'Stop'

$native = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AlphaReproWindows {
    public delegate bool Callback(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr state);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int capacity);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
Add-Type -TypeDefinition $native

function Get-WindowText([IntPtr]$Handle) {
	$buffer = [System.Text.StringBuilder]::new([Math]::Max(1, [AlphaReproWindows]::GetWindowTextLength($Handle) + 1))
	[void][AlphaReproWindows]::GetWindowText($Handle, $buffer, $buffer.Capacity)
	return $buffer.ToString()
}

function Get-PortableWindows {
	$rows = [System.Collections.Generic.List[object]]::new()
	$callback = [AlphaReproWindows+Callback] {
		param($handle, $state)
		if (-not [AlphaReproWindows]::IsWindowVisible($handle)) { return $true }
		$title = Get-WindowText $handle
		if (-not $title) { return $true }
		[uint32]$processId = 0
		[void][AlphaReproWindows]::GetWindowThreadProcessId($handle, [ref]$processId)
		try { $process = Get-Process -Id $processId -ErrorAction Stop } catch { return $true }
		if ($process.Path -and [string]::Equals($process.Path, $HostPath, [StringComparison]::OrdinalIgnoreCase)) {
			$rows.Add([pscustomobject]@{ Handle = $handle.ToInt64(); Title = $title; ProcessId = $processId })
		}
		return $true
	}
	[void][AlphaReproWindows]::EnumWindows($callback, [IntPtr]::Zero)
	return $rows.ToArray()
}

function Get-OwnedSaveDialog([IntPtr]$Owner) {
	$dialogs = [System.Collections.Generic.List[object]]::new()
	$callback = [AlphaReproWindows+Callback] {
		param($handle, $state)
		if ([AlphaReproWindows]::IsWindowVisible($handle) -and
			[AlphaReproWindows]::GetWindow($handle, 4) -eq $Owner -and
			(Get-WindowText $handle) -eq 'Visual Studio Code') {
			$dialogs.Add($handle)
		}
		return $true
	}
	[void][AlphaReproWindows]::EnumWindows($callback, [IntPtr]::Zero)
	if ($dialogs.Count -gt 1) { throw 'More than one save dialog belongs to the automation window' }
	if ($dialogs.Count -eq 0) { return [IntPtr]::Zero }
	return [IntPtr]$dialogs[0]
}

function Click-DontSave([IntPtr]$Dialog) {
	$buttons = [System.Collections.Generic.List[object]]::new()
	$callback = [AlphaReproWindows+Callback] {
		param($handle, $state)
		$className = [System.Text.StringBuilder]::new(64)
		[void][AlphaReproWindows]::GetClassName($handle, $className, $className.Capacity)
		if ($className.ToString() -eq 'Button' -and (Get-WindowText $handle) -match "^Do&?n.t Save$") {
			$buttons.Add($handle)
		}
		return $true
	}
	[void][AlphaReproWindows]::EnumChildWindows($Dialog, $callback, [IntPtr]::Zero)
	if ($buttons.Count -ne 1) { throw "The owned save dialog has no unique Don't Save button" }
	[void][AlphaReproWindows]::SendMessage([IntPtr]$buttons[0], 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}

$resolvedHost = [IO.Path]::GetFullPath($HostPath)
if (-not [IO.File]::Exists($resolvedHost) -or [IO.Path]::GetFileName($resolvedHost) -ine 'Code.exe') {
	throw 'HostPath must identify an existing Code.exe'
}

if ($Mode -eq 'snapshot') {
	$windows = @(Get-PortableWindows)
	$snapshot = @{ HostPath = $resolvedHost; Handles = @($windows | ForEach-Object { $_.Handle }) }
	$json = ConvertTo-Json -InputObject $snapshot -Compress
	$utf8 = [System.Text.UTF8Encoding]::new($false)
	$stream = [IO.File]::Open($SnapshotPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
	try {
		$bytes = $utf8.GetBytes($json)
		$stream.Write($bytes, 0, $bytes.Length)
	} finally { $stream.Dispose() }
	[pscustomobject]@{ status = 'snapshotted'; portableWindows = $windows.Count } | ConvertTo-Json -Compress
	exit 0
}

$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
if (-not [string]::Equals($snapshot.HostPath, $resolvedHost, [StringComparison]::OrdinalIgnoreCase)) {
	throw 'Window snapshot belongs to a different portable host'
}
$baseline = [System.Collections.Generic.HashSet[long]]::new()
foreach ($handle in $snapshot.Handles) { [void]$baseline.Add([long]$handle) }
$deadline = (Get-Date).AddSeconds(5)
$candidate = $null
do {
	$windows = @(Get-PortableWindows)
	$new = @($windows | Where-Object { -not $baseline.Contains([long]$_.Handle) })
	$owned = @($new | Where-Object { $_.Title -match '^\[Extension Development Host\]' })
	if ($owned.Count -gt 1) { throw 'Ambiguous new portable windows; no window was closed' }
	if ($owned.Count -eq 1) {
		$candidate = $owned[0]
		$foreign = @($new | Where-Object {
			$_.Handle -ne $candidate.Handle -and
			[AlphaReproWindows]::GetWindow([IntPtr]$_.Handle, 4) -ne [IntPtr]$candidate.Handle
		})
		if ($foreign.Count -gt 0) { throw 'A second new portable window is not owned by the automation window' }
		break
	}
	Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $deadline)

if (-not $candidate) {
	if ($new.Count -eq 0) {
		[pscustomobject]@{ status = 'already-closed'; portableWindows = $windows.Count } | ConvertTo-Json -Compress
		exit 0
	}
	throw 'A new portable window has an unexpected title; no window was closed'
}

$handle = [IntPtr]$candidate.Handle
$discard = $AllowDiscard -eq 'true'
$didDiscard = $false
$sentClose = $false
$deadline = (Get-Date).AddSeconds(8)
do {
	if (-not [AlphaReproWindows]::IsWindow($handle)) {
		[pscustomobject]@{ status = 'closed'; handle = $candidate.Handle; discardedGeneratedWorkspace = $didDiscard } | ConvertTo-Json -Compress
		exit 0
	}
	$dialog = Get-OwnedSaveDialog $handle
	if ($dialog -ne [IntPtr]::Zero) {
		if (-not $discard) { throw 'Automation window has a save prompt; leaving it open to preserve work' }
		Click-DontSave $dialog
		$didDiscard = $true
	} elseif (-not $sentClose) {
		[void][AlphaReproWindows]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
		$sentClose = $true
	}
	Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $deadline)
throw 'Automation window did not close; it was not force-terminated'
