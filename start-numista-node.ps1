$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $projectDir '.env'

# Import the same simple KEY=VALUE settings used by server/config.js.
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $name = $Matches[1]
      if ([Environment]::GetEnvironmentVariable($name, 'Process')) { continue }
      $value = $Matches[2]
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      } else {
        $value = ($value -replace '\s+#.*$', '').Trim()
      }
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

$nodeExe = $env:NUMISTA_NODE_EXE
if (-not $nodeExe) {
  $nodeExe = Join-Path $projectDir '..\..\New folder\numista-windows-x64\monerod.exe'
}
$nodeExe = [System.IO.Path]::GetFullPath($nodeExe)
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Numista daemon not found at '$nodeExe'. Set NUMISTA_NODE_EXE in .env."
}

$dataDir = $env:NUMISTA_NODE_DATA_DIR
if (-not $dataDir) { $dataDir = Join-Path $env:LOCALAPPDATA 'Numista\numista-testnet-v2' }
$dataDir = [System.IO.Path]::GetFullPath($dataDir)

$outPeers = 24
if ($env:NUMISTA_OUT_PEERS) { $outPeers = [int]$env:NUMISTA_OUT_PEERS }
$inPeers = 64
if ($env:NUMISTA_IN_PEERS) { $inPeers = [int]$env:NUMISTA_IN_PEERS }
if ($outPeers -lt 1 -or $outPeers -gt 200) { throw 'NUMISTA_OUT_PEERS must be between 1 and 200.' }
if ($inPeers -lt 0 -or $inPeers -gt 1000) { throw 'NUMISTA_IN_PEERS must be between 0 and 1000.' }

$peers = @()
if ($env:NUMISTA_NODE_PEERS) {
  $peers = @($env:NUMISTA_NODE_PEERS -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$threads = 4
if ($env:NUMISTA_MINING_THREADS) { $threads = [int]$env:NUMISTA_MINING_THREADS }
if ($threads -lt 1 -or $threads -gt [Environment]::ProcessorCount) {
  throw "NUMISTA_MINING_THREADS must be between 1 and $([Environment]::ProcessorCount) on this PC."
}

$daemonArguments = @(
  '--numista-testnet',
  '--rpc-bind-ip', '127.0.0.1',
  '--data-dir', $dataDir,
  '--out-peers', "$outPeers",
  '--in-peers', "$inPeers",
  '--rpc-max-connections', '100',
  '--rpc-max-connections-per-private-ip', '100'
)
foreach ($peer in $peers) { $daemonArguments += @('--add-peer', $peer) }

$miningAddress = ($env:NUMISTA_MINING_ADDRESS | ForEach-Object { $_.Trim() })
if ($miningAddress) {
  $daemonArguments += @('--start-mining', $miningAddress, '--mining-threads', "$threads")
} else {
  Write-Warning 'No NUMISTA_MINING_ADDRESS is set; the daemon will run without block mining.'
}
if ($peers.Count -eq 0) {
  Write-Warning 'No Numista seed peers are configured. Add known host:48080 peers in NUMISTA_NODE_PEERS or this node will remain isolated.'
}

Write-Host "Starting Numista testnet daemon: $nodeExe"
Write-Host "Using fresh/versioned testnet data directory: $dataDir"
Write-Host "Peer limits: $outPeers outbound, $inPeers inbound; configured bootstrap peers: $($peers.Count)"
if ($miningAddress) { Write-Host "Block mining threads: $threads" }
Write-Host 'RPC is bound to loopback on Numista port 48081. P2P listens on port 48080.'
Write-Host 'Run in this terminal to view daemon output; press Ctrl+C to stop.'
& $nodeExe @daemonArguments
exit $LASTEXITCODE
