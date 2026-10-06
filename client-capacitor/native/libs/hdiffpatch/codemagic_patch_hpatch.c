#include "codemagic_patch_hpatch.h"

#define _IS_NEED_PRINT_LOG 0
#define _IS_NEED_MAIN 0
#define _IS_NEED_CMDLINE 0
#define _IS_NEED_SFX 0
#define _IS_NEED_BSDIFF 0
#define _IS_NEED_VCDIFF 0
#define _IS_USED_MULTITHREAD 0
#define _IS_NEED_ALL_CompressPlugin 0
#define _IS_NEED_DEFAULT_CompressPlugin 0
#define _IS_NEED_ALL_ChecksumPlugin 0
#define _IS_NEED_DEFAULT_ChecksumPlugin 0
#define _CompressPlugin_zstd
#define _ChecksumPlugin_fadler64

#include "hpatchz.c"

static size_t codemagic_patch_limit_cache_memory(int64_t cache_memory) {
  const size_t min_cache_size = 1024 * 256;
  const size_t max_cache_size =
      ((sizeof(size_t) > 4) ? ((size_t)1 << 32) : ((size_t)1 << 30));

  if (cache_memory <= (int64_t)min_cache_size) {
    return min_cache_size;
  }

  return ((uint64_t)cache_memory < (uint64_t)max_cache_size)
             ? (size_t)cache_memory
             : max_cache_size;
}

int codemagic_patch_hpatchz(const char *old_dir,
                     const char *patch_path,
                     const char *out_dir,
                     int64_t cache_memory,
                     size_t thread_count) {
#if (_IS_NEED_DIR_DIFF_PATCH)
  const hpatch_BOOL is_dir_diff = getIsDirDiffFile(patch_path);
  if (is_dir_diff) {
    TDirPatchChecksumSet checksum_set = {
        0, hpatch_FALSE, hpatch_TRUE, hpatch_TRUE, hpatch_FALSE};
    return hpatch_dir(old_dir,
                      patch_path,
                      out_dir,
                      hpatch_FALSE,
                      codemagic_patch_limit_cache_memory(cache_memory),
                      kMaxOpenFileNumber_default_patch,
                      &checksum_set,
                      &defaultPatchDirlistener,
                      0,
                      0,
                      thread_count);
  }
#endif

  return hpatch(old_dir,
                patch_path,
                out_dir,
                hpatch_FALSE,
                codemagic_patch_limit_cache_memory(cache_memory),
                0,
                0,
                1,
                1,
                thread_count);
}
