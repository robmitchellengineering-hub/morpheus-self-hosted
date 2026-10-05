// What the capture endpoint actually does, with no HTTP in it.
//
// WHY THIS IS SEPARATE FROM THE ROUTE. Everything that can be wrong here — the magic number, the decode, which
// file is which, the verdict — is decidable without a server, and the guards job runs with no `npm install`,
// so it cannot import express. Putting the work here means the endpoint's real behaviour is tested on every
// pull request rather than only asserted as text, and capture.routes.js is left with nothing but multipart
// and a status code.
//
// THE UPLOADED BYTES ARE NOT STORED. A capture is ~27 MB a side and belongs on the user's machine; this reads
// a verdict out of them and drops them. Nothing in this file writes anywhere.
import { decodeWavMono } from './wav.js';
import { checkCapture, identifyBytes, validateCaptureWav } from './namCapture.js';

const bad = (error) => ({ status: 400, body: { error } });

/**
 * Validate, decode and judge a pair of uploads.
 *
 * @param input     `{ filename, buffer }` — the re-amp signal the user played through the amp
 * @param recorded  `{ filename, buffer }` — the recording of the amp's output
 * @returns `{ status, body }` — the status the route should send and the JSON to send with it
 */
export function runCaptureCheck({ input, recorded }) {
  if (!input || !recorded) {
    return bad('Both files are needed: the re-amp signal you played, and the recording of your amp.');
  }
  // MAGIC NUMBER BEFORE THE DECODE. Refusing a non-WAV after two full decodes have been paid for is a bad
  // trade, and the browser's `accept` attribute is a courtesy rather than a check.
  for (const [what, f] of [['The re-amp signal', input], ['The recording', recorded]]) {
    const check = validateCaptureWav({ filename: f.filename, bytes: f.buffer });
    if (!check.ok) return bad(`${what}: ${check.reason}`);
  }

  let wav;
  try {
    wav = decodeWavMono(input.buffer);
  } catch (err) {
    return bad(`The re-amp signal could not be read as audio: ${err.message}`);
  }
  const inputFrames = wav.samples.length;
  const inputRate = wav.sampleRate;
  // RELEASED BEFORE THE SECOND DECODE, and it is 73 MB: the official re-amp signal is 9.12 M frames and only
  // its frame count is ever used. `checkCapture` takes the count for exactly this reason.
  wav = null;
  const id = identifyBytes(input.buffer);

  let rec;
  try {
    rec = decodeWavMono(recorded.buffer);
  } catch (err) {
    return bad(`The recording could not be read as audio: ${err.message}`);
  }

  const result = checkCapture({
    inputFrames,
    recorded: rec.samples,
    inputRate,
    recordedRate: rec.sampleRate,
    inputVersion: id.version,
    inputMajor: id.major,
  });

  // The MD5 goes back because "the trainer will not recognise this input" is the most common failure and the
  // least informative sentence on its own — the panel shows the hash so the user can compare it with the one
  // the download page states.
  return {
    status: 200,
    body: { ...result, inputMd5: id.md5, inputName: input.filename, recordedName: recorded.filename },
  };
}
