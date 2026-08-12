import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'ui', 'index.html');
const toDir = path.join(root, 'dist', 'ui');

fs.mkdirSync(toDir, { recursive: true });
fs.copyFileSync(from, path.join(toDir, 'index.html'));
console.log(`copied ui → dist/ui/index.html`);
