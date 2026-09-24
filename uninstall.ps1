# Uninstall dsh-billing from a DSH profile (idempotent).
#
# Mirrors install.ps1: the official removal path is
#     dsh plugin --profile <name> remove dsh-billing
# which drops the dependency and removes the package from dsh.profile.bundles,
# so DSH stops applying our cordis.patch.yml layer.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# NOTE (why comments here are ASCII-only):
#   Windows PowerShell 5.1 reads .ps1 files using the ANSI code page unless the file
#   has a UTF-8 BOM. A multi-byte UTF-8 character inside a comment can decode to bytes
#   that unbalance quotes/brackets and break the whole script at parse time. Keep this
#   file ASCII-only, or always save it as UTF-8 *with* BOM.
[CmdletBinding()]
param(
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgName = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).name

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'the dsh command was not found on PATH; run this from a shell where `dsh` works'
}

& dsh plugin --profile $Profile remove $pkgName
if ($LASTEXITCODE -ne 0) { throw ('dsh plugin remove failed with exit code ' + $LASTEXITCODE) }

# pnpm leaves the node_modules symlink behind after a remove. Drop it so a later
# reinstall starts from a clean slate; never touch a real directory.
$profileDir = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $Profile)
$link = Join-Path (Join-Path $profileDir 'node_modules') $pkgName
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Remove-Item $link -Force -Recurse
    Write-Host ('removed leftover link: ' + $link)
  } else {
    Write-Host ('skip: ' + $link + ' is not a link, not removed')
  }
}

Write-Host 'Uninstalled. Refresh the page; if it does not take effect, restart dsh web.'
