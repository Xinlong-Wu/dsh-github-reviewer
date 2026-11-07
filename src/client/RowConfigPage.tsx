/** Editable configuration page for the github-reviewer bundle row. */

import { useSyncExternalStore, useState, type ReactNode } from 'react'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'plugins.row.config' SlotMap merge (view + form props).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GithubReviewerLocaleKey } from './locales.ts'

/** Host-owned form the manager page passes into the slot render args. */
interface RowConfigPageForm {
  readonly state: {
    getSnapshot(): ConfigFormSnapshot<Record<string, unknown>>
    subscribe(listener: () => void): () => void
  }
  mutate(
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    expectedRevision?: number,
  ): Promise<boolean>
}

/** No injected face: the manager passes `view` and `form` as render args. */
export interface GithubReviewerRowConfigInjected {}

export type GithubReviewerRowConfigProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'settings.githubReviewer'>
  & InjectFace<GithubReviewerRowConfigInjected>
  & {
    /** Render args from the manager page. */
    readonly view?: 'summary' | 'page' | undefined
    /** Host-owned configuration values and write actions for this row. */
    readonly form?: RowConfigPageForm | undefined
  }

type Snapshot = NonNullable<ConfigFormSnapshot<Record<string, unknown>>>

function text(value: Record<string, unknown> | undefined, key: string): string {
  const raw = value?.[key]
  return typeof raw === 'string' ? raw : ''
}

function numberOf(value: Record<string, unknown> | undefined, key: string): number {
  const raw = value?.[key]
  return typeof raw === 'number' ? raw : Number.NaN
}

/** Snapshot shown when the manager page renders the slot without a form. */
const EMPTY_SNAPSHOT: ConfigFormSnapshot<Record<string, unknown>> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
}

const fallbackGet = (): ConfigFormSnapshot<Record<string, unknown>> => EMPTY_SNAPSHOT
const fallbackSubscribe = (): (() => void) => () => {}

/** Render the summary one-liner or the editable page for the bundle row. */
export function GithubReviewerRowConfigPage(props: GithubReviewerRowConfigProps) {
  const form = props.form
  const snapshot = useSyncExternalStore<ConfigFormSnapshot<Record<string, unknown>>>(
    form === undefined ? fallbackSubscribe : form.state.subscribe.bind(form.state),
    form === undefined ? fallbackGet : form.state.getSnapshot.bind(form.state),
  )

  if (props.view === 'summary') {
    const count = snapshot?.value === undefined ? undefined
      : Array.isArray(snapshot.value.repositories) ? snapshot.value.repositories.length : undefined
    return <>{count === undefined ? '' : props.t('repositoriesSummary').replace('%1', String(count))}</>
  }

  if (form === undefined || snapshot === undefined || snapshot.status !== 'ready' || snapshot.value === undefined) {
    return <p className="ghr-note">{props.t('unavailable')}</p>
  }

  return <GithubReviewerRowConfigForm form={form} snapshot={snapshot} t={props.t} />
}

function GithubReviewerRowConfigForm(props: {
  form: RowConfigPageForm
  snapshot: ConfigFormSnapshot<Record<string, unknown>>
  t(key: GithubReviewerLocaleKey): string
}) {
  const value = props.snapshot.value ?? {}
  const [draft, setDraft] = useState(() => draftOf(value))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const writable = props.snapshot.writable && state !== 'saving'

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
    ], props.snapshot.revision)
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
    <div className="ghr-tab">
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

function draftOf(value: Record<string, unknown>): Draft {
  const review = (value.review ?? {}) as Record<string, unknown>
  const numberOf = (key: string, fallback: number): string => {
    const raw = value[key]
    return typeof raw === 'number' ? String(raw) : String(fallback)
  }
  const textOf = (key: string, fallback = ''): string => {
    const raw = value[key]
    return typeof raw === 'string' ? raw : fallback
  }
  const repositories = Array.isArray(value.repositories)
    ? value.repositories.filter((item): item is string => typeof item === 'string').join('\n')
    : ''
  const associations = Array.isArray(review.commandAuthorAssociations)
    ? review.commandAuthorAssociations.filter((item): item is string => typeof item === 'string').join(', ')
    : ''
  return {
    pollIntervalMs: numberOf('pollIntervalMs', 120_000),
    repositories,
    workspaceDir: textOf('workspaceDir'),
    workspaceTitle: textOf('workspaceTitle', 'GithubReviewer'),
    maxToolCalls: typeof review.maxToolCalls === 'number' ? String(review.maxToolCalls) : '30',
    toolTimeoutMs: typeof review.toolTimeoutMs === 'number' ? String(review.toolTimeoutMs) : '30000',
    toolResultLimit: typeof review.toolResultLimit === 'number' ? String(review.toolResultLimit) : '60000',
    timeoutMs: typeof review.timeoutMs === 'number' ? String(review.timeoutMs) : '900000',
    defaultInstructions: textOf('defaultInstructions'),
    commandAuthorAssociations: associations,
  }
}
