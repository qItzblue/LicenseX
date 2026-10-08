# LicenseX with the "Build from source" feature: the normal image plus Java (JDK), Maven and Gradle.
# Bigger than the plain Dockerfile and it needs more memory while a build runs. See docs/BUILD.md.
FROM node:22-slim

# JDK 21 (or 17 where 21 is not packaged), Maven, and the tools to fetch Gradle.
RUN apt-get update \
 && (apt-get install -y --no-install-recommends openjdk-21-jdk-headless || apt-get install -y --no-install-recommends openjdk-17-jdk-headless) \
 && apt-get install -y --no-install-recommends maven curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Gradle from gradle.org (the apt version is far too old for current Java). Pinned and checksum-verified.
ARG GRADLE_VERSION=8.10.2
ARG GRADLE_SHA256=31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26
RUN curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
 && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
 && unzip -q /tmp/gradle.zip -d /opt \
 && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
 && rm /tmp/gradle.zip \
 && java -version && mvn -version && gradle --version

WORKDIR /app
COPY server ./server
COPY web ./web
COPY package.json README.md DEPLOY.md licensex.config.example.json ./
ENV NODE_ENV=production PORT=3000 LICENSEX_DATA=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
