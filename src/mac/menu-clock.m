#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

static NSDictionary *clockTimeLayout(CGRect display, CGFloat height) {
  if (height < 10 || height > 64) return nil; // Do not point at an auto-hidden menu bar.
  NSDictionary *prefs = CFBridgingRelease(CFPreferencesCopyMultiple(NULL, CFSTR("com.apple.menuextra.clock"), kCFPreferencesCurrentUser, kCFPreferencesAnyHost));
  NSDateFormatter *format = [NSDateFormatter new];
  format.timeStyle = [prefs[@"ShowSeconds"] boolValue] ? NSDateFormatterMediumStyle : NSDateFormatterShortStyle;
  BOOL use24 = prefs[@"Show24Hour"] ? [prefs[@"Show24Hour"] boolValue] :
    [format.dateFormat rangeOfString:@"H"].location != NSNotFound || [format.dateFormat rangeOfString:@"k"].location != NSNotFound;
  if (prefs[@"Show24Hour"] || prefs[@"ShowAMPM"]) {
    NSString *hour = use24 ? @"HH" : @"h";
    format.dateFormat = [NSString stringWithFormat:@"%@:mm%@%@", hour,
      [prefs[@"ShowSeconds"] boolValue] ? @":ss" : @"",
      !use24 && [prefs[@"ShowAMPM"] boolValue] ? @" a" : @""];
  }
  NSString *time = [format stringFromDate:NSDate.date];
  CGFloat width = [prefs[@"IsAnalog"] boolValue] ? height : ceil([time sizeWithAttributes:@{NSFontAttributeName: [NSFont menuBarFontOfSize:0]}].width);
  // shortcut: Clock's time is right-aligned on stock macOS; include native spacing when exact window bounds are private.
  width = MIN(display.size.width, width + 24);
  return @{@"x": @(CGRectGetMaxX(display) - width), @"y": @(display.origin.y), @"w": @(width), @"h": @(height)};
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    // Window geometry needs neither screen capture nor accessibility permission.
    if (argc != 6) { puts("null"); return 0; }
    CGRect screen = CGRectMake(strtod(argv[1], NULL), strtod(argv[2], NULL), strtod(argv[3], NULL), strtod(argv[4], NULL));
    CGFloat menuHeight = strtod(argv[5], NULL);
    if (!isfinite(screen.origin.x) || !isfinite(screen.origin.y) || !isfinite(screen.size.width) || !isfinite(screen.size.height) ||
        screen.size.width <= 0 || screen.size.height <= 0 || !isfinite(menuHeight)) { puts("null"); return 0; }
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
    NSDictionary *clock = clocks.count == 1 ? clocks.firstObject : clocks.count == 0 ? clockTimeLayout(screen, menuHeight) : nil;
    if (clock) {
      NSData *data = [NSJSONSerialization dataWithJSONObject:clock options:0 error:nil];
      puts([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    } else puts("null");
  }
  return 0;
}
