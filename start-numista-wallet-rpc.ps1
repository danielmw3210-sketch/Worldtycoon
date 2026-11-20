$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir
$envFile = Join-Path $projectDir '.env'

# Import local settings; process environment values take precedence.
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

$walletExe = $env:NUMISTA_WALLET_RPC_EXE
if (-not $walletExe) {
  $nodeExe = $env:NUMISTA_NODE_EXE
  if (-not $nodeExe) { throw 'Set NUMISTA_WALLET_RPC_EXE or NUMISTA_NODE_EXE in .env.' }
  $walletExe = Join-Path (Split-Path -Parent $nodeExe) 'monero-wallet-rpc.exe'
}
$walletExe = [System.IO.Path]::GetFullPath($walletExe)
if (-not (Test-Path -LiteralPath $walletExe)) { throw "Wallet RPC executable not found at '$walletExe'." }

$walletFile = $env:NUMISTA_ISSUER_WALLET
if (-not $walletFile) { $walletFile = 'admin' }
if (-not [System.IO.Path]::IsPathRooted($walletFile)) {
  $walletDir = $env:NUMISTA_WALLET_DIR
  if (-not $walletDir) { $walletDir = $projectDir }
  $walletFile = Join-Path $walletDir $walletFile
}
$walletFile = [System.IO.Path]::GetFullPath($walletFile)
if (-not (Test-Path -LiteralPath $walletFile) -and -not (Test-Path -LiteralPath "$walletFile.keys")) {
  throw "Issuer wallet file not found. Set NUMISTA_ISSUER_WALLET to its wallet-file path; the secret wallet file stays outside Git."
}

$walletArguments = @(
  '--numista-testnet',
  '--daemon-address', '127.0.0.1:48081',
  '--rpc-bind-ip', '127.0.0.1',
  '--rpc-bind-port', '48083',
  '--wallet-file', $walletFile
)
$passwordFile = $env:NUMISTA_WALLET_PASSWORD_FILE
if ($passwordFile) {
  $passwordFile = [System.IO.Path]::GetFullPath($passwordFile)
  if (-not (Test-Path -LiteralPath $passwordFile)) { throw 'NUMISTA_WALLET_PASSWORD_FILE does not exist.' }
  $walletArguments += @('--password-file', $passwordFile)
}

Write-Host "Starting private Numista wallet RPC: $walletExe"
Write-Host 'Wallet RPC is loopback-only at 127.0.0.1:48083; wallet credentials are not printed.'
Write-Host 'Run in this terminal to view wallet RPC output; press Ctrl+C to stop.'
& $walletExe @walletArguments
exit $LASTEXITCODE
