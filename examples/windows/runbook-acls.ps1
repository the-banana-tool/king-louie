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
  throw "Cannot turn -Runner '$Runner' into a Windows account SID. Pass the account that runs Claude as MACHINE\user or DOMAIN\user."
}

$System = '*S-1-5-18'
$Admins = '*S-1-5-32-544'
$LocalService = '*S-1-5-19'
$RunnerSid = "*$sid"

# Creates $Path if it is missing, optionally cuts inherited entries, and sets
# each grant with /grant:r. With -WhatIf it only prints the icacls call.
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

$AdminFull = @("${System}:(OI)(CI)F", "${Admins}:(OI)(CI)F")

switch ($Role) {
  'base' {
    # Every runbook: the install folder. Only SYSTEM and Administrators can
    # change it; the runner can read the code and the MCP config but not
    # replace them.
    Set-KlAcl -Path "$Base" -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    # The installed service runs as LOCAL SERVICE and must still read its
    # code once inheritance from C:\ is cut.
    Set-KlAcl -Path "$Base\app" -Grants @("${LocalService}:(OI)(CI)RX")
    # Every runbook: node.yaml and runbooks/*.yaml, and the folder steps start
    # in. Both inherit from $Base (admin full control, runner read), so the
    # runner can neither loosen the policy nor plant a program there.
    Set-KlAcl -Path "$Base\mcp\config"
    Set-KlAcl -Path "$Base\mcp\work"
    # The stdio MCP instance's own data dir (its store and master key).
    Set-KlAcl -Path "$Base\mcp\data" -Grants @("${RunnerSid}:(OI)(CI)M")
  }
  'gpu-box' {
    # models.hf_download and train.run start hf.exe and python.exe from the
    # venv under here; the runner must not be able to replace them.
    Set-KlAcl -Path "$Base\tools" -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    # models.hf_download writes its downloads here.
    Set-KlAcl -Path 'D:\models' -Grants @("${RunnerSid}:(OI)(CI)M")
    # train.run: train.py and the configs stay admin-owned. Cutting
    # inheritance removes the Authenticated Users Modify entry a new folder
    # on a data drive inherits from the drive root.
    Set-KlAcl -Path 'D:\train' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    Set-KlAcl -Path 'D:\train\configs' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)RX")
    # train.run: training output.
    Set-KlAcl -Path 'D:\train\runs' -Grants @("${RunnerSid}:(OI)(CI)M")
  }
  'laptop' {
    # laptop.build_then_deploy fetches, installs and builds here. The runner
    # clones it first, so git sees the runner as the folder's owner.
    if (-not (Test-Path -LiteralPath 'C:\build\site')) {
      throw 'C:\build\site does not exist. Clone your site repository there as the runner first (install guide section 6).'
    }
    Set-KlAcl -Path 'C:\build\site' -Grants @("${RunnerSid}:(OI)(CI)M")
  }
}
