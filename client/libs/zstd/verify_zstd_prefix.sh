#!/bin/bash
# Verifies codemagic_patch_zstd_prefix.h fully isolates the vendored zstd:
#   (1) no bare zstd/xxhash symbol is exported from the definitions
#       (except the allowed ABI-stable *_isError predicates),
#   (2) the caller (artifacts.c) references only the renamed CMPATCH_* symbols,
#   (3) the zstd objects link among themselves,
#   (4) caller + definitions link together with no name mismatch.
# Run after regenerating the header or upgrading zstd. Exit 0 = isolated.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"           # .../client/libs/zstd
ZSTD_DIR="$HERE"
ROOT="$(cd "$ZSTD_DIR/../.." && pwd)"           # .../client
LIB="$ZSTD_DIR/lib"
HDR="$ZSTD_DIR/codemagic_patch_zstd_prefix.h"
SYSROOT="$(xcrun --show-sdk-path)"
CC="$(xcrun -f clang)"
fail=0

run_one_opt() {
  local OPT="$1"
  local WORK; WORK="$(mktemp -d)"
  local COMMON=(-c "$OPT" -arch arm64 -isysroot "$SYSROOT"
    -DZSTD_DISABLE_ASM=1 -DZSTD_LIB_DEPRECATED=0 -include "$HDR"
    -I"$LIB" -I"$LIB/common" -I"$LIB/decompress"
    -I"$ROOT/libs/artifacts" -I"$ROOT/libs/hdiffpatch")
  local FILES=(common/entropy_common.c common/error_private.c common/fse_decompress.c
    common/xxhash.c common/zstd_common.c decompress/huf_decompress.c
    decompress/zstd_ddict.c decompress/zstd_decompress.c decompress/zstd_decompress_block.c)
  for f in "${FILES[@]}"; do
    "$CC" "${COMMON[@]}" "$LIB/$f" -o "$WORK/z_$(echo "$f"|tr / _).o" || { echo "[$OPT] COMPILE FAIL: $f"; fail=1; }
  done
  "$CC" "${COMMON[@]}" "$ROOT/libs/artifacts/codemagic_patch_artifacts.c" -o "$WORK/artifacts.o" \
    || { echo "[$OPT] COMPILE FAIL: artifacts.c"; fail=1; }

  local leaked
  leaked="$(nm -g "$WORK"/z_*.o 2>/dev/null \
    | awk '$2 != "U" && $3 ~ /^_/ { print substr($3,2) }' \
    | grep -E '^(ZSTD_|ZSTDv|HUF_|FSE_|FSEv|ERR_|POOL_|HIST_|ZDICT_|XXH)' \
    | grep -vE '^CMPATCH_' | grep -vE '^(ZSTD|FSE|HUF)_isError$' | sort -u)"
  [ -n "$leaked" ] && { echo "[$OPT] (1) LEAKED bare definitions:"; echo "$leaked" | sed 's/^/      /'; fail=1; } \
                   || echo "[$OPT] (1) OK — no bare zstd/xxhash export (except allowed *_isError)"

  local badref
  badref="$(nm -gu "$WORK/artifacts.o" 2>/dev/null | awk '{print $NF}' | sed 's/^_//' \
    | grep -E '^(ZSTD_|HUF_|FSE_|XXH)' | grep -vE '^CMPATCH_' | grep -vE '^(ZSTD|FSE|HUF)_isError$' | sort -u)"
  [ -n "$badref" ] && { echo "[$OPT] (2) caller still references BARE zstd:"; echo "$badref" | sed 's/^/      /'; fail=1; } \
                   || echo "[$OPT] (2) OK — caller references only CMPATCH_* zstd symbols"

  "$CC" -arch arm64 -isysroot "$SYSROOT" -dynamiclib "$WORK"/z_*.o -o "$WORK/libz.dylib" 2>"$WORK/link.err" \
    && echo "[$OPT] (3) OK — zstd objects link cleanly after rename" \
    || { echo "[$OPT] (3) LINK FAIL:"; sed 's/^/      /' "$WORK/link.err"; fail=1; }

  if "$CC" -arch arm64 -isysroot "$SYSROOT" -dynamiclib -undefined dynamic_lookup \
       "$WORK"/z_*.o "$WORK/artifacts.o" -o "$WORK/libfull.dylib" 2>"$WORK/link2.err"; then
    local unresolved
    unresolved="$(nm -u "$WORK/libfull.dylib" 2>/dev/null | awk '{print $NF}' | sed 's/^_//' \
      | grep -E '^(CMPATCH_ZSTD|CMPATCH_HUF|CMPATCH_FSE|CMPATCH_ERR|ZSTD_|HUF_|FSE_|XXH)' \
      | grep -vE '^(ZSTD|FSE|HUF)_isError$' | sort -u)"
    [ -n "$unresolved" ] && { echo "[$OPT] (4) UNRESOLVED zstd refs (name mismatch!):"; echo "$unresolved" | sed 's/^/      /'; fail=1; } \
                         || echo "[$OPT] (4) OK — caller's zstd refs all resolve to renamed defs"
  else
    echo "[$OPT] (4) LINK FAIL:"; sed 's/^/      /' "$WORK/link2.err"; fail=1
  fi
  rm -rf "$WORK"
}

run_one_opt -O0
run_one_opt -Os
echo "==================================="
[ "$fail" -eq 0 ] && echo "ALL CHECKS PASSED ✅" || echo "CHECKS FAILED ❌"
exit "$fail"
