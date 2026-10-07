FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openjdk-21-jdk \
        maven \
        gradle \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

ENV NODE_ENV=production

RUN echo "Java:" && java -version \
    && echo "Maven:" && mvn -version \
    && echo "Gradle:" && gradle -version

EXPOSE 10000

CMD ["npm", "start"]
