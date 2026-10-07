# Build from source

Upload your plugin's source as a zip; LicenseX inspects it, compiles it, and gives you the jar. One click then turns that
jar into a product with licensed downloads.

Admin panel -> **Build**. This is **owner-only**: customers of a paid LicenseX never see it, because it runs build tools on the server.

## The flow

1. **Upload** a `.zip` of a **Maven** (`pom.xml`) or **Gradle** (`build.gradle`) project. A top-level folder inside the zip is fine.
2. **Inspection** (nothing is built or run yet). LicenseX unpacks the zip safely and reports:
   - project type, Java version, API dependency (Paper/Spigot/Bukkit/...);
   - the plugin's `name`, `version`, `main`, `api-version`, and whether the main class exists in the source;
   - counts of source files and lines;
   - **things worth a look**: calls to run operating-system commands, load classes at runtime, run scripts, grant op, stop
     the JVM, open network connections, hide large encoded strings, plus build scripts that run commands;
   - every web address found in the code that is not a well-known one.
3. **Build.** Press *Build jar*. If anything is *High*, you must first tick *I have read the findings and trust this code*.
   The log updates live. First builds download dependencies and can take a few minutes.
4. **Result:** download the jar, or **Use as product** (new product, or replace the file of an existing one). The product
   is analysed for license wrapping straight away. Jars and logs are deleted after 24 hours and when the server restarts.

## What this does and doesn't protect you from

Compiling code means running build tooling, and build tooling can run arbitrary code. LicenseX reduces the risk but
**it is not a sandbox**:

- Nothing runs until you press Build, and risky projects need an explicit confirmation.
- The build runs in a private temp folder with a minimal environment: your admin password, OAuth secrets and other
  `LICENSEX_*` settings are **not** passed to it. It has a 10-minute limit and only one build runs at a time.
- Zips are unpacked defensively: path traversal, symlinks, encrypted entries, zip bombs (size and file-count limits) are refused.
- The scan is a heuristic. A clean report does not mean the code is safe, and a finding does not mean it is malicious.

What it **cannot** stop: a malicious project running code during the build with the same operating-system rights as
LicenseX, which includes reading the `data/` folder (your licenses). So:

- **Only build code you wrote or trust.** Do not offer this feature to other people on a server that holds your licenses.
- For anything less trusted, run LicenseX's build feature on a separate machine/container that has no licenses on it.

## Installing the tools

The build feature needs a **JDK** (17 or 21, matching your plugin) and **Maven** (and **Gradle** for Gradle projects).
The Build page shows which ones the server has. Without them it still lets you upload and inspect.

- **Your own PC / a VPS:** install a JDK and Maven (`sudo apt install openjdk-21-jdk-headless maven` on Ubuntu/Debian).
- **Docker:** use `Dockerfile.builder` instead of `Dockerfile`. It adds a JDK and Maven. It is bigger and needs more memory
  (1 GB or more), so it will not fit Render's free plan.
- **Gradle projects:** install `gradle`, or tick *trust* and the project's own `gradlew` wrapper is used.
- Builds download dependencies from the internet (Maven Central, repo.papermc.io, ...), so the server needs outbound access.
- Environment: `LICENSEX_BUILD_M2` can point at an existing Maven repository folder to reuse its downloads.

## Tests

`npm test` includes fast tests for zip safety and the inspector. `npm run test:build` runs real Maven and Gradle builds
through the API (needs a JDK, Maven or Gradle, and internet).
