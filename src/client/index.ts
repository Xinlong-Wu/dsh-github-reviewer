/** Browser registration for the GitHub reviewer Plugins-page catalog tab. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import githubReviewerRemote from 'dsh-github-reviewer/remote'
import { GithubReviewerCatalogTab } from './GithubReviewerCard.tsx'
import { GithubReviewerRowConfigPage } from './RowConfigPage.tsx'
import { en, zh } from './locales.ts'

const LOCALE_NAMESPACE = 'settings.githubReviewer'

const styles = `
.ghr-tab{display:grid;gap:14px;max-width:720px}
.ghr-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55}
.ghr-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ghr-heading{font:inherit;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.ghr-refresh{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}
.ghr-refresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ghr-refresh:disabled{opacity:.5;cursor:not-allowed}
.ghr-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ghr-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.ghr-repos{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ghr-repo{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-3)}
.ghr-repo-name{font-size:13px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.ghr-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}
`

/** Required browser services; an incomplete Web composition leaves only this Client companion pending. */
export const inject = ['slots', 'locale', 'remote']

/** Register the Remote contribution, locale, styles, and the Plugins-page catalog tab. */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(githubReviewerRemote)
  ctx.effect(() => disposeRemote, 'github-reviewer repository catalog Remote')

  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'github-reviewer locale')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-github-reviewer'
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'github-reviewer styles')

  const t = ctx.locale.bind(LOCALE_NAMESPACE)

  // The catalog tab reads the mounted githubReviewerCatalog namespace. The
  // dotted path must NOT go into the static inject list: this same apply()
  // mounts the namespace, so a static requirement would wait on a service
  // that cannot exist yet (the plugin parks PENDING forever). The late
  // companion binding below is the cordis pattern for self-mounted services.
  ctx.inject(['remote.githubReviewerCatalog'], (remoteCtx) => {
    const loadCatalog: Parameters<typeof GithubReviewerCatalogTab>[0]['loadCatalog'] = async (signal) => {
      const result = await remoteCtx.remote.githubReviewerCatalog.repositories(signal)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    const injected = { loadCatalog }

    ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'github-reviewer',
      order: 30,
      label: () => t('title'),
      locale: LOCALE_NAMESPACE,
      inject: () => injected,
    }, GithubReviewerCatalogTab))

    // The installed-plugin row's configuration page: the manager renders this
    // keyed contribution with the entry's ConfigPageForm (from the volatile
    // Config projection). The key must match the bundle patch's row id.
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: 'dsh-github-reviewer#github-reviewer',
      locale: LOCALE_NAMESPACE,
      inject: () => ({}),
    }, GithubReviewerRowConfigPage))
  })
}
