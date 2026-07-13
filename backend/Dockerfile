FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runner
WORKDIR /app

# The compliance Compose preset requires a local ClamAV executable. Virus
# definitions are deliberately not fetched at runtime: operators mount a
# reviewed, regularly updated definition directory before accepting uploads.
RUN apt-get update \
  && apt-get install --no-install-recommends -y clamav \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3001
ENV ALETHEIA_AUTH_MODE=single_user
ENV ALETHEIA_DATA_DIR=/data/aletheia
ENV ALETHEIA_LOCAL_USER_ID=local-user
ENV ALETHEIA_LOCAL_USER_EMAIL=local@aletheia.internal
ENV ALETHEIA_RETRIEVAL_MODE=keyword
ENV ALETHEIA_SEMANTIC_INDEX_ENABLED=false
ENV ALETHEIA_SEMANTIC_INDEX_DRIVER=disabled
ENV ALETHEIA_SEMANTIC_INDEX_DIR=/data/aletheia/index/semantic-local
ENV ALETHEIA_DEMO_SEED_ENABLED=true
ENV ALETHEIA_DEMO_SEED_MODE=empty
ENV ALETHEIA_MALWARE_SCAN_MODE=required
ENV ALETHEIA_CLAMAV_PATH=/usr/bin/clamscan

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

RUN mkdir -p /data/aletheia
VOLUME ["/data/aletheia"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
