#!/usr/bin/env bash
# Builds the thin-client plugin jar AND compiles the server-side feature classes.
#   ./build.sh [path/to/paper-api.jar]
# After it runs:
#   target/MyPlugin-1.0.0.jar   -> upload to LicenseX as a product
#   server-out/*.class          -> copy into your LicenseX server's remote class store (server/prototype/remote/)
set -euo pipefail
cd "$(dirname "$0")"
API="${1:-$(ls ~/.m2/repository/io/papermc/paper/paper-api/*/paper-api-*.jar 2>/dev/null | grep -v sources | head -1)}"
[ -f "$API" ] || { echo "Pass a Paper API jar: ./build.sh path/to/paper-api.jar" >&2; exit 1; }

echo "1/2  Building the plugin jar (the server-side classes are NOT included)..."
mvn -B -q package

echo "2/2  Compiling the server-side feature classes into ./server-out ..."
rm -rf server-out && mkdir -p server-out
javac --release 8 -cp "$API:target/MyPlugin-1.0.0.jar" -d server-out $(find server-src -name '*.java')

echo
echo "Done."
echo "  Plugin jar:     target/MyPlugin-1.0.0.jar   (upload to LicenseX as a product)"
echo "  Server classes: server-out/                 (copy the .class files into LicenseX server/prototype/remote/)"
