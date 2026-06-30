#ifndef CODEMAGIC_PATCH_HPATCH_H
#define CODEMAGIC_PATCH_HPATCH_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int codemagic_patch_hpatchz(const char *old_dir,
                     const char *patch_path,
                     const char *out_dir,
                     int64_t cache_memory,
                     size_t thread_count);

#ifdef __cplusplus
}
#endif

#endif
