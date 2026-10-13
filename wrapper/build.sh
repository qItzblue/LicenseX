#!/usr/bin/env bash
# Compiles the wrapper classes LicenseX injects into customer plugins and writes them to server/wrapper/.
# The .class files are committed, so running LicenseX needs only Node. Re-run this after editing wrapper/src.
# Usage: wrapper/build.sh [path/to/bukkit-or-paper-api.jar]
set -euo pipefail
cd "$(dirname "$0")/.."
API="${1:-$(ls ~/.m2/repository/io/papermc/paper/paper-api/*/paper-api-*.jar 2>/dev/null | grep -v sources | head -1)}"
[ -f "$API" ] || { echo "Pass a Bukkit/Spigot/Paper API jar: wrapper/build.sh path/to/api.jar" >&2; exit 1; }
OUT=server/wrapper
rm -rf "$OUT" && mkdir -p "$OUT"
# Target Java 8 bytecode (major version 52) so wrapped plugins load on any server JVM.
javac --release 8 -Xlint:-options -encoding UTF-8 -cp "$API" -d "$OUT" wrapper/src/dev/licensex/wrap/*.java
# Flatten: only the file names are needed, the package is fixed by the class contents.
find "$OUT" -name '*.class' -exec mv {} "$OUT"/ \; && find "$OUT" -mindepth 1 -type d -empty -delete
ls -la "$OUT"
