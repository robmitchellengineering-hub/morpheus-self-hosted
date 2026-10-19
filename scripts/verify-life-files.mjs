// Runtime verification for life-stream attachments — what an upload records.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-life-files.mjs
//
// The claim being protected: `is_image` decides whether the stream renders a thumbnail or a document
// icon, and the wrong way round shows a broken image where a plain icon would have been fine. And an
// attachment with no stream must not be shown under one.
import { readFileSync } from 'node:fs';
import { describeUpload, groupByStream } from '../src/pages/CommandDeck/lifeFiles.js';

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

console.log('\n1. an upload records what it is, and never guesses "image"');
check('a photo is an image', describeUpload({ name: 'bill.jpg', type: 'image/jpeg' }, 'https://x/1').is_image, true);
check('…including a phone photo', describeUpload({ name: 'IMG_1.HEIC', type: 'image/heic' }, 'https://x/2').is_image, true);
check('a PDF is NOT an image', describeUpload({ name: 'lab.pdf', type: 'application/pdf' }, 'https://x/3').is_image, false);
check('a Word file is not an image', describeUpload({ name: 'x.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, 'u').is_image, false);
// The direction that matters: unknown must fall to DOCUMENT, because a broken <img> is worse than a
// plain icon.
check('an unknown type falls to document, not image', describeUpload({ name: 'mystery', type: '' }, 'u').is_image, false);
check('a missing type does not throw', describeUpload({ name: 'mystery' }, 'u').is_image, false);
check('the url is kept', describeUpload({ name: 'a.png', type: 'image/png' }, 'https://x/4').file_url, 'https://x/4');
check('the name is kept', describeUpload({ name: 'a.png', type: 'image/png' }, 'u').file_name, 'a.png');
check('the type is kept for later', describeUpload({ name: 'a.png', type: 'image/png' }, 'u').file_type, 'image/png');
check('a nameless file still stores', describeUpload({ type: 'image/png' }, 'u').file_name, '');

console.log('\n2. attachments hang on their own stream, and nowhere else');
const files = [
  { id: '1', life_stream_id: 's-health' },
  { id: '2', life_stream_id: 's-health' },
  { id: '3', life_stream_id: 's-money' },
];
const grouped = groupByStream(files, ['s-health', 's-money', 's-people']);
check('a stream gets its own two', grouped['s-health'].map((f) => f.id), ['1', '2']);
check('…and the other gets its one', grouped['s-money'].map((f) => f.id), ['3']);
check('a stream with none is simply absent, not empty-and-broken', grouped['s-people'], undefined);
// A row whose stream was deleted must not surface under a stream it does not belong to.
check('a file on an unknown stream is dropped', groupByStream([{ id: 'x', life_stream_id: 'gone' }], ['s-health']), {});
check('a file with no stream at all is dropped', groupByStream([{ id: 'y' }], ['s-health']), {});
check('junk does not throw', [groupByStream(null, []), groupByStream([], null)], [{}, {}]);

console.log('\n3. the wiring that makes it reachable is present');
const ctx = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
const widget = readFileSync(new URL('../src/pages/CommandDeck/widgets/life_streams.jsx', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../server/prisma/schema.prisma', import.meta.url), 'utf8');
check('the stream carries its attachments', /files: lifeFileRows\.filter\(\(f\) => f\.life_stream_id === ls\.id\)/.test(ctx), true);
check('there is a way to attach and a way to remove', /addLifeFiles/.test(ctx) && /removeLifeFile/.test(ctx), true);
check('the upload decides is_image through the guarded helper', /describeUpload\(f, url\)/.test(widget), true);
check('the widget offers a real file input, not only a button', /type="file"/.test(widget), true);
check('the table exists', /model DeckLifeFile \{/.test(schema), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
