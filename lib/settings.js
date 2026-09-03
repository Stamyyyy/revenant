const fs = require('fs');
const { atomicWriteFileSync } = require('./atomic-write');

function loadSettings(settingsPath, defaults) {
  try {
    return Object.assign({}, defaults, JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch (e) {
    return Object.assign({}, defaults);
  }
}

function saveSettings(settingsPath, settings) {
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

module.exports = { loadSettings, saveSettings };
