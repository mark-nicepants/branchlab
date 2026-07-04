# Slim static container for branchlab.dev. Build context is the src-website
# directory (dist/ must exist — run `npm run build` first):
#   docker build -f deploy/Dockerfile -t branchlab-site .
# TLS and the public hostname are handled upstream by nginx-proxy-manager;
# this container just serves plain HTTP on :80 on the shared `npm` network.
FROM nginx:alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/
