const {execFileSync} = require('node:child_process');
const path = require('node:path');

// Local builds have no Developer ID. Seal the complete bundle rather than
// retaining Electron's incomplete linker signature after repackaging.
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {stdio:'inherit'});
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {stdio:'inherit'});
};
