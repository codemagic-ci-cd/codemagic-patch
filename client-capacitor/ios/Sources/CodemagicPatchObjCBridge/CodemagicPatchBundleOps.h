// Ported verbatim from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchBundleOps.h (Apache-2.0). No changes — this file has no React Native
// dependency at all (plain Foundation + the vendored C libraries), so nothing needed
// adapting here.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CodemagicPatchBundleOps : NSObject

+ (BOOL)extractBundle:(NSString *)archivePath
             toOutDir:(NSString *)outDir;

+ (BOOL)applyDirectoryPatchWithBaseDir:(NSString *)baseDir
                             patchPath:(NSString *)patchPath
                                outDir:(NSString *)outDir;

+ (BOOL)validateContentsTree:(NSString *)rootDir;

@end

NS_ASSUME_NONNULL_END
