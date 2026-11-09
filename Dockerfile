ARG PYTHON_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE}
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app/birbcrew
COPY pyproject.toml uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/venv UV_PYTHON_DOWNLOADS=never UV_CACHE_DIR=/tmp/uv-cache
RUN uv sync --frozen --no-dev --no-install-project --python /usr/local/bin/python
COPY src ./src
RUN uv sync --frozen --no-dev --python /usr/local/bin/python
RUN chmod -R a+rX /app/birbcrew
ENV PATH=/venv/bin:$PATH PYTHONUNBUFFERED=1
USER 10001:10001
CMD ["python", "-m", "uvicorn", "birbcrew.api:app", "--host", "127.0.0.1", "--port", "8000"]
