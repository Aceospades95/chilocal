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

# ---- Stage 2: tiny static web server, members-only ------------------------
# The nginx config is a TEMPLATE: the official image substitutes set env
# vars at startup, so API_UPSTREAM (where the auth server lives) is
# overridable per deployment without rebuilding.
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="chilocal" \
      org.opencontainers.image.description="ChiLocal — members-only Chicago night engine"
COPY --from=data /app/site /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=192.168.1.19:8787
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://localhost/gate.html || exit 1
