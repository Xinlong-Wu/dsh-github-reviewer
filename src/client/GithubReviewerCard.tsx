/** Read-only repository catalog plus the entry's editable config form, contributed to the Plugins settings page. */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconRefreshOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RepositoryCatalog } from '../repository-catalog-contract.ts'
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
      {props.configForm === undefined
        ? null
        : <GithubReviewerConfigFormSection form={props.configForm} t={props.t} />}
    </div>
  )
}

type ConfigValues = {
  pollIntervalMs?: number
  repositories?: string[]
  workspaceDir?: string
  workspaceTitle?: string
  review?: {
    maxToolCalls?: number
    toolTimeoutMs?: number
    toolResultLimit?: number
    timeoutMs?: number
    defaultInstructions?: string
    commandAuthorAssociations?: string[]
  }
}

interface Draft {
  pollIntervalMs: string
  repositories: string
  workspaceDir: string
  workspaceTitle: string
  maxToolCalls: string
  toolTimeoutMs: string
  toolResultLimit: string
  timeoutMs: string
  defaultInstructions: string
  commandAuthorAssociations: string
}

function draftOf(value: ConfigValues | undefined): Draft {
  const review = value?.review ?? {}
  const numberOf = (raw: number | undefined, fallback: number): string => String(raw ?? fallback)
  const textOf = (raw: string | undefined, fallback = ''): string => raw ?? fallback
  const repositories = Array.isArray(value?.repositories)
    ? value.repositories.filter((item): item is string => typeof item === 'string').join('\n')
    : ''
  const associations = Array.isArray(review.commandAuthorAssociations)
    ? review.commandAuthorAssociations.filter((item): item is string => typeof item === 'string').join(', ')
    : ''
  return {
    pollIntervalMs: numberOf(value?.pollIntervalMs, 120_000),
    repositories,
    workspaceDir: textOf(value?.workspaceDir),
    workspaceTitle: textOf(value?.workspaceTitle, 'GithubReviewer'),
    maxToolCalls: numberOf(review.maxToolCalls, 30),
    toolTimeoutMs: numberOf(review.toolTimeoutMs, 30_000),
    toolResultLimit: numberOf(review.toolResultLimit, 60_000),
    timeoutMs: numberOf(review.timeoutMs, 900_000),
    defaultInstructions: textOf(review.defaultInstructions),
    commandAuthorAssociations: associations,
  }
}

/** The entry's editable volatile fields, saved through the fenced config form. */
function GithubReviewerConfigFormSection(props: {
  form: ConfigForm<Record<string, unknown>>
  t(key: GithubReviewerLocaleKey): string
}) {
  const snapshot: ConfigFormSnapshot<Record<string, unknown>> = useSyncExternalStore(
    props.form.subscribe.bind(props.form),
    props.form.getSnapshot.bind(props.form),
  )
  const [draft, setDraft] = useState(() => draftOf(snapshot.value as ConfigValues | undefined))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  // Re-materialize the draft when the Host publishes a new revision (e.g. the
  // patch changing elsewhere), not on every snapshot identity churn.
  const [lastRevision, setLastRevision] = useState(snapshot.revision)
  if (snapshot.revision !== lastRevision) {
    setLastRevision(snapshot.revision)
    setDraft(draftOf(snapshot.value as ConfigValues | undefined))
    setState('idle')
  }

  const writable = snapshot.writable && snapshot.status === 'ready' && state !== 'saving'
  const edit = (key: keyof Draft, text: string): void => { setDraft(current => ({ ...current, [key]: text })) }

  const save = async (): Promise<void> => {
    setState('saving')
    const repositories = draft.repositories.split('\n').map(line => line.trim()).filter(line => line !== '')
    const ok = await props.form.mutate([
      { op: 'set', path: ['pollIntervalMs'], value: Number(draft.pollIntervalMs) },
      { op: 'set', path: ['repositories'], value: repositories },
      { op: 'set', path: ['workspaceDir'], value: draft.workspaceDir.trim() },
      { op: 'set', path: ['workspaceTitle'], value: draft.workspaceTitle.trim() },
      { op: 'set', path: ['review'], value: {
        maxToolCalls: Number(draft.maxToolCalls),
        toolTimeoutMs: Number(draft.toolTimeoutMs),
        toolResultLimit: Number(draft.toolResultLimit),
        timeoutMs: Number(draft.timeoutMs),
        defaultInstructions: draft.defaultInstructions,
        commandAuthorAssociations: draft.commandAuthorAssociations.split(',').map(v => v.trim()).filter(v => v !== ''),
      } },
    ], snapshot.revision)
    setState(ok ? 'saved' : 'failed')
  }

  const numberField = (key: keyof Draft, label: GithubReviewerLocaleKey): ReactNode => (
    <label className="ghr-field">
      <span>{props.t(label)}</span>
      <input type="number" value={draft[key]} disabled={!writable}
        onChange={event => edit(key, event.target.value)} />
    </label>
  )
  const textField = (key: keyof Draft, label: GithubReviewerLocaleKey): ReactNode => (
    <label className="ghr-field">
      <span>{props.t(label)}</span>
      <input value={draft[key]} disabled={!writable} onChange={event => edit(key, event.target.value)} />
    </label>
  )

  return (
    <div className="ghr-config">
      <h3 className="ghr-heading">{props.t('configSection')}</h3>
      <p className="ghr-hint">{props.t('configFormHint')}</p>
      {numberField('pollIntervalMs', 'pollIntervalMs')}
      <label className="ghr-field">
        <span>{props.t('repositories')}</span>
        <textarea rows={4} value={draft.repositories} disabled={!writable}
          onChange={event => edit('repositories', event.target.value)} />
      </label>
      <div className="ghr-grid">
        {textField('workspaceDir', 'workspaceDir')}
        {textField('workspaceTitle', 'workspaceTitle')}
      </div>
      <div className="ghr-grid">
        {numberField('maxToolCalls', 'maxToolCalls')}
        {numberField('toolTimeoutMs', 'toolTimeoutMs')}
        {numberField('toolResultLimit', 'toolResultLimit')}
        {numberField('timeoutMs', 'timeoutMs')}
      </div>
      <label className="ghr-field">
        <span>{props.t('defaultInstructions')}</span>
        <textarea rows={3} value={draft.defaultInstructions} disabled={!writable}
          onChange={event => edit('defaultInstructions', event.target.value)} />
      </label>
      <label className="ghr-field">
        <span>{props.t('commandAuthorAssociations')}</span>
        <input value={draft.commandAuthorAssociations} disabled={!writable}
          onChange={event => edit('commandAuthorAssociations', event.target.value)} />
      </label>
      <div className="ghr-actions">
        {state === 'saved' ? <span className="ghr-note">{props.t('savedHint')}</span> : null}
        {state === 'failed' ? <span className="ghr-error">{props.t('saveFailed')}</span> : null}
        <button type="button" className="ghr-refresh" disabled={!writable} onClick={() => { void save() }}>
          {state === 'saving' ? props.t('saving') : props.t('save')}
        </button>
      </div>
    </div>
  )
}
