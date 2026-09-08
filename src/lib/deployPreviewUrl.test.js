import { buildDeployPreviewUrl } from './deployPreviewUrl.js';
import assert from 'node:assert';

const expected = 'https://deploy-preview-42--morpheus-self-hosted-app.netlify.app';
assert.strictEqual(buildDeployPreviewUrl(42), expected);
console.log('deployPreviewUrl.test.js passed');
