#!/usr/bin/env bash
# Builds hello-plugin.jar (a plugin that knows nothing about LicenseX). Needs the paper-api classpath in $CP.
set -euo pipefail
cd "$(dirname "$0")"
CP="${CP:-$(cat /tmp/pcp.txt)}"
rm -rf build && mkdir -p build/classes
javac --release 17 -cp "$CP" -d build/classes src/com/acme/hello/HelloPlugin.java
cp plugin.yml config.yml build/classes/
jar cf hello-plugin.jar -C build/classes .
rm -rf build
ls -la hello-plugin.jar
