#!/usr/bin/env bash
set -euo pipefail

echo "================================================================"
echo "    Numista Blockchain & Townforge Game VPS Auto-Provisioner    "
echo "================================================================"

# 1. Update and install prerequisites
echo "--> Updating packages..."
apt-get update -y
apt-get install -y curl wget git build-essential ufw nginx certbot python3-certbot-nginx

# 2. Install Node.js 20 LTS (if not present)
if ! command -v node &> /dev/null; then
    echo "--> Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"

# 3. Configure Firewall (UFW)
echo "--> Configuring Firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp       comment 'SSH'
ufw allow 80/tcp       comment 'HTTP'
ufw allow 443/tcp      comment 'HTTPS'
ufw allow 48080/tcp    comment 'Numista Testnet P2P'
# Note: 48081 (Daemon RPC) and 48083 (Wallet RPC) are strictly blocked from external access!
ufw --force enable

# 4. Create Service User & Directories
echo "--> Setting up numista user and paths..."
id -u numista &>/dev/null || useradd -r -m -s /bin/bash numista

mkdir -p /var/lib/numista/data
mkdir -p /var/lib/numista/wallets
mkdir -p /var/lib/numista/ringdb
mkdir -p /var/log/numista
mkdir -p /etc/numista
mkdir -p /var/www/townforge-numista

chown -R numista:numista /var/lib/numista /var/log/numista /etc/numista /var/www/townforge-numista
chmod 700 /etc/numista /var/lib/numista/wallets

# 5. Instructions for copying binaries and files
echo ""
echo "================================================================"
echo "  NEXT STEPS TO FINISH DEPLOYMENT:                              "
echo "================================================================"
echo "1. Copy Linux binaries ('monerod' and 'monero-wallet-rpc') to:"
echo "   /usr/local/bin/monerod"
echo "   /usr/local/bin/monero-wallet-rpc"
echo "   chmod +x /usr/local/bin/monerod /usr/local/bin/monero-wallet-rpc"
echo ""
echo "2. Copy your wallet files ('townforge', 'townforge.keys') to:"
echo "   /var/lib/numista/wallets/"
echo "   chown -R numista:numista /var/lib/numista/wallets"
echo ""
echo "3. Write your wallet password to:"
echo "   echo 'YOUR_PASSWORD' > /etc/numista/wallet-pass.txt"
echo "   chmod 600 /etc/numista/wallet-pass.txt"
echo "   chown numista:numista /etc/numista/wallet-pass.txt"
echo ""
echo "4. Copy game repo to /var/www/townforge-numista:"
echo "   cd /var/www/townforge-numista"
echo "   npm install && npm run build"
echo "   chown -R numista:numista /var/www/townforge-numista"
echo ""
echo "5. Install systemd services and Nginx configuration:"
echo "   cp deploy/numistad.service /etc/systemd/system/"
echo "   cp deploy/numista-wallet-rpc.service /etc/systemd/system/"
echo "   cp deploy/townforge-game.service /etc/systemd/system/"
echo "   cp deploy/nginx-townforge.conf /etc/nginx/sites-available/townforge"
echo "   ln -sf /etc/nginx/sites-available/townforge /etc/nginx/sites-enabled/"
echo "   systemctl daemon-reload"
echo "   systemctl enable --now numistad"
echo "   systemctl enable --now numista-wallet-rpc"
echo "   systemctl enable --now townforge-game"
echo "   systemctl restart nginx"
echo ""
echo "6. Obtain SSL Certificate:"
echo "   certbot --nginx -d YOUR_DOMAIN.COM"
echo "================================================================"
