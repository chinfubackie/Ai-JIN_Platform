FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home --shell /usr/sbin/nologin aijin \
    && chown -R aijin:aijin /app
USER aijin
EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8501/healthz', timeout=3).read()"
CMD ["gunicorn", "--bind", "0.0.0.0:8501", "--workers", "2", "--threads", "4", "--timeout", "180", "app:app"]
