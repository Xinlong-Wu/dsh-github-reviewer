/** Locale dictionaries for the GitHub reviewer Plugins-page catalog tab. */

export type GithubReviewerLocaleKey = keyof typeof en

export const en = {
  title: 'GitHub Reviewer',
  intro: 'Monitored repositories and review runtime state for the configured reviewer instance. Edit its configuration on the instance row of the installed plugin.',
  repositories: 'Monitored repositories',
  repositoriesEmpty: 'No repositories are monitored.',
  repositoryCatalogLoading: 'Loading accessible repositories…',
  repositoryCatalogLoadFailed: 'Could not load accessible repositories.',
  refreshRepositoryCatalog: 'Refresh catalog',
  catalogUnavailable: 'Catalog unavailable',
  privateRepository: 'Private',
} as const

export const zh: Record<GithubReviewerLocaleKey, string> = {
  title: 'GitHub Reviewer',
  intro: '已配置评审实例的监控仓库与运行状态；实例配置请在已安装插件的实例行中编辑。',
  repositories: '监控中的仓库',
  repositoriesEmpty: '当前没有监控任何仓库。',
  repositoryCatalogLoading: '正在加载有权访问的仓库…',
  repositoryCatalogLoadFailed: '无法加载仓库目录。',
  refreshRepositoryCatalog: '刷新目录',
  catalogUnavailable: '目录不可用',
  privateRepository: '私有',
} as const
