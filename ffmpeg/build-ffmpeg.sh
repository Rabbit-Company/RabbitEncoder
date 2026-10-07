#!/usr/bin/env bash
set -euo pipefail

SRC=/src/ffmpeg
OUT=/out
mkdir -p "$OUT"

COMMON_FLAGS=(
  --disable-decoder=amrnb
  --disable-gnutls
  --disable-liblensfun
  --disable-libopencv
  --disable-podpages
  --disable-sndio
  --disable-stripping

  --enable-avfilter
  --enable-chromaprint
  --enable-frei0r
  --enable-gcrypt
  --enable-gpl
  --enable-ladspa
  --enable-libaom
  --enable-libaribb24
  --enable-libass
  --enable-libbluray
  --enable-libbs2b
  --enable-libcaca
  --enable-libcdio
  --enable-libcodec2
  --enable-libdav1d
  --enable-libdavs2
  --enable-libdc1394
  --enable-libdrm
  --enable-libdvdnav
  --enable-libdvdread
  --enable-libfdk-aac
  --enable-libflite
  --enable-libfontconfig
  --enable-libfreetype
  --enable-libfribidi
  --enable-libgme
  --enable-libgsm
  --enable-libharfbuzz
  --enable-libiec61883
  --enable-libilbc
  --enable-libjack
  --enable-libjxl
  --enable-libklvanc
  --enable-libkvazaar
  --enable-libmp3lame
  --enable-libmysofa
  --enable-libopencore-amrnb
  --enable-libopencore-amrwb
  --enable-libopenh264
  --enable-libopenjpeg
  --enable-libopenmpt
  --enable-libopus
  --enable-libplacebo
  --enable-libpulse
  --enable-librabbitmq
  --enable-librist
  --enable-librsvg
  --enable-librubberband
  --enable-libshine
  --enable-libsmbclient
  --enable-libsnappy
  --enable-libsoxr
  --enable-libspeex
  --enable-libsrt
  --enable-libsvtav1
  --enable-libtesseract
  --enable-libtheora
  --enable-libtwolame
  --enable-libvidstab
  --enable-libvmaf
  --enable-libvo-amrwbenc
  --enable-libvorbis
  --enable-libvpx
  --enable-libwebp
  --enable-libx264
  --enable-libx265
  --enable-libxavs2
  --enable-libxml2
  --enable-libxvid
  --enable-libzimg
  --enable-libzmq
  --enable-libzvbi
  --enable-lv2

  --enable-nonfree
  --enable-openal
  --enable-opencl
  --enable-opengl
  --enable-openssl
  --enable-pthreads
  --enable-shared
  --disable-static
  --enable-version3
	--enable-lto
  --enable-vaapi
  --enable-libvpl

  --enable-vulkan

  --enable-runtime-cpudetect
	--enable-x86asm

	--enable-rpath

  --toolchain=hardened
  --cc=gcc
  --cxx=g++
  --disable-altivec
)

build_one() {
  local level="$1"
  local build_dir="/build/ffmpeg-${level}"
  local prefix="/opt/ffmpeg-${level}"

  echo "==== Building FFmpeg for ${level} ===="

  rm -rf "$build_dir" "$prefix"
  mkdir -p "$build_dir"

  cd "$build_dir"

  CFLAGS="-O3 -pipe -march=${level} -mtune=generic -DCL_TARGET_OPENCL_VERSION=300" \
  CXXFLAGS="-O3 -pipe -march=${level} -mtune=generic -DCL_TARGET_OPENCL_VERSION=300" \
  LDFLAGS="-Wl,-O1 -Wl,--as-needed -Wl,-rpath,${prefix}/lib" \
  PKG_CONFIG_PATH="/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig" \
  "$SRC/configure" \
    --prefix="$prefix" \
    --libdir="$prefix/lib" \
    --shlibdir="$prefix/lib" \
    --incdir="$prefix/include" \
    --extra-version="rabbit-${level}" \
    --cpu="$level" \
    "${COMMON_FLAGS[@]}"

  make -j"$(nproc)"
  make install

  export LD_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

  "$prefix/bin/ffmpeg" -hide_banner -buildconf > "$prefix/buildconf.txt"
  "$prefix/bin/ffmpeg" -hide_banner -hwaccels  > "$prefix/hwaccels.txt"
  "$prefix/bin/ffmpeg" -hide_banner -filters   > "$prefix/filters.txt"
  "$prefix/bin/ffmpeg" -hide_banner -encoders  > "$prefix/encoders.txt"
  "$prefix/bin/ffmpeg" -hide_banner -decoders  > "$prefix/decoders.txt"

  # Vulkan filters are silently dropped when configure finds no GLSL compiler
  if ! grep -q nlmeans_vulkan "$prefix/filters.txt"; then
    echo "ERROR: nlmeans_vulkan filter missing from ${level} build" >&2
    exit 1
  fi

  tar --zstd -cpf "$OUT/ffmpeg-${level}.tar.zst" -C /opt "ffmpeg-${level}"

  echo "==== Done: $OUT/ffmpeg-${level}.tar.zst ===="
}

build_one x86-64-v2
build_one x86-64-v3
build_one x86-64-v4