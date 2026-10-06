// Ported verbatim from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchHashing.mm (Apache-2.0). No changes — this file has no React Native
// dependency at all (plain Foundation + the vendored C libraries), so nothing needed
// adapting here.
#import "CodemagicPatchHashing.h"

#include "package_hash_v1.h"

@implementation CodemagicPatchHashing

+ (nullable NSString *)packageHashAtPath:(NSString *)contentsPath
{
  if (contentsPath.length == 0) {
    return nil;
  }

  char outHash[65];
  int result = codemagic_patch_compute_package_hash(contentsPath.fileSystemRepresentation, outHash);
  if (result != 0) {
    return nil;
  }

  return [NSString stringWithUTF8String:outHash];
}

@end
