const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  config: () => ipcRenderer.invoke('config'),
  server: value => ipcRenderer.invoke('server', value),
  request: (route, method = 'GET', body) => ipcRenderer.invoke('request', { route, method, body }),
  connect: on => ipcRenderer.invoke('connect', on),
  window: action => ipcRenderer.invoke('window', action),
  fit: height => ipcRenderer.invoke('fit', height),
  speak: text => ipcRenderer.invoke('speak', text),
  stopVoice: () => ipcRenderer.invoke('stop-voice'),
  onEvent: callback => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
});
