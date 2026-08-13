# Builder for the Trusted Web Activity APK. JDK, Android SDK and Bubblewrap
# all live in the image, so the host needs nothing but Docker and the build
# runs without a single interactive prompt.
FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip curl \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH

# Android command-line tools, then the pieces Bubblewrap compiles against.
# The symlink at the end bridges two SDK layouts: Bubblewrap still looks for
# <sdk>/bin/sdkmanager and rejects a root holding neither `tools` nor `bin`,
# while current SDKs keep both under cmdline-tools/latest.
RUN mkdir -p /opt/android-sdk/cmdline-tools \
    && curl -fsSL -o /tmp/cmdline.zip \
       https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdline.zip -d /tmp/cmdline \
    && mv /tmp/cmdline/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm -rf /tmp/cmdline.zip /tmp/cmdline \
    && yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.1.0" > /dev/null \
    && ln -s /opt/android-sdk/cmdline-tools/latest/bin /opt/android-sdk/bin

RUN npm install -g @bubblewrap/cli@latest

# Pointing Bubblewrap at the JDK and SDK above is what stops `init`/`build`
# from asking to download its own copies.
RUN mkdir -p /root/.bubblewrap \
    && printf '{"jdkPath":"%s","androidSdkPath":"%s"}\n' "$JAVA_HOME" "$ANDROID_HOME" \
       > /root/.bubblewrap/config.json

WORKDIR /work
