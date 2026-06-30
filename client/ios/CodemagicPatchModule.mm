#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_REMAP_MODULE(NativeCodemagicPatch, CodemagicPatchModule, NSObject)

RCT_EXTERN_METHOD(getBootState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(fetchManifest:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getDeviceId:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getPackageMetadata:(NSString *)packageHash resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(enqueueMetricEvent:(NSString *)eventJson resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadUpdate:(NSDictionary *)request resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(installUpdate:(NSDictionary *)request resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(confirmPendingUpdate:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stageEmbeddedRevert:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearUpdatesForTests:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(reloadBundle:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(verifyJwtSignature:(NSDictionary *)request resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end

#ifdef RCT_NEW_ARCH_ENABLED

#import <memory>

#if __has_include(<CodemagicPatchSpec/CodemagicPatchSpec.h>)
#import <CodemagicPatchSpec/CodemagicPatchSpec.h>
#else
#import "CodemagicPatchSpec.h"
#endif

@interface CodemagicPatchModule (CodemagicPatchLegacySelectors)

- (void)getBootState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)fetchManifest:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)getDeviceId:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)getPackageMetadata:(NSString *)packageHash
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject;
- (void)enqueueMetricEvent:(NSString *)eventJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject;
- (void)downloadUpdate:(NSDictionary *)request
              resolver:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject;
- (void)installUpdate:(NSDictionary *)request
             resolver:(RCTPromiseResolveBlock)resolve
             rejecter:(RCTPromiseRejectBlock)reject;
- (void)confirmPendingUpdate:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)stageEmbeddedRevert:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)clearUpdatesForTests:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)reloadBundle:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)verifyJwtSignature:(NSDictionary *)request
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject;

@end

@interface CodemagicPatchModule (CodemagicPatchTurboModule) <NativeCodemagicPatchSpec>
@end

static NSMutableDictionary *CodemagicPatchPendingMetadataDictionary(
    JS::NativeCodemagicPatch::NativePendingUpdateMetadataInput metadata)
{
  NSMutableDictionary *dictionary = [NSMutableDictionary new];
  NSString *label = metadata.label();
  if (label != nil) {
    dictionary[@"label"] = label;
  }
  dictionary[@"isMandatory"] = @(metadata.isMandatory());
  NSString *releaseNotes = metadata.releaseNotes();
  if (releaseNotes != nil) {
    dictionary[@"releaseNotes"] = releaseNotes;
  }
  std::optional<bool> signatureVerified = metadata.signatureVerified();
  if (signatureVerified.has_value()) {
    dictionary[@"signatureVerified"] = @(*signatureVerified);
  }
  return dictionary;
}

@implementation CodemagicPatchModule (CodemagicPatchTurboModule)

- (void)getBootState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self getBootState:resolve rejecter:reject];
}

- (void)fetchManifest:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self fetchManifest:resolve rejecter:reject];
}

- (void)getDeviceId:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self getDeviceId:resolve rejecter:reject];
}

- (void)getPackageMetadata:(NSString *)packageHash
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [self getPackageMetadata:packageHash resolver:resolve rejecter:reject];
}

- (void)enqueueMetricEvent:(NSString *)eventJson
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [self enqueueMetricEvent:eventJson resolver:resolve rejecter:reject];
}

- (void)downloadUpdate:(JS::NativeCodemagicPatch::NativeDownloadUpdateRequest &)request
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  NSMutableDictionary *dictionary = [NSMutableDictionary dictionaryWithDictionary:@{
    @"packageHash" : request.packageHash(),
    @"artifactType" : request.artifactType(),
    @"url" : request.url(),
    @"metadata" : CodemagicPatchPendingMetadataDictionary(request.metadata())
  }];
  std::optional<double> expectedBytes = request.expectedBytes();
  if (expectedBytes.has_value()) {
    dictionary[@"expectedBytes"] = @(*expectedBytes);
  }
  [self downloadUpdate:dictionary resolver:resolve rejecter:reject];
}

- (void)installUpdate:(JS::NativeCodemagicPatch::NativeInstallUpdateRequest &)request
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  NSMutableDictionary *dictionary = [NSMutableDictionary dictionaryWithDictionary:@{
    @"packageHash" : request.packageHash()
  }];
  [self installUpdate:dictionary resolver:resolve rejecter:reject];
}

- (void)confirmPendingUpdate:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self confirmPendingUpdate:resolve rejecter:reject];
}

- (void)stageEmbeddedRevert:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self stageEmbeddedRevert:resolve rejecter:reject];
}

- (void)clearUpdatesForTests:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self clearUpdatesForTests:resolve rejecter:reject];
}

- (void)reloadBundle:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self reloadBundle:resolve rejecter:reject];
}

- (void)verifyJwtSignature:(JS::NativeCodemagicPatch::NativeJwtVerificationRequest &)request
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [self verifyJwtSignature:@{
    @"jwt" : request.jwt(),
    @"contentHash" : request.contentHash()
  } resolver:resolve rejecter:reject];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeCodemagicPatchSpecJSI>(params);
}

@end

#endif
