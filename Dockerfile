FROM oven/bun:1.3.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json bunfig.toml ./
COPY src ./src
COPY tests ./tests
CMD ["bun", "run", "db:migrate"]
