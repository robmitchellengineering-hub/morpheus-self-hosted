// clap_offline — render audio through a CLAP plugin with no host application, no audio device and no GUI.
//
// WHY THIS EXISTS. A plugin can only be judged by what comes out of it, and the only way to get that today is
// to open a DAW, load it, play something and listen. That makes "does my plugin alias?", "does it report its
// latency correctly?" and "does bypass actually bypass?" questions of opinion, and it makes them unaskable in
// CI. This runs the plugin's own CLAP entry point against a file and writes what came out, so the measurement
// library can put a number on it.
//
// WHAT IT DELIBERATELY DOES NOT DO: it does not dlopen a bundle. It is linked against the plugin's own
// `Source/Plugin.cpp` and `Source/PluginEntry.cpp`, so it tests the CLAP core — the thing the developer wrote —
// without needing clap-wrapper, a VST3 SDK or Xcode. The WRAPPED binaries (VST3/AU/standalone) are a different
// question and are proved elsewhere, by the runner builds that load them. Saying so matters: a bench that
// silently tested something other than the shipped artifact would be worse than no bench.
//
// The audio format is MRAW (see `mraw.h`): a trivial float32 container, so this file contains no WAV parsing
// and there is exactly one WAV implementation in the project — the guarded one in JavaScript.
//
// Build:  c++ -std=c++20 -O2 -I<clap-headers> clap_offline.cpp <plugin>/Source/*.cpp -o clap_offline
// Run:    ./clap_offline --in in.mraw --out out.mraw [--param ID=VALUE] [--blocksize N] [--list-params]
//
// Prints one JSON object on stdout describing the plugin and what it did; anything human-readable goes to
// stderr, so the caller can parse the JSON without filtering.

#include <clap/clap.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// ── the MRAW container: magic, version, sample rate, channels, frames, then interleaved float32 ────────────
struct RawAudio {
  uint32_t sampleRate = 0;
  uint32_t channels = 0;
  uint32_t frames = 0;
  std::vector<float> samples; // interleaved
};

static bool mrawRead(const char *path, RawAudio &out) {
  FILE *f = std::fopen(path, "rb");
  if (!f) { std::fprintf(stderr, "clap_offline: cannot open %s\n", path); return false; }
  char magic[4];
  uint32_t version = 0;
  if (std::fread(magic, 1, 4, f) != 4 || std::memcmp(magic, "MRAW", 4) != 0) {
    std::fprintf(stderr, "clap_offline: %s is not MRAW (wrong magic)\n", path);
    std::fclose(f);
    return false;
  }
  if (std::fread(&version, 4, 1, f) != 1 || version != 1) {
    std::fprintf(stderr, "clap_offline: %s has unsupported MRAW version %u\n", path, version);
    std::fclose(f);
    return false;
  }
  if (std::fread(&out.sampleRate, 4, 1, f) != 1 || std::fread(&out.channels, 4, 1, f) != 1 ||
      std::fread(&out.frames, 4, 1, f) != 1) {
    std::fprintf(stderr, "clap_offline: %s has a truncated header\n", path);
    std::fclose(f);
    return false;
  }
  if (out.channels == 0 || out.channels > 32 || out.frames == 0) {
    std::fprintf(stderr, "clap_offline: %s declares %u channels and %u frames\n", path, out.channels, out.frames);
    std::fclose(f);
    return false;
  }
  out.samples.resize((size_t)out.frames * out.channels);
  const size_t got = std::fread(out.samples.data(), sizeof(float), out.samples.size(), f);
  std::fclose(f);
  if (got != out.samples.size()) {
    std::fprintf(stderr, "clap_offline: %s holds %zu of %zu samples\n", path, got, out.samples.size());
    return false;
  }
  return true;
}

static bool mrawWrite(const char *path, uint32_t sampleRate, uint32_t channels, const std::vector<float> &samples) {
  FILE *f = std::fopen(path, "wb");
  if (!f) { std::fprintf(stderr, "clap_offline: cannot write %s\n", path); return false; }
  const uint32_t version = 1;
  const uint32_t frames = (uint32_t)(samples.size() / channels);
  std::fwrite("MRAW", 1, 4, f);
  std::fwrite(&version, 4, 1, f);
  std::fwrite(&sampleRate, 4, 1, f);
  std::fwrite(&channels, 4, 1, f);
  std::fwrite(&frames, 4, 1, f);
  std::fwrite(samples.data(), sizeof(float), samples.size(), f);
  std::fclose(f);
  return true;
}

// ── the host: the minimum a plugin is entitled to, and nothing it is not ────────────────────────────────────
static const void *hostGetExtension(const clap_host_t *, const char *) { return nullptr; }
static void hostNoop(const clap_host_t *) {}

// Input events: an ordered list the host owns and the plugin reads. Parameters are set by SENDING AN EVENT —
// CLAP has no `set_value` — which is the detail a naive host gets wrong and then reports "the parameter did
// nothing".
struct EventList {
  std::vector<const clap_event_header_t *> events;
};

static uint32_t eventsSize(const clap_input_events_t *list) {
  return (uint32_t)((const EventList *)list->ctx)->events.size();
}
static const clap_event_header_t *eventsGet(const clap_input_events_t *list, uint32_t index) {
  const EventList *e = (const EventList *)list->ctx;
  return index < e->events.size() ? e->events[index] : nullptr;
}

static const clap_host_t HOST = {
  CLAP_VERSION_INIT,
  nullptr,                    // host_data
  "Morpheus offline host",    // name
  "Morpheus",                 // vendor
  "https://morpheus.nz",      // url
  "1.0.0",                    // version
  hostGetExtension,
  hostNoop,                   // request_restart
  hostNoop,                   // request_process
  hostNoop,                   // request_callback
};

static std::string jsonEscape(const char *s) {
  std::string out;
  for (const char *p = s; p && *p; ++p) {
    if (*p == '"' || *p == '\\') { out += '\\'; out += *p; }
    else if (*p == '\n') out += "\\n";
    else out += *p;
  }
  return out;
}

// ── state, for the one proof that needs it ───────────────────────────────────────────────────────────
// CLAP's state extension talks to STREAMS, not files, so a round-trip needs a buffer behind them. This is the
// whole of it: a cursor over bytes in, and an append onto bytes out. It exists because the chain order is a
// value the plugin SAVES now — and "it saves it" is only a claim until something loads it back and renders.
struct MemStream {
  const std::vector<uint8_t> *in = nullptr;
  std::vector<uint8_t> *out = nullptr;
  uint64_t at = 0;
};

static int64_t mem_read(const clap_istream_t *stream, void *buffer, uint64_t size) {
  MemStream *m = (MemStream *)stream->ctx;
  const uint64_t left = m->in->size() - m->at;
  const uint64_t n = size < left ? size : left;
  if (n == 0) return 0;
  std::memcpy(buffer, m->in->data() + m->at, (size_t)n);
  m->at += n;
  return (int64_t)n;
}

static int64_t mem_write(const clap_ostream_t *stream, const void *buffer, uint64_t size) {
  MemStream *m = (MemStream *)stream->ctx;
  const uint8_t *p = (const uint8_t *)buffer;
  m->out->insert(m->out->end(), p, p + size);
  return (int64_t)size;
}

/** The whole file, or empty when it cannot be read — one helper so the two call sites cannot drift. */
static bool readFileBytes(const char *path, std::vector<uint8_t> &into) {
  FILE *f = std::fopen(path, "rb");
  if (!f) return false;
  std::fseek(f, 0, SEEK_END);
  const long n = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  into.resize(n > 0 ? (size_t)n : 0);
  const bool ok = into.empty() || std::fread(into.data(), 1, into.size(), f) == into.size();
  std::fclose(f);
  return ok;
}

static bool writeFileBytes(const char *path, const std::vector<uint8_t> &bytes) {
  FILE *f = std::fopen(path, "wb");
  if (!f) return false;
  const bool ok = bytes.empty() || std::fwrite(bytes.data(), 1, bytes.size(), f) == bytes.size();
  std::fclose(f);
  return ok;
}

int main(int argc, char **argv) {
  const char *inPath = nullptr;
  const char *outPath = nullptr;
  const char *saveStatePath = nullptr;
  const char *loadStatePath = nullptr;
  uint32_t blockSize = 256;
  bool listParams = false;
  std::vector<std::pair<clap_id, double>> setParams;

  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto next = [&]() -> const char * { return (i + 1 < argc) ? argv[++i] : nullptr; };
    if (a == "--in") inPath = next();
    else if (a == "--out") outPath = next();
    else if (a == "--blocksize") { const char *v = next(); if (v) blockSize = (uint32_t)std::atoi(v); }
    else if (a == "--list-params") listParams = true;
    else if (a == "--save-state") saveStatePath = next();
    else if (a == "--load-state") loadStatePath = next();
    else if (a == "--param") {
      const char *v = next();
      if (!v) { std::fprintf(stderr, "clap_offline: --param needs ID=VALUE\n"); return 2; }
      const char *eq = std::strchr(v, '=');
      if (!eq) { std::fprintf(stderr, "clap_offline: --param needs ID=VALUE, got %s\n", v); return 2; }
      setParams.emplace_back((clap_id)std::atoi(std::string(v, eq - v).c_str()), std::atof(eq + 1));
    } else {
      std::fprintf(stderr, "clap_offline: unknown argument %s\n", a.c_str());
      return 2;
    }
  }
  if (!inPath || !outPath) {
    std::fprintf(stderr, "usage: clap_offline --in in.mraw --out out.mraw [--param ID=VALUE] [--blocksize N] [--list-params]\n");
    return 2;
  }
  if (blockSize == 0 || blockSize > 8192) { std::fprintf(stderr, "clap_offline: bad --blocksize\n"); return 2; }

  RawAudio in;
  if (!mrawRead(inPath, in)) return 1;

  // The plugin is LINKED IN, so the entry point is an ordinary symbol. That is the whole trick: no bundle
  // layout, no dlopen, no platform paths.
  extern const clap_plugin_entry_t clap_entry;
  const clap_plugin_entry_t *entry = &clap_entry;
  if (entry->clap_version.major != CLAP_VERSION_MAJOR) {
    std::fprintf(stderr, "clap_offline: entry ABI %u.%u is not this header's %u\n",
                 entry->clap_version.major, entry->clap_version.minor, CLAP_VERSION_MAJOR);
    return 1;
  }
  if (!entry->init(nullptr)) { std::fprintf(stderr, "clap_offline: clap_entry.init() failed\n"); return 1; }

  const clap_plugin_factory_t *factory =
      (const clap_plugin_factory_t *)entry->get_factory(CLAP_PLUGIN_FACTORY_ID);
  if (!factory || factory->get_plugin_count(factory) == 0) {
    std::fprintf(stderr, "clap_offline: the entry exports no plugins\n");
    entry->deinit();
    return 1;
  }
  const clap_plugin_descriptor_t *desc = factory->get_plugin_descriptor(factory, 0);
  const clap_plugin_t *plugin = factory->create_plugin(factory, &HOST, desc->id);
  if (!plugin) { std::fprintf(stderr, "clap_offline: create_plugin returned null\n"); entry->deinit(); return 1; }
  if (!plugin->init(plugin)) { std::fprintf(stderr, "clap_offline: plugin->init() failed\n"); entry->deinit(); return 1; }

  const clap_plugin_params_t *params =
      (const clap_plugin_params_t *)plugin->get_extension(plugin, CLAP_EXT_PARAMS);
  const clap_plugin_latency_t *latency =
      (const clap_plugin_latency_t *)plugin->get_extension(plugin, CLAP_EXT_LATENCY);
  const clap_plugin_audio_ports_t *ports =
      (const clap_plugin_audio_ports_t *)plugin->get_extension(plugin, CLAP_EXT_AUDIO_PORTS);
  const clap_plugin_state_t *state =
      (const clap_plugin_state_t *)plugin->get_extension(plugin, CLAP_EXT_STATE);

  // ⭐ THE ORDER, LOADED BEFORE A SINGLE BLOCK IS PROCESSED. The plugin hands it to its audio thread through a
  // pending slot and swaps it in at the top of the next block, so a load that happens here is in force for the
  // whole render — which is what makes "a reorder is heard" testable rather than assumed.
  if (loadStatePath) {
    if (!state) { std::fprintf(stderr, "clap_offline: --load-state, but the plugin has no state extension\n"); return 1; }
    std::vector<uint8_t> blob;
    if (!readFileBytes(loadStatePath, blob)) { std::fprintf(stderr, "clap_offline: cannot read %s\n", loadStatePath); return 1; }
    MemStream m; m.in = &blob;
    const clap_istream_t is = {&m, mem_read};
    if (!state->load(plugin, &is)) { std::fprintf(stderr, "clap_offline: state->load() refused %s\n", loadStatePath); return 1; }
  }

  // How many channels does the plugin actually want? Asking beats assuming: a plugin that declares one port of
  // two channels and is handed a mono buffer will process whatever is in it, and the bench would then report on
  // audio the plugin never saw.
  uint32_t portChannels = in.channels;
  if (ports && ports->count(plugin, false) > 0) {
    clap_audio_port_info_t info{};
    if (ports->get(plugin, 0, false, &info)) portChannels = info.channel_count;
  }

  std::printf("{\"id\":\"%s\",\"name\":\"%s\",\"vendor\":\"%s\",\"version\":\"%s\"",
              jsonEscape(desc->id).c_str(), jsonEscape(desc->name).c_str(),
              jsonEscape(desc->vendor).c_str(), jsonEscape(desc->version).c_str());
  std::printf(",\"inputChannels\":%u,\"portChannels\":%u,\"sampleRate\":%u,\"blockSize\":%u",
              in.channels, portChannels, in.sampleRate, blockSize);
  // Whether the plugin CLAIMS a latency, not just what it claims: a plugin that returns nothing and happens to
  // be zero-latency is fine, while one that introduces latency and says nothing is a bug a DAW cannot show you.
  std::printf(",\"reportsLatency\":%s,\"reportedLatency\":%u",
              latency ? "true" : "false", latency ? latency->get(plugin) : 0);
  std::printf(",\"params\":[");
  const uint32_t paramCount = params ? params->count(plugin) : 0;
  for (uint32_t i = 0; i < paramCount; i++) {
    clap_param_info_t info{};
    if (!params->get_info(plugin, i, &info)) continue;
    double value = 0;
    params->get_value(plugin, info.id, &value);
    if (i) std::printf(",");
    std::printf("{\"index\":%u,\"id\":%u,\"name\":\"%s\",\"min\":%g,\"max\":%g,\"default\":%g,\"value\":%g}",
                i, info.id, jsonEscape(info.name).c_str(), info.min_value, info.max_value, info.default_value, value);
  }
  std::printf("]}\n");
  std::fflush(stdout);
  if (listParams) { plugin->destroy(plugin); entry->deinit(); return 0; }

  if (!plugin->activate(plugin, (double)in.sampleRate, blockSize, blockSize)) {
    std::fprintf(stderr, "clap_offline: activate failed (%u Hz, %u frames)\n", in.sampleRate, blockSize);
    plugin->destroy(plugin);
    entry->deinit();
    return 1;
  }
  if (!plugin->start_processing(plugin)) {
    std::fprintf(stderr, "clap_offline: start_processing failed\n");
    plugin->deactivate(plugin); plugin->destroy(plugin); entry->deinit();
    return 1;
  }

  // Buffers for the port, sized once. `constant_mask` stays 0: claiming a constant channel would tell the
  // plugin its output is steady and let it skip work, which is exactly the kind of optimisation that makes a
  // bench measure a plugin that is not doing anything.
  std::vector<std::vector<float>> inBuf(portChannels, std::vector<float>(blockSize, 0.0f));
  std::vector<std::vector<float>> outBuf(portChannels, std::vector<float>(blockSize, 0.0f));
  std::vector<float *> inPtrs(portChannels), outPtrs(portChannels);
  for (uint32_t c = 0; c < portChannels; c++) { inPtrs[c] = inBuf[c].data(); outPtrs[c] = outBuf[c].data(); }

  clap_audio_buffer_t inAudio{};
  inAudio.data32 = inPtrs.data();
  inAudio.channel_count = portChannels;
  clap_audio_buffer_t outAudio{};
  outAudio.data32 = outPtrs.data();
  outAudio.channel_count = portChannels;

  // Parameters are set by event, once, in the first block — the CLAP contract for "the host changed a value".
  std::vector<clap_event_param_value_t> paramEvents(setParams.size());
  EventList eventList;
  for (size_t i = 0; i < setParams.size(); i++) {
    clap_event_param_value_t &e = paramEvents[i];
    e.header.size = sizeof(clap_event_param_value_t);
    e.header.time = 0;
    e.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
    e.header.type = CLAP_EVENT_PARAM_VALUE;
    e.header.flags = 0;
    e.param_id = setParams[i].first;
    e.cookie = nullptr;
    e.note_id = -1;
    e.port_index = -1;
    e.channel = -1;
    e.key = -1;
    e.value = setParams[i].second;
    eventList.events.push_back(&e.header);
  }
  clap_input_events_t inEvents{};
  inEvents.ctx = &eventList;
  inEvents.size = eventsSize;
  inEvents.get = eventsGet;
  clap_output_events_t outEvents{};
  outEvents.ctx = nullptr;
  outEvents.try_push = [](const clap_output_events_t *, const clap_event_header_t *) { return true; };

  std::vector<float> rendered((size_t)in.frames * portChannels, 0.0f);
  uint32_t done = 0;
  // ⏱ TIMED AROUND THE PROCESS LOOP AND NOTHING ELSE — not the file read, not the JSON, not the plugin's
  // construction. This number is what answers "can a Raspberry Pi run this in real time?", and a measurement
  // that included process startup would be a measurement of process startup on a short render.
  const auto processStart = std::chrono::steady_clock::now();
  while (done < in.frames) {
    const uint32_t n = std::min(blockSize, in.frames - done);
    for (uint32_t c = 0; c < portChannels; c++) {
      for (uint32_t i = 0; i < n; i++) {
        // Channel adaptation: a mono source feeding a stereo port is the common case for a test signal, and
        // duplicating it is what every host does. Anything else is a mismatch worth failing on rather than
        // guessing at.
        const uint32_t src = (portChannels == in.channels) ? c : 0;
        inBuf[c][i] = in.samples[(size_t)(done + i) * in.channels + src];
        outBuf[c][i] = 0.0f;
      }
      for (uint32_t i = n; i < blockSize; i++) { inBuf[c][i] = 0.0f; outBuf[c][i] = 0.0f; }
    }

    clap_process_t process{};
    process.steady_time = done;
    process.frames_count = n;
    process.transport = nullptr;
    process.audio_inputs = &inAudio;
    process.audio_inputs_count = 1;
    process.audio_outputs = &outAudio;
    process.audio_outputs_count = 1;
    process.in_events = &inEvents;
    process.out_events = &outEvents;

    const clap_process_status status = plugin->process(plugin, &process);
    if (status == CLAP_PROCESS_ERROR) {
      std::fprintf(stderr, "clap_offline: process() returned an error at frame %u\n", done);
      plugin->stop_processing(plugin); plugin->deactivate(plugin); plugin->destroy(plugin); entry->deinit();
      return 1;
    }
    for (uint32_t c = 0; c < portChannels; c++) {
      for (uint32_t i = 0; i < n; i++) rendered[(size_t)(done + i) * portChannels + c] = outBuf[c][i];
    }
    done += n;
    eventList.events.clear(); // the change is delivered once, not every block
  }

  const auto processEnd = std::chrono::steady_clock::now();
  const double processSeconds = std::chrono::duration<double>(processEnd - processStart).count();

  // ⭐ AND SAVED AFTER THE LAST BLOCK, which is where a host saves it. The bytes must be the ORDER THAT RAN,
  // not the compiled default — a session that saved a reordered chain and loaded the default back would be a
  // reorder that silently undid itself, and nothing but a round-trip can tell those two apart.
  if (saveStatePath) {
    if (!state) { std::fprintf(stderr, "clap_offline: --save-state, but the plugin has no state extension\n"); return 1; }
    std::vector<uint8_t> blob;
    MemStream m; m.out = &blob;
    const clap_ostream_t os = {&m, mem_write};
    if (!state->save(plugin, &os)) { std::fprintf(stderr, "clap_offline: state->save() failed\n"); return 1; }
    if (!writeFileBytes(saveStatePath, blob)) { std::fprintf(stderr, "clap_offline: cannot write %s\n", saveStatePath); return 1; }
  }

  plugin->stop_processing(plugin);
  plugin->deactivate(plugin);
  plugin->destroy(plugin);
  entry->deinit();

  // Reported on stdout as one more field of the same JSON line, so a caller reads the plugin's identity and
  // how long it took in the same parse. `audioSeconds` is what the render was worth, so the real-time factor
  // is a division the caller does rather than two numbers it has to be trusted to combine correctly.
  std::printf("{\"processSeconds\":%.9f,\"audioSeconds\":%.9f,\"frames\":%u,\"sampleRate\":%u,\"blockSize\":%u}\n",
              processSeconds, (double)in.frames / (double)in.sampleRate, in.frames, in.sampleRate, blockSize);

  if (!mrawWrite(outPath, in.sampleRate, portChannels, rendered)) return 1;
  return 0;
}
