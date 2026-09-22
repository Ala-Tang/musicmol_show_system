const fs = require('fs');
const path = require('path');

function chromiumLaunchOptions(extra = {}) {
  const localChrome = path.join(__dirname, '..', 'painojs', 'chrome-linux64', 'chrome');
  if (fs.existsSync(localChrome) && !extra.executablePath) {
    return { ...extra, executablePath: localChrome };
  }
  return { ...extra };
}

module.exports = { chromiumLaunchOptions };
