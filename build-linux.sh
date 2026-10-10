#!/bin/bash
# Build Linux single-file binary (no Node/npm needed at runtime).
# Requires: Node.js + opencode installed on the BUILD machine only.
set -e
cd "$(dirname "$0")"
mkdir -p dist

echo "[1/4] bundling with esbuild..."
npx -y esbuild oc-api-proxy.mjs --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs

echo "[2/4] generating SEA blob..."
node --experimental-sea-config sea-config.json

echo "[3/4] copying node binary..."
NODE_EXE="$(command -v node)"
cp "$NODE_EXE" dist/oc-api-proxy

echo "[4/4] injecting blob..."
FUSE="$(node scripts/get-fuse.cjs)"
npx -y postject dist/oc-api-proxy NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse "$FUSE"

chmod +x dist/oc-api-proxy
echo ""
echo "DONE: dist/oc-api-proxy"
