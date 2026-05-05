const fs = require('fs');
const path = require('path');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/restore-json.js ./backups/data-YYYY.json');
  process.exit(1);
}
const resolved = path.resolve(process.cwd(), source);
if (!fs.existsSync(resolved)) {
  console.error(`Backup file not found: ${resolved}`);
  process.exit(1);
}
JSON.parse(fs.readFileSync(resolved, 'utf8'));
const target = path.join(__dirname, '..', 'data.json');
fs.copyFileSync(resolved, target);
console.log(`Restored ${resolved} to ${target}`);
