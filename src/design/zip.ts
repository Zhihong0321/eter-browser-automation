/**
 * Minimal ZIP writer.
 *
 * The host engine accepts one thing: a .zip with index.html at its root. Node
 * ships a deflate encoder but no zip container, and the container is a 1989
 * format that fits in this file — cheaper than taking a dependency for it.
 *
 * Deliberately no compression method beyond deflate and no zip64: a bundle that
 * needs either is past the engine's 145 MB limit anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Every entry gets the same DOS timestamp, so identical input zips byte-identically. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01, the earliest the format can express.

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  name: string;
  body: Buffer;
}

/** Build a zip in memory. */
export function zipEntries(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.body);
    // A tiny or incompressible file can deflate LARGER than the input. Storing
    // it verbatim is both smaller and what every other writer does.
    const stored = deflated.length >= entry.body.length;
    const data = stored ? entry.body : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

/** Files that must never reach a public host, whatever the agent left lying around. */
const NEVER_BUNDLE = /^(\.env|\.env\..*|\.git|node_modules|\.DS_Store|Thumbs\.db)$/i;

function walk(root: string, dir: string, out: ZipEntry[]): void {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (NEVER_BUNDLE.test(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(root, full, out);
    else if (item.isFile()) {
      out.push({ name: path.relative(root, full).split(path.sep).join('/'), body: fs.readFileSync(full) });
    }
  }
}

/**
 * Zip a directory's CONTENTS, not the directory itself — the engine wants
 * index.html at the archive root.
 */
export function zipDir(dir: string): Buffer {
  const entries: ZipEntry[] = [];
  walk(dir, dir, entries);
  if (!entries.some((e) => e.name === 'index.html')) {
    // The engine answers 400 for this. Failing here names the actual problem.
    throw new Error(`No index.html at the root of ${dir} — the host engine will reject the bundle.`);
  }
  return zipEntries(entries);
}
