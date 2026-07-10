# chilocal-api — companion server (accounts, live CTA arrivals, tonight's
# events, two-phone rooms). Zero npm dependencies: Node + one file; the
# account database is SQLite via node's built-in module, stored in /data.
FROM node:22-alpine
LABEL org.opencontainers.image.title="chilocal-api" \
      org.opencontainers.image.description="ChiLocal companion API: accounts, CTA arrivals proxy, events, two-phone rooms"
WORKDIR /app
COPY server.mjs export-digest.mjs ./
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://localhost:8787/api/health || exit 1
USER node
CMD ["node", "--experimental-sqlite", "server.mjs"]
