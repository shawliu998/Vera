const zhCN = {
  common: {
    appName: "Vera",
    actions: {
      back: "返回",
      cancel: "取消",
      close: "关闭",
      confirm: "确认",
      copy: "复制",
      create: "新建",
      delete: "删除",
      done: "完成",
      download: "下载",
      edit: "编辑",
      move: "移动",
      open: "打开",
      refresh: "刷新",
      rename: "重命名",
      retry: "重试",
      save: "保存",
      search: "搜索",
      upload: "上传",
    },
    status: {
      empty: "暂无内容",
      failed: "失败",
      loading: "正在加载…",
      processing: "正在处理…",
      ready: "就绪",
      saved: "已保存",
      saving: "正在保存…",
    },
    fields: {
      createdAt: "创建时间",
      name: "名称",
      updatedAt: "更新时间",
    },
  },
  nav: {
    projects: "项目",
    assistant: "助手",
    workflows: "工作流",
    tabular: "表格",
    settings: "设置",
  },
  projects: {
    title: "项目",
    subtitle: "创建项目，并在本地组织项目文档及其版本。",
    all: "全部项目",
    recent: "最近项目",
    create: "新建项目",
    open: "打开项目",
    nameLabel: "项目名称",
    namePlaceholder: "输入项目名称",
    descriptionLabel: "项目说明",
    descriptionPlaceholder: "说明项目目标或背景（可选）",
    empty: {
      title: "还没有项目",
      body: "新建一个项目，在本地集中管理相关文档。",
      action: "新建第一个项目",
    },
    errors: {
      load: "无法加载项目。请重试。",
      create: "无法新建项目。请检查名称后重试。",
      update: "无法更新项目。请重试。",
      delete: "无法删除项目。项目内容尚未更改。",
    },
    deleteConfirm: {
      title: "删除项目？",
      body: "项目、其中的文档及关联本地数据将从本地工作区中永久删除。此操作无法撤销。",
      namePrompt: "输入“{name}”以确认删除。",
      action: "永久删除项目",
    },
  },
  documents: {
    title: "文档",
    subtitle: "集中管理项目资料及其版本。",
    upload: "上传文档",
    addToProject: "添加到项目",
    newVersion: "上传新版本",
    preview: "预览文档",
    downloadOriginal: "下载原文件",
    moveToFolder: "移动到文件夹",
    removeFromProject: "从项目移除",
    version: "版本 {version}",
    empty: {
      title: "还没有文档",
      body: "上传资料并在本地管理版本；助手、工作流和表格能力将在后续版本启用。",
      action: "上传第一个文档",
    },
    errors: {
      load: "无法加载文档。请重试。",
      upload: "文档上传失败。原文件未被修改。",
      download: "无法准备下载。请重试。",
      move: "无法移动文档。请重试。",
      delete: "无法删除文档。请重试。",
      unsupported: "暂不支持这种文档格式。",
    },
    deleteConfirm: {
      title: "删除文档？",
      body: "“{name}”的全部版本将从本地工作区中永久删除。此操作无法撤销。",
      action: "永久删除文档",
    },
  },
  assistant: {
    title: "助手",
    subtitle: "助手能力正在规划，将在后续版本启用。",
    newChat: "后续启用",
    projectScope: "项目范围",
    globalScope: "独立对话",
    placeholder: "助手能力将在后续版本启用",
    send: "尚未启用",
    stop: "尚未启用",
    sources: "引用来源",
    empty: {
      title: "助手能力后续启用",
      body: "项目与文档现已可用；基于资料的对话将在后续版本开放。",
    },
    errors: {
      load: "助手能力尚未启用。",
      send: "助手能力尚未启用。",
      stream: "助手能力尚未启用。",
    },
  },
  workflows: {
    title: "工作流",
    subtitle: "工作流能力正在规划，将在后续版本启用。",
    create: "后续启用",
    run: "尚未启用",
    runAgain: "尚未启用",
    steps: "步骤",
    history: "运行记录",
    builtin: "内置工作流",
    projectOptional: "项目（可选）",
    empty: {
      title: "工作流能力后续启用",
      body: "工作流配置与运行将在后续版本开放。",
      action: "后续启用",
    },
    errors: {
      load: "工作流能力尚未启用。",
      save: "工作流能力尚未启用。",
      run: "工作流能力尚未启用。",
      retry: "工作流能力尚未启用。",
    },
    deleteConfirm: {
      title: "工作流能力尚未启用",
      body: "工作流配置与管理将在后续版本开放。",
      action: "尚未启用",
    },
  },
  tabular: {
    title: "表格",
    subtitle: "表格审阅能力正在规划，将在后续版本启用。",
    create: "后续启用",
    addDocuments: "添加文档",
    addColumn: "添加列",
    runColumn: "尚未启用",
    runCell: "尚未启用",
    retryCell: "尚未启用",
    export: "尚未启用",
    source: "来源",
    empty: {
      title: "表格审阅能力后续启用",
      body: "批量提取、审阅与导出将在后续版本开放。",
      action: "后续启用",
    },
    errors: {
      load: "表格审阅能力尚未启用。",
      save: "表格审阅能力尚未启用。",
      run: "表格审阅能力尚未启用。",
      export: "表格审阅能力尚未启用。",
    },
    deleteConfirm: {
      title: "表格审阅能力尚未启用",
      body: "表格审阅配置与管理将在后续版本开放。",
      action: "尚未启用",
    },
  },
  settings: {
    title: "设置",
    subtitle: "管理界面语言和本地工作区；模型配置将在后续版本启用。",
    language: {
      title: "语言",
      description: "选择 Vera 的界面语言。",
      zhCN: "简体中文",
      enUS: "English (United States)",
    },
    models: {
      title: "模型",
      description: "模型配置将随助手、工作流和表格能力在后续版本启用。",
      add: "添加模型",
      default: "默认模型",
      local: "本地模型",
      remote: "远程模型",
      noModels: "还没有可用模型。",
    },
    appearance: {
      title: "外观",
      theme: "主题",
      light: "浅色",
      dark: "深色",
      system: "跟随系统",
    },
    errors: {
      load: "无法加载设置。请重试。",
      save: "无法保存设置。之前的设置仍然有效。",
    },
  },
  workspace: {
    title: "本地工作区",
    description: "项目资料保存在此设备上的 Vera 数据目录中。",
    localOnly: "仅本机",
    dataLocation: "数据位置",
    database: "工作区数据库",
    blobStorage: "文档存储",
    availableSpace: "可用空间",
    offlineReady: "可离线使用",
    offlineDescription: "项目和文档资料保存在此设备上；远程模型能力当前未启用。",
    openDataFolder: "打开数据文件夹",
    integrityCheck: "检查工作区完整性",
    integrityHealthy: "工作区完整性检查通过。",
    errors: {
      unavailable: "本地工作区暂不可用。请重新启动 Vera。",
      integrity: "工作区完整性检查未通过。请先保留现有数据并查看诊断信息。",
      storage: "本地存储空间不足。请释放空间后重试。",
    },
    resetConfirm: {
      title: "清除本地工作区？",
      body: "所有项目、文档及关联本地数据都将从此设备永久删除。此操作无法撤销。",
      phrasePrompt: "输入“{phrase}”以确认清除。",
      action: "永久清除本地数据",
    },
  },
  errors: {
    validation: "提交的内容不完整或格式不正确。请检查后重试。",
    notFound: "请求的内容不存在或已被删除。",
    conflict: "内容已发生变化。请刷新后重试。",
    precondition: "当前状态不允许执行此操作。请刷新后重试。",
    unauthorized: "本地会话已失效。请重新启动 Vera。",
    forbidden: "当前会话无权执行此操作。",
    rateLimited: "操作过于频繁。请稍后重试。",
    jobFailed: "后台任务未能完成。请查看任务状态后重试。",
    internal: "Vera 未能完成此操作。你的本地数据不会因此被自动删除。",
    invalidResponse: "Vera 收到了无法识别的本地服务响应。请重试。",
    localControl: "无法连接本地服务。请重新启动 Vera。",
    modelUnavailable: "模型相关能力尚未启用。",
    remoteDisabled: "当前版本未启用远程模型。",
    unsupported: "当前版本暂不支持此操作。",
    network: "连接失败。请检查本地服务或网络后重试。",
    unknown: "操作未能完成。请重试；如果问题持续，请查看诊断信息。",
  },
} as const;

type DictionaryShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : DictionaryShape<T[Key]>;
};

const enUS = {
  common: {
    appName: "Vera",
    actions: {
      back: "Back",
      cancel: "Cancel",
      close: "Close",
      confirm: "Confirm",
      copy: "Copy",
      create: "Create",
      delete: "Delete",
      done: "Done",
      download: "Download",
      edit: "Edit",
      move: "Move",
      open: "Open",
      refresh: "Refresh",
      rename: "Rename",
      retry: "Retry",
      save: "Save",
      search: "Search",
      upload: "Upload",
    },
    status: {
      empty: "No content",
      failed: "Failed",
      loading: "Loading…",
      processing: "Processing…",
      ready: "Ready",
      saved: "Saved",
      saving: "Saving…",
    },
    fields: {
      createdAt: "Created",
      name: "Name",
      updatedAt: "Updated",
    },
  },
  nav: {
    projects: "Projects",
    assistant: "Assistant",
    workflows: "Workflows",
    tabular: "Tabular",
    settings: "Settings",
  },
  projects: {
    title: "Projects",
    subtitle: "Create projects and organize project documents and versions locally.",
    all: "All projects",
    recent: "Recent projects",
    create: "New project",
    open: "Open project",
    nameLabel: "Project name",
    namePlaceholder: "Enter a project name",
    descriptionLabel: "Project description",
    descriptionPlaceholder: "Describe the objective or context (optional)",
    empty: {
      title: "No projects yet",
      body: "Create a project to manage related documents locally.",
      action: "Create your first project",
    },
    errors: {
      load: "Projects could not be loaded. Try again.",
      create: "The project could not be created. Check the name and try again.",
      update: "The project could not be updated. Try again.",
      delete: "The project could not be deleted. Its contents were not changed.",
    },
    deleteConfirm: {
      title: "Delete project?",
      body: "The project, its documents, and associated local data will be permanently removed from the local workspace. This cannot be undone.",
      namePrompt: "Type “{name}” to confirm deletion.",
      action: "Delete project permanently",
    },
  },
  documents: {
    title: "Documents",
    subtitle: "Manage project materials and their versions in one place.",
    upload: "Upload document",
    addToProject: "Add to project",
    newVersion: "Upload new version",
    preview: "Preview document",
    downloadOriginal: "Download original",
    moveToFolder: "Move to folder",
    removeFromProject: "Remove from project",
    version: "Version {version}",
    empty: {
      title: "No documents yet",
      body: "Upload materials and manage their versions locally. Assistant, Workflows, and Tabular will be enabled in a later release.",
      action: "Upload your first document",
    },
    errors: {
      load: "Documents could not be loaded. Try again.",
      upload: "The document could not be uploaded. The original file was not changed.",
      download: "The download could not be prepared. Try again.",
      move: "The document could not be moved. Try again.",
      delete: "The document could not be deleted. Try again.",
      unsupported: "This document format is not supported yet.",
    },
    deleteConfirm: {
      title: "Delete document?",
      body: "All versions of “{name}” will be permanently removed from the local workspace. This cannot be undone.",
      action: "Delete document permanently",
    },
  },
  assistant: {
    title: "Assistant",
    subtitle: "Assistant is planned and will be enabled in a later release.",
    newChat: "Available later",
    projectScope: "Project scope",
    globalScope: "Standalone conversation",
    placeholder: "Assistant will be enabled in a later release",
    send: "Not enabled",
    stop: "Not enabled",
    sources: "Sources",
    empty: {
      title: "Assistant will be enabled later",
      body: "Projects and Documents are available now. Document-grounded conversations will be enabled in a later release.",
    },
    errors: {
      load: "Assistant is not enabled yet.",
      send: "Assistant is not enabled yet.",
      stream: "Assistant is not enabled yet.",
    },
  },
  workflows: {
    title: "Workflows",
    subtitle: "Workflows are planned and will be enabled in a later release.",
    create: "Available later",
    run: "Not enabled",
    runAgain: "Not enabled",
    steps: "Steps",
    history: "Run history",
    builtin: "Built-in workflow",
    projectOptional: "Project (optional)",
    empty: {
      title: "Workflows will be enabled later",
      body: "Workflow configuration and execution will be available in a later release.",
      action: "Available later",
    },
    errors: {
      load: "Workflows are not enabled yet.",
      save: "Workflows are not enabled yet.",
      run: "Workflows are not enabled yet.",
      retry: "Workflows are not enabled yet.",
    },
    deleteConfirm: {
      title: "Workflows are not enabled yet",
      body: "Workflow configuration and management will be available in a later release.",
      action: "Not enabled",
    },
  },
  tabular: {
    title: "Tabular",
    subtitle: "Tabular review is planned and will be enabled in a later release.",
    create: "Available later",
    addDocuments: "Add documents",
    addColumn: "Add column",
    runColumn: "Not enabled",
    runCell: "Not enabled",
    retryCell: "Not enabled",
    export: "Not enabled",
    source: "Source",
    empty: {
      title: "Tabular review will be enabled later",
      body: "Batch extraction, review, and export will be available in a later release.",
      action: "Available later",
    },
    errors: {
      load: "Tabular review is not enabled yet.",
      save: "Tabular review is not enabled yet.",
      run: "Tabular review is not enabled yet.",
      export: "Tabular review is not enabled yet.",
    },
    deleteConfirm: {
      title: "Tabular review is not enabled yet",
      body: "Tabular review configuration and management will be available in a later release.",
      action: "Not enabled",
    },
  },
  settings: {
    title: "Settings",
    subtitle: "Manage interface language and the local workspace. Model configuration will be enabled in a later release.",
    language: {
      title: "Language",
      description: "Choose Vera's interface language.",
      zhCN: "简体中文",
      enUS: "English (United States)",
    },
    models: {
      title: "Models",
      description: "Model configuration will be enabled with Assistant, Workflows, and Tabular in a later release.",
      add: "Add model",
      default: "Default model",
      local: "Local model",
      remote: "Remote model",
      noModels: "No models are available yet.",
    },
    appearance: {
      title: "Appearance",
      theme: "Theme",
      light: "Light",
      dark: "Dark",
      system: "System",
    },
    errors: {
      load: "Settings could not be loaded. Try again.",
      save: "Settings could not be saved. Your previous settings are still active.",
    },
  },
  workspace: {
    title: "Local workspace",
    description: "Project materials are stored in Vera's data directory on this device.",
    localOnly: "On this device",
    dataLocation: "Data location",
    database: "Workspace database",
    blobStorage: "Document storage",
    availableSpace: "Available space",
    offlineReady: "Available offline",
    offlineDescription: "Project and document materials stay on this device. Remote model capability is not enabled yet.",
    openDataFolder: "Open data folder",
    integrityCheck: "Check workspace integrity",
    integrityHealthy: "The workspace integrity check passed.",
    errors: {
      unavailable: "The local workspace is unavailable. Restart Vera.",
      integrity: "The workspace integrity check did not pass. Preserve the current data before reviewing diagnostics.",
      storage: "There is not enough local storage. Free some space and try again.",
    },
    resetConfirm: {
      title: "Clear local workspace?",
      body: "All projects, documents, and associated local data will be permanently removed from this device. This cannot be undone.",
      phrasePrompt: "Type “{phrase}” to confirm clearing the workspace.",
      action: "Delete local data permanently",
    },
  },
  errors: {
    validation: "Some information is missing or invalid. Check it and try again.",
    notFound: "The requested content does not exist or has been deleted.",
    conflict: "This content has changed. Refresh and try again.",
    precondition: "This action is not available in the current state. Refresh and try again.",
    unauthorized: "The local session has expired. Restart Vera.",
    forbidden: "The current session is not allowed to perform this action.",
    rateLimited: "There have been too many requests. Try again shortly.",
    jobFailed: "The background task could not finish. Review its status and try again.",
    internal: "Vera could not complete this action. Your local data will not be deleted automatically.",
    invalidResponse: "Vera received an unrecognized response from the local service. Try again.",
    localControl: "The local service could not be reached. Restart Vera.",
    modelUnavailable: "Model-related capabilities are not enabled yet.",
    remoteDisabled: "Remote models are not enabled in this version.",
    unsupported: "This action is not supported in the current version.",
    network: "The connection failed. Check the local service or network and try again.",
    unknown: "The action could not be completed. Try again; if the problem continues, review diagnostics.",
  },
} as const satisfies DictionaryShape<typeof zhCN>;

export const MESSAGES = {
  "zh-CN": zhCN,
  "en-US": enUS,
} as const;

export type MessageDictionary = DictionaryShape<typeof zhCN>;

type DotPaths<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : T[Key] extends Record<string, unknown>
      ? `${Key}.${DotPaths<T[Key]>}`
      : never;
}[keyof T & string];

export type MessageKey = DotPaths<typeof zhCN>;
export type TranslationValue = string | number;
export type TranslationValues = Readonly<Record<string, TranslationValue>>;
export type Translate = (key: MessageKey, values?: TranslationValues) => string;

function readMessage(dictionary: MessageDictionary, key: MessageKey): string {
  let value: unknown = dictionary;
  for (const segment of key.split(".")) {
    value = (value as Record<string, unknown>)[segment];
  }
  return value as string;
}

export function translateMessage(
  locale: keyof typeof MESSAGES,
  key: MessageKey,
  values?: TranslationValues,
): string {
  const template = readMessage(MESSAGES[locale], key);
  if (!values) return template;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name: string) => {
    const value = values[name];
    return value === undefined ? token : String(value);
  });
}
