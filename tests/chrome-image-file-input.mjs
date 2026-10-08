import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MAX_CHROME_IMAGE_FILE_BYTES, prepareChromeImageFile } from '../lib/chrome-image-file.mjs';
import { safeChromeDiagnostics } from '../lib/chrome-extension-client.mjs';
import { isReadOnlyChromeMethod, operationFingerprint } from '../lib/chrome-operation-registry.mjs';

// No provider, browser, or owner files are accessed. All inputs are constructed
// inside one new private temporary directory and removed after this suite.
const temporaryDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mdb-image-file-unit-')));
await fs.chmod(temporaryDirectory, 0o700);
const results = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const typedBody = Buffer.concat([Buffer.from(type), body]);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc32(typedBody));
  return Buffer.concat([header, typedBody, trailer]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(3, 0);
ihdr.writeUInt32BE(2, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const rgbaRow = Buffer.from([0, 35, 83, 53, 255, 35, 83, 53, 255, 35, 83, 53, 255]);
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.concat([rgbaRow, rgbaRow]))), chunk('IEND', Buffer.alloc(0)),
]);
// The preparer promises container-signature validation, not image decoding.
// JPEG/WebP cases exercise that contract; the browser suite decodes the PNG.
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([18, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0])]);
const paths = {};
async function write(name, bytes) {
  const localPath = path.join(temporaryDirectory, name);
  await fs.writeFile(localPath, bytes, { mode: 0o600 });
  paths[name] = localPath;
  return localPath;
}
async function scenario(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message, stack: error.stack }); }
}
async function rejected(name, args, expectedCode) {
  await scenario(name, async () => {
    await assert.rejects(() => prepareChromeImageFile(args), error => {
      assert.equal(error.code, expectedCode);
      const publicError = JSON.stringify({ message: error.message, details: error.details });
      assert.ok(!publicError.includes(temporaryDirectory), 'Failure diagnostics must not expose the absolute source path');
      assert.ok(!publicError.includes(png.toString('base64')), 'Failure diagnostics must not expose image bytes');
      return true;
    });
  });
}
try {
  assert.equal(MAX_CHROME_IMAGE_FILE_BYTES, 1_048_576, 'The upload cap must fit the existing native envelope');
  for (const [name, mimeType, bytes] of [['logo.png', 'image/png', png], ['logo.jpg', 'image/jpeg', jpeg], ['logo.webp', 'image/webp', webp]]) {
    const localPath = await write(name, bytes);
    await scenario(`prepare-${mimeType}`, async () => {
      const prepared = await prepareChromeImageFile({ localPath, expectedSha256: hash(bytes), mimeType });
      assert.equal(prepared.name, name);
      assert.equal(prepared.mimeType, mimeType);
      assert.equal(prepared.size, bytes.length);
      assert.equal(prepared.sha256, hash(bytes));
      assert.deepEqual(Buffer.from(prepared.base64, 'base64'), bytes);
      assert.equal(Number.isFinite(prepared.lastModified), true);
      assert.equal(prepared.lastModified, Math.trunc((await fs.stat(localPath)).mtimeMs));
      assert.deepEqual(Object.keys(prepared).sort(), ['base64', 'lastModified', 'mimeType', 'name', 'sha256', 'size']);
    });
  }
  const valid = { localPath: paths['logo.png'], expectedSha256: hash(png), mimeType: 'image/png' };
  await rejected('relative-path', { ...valid, localPath: 'logo.png' }, 'CHROME_IMAGE_PATH_INVALID');
  await rejected('empty-path', { ...valid, localPath: '' }, 'CHROME_IMAGE_PATH_INVALID');
  await rejected('missing-file', { ...valid, localPath: path.join(temporaryDirectory, 'missing.png') }, 'CHROME_IMAGE_READ_FAILED');
  await rejected('directory', { ...valid, localPath: temporaryDirectory }, 'CHROME_IMAGE_NOT_REGULAR');
  const symlink = path.join(temporaryDirectory, 'linked.png');
  await fs.symlink(paths['logo.png'], symlink);
  await rejected('symlink', { ...valid, localPath: symlink }, 'CHROME_IMAGE_SYMLINK');
  await rejected('explicit-mime-required', { ...valid, mimeType: undefined }, 'CHROME_IMAGE_MIME_INVALID');
  await rejected('unsupported-mime', { ...valid, mimeType: 'image/svg+xml' }, 'CHROME_IMAGE_MIME_INVALID');
  await rejected('mime-does-not-match-signature', { ...valid, mimeType: 'image/jpeg' }, 'CHROME_IMAGE_SIGNATURE_MISMATCH');
  const disguised = await write('disguised.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  await rejected('active-format-is-not-a-raster-image', { ...valid, localPath: disguised, expectedSha256: hash(await fs.readFile(disguised)) }, 'CHROME_IMAGE_SIGNATURE_MISMATCH');
  const empty = await write('empty.png', Buffer.alloc(0));
  await rejected('empty-file', { ...valid, localPath: empty, expectedSha256: hash(Buffer.alloc(0)) }, 'CHROME_IMAGE_TOO_LARGE');
  const linkedDirectory = path.join(temporaryDirectory, 'linked-directory');
  await fs.symlink(temporaryDirectory, linkedDirectory);
  await rejected('symlink-in-parent-component', { ...valid, localPath: path.join(linkedDirectory, 'logo.png') }, 'CHROME_IMAGE_SYMLINK');
  await rejected('non-normalized-path', { ...valid, localPath: temporaryDirectory + '/./logo.png' }, 'CHROME_IMAGE_PATH_INVALID');
  const wrongExtension = await write('logo.txt', png);
  await rejected('raster-with-mismatched-extension', { ...valid, localPath: wrongExtension }, 'CHROME_IMAGE_SIGNATURE_MISMATCH');
  const truncated = await write('truncated.png', png.subarray(0, 16));
  await rejected('truncated-png-header', { ...valid, localPath: truncated, expectedSha256: hash(png.subarray(0, 16)) }, 'CHROME_IMAGE_SIGNATURE_MISMATCH');
  await rejected('mismatched-review-hash', { ...valid, expectedSha256: '0'.repeat(64) }, 'CHROME_IMAGE_HASH_MISMATCH');
  await rejected('malformed-review-hash', { ...valid, expectedSha256: 'not-a-sha256' }, 'CHROME_IMAGE_HASH_MISMATCH');
  await rejected('review-hash-required', { ...valid, expectedSha256: undefined }, 'CHROME_IMAGE_HASH_MISMATCH');
  const exactCapBytes = Buffer.concat([png, Buffer.alloc(MAX_CHROME_IMAGE_FILE_BYTES - png.length)]);
  const exactCap = await write('exact-cap.png', exactCapBytes);
  await scenario('exact-byte-cap-and-transport-budget', async () => {
    const file = await prepareChromeImageFile({ ...valid, localPath: exactCap, expectedSha256: hash(exactCapBytes) });
    assert.equal(file.size, MAX_CHROME_IMAGE_FILE_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify({ method: 'set_file_input', params: { tabId: 1, selector: '#logo-file', file } })) < 2 * 1024 * 1024,
      'The maximum payload plus metadata fits the existing 2 MiB native socket request cap');
  });
  const oversizedBytes = Buffer.concat([exactCapBytes, Buffer.from([0])]);
  const oversized = await write('too-large.png', oversizedBytes);
  await rejected('one-byte-over-cap', { ...valid, localPath: oversized, expectedSha256: hash(oversizedBytes) }, 'CHROME_IMAGE_TOO_LARGE');
  const prepared = await prepareChromeImageFile(valid);
  const source = await fs.readFile(path.join(root, 'bridge.mjs'), 'utf8');
  const start = source.indexOf('function auditSafeArguments(');
  assert.ok(start >= 0, 'The production audit redactor must be present');
  const end = source.indexOf('\n}', start);
  const auditSafeArguments = vm.runInNewContext('(' + source.slice(start, end + 2) + ')', { Buffer, crypto });
  const wire = { tabId: 123, selector: '#logo-file', expectedDocumentId: 'document-a', file: prepared };
  for (const [name, args] of [
    ['public-caller', { tab_id: 123, selector: '#logo-file', expected_document_id: 'document-a', local_path: valid.localPath,
      expected_sha256: prepared.sha256, mime_type: prepared.mimeType, operation_id: 'owned-upload-01' }],
    ['internal-wire', wire],
  ]) await scenario('audit-redacts-' + name, async () => {
    const redacted = JSON.parse(JSON.stringify(auditSafeArguments('chrome_set_file_input', args)));
    assert.equal(redacted.tab_id, 123);
    assert.equal(redacted.selector, '#logo-file');
    assert.equal(redacted.expected_document_id, 'document-a');
    assert.equal(redacted.expected_sha256, prepared.sha256);
    assert.equal(redacted.mime_type, prepared.mimeType);
    assert.equal(redacted.local_path, '[REDACTED_LOCAL_IMAGE_PATH]');
    assert.ok(!Object.hasOwn(redacted, 'file'), 'The internal wire file object never enters the audit');
    const text = JSON.stringify(redacted);
    assert.ok(!text.includes(temporaryDirectory));
    assert.ok(!text.includes(prepared.base64));
  });
  await scenario('file-diagnostics-retain-only-bounded-public-fields', async () => {
    const retained = { fileAssigned: true, inputEventDispatched: true, changeEventDispatched: false,
      inputDefaultPrevented: false, changeDefaultPrevented: false, fileRetained: false,
      fileCount: 0, fileSize: prepared.size, fileSha256: prepared.sha256 };
    const diagnostics = safeChromeDiagnostics({ ...retained, localPath: valid.localPath, local_path: valid.localPath,
      base64: prepared.base64, file: prepared, name: prepared.name, arbitrary: 'must-not-survive', message: valid.localPath });
    assert.deepEqual(diagnostics, retained);
    assert.deepEqual(safeChromeDiagnostics({ fileAssigned: { localPath: valid.localPath }, fileSize: Infinity, fileSha256: 'a'.repeat(129) }), {});
    assert.ok(!JSON.stringify(diagnostics).includes(prepared.base64));
    assert.ok(!JSON.stringify(diagnostics).includes(temporaryDirectory));
  });
  await scenario('upload-fingerprint-binds-reviewed-file-and-document', async () => {
    const request = { method: 'tabs.setFileInput', args: wire, allowedUrlPatterns: ['https://example.test/*'] };
    const fingerprint = operationFingerprint(request);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(isReadOnlyChromeMethod(request.method), false, 'File assignment uses the durable mutation lifecycle');
    for (const args of [
      { ...wire, expectedDocumentId: 'document-b' },
      { ...wire, file: { ...prepared, sha256: '0'.repeat(64) } },
      { ...wire, file: { ...prepared, base64: Buffer.from('different reviewed bytes').toString('base64') } },
    ]) assert.notEqual(operationFingerprint({ ...request, args }), fingerprint);
    const reorder = value => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    assert.equal(operationFingerprint(reorder(request)), fingerprint, 'Object insertion order does not change the no-replay identity');
  });
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: results.filter(result => result.passed).length, total: results.length, results, temporaryDirectoryRemoved: true }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
