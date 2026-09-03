const fs = require('fs');

function loadSettings(settingsPath, defaults) {
  try {
    return Object.assign({}, defaults, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch (e) {
    return Object.assign({}, defaults);
  }
}

function saveSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

module.exports = { loadSettings, saveSettings };
