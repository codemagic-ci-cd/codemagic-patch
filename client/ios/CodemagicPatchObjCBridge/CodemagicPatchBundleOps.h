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
