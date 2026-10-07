#!/bin/sh
# Starts LicenseX. Needs Node.js 22.13 or newer: https://nodejs.org
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then echo "Node.js 22.13 or newer is required: https://nodejs.org"; exit 1; fi
exec node server/index.js
