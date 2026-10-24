FROM debian:testing

USER root
ENV DEBIAN_FRONTEND=noninteractive

ARG SVTAV1TRITIUM_REPO=https://github.com/Uranite/svt-av1-tritium.git
ARG SVTAV1TRITIUM_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates \
	curl \
	git \
	build-essential \
	clang \
	lld \
	llvm \
	pkg-config \
	cmake \
	ninja-build \
	nasm \
	yasm \
	file \
	binutils \
	&& rm -rf /var/lib/apt/lists/*

# clang's PGO-generate phase links the compiler-rt profile runtime
# (libclang_rt.profile.a), which ships in a separate, version-matched package
# that clang/llvm don't pull in on their own.
RUN apt-get update \
 && CLANG_MAJOR="$(clang --version | sed -nE 's/.*version ([0-9]+).*/\1/p' | head -n1)" \
 && apt-get install -y --no-install-recommends "libclang-rt-${CLANG_MAJOR}-dev" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Tritium has no version tags, so --version would only print the commit hash.
# Tag HEAD locally with the CMake version and short hash so it reads v4.2.0-<hash>.
RUN git clone "${SVTAV1TRITIUM_REPO}" svt-av1-tritium \
 && cd svt-av1-tritium \
 && git checkout "${SVTAV1TRITIUM_REF}" \
 && if ! git describe --tags --match 'v[0-9]*' >/dev/null 2>&1; then \
	VER="$(sed -nE 's/^project\(svt-av1 VERSION ([0-9.]+).*/\1/p' CMakeLists.txt)"; \
	git tag "v${VER}-$(git rev-parse --short=7 HEAD)"; \
 fi

COPY build-svt-av1-tritium.sh /usr/local/bin/build-svt-av1-tritium.sh
RUN chmod +x /usr/local/bin/build-svt-av1-tritium.sh

VOLUME ["/out"]
CMD ["/usr/local/bin/build-svt-av1-tritium.sh"]