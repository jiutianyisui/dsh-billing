# Uninstall the dsh-billing plugin: remove the junction from the profile's
# node_modules and the marked block from cordis.patch.yml.
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
$utf8 = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgName = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).name
$profileDir = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $Profile)

$link = Join-Path (Join-Path $profileDir 'node_modules') $pkgName
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Remove-Item $link -Force -Recurse
    Write-Host ('removed link: ' + $link)
  } else {
    Write-Host ('skip: ' + $link + ' is not a link, not removed')
  }
}

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchPath) {
  $patch = Get-Content $patchPath -Raw -Encoding utf8
  $pattern = [regex]::Escape('# >>> dsh-billing') + '(?s).*?' + [regex]::Escape('# <<< dsh-billing') + '\r?\n?'
  $next = [regex]::Replace($patch, $pattern, '')
  if ($next -ne $patch) {
    [IO.File]::WriteAllText($patchPath, $next, $utf8)
    Write-Host ('patched: ' + $patchPath)
  } else {
    Write-Host 'no dsh-billing block found in the patch file'
  }
}

Write-Host 'Uninstalled. Refresh the page; if it does not take effect, restart dsh web.'
