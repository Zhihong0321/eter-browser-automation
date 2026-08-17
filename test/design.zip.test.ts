import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { zipDir, zipEntries } from '../src/design/zip.js';
import { toSlug } from '../src/design/host.js';

function tmpSite(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-zip-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

/**
 * Read the archive back through the central directory, the way a real unzipper
 * does. Asserting on our own local headers would pass even if the central
 * directory were wrong — and that is the half the server reads first.
 */
function readViaCentralDirectory(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'no end-of-central-directory signature');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'bad central header signature');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    offset += 46 + nameLen + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return out;
}

test('a zipped site round-trips through the central directory', () => {
  const dir = tmpSite({
    'index.html': '<!doctype html><h1>Hello</h1>',
    'css/app.css': 'body{margin:0}',
    'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const files = readViaCentralDirectory(zipDir(dir));

  assert.deepEqual([...files.keys()].sort(), ['css/app.css', 'img/logo.svg', 'index.html']);
  assert.equal(files.get('index.html')!.toString(), '<!doctype html><h1>Hello</h1>');
  assert.equal(files.get('css/app.css')!.toString(), 'body{margin:0}');
});

test('nested paths use forward slashes, not the platform separator', () => {
  // A backslash here would publish a file literally named "css\app.css" on a
  // Linux host, and every relative href would 404.
  const files = readViaCentralDirectory(zipDir(tmpSite({ 'index.html': 'x', 'a/b/c.txt': 'deep' })));
  assert.ok(files.has('a/b/c.txt'));
  assert.equal([...files.keys()].some((k) => k.includes('\\')), false);
});

test('secrets and junk never reach a public host', () => {
  const files = readViaCentralDirectory(
    zipDir(tmpSite({ 'index.html': 'x', '.env': 'KEY=secret', '.DS_Store': 'junk' })),
  );
  assert.equal(files.has('.env'), false);
  assert.equal(files.has('.DS_Store'), false);
  assert.deepEqual([...files.keys()], ['index.html']);
});

test('a bundle without index.html at the root is refused before upload', () => {
  // The engine answers 400 for this; failing here names the actual problem.
  assert.throws(() => zipDir(tmpSite({ 'pages/index.html': 'x' })), /No index\.html at the root/);
});

test('incompressible data is stored, never inflated by deflate', () => {
  // Deflate on random bytes produces MORE bytes than the input. Storing avoids
  // an archive larger than the directory it came from. Must be genuinely
  // random: an arithmetic sequence looks random but compresses ~30x.
  const random = randomBytes(4096);
  const zip = zipEntries([{ name: 'index.html', body: random }]);
  assert.equal(zip.readUInt16LE(8), 0, 'method should be 0 (stored)');
  assert.deepEqual(readViaCentralDirectory(zip).get('index.html'), random);
});

test('the same input zips byte-identically', () => {
  // Fixed DOS timestamps, so a re-publish with no changes is a no-op diff.
  const entries = [{ name: 'index.html', body: Buffer.from('stable') }];
  assert.deepEqual(zipEntries(entries), zipEntries(entries));
});

test('slugs are derived within the engine rules', () => {
  assert.equal(toSlug('SolarTapak — Landing Page!'), 'solartapak-landing-page');
  assert.equal(toSlug('  Q3 2026 Pitch  '), 'q3-2026-pitch');
  // 63 chars max, and must not end on the hyphen the truncation created.
  const long = toSlug('a'.repeat(80));
  assert.equal(long.length, 63);
  assert.match(long, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  assert.throws(() => toSlug('!!!'), /Cannot derive a valid slug/);
});
