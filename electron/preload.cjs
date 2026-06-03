const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('polarRuntime', {
  isElectron: true,
  executeNode(classType, params, inputs) {
    return ipcRenderer.invoke('polar:execute-node', { classType, params, inputs })
  },
})
