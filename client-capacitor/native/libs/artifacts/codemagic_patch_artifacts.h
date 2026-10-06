#ifndef CODEMAGIC_PATCH_ARTIFACTS_H
#define CODEMAGIC_PATCH_ARTIFACTS_H

#ifdef __cplusplus
extern "C" {
#endif

int codemagic_patch_decompress_zstd_file(const char *input_path,
                                  const char *output_path);
int codemagic_patch_extract_tar_zstd(const char *archive_path, const char *out_dir);
int codemagic_patch_apply_hdiffpatch(const char *base_dir,
                              const char *patch_path,
                              const char *out_dir);
int codemagic_patch_validate_contents_tree(const char *root_dir);

#ifdef __cplusplus
}
#endif

#endif
