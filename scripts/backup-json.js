const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataFile = path.join(root, 'data.json');
const backupDir = path.resolve(root, process.env.BACKUP_DIR || 'backups');

if (!fs.existsSync(dataFile)) {
  console.error('No data.json found. Start the app once or check your storage mode.');
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(backupDir, `data-${stamp}.json`);
fs.copyFileSync(dataFile, out);
console.log(`JSON backup created: ${out}`);
