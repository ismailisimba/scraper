# ======================================================================================
# STAGE 1: Build the application and install Node.js dependencies
# ======================================================================================
FROM node:22-slim AS builder

WORKDIR /usr/src/app

COPY package*.json ./

# Use 'npm ci' for clean, reproducible production builds
RUN npm ci --omit=dev

COPY . .


# ======================================================================================
# STAGE 2: Create the final production image
# ======================================================================================
FROM node:22-slim

ENV NODE_ENV=production
# Tell Puppeteer to use the system-installed Chrome, not its own download
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"

# The node:slim image already comes with a 'node' user. We will use it.

# Install system dependencies for Chrome in a single layer
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gnupg \
        wget \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf --no-install-recommends \
    # Clean up APT cache
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy dependencies and source code from the 'builder' stage, setting ownership
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app .

# Switch to the non-root user for security
USER node

# Cloud Run expects the service to listen on port 8080 by default
EXPOSE 8080

CMD [ "npm", "start" ]
