const {execFileSync, spawnSync} = require('node:child_process');
const path = require('node:path');

// electron-builder signs nested binaries with our stable Developer ID first.
// Never replace that signature with an ad-hoc signature: doing so breaks
// Keychain trust across updates, even after the user chooses Always Allow.
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', bundle], {encoding:'utf8'});
  if (result.status !== 0 || !result.stderr.includes('TeamIdentifier=J997PDPCC4') || !result.stderr.includes('Authority=Developer ID Application:')) {
    throw new Error('KanBorg requires its stable Developer ID signature before packaging. Ad-hoc releases are not permitted.');
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {stdio:'inherit'});
};
