# Jarvis na nuvem: a portaria (porta 8700) + um núcleo do Jarvis por pessoa, sem microfone, câmera nem tela.
# Monta no Coolify a partir deste repositório. Os dados de cada pessoa ficam no volume /dados (nunca na imagem).
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORTARIA_DADOS=/dados \
    TZ=America/Fortaleza

# Node 22 (motor do financeiro) e o básico para compilar o better-sqlite3 se o binário pronto faltar
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tzdata gnupg build-essential \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

WORKDIR /app

# dependências do núcleo (com o grupo da nuvem: Chromium para imagens/PDF, backup no R2), SEM o que a nuvem não
# usa (câmera, mãos, voz offline, áudio): imagem com metade do tamanho e montagem leve para a VPS
COPY backend/pyproject.toml backend/uv.lock backend/
RUN cd backend && uv export --frozen --group nuvem --no-hashes --no-emit-project \
      | grep -viE "^(mediapipe|opencv|onnxruntime|rtmlib|vosk|sounddevice|jax|jaxlib|scipy|matplotlib|ml-dtypes|opt-einsum|flatbuffers|sentencepiece|absl-py)" > /tmp/req.txt \
 && uv venv .venv --python 3.12 \
 && uv pip install --python .venv/bin/python -r /tmp/req.txt \
 && .venv/bin/playwright install --with-deps chromium

# motor do financeiro
COPY financeiro/motor/package.json financeiro/motor/package-lock.json financeiro/motor/
RUN cd financeiro/motor && npm ci --omit=dev
RUN mkdir -p financeiro/motor/tessdata \
 && curl -fsSL -o financeiro/motor/tessdata/por.traineddata.gz \
    https://cdn.jsdelivr.net/npm/@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz

# interface (cartões e relatórios são desenhados por ela)
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci
COPY . .
# a interface é montada com memória limitada (a VPS roda outros sites)
RUN cd frontend && NODE_OPTIONS=--max-old-space-size=768 npm run build

VOLUME /dados
EXPOSE 8700
WORKDIR /app/backend
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fs http://127.0.0.1:8700/health || exit 1
CMD [".venv/bin/python", "-m", "jarvis.portaria"]
