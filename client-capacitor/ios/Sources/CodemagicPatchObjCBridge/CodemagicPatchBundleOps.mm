// Ported verbatim from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchBundleOps.mm (Apache-2.0). No changes — this file has no React Native
// dependency at all (plain Foundation + the vendored C libraries), so nothing needed
// adapting here.
#import "CodemagicPatchBundleOps.h"

#include "codemagic_patch_artifacts.h"

@implementation CodemagicPatchBundleOps

+ (BOOL)extractBundle:(NSString *)archivePath
             toOutDir:(NSString *)outDir
{
  return codemagic_patch_extract_tar_zstd(archivePath.fileSystemRepresentation,
                                   outDir.fileSystemRepresentation) == 0;
}

+ (BOOL)applyDirectoryPatchWithBaseDir:(NSString *)baseDir
                             patchPath:(NSString *)patchPath
                                outDir:(NSString *)outDir
{
  return codemagic_patch_apply_hdiffpatch(baseDir.fileSystemRepresentation,
                                   patchPath.fileSystemRepresentation,
                                   outDir.fileSystemRepresentation) == 0;
}

+ (BOOL)validateContentsTree:(NSString *)rootDir
{
  return codemagic_patch_validate_contents_tree(rootDir.fileSystemRepresentation) == 0;
}

@end
