FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fathom fathom
COPY docs docs
ENV FATHOM_DB=/data/fathom.db FATHOM_EXPORT_DIR=/data/export
