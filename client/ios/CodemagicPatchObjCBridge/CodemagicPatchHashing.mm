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
