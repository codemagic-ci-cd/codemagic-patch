/*
 * SHA-256 (FIPS PUB 180-4). Vendored from Brad Conte's public-domain
 * crypto-algorithms reference (https://github.com/B-Con/crypto-algorithms),
 * renamed with a `codemagic_patch_` prefix. See sha256.c for full provenance notes.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint8_t data[64];
  uint32_t datalen;
  uint64_t bitlen;
  uint32_t state[8];
} codemagic_patch_sha256_ctx;

void codemagic_patch_sha256_init(codemagic_patch_sha256_ctx *ctx);
void codemagic_patch_sha256_update(codemagic_patch_sha256_ctx *ctx, const uint8_t *data, size_t len);
void codemagic_patch_sha256_final(codemagic_patch_sha256_ctx *ctx, uint8_t hash[32]);
void codemagic_patch_sha256_hex(const uint8_t hash[32], char out_hex[65]);
int codemagic_patch_sha256_file_hex(const char *path, char out_hex[65]);

#ifdef __cplusplus
}
#endif
