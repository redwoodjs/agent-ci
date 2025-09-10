FROM --platform=linux/arm64 docker.io/cloudflare/sandbox:0.3.1

RUN npm install --global corepack@latest && \
    corepack enable && \
    mkdir /redwoodsdk && \
    cd /redwoodsdk && \
    npx create-rwsdk --template=minimal minimal && \
    cd minimal && \
    pnpm install

RUN mkdir /root/.claude && npm install -g @anthropic-ai/claude-code
COPY ./container/claude/claude.json /root/.claude.json
COPY ./container/claude/settings.json /root/.claude/settings.json

COPY ./container/machinen/ /machinen
RUN cd /machinen && pnpm install && pnpm esbuild sandbox.ts > sandbox.js

EXPOSE 8910
EXPOSE 5173
