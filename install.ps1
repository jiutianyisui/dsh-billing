# Install dsh-billing into a DSH profile as a *bundle* (idempotent).
#
# Why this is not a manual junction + patch edit anymore:
#   The package declares `dsh.bundle.patch` in package.json. The official way to
#   install such a package is:
#       dsh plugin --profile <name> add <dir>
#   which delegates to the profile's own pnpm. It does two things for us:
#     1) records the dependency in the profile package.json
#        ("dsh-billing": "link:<this directory>")
#     2) appends "dsh-billing" to dsh.profile.bundles
#   DSH then applies our cordis.patch.yml automatically as one profile layer.
#
#   Hand-editing the profile's cordis.patch.yml (what this script used to do)
#   bypasses dsh.profile.bundles, so pnpm could drop the link on its next
#   install and the plugin would silently disappear. Do not go back to that.
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
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# The bundle patch must exist, or DSH refuses the package as a bundle.
$patchFile = Join-Path $root 'cordis.patch.yml'
if (-not (Test-Path $patchFile)) {
  throw 'cordis.patch.yml is missing: the package cannot be installed as a bundle without it'
}

# Keep the old guard: a browser-half artifact is the cheapest proof build.ps1 ran.
$clientBundle = Join-Path $root 'lib\client.js'
if (-not (Test-Path $clientBundle)) { throw 'lib\client.js not found: run build.ps1 first' }

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'the dsh command was not found on PATH; run this from a shell where `dsh` works'
}

Write-Host ('adding bundle from: ' + $root)
Write-Host ('to profile: ' + $Profile)

# --profile is a required flag on the dsh CLI; everything after it goes to the
# profile's pnpm. A local directory is passed straight through.
& dsh plugin --profile $Profile add $root
if ($LASTEXITCODE -ne 0) { throw ('dsh plugin add failed with exit code ' + $LASTEXITCODE) }

Write-Host ''
Write-Host 'Installed as a profile bundle. Now:'
Write-Host '  1) refresh the browser page (dsh web recomposes the plugin graph)'
Write-Host '  2) if it still does not show up, restart dsh web'
Write-Host ''
Write-Host 'Verify it registered:'
Write-Host ('  dsh plugin --profile ' + $Profile + ' list')
