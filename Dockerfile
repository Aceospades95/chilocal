# syntax=docker/dockerfile:1

# ---- Stage 1: fetch full-resolution official boundary data ----------------
# Runs on your server at build time (which has internet). If the fetch fails
# (e.g. offline build), the image still ships the bundled simplified samples
# and the app falls back to the live portal, so the build never breaks.
FROM alpine:3.20 AS data
RUN apk add --no-cache bash curl
WORKDIR /app
COPY scripts ./scripts
COPY site ./site
RUN bash scripts/fetch-data.sh \
    || echo "NOTE: data fetch skipped — using bundled samples + live fallback."

# ---- Stage 2: tiny static web server --------------------------------------
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="chilocal" \
      org.opencontainers.image.description="Interactive Chicago neighborhood boundary map"
COPY --from=data /app/site /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://localhost/ || exit 1
