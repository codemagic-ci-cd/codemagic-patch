#include "package_hash_v1.h"

#include "sha256.h"

#include <dirent.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

typedef struct {
  char **items;
  size_t count;
  size_t capacity;
} codemagic_patch_entry_list;

static int codemagic_patch_is_dot_entry(const char *name) {
  return strcmp(name, ".") == 0 || strcmp(name, "..") == 0;
}

static int codemagic_patch_is_excluded_file(const char *relative_path, const char *name) {
  return strcmp(name, ".DS_Store") == 0 ||
         strcmp(relative_path, "__MACOSX") == 0 ||
         strncmp(relative_path, "__MACOSX/", 9) == 0;
}

static char *codemagic_patch_join_path(const char *left, const char *right) {
  size_t left_len = strlen(left);
  size_t right_len = strlen(right);
  int needs_slash = left_len > 0 && left[left_len - 1] != '/';
  char *joined = (char *)malloc(left_len + (size_t)needs_slash + right_len + 1);
  if (!joined) return NULL;
  memcpy(joined, left, left_len);
  if (needs_slash) joined[left_len++] = '/';
  memcpy(joined + left_len, right, right_len);
  joined[left_len + right_len] = '\0';
  return joined;
}

static int codemagic_patch_entry_list_push(codemagic_patch_entry_list *list, char *entry) {
  if (list->count == list->capacity) {
    size_t next_capacity = list->capacity == 0 ? 16 : list->capacity * 2;
    char **next_items = (char **)realloc(list->items, next_capacity * sizeof(char *));
    if (!next_items) return 1;
    list->items = next_items;
    list->capacity = next_capacity;
  }

  list->items[list->count++] = entry;
  return 0;
}

static void codemagic_patch_entry_list_free(codemagic_patch_entry_list *list) {
  for (size_t i = 0; i < list->count; ++i) {
    free(list->items[i]);
  }
  free(list->items);
  list->items = NULL;
  list->count = 0;
  list->capacity = 0;
}

static int codemagic_patch_entry_compare(const void *left, const void *right) {
  const char *left_str = *(const char * const *)left;
  const char *right_str = *(const char * const *)right;
  return strcmp(left_str, right_str);
}

static char *codemagic_patch_make_entry(const char *relative_path, const char file_hash[65]) {
  size_t path_len = strlen(relative_path);
  char *entry = (char *)malloc(path_len + 1 + 64 + 1);
  if (!entry) return NULL;
  memcpy(entry, relative_path, path_len);
  entry[path_len] = ':';
  memcpy(entry + path_len + 1, file_hash, 64);
  entry[path_len + 65] = '\0';
  return entry;
}

static int codemagic_patch_collect_entries(
    const char *root,
    const char *relative_dir,
    codemagic_patch_entry_list *entries) {
  char *current_path = relative_dir[0] == '\0'
      ? strdup(root)
      : codemagic_patch_join_path(root, relative_dir);
  if (!current_path) return 1;

  DIR *dir = opendir(current_path);
  if (!dir) {
    free(current_path);
    return 2;
  }

  int result = 0;
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    const char *name = entry->d_name;
    if (codemagic_patch_is_dot_entry(name)) {
      continue;
    }

    char *relative_path = relative_dir[0] == '\0'
        ? strdup(name)
        : codemagic_patch_join_path(relative_dir, name);
    if (!relative_path) {
      result = 1;
      break;
    }

    char *absolute_path = codemagic_patch_join_path(root, relative_path);
    if (!absolute_path) {
      free(relative_path);
      result = 1;
      break;
    }

    struct stat info;
    if (lstat(absolute_path, &info) != 0) {
      free(absolute_path);
      free(relative_path);
      result = 3;
      break;
    }

    if (S_ISDIR(info.st_mode)) {
      result = codemagic_patch_collect_entries(root, relative_path, entries);
    } else if (S_ISREG(info.st_mode) && !codemagic_patch_is_excluded_file(relative_path, name)) {
      char file_hash[65];
      result = codemagic_patch_sha256_file_hex(absolute_path, file_hash);
      if (result == 0) {
        char *package_entry = codemagic_patch_make_entry(relative_path, file_hash);
        if (!package_entry || codemagic_patch_entry_list_push(entries, package_entry) != 0) {
          free(package_entry);
          result = 1;
        }
      }
    }

    free(absolute_path);
    free(relative_path);

    if (result != 0) {
      break;
    }
  }

  closedir(dir);
  free(current_path);
  return result;
}

static size_t codemagic_patch_json_escaped_len(const char *value) {
  size_t len = 0;
  for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
    switch (*p) {
      case '"':
      case '\\':
        len += 2;
        break;
      case '\b':
      case '\f':
      case '\n':
      case '\r':
      case '\t':
        len += 2;
        break;
      default:
        if (*p < 0x20) {
          len += 6;
        } else {
          len += 1;
        }
    }
  }
  return len;
}

static char *codemagic_patch_write_json_escaped(char *out, const char *value) {
  static const char hex[] = "0123456789abcdef";
  for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
    switch (*p) {
      case '"':
        *out++ = '\\';
        *out++ = '"';
        break;
      case '\\':
        *out++ = '\\';
        *out++ = '\\';
        break;
      case '\b':
        *out++ = '\\';
        *out++ = 'b';
        break;
      case '\f':
        *out++ = '\\';
        *out++ = 'f';
        break;
      case '\n':
        *out++ = '\\';
        *out++ = 'n';
        break;
      case '\r':
        *out++ = '\\';
        *out++ = 'r';
        break;
      case '\t':
        *out++ = '\\';
        *out++ = 't';
        break;
      default:
        if (*p < 0x20) {
          *out++ = '\\';
          *out++ = 'u';
          *out++ = '0';
          *out++ = '0';
          *out++ = hex[(*p >> 4) & 0x0f];
          *out++ = hex[*p & 0x0f];
        } else {
          *out++ = (char)*p;
        }
    }
  }
  return out;
}

static char *codemagic_patch_entries_to_json(const codemagic_patch_entry_list *entries) {
  size_t len = 2;
  for (size_t i = 0; i < entries->count; ++i) {
    if (i > 0) len += 1;
    len += 2 + codemagic_patch_json_escaped_len(entries->items[i]);
  }

  char *json = (char *)malloc(len + 1);
  if (!json) return NULL;

  char *cursor = json;
  *cursor++ = '[';
  for (size_t i = 0; i < entries->count; ++i) {
    if (i > 0) *cursor++ = ',';
    *cursor++ = '"';
    cursor = codemagic_patch_write_json_escaped(cursor, entries->items[i]);
    *cursor++ = '"';
  }
  *cursor++ = ']';
  *cursor = '\0';
  return json;
}

int codemagic_patch_compute_package_hash(const char *contents_dir, char out_hex[65]) {
  if (!contents_dir || !out_hex) {
    return 1;
  }

  struct stat root_stat;
  if (stat(contents_dir, &root_stat) != 0 || !S_ISDIR(root_stat.st_mode)) {
    return 2;
  }

  codemagic_patch_entry_list entries = {0};
  int result = codemagic_patch_collect_entries(contents_dir, "", &entries);
  if (result != 0) {
    codemagic_patch_entry_list_free(&entries);
    return result;
  }

  qsort(entries.items, entries.count, sizeof(char *), codemagic_patch_entry_compare);
  char *json = codemagic_patch_entries_to_json(&entries);
  if (!json) {
    codemagic_patch_entry_list_free(&entries);
    return 1;
  }

  codemagic_patch_sha256_ctx ctx;
  codemagic_patch_sha256_init(&ctx);
  codemagic_patch_sha256_update(&ctx, (const uint8_t *)json, strlen(json));
  uint8_t hash[32];
  codemagic_patch_sha256_final(&ctx, hash);
  codemagic_patch_sha256_hex(hash, out_hex);

  free(json);
  codemagic_patch_entry_list_free(&entries);
  return 0;
}
