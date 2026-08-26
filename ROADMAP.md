# Morpheus — Feature Roadmap

## Researched / Planned Features

### 1. Native Live-Preview Hosting (Cloud Emulators + Streaming)

**Status:** Researched — tabled for future build

**Goal:** Enable live, real-time preview of native builds (Android APK, iOS app, Windows .exe, macOS .app, Linux binary) directly in the Morpheus mobile app — not a web mockup, but the actual compiled binary running on cloud infrastructure and streamed to the operator's device.

**Why it matters:** The current rapid-prototype system generates a web-based visual mockup (great for UI/UX feedback), but it cannot show real native rendering, actual platform APIs, hardware sensor behavior, or true performance. A hosted native preview would close that gap.

**Researched approaches:**

1. **Cloud Android Emulators (Android):**
   - Genyroid / Genymotion SaaS — REST API to boot emulators, stream screen via WebRTC
   - Android Studio Emulator in headless mode on a cloud GPU VM (AWS Device Farm / Firebase Test Lab)
   - Appetize.io — runs APKs in-browser via streaming (limited but instant)
   - BrowserStack App Live — real device farm with WebRTC streaming

2. **iOS Simulators (iOS):**
   - Corellium — cloud ARM VMs running real iOS, WebRTC screen streaming, full simulator API
   - MacStadium / AWS EC2 Mac — hosted macOS with Xcode simulators, stream via VNC/WebRTC
   - Appetize.io also supports iOS apps

3. **Desktop Builds (Windows/macOS/Linux):**
   - Cloud Windows VMs (Azure, AWS WorkSpaces) with remote desktop streaming
   - Parsec / Moonlight for low-latency GPU-accelerated desktop streaming
   - Wine + Xvfb on Linux for cross-platform Windows .exe preview

4. **Embedded / Arduino:**
   - Wokwi / SimAVR — browser-based AVR simulator with serial monitor
   - QEMU for ARM-based firmware emulation

**Proposed architecture:**
- After GitHub Actions compiles a native binary, the artifact is pushed to a preview-hosting service.
- The service boots the appropriate emulator/simulator/VM, installs the binary, and opens a WebRTC stream.
- The Morpheus mobile app embeds the stream in the PreviewPanel with touch input forwarded to the remote device.
- A "Stop Preview" button tears down the cloud instance to control costs.

**Cost considerations:**
- Cloud emulators / device farms bill per minute — need auto-shutdown after inactivity.
- Corellium is enterprise-priced; Appetize.io has a freemium tier.
- Self-hosted emulators on spot instances could reduce cost but adds ops burden.

**Recommended next step:** Start with Appetize.io integration (Android + iOS, instant, freemium) as a proof-of-concept, then evaluate Corellium for full-device fidelity.

---

_Last updated: 2026-08-21_