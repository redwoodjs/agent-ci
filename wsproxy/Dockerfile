FROM oven/bun:1

WORKDIR /app

# Only app files; no dependencies
COPY proxy.ts package.json ./

EXPOSE 3000

CMD ["bun", "run", "proxy.ts"]


