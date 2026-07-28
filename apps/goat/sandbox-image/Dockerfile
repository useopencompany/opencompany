FROM node:24-bookworm-slim

ENV AGENT_BROWSER_SCREENSHOT_DIR=/vercel/sandbox/.opencompany/screenshots

RUN npm install --global agent-browser@0.27.3 \
  && agent-browser install --with-deps \
  && mkdir -p /vercel/sandbox/.opencompany/screenshots \
  && chmod -R a+rX /usr/local/lib/node_modules /usr/local/bin \
  && chmod 0777 /vercel/sandbox /vercel/sandbox/.opencompany /vercel/sandbox/.opencompany/screenshots

WORKDIR /vercel/sandbox
