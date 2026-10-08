# LicenseX: no build step and no npm dependencies.
FROM node:22-slim
WORKDIR /app
COPY server ./server
COPY web ./web
COPY package.json README.md DEPLOY.md licensex.config.example.json ./
ENV NODE_ENV=production PORT=3000 LICENSEX_DATA=/data TRUST_PROXY=1
# Licenses live in /data: mount a persistent volume here or they are lost when the container is replaced.
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
