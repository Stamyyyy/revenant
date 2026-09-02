const fs = require('fs');
const { buildIndex, search } = require('./mft');

const out = [];
const log = (...a) => { const line = a.join(' '); out.push(line); };

const t0 = Date.now();
let lastLog = t0;
let index, totalRecords;
try {
  ({ index, totalRecords } = buildIndex('C', (scanned, total) => {
    const now = Date.now();
    if (now - lastLog > 2000 || scanned === total) {
      log(`scanned ${scanned}/${total} (${((scanned / total) * 100).toFixed(1)}%) @ ${((now - t0) / 1000).toFixed(1)}s`);
      lastLog = now;
    }
  }));
} catch (err) {
  log('BUILD FAILED:', err.stack);
  fs.writeFileSync('C:\\Users\\stama\\code\\revenant\\lib\\test-out.txt', out.join('\n'), 'utf8');
  process.exit(1);
}
const t1 = Date.now();

log(`\nindex built: ${index.size} in-use records out of ${totalRecords} total, in ${((t1 - t0) / 1000).toFixed(2)}s`);

const queries = process.argv.slice(2);
if (queries.length === 0) queries.push('wraith', 'node_modules', '.exe');

for (const q of queries) {
  const st = Date.now();
  const results = search(index, q, 'C', 15);
  log(`\nsearch "${q}" -> ${results.length} results in ${Date.now() - st}ms`);
  for (const r of results) log(`  ${r.isDirectory ? '[dir] ' : '      '}${r.path}`);
}

fs.writeFileSync('C:\\Users\\stama\\code\\revenant\\lib\\test-out.txt', out.join('\n'), 'utf8');
