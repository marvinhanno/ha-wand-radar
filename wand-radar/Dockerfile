# Debian statt Alpine: numpy, h5py, pyproj und opencv gibt es nur dort als fertige Pakete.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY wand_radar.py route.py wand-radar-card.js ./

CMD ["python", "/app/wand_radar.py"]
