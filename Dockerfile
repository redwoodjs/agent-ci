FROM --platform=linux/arm64 docker.io/cloudflare/sandbox:0.1.3

RUN npm install --global corepack@latest && corepack enable

EXPOSE 5173