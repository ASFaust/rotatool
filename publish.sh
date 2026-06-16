#!/usr/bin/env bash
# Build the app and publish the static files to the Hetzner server (rotatool.asfaust.de).
set -euo pipefail

cd "$(dirname "$0")"

npm run build
rsync -avz --delete dist/ cog-raw:/var/www/rotatool/

echo "Published to https://rotatool.asfaust.de"
