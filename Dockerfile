# Base Node image
FROM node:20-bookworm

# Install JDK 17, Maven, Gradle, and required dependencies
RUN apt-get update && \
    apt-get install -y openjdk-17-jdk maven gradle wget unzip git && \
    rm -rf /var/lib/apt/lists/*

# Set Environment Variables for Java
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="$JAVA_HOME/bin:${PATH}"

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Expose port and start application
EXPOSE 3000
CMD ["npm", "start"]
