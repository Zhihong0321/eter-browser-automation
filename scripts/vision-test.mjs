// PROTOTYPE — throwaway. Hardcoded, no error handling. Do not ship.
// Verify the FIXED wrapper: images work, and text-only did not regress.

import fs from 'node:fs';
for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  if (l.includes('=') && !l.startsWith('#')) process.env[l.slice(0, l.indexOf('=')).trim()] = l.slice(l.indexOf('=') + 1).trim();
}

const { fastAsk, imageDataUrl, isFastWorkerReady } = await import('../dist/fastworker.js');
console.log('ready:', isFastWorkerReady(), '| model:', process.env.FASTWORKER_MODEL);

console.log('\n--- TEXT-ONLY (regression check)');
const t = await fastAsk('What is 17 + 25? Digits only.');
console.log('   answer:', t.text, '|', t.ms, 'ms |', t.outputTokens, 'tok');

console.log('\n--- WITH IMAGE (the login page that cost 5 hours)');
const v = await fastAsk(
  'This is a 2403x1401 screenshot. Name the control that submits this login form, and give its centre as x,y normalised 0-1000. Answer as: NAME | x,y',
  { images: [imageDataUrl('scripts/ac-wall.png')], maxTokens: 2000 },
);
console.log('   answer:', v.text);
console.log('   ', v.ms, 'ms |', v.outputTokens, 'tok | reasoning', v.reasoningChars, 'chars');

const m = v.text.match(/(\d+)\s*,\s*(\d+)/);
if (m) console.log(`   -> click at (${Math.round((+m[1] / 1000) * 2403)}, ${Math.round((+m[2] / 1000) * 1401)})   [true button centre ~ (1448, 924)]`);
