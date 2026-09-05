# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json ./
RUN bun install

COPY src/ ./src/
COPY public/ ./public/

RUN bun build src/index.ts --outfile rabbit-encoder --target bun --compile --production

# Runtime stage
FROM debian:testing-slim

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTICL_ENABLE=radeonsi,iris,nouveau
ENV OCL_ICD_VENDORS=/etc/OpenCL/vendors

ENV LC_ALL=C.UTF-8
ENV LANG=C.UTF-8

# Base packages
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	gpgv \
 && rm -rf /var/lib/apt/lists/*

# Install deb-multimedia keyring
RUN curl -fsSLo /tmp/deb-multimedia-keyring.deb \
    https://www.deb-multimedia.org/pool/main/d/deb-multimedia-keyring/deb-multimedia-keyring_2024.9.1_all.deb \
 && dpkg -i /tmp/deb-multimedia-keyring.deb \
 && rm -f /tmp/deb-multimedia-keyring.deb

RUN cat >/etc/apt/sources.list.d/dmo.sources <<'EOF'
Types: deb
URIs: https://www.deb-multimedia.org
Suites: forky
Components: main non-free
Signed-By: /usr/share/keyrings/deb-multimedia-keyring.pgp
Enabled: yes
EOF

# Runtime packages
RUN apt-get update && apt-get install -y --no-install-recommends \
	python3 \
	python3-pip \
	python3-venv \
	python3-dev \
	libpython3-dev \
	ffmpeg \
	mediainfo \
	opus-tools \
	mkvtoolnix \
	zstd \
	7zip \
	\
	# OpenCL
	ocl-icd-libopencl1 \
	mesa-opencl-icd \
	clinfo \
	\
	# Vulkan / Mesa
	libvulkan1 \
	mesa-vulkan-drivers \
	vulkan-tools \
	\
	# Common custom-FFmpeg runtime dependencies
	libaom3 \
	libaribb24-0t64 \
	libass9 \
	libbluray4 \
	libbs2b0 \
	libcaca0 \
	libcdio-cdda2t64 \
	libcdio-paranoia2t64 \
	libchromaprint1 \
	libcodec2-1.2 \
	libdav1d7 \
	libdavs2-16 \
	libdc1394-25 \
	libdrm2 \
	libdvdnav4 \
	libdvdread8t64 \
	libfdk-aac2 \
	flite \
	libflite1 \
	libfontconfig1 \
	libfreetype6 \
	libfribidi0 \
	libgcrypt20 \
	libgme0 \
	libgsm1 \
	libharfbuzz0b \
	libiec61883-0 \
	libavc1394-0 \
	libraw1394-11 \
	libilbc3 \
	libjack-jackd2-0 \
	libjxl0.11 \
	libklvanc0 \
	libkvazaar7 \
	libmp3lame0 \
	libmysofa1 \
	libopencore-amrnb0 \
	libopencore-amrwb0 \
	libopenh264-8 \
	libopenjp2-7 \
	libopenmpt0t64 \
	libopus0 \
	libplacebo360 \
	libpulse0 \
	librabbitmq4 \
	librist4 \
	librsvg2-2 \
	librubberband3 \
	libshine3 \
	libsmbclient0 \
	libsnappy1v5 \
	libsoxr0 \
	libspeex1 \
	libsrt1.5-openssl \
	libsvtav1enc4 \
	libtesseract5 \
	libtwolame0 \
	libva2 \
	libvdpau1 \
	libvidstab1.2 \
	libvmaf3 \
	libvo-amrwbenc0 \
	libvorbis0a \
	libvorbisenc2 \
	libvpl2 \
	libsvtvp9enc1 \
	libshaderc1 \
	libwebp7 \
	libwebpmux3 \
	libx264-165 \
	libx265-216 \
	libxavs2-13 \
	libxvidcore4 \
	libzimg2 \
	libzmq5 \
	libzvbi0t64 \
	liblilv-0-0 \
	libopenal1 \
	libssl3t64 \
	libgl1 \
	libegl1 \
	libgles2 \
	libglu1-mesa \
 && rm -f /etc/OpenCL/vendors/mesa.icd \
 && rm -rf /var/lib/apt/lists/*

# Create venv, install vsrepo, and symlink it for convenience
RUN python3 -m venv /opt/vs-venv \
	&& /opt/vs-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
	&& /opt/vs-venv/bin/pip install --no-cache-dir \
		VapourSynth \
		vsrepo \
		vsjetpack \
		vstools \
		vsutil \
		vapoursynth-adaptivegrain \
		vapoursynth-akarin \
		vapoursynth-awarp \
		vapoursynth-resize2 \
		vapoursynth-vszip \
		vapoursynth-zsmooth \
		vapoursynth-mvtools \
		vapoursynth-eedi3 \
		vapoursynth-znedi3 \
		vapoursynth-descale \
		vapoursynth-deblock \
		vapoursynth-hysteresis \
		ffms2 \
		fonttools \
	&& /opt/vs-venv/bin/vapoursynth config \
	&& ln -sf /opt/vs-venv/bin/python /usr/local/bin/python \
	&& ln -sf /opt/vs-venv/bin/python3 /usr/local/bin/python3 \
	&& ln -sf /opt/vs-venv/bin/vapoursynth /usr/local/bin/vapoursynth \
	&& ln -sf /opt/vs-venv/bin/vspipe /usr/local/bin/vspipe \
	&& ln -sf /opt/vs-venv/bin/vsrepo /usr/local/bin/vsrepo

# Use the venv's vsrepo to install required scripts
RUN mkdir -p /root/.config/vsrepo \
	&& vsrepo update \
	&& vsrepo install ffms2 fmtc nnedi3 knlm

# Make the venv's Python the default for any 'python3' call
ENV PATH="/opt/vs-venv/bin:${PATH}"

COPY fonts/ /app/fonts/
COPY vapoursynth/ /app/vapoursynth/

# Download all binaries from CDN
ARG CDN_BASE="https://cdn.rabbit-company.com/rabbit-encoder/binaries"
RUN mkdir -p /opt/binaries/x86_64_v2 /opt/binaries/x86_64_v3 /opt/binaries/x86_64_v4 \
 && curl -fsSL --retry 2 "${CDN_BASE}/language-detector" -o /opt/binaries/language-detector \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v2/SVT-AV1-Essential" -o /opt/binaries/x86_64_v2/SVT-AV1-Essential \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v3/SVT-AV1-Essential" -o /opt/binaries/x86_64_v3/SVT-AV1-Essential \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v4/SVT-AV1-Essential" -o /opt/binaries/x86_64_v4/SVT-AV1-Essential \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v2/SVT-AV1-HDR" -o /opt/binaries/x86_64_v2/SVT-AV1-HDR \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v3/SVT-AV1-HDR" -o /opt/binaries/x86_64_v3/SVT-AV1-HDR \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v4/SVT-AV1-HDR" -o /opt/binaries/x86_64_v4/SVT-AV1-HDR \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v2/SVT-AV1-5FISH" -o /opt/binaries/x86_64_v2/SVT-AV1-5FISH \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v3/SVT-AV1-5FISH" -o /opt/binaries/x86_64_v3/SVT-AV1-5FISH \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v4/SVT-AV1-5FISH" -o /opt/binaries/x86_64_v4/SVT-AV1-5FISH \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v2/ffmpeg2.tar.zst" -o /opt/binaries/x86_64_v2/ffmpeg.tar.zst \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v3/ffmpeg2.tar.zst" -o /opt/binaries/x86_64_v3/ffmpeg.tar.zst \
 && curl -fsSL --retry 2 "${CDN_BASE}/x86_64_v4/ffmpeg2.tar.zst" -o /opt/binaries/x86_64_v4/ffmpeg.tar.zst \
# Make encoder binaries executable
 && chmod +x \
	/opt/binaries/language-detector \
	/opt/binaries/x86_64_v2/SVT-AV1-Essential \
	/opt/binaries/x86_64_v3/SVT-AV1-Essential \
	/opt/binaries/x86_64_v4/SVT-AV1-Essential \
	/opt/binaries/x86_64_v2/SVT-AV1-HDR \
	/opt/binaries/x86_64_v3/SVT-AV1-HDR \
	/opt/binaries/x86_64_v4/SVT-AV1-HDR \
	/opt/binaries/x86_64_v2/SVT-AV1-5FISH \
	/opt/binaries/x86_64_v3/SVT-AV1-5FISH \
	/opt/binaries/x86_64_v4/SVT-AV1-5FISH \
# Extract FFmpeg tarballs
 && mkdir -p /opt \
 && tar --zstd -xpf /opt/binaries/x86_64_v2/ffmpeg.tar.zst -C /opt \
 && tar --zstd -xpf /opt/binaries/x86_64_v3/ffmpeg.tar.zst -C /opt \
 && tar --zstd -xpf /opt/binaries/x86_64_v4/ffmpeg.tar.zst -C /opt \
 && chmod +x \
	/opt/ffmpeg-x86-64-v2/bin/ffmpeg \
	/opt/ffmpeg-x86-64-v2/bin/ffprobe \
	/opt/ffmpeg-x86-64-v3/bin/ffmpeg \
	/opt/ffmpeg-x86-64-v3/bin/ffprobe \
	/opt/ffmpeg-x86-64-v4/bin/ffmpeg \
	/opt/ffmpeg-x86-64-v4/bin/ffprobe

# Verify all custom FFmpeg builds can resolve shared libraries.
RUN set -eux; \
	for level in x86-64-v2 x86-64-v3 x86-64-v4; do \
		echo "Checking /opt/ffmpeg-$level/bin/ffmpeg"; \
		LD_LIBRARY_PATH="/opt/ffmpeg-$level/lib" ldd "/opt/ffmpeg-$level/bin/ffmpeg" | tee "/tmp/ldd-ffmpeg-$level.txt"; \
		! grep -q "not found" "/tmp/ldd-ffmpeg-$level.txt"; \
		echo "Checking /opt/ffmpeg-$level/bin/ffprobe"; \
		LD_LIBRARY_PATH="/opt/ffmpeg-$level/lib" ldd "/opt/ffmpeg-$level/bin/ffprobe" | tee "/tmp/ldd-ffprobe-$level.txt"; \
		! grep -q "not found" "/tmp/ldd-ffprobe-$level.txt"; \
	done

# Entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Auto-Boost-Essential script
RUN mkdir -p /opt/Auto-Boost-Essential
COPY scripts/Auto-Boost-Essential.py /opt/Auto-Boost-Essential/

# Application
WORKDIR /app

COPY --from=builder /app/rabbit-encoder /app/

RUN mkdir -p /data/input /data/output /data/temp

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app/rabbit-encoder"]