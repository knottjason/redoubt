# Build from the repository root: docker build -f plugins/suricata/Dockerfile .
# Use the same image version as your sensor, so rules are rebuilt by the same tools.
ARG SURICATA=jasonish/suricata:8.0.8
FROM node:24-bookworm-slim AS node
FROM ${SURICATA}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json ./
COPY src/shared/plugin.ts ./src/shared/
COPY plugins/lib ./plugins/lib
COPY plugins/suricata ./plugins/suricata
RUN install -d -o suricata -g suricata /incoming
USER suricata
EXPOSE 8790
ENTRYPOINT ["node", "plugins/suricata/main.ts"]
