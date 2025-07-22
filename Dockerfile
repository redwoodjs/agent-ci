FROM node:22-slim

EXPOSE 8910/tcp
EXPOSE 8911/tcp

RUN corepack enable 
WORKDIR /app
COPY ./container/ .

RUN wget -qO- https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" bash -
RUN pnpm install

CMD ["pnpm", "run", "dev:all"]