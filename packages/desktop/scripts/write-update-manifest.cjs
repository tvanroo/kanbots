const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {version} = require('../package.json');
const file = `kanborg-${version}-mac-arm64.dmg`;
const release = path.resolve(__dirname, '../release');
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(release, file))).digest('hex');
fs.writeFileSync(path.join(release, 'kanborg-update.json'), JSON.stringify({version, file, sha256}, null, 2));
