/** Read-only repository catalog tab contributed to the Plugins settings page. */

import { useEffect, useState } from 'react'
import { IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryCatalog } from '../repository-catalog-contract.ts'
import type { GithubReviewerLocaleKey } from './locales.ts'

/**
 * Registration-side face the browser entry supplies: one typed Host call that
 * resolves the configured credential's accessible repositories.
 */
export interface GithubReviewerCatalogTabInjected {
  /** Load the accessible repository catalog; throws on Host rejection. */
  loadCatalog: (signal: AbortSignal) => Promise<RepositoryCatalog>
}

export type GithubReviewerCatalogTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.githubReviewer'>
  & InjectFace<GithubReviewerCatalogTabInjected>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.githubReviewer': GithubReviewerLocaleKey
  }
}

type CatalogState =
  | { phase: 'loading' }
  | { phase: 'ready'; catalog: RepositoryCatalog }
  | { phase: 'error'; message: string }

/** Render the monitored-repository catalog with one refresh control. */
export function GithubReviewerCatalogTab(props: GithubReviewerCatalogTabProps) {
  const loadCatalog = props.loadCatalog
  const [state, setState] = useState<CatalogState>({ phase: 'loading' })
  const [reloading, setReloading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const load = (signal: AbortSignal): void => {
    setReloading(true)
    loadCatalog(signal)
      .then(catalog => { setState({ phase: 'ready', catalog }) })
      .catch((error: unknown) => { setState({ phase: 'error', message: String(error) }) })
      .finally(() => { setReloading(false) })
  }

  useEffect(() => {
    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => { setReloading(false) }, { once: true })
    load(controller.signal)
    return () => { controller.abort() }
    // loadCatalog is a stable injected face; reloadToken models manual refresh.
  }, [loadCatalog, reloadToken])

  const rows = state.phase === 'ready' ? state.catalog.repositories : []

  return (
    <div className="ghr-tab">
      <p className="ghr-intro">{props.t('intro')}</p>
      <div className="ghr-toolbar">
        <h3 className="ghr-heading">{props.t('repositories')}</h3>
        <button
          type="button"
          className="ghr-refresh"
          disabled={reloading}
          onClick={() => { setReloadToken(token => token + 1) }}
        >
          <IconRefreshOutlineMedium />
          <span>{props.t('refreshRepositoryCatalog')}</span>
        </button>
      </div>
      {reloading
        ? <p className="ghr-note">{props.t('repositoryCatalogLoading')}</p>
        : null}
      {state.phase === 'error'
        ? <p className="ghr-error">{props.t('repositoryCatalogLoadFailed')} <code>{state.message}</code></p>
        : null}
      {state.phase === 'ready' && !reloading && rows.length === 0
        ? <p className="ghr-note">{props.t('repositoriesEmpty')}</p>
        : null}
      {rows.length > 0
        ? (
            <ul className="ghr-repos">
              {rows.map(repository => (
                <li className="ghr-repo" key={repository.fullName}>
                  <span className="ghr-repo-name">{repository.fullName}</span>
                  {repository.private
                    ? <span className="ghr-badge">{props.t('privateRepository')}</span>
                    : null}
                </li>
              ))}
            </ul>
          )
        : null}
    </div>
  )
}
