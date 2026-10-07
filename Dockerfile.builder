# LicenseX with the "Build from source" feature: the normal image plus a JDK and Maven (and Gradle for Gradle projects).
# Bigger and needs more memory than the plain Dockerfile (give it 1 GB or more). See docs/BUILD.md.
FROM node:22-slim
RUN apt-get update \
 && (apt-get install -y --no-install-recommends openjdk-21-jdk-headless || apt-get install -y --no-install-recommends openjdk-17-jdk-headless) \
 && apt-get install -y --no-install-recommends maven ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server ./server
COPY web ./web
COPY package.json README.md DEPLOY.md licensex.config.example.json ./
ENV NODE_ENV=production PORT=3000 LICENSEX_DATA=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
