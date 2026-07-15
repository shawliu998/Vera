declare module "*.css";

interface AletheiaDesktopInfo {
  appVersion: string;
  backendUrl: string;
  workspaceApiUrl: string;
  frontendUrl: string;
  localClient: boolean;
  encryptedVolumeAttested: boolean;
  applicationEncryption: "required" | "disabled";
  databaseEncryption: "sqlcipher_required" | "metadata_plaintext";
}

interface Window {
  aletheiaDesktop?: {
    getInfo: () => Promise<AletheiaDesktopInfo>;
    getAuthToken: () => Promise<string>;
    openDataDirectory: () => Promise<{ opened: true }>;
    openLogsDirectory: () => Promise<{ opened: true }>;
    exportDiagnosticBundle: () => Promise<{
      saved: boolean;
      canceled: boolean;
      bytes?: number;
      sha256?: string;
      createdAt?: string;
    }>;
    restartLocalServices: () => Promise<{ restarted: true }>;
    getAuditAnchorConfiguration: () => Promise<{
      enabled: boolean;
      managedExternally: boolean;
      journalDirectory: string | null;
      keyId: string | null;
      status: string;
    }>;
    configureAuditAnchor: () => Promise<{
      changed: boolean;
      canceled: boolean;
      configuration: {
        enabled: boolean;
        managedExternally: boolean;
        journalDirectory: string | null;
        keyId: string | null;
        status: string;
      };
    }>;
    disableAuditAnchor: () => Promise<{
      changed: boolean;
      canceled: boolean;
      configuration: {
        enabled: boolean;
        managedExternally: boolean;
        journalDirectory: string | null;
        keyId: string | null;
        status: string;
      };
    }>;
    createEncryptedBackup: () => Promise<{
      saved: boolean;
      canceled: boolean;
      filePath?: string;
      bytes?: number;
      sha256?: string;
      createdAt?: string;
    }>;
    inspectEncryptedBackup: () => Promise<{
      canceled: boolean;
      ok?: boolean;
      filePath?: string;
      createdAt?: string;
      files?: number;
      bytes?: number;
      checks?: Array<{ id: string; ok: boolean; detail: string }>;
    }>;
    restoreEncryptedBackup: () => Promise<{
      restored: boolean;
      canceled: boolean;
      createdAt?: string;
      files?: number;
      bytes?: number;
    }>;
    saveLitigationArtifact: (input: {
      matterId: string;
      exportId: string;
      suggestedName: string;
      openAfterSave: boolean;
    }) => Promise<{
      saved: boolean;
      canceled: boolean;
      opened: boolean;
      openError?: string | null;
      filePath?: string;
    }>;
    saveOriginalMatterDocument: (input: {
      matterId: string;
      documentId: string;
      suggestedName: string;
      openAfterSave: boolean;
    }) => Promise<{
      saved: boolean;
      canceled: boolean;
      opened: boolean;
      openError?: string | null;
      filePath?: string;
    }>;
    getNotificationSupport: () => Promise<{ supported: boolean }>;
    showNotification: (input: {
      title: string;
      body: string;
      tag?: string;
      href?: string;
    }) => Promise<{ supported: boolean; shown: boolean }>;
    dismissNotification: (tag: string) => Promise<{ dismissed: boolean }>;
    saveTaskCalendar: (input: {
      status: "open" | "completed" | "all";
      suggestedName: string;
      openAfterSave: boolean;
    }) => Promise<{
      saved: boolean;
      canceled: boolean;
      opened: boolean;
      openError?: string | null;
      filePath?: string;
    }>;
  };
}
