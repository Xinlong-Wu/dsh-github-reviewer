/** Presentation component for the GitHub reviewer plugin settings card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GithubReviewerCardFace, ReviewerField } from './controller.ts'
import type { GithubReviewerLocaleKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export type GithubReviewerCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.githubReviewer'>
  & InjectFace<GithubReviewerCardFace>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.githubReviewer': GithubReviewerLocaleKey
  }
}

const fieldCopy: Array<{
  field: ReviewerField
  label: GithubReviewerLocaleKey
  hint?: GithubReviewerLocaleKey
  multiline?: boolean
}> = [
  { field: 'repositories', label: 'repositories', hint: 'repositoriesHint', multiline: true },
  { field: 'pollIntervalMs', label: 'pollIntervalMs' },
  { field: 'workspaceDir', label: 'workspaceDir' },
  { field: 'workspaceTitle', label: 'workspaceTitle' },
  { field: 'maxToolCalls', label: 'maxToolCalls' },
  { field: 'toolTimeoutMs', label: 'toolTimeoutMs' },
  { field: 'toolResultLimit', label: 'toolResultLimit' },
  { field: 'timeoutMs', label: 'timeoutMs' },
  { field: 'defaultInstructions', label: 'defaultInstructions', multiline: true },
  {
    field: 'commandAuthorAssociations',
    label: 'commandAuthorAssociations',
    hint: 'commandAuthorAssociationsHint',
    multiline: true,
  },
  { field: 'models', label: 'models', hint: 'modelsHint', multiline: true },
]

/** Render the card from framework-bound state and callbacks. */
export function GithubReviewerCard(props: GithubReviewerCardProps) {
  const state = props.useGithubReviewerCard(snapshot => snapshot)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  const invalid = Object.values(state.fields).some(field => field.invalid)
  return (
    <li className="ghr-card">
      <header className="ghr-header">
        <div>
          <h3>{props.t('title')}</h3>
          <p>{props.t('description')}</p>
        </div>
      </header>
      {!state.writable ? <p className="ghr-warning">{props.t('readOnly')}</p> : null}
      <div className="ghr-grid">
        {fieldCopy.map((copy) => {
          const field = state.fields[copy.field]
          const id = `github-reviewer-${copy.field}`
          return (
            <div className="ghr-field" key={copy.field}>
              <div className="ghr-field-head">
                <label htmlFor={id}>{props.t(copy.label)}</label>
                <span className={field.overridden ? 'ghr-badge' : 'ghr-badge ghr-badge-muted'}>
                  {props.t(field.overridden ? 'overridden' : 'inherited')}
                </span>
                {field.overridden
                  ? (
                    <button type="button" disabled={disabled} onClick={() => { props.reset(copy.field) }}>
                      {props.t('reset')}
                    </button>
                  )
                  : null}
              </div>
              {copy.multiline === true
                ? (
                  <textarea
                    id={id}
                    value={field.text}
                    disabled={disabled}
                    aria-invalid={field.invalid || undefined}
                    rows={copy.field === 'models' || copy.field === 'defaultInstructions' ? 6 : 3}
                    onChange={(event) => { props.edit(copy.field, event.target.value) }}
                  />
                )
                : (
                  <input
                    id={id}
                    type="text"
                    value={field.text}
                    disabled={disabled}
                    aria-invalid={field.invalid || undefined}
                    onChange={(event) => { props.edit(copy.field, event.target.value) }}
                  />
                )}
              <p className={field.invalid ? 'ghr-invalid' : 'ghr-hint'}>
                {field.invalid ? props.t('invalid') : copy.hint === undefined ? '' : props.t(copy.hint)}
              </p>
            </div>
          )
        })}
      </div>
      {state.failed ? <p className="ghr-warning" role="status">{props.t('saveFailed')}</p> : null}
      <p className="ghr-hint">{props.t('savedHint')}</p>
      <footer className="ghr-actions">
        <button type="button" disabled={!state.dirty || state.saving} onClick={props.discard}>
          {props.t('discard')}
        </button>
        <button
          type="button"
          className="ghr-primary"
          disabled={!state.dirty || invalid || disabled}
          onClick={props.save}
        >
          {props.t(state.saving ? 'saving' : 'save')}
        </button>
      </footer>
    </li>
  )
}
