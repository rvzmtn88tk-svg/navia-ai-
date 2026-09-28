#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <React/RCTBridgeModule.h>
#import <MapLibre/MapLibre.h>

// ——— "No internet" test mode for the map (iOS) ———
// MapLibre's setConnected() exists only on Android. Here every map request
// fails with "not connected to the internet" while the test mode is on, so
// MapLibre falls back to its offline packs exactly as in airplane mode.
@interface NaviaOfflineURLProtocol : NSURLProtocol
@end
@implementation NaviaOfflineURLProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return YES; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNotConnectedToInternet userInfo:nil]];
}
- (void)stopLoading {}
@end

static BOOL gNaviaMapOffline = NO;

/** Hands MapLibre a network session: normal, or one where every request
 * fails as in airplane mode. Installed at launch, before the first map. */
@interface NaviaMapGate : NSObject <MLNNetworkConfigurationDelegate>
@end
@implementation NaviaMapGate {
  NSURLSession *_offlineSession;
  NSURLSession *_onlineSession;
}
+ (instancetype)shared {
  static NaviaMapGate *gate;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ gate = [NaviaMapGate new]; });
  return gate;
}
- (NSURLSession *)sessionForNetworkConfiguration:(MLNNetworkConfiguration *)configuration {
  if (gNaviaMapOffline) {
    if (!_offlineSession) {
      NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
      config.protocolClasses = @[[NaviaOfflineURLProtocol class]];
      _offlineSession = [NSURLSession sessionWithConfiguration:config];
    }
    return _offlineSession;
  }
  if (!_onlineSession) _onlineSession = [NSURLSession sessionWithConfiguration:configuration.sessionConfiguration];
  return _onlineSession;
}
@end

@interface NaviaMapNetwork : NSObject <RCTBridgeModule>
@end
@implementation NaviaMapNetwork
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return NO; }
RCT_EXPORT_METHOD(setOffline:(BOOL)offline) {
  gNaviaMapOffline = offline;
}
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(isOffline) {
  return @(gNaviaMapOffline);
}
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"main";
  // Test aid: start with the map offline (`defaults write ua.navia.app NaviaMapOfflineTest -bool YES`).
  gNaviaMapOffline = [[NSUserDefaults standardUserDefaults] boolForKey:@"NaviaMapOfflineTest"];
  [MLNNetworkConfiguration sharedManager].delegate = [NaviaMapGate shared];

  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

// Linking API
- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options {
  return [super application:application openURL:url options:options] || [RCTLinkingManager application:application openURL:url options:options];
}

// Universal Links
- (BOOL)application:(UIApplication *)application continueUserActivity:(nonnull NSUserActivity *)userActivity restorationHandler:(nonnull void (^)(NSArray<id<UIUserActivityRestoring>> * _Nullable))restorationHandler {
  BOOL result = [RCTLinkingManager application:application continueUserActivity:userActivity restorationHandler:restorationHandler];
  return [super application:application continueUserActivity:userActivity restorationHandler:restorationHandler] || result;
}

// Explicitly define remote notification delegates to ensure compatibility with some third-party libraries
- (void)application:(UIApplication *)application didRegisterForRemoteNotificationsWithDeviceToken:(NSData *)deviceToken
{
  return [super application:application didRegisterForRemoteNotificationsWithDeviceToken:deviceToken];
}

// Explicitly define remote notification delegates to ensure compatibility with some third-party libraries
- (void)application:(UIApplication *)application didFailToRegisterForRemoteNotificationsWithError:(NSError *)error
{
  return [super application:application didFailToRegisterForRemoteNotificationsWithError:error];
}

// Explicitly define remote notification delegates to ensure compatibility with some third-party libraries
- (void)application:(UIApplication *)application didReceiveRemoteNotification:(NSDictionary *)userInfo fetchCompletionHandler:(void (^)(UIBackgroundFetchResult))completionHandler
{
  return [super application:application didReceiveRemoteNotification:userInfo fetchCompletionHandler:completionHandler];
}

@end
