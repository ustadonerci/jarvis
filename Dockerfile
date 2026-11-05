# Jarvis çekirdek sürümü: her müşteriye ayrı kapsayıcı (veriler birbirine karışmaz).
# Kişisel veri, API anahtarı ve hafıza İÇERMEZ: anahtarlar .env ile (env_file), veriler /app/server/data biriminde.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN npm --prefix server ci --no-audit --no-fund && npm --prefix web ci --no-audit --no-fund
COPY server server
COPY web web
COPY scripts scripts
RUN cd web && npx vite build && cd .. && rm -rf server/data server/.env*
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
VOLUME ["/app/server/data"]
CMD ["npm", "--prefix", "server", "start"]
