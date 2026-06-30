#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CodemagicPatchHashing : NSObject

+ (nullable NSString *)packageHashAtPath:(NSString *)contentsPath;

@end

NS_ASSUME_NONNULL_END
