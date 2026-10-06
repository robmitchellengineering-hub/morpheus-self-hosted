// Load a generated plugin's GUI and photograph it, without a DAW and without a screen.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────────────
// `clap-offline` answers "does this plugin make the right sound"; nothing answered "does this plugin have a
// panel, and does it come up". A plugin GUI is the one part of this project that CANNOT be checked by reading
// the source or by a guard: `clap_plugin_gui` is a dozen function pointers whose only real test is a host
// calling them in order. This is that host, reduced to the four calls that matter — `is_api_supported`,
// `get_size`, `set_parent`, `show` — plus the one that produces evidence.
//
// ⚠️ IT RENDERS THE VIEW OFFSCREEN, IT DOES NOT PHOTOGRAPH THE SCREEN. `cacheDisplayInRect:toBitmapImageRep:`
// asks AppKit to draw the view into a bitmap, so this needs no window server, no screen-recording
// permission and no visible window — the same reason `clap-offline` renders audio instead of opening a
// device. It is a macOS tool for the same reason: it is Cocoa that is being tested.
//
// Build it WITH the plugin's own sources, exactly as the audio bench is built:
//
//   c++ -std=c++20 -O2 -w -I<clap>/include -I<plugin>/Source \
//       tools/clap-gui-host/clap_gui_host.mm <plugin>/Source/Plugin.cpp <plugin>/Source/PluginEntry.cpp \
//       <plugin>/Source/PluginGui.mm -framework Cocoa -framework QuartzCore -o /tmp/clap_gui_host
//
// Run:  /tmp/clap_gui_host --out board.png [--id nz.morpheus.plugin] [--wait 0.5]
#import <Cocoa/Cocoa.h>
#include <clap/clap.h>
#include <stdio.h>
#include <string.h>

// ── the smallest host CLAP allows ───────────────────────────────────────────────────────────────────────
static const void *host_get_extension(const clap_host_t *host, const char *id) { (void)host; (void)id; return nullptr; }
static void host_request_restart(const clap_host_t *host) { (void)host; }
static void host_request_process(const clap_host_t *host) { (void)host; }
static void host_request_callback(const clap_host_t *host) { (void)host; }

static const clap_host_t s_host = {
  .clap_version = CLAP_VERSION_INIT,
  .host_data = nullptr,
  .name = "Morpheus GUI host",
  .vendor = "Morpheus",
  .url = "https://morpheus.nz",
  .version = "1.0.0",
  .get_extension = host_get_extension,
  .request_restart = host_request_restart,
  .request_process = host_request_process,
  .request_callback = host_request_callback,
};

int main(int argc, char **argv) {
  @autoreleasepool {
    const char *out = nullptr;
    const char *wanted = nullptr;
    double wait = 0.6;
    for (int i = 1; i < argc; ++i) {
      if (!strcmp(argv[i], "--out") && i + 1 < argc) out = argv[++i];
      else if (!strcmp(argv[i], "--id") && i + 1 < argc) wanted = argv[++i];
      else if (!strcmp(argv[i], "--wait") && i + 1 < argc) wait = atof(argv[++i]);
    }
    if (!out) {
      fprintf(stderr, "usage: clap_gui_host --out <shot.png> [--id <plugin-id>] [--wait <seconds>]\n");
      return 2;
    }

    // The entry point is linked in, so there is no library to open. `init` takes the path the host would
    // dlopen from; this host needs it only so the plugin can say where it lives.
    extern const clap_plugin_entry_t clap_entry;
    if (!clap_entry.init(argv[0])) {
      fprintf(stderr, "the plugin entry point refused to initialise\n");
      return 1;
    }
    const clap_plugin_factory_t *factory =
        (const clap_plugin_factory_t *)clap_entry.get_factory(CLAP_PLUGIN_FACTORY_ID);
    if (!factory) {
      fprintf(stderr, "the plugin exposes no factory\n");
      return 1;
    }
    const uint32_t n = factory->get_plugin_count(factory);
    printf("the plugin exposes %u plugin(s)\n", n);
    const clap_plugin_descriptor_t *desc = nullptr;
    for (uint32_t i = 0; i < n; ++i) {
      const clap_plugin_descriptor_t *d = factory->get_plugin_descriptor(factory, i);
      printf("  - %s (%s)\n", d->id, d->name);
      if (!wanted || !strcmp(d->id, wanted)) { desc = d; break; }
    }
    if (!desc) {
      fprintf(stderr, "no plugin matched%s%s\n", wanted ? " id " : "", wanted ? wanted : "");
      return 1;
    }

    const clap_plugin_t *plugin = factory->create_plugin(factory, &s_host, desc->id);
    if (!plugin || !plugin->init(plugin)) {
      fprintf(stderr, "create_plugin/init failed\n");
      return 1;
    }
    plugin->activate(plugin, 48000.0, 1, 512);

    // ── the four calls that decide whether this plugin has a window at all ────────────────────────────────
    const clap_plugin_gui_t *gui = (const clap_plugin_gui_t *)plugin->get_extension(plugin, CLAP_EXT_GUI);
    if (!gui) {
      fprintf(stderr, "FAIL: the plugin exposes no CLAP_EXT_GUI, so a standalone window has nothing to put in it\n");
      return 1;
    }
    const bool embedded = gui->is_api_supported(plugin, CLAP_WINDOW_API_COCOA, false);
    printf("CLAP_WINDOW_API_COCOA embedded: %s\n", embedded ? "supported" : "NOT SUPPORTED");
    if (!embedded) {
      fprintf(stderr, "FAIL: the panel does not support the Cocoa window API\n");
      return 1;
    }
    if (!gui->create(plugin, CLAP_WINDOW_API_COCOA, false)) {
      fprintf(stderr, "FAIL: create() refused the Cocoa API\n");
      return 1;
    }
    uint32_t w = 0, h = 0;
    if (!gui->get_size(plugin, &w, &h) || w == 0 || h == 0) {
      fprintf(stderr, "FAIL: get_size() reported %ux%u\n", w, h);
      return 1;
    }
    printf("the panel asks for %ux%u points, can_resize=%d\n", w, h, (int)gui->can_resize(plugin));

    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, w, h)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setTitle:[NSString stringWithUTF8String:desc->name]];
    NSView *content = [window contentView];
    content.wantsLayer = YES;
    const clap_window_t parent = { .api = CLAP_WINDOW_API_COCOA, .cocoa = (__bridge void *)content };
    if (!gui->set_parent(plugin, &parent)) {
      fprintf(stderr, "FAIL: set_parent() refused the host's view\n");
      return 1;
    }
    if (!gui->show(plugin)) {
      fprintf(stderr, "FAIL: show() refused\n");
      return 1;
    }
    // The panel draws on a timer and needs a run-loop turn (or several) before the first frame is real —
    // and the same is true in a DAW, which is why the timer runs in common modes.
    [window makeKeyAndOrderFront:nil];
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:wait];
    while ([until timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }

    // ── the evidence ──────────────────────────────────────────────────────────────────────────────────────
    // ⚠️ THIS CANNOT FAIL QUIETLY. A host that got this far has a plugin claiming a working panel, so a
    // bitmap that will not render — a view with no bounds, a window with no content — is a defect and says
    // so, rather than writing a one-pixel PNG and exiting happy.
    NSView *panel = [content subviews].firstObject;
    if (!panel) {
      fprintf(stderr, "FAIL: the plugin created no view inside the one it was given\n");
      return 1;
    }
    printf("the panel put a %s of %.0fx%.0f into the host's view\n",
           [NSStringFromClass([panel class]) UTF8String], panel.frame.size.width, panel.frame.size.height);
    NSBitmapImageRep *rep = [panel bitmapImageRepForCachingDisplayInRect:panel.bounds];
    [panel cacheDisplayInRect:panel.bounds toBitmapImageRep:rep];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png || png.length < 2000) {
      fprintf(stderr, "FAIL: the rendered panel came out as %lu bytes — that is not a drawn view\n", (unsigned long)png.length);
      return 1;
    }
    [png writeToFile:[NSString stringWithUTF8String:out] atomically:YES];
    printf("wrote %s (%lu bytes, %ldx%ld pixels)\n", out, (unsigned long)png.length,
           (long)[rep pixelsWide], (long)[rep pixelsHigh]);

    gui->hide(plugin);
    gui->destroy(plugin);
    plugin->deactivate(plugin);
    plugin->destroy(plugin);
    clap_entry.deinit();
  }
  return 0;
}
