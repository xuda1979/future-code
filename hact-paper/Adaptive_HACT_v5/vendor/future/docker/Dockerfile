# Deployment template: not built or run in the delivery environment.
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /opt/future-control
COPY requirements.lock pyproject.toml README.md ./
COPY src ./src
RUN python -m pip install --no-cache-dir -r requirements.lock && python -m pip install --no-cache-dir . \
    && useradd --create-home --uid 10001 agent
USER 10001:10001
WORKDIR /project
ENTRYPOINT ["future-control", "--project", "/project"]
CMD ["run", "--quiet"]
