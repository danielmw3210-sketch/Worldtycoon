# Connect Local Numista Node to Online Seed Node
param(
    [Parameter(Mandatory=$true)]
    [string]$SeedHost
)

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectDir '..\..\scratch\townforge-numista\.env'

if (-not (Test-Path $envFile)) {
    $envFile = ".\.env"
}

Write-Host "Updating seed node peer in $envFile ..." -ForegroundColor Cyan

$content = Get-Content $envFile
$peerLine = "NUMISTA_NODE_PEERS=$SeedHost:48080"

if ($content -match '^NUMISTA_NODE_PEERS=') {
    $content = $content -replace '^NUMISTA_NODE_PEERS=.*$', $peerLine
} else {
    $content += $peerLine
}

$content | Set-Content $envFile -Encoding UTF8
Write-Host "Configured peer: $SeedHost:48080" -ForegroundColor Green
Write-Host "You can now run .\start-numista-node.ps1 to join the online testnet!" -ForegroundColor Yellow
