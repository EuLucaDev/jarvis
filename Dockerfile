# Portaria do Jarvis (jarvis.agcunae.com): contas, site, links da loja de versões e a ponte do Telegram.
# O Jarvis em si roda no computador de cada pessoa; aqui não há núcleo, financeiro nem navegador: imagem pequena,
# montagem leve para a VPS (que também roda outros sites). Dados no volume /dados (nunca na imagem).

# 1) a interface do site (só para montar; não vai para a imagem final)
FROM node:22-slim AS site
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN NODE_OPTIONS=--max-old-space-size=512 npm run build

# 2) a portaria
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 \
    PORTARIA_DADOS=/dados \
    TZ=America/Fortaleza
RUN apt-get update && apt-get install -y --no-install-recommends curl tzdata && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "fastapi>=0.115" "uvicorn[standard]>=0.30" "httpx>=0.27" "boto3>=1.35" "cryptography>=43" "python-multipart>=0.0.9"
WORKDIR /app
COPY backend/jarvis/ backend/jarvis/
COPY VERSION ./
COPY --from=site /app/frontend/dist frontend/dist
VOLUME /dados
EXPOSE 8700
WORKDIR /app/backend
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fs http://127.0.0.1:8700/health || exit 1
CMD ["python", "-m", "jarvis.portaria"]
