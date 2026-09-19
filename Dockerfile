FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS build

WORKDIR /source
COPY package.json package-lock.json tsconfig.json tsconfig.base.json mise.toml ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --ignore-scripts --no-audit --no-fund
ARG VERSION=0.0.0
RUN node scripts/set-release-version.mjs "$VERSION" && \
    npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund && \
    npx tsc -p packages/doppelclaude && \
    npx tsc -p packages/http-doppelclaude

FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7

RUN groupadd --gid 3456 doppelclaude && \
    useradd --uid 3456 --gid 3456 --home-dir /var/lib/doppelclaude \
      --no-create-home --shell /usr/sbin/nologin doppelclaude && \
    mkdir -p /app /var/lib/doppelclaude && \
    chown 3456:3456 /var/lib/doppelclaude
WORKDIR /app
COPY --from=build /source/package.json /source/package-lock.json ./
COPY --from=build /source/packages/doppelclaude/package.json \
  /source/packages/doppelclaude/LICENSE /source/packages/doppelclaude/README.md \
  ./packages/doppelclaude/
COPY --from=build /source/packages/doppelclaude/dist ./packages/doppelclaude/dist
COPY --from=build /source/packages/http-doppelclaude/package.json \
  /source/packages/http-doppelclaude/LICENSE /source/packages/http-doppelclaude/README.md \
  ./packages/http-doppelclaude/
COPY --from=build /source/packages/http-doppelclaude/dist ./packages/http-doppelclaude/dist
RUN npm ci --omit=dev --ignore-scripts --workspace=doppelclaude \
      --workspace=http-doppelclaude --no-audit --no-fund && \
    rm -rf /root/.npm

ENV DOPPELCLAUDE_HTTP_HOST=0.0.0.0 \
    DOPPELCLAUDE_STATE_DIR=/var/lib/doppelclaude \
    CLAUDE_CONFIG_DIR=/var/lib/doppelclaude/.claude \
    HOME=/var/lib/doppelclaude \
    PORT=3456
USER 3456:3456
EXPOSE 3456
ENTRYPOINT ["node_modules/.bin/doppelclaude-serve"]
