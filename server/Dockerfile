# chilocal-api — companion server (live CTA arrivals, tonight's events,
# two-phone rooms). Zero npm dependencies: the image is Node + one file.
FROM node:22-alpine
LABEL org.opencontainers.image.title="chilocal-api" \
      org.opencontainers.image.description="ChiLocal companion API: CTA arrivals proxy, events, two-phone rooms"
WORKDIR /app
COPY server.mjs .
ENV NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://localhost:8787/api/health || exit 1
USER node
CMD ["node", "server.mjs"]
