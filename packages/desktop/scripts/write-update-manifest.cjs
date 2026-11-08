const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {version} = require('../package.json');
const file = `kanborg-${version}-mac-arm64.dmg`;
const release = path.resolve(__dirname, '../release');
// A signed app is not necessarily accepted by Gatekeeper after download.
// Never advertise an update until Apple's ticket is stapled and accepted.
const bundle = path.join(release, 'mac-arm64', 'KanBorg.app');
execFileSync('/usr/bin/xcrun', ['stapler', 'validate', bundle], {stdio:'inherit'});
execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', bundle], {stdio:'inherit'});
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(release, file))).digest('hex');
fs.writeFileSync(path.join(release, 'kanborg-update.json'), JSON.stringify({version, file, sha256}, null, 2));
