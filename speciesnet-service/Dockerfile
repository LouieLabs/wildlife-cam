# In plain words: a container with SpeciesNet AND its model weights already
# inside, so it starts fast and never phones Kaggle at runtime. The weight
# "bake" (the python -c step) is the important trick: it downloads the ~500MB
# of weights ONCE at image-build time into a pinned cache dir, so a cold Cloud
# Run instance only has to load them off local disk (~30-60s) instead of
# downloading them first.
FROM python:3.12-slim

# torch/Pillow need a couple of system libraries that -slim leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
# CPU-only torch wheels: ~2GB smaller than the CUDA build, and Cloud Run has
# no GPU anyway.
RUN pip install --no-cache-dir -r requirements.txt \
    --extra-index-url https://download.pytorch.org/whl/cpu

# ---- Bake the model weights into the image ----
# KAGGLEHUB_CACHE pins the download dir so build-time download and run-time
# load use the SAME path. If Kaggle ever starts requiring auth for this model,
# this step will fail loudly at build time (never silently at runtime).
ENV KAGGLEHUB_CACHE=/opt/speciesnet-cache
RUN python -c "from speciesnet import DEFAULT_MODEL, SpeciesNet; \
SpeciesNet(DEFAULT_MODEL, components='all', geofence=True); \
print('weights baked')"

COPY app.py speciesnet_runner.py parsing.py ./

ENV PORT=8080
# One worker, one thread: torch inference is CPU-bound and the model isn't
# safe to run concurrently in one process — Cloud Run scales instances instead
# (deploy uses --concurrency=1). Long timeout covers the first-request model load.
CMD exec gunicorn --bind :$PORT --workers 1 --threads 1 --timeout 120 app:app
