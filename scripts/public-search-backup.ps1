[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet("backup", "restore")]
  [string]$Action = "backup",
  [string]$DatabasePath = "data\public-search.sqlite",
  [string]$BackupPath,
  [switch]$ServiceStopped,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Resolve-RepositoryPath([string]$Path) {
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\$Path"))
}

$database = Resolve-RepositoryPath $DatabasePath
if (-not $BackupPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $BackupPath = "backups\public-search-$stamp.sqlite"
}
$backup = Resolve-RepositoryPath $BackupPath

if ($Action -eq "backup") {
  if (-not $ServiceStopped) { throw "Stop public-search first, then rerun with -ServiceStopped. This cold backup preserves SQLite and WAL consistency." }
  if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Database not found: $database" }
  $backupDirectory = Split-Path -Parent $backup
  if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) { New-Item -ItemType Directory -Path $backupDirectory | Out-Null }
  if ((Test-Path -LiteralPath $backup) -and -not $Force) { throw "Backup already exists: $backup. Use -Force to replace it." }
  if ($PSCmdlet.ShouldProcess($backup, "Create cold SQLite backup from $database")) {
    Copy-Item -LiteralPath $database -Destination $backup -Force
    foreach ($suffix in "-wal", "-shm") {
      $source = "$database$suffix"
      if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination "$backup$suffix" -Force }
      else { Remove-Item -LiteralPath "$backup$suffix" -Force -ErrorAction SilentlyContinue }
    }
    "Created cold backup: $backup"
  }
}

if ($Action -eq "restore") {
  if (-not $ServiceStopped) { throw "Stop public-search first, then rerun with -ServiceStopped. Restoring while it is running can corrupt the database." }
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Backup not found: $backup" }
  if ((Test-Path -LiteralPath $database) -and -not $Force) { throw "Database already exists: $database. Stop public-search and use -Force to replace it." }
  if ($PSCmdlet.ShouldProcess($database, "Restore SQLite backup $backup")) {
    $databaseDirectory = Split-Path -Parent $database
    if (-not (Test-Path -LiteralPath $databaseDirectory -PathType Container)) { New-Item -ItemType Directory -Path $databaseDirectory | Out-Null }
    Copy-Item -LiteralPath $backup -Destination $database -Force
    foreach ($suffix in "-wal", "-shm") {
      $source = "$backup$suffix"
      if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination "$database$suffix" -Force }
      else { Remove-Item -LiteralPath "$database$suffix" -Force -ErrorAction SilentlyContinue }
    }
    "Restored $backup to $database. Start public-search only after this command completes."
  }
}
