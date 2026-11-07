FROM node:22.22.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dependency-patches ./dependency-patches
COPY packages ./packages
COPY scripts ./scripts
COPY tools ./tools
COPY config/endpoint.global.json config/endpoint.json config/endpoint-manifest-mirrors.json ./config/
COPY apps/cindy-host ./apps/cindy-host
ENV XDT_SKIP_AGENT_BIN_INSTALL=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --filter @cindy/host... --frozen-lockfile --prod=false \
    && pnpm --filter @cindy/host build \
    && pnpm install:codex \
    && pnpm install:claude
RUN cd apps/cindy-host && node -e 'const fs=require("node:fs"); fs.mkdirSync("/runtime",{recursive:true}); const dependencies={}; for(const name of ["@napi-rs/keyring","better-sqlite3","sharp"]) dependencies[name]=name==="sharp"?require(name).versions.sharp:require(name+"/package.json").version; fs.writeFileSync("/runtime/package.json",JSON.stringify({private:true,dependencies}));' \
    && npm install --prefix /runtime --omit=dev
RUN mkdir -p /runtime/dist /runtime/codex /runtime/claude \
    && cp apps/cindy-host/dist/cli.cjs /runtime/dist/cli.cjs \
    && cp -a apps/codex-package-bin/linux-$(node -p process.arch)/. /runtime/codex/ \
    && cp apps/claude-code-bin/linux-$(node -p process.arch)/claude /runtime/claude/claude

FROM node:22.22.0-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git libsecret-1-0 locales tzdata \
    && printf 'en_US.UTF-8 UTF-8\n' > /etc/locale.gen && locale-gen \
    && ln -snf /usr/share/zoneinfo/America/Los_Angeles /etc/localtime \
    && printf 'America/Los_Angeles\n' > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*
ENV TZ=America/Los_Angeles LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8
WORKDIR /opt/cindy-host
COPY --from=build /runtime ./
RUN printf '#!/bin/sh\nexec node /opt/cindy-host/dist/cli.cjs "$@"\n' > /usr/local/bin/cindy-host \
    && chmod 755 /usr/local/bin/cindy-host \
    && mkdir -p /var/lib/cindy-host /var/lib/cindy-codex \
    && chown node:node /var/lib/cindy-host /var/lib/cindy-codex \
    && chmod 700 /var/lib/cindy-host /var/lib/cindy-codex
ENV CINDY_HOST_DATA_DIR=/var/lib/cindy-host \
    CINDY_HOST_CREDENTIAL_STORE=file \
    CINDY_HOST_AGENT=codex \
    CINDY_HOST_CODEX_BINARY=/opt/cindy-host/codex/bin/codex \
    CODEX_HOME=/var/lib/cindy-codex
USER node
ENTRYPOINT ["cindy-host"]
CMD ["serve"]
