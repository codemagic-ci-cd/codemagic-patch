#pragma once

#ifdef __cplusplus
extern "C" {
#endif

int codemagic_patch_compute_package_hash(const char *contents_dir, char out_hex[65]);

#ifdef __cplusplus
}
#endif
