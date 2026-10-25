#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

int main(void) {
  @autoreleasepool {
    // Window geometry needs neither screen capture nor accessibility permission.
    CGRect screen = CGDisplayBounds(CGMainDisplayID());
    NSMutableSet *owners = [NSMutableSet set];
    for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.controlcenter"])
      [owners addObject:@(app.processIdentifier)];
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray *clocks = [NSMutableArray array];
    for (NSDictionary *window in windows) {
      if (![owners containsObject:window[(id)kCGWindowOwnerPID]] || [window[(id)kCGWindowLayer] integerValue] != NSStatusWindowLevel) continue;
      CGRect rect;
      if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &rect)) continue;
      if (rect.size.width <= 10 || rect.size.width >= 500 || rect.size.height <= 0 || rect.size.height > 64 ||
          fabs(CGRectGetMaxX(rect) - CGRectGetMaxX(screen)) > 2 || rect.origin.y < screen.origin.y || CGRectGetMaxY(rect) > screen.origin.y + 64) continue;
      // shortcut: modern macOS pins Clock at the far right; revisit if Apple makes it movable.
      [clocks addObject:@{@"x": @(rect.origin.x), @"y": @(rect.origin.y), @"w": @(rect.size.width), @"h": @(rect.size.height)}];
    }
    if (clocks.count == 1) {
      NSData *data = [NSJSONSerialization dataWithJSONObject:clocks.firstObject options:0 error:nil];
      puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    } else puts("null");
  }
  return 0;
}
