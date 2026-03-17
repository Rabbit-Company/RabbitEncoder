# Build stage

FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json ./
RUN bun install

COPY src/ ./src/
COPY public/ ./public/

RUN bun build src/index.ts --outfile rabbit-encoder --target bun --compile --production

# Runtime stage

FROM archlinux:latest

ENV BUN_INSTALL=/usr/local/bun
ENV PATH="$BUN_INSTALL/bin:/usr/local/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1

ENV LLVM_CONFIG=/usr/bin/llvm-config-21

RUN pacman -Syu --noconfirm && pacman -S --noconfirm --needed \
    llvm21 llvm21-libs \
    curl unzip ca-certificates \
    ffmpeg mediainfo mkvtoolnix-cli opus-tools \
    vapoursynth ffms2 \
    python python-pip python-rich \
    base-devel git sudo \
    && pacman -Scc --noconfirm

# Set up non-root user for AUR builds
RUN useradd -m builder && \
    echo "builder ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Install yay (AUR helper)
USER builder
WORKDIR /tmp
RUN git clone https://aur.archlinux.org/yay-bin.git && \
    cd yay-bin && makepkg -si --noconfirm && \
    cd .. && rm -rf yay-bin

# Install AUR packages: VapourSynth plugins
RUN yay -S --noconfirm --needed --answerdiff None --answerclean None \
    vapoursynth-plugin-vsakarin-git

RUN yay -S --noconfirm --needed --removemake --answerdiff None --answerclean None \
    vapoursynth-plugin-vszip \
    vapoursynth-plugin-vsjetpack

# Switch back to root
USER root
WORKDIR /

# Clean up build tools to shrink image
RUN pacman -Rns --noconfirm base-devel git sudo 2>/dev/null || true && \
    pacman -Scc --noconfirm && \
    rm -rf /home/builder/.cache /tmp/* /var/cache/pacman/pkg/*

# Copy SVT-AV1-Essential binary
COPY binaries/SvtAv1EncApp /usr/local/bin/SvtAv1EncApp
RUN chmod +x /usr/local/bin/SvtAv1EncApp

# Install vsjetpack Python bindings
RUN pip install --break-system-packages vsjetpack 2>/dev/null || true

# Auto-Boost-Essential script
RUN mkdir -p /opt/Auto-Boost-Essential
COPY scripts/Auto-Boost-Essential.py /opt/Auto-Boost-Essential/

# Application
WORKDIR /app

COPY --from=builder /app/rabbit-encoder /app/

RUN mkdir -p /data/input /data/output /data/temp

EXPOSE 3000
CMD ["/app/rabbit-encoder"]