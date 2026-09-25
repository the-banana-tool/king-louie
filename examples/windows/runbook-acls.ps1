<#
.SYNOPSIS
  Sets the Windows ACLs the King Louie example runbooks rely on.

.DESCRIPTION
  Run from an elevated PowerShell. Run -Role base first, right after copying
  the code to $Base\app and before installing the service, so the install
  folder is locked from the start. Then run it again with the machine's role
  (gpu-box or laptop). -WhatIf prints every call this script would make
  without making it.

  -Runner is the signed-in Windows user who runs Claude Code or Claude
  Desktop, and so the stdio MCP server and every runbook step. These ACLs
  stop that user from changing the admin-owned files only while Claude runs
  unelevated: an elevated session is an administrator and can change anything.

  Every grant names a SID, so the script works in any Windows display
  language: *S-1-5-18 is SYSTEM, *S-1-5-32-544 is Administrators and
  *S-1-5-19 is LOCAL SERVICE, the installed service's account. Running it
  again is safe: /grant:r replaces an account's explicit entry instead of
  adding a second one, and the admin-owned folders are fully re-verified
  each time.

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

# -Base must be a real installation folder: rooted with a drive and a
# separator (a bare 'C:' is drive-relative, not a real path), not a drive
# root (every grant in -Role base would then apply to the whole drive
# instead of one folder), and outside $env:SystemRoot (Windows update and
# repair tooling depends on that tree keeping its own ACLs).
if ($Base -notmatch '^[A-Za-z]:[\\/]') {
  throw "-Base '$Base' must be rooted with a drive and a separator, e.g. C:\KingLouie (not just C:)."
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
# This script takes ownership of, and rewrites the ACLs under, whatever
# -Base names. If it already exists it must look like a King Louie install
# (or be empty), so a typo cannot hand this script someone's home folder or
# another app's install directory.
if (Test-Path -LiteralPath $baseFull) {
  $hasChildren = @(Get-ChildItem -LiteralPath $baseFull -Force -ErrorAction SilentlyContinue).Count -gt 0
  $looksLikeKingLouie = Test-Path -LiteralPath (Join-Path $baseFull 'app\package.json')
  if ($hasChildren -and -not $looksLikeKingLouie) {
    throw "-Base '$Base' already exists, is not empty, and has no app\package.json under it; refusing to take ownership of a folder that might not be the King Louie install. Point -Base at an empty folder or an existing King Louie install."
  }
}

# Never a bare icacls or takeown: Windows looks in the current directory
# before PATH.
$icacls = "$env:SystemRoot\System32\icacls.exe"
$takeown = "$env:SystemRoot\System32\takeown.exe"

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
# runner's entries by hand: icacls <path> /remove:g *<old runner's SID> /T.
$RunnerSid = "*$sid"

# gpu-box's Python venv (train.run, models.hf_download) is created from the
# interpreter recorded in its pyvenv.cfg. A per-user install lives under the
# runner's own profile, which none of this script's grants protect: the
# runner could repoint the venv at an interpreter under their control, or at
# one that can see packages outside the venv. Refuse until Python is
# (re)installed "for all users" (guide section 2/6) with no system-wide
# site-packages leak.
$pyvenvCfg = Join-Path $Base 'tools\py\pyvenv.cfg'
if (Test-Path -LiteralPath $pyvenvCfg) {
  $cfgLines = Get-Content -LiteralPath $pyvenvCfg
  $homeLine = $cfgLines | Where-Object { $_ -match '^\s*home\s*=\s*(.+?)\s*$' } | Select-Object -First 1
  $pyHome = if ($homeLine -and $homeLine -match '^\s*home\s*=\s*(.+?)\s*$') { [IO.Path]::GetFullPath($Matches[1]) } else { '' }
  # $env:ProgramW6432 is the real 64-bit Program Files even when this script
  # runs as a 32-bit process on 64-bit Windows, where $env:ProgramFiles would
  # otherwise read "Program Files (x86)". Fall back to $env:ProgramFiles on a
  # 32-bit OS, where ProgramW6432 is not set.
  $allUsersRoot = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $allUsersRoot = [IO.Path]::GetFullPath($allUsersRoot).TrimEnd('\')
  $underAllUsers = $pyHome -and (($pyHome.TrimEnd('\') -eq $allUsersRoot) -or ($pyHome.TrimEnd('\') -like "$allUsersRoot\*"))
  if (-not $underAllUsers) {
    throw "$pyvenvCfg's home ('$pyHome') is not under $allUsersRoot. Reinstall Python 'for all users' (guide section 2) so the interpreter chain is admin-owned."
  }
  $systemSitePackages = $cfgLines | Where-Object { $_ -match '^\s*include-system-site-packages\s*=\s*true\s*$' }
  if ($systemSitePackages) {
    throw "$pyvenvCfg sets include-system-site-packages = true, which lets the venv import packages outside itself. Recreate the venv without --system-site-packages."
  }
}

# Creates $Path if it is missing and sets each grant with /grant:r. With
# -WhatIf it only prints the icacls call.
function Set-KlAcl {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string] $Path,
    [switch] $CutInheritance,
    [string[]] $Grants = @()
  )
  $icaclsArgs = @($Path)
  if ($CutInheritance) { $icaclsArgs += '/inheritance:r' }
  foreach ($grant in $Grants) { $icaclsArgs += @('/grant:r', $grant) }
  if ($PSCmdlet.ShouldProcess($Path, "icacls $($icaclsArgs -join ' ')")) {
    if (-not (Test-Path -LiteralPath $Path)) {
      New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
    if ($icaclsArgs.Count -gt 1) {
      & $icacls @icaclsArgs
      if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Path (exit code $LASTEXITCODE)" }
    }
  }
}

# icacls's own exit code cannot be trusted for a setowner it lacks the
# privilege for: it still exits 0 (reproduced on this host; the same call
# without /C exits 1307). Read the owner back with Get-Acl and verify it by
# SID instead of trusting any exit code.
function Confirm-KlOwnerIsAdmins {
  param([Parameter(Mandatory)][string] $Path)
  $ownerAccount = (Get-Acl -LiteralPath $Path).Owner
  $ownerSid = ([Security.Principal.NTAccount] $ownerAccount).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne 'S-1-5-32-544') {
    throw "icacls /setowner did not make Administrators the owner of $Path (owner is $ownerAccount, $ownerSid)"
  }
}

# Walks $Path and everything under it and throws, naming the path, unless
# every item is owned by Administrators and grants no write-capable access
# to any SID other than SYSTEM or Administrators. $WritableExceptions are
# subfolders (and everything under them) where the runner's or LOCAL
# SERVICE's own explicit grant is allowed too. This is the only check in
# this script that can be trusted on its own: exit codes and one-level
# checks cannot be, once /C is involved (see Confirm-KlOwnerIsAdmins) or
# once a call recurses (icacls's own /T can still exit 0 on a per-file
# failure).
function Confirm-KlTreeLockedDown {
  param(
    [Parameter(Mandatory)][string] $Path,
    [string[]] $WritableExceptions = @()
  )
  $writeRights = [Security.AccessControl.FileSystemRights] 'WriteData, AppendData, WriteAttributes, WriteExtendedAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership, Write, Modify, FullControl'
  $items = @(Get-Item -LiteralPath $Path) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force)
  foreach ($item in $items) {
    $itemAcl = Get-Acl -LiteralPath $item.FullName
    $ownerSid = ([Security.Principal.NTAccount] $itemAcl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne 'S-1-5-32-544') {
      throw "$($item.FullName) is not owned by Administrators (owner is $ownerSid)"
    }
    $exempt = $false
    foreach ($exceptionPath in $WritableExceptions) {
      if ($item.FullName -eq $exceptionPath -or $item.FullName.StartsWith("$exceptionPath\", [StringComparison]::OrdinalIgnoreCase)) {
        $exempt = $true
        break
      }
    }
    foreach ($rule in $itemAcl.Access) {
      if ($rule.AccessControlType -ne 'Allow') { continue }
      if (([int] $rule.FileSystemRights -band [int] $writeRights) -eq 0) { continue }
      $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($ruleSid -eq 'S-1-5-18' -or $ruleSid -eq 'S-1-5-32-544') { continue }
      if ($exempt -and ($ruleSid -eq $sid -or $ruleSid -eq 'S-1-5-19')) { continue }
      throw "$($item.FullName) grants write access to $ruleSid, which is not SYSTEM or Administrators"
    }
  }
}

function New-KlAccessRule {
  param(
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier] $Sid,
    [Parameter(Mandatory)][Security.AccessControl.FileSystemRights] $Rights
  )
  New-Object Security.AccessControl.FileSystemAccessRule($Sid, $Rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')
}

# Fully reclaims an admin-owned tree in five steps, in order, because none of
# icacls's shortcuts for doing this in one call can be trusted (see the
# functions above):
#   1. Take ownership of the top folder alone (no /T) and verify it by SID.
#   2. Replace the top folder's DACL wholesale (Get-Acl / SetAccessRuleProtection
#      / remove every rule / add exactly $TopRules / Set-Acl), so no stray
#      explicit ACE from before this script ever ran survives.
#   3. Take ownership of everything below the top folder with takeown (not
#      icacls /setowner /T, which stays /C-swallowed even without /C's flag
#      once it recurses) and reset every descendant to pure inheritance from
#      the top folder.
#   4. Re-apply the explicit grants the data subfolders under this tree still
#      need, now that step 3 wiped them along with everything else.
#   5. Verify the whole tree by hand (Confirm-KlTreeLockedDown).
# With -WhatIf, each step prints what it would do without doing it, and step
# 5 does not run (there is nothing real to verify).
function Set-KlAdminOwnedTree {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][Security.AccessControl.FileSystemAccessRule[]] $TopRules,
    [hashtable] $DataGrants = @{}
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    if ($PSCmdlet.ShouldProcess($Path, 'create the folder')) {
      New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
  }

  if ($PSCmdlet.ShouldProcess($Path, 'icacls /setowner the top folder, then verify the owner by SID')) {
    & $icacls $Path '/setowner' $Admins
    if ($LASTEXITCODE -ne 0) { throw "icacls /setowner failed on $Path (exit code $LASTEXITCODE)" }
    Confirm-KlOwnerIsAdmins -Path $Path
  }

  if ($PSCmdlet.ShouldProcess($Path, 'replace the DACL wholesale (Get-Acl / Set-Acl)')) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void] $acl.RemoveAccessRule($rule) }
    foreach ($rule in $TopRules) { $acl.AddAccessRule($rule) }
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  if ($PSCmdlet.ShouldProcess("$Path (recursively)", 'takeown /A /R, then icacls /reset /T (no /C)')) {
    & $takeown '/F' $Path '/A' '/R' '/D' 'Y'
    if ($LASTEXITCODE -ne 0) { throw "takeown failed under $Path (exit code $LASTEXITCODE)" }
    & $icacls "$Path\*" '/reset' '/T'
    if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed under $Path (exit code $LASTEXITCODE)" }
  }

  foreach ($dataPath in $DataGrants.Keys) {
    Set-KlAcl -Path $dataPath -Grants @($DataGrants[$dataPath])
  }

  if ($PSCmdlet.ShouldProcess($Path, 'verify the whole tree is locked down (Confirm-KlTreeLockedDown)')) {
    Confirm-KlTreeLockedDown -Path $Path -WritableExceptions @($DataGrants.Keys)
  }
}

$AdminFull = @("${System}:(OI)(CI)F", "${Admins}:(OI)(CI)F")
$SystemSecurityId = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$AdminsSecurityId = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$RunnerSecurityId = New-Object Security.Principal.SecurityIdentifier($sid)
# The rule set every admin-owned tree's top folder gets: SYSTEM and
# Administrators keep full control, the runner can read and run but not
# write, and none of it is negotiable by anyone else.
$AdminOwnedTopRules = @(
  (New-KlAccessRule $SystemSecurityId 'FullControl'),
  (New-KlAccessRule $AdminsSecurityId 'FullControl'),
  (New-KlAccessRule $RunnerSecurityId 'ReadAndExecute')
)

switch ($Role) {
  'base' {
    # Every runbook: the install folder. Only SYSTEM and Administrators can
    # change it; the runner can read the code and the MCP config but not
    # replace them.
    Set-KlAdminOwnedTree -Path "$Base" -TopRules $AdminOwnedTopRules -DataGrants @{
      # Step 3's takeover reassigns ownership of this data subfolder to
      # Administrators too; the runner keeps write access here by this
      # explicit grant (step 4), not by owning it.
      "$Base\mcp\data" = "${RunnerSid}:(OI)(CI)M"
    }
    # The installed service runs as LOCAL SERVICE and must still read its
    # code once inheritance from C:\ is cut.
    Set-KlAcl -Path "$Base\app" -Grants @("${LocalService}:(OI)(CI)RX")
    # Every runbook: node.yaml and runbooks/*.yaml, and the folder steps start
    # in. Both inherit from $Base (admin full control, runner read), so the
    # runner can neither loosen the policy nor plant a program there.
    Set-KlAcl -Path "$Base\mcp\config"
    Set-KlAcl -Path "$Base\mcp\work"
  }
  'gpu-box' {
    # models.hf_download and train.run start hf.exe and python.exe from the
    # venv under here; the runner must not be able to replace them.
    Set-KlAdminOwnedTree -Path "$Base\tools" -TopRules $AdminOwnedTopRules -DataGrants @{}
    # models.hf_download writes its downloads here. Cutting inheritance
    # removes the Authenticated Users Modify entry a new folder on a data
    # drive inherits from the drive root; the runner keeps Modify by
    # explicit grant instead. This path is not nested under $Base or
    # D:\train, so the takeover above never touches it: its ownership is
    # left alone, since the runner may already own the files it downloaded
    # here.
    Set-KlAcl -Path 'D:\models' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)M")
    # train.run: train.py and the configs stay admin-owned. Cutting
    # inheritance removes the Authenticated Users Modify entry a new folder
    # on a data drive inherits from the drive root.
    Set-KlAdminOwnedTree -Path 'D:\train' -TopRules $AdminOwnedTopRules -DataGrants @{
      # Same reasoning as $Base\mcp\data above.
      'D:\train\runs' = "${RunnerSid}:(OI)(CI)M"
    }
    Set-KlAdminOwnedTree -Path 'D:\train\configs' -TopRules $AdminOwnedTopRules -DataGrants @{}
  }
  'laptop' {
    # laptop.build_then_deploy fetches, installs and builds here. The runner
    # clones it first, so git sees the runner as the folder's owner. This
    # path is not nested under $Base or D:\train, so the takeover above
    # never touches it: cutting inheritance and granting Modify does not
    # disturb who owns it, and its ownership is deliberately left alone --
    # git needs to keep owning its own checkout.
    if (-not (Test-Path -LiteralPath 'C:\build\site')) {
      throw 'C:\build\site does not exist. Clone your site repository there as the runner first (install guide section 6).'
    }
    Set-KlAcl -Path 'C:\build\site' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)M")
  }
}
