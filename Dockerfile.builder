FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jdk-headless \
    maven \
    gradle \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json yarn.lock* ./
RUN yarn install

COPY . .

ENV NODE_ENV=production
ENV PORT=10000

RUN java -version
RUN mvn -version
RUN gradle -version

EXPOSE 10000

CMD ["yarn", "start"]
