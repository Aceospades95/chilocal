# syntax=docker/dockerfile:1

# Tiny static web server, members-only. The site ships fully baked: the
# *.min.* data files in site/data are produced by the scripts/ pipeline at
# development time and committed — nothing is fetched at image build time.
# (scripts/fetch-data.sh pulls the full-resolution official boundaries the
# pipeline simplifies FROM; the app itself never loads those.)
#
# The nginx config is a TEMPLATE: the official image substitutes set env
# vars at startup, so API_UPSTREAM (where the auth server lives) is
# overridable per deployment without rebuilding.
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="chilocal" \
      org.opencontainers.image.description="ChiLocal — members-only Chicago night engine"
COPY site /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=192.168.1.19:8787
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://localhost/gate.html || exit 1
