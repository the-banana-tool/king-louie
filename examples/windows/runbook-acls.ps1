<#
.SYNOPSIS
  Sets the Windows ACLs the King Louie example runbooks rely on.

.DESCRIPTION
  Run from an elevated PowerShell. Run -Role base first, right after copying
  the code to $Base\app and before installing the service, so the install
  folder is locked from the start. Then run it again with the machine's role
  (gpu-box or laptop). -WhatIf prints every change without making it.

  -Runner is the signed-in Windows user who runs Claude Code or Claude
  Desktop, and so the stdio MCP server and every runbook step. These ACLs
  stop that user from changing the admin-owned files only while Claude runs
  unelevated: an elevated session is an administrator and can change anything.

  Every grant names a SID, so the script works in any Windows display
  language: *S-1-5-18 is SYSTEM, *S-1-5-32-544 is Administrators and
  *S-1-5-19 is LOCAL SERVICE, the installed service's account. Running it
  again is safe: /grant:r replaces an account's explicit entry instead of
  adding a second one.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\KingLouie\app\examples\windows\runbook-acls.ps1 -Role base -Runner 'gpu-box\<runner>' -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][ValidateSet('base', 'gpu-box', 'laptop')][string] $Role,
  [Parameter(Mandatory)][string] $Runner,
  [string] $Base = 'C:\KingLouie'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -Base must be a real installation folder: rooted so every child path below
# is unambiguous, not a drive root (every grant in -Role base would then
# apply to the whole drive instead of one folder), and outside
# $env:SystemRoot (Windows update and repair tooling depends on that tree
# keeping its own ACLs).
if (-not [System.IO.Path]::IsPathRooted($Base)) {
  throw "-Base '$Base' must be a rooted path, e.g. C:\KingLouie."
}
$baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
$baseRoot = [System.IO.Path]::GetPathRoot($baseFull + '\').TrimEnd('\')
if ($baseFull -eq $baseRoot) {
  throw "-Base '$Base' cannot be a drive root; use a subfolder such as $baseRoot\KingLouie."
}
$systemRootFull = [System.IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\')
if ($baseFull -eq $systemRootFull -or $baseFull.StartsWith("$systemRootFull\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "-Base '$Base' cannot be under `$env:SystemRoot ($env:SystemRoot)."
}

# Never a bare icacls: Windows looks in the current directory before PATH.
$icacls = "$env:SystemRoot\System32\icacls.exe"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell (Run as administrator).'
}

try {
  $sid = (New-Object Security.Principal.NTAccount($Runner)).Translate([Security.Principal.SecurityIdentifier]).Value
} catch {
  throw "Cannot turn -Runner '$Runner' into a Windows account SID. Pass the account that runs Claude as MACHINE\user or DOMAIN\user. ($($_.Exception.Message))"
}

$System = '*S-1-5-18'
$Admins = '*S-1-5-32-544'
$LocalService = '*S-1-5-19'
# Running again with a different -Runner does not remove the previous
# runner's explicit ACEs: /grant:r only replaces the entry for the account
# named in this call. After changing who runs Claude, remove the old
# runner's entries by hand (icacls <path> /remove:g <old runner's SID> /T).
$RunnerSid = "*$sid"

# gpu-box's Python venv (train.run, models.hf_download) is created from the
# interpreter recorded in its pyvenv.cfg. A per-user install lives under the
# runner's own profile, which none of this script's grants protect: the
# runner could repoint the venv at an interpreter under their control.
# Refuse until Python is (re)installed "for all users" (guide section 2/6),
# which puts it under $env:ProgramFiles instead.
$pyvenvCfg = Join-Path $Base 'tools\py\pyvenv.cfg'
if (Test-Path -LiteralPath $pyvenvCfg) {
  $homeLine = Get-Content -LiteralPath $pyvenvCfg | Where-Object { $_ -match '^\s*home\s*=\s*(.+?)\s*$' } | Select-Object -First 1
  $pyHome = if ($homeLine -and $homeLine -match '^\s*home\s*=\s*(.+?)\s*$') { $Matches[1] } else { '' }
  $programFiles = $env:ProgramFiles.TrimEnd('\')
  $underProgramFiles = $pyHome -and (($pyHome.TrimEnd('\') -eq $programFiles) -or ($pyHome.TrimEnd('\') -like "$programFiles\*"))
  if (-not $underProgramFiles) {
    throw "$pyvenvCfg's home ('$pyHome') is not under `$env:ProgramFiles. Reinstall Python 'for all users' (guide section 2) so the interpreter chain is admin-owned."
  }
}

# Creates $Path if it is missing, optionally cuts inherited entries and
# reclaims ownership, and sets each grant with /grant:r. With -WhatIf it only
# prints the icacls calls.
function Set-KlAcl {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string] $Path,
    [switch] $CutInheritance,
    [switch] $ResetOwnership,
    [string[]] $Grants = @()
  )
  $icaclsArgs = @($Path)
  if ($CutInheritance) { $icaclsArgs += '/inheritance:r' }
  foreach ($grant in $Grants) { $icaclsArgs += @('/grant:r', $grant) }
  if ($PSCmdlet.ShouldProcess($Path, "icacls $($icaclsArgs -join ' ')")) {
    if (-not (Test-Path -LiteralPath $Path)) {
      New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
    if ($ResetOwnership) {
      # An owner keeps implicit WRITE_DAC and so can grant itself access
      # straight back, no matter what ACEs the /grant call below sets.
      # Reclaiming ownership for Administrators, then clearing any explicit
      # ACEs a previous owner left on existing children, closes that hole
      # before the grants run.
      & $icacls $Path '/setowner' $Admins '/T' '/C'
      if ($LASTEXITCODE -ne 0) { throw "icacls /setowner failed on $Path (exit code $LASTEXITCODE)" }
      & $icacls "$Path\*" '/reset' '/T' '/C'
      if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed on $Path (exit code $LASTEXITCODE)" }
    }
    if ($icaclsArgs.Count -gt 1) {
      & $icacls @icaclsArgs
      if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Path (exit code $LASTEXITCODE)" }
    }
  }
}

$AdminFull = @("${System}:(OI)(CI)F", "${Admins}:(OI)(CI)F")

switch ($Role) {
  'base' {
    # Every runbook: the install folder. Only SYSTEM and Administrators can
    # change it; the runner can read the code and the MCP config but not
    # replace them. Reset first: a runner-owned folder from an earlier,
    # unlocked install would otherwise stay re-grantable to itself.
    Set-KlAcl -Path "$Base" -CutInheritance -ResetOwnership -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    # The installed service runs as LOCAL SERVICE and must still read its
    # code once inheritance from C:\ is cut.
    Set-KlAcl -Path "$Base\app" -Grants @("${LocalService}:(OI)(CI)RX")
    # Every runbook: node.yaml and runbooks/*.yaml, and the folder steps start
    # in. Both inherit from $Base (admin full control, runner read), so the
    # runner can neither loosen the policy nor plant a program there.
    Set-KlAcl -Path "$Base\mcp\config"
    Set-KlAcl -Path "$Base\mcp\work"
    # The stdio MCP instance's own data dir (its store and master key). The
    # runner needs Modify here, so ownership is left alone: it is data, not
    # a program the runner must be locked out of replacing.
    Set-KlAcl -Path "$Base\mcp\data" -Grants @("${RunnerSid}:(OI)(CI)M")
  }
  'gpu-box' {
    # models.hf_download and train.run start hf.exe and python.exe from the
    # venv under here; the runner must not be able to replace them. Reset
    # first for the same reason as $Base above.
    Set-KlAcl -Path "$Base\tools" -CutInheritance -ResetOwnership -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    # models.hf_download writes its downloads here. Cutting inheritance
    # removes the Authenticated Users Modify entry a new folder on a data
    # drive inherits from the drive root; the runner keeps Modify by
    # explicit grant instead. Ownership is left alone: this folder holds
    # downloaded data, not a program, and the runner may already own the
    # files it wrote here.
    Set-KlAcl -Path 'D:\models' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)M")
    # train.run: train.py and the configs stay admin-owned. Cutting
    # inheritance removes the Authenticated Users Modify entry a new folder
    # on a data drive inherits from the drive root. Reset first for the same
    # reason as $Base above.
    Set-KlAcl -Path 'D:\train' -CutInheritance -ResetOwnership -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    Set-KlAcl -Path 'D:\train\configs' -CutInheritance -ResetOwnership -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    # train.run: training output. The runner needs Modify here, so ownership
    # is left alone, as with mcp\data above.
    Set-KlAcl -Path 'D:\train\runs' -Grants @("${RunnerSid}:(OI)(CI)M")
  }
  'laptop' {
    # laptop.build_then_deploy fetches, installs and builds here. The runner
    # clones it first, so git sees the runner as the folder's owner. Cutting
    # inheritance and granting Modify does not disturb that; only an
    # ownership reset would, so this deliberately skips -ResetOwnership —
    # git needs to keep owning its own checkout.
    if (-not (Test-Path -LiteralPath 'C:\build\site')) {
      throw 'C:\build\site does not exist. Clone your site repository there as the runner first (install guide section 6).'
    }
    Set-KlAcl -Path 'C:\build\site' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)M")
  }
}
