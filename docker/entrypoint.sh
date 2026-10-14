#!/bin/sh
set -e

export PATH="/opt/vs-venv/bin:${PATH}"

BIN_DIR="/opt/binaries"

TARGET_ESSENTIAL="/usr/local/bin/SVT-AV1-Essential"
TARGET_HDR="/usr/local/bin/SVT-AV1-HDR"
TARGET_5FISH="/usr/local/bin/SVT-AV1-5FISH"
TARGET_FFMPEG="/usr/local/bin/ffmpeg"
TARGET_FFPROBE="/usr/local/bin/ffprobe"


# Always expose the arch-independent language-detector
if ! command -v language-detector >/dev/null 2>&1; then
	ln -sf "$BIN_DIR/language-detector" /usr/local/bin/language-detector
fi

echo "[entrypoint] Detecting CPU..."

SUPPORTS_V4=0
SUPPORTS_V3=0

# Preferred: ask the dynamic loader
if /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --help 2>/dev/null \
	| grep -q 'x86-64-v4 (supported, searched)'; then
	SUPPORTS_V4=1
elif /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 --help 2>/dev/null \
	| grep -q 'x86-64-v3 (supported, searched)'; then
	SUPPORTS_V3=1
else
	# Fallback: check CPU flags directly
	FLAGS=$(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2- || true)
	MISSING_V4=""
	MISSING_V3=""

	# Check x86-64-v4 features
	for f in avx512f avx512bw avx512cd avx512dq avx512vl; do
		case " $FLAGS " in
			*" $f "*) ;;
			*) MISSING_V4="$MISSING_V4 $f" ;;
		esac
	done
	[ -z "$MISSING_V4" ] && SUPPORTS_V4=1

	if [ "$SUPPORTS_V4" -eq 0 ]; then
		# Check x86-64-v3 features
		for f in avx avx2 bmi1 bmi2 f16c fma lzcnt movbe; do
			case " $FLAGS " in
				*" $f "*) ;;
				*) MISSING_V3="$MISSING_V3 $f" ;;
			esac
		done
		[ -z "$MISSING_V3" ] && SUPPORTS_V3=1
	fi
fi

if [ "$SUPPORTS_V4" -eq 1 ]; then
	ARCH_NAME="x86-64-v4"
	ARCH_DIR="$BIN_DIR/x86_64_v4"
	FFMPEG_DIR="/opt/ffmpeg-x86-64-v4"
	echo "[entrypoint] CPU supports x86-64-v4"
elif [ "$SUPPORTS_V3" -eq 1 ]; then
	ARCH_NAME="x86-64-v3"
	ARCH_DIR="$BIN_DIR/x86_64_v3"
	FFMPEG_DIR="/opt/ffmpeg-x86-64-v3"
	echo "[entrypoint] CPU supports x86-64-v3"
else
	ARCH_NAME="x86-64-v2"
	ARCH_DIR="$BIN_DIR/x86_64_v2"
	FFMPEG_DIR="/opt/ffmpeg-x86-64-v2"
	echo "[entrypoint] CPU supports x86-64-v2"
fi

# Expose SVT-AV1-ESSENTIAL encoder
if [ -x "$ARCH_DIR/SVT-AV1-Essential" ]; then
	ln -sf "$ARCH_DIR/SVT-AV1-Essential" "$TARGET_ESSENTIAL"
fi

# Expose SVT-AV1-HDR encoder
if [ -x "$ARCH_DIR/SVT-AV1-HDR" ]; then
	ln -sf "$ARCH_DIR/SVT-AV1-HDR" "$TARGET_HDR"
fi

# Expose SVT-AV1-5FISH encoder
if [ -x "$ARCH_DIR/SVT-AV1-5FISH" ]; then
	ln -sf "$ARCH_DIR/SVT-AV1-5FISH" "$TARGET_5FISH"
fi

if [ -x /opt/vs-venv/bin/vapoursynth ]; then
  export VSSCRIPT_PATH="$("/opt/vs-venv/bin/vapoursynth" get-vsscript)"
fi

# Expose custom FFmpeg
if [ -x "$FFMPEG_DIR/bin/ffmpeg" ]; then
	ln -sf "$FFMPEG_DIR/bin/ffmpeg" "$TARGET_FFMPEG"
else
	echo "[entrypoint] ERROR: missing $FFMPEG_DIR/bin/ffmpeg" >&2
	exit 1
fi

if [ -x "$FFMPEG_DIR/bin/ffprobe" ]; then
	ln -sf "$FFMPEG_DIR/bin/ffprobe" "$TARGET_FFPROBE"
else
	echo "[entrypoint] ERROR: missing $FFMPEG_DIR/bin/ffprobe" >&2
	exit 1
fi

# Make matching FFmpeg shared libs visible
export LD_LIBRARY_PATH="$FFMPEG_DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Refresh linker cache where possible
ldconfig 2>/dev/null || true

echo "[entrypoint] Using FFmpeg: $("$TARGET_FFMPEG" -hide_banner -version | head -n1 | sed -E 's/^[^ ]+ version ([^ ]+).*/\1/')"
echo "[entrypoint] Using FFprobe: $("$TARGET_FFPROBE" -hide_banner -version | head -n1 | sed -E 's/^[^ ]+ version ([^ ]+).*/\1/')"
echo "[entrypoint] Using SVT-AV1-Essential: $("$TARGET_ESSENTIAL" --version | head -n1 | sed -E 's/.* v([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
echo "[entrypoint] Using SVT-AV1-HDR: $("$TARGET_HDR" --version | head -n1 | sed -E 's/.* v([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
echo "[entrypoint] Using SVT-AV1-5FISH: $("$TARGET_5FISH" --version | head -n1 | sed -E 's/.* v([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
echo "[entrypoint] Using regrain: $(regrain --version | head -n1 | sed -E 's/^[^ ]+ ([^ ]+).*/\1/')"

USER_VS_DIR="/config/vapoursynth/presets"
if [ ! -d "$USER_VS_DIR" ]; then
	mkdir -p "$USER_VS_DIR"
	cat > "$USER_VS_DIR/README.md" <<'EOF'
Drop your custom VapourSynth presets in this directory.

Each preset needs two files with the same stem:
  myfilter.vpy   - the script
  myfilter.json  - the manifest (id, levels, params, defaults)

See https://github.com/Rabbit-Company/RabbitEncoder/tree/main/vapoursynth/presets for working examples.

After adding a preset, hit "Reload presets" in the dashboard's Advanced
Settings panel (or POST /api/vs-presets/reload).
EOF
fi

exec "$@"