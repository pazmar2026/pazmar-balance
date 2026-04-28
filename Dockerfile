# ─── Dockerfile para Pazmar Balance ─────────────────────────────────────────
FROM node:20-alpine

# Criar directório da app
WORKDIR /app

# Copiar package.json e instalar dependências
COPY package*.json ./
RUN npm install --production

# Copiar o resto da aplicação
COPY . .

# Criar directório para a base de dados (volume persistente no Fly.io)
RUN mkdir -p /data

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/pazmar.db

# Expor a porta
EXPOSE 8080

# Iniciar o servidor
CMD ["node", "server.js"]
