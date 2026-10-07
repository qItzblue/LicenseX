# 1. Start with your app's base environment (Assuming Node.js here)
FROM node:18-bullseye

# 2. Install Java (JDK 17) and Maven
RUN apt-get update && \
    apt-get install -y openjdk-17-jdk maven wget unzip && \
    rm -rf /var/lib/apt/lists/*

# 3. Set the JAVA_HOME environment variable
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="$JAVA_HOME/bin:${PATH}"

# 4. Install Gradle (Version 8.5)
ENV GRADLE_VERSION=8.5
RUN wget -q https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip -P /tmp && \
    unzip -q -d /opt/gradle /tmp/gradle-${GRADLE_VERSION}-bin.zip && \
    ln -s /opt/gradle/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle && \
    rm /tmp/gradle-${GRADLE_VERSION}-bin.zip

# 5. Set up your application directory
WORKDIR /app

# 6. Copy all your files into the container
COPY . .

# 7. Install your app's dependencies (e.g., npm install)
RUN npm install

# 8. Start your application
# (Change this if your app starts differently, like "node index.js")
CMD ["npm", "start"]
