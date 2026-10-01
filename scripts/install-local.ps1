# Builds Glassbox and installs it to %LOCALAPPDATA%\Programs\Glassbox, with a Start menu shortcut.
# Run: npm run install:local   (close Glassbox first; open sessions would be lost)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Glassbox'

if (Get-Process Glassbox -ErrorAction SilentlyContinue) {
  Write-Host 'Glassbox is running. Close it, then run this again.'
  exit 1
}

Push-Location $root
try { npm run dist; if ($LASTEXITCODE -ne 0) { throw 'Build failed' } } finally { Pop-Location }

New-Item -ItemType Directory -Force $dest | Out-Null
robocopy (Join-Path $root 'release\win-unpacked') $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit $LASTEXITCODE)" }

$exe = Join-Path $dest 'Glassbox.exe'
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Glassbox.lnk'))
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $dest
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = 'Glassbox: run Claude with full visibility'
$shortcut.Save()

Write-Host "Installed to $dest"
Start-Process $exe
