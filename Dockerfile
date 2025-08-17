FROM --platform=linux/arm64 docker.io/cloudflare/sandbox:0.2.4


RUN npm install --global corepack@latest && \
    corepack enable && \
    mkdir /redwoodsdk && \
    cd /redwoodsdk && \
    npx create-rwsdk --template=minimal minimal && \
    cd minimal && \
    pnpm install


COPY ./container/ /machinen
RUN cd /machinen && pnpm install && pnpm esbuild sandbox.ts > sandbox.js

EXPOSE 8910
EXPOSE 5173
