# RVC — local voice conversion, used to give Miku her actual character voice.
#
# RVC does not synthesise speech. It re-timbres speech that already exists, so it
# runs as the SECOND half of a pipeline: Kokoro says the words, this turns them
# into the character. Both are local containers — no API key, no billing, works
# with the internet down.
#
# There's no official rvc-python image, hence this file.
# https://github.com/daswer123/rvc-python
#
# ── Why this file is so fussy ────────────────────────────────────────────────
# rvc-python depends on fairseq==0.12.2, which is a genuine minefield:
#   • fairseq ships no wheel past cp38, so on 3.11+ it compiles from source —
#     and it does not build there. faiss-cpu==1.7.3 likewise stops at cp310.
#     => Python 3.10 is the newest base that works. Do not "upgrade" it.
#   • fairseq's setup.py breaks with Cython 3 and with setuptools >= 66, and it
#     imports numpy at build time, so both must be present BEFORE it installs,
#     with build isolation off.
#   • pip >= 24.1 enforces PEP 440 strictly and rejects omegaconf 2.0.6's
#     malformed metadata ("PyYAML>=5.1.*"), which fairseq pulls in.
#   • fairseq's sdist on PyPI is BROKEN: the tarball omits its own C++ sources
#     (fairseq/clib/libbase/balanced_assignment.cpp), so compiling it from PyPI
#     always dies with "No such file or directory". It has to come from the git
#     tag, which actually contains them.
# Each pin below is load-bearing. Changing one tends to break the build.

FROM python:3.10-slim

# ffmpeg: rvc-python shells out to it for audio decode/resample.
# build-essential + python3-dev: fairseq has C extensions to compile.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        build-essential \
        python3-dev \
        git \
    && rm -rf /var/lib/apt/lists/*

# Old pip (see above) and the setuptools/wheel fairseq expects.
RUN pip install --no-cache-dir "pip<24.1" "setuptools==65.5.0" "wheel"

# CPU-only torch, PINNED as a matched pair. The default wheel drags in ~2 GB of
# CUDA libraries that would never be used on a box without an NVIDIA GPU.
#
# The versions are exact on purpose: torchaudio ships a compiled extension linked
# against a specific torch ABI, so a torch/torchaudio pair that drifted apart
# dies at import with "undefined symbol: aoti_torch_abi_version". Leaving these
# unpinned lets a later install shift torch and break torchaudio.
RUN pip install --no-cache-dir \
        "torch==2.1.2" "torchaudio==2.1.2" \
        --index-url https://download.pytorch.org/whl/cpu

# Must exist before fairseq builds: its setup.py imports numpy, and Cython 3
# breaks its generated sources.
RUN pip install --no-cache-dir "Cython<3.0" "numpy==1.23.5"

# From the git tag, NOT PyPI — the published sdist is missing its own C++
# sources and cannot compile (see the note at the top of this file).
# --no-build-isolation so it uses the Cython/numpy installed above rather than
# fetching a fresh (and incompatible) set into an isolated build env.
RUN pip install --no-cache-dir --no-build-isolation \
        "git+https://github.com/facebookresearch/fairseq.git@v0.12.2#egg=fairseq"

RUN pip install --no-cache-dir rvc-python

# rvc-python declares torch>=2.0.0 / torchaudio>=2.0.0, so pip is free to pull a
# newer one and leave the pair mismatched — which is exactly what killed the
# container the first time. Re-assert the matched CPU pair last, after every
# other dependency has had its say, and prove they agree at BUILD time rather
# than discovering it in a restart loop.
RUN pip install --no-cache-dir --force-reinstall \
        "torch==2.1.2" "torchaudio==2.1.2" \
        --index-url https://download.pytorch.org/whl/cpu \
    && python -c "import torch, torchaudio, fairseq; print('torch', torch.__version__, '| torchaudio', torchaudio.__version__)" \
    && python -c "import rvc_python; print('rvc-python imports OK')"

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
