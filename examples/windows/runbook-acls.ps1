<#
.SYNOPSIS
  Sets the Windows ACLs the King Louie example runbooks rely on.

.DESCRIPTION
  Run from an elevated Windows PowerShell. Run -Role base first, right after
  copying the code to $Base\app and before installing the service, so the
  install folder is locked from the start. Then run it again with the
  machine's role (gpu-box or laptop). -WhatIf prints every change this
  script would make without making it. An existing $Base must be owned by
  Administrators or SYSTEM (create it from an elevated PowerShell, as the
  install guide shows); the script refuses one anybody else created.

  -Runner must be a single user account, never a group or a built-in
  account. The script warns, but goes on, when that user is a local
  administrator: with UAC at its default setting that is not a boundary.

  -Runner is the signed-in Windows user who runs Claude Code or Claude
  Desktop, and so the stdio MCP server and every runbook step. These ACLs
  stop that user from changing the admin-owned files only while Claude runs
  unelevated: an elevated session is an administrator and can change anything.
  Close Claude and every other program the runner has open before running
  this script: a handle the runner opened earlier keeps the access it was
  opened with.

  Every grant names a SID, so the script works in any Windows display
  language: *S-1-5-18 is SYSTEM, *S-1-5-32-544 is Administrators and
  *S-1-5-19 is LOCAL SERVICE, the installed service's account.

  Running it again is safe. Each admin-owned folder is locked again from the
  top down, one folder at a time: a folder is locked before its contents are
  listed, so the runner cannot add anything to it while the walk runs. The
  walk never follows a junction, symbolic link or other reparse point, and
  never changes a file that has a second hard link: it stops with an error
  naming the path instead, before changing anything that path points at.
  The runner's data folders (mcp\data, D:\train\runs) are locked themselves
  but never walked into. /grant:r replaces an account's explicit entry
  instead of adding a second one.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\KingLouie\app\examples\windows\runbook-acls.ps1 -Role base -Runner 'gpu-box\<runner>' -WhatIf
#>
#Requires -PSEdition Desktop
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][ValidateSet('base', 'gpu-box', 'laptop')][string] $Role,
  [Parameter(Mandatory)][string] $Runner,
  [string] $Base = 'C:\KingLouie'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Functions. None of them reads the script's parameters: each takes what it
# needs as arguments, so tests/examples.test.js can load them into an
# unelevated session and run the walk against a scratch folder.
# ---------------------------------------------------------------------------

# Compiles the Win32 calls PowerShell has no cmdlet for, once per session:
# reading the attributes and hard-link count of a file, and writing its
# owner and DACL, each through a handle opened on the item itself (never on
# what a reparse point names); and enabling a privilege this process
# already holds.
function Initialize-KlNative {
  if ('KlNative' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class KlNative {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  // BY_HANDLE_FILE_INFORMATION. Pack = 4: each FILETIME is two DWORDs, so
  // the three longs below must not be 8-byte aligned.
  private struct ByHandleFileInformation {
    public uint FileAttributes;
    public long CreationTime;
    public long LastAccessTime;
    public long LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  private struct TokenPrivilege {
    public uint Count;
    public long Luid;
    public uint Attributes;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool LookupPrivilegeValueW(string system, string name, out long luid);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returnLength);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor, uint length, out uint needed);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool LookupAccountSidW(string system, byte[] sid, StringBuilder name, ref uint nameLength, StringBuilder domain, ref uint domainLength, out int use);

  private const uint OwnerSecurityInformation = 0x1;
  private const uint DaclSecurityInformation = 0x4;
  private const uint FileAttributeDirectory = 0x10;
  private const uint FileAttributeReparsePoint = 0x400;

  private static byte[] ToBytes(RawSecurityDescriptor descriptor) {
    byte[] bytes = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(bytes, 0);
    return bytes;
  }

  // Locks one file or folder through a single handle opened on the item
  // itself (FILE_FLAG_OPEN_REPARSE_POINT), never on what a link names:
  // checks on that handle that it is not a reparse point, is the kind of
  // item the caller listed, and (a file) has one hard link; writes the owner
  // and reads it back by SID; then writes the DACL. SetKernelObjectSecurity
  // changes this one item only. SetNamedSecurityInfo, which Set-Acl and
  // icacls use, also rewrites the inherited entries of everything below the
  // item, before this walk has checked any of it (reproduced: a hard link
  // below the top folder was rewritten by the top folder's lock).
  public static void LockItem(string path, bool isDirectory, string ownerSid, string daclSddl) {
    // READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES
    uint access = 0x20000 | 0x40000 | 0x80000 | 0x80;
    using (SafeFileHandle handle = CreateFileW(path, access, 0x7, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open " + path + " to change its owner and ACL");
      }
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(handle, out info)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read the file information of " + path);
      }
      if ((info.FileAttributes & FileAttributeReparsePoint) != 0) {
        throw new InvalidOperationException(path + " is a junction, symbolic link or other reparse point. This script never follows one. Remove it (as an administrator) and run the script again.");
      }
      if (((info.FileAttributes & FileAttributeDirectory) != 0) != isDirectory) {
        throw new InvalidOperationException(path + " changed between being listed and being locked. Close every program the runner has open and run the script again.");
      }
      if (!isDirectory && info.NumberOfLinks > 1) {
        throw new InvalidOperationException(path + " has " + info.NumberOfLinks + " hard links: it is also reachable under another name, possibly outside this folder, and changing its ACL here would change it there too. Replace it with a plain copy (as an administrator) and run the script again.");
      }

      SecurityIdentifier owner = new SecurityIdentifier(ownerSid);
      byte[] ownerOnly = ToBytes(new RawSecurityDescriptor(ControlFlags.SelfRelative, owner, null, null, null));
      if (!SetKernelObjectSecurity(handle, OwnerSecurityInformation, ownerOnly)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot make " + ownerSid + " the owner of " + path);
      }
      uint needed;
      GetKernelObjectSecurity(handle, OwnerSecurityInformation, null, 0, out needed);
      byte[] current = new byte[needed];
      if (!GetKernelObjectSecurity(handle, OwnerSecurityInformation, current, needed, out needed)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read the owner of " + path);
      }
      SecurityIdentifier actual = new RawSecurityDescriptor(current, 0).Owner;
      if (actual == null || actual.Value != owner.Value) {
        throw new InvalidOperationException("Could not make " + ownerSid + " the owner of " + path + " (owner is still " + actual + ").");
      }

      if (!SetKernelObjectSecurity(handle, DaclSecurityInformation, ToBytes(new RawSecurityDescriptor(daclSddl)))) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot write the ACL of " + path);
      }
    }
  }

  // Returns { attributes, number of links }. FILE_READ_ATTRIBUTES only, every
  // share mode, FILE_FLAG_OPEN_REPARSE_POINT (the handle is on the link, not
  // its target) and FILE_FLAG_BACKUP_SEMANTICS (so a folder opens too).
  public static uint[] GetFileFacts(string path) {
    using (SafeFileHandle handle = CreateFileW(path, 0x80, 0x7, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open " + path);
      }
      ByHandleFileInformation info;
      if (!GetFileInformationByHandle(handle, out info)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read the file information of " + path);
      }
      return new uint[] { info.FileAttributes, info.NumberOfLinks };
    }
  }

  // Returns the SID_NAME_USE of an account: 1 is a user; groups, aliases
  // (BUILTIN\Users) and well-known groups (Everyone, LOCAL SERVICE) are not.
  public static int GetSidType(string sidValue) {
    SecurityIdentifier sid = new SecurityIdentifier(sidValue);
    byte[] bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    uint nameLength = 512;
    uint domainLength = 512;
    StringBuilder name = new StringBuilder((int) nameLength);
    StringBuilder domain = new StringBuilder((int) domainLength);
    int use;
    if (!LookupAccountSidW(null, bytes, name, ref nameLength, domain, ref domainLength, out use)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot look up the account type of " + sidValue);
    }
    return use;
  }

  public static void EnablePrivilege(string name) {
    IntPtr token;
    // TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY
    if (!OpenProcessToken(GetCurrentProcess(), 0x20 | 0x8, out token)) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open this process's token");
    }
    try {
      long luid;
      if (!LookupPrivilegeValueW(null, name, out luid)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unknown privilege " + name);
      }
      TokenPrivilege state = new TokenPrivilege();
      state.Count = 1;
      state.Luid = luid;
      state.Attributes = 0x2; // SE_PRIVILEGE_ENABLED
      if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enable " + name);
      }
      // AdjustTokenPrivileges succeeds with ERROR_NOT_ALL_ASSIGNED when the
      // token does not hold the privilege at all.
      int error = Marshal.GetLastWin32Error();
      if (error != 0) {
        throw new Win32Exception(error, "This process does not hold " + name);
      }
    } finally {
      CloseHandle(token);
    }
  }
}
'@
}

function Test-KlPathUnder {
  param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][string] $Root)
  $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase)
}

# Throws unless $Path is a plain folder or file: not a junction, symbolic
# link or other reparse point. GetAttributes reads the link itself, never
# its target.
function Assert-KlNotReparsePoint {
  param([Parameter(Mandatory)][string] $Path)
  $attributes = [IO.File]::GetAttributes($Path)
  if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "$Path is a junction, symbolic link or other reparse point. This script never follows one: nothing a King Louie install needs is one, and following it would change the ACLs of whatever it points at. Remove it (as an administrator) and run the script again."
  }
}

# Throws unless $Path is a plain file with exactly one name. A second hard
# link is the same file under another name, possibly outside this tree, so
# changing its owner or ACL here would change it there too.
function Assert-KlSingleLinkFile {
  param([Parameter(Mandatory)][string] $Path)
  $facts = [KlNative]::GetFileFacts($Path)
  if ($facts[0] -band [uint32] [IO.FileAttributes]::ReparsePoint) {
    throw "$Path is a symbolic link or other reparse point. This script never follows one. Remove it (as an administrator) and run the script again."
  }
  if ($facts[1] -gt 1) {
    throw "$Path has $($facts[1]) hard links: it is also reachable under another name, possibly outside this folder, and changing its ACL here would change it there too. Replace it with a plain copy (as an administrator) and run the script again."
  }
}

# Turns access rules into the SDDL of a DACL. -Kind picks the ACE flags:
#   Top      explicit, inherited by folders and files below   (OICI)
#   Folder   inherited from the parent, passed on again        (OICIID)
#   File     inherited from the parent                         (ID)
# Only plain Allow rules inherited by folders and files are accepted, the
# one shape this script grants, so what the walk writes as "inherited" is
# exactly what Windows would compute from the parent.
function ConvertTo-KlAceSddl {
  param(
    [Parameter(Mandatory)][Security.AccessControl.FileSystemAccessRule[]] $Rules,
    [Parameter(Mandatory)][ValidateSet('Top', 'Folder', 'File')][string] $Kind
  )
  $flags = @{ Top = 'OICI'; Folder = 'OICIID'; File = 'ID' }[$Kind]
  $aces = foreach ($rule in $Rules) {
    if ($rule.AccessControlType -ne 'Allow' -or $rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or $rule.PropagationFlags -ne 'None') {
      throw "Unsupported access rule for $($rule.IdentityReference): only Allow rules inherited by folders and files."
    }
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    '(A;{0};0x{1:x};;;{2})' -f $flags, [int] $rule.FileSystemRights, $ruleSid
  }
  -join $aces
}

# Locks the tree under $Path top-down, one folder at a time. For each folder:
# lock it first (owner $OwnerSid, verified by SID, and its DACL replaced),
# and only then list what is directly inside it. For each thing inside:
#   - a junction, symbolic link or other reparse point: throw, before
#     touching it or anything it points at;
#   - a file: throw if it has a second hard link, else make $OwnerSid its
#     owner and reset it to inherited-only;
#   - a folder in $DataFolders: lock the folder itself (owner, inherited-only
#     plus its extra rules) and never walk into it: its contents are the
#     runner's;
#   - any other folder: lock it the same way (inherited-only) and walk it.
# The top folder gets $TopRules, protected. $EnsureFolders and the
# $DataFolders keys are created, if missing, only once their parent is
# locked. Every lock goes through [KlNative]::LockItem, which changes one
# item and nothing below it. No call here recurses on its own (no takeown
# /R, no icacls recursion): both follow junctions out of the tree.
function Lock-KlAdminOwnedTree {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier] $OwnerSid,
    [Parameter(Mandatory)][Security.AccessControl.FileSystemAccessRule[]] $TopRules,
    [hashtable] $DataFolders = @{},
    [string[]] $EnsureFolders = @()
  )
  Initialize-KlNative
  $top = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $topDacl = 'D:PAI' + (ConvertTo-KlAceSddl -Rules $TopRules -Kind Top)
  $folderDacl = 'D:AI' + (ConvertTo-KlAceSddl -Rules $TopRules -Kind Folder)
  $fileDacl = 'D:AI' + (ConvertTo-KlAceSddl -Rules $TopRules -Kind File)
  $data = @{}
  foreach ($key in $DataFolders.Keys) {
    $data[[IO.Path]::GetFullPath($key).TrimEnd('\')] = 'D:AI' + (ConvertTo-KlAceSddl -Rules @($DataFolders[$key]) -Kind Top) + (ConvertTo-KlAceSddl -Rules $TopRules -Kind Folder)
  }
  # Every folder to create, with each missing ancestor between it and $top.
  $wanted = New-Object 'System.Collections.Generic.List[string]'
  foreach ($folder in @($EnsureFolders) + @($data.Keys)) {
    $full = [IO.Path]::GetFullPath($folder).TrimEnd('\')
    if (-not $full.StartsWith("$top\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "$full is not inside $top."
    }
    while ($full.Length -gt $top.Length) {
      if (-not $wanted.Contains($full)) { $wanted.Add($full) }
      $full = [IO.Path]::GetDirectoryName($full)
    }
  }

  if (-not (Test-Path -LiteralPath $top)) {
    if (-not $PSCmdlet.ShouldProcess($top, 'create the folder')) { return }
    [void] [IO.Directory]::CreateDirectory($top)
  }
  Assert-KlNotReparsePoint -Path $top
  if ($PSCmdlet.ShouldProcess($top, "make $OwnerSid the owner and replace the DACL with $topDacl")) {
    [KlNative]::LockItem($top, $true, $OwnerSid.Value, $topDacl)
  }

  $pending = New-Object System.Collections.Stack
  $pending.Push($top)
  while ($pending.Count -gt 0) {
    $dir = $pending.Pop()
    $children = @(Get-ChildItem -LiteralPath $dir -Force)
    foreach ($folder in $wanted) {
      if (-not [IO.Path]::GetDirectoryName($folder).Equals($dir, [StringComparison]::OrdinalIgnoreCase)) { continue }
      if (@($children | Where-Object { $_.FullName -eq $folder }).Count -gt 0) { continue }
      if ($PSCmdlet.ShouldProcess($folder, 'create the folder')) {
        [void] [IO.Directory]::CreateDirectory($folder)
        $children += Get-Item -LiteralPath $folder -Force
      }
    }
    foreach ($child in $children) {
      $full = $child.FullName
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Assert-KlNotReparsePoint -Path $full
      }
      if ($child.PSIsContainer) {
        $dataKey = @($data.Keys | Where-Object { $_ -eq $full })
        if ($dataKey.Count -gt 0) {
          if ($PSCmdlet.ShouldProcess($full, "make $OwnerSid the owner and replace the DACL with $($data[$dataKey[0]]) (contents not walked)")) {
            [KlNative]::LockItem($full, $true, $OwnerSid.Value, $data[$dataKey[0]])
          }
          continue
        }
        if ($PSCmdlet.ShouldProcess($full, "make $OwnerSid the owner and reset to inherited-only")) {
          [KlNative]::LockItem($full, $true, $OwnerSid.Value, $folderDacl)
        }
        $pending.Push($full)
      } else {
        Assert-KlSingleLinkFile -Path $full
        if ($PSCmdlet.ShouldProcess($full, "make $OwnerSid the owner and reset to inherited-only")) {
          [KlNative]::LockItem($full, $false, $OwnerSid.Value, $fileDacl)
        }
      }
    }
  }
}

# Walks $Path and everything under it (never through a reparse point: it
# throws on one instead) and throws, naming the path, unless every item is
# owned by $OwnerSid and grants no write-capable access to any SID other
# than SYSTEM or $OwnerSid. A $DataFolders folder and its contents may also
# grant write access to $DataWriterSid, and the contents' owner is not
# checked (the runner owns what it writes there).
function Confirm-KlTreeLockedDown {
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][Security.Principal.SecurityIdentifier] $OwnerSid,
    [string[]] $DataFolders = @(),
    [Security.Principal.SecurityIdentifier] $DataWriterSid
  )
  # GENERIC_WRITE (0x40000000) and GENERIC_ALL (0x10000000) are not
  # FileSystemRights names but can appear in an entry's mask.
  $writeMask = [int] [Security.AccessControl.FileSystemRights] 'WriteData, AppendData, WriteAttributes, WriteExtendedAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
  $writeMask = $writeMask -bor 0x40000000 -bor 0x10000000
  $top = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $dataRoots = @($DataFolders | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
  $pending = New-Object System.Collections.Stack
  $pending.Push((Get-Item -LiteralPath $top -Force))
  while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    $full = $item.FullName.TrimEnd('\')
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "$full is a junction, symbolic link or other reparse point; nothing under an admin-owned folder may be one. Remove it (as an administrator) and run the script again."
    }
    $inData = $false
    $insideData = $false
    foreach ($dataRoot in $dataRoots) {
      if (Test-KlPathUnder -Path $full -Root $dataRoot) {
        $inData = $true
        if (-not $full.Equals($dataRoot, [StringComparison]::OrdinalIgnoreCase)) { $insideData = $true }
      }
    }
    $acl = Get-Acl -LiteralPath $full
    # A NULL DACL (no DACL at all) grants everyone full access. .NET shows it
    # as one Everyone rule, which the write check below would catch too, but
    # this says what is actually wrong.
    $rawDescriptor = New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $rawDescriptor.DiscretionaryAcl) {
      throw "$full has no DACL at all (a NULL DACL), which grants everyone full access."
    }
    if (-not $insideData) {
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
      if ($owner.Value -ne $OwnerSid.Value) {
        throw "$full is not owned by $OwnerSid (owner is $owner)."
      }
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne 'Allow') { continue }
      if (([int] $rule.FileSystemRights -band $writeMask) -eq 0) { continue }
      $ruleSid = $rule.IdentityReference.Value
      if ($ruleSid -eq 'S-1-5-18' -or $ruleSid -eq $OwnerSid.Value) { continue }
      if ($inData -and $DataWriterSid -and $ruleSid -eq $DataWriterSid.Value) { continue }
      throw "$full grants write access to $ruleSid, which is not SYSTEM or $OwnerSid."
    }
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $full -Force)) { $pending.Push($child) }
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

# Creates $Path if it is missing and sets each grant with /grant:r. With
# -WhatIf it only prints the icacls call. Refuses a $Path that is a reparse
# point, like the walk does.
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
  if (Test-Path -LiteralPath $Path) { Assert-KlNotReparsePoint -Path $Path }
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

# Locks one admin-owned tree (Lock-KlAdminOwnedTree), then verifies all of
# it by hand (Confirm-KlTreeLockedDown). The owner is Administrators and the
# data folders' writer is the runner. With -WhatIf the walk prints each
# change and the verification does not run (nothing real to verify).
function Set-KlAdminOwnedTree {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string] $Path,
    [hashtable] $DataFolders = @{},
    [string[]] $EnsureFolders = @()
  )
  Lock-KlAdminOwnedTree -Path $Path -OwnerSid $AdminsSecurityId -TopRules $AdminOwnedTopRules -DataFolders $DataFolders -EnsureFolders $EnsureFolders
  if ($PSCmdlet.ShouldProcess($Path, 'verify the whole tree is locked down (Confirm-KlTreeLockedDown)')) {
    Confirm-KlTreeLockedDown -Path $Path -OwnerSid $AdminsSecurityId -DataFolders @($DataFolders.Keys) -DataWriterSid $RunnerSecurityId
  }
}

# Checks -Base and returns it normalized. -Base must be a real installation
# folder: rooted with a drive and a separator (a bare 'C:' is drive-relative,
# not a real path), not a drive root (every grant in -Role base would then
# apply to the whole drive instead of one folder), and outside
# $env:SystemRoot (Windows update and repair tooling depends on that tree
# keeping its own ACLs). Every path the script builds comes from the
# returned $baseFull, so a trailing '\' on -Base changes nothing.
#
# This script takes ownership of, and rewrites the ACLs under, whatever
# -Base names. If it already exists:
#   - it must not be a junction, symbolic link or other reparse point;
#   - its owner must be Administrators or SYSTEM, which is what an elevated
#     New-Item gives it (install guide section 3). A folder anyone else
#     created may have been filled, or had its ACL set, by that account
#     before this script ever ran, and the elevated steps that follow
#     (git clone, npm ci, this script) would then run what they put there;
#   - and it must be empty or look like a King Louie install (have
#     app\package.json), so a typo cannot hand this script someone's home
#     folder or another app's install directory.
function Resolve-KlBase {
  param([Parameter(Mandatory)][string] $Base)
  if ($Base -notmatch '^[A-Za-z]:[\\/]') {
    throw "-Base '$Base' must be rooted with a drive and a separator, e.g. C:\KingLouie (not just C:)."
  }
  $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\')
  $baseRoot = [System.IO.Path]::GetPathRoot($baseFull + '\').TrimEnd('\')
  if ($baseFull -eq $baseRoot) {
    throw "-Base '$Base' cannot be a drive root; use a subfolder such as $baseRoot\KingLouie."
  }
  $systemRootFull = [System.IO.Path]::GetFullPath($env:SystemRoot).TrimEnd('\')
  if (Test-KlPathUnder -Path $baseFull -Root $systemRootFull) {
    throw "-Base '$Base' cannot be under `$env:SystemRoot ($env:SystemRoot)."
  }
  if (Test-Path -LiteralPath $baseFull) {
    Assert-KlNotReparsePoint -Path $baseFull
    $baseOwner = (Get-Acl -LiteralPath $baseFull).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($baseOwner -ne 'S-1-5-32-544' -and $baseOwner -ne 'S-1-5-18') {
      throw "-Base '$Base' already exists and is owned by $baseOwner, not by Administrators or SYSTEM; refusing to trust a folder an administrator did not create. Move it aside, then create $baseFull again from an elevated PowerShell as install guide section 3 shows."
    }
    $hasChildren = @(Get-ChildItem -LiteralPath $baseFull -Force -ErrorAction Stop).Count -gt 0
    $looksLikeKingLouie = Test-Path -LiteralPath "$baseFull\app\package.json"
    if ($hasChildren -and -not $looksLikeKingLouie) {
      throw "-Base '$Base' already exists, is not empty, and has no app\package.json under it; refusing to take ownership of a folder that might not be the King Louie install. Point -Base at an empty folder or an existing King Louie install."
    }
  }
  $baseFull
}

# Throws unless $Sid is a single user account. A group (BUILTIN\Users,
# Everyone, Authenticated Users) or a service account (LOCAL SERVICE) as the
# runner would get Modify on mcp\data, which holds the MCP instance's master
# key, for every account in it.
function Assert-KlRunnerIsUser {
  param([Parameter(Mandatory)][Security.Principal.SecurityIdentifier] $Sid, [Parameter(Mandatory)][string] $Name)
  Initialize-KlNative
  $sidType = [KlNative]::GetSidType($Sid.Value)
  # SID_NAME_USE 1 is SidTypeUser.
  if ($sidType -ne 1) {
    throw "-Runner '$Name' ($($Sid.Value)) is not a user account (account type $sidType). Pass the one Windows user who runs Claude, as MACHINE\user or DOMAIN\user, never a group or a built-in account."
  }
}

# True when $Sid is a member of the local Administrators group, directly or
# through a nested group.
function Test-KlLocalAdministrator {
  param([Parameter(Mandatory)][Security.Principal.SecurityIdentifier] $Sid)
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement
  $context = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Machine)
  try {
    $group = [System.DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($context, [System.DirectoryServices.AccountManagement.IdentityType]::Sid, 'S-1-5-32-544')
    try {
      foreach ($member in $group.GetMembers($true)) {
        if ($member.Sid -and $member.Sid.Value -eq $Sid.Value) { return $true }
      }
      return $false
    } finally {
      $group.Dispose()
    }
  } finally {
    $context.Dispose()
  }
}

# gpu-box's Python venv (train.run, models.hf_download) is created from the
# interpreter recorded in its pyvenv.cfg. A per-user install lives under the
# runner's own profile, which none of this script's grants protect: the
# runner could repoint the venv at an interpreter under their control, or at
# one that can see packages outside the venv. Throws unless the cfg's home
# is under $AllUsersRoot (Python installed "for all users", guide section
# 2/6) and the venv does not include the system site-packages.
function Assert-KlAllUsersPythonVenv {
  param([Parameter(Mandatory)][string] $PyvenvCfg, [Parameter(Mandatory)][string] $AllUsersRoot)
  $cfgLines = @(Get-Content -LiteralPath $PyvenvCfg)
  $homeLine = $cfgLines | Where-Object { $_ -match '^\s*home\s*=\s*(.+?)\s*$' } | Select-Object -First 1
  $pyHome = if ($homeLine -and $homeLine -match '^\s*home\s*=\s*(.+?)\s*$') { [IO.Path]::GetFullPath($Matches[1]).TrimEnd('\') } else { '' }
  $root = [IO.Path]::GetFullPath($AllUsersRoot).TrimEnd('\')
  if (-not $pyHome -or -not (Test-KlPathUnder -Path $pyHome -Root $root)) {
    throw "$PyvenvCfg's home ('$pyHome') is not under $root. Reinstall Python 'for all users' (guide section 2) so the interpreter chain is admin-owned."
  }
  $systemSitePackages = $cfgLines | Where-Object { $_ -match '^\s*include-system-site-packages\s*=\s*true\s*$' }
  if ($systemSitePackages) {
    throw "$PyvenvCfg sets include-system-site-packages = true, which lets the venv import packages outside itself. Recreate the venv without --system-site-packages."
  }
}

# ---------------------------------------------------------------------------
# Checks, before anything changes.
# ---------------------------------------------------------------------------

$baseFull = Resolve-KlBase -Base $Base

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
Assert-KlRunnerIsUser -Sid $sid -Name $Runner

# UAC's default setting is not a security boundary: a program an
# administrator runs unelevated can elevate without a prompt the user
# notices, and an elevated Claude can change everything these ACLs protect.
# Warn, but go on: the ACLs are still worth having.
try {
  $runnerIsAdmin = Test-KlLocalAdministrator -Sid $sid
} catch {
  $runnerIsAdmin = $null
  Write-Warning "Could not check whether -Runner '$Runner' is a local administrator: $($_.Exception.Message)"
}
if ($runnerIsAdmin) {
  Write-Warning "-Runner '$Runner' is a member of the local Administrators group. These ACLs hold only while Claude runs unelevated, and with UAC at its default setting an administrator's programs can elevate without a real prompt. Make the runner a standard user, or at least set UAC to 'Always notify' (install guide section 2)."
}

$System = '*S-1-5-18'
$Admins = '*S-1-5-32-544'
$LocalService = '*S-1-5-19'
# Running again with a different -Runner does not remove the previous
# runner's explicit ACEs: /grant:r only replaces the entry for the account
# named in this call. After changing who runs Claude, remove the old
# runner's entry by hand from each folder this script grants it on:
# icacls <folder> /remove:g *<old runner's SID>. Those entries are explicit
# only on those folders; everything below them inherits.
$RunnerSid = "*$sid"

$pyvenvCfg = "$baseFull\tools\py\pyvenv.cfg"
if (Test-Path -LiteralPath $pyvenvCfg) {
  # $env:ProgramW6432 is the real 64-bit Program Files even when this script
  # runs as a 32-bit process on 64-bit Windows, where $env:ProgramFiles would
  # otherwise read "Program Files (x86)". Fall back to $env:ProgramFiles on a
  # 32-bit OS, where ProgramW6432 is not set.
  $allUsersRoot = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  Assert-KlAllUsersPythonVenv -PyvenvCfg $pyvenvCfg -AllUsersRoot $allUsersRoot
}

# An administrator holds these, but they start disabled. SeBackup lets the
# walk open an item with READ_CONTROL even when its DACL shuts
# Administrators out (a runner-planted item can); SeTakeOwnership lets it
# take a file the runner owns; SeRestore lets it set Administrators as the
# owner and write the DACL whatever the old DACL says. All three apply only
# to handles opened with FILE_FLAG_BACKUP_SEMANTICS, as LockItem's are.
Initialize-KlNative
[KlNative]::EnablePrivilege('SeBackupPrivilege')
[KlNative]::EnablePrivilege('SeTakeOwnershipPrivilege')
[KlNative]::EnablePrivilege('SeRestorePrivilege')

# ---------------------------------------------------------------------------
# Changes.
# ---------------------------------------------------------------------------

$AdminFull = @("${System}:(OI)(CI)F", "${Admins}:(OI)(CI)F")
$SystemSecurityId = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$AdminsSecurityId = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$RunnerSecurityId = New-Object Security.Principal.SecurityIdentifier($sid)
# The rule set every admin-owned tree's top folder gets: SYSTEM and
# Administrators keep full control, the runner can read and run but not
# write.
$AdminOwnedTopRules = @(
  (New-KlAccessRule $SystemSecurityId 'FullControl'),
  (New-KlAccessRule $AdminsSecurityId 'FullControl'),
  (New-KlAccessRule $RunnerSecurityId 'ReadAndExecute')
)
# The runner's own data folders: Modify, inherited by what it writes there.
$RunnerDataRules = @((New-KlAccessRule $RunnerSecurityId 'Modify'))

switch ($Role) {
  'base' {
    # Every runbook: the install folder. Only SYSTEM and Administrators can
    # change it; the runner can read the code and the MCP config but not
    # replace them. mcp\config holds node.yaml and runbooks/*.yaml, and
    # mcp\work is the folder steps start in: both inherit from $baseFull, so
    # the runner can neither loosen the policy nor plant a program there.
    # mcp\data is the stdio MCP instance's own data dir (its store and
    # master key): Administrators own the folder, the runner writes in it by
    # its Modify entry, and the walk never goes inside it.
    Set-KlAdminOwnedTree -Path $baseFull -DataFolders @{ "$baseFull\mcp\data" = $RunnerDataRules } -EnsureFolders @("$baseFull\mcp\config", "$baseFull\mcp\work")
    # The installed service runs as LOCAL SERVICE and must still read its
    # code once inheritance from C:\ is cut.
    Set-KlAcl -Path "$baseFull\app" -Grants @("${LocalService}:(OI)(CI)RX")
  }
  'gpu-box' {
    # models.hf_download and train.run start hf.exe and python.exe from the
    # venv under here; the runner must not be able to replace them.
    Set-KlAdminOwnedTree -Path "$baseFull\tools" -DataFolders @{}
    # models.hf_download writes its downloads here. Cutting inheritance
    # removes the Authenticated Users Modify entry a new folder on a data
    # drive inherits from the drive root; the runner keeps Modify by
    # explicit grant instead. This path is not inside $baseFull or D:\train,
    # so no walk reaches it: its ownership is left alone, since the runner
    # may already own the files it downloaded here.
    Set-KlAcl -Path 'D:\models' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)M")
    # train.run: train.py and the configs stay admin-owned; the runs folder
    # is training output. Locking D:\train also removes the Authenticated
    # Users Modify entry a new folder on a data drive inherits from the
    # drive root.
    Set-KlAdminOwnedTree -Path 'D:\train' -DataFolders @{ 'D:\train\runs' = $RunnerDataRules } -EnsureFolders @('D:\train\configs')
    Set-KlAdminOwnedTree -Path 'D:\train\configs' -DataFolders @{}
  }
  'laptop' {
    # laptop.build_then_deploy fetches, installs and builds here. The runner
    # clones it first, so git sees the runner as the folder's owner. This
    # path is not inside $baseFull or D:\train, so no walk reaches it:
    # cutting inheritance and granting Modify does not change who owns it,
    # and its ownership is deliberately left alone -- git needs to keep
    # owning its own checkout.
    if (-not (Test-Path -LiteralPath 'C:\build\site')) {
      throw 'C:\build\site does not exist. Clone your site repository there as the runner first (install guide section 6).'
    }
    Set-KlAcl -Path 'C:\build\site' -CutInheritance -Grants ($AdminFull + "${RunnerSid}:(OI)(CI)M")
  }
}
