// Live smoke for the page-insight stage. Not part of the test suite: it needs a real
// browser and a real site. `npx tsx scripts/pi-smoke.ts <url>`
import { VaultService } from '../src/service.js';
import { runPageInsight, pageInsightApiKey } from '../src/enrich/pageinsight.js';
import { resolveVaultHome } from '../src/config.js';

const url = process.argv[2] ?? 'https://www.eternalgy.com';
const svc = new VaultService(resolveVaultHome());
console.log('PAGESPEED_API_KEY set:', pageInsightApiKey() ? 'yes' : 'no');
try {
  const r = await runPageInsight(url, { browser: svc.agentBrowser() });
  console.log(JSON.stringify(r, null, 2));
} catch (e) {
  console.log('FAILED:', e instanceof Error ? e.message : e);
}
process.exit(0);
