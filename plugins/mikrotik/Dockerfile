# Build from the repository root: docker build -f plugins/mikrotik/Dockerfile .
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src/shared ./src/shared
COPY plugins/lib ./plugins/lib
COPY plugins/mikrotik ./plugins/mikrotik
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8790
CMD ["node", "plugins/mikrotik/main.ts"]
