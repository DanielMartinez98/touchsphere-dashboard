# RVC — local voice conversion, used to give Miku her actual character voice.
#
# RVC does not synthesise speech. It re-timbres speech that already exists, so it
# runs as the SECOND half of a pipeline: Kokoro says the words, this turns them
# into the character. Both are local containers — no API key, no billing, works
# with the internet down.
#
# There's no official rvc-python image, hence this file.
# https://github.com/daswer123/rvc-python

FROM python:3.11-slim

# ffmpeg: rvc-python shells out to it for audio decode/resample.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch. The default wheel drags in ~2 GB of CUDA libraries that would
# never be used on a box without an NVIDIA GPU — this keeps the image sane.
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir rvc-python

WORKDIR /app

# Voice models live here, bind-mounted from the host: one folder per model,
# each holding a .pth (and optionally a .index). The folder name is what you
# put in `rvcModel` on the assistant profile.
#   rvc-models/miku/miku.pth
#   rvc-models/miku/miku.index
VOLUME ["/app/rvc_models"]

EXPOSE 5050

# -l  listen on all interfaces (so the app container can reach it)
# -de cpu  no GPU on this host
CMD ["python", "-m", "rvc_python", "api", "-p", "5050", "-l", "-de", "cpu"]
