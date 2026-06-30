#include "codemagic_patch_artifacts.h"

#include <errno.h>
#include <stdint.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "codemagic_patch_hpatch.h"
#include "zstd.h"

#define CODEMAGIC_PATCH_IO_BUFFER_SIZE (128 * 1024)
#define CODEMAGIC_PATCH_TAR_BLOCK_SIZE 512

static int codemagic_patch_mkdirs(const char *path) {
  char *copy = NULL;
  size_t len = 0;

  if (path == NULL || path[0] == '\0') {
    return -1;
  }

  len = strlen(path);
  copy = (char *)malloc(len + 1);
  if (copy == NULL) {
    return -1;
  }
  memcpy(copy, path, len + 1);

  for (char *cursor = copy + 1; *cursor != '\0'; ++cursor) {
    if (*cursor == '/') {
      *cursor = '\0';
      if (mkdir(copy, 0700) != 0 && errno != EEXIST) {
        free(copy);
        return -1;
      }
      *cursor = '/';
    }
  }

  if (mkdir(copy, 0700) != 0 && errno != EEXIST) {
    free(copy);
    return -1;
  }

  free(copy);
  return 0;
}

static int codemagic_patch_parent_mkdirs(const char *path) {
  char *copy = NULL;
  char *slash = NULL;
  int result = 0;

  copy = (char *)malloc(strlen(path) + 1);
  if (copy == NULL) {
    return -1;
  }
  strcpy(copy, path);

  slash = strrchr(copy, '/');
  if (slash != NULL) {
    *slash = '\0';
    if (copy[0] != '\0') {
      result = codemagic_patch_mkdirs(copy);
    }
  }

  free(copy);
  return result;
}

static int codemagic_patch_skip_bytes(FILE *file, uint64_t bytes) {
  unsigned char buffer[CODEMAGIC_PATCH_TAR_BLOCK_SIZE];

  while (bytes > 0) {
    size_t chunk = bytes > sizeof(buffer) ? sizeof(buffer) : (size_t)bytes;
    if (fread(buffer, 1, chunk, file) != chunk) {
      return -1;
    }
    bytes -= chunk;
  }

  return 0;
}

static int codemagic_patch_is_zero_block(const unsigned char block[CODEMAGIC_PATCH_TAR_BLOCK_SIZE]) {
  for (size_t index = 0; index < CODEMAGIC_PATCH_TAR_BLOCK_SIZE; ++index) {
    if (block[index] != 0) {
      return 0;
    }
  }
  return 1;
}

static int codemagic_patch_read_tar_string(char *out,
                                    size_t out_size,
                                    const unsigned char *field,
                                    size_t field_size) {
  size_t len = 0;

  while (len < field_size && field[len] != '\0') {
    ++len;
  }

  if (len + 1 > out_size) {
    return -1;
  }

  memcpy(out, field, len);
  out[len] = '\0';
  return 0;
}

static int codemagic_patch_read_tar_octal(const unsigned char *field,
                                   size_t field_size,
                                   uint64_t *out) {
  char value[32];
  char *end = NULL;

  if (field_size >= sizeof(value)) {
    return -1;
  }

  memcpy(value, field, field_size);
  value[field_size] = '\0';
  *out = strtoull(value, &end, 8);
  return end == value ? -1 : 0;
}

static int codemagic_patch_validate_relative_path(const char *path) {
  const char *cursor = path;

  if (path == NULL || path[0] == '\0' || path[0] == '/' ||
      strchr(path, '\\') != NULL) {
    return -1;
  }

  while (*cursor != '\0') {
    const char *slash = strchr(cursor, '/');
    size_t len = slash == NULL ? strlen(cursor) : (size_t)(slash - cursor);

    if (len == 0 ||
        (len == 1 && cursor[0] == '.') ||
        (len == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      return -1;
    }

    if (slash == NULL) {
      break;
    }
    cursor = slash + 1;
  }

  return 0;
}

static int codemagic_patch_should_skip_path(const char *path) {
  const char *name = strrchr(path, '/');
  name = name == NULL ? path : name + 1;
  return strcmp(name, ".DS_Store") == 0 ||
         strcmp(path, "__MACOSX") == 0 ||
         strncmp(path, "__MACOSX/", 9) == 0;
}

static int codemagic_patch_join_path(char **out, const char *root, const char *relative) {
  size_t root_len = strlen(root);
  size_t rel_len = strlen(relative);
  int need_slash = root_len > 0 && root[root_len - 1] != '/';

  *out = (char *)malloc(root_len + (need_slash ? 1 : 0) + rel_len + 1);
  if (*out == NULL) {
    return -1;
  }

  memcpy(*out, root, root_len);
  if (need_slash) {
    (*out)[root_len] = '/';
  }
  memcpy(*out + root_len + (need_slash ? 1 : 0), relative, rel_len);
  (*out)[root_len + (need_slash ? 1 : 0) + rel_len] = '\0';
  return 0;
}

int codemagic_patch_decompress_zstd_file(const char *input_path,
                                  const char *output_path) {
  FILE *input = NULL;
  FILE *output = NULL;
  ZSTD_DStream *stream = NULL;
  void *input_buffer = NULL;
  void *output_buffer = NULL;
  size_t last_status = 1;
  int result = -1;

  input = fopen(input_path, "rb");
  if (input == NULL) {
    goto cleanup;
  }

  if (codemagic_patch_parent_mkdirs(output_path) != 0) {
    goto cleanup;
  }

  output = fopen(output_path, "wb");
  if (output == NULL) {
    goto cleanup;
  }

  stream = ZSTD_createDStream();
  input_buffer = malloc(ZSTD_DStreamInSize());
  output_buffer = malloc(ZSTD_DStreamOutSize());
  if (stream == NULL || input_buffer == NULL || output_buffer == NULL ||
      ZSTD_isError(ZSTD_initDStream(stream))) {
    goto cleanup;
  }

  for (;;) {
    size_t read_count = fread(input_buffer, 1, ZSTD_DStreamInSize(), input);
    ZSTD_inBuffer in = {input_buffer, read_count, 0};

    if (read_count == 0 && ferror(input)) {
      goto cleanup;
    }

    while (in.pos < in.size) {
      ZSTD_outBuffer out = {output_buffer, ZSTD_DStreamOutSize(), 0};
      size_t status = ZSTD_decompressStream(stream, &out, &in);
      if (ZSTD_isError(status)) {
        goto cleanup;
      }
      last_status = status;
      if (out.pos > 0 && fwrite(output_buffer, 1, out.pos, output) != out.pos) {
        goto cleanup;
      }
    }

    if (read_count == 0) {
      if (last_status != 0) {
        goto cleanup;
      }
      break;
    }
  }

  result = 0;

cleanup:
  if (stream != NULL) {
    ZSTD_freeDStream(stream);
  }
  free(input_buffer);
  free(output_buffer);
  if (input != NULL) {
    fclose(input);
  }
  if (output != NULL) {
    if (fclose(output) != 0) {
      result = -1;
    }
  }
  if (result != 0 && output_path != NULL) {
    unlink(output_path);
  }
  return result;
}

static int codemagic_patch_extract_tar_file(const char *tar_path, const char *out_dir) {
  FILE *tar = NULL;
  unsigned char header[CODEMAGIC_PATCH_TAR_BLOCK_SIZE];
  int result = -1;

  tar = fopen(tar_path, "rb");
  if (tar == NULL || codemagic_patch_mkdirs(out_dir) != 0) {
    goto cleanup;
  }

  for (;;) {
    char name[101];
    char prefix[156];
    char relative[257];
    char *target = NULL;
    uint64_t size = 0;
    uint64_t padding = 0;
    unsigned char typeflag = 0;

    if (fread(header, 1, sizeof(header), tar) != sizeof(header)) {
      goto cleanup;
    }
    if (codemagic_patch_is_zero_block(header)) {
      result = 0;
      goto cleanup;
    }

    if (codemagic_patch_read_tar_string(name, sizeof(name), header, 100) != 0 ||
        codemagic_patch_read_tar_string(prefix, sizeof(prefix), header + 345, 155) != 0 ||
        codemagic_patch_read_tar_octal(header + 124, 12, &size) != 0) {
      goto cleanup;
    }

    typeflag = header[156];
    if (prefix[0] != '\0') {
      if (snprintf(relative, sizeof(relative), "%s/%s", prefix, name) >=
          (int)sizeof(relative)) {
        goto cleanup;
      }
    } else {
      if (snprintf(relative, sizeof(relative), "%s", name) >= (int)sizeof(relative)) {
        goto cleanup;
      }
    }

    if (codemagic_patch_validate_relative_path(relative) != 0) {
      goto cleanup;
    }

    if (typeflag != '\0' && typeflag != '0') {
      goto cleanup;
    }

    padding = (CODEMAGIC_PATCH_TAR_BLOCK_SIZE - (size % CODEMAGIC_PATCH_TAR_BLOCK_SIZE)) %
              CODEMAGIC_PATCH_TAR_BLOCK_SIZE;

    if (codemagic_patch_should_skip_path(relative)) {
      if (codemagic_patch_skip_bytes(tar, size + padding) != 0) {
        goto cleanup;
      }
      continue;
    }

    if (codemagic_patch_join_path(&target, out_dir, relative) != 0 ||
        codemagic_patch_parent_mkdirs(target) != 0) {
      free(target);
      goto cleanup;
    }

    FILE *out = fopen(target, "wb");
    free(target);
    if (out == NULL) {
      goto cleanup;
    }

    uint64_t remaining = size;
    unsigned char buffer[CODEMAGIC_PATCH_IO_BUFFER_SIZE];
    while (remaining > 0) {
      size_t chunk = remaining > sizeof(buffer) ? sizeof(buffer) : (size_t)remaining;
      if (fread(buffer, 1, chunk, tar) != chunk ||
          fwrite(buffer, 1, chunk, out) != chunk) {
        fclose(out);
        goto cleanup;
      }
      remaining -= chunk;
    }

    if (fclose(out) != 0 || codemagic_patch_skip_bytes(tar, padding) != 0) {
      goto cleanup;
    }
  }

cleanup:
  if (tar != NULL) {
    fclose(tar);
  }
  return result;
}

int codemagic_patch_extract_tar_zstd(const char *archive_path, const char *out_dir) {
  char *tar_path = NULL;
  int result = -1;

  if (archive_path == NULL || out_dir == NULL) {
    return -1;
  }

  tar_path = (char *)malloc(strlen(out_dir) + strlen("/.codemagic_patch-bundle.tar") + 1);
  if (tar_path == NULL) {
    return -1;
  }
  sprintf(tar_path, "%s/.codemagic_patch-bundle.tar", out_dir);

  if (codemagic_patch_mkdirs(out_dir) != 0 ||
      codemagic_patch_decompress_zstd_file(archive_path, tar_path) != 0) {
    goto cleanup;
  }

  result = codemagic_patch_extract_tar_file(tar_path, out_dir);

cleanup:
  if (tar_path != NULL) {
    unlink(tar_path);
    free(tar_path);
  }
  return result;
}

int codemagic_patch_apply_hdiffpatch(const char *base_dir,
                              const char *patch_path,
                              const char *out_dir) {
  if (base_dir == NULL || patch_path == NULL || out_dir == NULL) {
    return -1;
  }

  return codemagic_patch_hpatchz(base_dir, patch_path, out_dir, 1024 * 1024, 1) == 0 ? 0 : -1;
}

static int codemagic_patch_validate_contents_tree_inner(const char *root_dir,
                                                 const char *relative_dir) {
  char *absolute_dir = NULL;
  DIR *dir = NULL;
  struct dirent *entry = NULL;
  int result = -1;

  if (relative_dir == NULL || relative_dir[0] == '\0') {
    absolute_dir = (char *)malloc(strlen(root_dir) + 1);
    if (absolute_dir == NULL) {
      return -1;
    }
    strcpy(absolute_dir, root_dir);
  } else if (codemagic_patch_join_path(&absolute_dir, root_dir, relative_dir) != 0) {
    return -1;
  }

  dir = opendir(absolute_dir);
  if (dir == NULL) {
    goto cleanup;
  }

  while ((entry = readdir(dir)) != NULL) {
    char relative_child[1024];
    char *absolute_child = NULL;
    struct stat info;

    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }

    if (relative_dir == NULL || relative_dir[0] == '\0') {
      if (snprintf(relative_child, sizeof(relative_child), "%s", entry->d_name) >=
          (int)sizeof(relative_child)) {
        goto cleanup;
      }
    } else if (snprintf(relative_child,
                        sizeof(relative_child),
                        "%s/%s",
                        relative_dir,
                        entry->d_name) >= (int)sizeof(relative_child)) {
      goto cleanup;
    }

    if (codemagic_patch_validate_relative_path(relative_child) != 0 ||
        codemagic_patch_join_path(&absolute_child, root_dir, relative_child) != 0) {
      free(absolute_child);
      goto cleanup;
    }

    if (lstat(absolute_child, &info) != 0) {
      free(absolute_child);
      goto cleanup;
    }

    free(absolute_child);

    if (S_ISDIR(info.st_mode)) {
      if (codemagic_patch_validate_contents_tree_inner(root_dir, relative_child) != 0) {
        goto cleanup;
      }
      continue;
    }

    if (!S_ISREG(info.st_mode)) {
      goto cleanup;
    }
  }

  result = 0;

cleanup:
  if (dir != NULL) {
    closedir(dir);
  }
  free(absolute_dir);
  return result;
}

int codemagic_patch_validate_contents_tree(const char *root_dir) {
  struct stat info;

  if (root_dir == NULL ||
      lstat(root_dir, &info) != 0 ||
      !S_ISDIR(info.st_mode)) {
    return -1;
  }

  return codemagic_patch_validate_contents_tree_inner(root_dir, "");
}
