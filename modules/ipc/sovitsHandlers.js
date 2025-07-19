const { ipcMain } = require('electron');
const SovitsTTS = require('../SovitsTTS');

let sovitsTTSInstance = null;

function initialize(mainWindow) {
    if (!mainWindow) {
        console.error("SovitsTTS a besoin de la fenêtre principale pour s'initialiser.");
        return;
    }

    sovitsTTSInstance = new SovitsTTS(mainWindow);

    ipcMain.handle('sovits-get-models', async (event, forceRefresh) => {
        if (!sovitsTTSInstance) return null;
        return await sovitsTTSInstance.getModels(forceRefresh);
    });

    ipcMain.on('sovits-speak', (event, { text, voice, speed, msgId }) => {
        if (!sovitsTTSInstance) return;
        sovitsTTSInstance.speak(text, voice, speed, msgId);
    });

    ipcMain.on('sovits-stop', () => {
        if (!sovitsTTSInstance) return;
        sovitsTTSInstance.stop();
    });

    ipcMain.on('sovits-audio-playback-finished', () => {
        if (!sovitsTTSInstance) return;
        sovitsTTSInstance.audioPlaybackFinished();
    });

    console.log('SovitsTTS IPC handlers initialisés.');
}

module.exports = {
    initialize
};