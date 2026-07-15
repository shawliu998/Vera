const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aletheiaDesktop", {
  getInfo: () => ipcRenderer.invoke("aletheia:get-info"),
  getAuthToken: () => ipcRenderer.invoke("aletheia:get-auth-token"),
  openDataDirectory: () => ipcRenderer.invoke("aletheia:open-data-directory"),
  openLogsDirectory: () => ipcRenderer.invoke("aletheia:open-logs-directory"),
  exportDiagnosticBundle: () =>
    ipcRenderer.invoke("aletheia:export-diagnostics"),
  restartLocalServices: () =>
    ipcRenderer.invoke("aletheia:restart-local-services"),
  getAuditAnchorConfiguration: () =>
    ipcRenderer.invoke("aletheia:get-audit-anchor-configuration"),
  configureAuditAnchor: () =>
    ipcRenderer.invoke("aletheia:configure-audit-anchor"),
  disableAuditAnchor: () =>
    ipcRenderer.invoke("aletheia:disable-audit-anchor"),
  createEncryptedBackup: () =>
    ipcRenderer.invoke("aletheia:create-encrypted-backup"),
  inspectEncryptedBackup: () =>
    ipcRenderer.invoke("aletheia:inspect-encrypted-backup"),
  restoreEncryptedBackup: () =>
    ipcRenderer.invoke("aletheia:restore-encrypted-backup"),
  saveLitigationArtifact: (input) =>
    ipcRenderer.invoke("aletheia:save-litigation-artifact", input),
  saveOriginalMatterDocument: (input) =>
    ipcRenderer.invoke("aletheia:save-original-matter-document", input),
  getNotificationSupport: () =>
    ipcRenderer.invoke("aletheia:notification-support"),
  showNotification: (input) =>
    ipcRenderer.invoke("aletheia:show-notification", input),
  dismissNotification: (tag) =>
    ipcRenderer.invoke("aletheia:dismiss-notification", tag),
  saveTaskCalendar: (input) =>
    ipcRenderer.invoke("aletheia:save-task-calendar", input),
});
