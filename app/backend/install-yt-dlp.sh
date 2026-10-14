#!/bin/bash
#
# Install yt-dlp - The most reliable YouTube downloader
#
# This script installs yt-dlp on your server
# Works on Linux (Ubuntu, Debian, CentOS, etc.)
#

set -e  # Exit on error

echo "==================================="
echo "Installing yt-dlp"
echo "==================================="
echo ""

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Cannot detect OS"
    exit 1
fi

echo "Detected OS: $OS"
echo ""

# Method 1: Try package manager first (easiest)
echo "Attempting installation via package manager..."

if command -v apt &> /dev/null; then
    echo "Using apt (Debian/Ubuntu)..."
    sudo apt update
    sudo apt install -y yt-dlp || {
        echo "apt installation failed, trying alternative method..."
    }
elif command -v yum &> /dev/null; then
    echo "Using yum (CentOS/RHEL)..."
    sudo yum install -y yt-dlp || {
        echo "yum installation failed, trying alternative method..."
    }
elif command -v dnf &> /dev/null; then
    echo "Using dnf (Fedora)..."
    sudo dnf install -y yt-dlp || {
        echo "dnf installation failed, trying alternative method..."
    }
fi

# Check if installed
if command -v yt-dlp &> /dev/null; then
    echo ""
    echo "✓ yt-dlp installed successfully via package manager!"
    yt-dlp --version
    echo ""
    echo "Installation complete!"
    exit 0
fi

# Method 2: Download binary directly (most reliable)
echo ""
echo "Installing yt-dlp binary directly..."

# Download latest release
echo "Downloading latest yt-dlp release..."
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp

# Make executable
sudo chmod +x /usr/local/bin/yt-dlp

# Verify installation
if command -v yt-dlp &> /dev/null; then
    echo ""
    echo "✓ yt-dlp installed successfully!"
    yt-dlp --version
    echo ""
    echo "==================================="
    echo "Installation complete!"
    echo "==================================="
    exit 0
else
    echo ""
    echo "❌ Installation failed!"
    echo ""
    echo "Please install manually:"
    echo "  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp"
    echo "  chmod +x /usr/local/bin/yt-dlp"
    echo ""
    echo "Or with pip:"
    echo "  pip install yt-dlp"
    exit 1
fi
