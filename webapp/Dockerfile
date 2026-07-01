FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip uninstall -y opencv-python opencv-python-headless \
    && pip install --no-cache-dir "opencv-python-headless>=4.8"
COPY . .
RUN useradd --create-home --shell /usr/sbin/nologin aijin \
    && chown -R aijin:aijin /app
USER aijin
EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8501/healthz', timeout=3).read()"
# Single worker: training/video-autolabel job state (_local_train_state,
# _video_label_state) lives in module-level in-process dicts, not a shared
# store. With >1 worker, status polls hit a random process and see stale
# "idle" state even while another worker is actively training. --threads
# still gives request concurrency within that one process.
CMD ["gunicorn", "--preload", "--bind", "0.0.0.0:8501", "--workers", "1", "--threads", "4", "--timeout", "180", "app:app"]
