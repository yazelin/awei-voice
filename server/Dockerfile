FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/var/cache/awei/huggingface

WORKDIR /app

# The backend is a full-SHA git dependency. Git is build-only and is removed
# after installation; the runtime image never contains an unpinned checkout.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY awei_voice_server ./awei_voice_server

ARG INSTALL_LOCAL_MMS=1
ARG AWEI_UID=999
ARG AWEI_GID=999
RUN if [ "$INSTALL_LOCAL_MMS" = "1" ]; then \
      python -m pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        'torch>=2.6,<3' \
      && python -m pip install --no-cache-dir '.[mms]'; \
    else \
      python -m pip install --no-cache-dir .; \
    fi \
    && apt-get purge --yes git \
    && apt-get autoremove --yes \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid "$AWEI_GID" awei \
    && useradd --system --uid "$AWEI_UID" --gid awei --create-home awei \
    && mkdir -p /var/cache/awei /var/lib/awei \
    && chown -R awei:awei /var/cache/awei /var/lib/awei

USER awei

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=2)"]

# Async jobs are process-local. Keep exactly one worker until the upstream job
# registry is replaced with shared durable infrastructure.
CMD ["uvicorn", "awei_voice_server.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
