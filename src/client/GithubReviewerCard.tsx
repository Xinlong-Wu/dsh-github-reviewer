/** Read-only repository catalog plus the entry's editable config form, contributed to the Plugins settings page. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryCatalog } from '../repository-catalog-contract.ts'
import { GithubReviewerConfigFormSection } from './ConfigFormSection.tsx'
import type { GithubReviewerLocaleKey } from './locales.ts'

/**
 * Registration-side face the browser entry supplies: one typed Host call that
 * resolves the configured credential's accessible repositories, and the live
 * config form of the profile entry this tab edits.
 */
export interface GithubReviewerCatalogTabInjected {
  /** Load the accessible repository catalog; throws on Host rejection. */
  loadCatalog: (signal: AbortSignal) => Promise<RepositoryCatalog>
  /** The profile entry's config form (volatile fields); undefined when the composition lacks the mirror. */
  configForm?: ConfigForm<Record<string, unknown>> | undefined
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

/** Snapshot shown when the composition lacks the config form mirror. */
const EMPTY_SNAPSHOT: ConfigFormSnapshot<Record<string, unknown>> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
}

type CatalogState =
  | { phase: 'loading' }
  | { phase: 'ready'; catalog: RepositoryCatalog }
  | { phase: 'error'; message: string }

/** Render the accessible-repository catalog with one refresh control. */
export function GithubReviewerCatalogTab(props: GithubReviewerCatalogTabProps) {
  const loadCatalog = props.loadCatalog
  const configForm = props.configForm
  const [state, setState] = useState<CatalogState>({ phase: 'loading' })
  const [reloading, setReloading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  // The entry's config form is a store: subscribe here so the editable
  // section re-renders on every Host revision.
  const getSnapshot = (): ConfigFormSnapshot<Record<string, unknown>> =>
    configForm === undefined ? EMPTY_SNAPSHOT : configForm.getSnapshot()
  const subscribe = (listener: () => void): (() => void) =>
    configForm === undefined ? () => {} : configForm.subscribe(listener)
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

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
  const configSection = configForm === undefined ? null : (
    <>
      <h3 className="ghr-heading">{props.t('configSection')}</h3>
      <GithubReviewerConfigFormSection
        snapshot={snapshot}
        mutate={configForm.mutate.bind(configForm)}
        t={props.t}
      />
    </>
  )

  return (
    <div className="ghr-tab">
      <p className="ghr-intro">{props.t('intro')}</p>
      <div className="ghr-toolbar">
        <h3 className="ghr-heading">{props.t('repositoryCatalog')}</h3>
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
        ? <p className="ghr-note">{props.t('repositoryCatalogEmpty')}</p>
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
      {configSection}
    </div>
  )
}
