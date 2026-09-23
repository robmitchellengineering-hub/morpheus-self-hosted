// Runtime verification for the Alice Stats photo widget.
//
// Dependency-free (server/src/lib/photoDrive.js imports nothing), so it runs in
// CI's no-install guards job. Run:  node scripts/verify-photo-drive.mjs
//
// Two halves, and the second is the one that rots:
//   1. the pure decisions — what counts as a folder, what counts as an
//      acceptable photo, what a filename looks like, and above all whether a
//      403 and a 404 can be told apart.
//   2. the promises the UI makes — the photo goes to the user's own Drive and
//      nowhere else, the camera opens on a phone, and no Prisma column was
//      added to store what an existing JSON column already holds.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MAX_PHOTO_BYTES, ALLOWED_PHOTO_MIME, CONNECTIONS_KEY, DEFAULT_FOLDER_NAME,
  folderIdFromInput, driveFolderLink, driveFileLink, extensionForMime,
  photoFilename, validatePhoto, classifyDriveError,
  GOOGLE_SOURCES, chooseGoogleSource, hasAnyGoogleSource,
} from '../server/src/lib/photoDrive.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let checks = 0;
let failures = 0;
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

const has = (haystack, needle) => String(haystack).includes(needle);
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456';

console.log('\nPhoto widget → Google Drive — runtime verification\n');

// ── 1. what counts as a folder ──────────────────────────────────────────────
console.log('1. a folder link or id resolves, and nothing else does');

check('a plain folder link', folderIdFromInput(`https://drive.google.com/drive/folders/${ID}`), ID);
check('a folder link with an account index', folderIdFromInput(`https://drive.google.com/drive/u/1/folders/${ID}?usp=sharing`), ID);
check('an open?id= link', folderIdFromInput(`https://drive.google.com/open?id=${ID}`), ID);
check('a bare id pasted from the URL bar', folderIdFromInput(ID), ID);
check('surrounding whitespace is tolerated', folderIdFromInput(`  ${ID}  `), ID);
// The dangerous one: a folder NAME cannot be resolved by name here, and
// guessing would send a person's photos at whatever happens to match.
check('a folder name is refused, not guessed at', folderIdFromInput('Morpheus Photos'), null);
check('a non-Drive URL is refused', folderIdFromInput(`https://example.com/drive/folders/${ID}`), null);
check('a Drive link with no folder in it is refused', folderIdFromInput('https://drive.google.com/drive/my-drive'), null);
check('an empty string is refused', folderIdFromInput(''), null);
check('null is refused', folderIdFromInput(null), null);
check('a sentence is refused', folderIdFromInput('save them in my photos folder please'), null);
check('the folder link we show points at the id', driveFolderLink(ID), `https://drive.google.com/drive/folders/${ID}`);
check('the file link we show points at the id', driveFileLink(ID), `https://drive.google.com/file/d/${ID}/view`);
check('a junk id produces no link rather than a broken one', driveFolderLink('nope'), '');

// ── 2. what counts as an acceptable photo ───────────────────────────────────
console.log('\n2. photos are accepted or refused for a stated reason');

check('a normal jpeg is accepted', validatePhoto({ size: 2 * 1024 * 1024, mime: 'image/jpeg' }).ok, true);
check('the limit itself is accepted', validatePhoto({ size: MAX_PHOTO_BYTES, mime: 'image/png' }).ok, true);
check('one byte over the limit is refused', validatePhoto({ size: MAX_PHOTO_BYTES + 1, mime: 'image/png' }).ok, false);
// The message is the whole point of the refusal: it has to say how big, and
// what the limit is, or the operator is left guessing at the picker.
const tooBig = validatePhoto({ size: MAX_PHOTO_BYTES + 1, mime: 'image/png' }).reason;
check('the too-big reason names the limit in MB', has(tooBig, 'MB') && has(tooBig, '8'), true);
check('an empty file is refused', validatePhoto({ size: 0, mime: 'image/jpeg' }).ok, false);
check('a missing size is refused', validatePhoto({ mime: 'image/jpeg' }).ok, false);
check('a PDF is refused', validatePhoto({ size: 1000, mime: 'application/pdf' }).ok, false);
check('the wrong-type reason names the type', has(validatePhoto({ size: 1000, mime: 'application/pdf' }).reason, 'application/pdf'), true);
check('every allowed mime passes', ALLOWED_PHOTO_MIME.every((m) => validatePhoto({ size: 1000, mime: m }).ok), true);

// ── 3. filenames ────────────────────────────────────────────────────────────
console.log('\n3. a photo gets a name that will not collide');

const at = new Date('2026-09-22T07:15:30.000Z');
check('the filename is timestamped and carries the mime extension', photoFilename('IMG_4021.JPG', 'image/jpeg', at), 'photo-2026-09-22T07-15-30Z.jpg');
check('a png stays a png', photoFilename('x', 'image/png', at), 'photo-2026-09-22T07-15-30Z.png');
check('a heic stays a heic', photoFilename('x', 'image/heic', at), 'photo-2026-09-22T07-15-30Z.heic');
check('two seconds apart do not collide',
  photoFilename('a', 'image/jpeg', at) === photoFilename('b', 'image/jpeg', new Date(at.getTime() + 1000)), false);
// A hostile or odd name must not decide the extension when the mime already did.
check('the mime wins over a misleading filename', photoFilename('holiday.png', 'image/jpeg', at), 'photo-2026-09-22T07-15-30Z.jpg');
check('an unknown mime falls back to the name extension', photoFilename('snap.webp', 'application/octet-stream', at), 'photo-2026-09-22T07-15-30Z.webp');
check('an unknown mime and no name extension still yields jpg', photoFilename('snap', '', at), 'photo-2026-09-22T07-15-30Z.jpg');
check('mime parameters are ignored', extensionForMime('image/jpeg; charset=binary'), 'jpg');
check('an unknown mime has no extension', extensionForMime('image/tiff'), '');

// ── 4. the failures must not look alike ─────────────────────────────────────
console.log('\n4. a scope refusal never reads like a missing folder');

const forbidden = classifyDriveError(403, 'Insufficient permissions');
const missing = classifyDriveError(404, 'File not found');
check('403 is classified as a scope problem', forbidden.kind, 'scope');
check('404 is classified as not-found', missing.kind, 'not-found');
check('the two messages differ', forbidden.message === missing.message, false);
// drive.file is the actual cause of the 403, and the message must say so or the
// operator will re-paste the same folder forever.
check('the 403 message explains drive.file', has(forbidden.message, 'drive.file'), true);
check('the 403 message points at the way out', has(forbidden.message, 'create one'), true);
check('401 is an auth problem', classifyDriveError(401).kind, 'auth');
check('429 is rate limiting', classifyDriveError(429).kind, 'rate');
check('a 500 is upstream, and says nothing was saved', has(classifyDriveError(500).message, 'Nothing was saved'), true);
check('an unknown status keeps the real reason', has(classifyDriveError(418, 'teapot').message, 'teapot'), true);

// ── 5. the promises the UI makes ────────────────────────────────────────────
console.log('\n5. the photo goes to the user\'s own Drive, and the camera opens');

const widget = read('src/components/matrix/PhotoDriveWidget.jsx');
const handler = read('server/src/functions/photoDrive.js');
const schema = read('server/prisma/schema.prisma');

check('the input opens the camera on a phone', has(widget, 'capture="environment"'), true);
check('the input accepts images', has(widget, 'accept="image/*"'), true);
check('the widget calls the photoDrive function', has(widget, "invoke('photoDrive'"), true);
check('the widget shows a preview before uploading', has(widget, 'previewUrl'), true);
// The promise, in as many words, on screen.
check('the UI says the photo is not stored by Morpheus', has(widget, 'Morpheus never stores it'), true);
check('the widget offers to create a folder', has(widget, "action: 'create_folder'"), true);
check('the widget can take a pasted folder link', has(widget, "action: 'set_folder'"), true);

check('the handler reuses the existing Drive file helper', has(handler, 'createDriveFile'), true);
check('the handler verifies a pasted folder instead of trusting it', has(handler, 'getDriveFileMeta'), true);
check('the handler reports where the photo lives', has(handler, "storedBy: 'google-drive'"), true);
// Comments are stripped before asserting on source. The handler's own header
// explains that it does NOT use S3 or the media route — without this, that
// sentence is collected as if it were an import.
const handlerCode = handler.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('the handler does not reach for S3 or the media route', /mediaAssets|media-assets|S3Client|aws-sdk/.test(handlerCode), false);
check('the handler starts no second OAuth flow', has(handlerCode, 'oauth2.googleapis.com'), false);
// The storage decision, pinned: an existing JSON column, no migration. The
// handler must go through the shared constant — a literal here would drift
// from the lib that defines it.
check('the handler stores under the shared namespaced key', has(handlerCode, 'CONNECTIONS_KEY'), true);
check('that key is namespaced, not a bare word', /^[a-z][A-Za-z]+[A-Z]/.test(CONNECTIONS_KEY), true);
check('the storage is UserSettings.connections', has(handlerCode, 'connections'), true);
check('no new Prisma column was added for the folder', /photoDriveFolderId\s+String/.test(schema), false);
check('the schema still has no photo column at all', /photo(Folder|DriveFile|Upload)/i.test(schema), false);
check('a sensible default folder name exists', DEFAULT_FOLDER_NAME, 'Morpheus Photos');

// The page's own honesty claim had to change once this widget remembered a
// folder: "nothing is stored" stopped being true, so it now says what is.
const page = read('src/pages/AliceStats.jsx');
check('the page mounts the widget', has(page, '<PhotoDriveWidget />'), true);
check('the page no longer claims nothing at all is stored', has(page, 'nothing is stored. The photo widget'), true);


// ── 6. one user, one Google consent ─────────────────────────────────────────
//
// Rob, 2026-09-22: "The google credentials should come from the google connected
// from the user." There are two per-user Google connections here and the widget
// originally used only one of them, so somebody who had already connected Google
// for the Command Deck was asked to connect it again for a photo. These
// assertions pin the fix, including the shape of the bug: a hard dependency on
// either single connection.
console.log('\n6. the token comes from whichever Google connection the user already has');

const deckConn = { email: 'rob@example.com', token: 'deck-token' };
const driveConn = { email: 'other@example.com', token: 'drive-token' };

check('the Deck connection wins when both exist', chooseGoogleSource({ deck: deckConn, drive: driveConn })?.source, 'deck');
check('a Deck-only user needs no Drive connection', chooseGoogleSource({ deck: deckConn, drive: null })?.source, 'deck');
check('a Drive-only user still works', chooseGoogleSource({ deck: null, drive: driveConn })?.source, 'drive');
check('only a user with NEITHER is prompted to connect', chooseGoogleSource({ deck: null, drive: null }), null);
check('the account that will be used is reported back', chooseGoogleSource({ deck: deckConn, drive: driveConn })?.email, 'rob@example.com');
check('the chosen connection carries a human label', chooseGoogleSource({ deck: deckConn, drive: null })?.label, GOOGLE_SOURCES[0]?.label);
check('a row with no token does not count as connected', chooseGoogleSource({ deck: { email: 'x' }, drive: null }), null);
check('the search order is deck then drive', GOOGLE_SOURCES.map((s) => s.id), ['deck', 'drive']);
// The regression this guards: someone "simplifying" this down to the one
// connection they happen to know about.
check('more than one source exists — neither is a hard dependency', GOOGLE_SOURCES.length >= 2, true);
check('hasAnyGoogleSource agrees with the chooser', hasAnyGoogleSource({ drive: driveConn }), true);
check('hasAnyGoogleSource says no when there is nothing', hasAnyGoogleSource({}), false);

check('the handler resolves the Deck connection', has(handlerCode, 'getDeckGoogleConnection'), true);
check('the handler resolves the Drive connection as a fallback', has(handlerCode, 'getGoogleDriveConnection'), true);
// getGoogleDriveToken THROWS when the Drive connection is absent, so using it
// here would reinstate exactly the dependency Rob corrected.
check('the handler never calls the throwing Drive-only resolver', has(handlerCode, 'getGoogleDriveToken'), false);
check('the widget names the account and where it came from', has(widget, 'sourceLabel'), true);
check('the copy promises no second consent', has(widget, 'never a second one'), true);

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe photo widget is broken, or it promises something it does not do.\n');
  process.exit(1);
}
console.log('photo widget holds.\n');
