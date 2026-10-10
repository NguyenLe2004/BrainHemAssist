FROM node:22-alpine AS frontend
WORKDIR /build/frontend
COPY mvp/frontend/ ./
RUN npm ci && npm run build

FROM python:3.11-slim-bookworm
WORKDIR /opt/brainhem
COPY mvp/backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && groupadd --gid 10001 brainhem \
    && useradd --uid 10001 --gid brainhem --no-create-home brainhem \
    && install -d -o brainhem -g brainhem /var/lib/brainhem
COPY --chown=brainhem:brainhem mvp/backend/app/ ./backend/app/
COPY --from=frontend /build/frontend/dist/ ./frontend/dist/
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.txt /opt/brainhem/licenses/
COPY LICENSES/ /opt/brainhem/licenses/upstream/
ENV BRAINHEM_DATA_DIR=/var/lib/brainhem \
    BRAINHEM_FRONTEND_DIR=/opt/brainhem/frontend/dist \
    BRAINHEM_RBAC_ENABLED=true
USER brainhem
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"]
