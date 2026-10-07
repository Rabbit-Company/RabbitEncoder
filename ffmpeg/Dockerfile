FROM debian:testing

USER root
ENV DEBIAN_FRONTEND=noninteractive
ENV MAKEFLAGS="-j$(nproc)"

ARG FFMPEG_REF=n9.0.2
ARG DEB_MULTIMEDIA_KEYRING_VERSION=2024.9.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gpgv \
    git \
    build-essential \
    pkg-config \
    nasm \
    yasm \
    cmake \
    meson \
    ninja-build \
    autoconf \
    automake \
    libtool \
    texinfo \
    zstd \
    xz-utils \
    tar \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/deb-multimedia-keyring.deb \
    "https://www.deb-multimedia.org/pool/main/d/deb-multimedia-keyring/deb-multimedia-keyring_${DEB_MULTIMEDIA_KEYRING_VERSION}_all.deb" \
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

RUN apt-get update && apt-get install -y --no-install-recommends \
	libaom-dev \
	libaribb24-dev \
	libass-dev \
	libbluray-dev \
	libbs2b-dev \
	libcaca-dev \
	libcdio-dev \
	libcdio-paranoia-dev \
	libchromaprint-dev \
	libcodec2-dev \
	libdav1d-dev \
	libdavs2-dev \
	libdc1394-dev \
	libdrm-dev \
	libdvdnav-dev \
	libdvdread-dev \
	libfdk-aac-dev \
	flite1-dev \
	libfontconfig-dev \
	libfreetype-dev \
	libfribidi-dev \
	libgcrypt20-dev \
	libgme-dev \
	libgsm1-dev \
	libharfbuzz-dev \
	libavc1394-dev \
	libraw1394-dev \
	libiec61883-dev \
	libilbc-dev \
	libjack-jackd2-dev \
	libjxl-dev \
	libklvanc-dev \
	libkvazaar-dev \
	libmp3lame-dev \
	libmysofa-dev \
	libopencore-amrnb-dev \
	libopencore-amrwb-dev \
	libopenh264-dev \
	libopenjp2-7-dev \
	libopenmpt-dev \
	libopus-dev \
	libplacebo-dev \
	libpulse-dev \
	librabbitmq-dev \
	librist-dev \
	librsvg2-dev \
	librubberband-dev \
	libshine-dev \
	libsmbclient-dev \
	libsnappy-dev \
	libsoxr-dev \
	libspeex-dev \
	libsrt-openssl-dev \
	libsvtav1enc-dev \
	libtesseract-dev \
	libtheora-dev \
	libtwolame-dev \
	libva-dev \
	libvdpau-dev \
	libvidstab-dev \
	libvmaf-dev \
	libvo-amrwbenc-dev \
	libvorbis-dev \
	libvpl-dev \
	libvpx-dev \
	libvulkan-dev \
	glslang-dev \
	glslc \
	spirv-headers \
	libwebp-dev \
	libx264-dev \
	libx265-dev \
	libxavs2-dev \
	libxml2-dev \
	libxvidcore-dev \
	libzimg-dev \
	libzmq3-dev \
	libzvbi-dev \
	lv2-dev \
	liblilv-dev \
	frei0r-plugins-dev \
	ladspa-sdk \
	ocl-icd-opencl-dev \
	libgl1-mesa-dev \
	libegl1-mesa-dev \
	libgles2-mesa-dev \
	libglu1-mesa-dev \
	opencl-headers \
	libopenal-dev \
	libssl-dev \
	zlib1g-dev \
	libbz2-dev \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg \
 && cd ffmpeg \
 && git checkout "${FFMPEG_REF}"

COPY build-ffmpeg.sh /usr/local/bin/build-ffmpeg.sh
RUN chmod +x /usr/local/bin/build-ffmpeg.sh

VOLUME ["/out"]
CMD ["/usr/local/bin/build-ffmpeg.sh"]