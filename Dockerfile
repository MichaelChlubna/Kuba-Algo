# One image for the web app: the React build is served by the FastAPI backend.
# Stage 1: frontend build
FROM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
# optional extra CA for TLS-intercepting proxies: docker build --secret id=extra_ca,src=<bundle.pem>
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend + built frontend
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    FP_DATA_DIR=/data FP_HOST=0.0.0.0 FP_PORT=8000 FP_STATIC_DIR=/app/static FP_SITE_DIR=/app/site
WORKDIR /app
COPY backend/requirements.txt ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install --no-cache-dir -r requirements.txt
COPY backend/fp ./fp
COPY backend/config.yaml ./
COPY --from=frontend /src/dist ./static
COPY site ./site
RUN useradd --uid 1000 --create-home fp && mkdir -p /data && chown fp /data
USER fp
VOLUME /data
EXPOSE 8000
# probe every 2 s while starting, so the proxy routes to a fresh container within seconds of a
# redeploy (Coolify routes only healthy containers; with a 30 s first probe the site gave 503)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"
ENTRYPOINT ["python", "-m", "fp"]
CMD ["serve"]
