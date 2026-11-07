/** Editable volatile config fields shared by the tab and the row config page. */

import { useEffect, useState, type ReactNode } from 'react'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { GithubReviewerLocaleKey } from './locales.ts'

/** Host-owned form: schema-resolved values plus revision-fenced writes. */
export interface GithubReviewerConfigSectionProps {
  readonly snapshot: ConfigFormSnapshot<Record<string, unknown>>
  mutate(
    ops: readonly SettingsPathOpView[],
    expectedRevision?: number,
  ): Promise<boolean>
  t(key: GithubReviewerLocaleKey): string
}

/** GitHub author_association values allowed to trigger /review and /bot. */
const ASSOCIATION_OPTIONS = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
] as const

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

function draftOf(value: Record<string, unknown> | undefined): Draft {
  const review = (value?.review ?? {}) as Record<string, unknown>
  const numberOf = (raw: unknown, fallback: number): string => (typeof raw === 'number' ? String(raw) : String(fallback))
  const textOf = (raw: unknown, fallback = ''): string => (typeof raw === 'string' ? raw : fallback)
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

export function GithubReviewerConfigFormSection(props: GithubReviewerConfigSectionProps) {
  // Presentational: the parent owns the store subscription and re-renders on
  // snapshot replacement; the draft re-materializes per revision.
  const snapshot = props.snapshot
  const [draft, setDraft] = useState(() => draftOf(snapshot.value))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [lastRevision, setLastRevision] = useState(snapshot.revision)
  if (snapshot.revision !== lastRevision) {
    setLastRevision(snapshot.revision)
    setDraft(draftOf(snapshot.value))
    setState('idle')
  }

  const writable = snapshot.writable && snapshot.status === 'ready' && state !== 'saving'
  const edit = (key: keyof Draft, text: string): void => { setDraft(current => ({ ...current, [key]: text })) }

  const associations = new Set(draft.commandAuthorAssociations.split(',').map(v => v.trim()).filter(v => v !== ''))
  const toggleAssociation = (code: string): void => {
    if (associations.has(code)) associations.delete(code)
    else associations.add(code)
    edit('commandAuthorAssociations', [...associations].join(', '))
  }

  const save = async (): Promise<void> => {
    setState('saving')
    const repositories = draft.repositories.split('\n').map(line => line.trim()).filter(line => line !== '')
    const ok = await props.mutate([
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
        commandAuthorAssociations: [...associations],
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
      <fieldset className="ghr-field">
        <span>{props.t('commandAuthorAssociations')}</span>
        <div className="ghr-checks">
          <label className="ghr-check">
            <input type="checkbox" checked={associations.has('*')} disabled={!writable}
              onChange={() => toggleAssociation('*')} />
            <span>{props.t('anyone')}</span>
          </label>
          {ASSOCIATION_OPTIONS.map(code => (
            <label className="ghr-check" key={code}>
              <input type="checkbox" checked={associations.has(code)} disabled={!writable}
                onChange={() => toggleAssociation(code)} />
              <span>{code}</span>
            </label>
          ))}
        </div>
        <span className="ghr-hint">{props.t('commandAuthorAssociationsHint')}</span>
      </fieldset>
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
