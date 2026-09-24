# Install the dsh-billing plugin into DSH's web profile (idempotent):
#   1) create a junction under the profile's node_modules pointing at this directory
#      (node resolves the package by name through it)
#   2) insert a marked plugin entry into the profile's cordis.patch.yml
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# Undo:   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# NOTE (why comments here are ASCII-only):
#   Windows PowerShell 5.1 reads .ps1 files using the ANSI code page unless the file
#   has a UTF-8 BOM. A multi-byte UTF-8 character inside a comment can decode to bytes
#   that unbalance quotes/brackets and break the whole script at parse time. Keep this
#   file ASCII-only, or always save it as UTF-8 *with* BOM.
[CmdletBinding()]
param(
  # Target profile name (default 'web', the one `dsh web` uses)
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgName = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).name
$profileDir = Join-Path $env:USERPROFILE ('.dsh\profiles\' + $Profile)
if (-not (Test-Path $profileDir)) { throw ('profile not found: ' + $profileDir) }

$clientBundle = Join-Path $root 'lib\client.js'
if (-not (Test-Path $clientBundle)) { throw 'lib\client.js not found: run build.ps1 first' }

# ---- 1) node_modules link ------------------------------------------------------
$modules = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Force -Path $modules | Out-Null
$link = Join-Path $modules $pkgName
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') {
    throw ($link + ' exists and is not a link: inspect and remove it manually; install.ps1 will not overwrite a real directory')
  }
  Remove-Item $link -Force -Recurse
}
New-Item -ItemType Junction -Path $link -Target $root | Out-Null
Write-Host ('linked: ' + $link + '  ->  ' + $root)

# ---- 2) profile patch entry ----------------------------------------------------
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$patch = if (Test-Path $patchPath) { Get-Content $patchPath -Raw -Encoding utf8 } else { '' }
$begin = '# >>> dsh-billing'
$end = '# <<< dsh-billing'
# Pitfall: inside @( ) the comma binds tighter than +, so `$begin + 'x'` becomes an
# array append and the emitted YAML splits into two lines and fails to parse.
# One element per line, no concatenation inside the array literal.
$block = @(
  '',
  $begin,
  '- insert:',
  ('    - id: ' + $pkgName),
  ('      name: ' + $pkgName),
  $end,
  ''
) -join "`n"

# Drop any previous block (idempotent), then append the new one: the top level is a
# YAML array, so an extra `- insert:` item is valid.
$pattern = [regex]::Escape($begin) + '(?s).*?' + [regex]::Escape($end) + '\r?\n?'
$patch = [regex]::Replace($patch, $pattern, '')
if (-not $patch.EndsWith("`n")) { $patch += "`n" }
$patch += $block
[IO.File]::WriteAllText($patchPath, $patch, $utf8)
Write-Host ('patched: ' + $patchPath)

Write-Host ''
Write-Host 'Installed. Now:'
Write-Host '  1) refresh the browser page (dsh web recomposes the plugin graph and serves the new client.js)'
Write-Host '  2) if it still does not show up, restart dsh web (new plugin entries need a new Loader composition)'
