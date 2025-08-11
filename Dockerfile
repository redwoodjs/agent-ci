FROM --platform=linux/arm64 docker.io/cloudflare/sandbox:0.2.4

RUN npm install --global corepack@latest && \
    corepack enable && \
    mkdir /redwoodsdk && \
    cd /redwoodsdk && \
    npx create-rwsdk --template=minimal minimal && \
    cd minimal && \
    pnpm install

EXPOSE 5173
EXPOSE 8910