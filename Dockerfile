FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build

WORKDIR /source
COPY package.json package-lock.json tsconfig.json tsconfig.base.json mise.toml ./
COPY packages ./packages
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npx tsc -p packages/doppelclaude && \
    npx tsc -p packages/http-doppelclaude

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

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
