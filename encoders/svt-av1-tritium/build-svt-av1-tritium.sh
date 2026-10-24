#!/usr/bin/env bash
set -euo pipefail

SRC=/src/svt-av1-tritium
OUT=/out
mkdir -p "$OUT"

# Set ENABLE_PGO=0 to skip profile-guided optimization entirely.
ENABLE_PGO="${ENABLE_PGO:-1}"

COMMON_CFLAGS="-O3 -pipe -mtune=generic"
COMMON_LDFLAGS="-static -static-libgcc -static-libstdc++ -fuse-ld=lld"

# clang's LTO writes LLVM bitcode into the intermediate static archives, which
# GNU ar/ranlib/nm cannot read. Point CMake at the LLVM equivalents when
# they're available so the static link step succeeds.
LLVM_AR="$(command -v llvm-ar || true)"
LLVM_RANLIB="$(command -v llvm-ranlib || true)"
LLVM_NM="$(command -v llvm-nm || true)"

JOBS="$(nproc)"

# ---------------------------------------------------------------------------
# Detect the highest x86-64 micro-architecture level the BUILD HOST can run.
#
# PGO works by executing the freshly built (instrumented) encoder over a
# sample clip. A binary compiled for x86-64-v4 uses AVX-512 and will crash
# with SIGILL on a host that lacks it, so PGO can only be applied to a target
# level the host itself is able to execute. We fall back to a non-PGO (but
# still LTO-optimized) build for any level the host can't run.
# ---------------------------------------------------------------------------
detect_host_level() {
  local ld="/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
  if "$ld" --help 2>/dev/null | grep -q 'x86-64-v4 (supported, searched)'; then
    echo 4; return
  elif "$ld" --help 2>/dev/null | grep -q 'x86-64-v3 (supported, searched)'; then
    echo 3; return
  fi

  local flags
  flags=" $(grep -m1 '^flags' /proc/cpuinfo | cut -d: -f2- || true) "
  local ok=1
  for f in avx512f avx512bw avx512cd avx512dq avx512vl; do
    case "$flags" in *" $f "*) ;; *) ok=0 ;; esac
  done
  if [ "$ok" -eq 1 ]; then echo 4; return; fi

  ok=1
  for f in avx avx2 bmi1 bmi2 f16c fma lzcnt movbe; do
    case "$flags" in *" $f "*) ;; *) ok=0 ;; esac
  done
  if [ "$ok" -eq 1 ]; then echo 3; return; fi

  echo 2
}

HOST_LEVEL="$(detect_host_level)"
echo "==== Build host supports up to x86-64-v${HOST_LEVEL} ===="
echo "==== Compiler: clang $(clang -dumpversion 2>/dev/null || echo '?') / lld ===="
if [ "$ENABLE_PGO" = "1" ]; then
  echo "==== PGO: enabled (per-level, gated on host capability) ===="
else
  echo "==== PGO: disabled via ENABLE_PGO=0 ===="
fi

build_one() {
  local level="$1"       # e.g. x86-64-v3
  local level_num="$2"   # e.g. 3

  echo
  echo "==== Building SVT-AV1-Tritium for ${level} ===="

  rm -rf "$SRC/Build/linux/Release" "$SRC/Bin/Release"

  # AVX-512 only matters for v4; v2/v3 CPUs can't execute it.
  local avx512_flag="disable-avx512"
  [ "$level_num" -ge 4 ] && avx512_flag="enable-avx512"

  # Enable PGO only when the host can actually run this target's ISA.
  local pgo_flag=""
  if [ "$ENABLE_PGO" = "1" ]; then
    if [ "$HOST_LEVEL" -ge "$level_num" ]; then
      pgo_flag="enable-pgo"
      echo "---- ${level}: PGO ENABLED (host can execute this ISA) ----"
    else
      echo "---- ${level}: PGO SKIPPED (host is x86-64-v${HOST_LEVEL}, cannot run ${level}); LTO-only ----"
    fi
  fi

  cd "$SRC/Build/linux"

  ./build.sh release static \
    cc=clang cxx=clang++ \
    "jobs=${JOBS}" \
    --disable-native \
    --enable-lto \
    "${avx512_flag}" \
    ${pgo_flag:+$pgo_flag} \
    -- \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_C_FLAGS="${COMMON_CFLAGS} -march=${level}" \
      -DCMAKE_CXX_FLAGS="${COMMON_CFLAGS} -march=${level}" \
      -DCMAKE_EXE_LINKER_FLAGS="${COMMON_LDFLAGS}" \
      ${LLVM_AR:+-DCMAKE_AR=$LLVM_AR} \
      ${LLVM_RANLIB:+-DCMAKE_RANLIB=$LLVM_RANLIB} \
      ${LLVM_NM:+-DCMAKE_NM=$LLVM_NM}

  local out_dir="$OUT/${level//-/_}"
  mkdir -p "$out_dir"
  cp "$SRC/Bin/Release/SvtAv1EncApp" "$out_dir/SvtAv1EncApp"
  strip "$out_dir/SvtAv1EncApp" || true
  chmod +x "$out_dir/SvtAv1EncApp"

  echo "---- ${level} binary info ----"
  file "$out_dir/SvtAv1EncApp" || true
  "$out_dir/SvtAv1EncApp" --version > "$out_dir/version.txt" 2>&1 || true
  cat "$out_dir/version.txt" || true

  echo "==== Done: $out_dir/SvtAv1EncApp ===="
}

build_one x86-64-v2 2
build_one x86-64-v3 3
build_one x86-64-v4 4

echo
echo "All builds complete. Output tree:"
find "$OUT" -type f | sort