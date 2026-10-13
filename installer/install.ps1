# Podcast Kurgu Asistani - elle kurulum betigi (setup.exe kullanmadan)
# Kullanim:  sag tik > "PowerShell ile calistir"  ya da  install.bat
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$extId = 'com.podcastkurgu.panel'
$src = Join-Path $PSScriptRoot '..\extension'
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\$extId"

if ($Uninstall) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Write-Host 'Eklenti kaldirildi.' -ForegroundColor Green
    exit 0
}

if (-not (Test-Path (Join-Path $src 'CSXS\manifest.xml'))) {
    throw "extension klasoru bulunamadi: $src"
}

Write-Host "Eklenti kopyalaniyor: $dest"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force

# Imzasiz CEP uzantilarina izin ver
foreach ($v in 9..13) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}

Write-Host ''
Write-Host 'Kurulum tamamlandi.' -ForegroundColor Green
Write-Host 'Premiere Pro > Pencere (Window) > Uzantilar (Extensions) > Podcast Kurgu Asistani'
Write-Host 'FFmpeg, Whisper ve modeli panelin "Ayarlar" sekmesinden indirebilirsiniz.'
