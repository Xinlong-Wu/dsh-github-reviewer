/** Presentation component for the GitHub reviewer plugin settings card. */

import React, { useEffect, useRef, useState } from 'react'
import { IconPlusOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  GithubReviewerCardFace,
  ReviewerCollectionState,
  ReviewerField,
  ReviewerTextField,
} from './controller.ts'
import type { GithubReviewerLocaleKey } from './locales.ts'
import { RepositoryCombobox } from './RepositoryCombobox.tsx'
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
  field: ReviewerTextField
  label: GithubReviewerLocaleKey
  hint?: GithubReviewerLocaleKey
  multiline?: boolean
}> = [
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
]

/** Six-dot grip used as the model priority drag handle. */
function DragGrip() {
  return (
    <svg viewBox="0 0 12 16" width="12" height="16" aria-hidden="true" focusable="false">
      {[3, 8, 13].flatMap(y => [3, 9].map(x => <circle cx={x} cy={y} r="1.2" fill="currentColor" key={`${x}-${y}`} />))}
    </svg>
  )
}

/** Render one inherited/overridden marker and optional reset action. */
function FieldMeta(props: {
  field: ReviewerField
  state: Pick<ReviewerCollectionState<unknown>, 'overridden'>
  disabled: boolean
  reset(field: ReviewerField): void
  t(key: GithubReviewerLocaleKey): string
}) {
  return (
    <>
      <span className={props.state.overridden ? 'ghr-badge' : 'ghr-badge ghr-badge-muted'}>
        {props.t(props.state.overridden ? 'overridden' : 'inherited')}
      </span>
      {props.state.overridden
        ? (
          <button type="button" disabled={props.disabled} onClick={() => { props.reset(props.field) }}>
            {props.t('reset')}
          </button>
          )
        : null}
    </>
  )
}

/** Render the card from framework-bound state and callbacks. */
export function GithubReviewerCard(props: GithubReviewerCardProps) {
  const state = props.useGithubReviewerCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [draggingModelIndex, setDraggingModelIndex] = useState<number | null>(null)
  const [dropModelIndex, setDropModelIndex] = useState<number | null>(null)
  const [modelMoveAnnouncement, setModelMoveAnnouncement] = useState('')
  const pendingModelFocus = useRef<number | null>(null)
  const modelHandles = useRef<Array<HTMLButtonElement | null>>([])
  const modelDragDepths = useRef(new Map<number, number>())

  useEffect(() => {
    const index = pendingModelFocus.current
    if (index === null) return
    modelHandles.current[index]?.focus()
    pendingModelFocus.current = null
  }, [state.models.rows])
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  const invalid = state.repositories.invalid
    || state.models.invalid
    || Object.values(state.fields).some(field => field.invalid)
  const selectableModelGroups = state.modelCatalog.groups.filter(group => group.models.length > 0)
  const ownerOptions = [...new Map(state.repositoryCatalog.repositories
    .map(repository => [repository.owner.toLowerCase(), repository.owner] as const)).values()]
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
  const addModelDisabled = disabled || selectableModelGroups.length === 0
  return (
    <li className={open ? 'ghr-card ghr-card-open' : 'ghr-card'}>
      <button
        type="button"
        className="ghr-header"
        aria-expanded={open}
        aria-label={`${props.t(open ? 'collapse' : 'expand')}: ${props.t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="ghr-head-text">
          <span className="ghr-name">{props.t('title')}</span>
          <span className="ghr-description">{props.t('description')}</span>
        </span>
        {state.dirty ? <span className="ghr-pending">{props.t('unsaved')}</span> : null}
        <span className={open ? 'ghr-chevron ghr-chevron-open' : 'ghr-chevron'} aria-hidden="true">⌄</span>
      </button>
      {open
        ? (
          <div className="ghr-body">
            {!state.writable ? <p className="ghr-warning">{props.t('readOnly')}</p> : null}

            <section className="ghr-field ghr-collection">
              <div className="ghr-field-head">
                <h4>{props.t('repositories')}</h4>
                <FieldMeta field="repositories" state={state.repositories} disabled={disabled} reset={props.reset} t={props.t} />
                {state.repositoryCatalog.loaded || state.repositoryCatalog.loading || state.repositoryCatalog.error !== null
                  ? (
                    <button
                      type="button"
                      disabled={state.repositoryCatalog.loading}
                      onClick={props.retryRepositoryCatalog}
                    >
                      {props.t(state.repositoryCatalog.error === null ? 'refreshRepositoryCatalog' : 'retry')}
                    </button>
                    )
                  : null}
              </div>
              {state.repositoryCatalog.loading
                ? <p className="ghr-hint" aria-live="polite">{props.t('repositoryCatalogLoading')}</p>
                : null}
              {state.repositoryCatalog.error !== null
                ? <p className="ghr-catalog-status">{props.t('repositoryCatalogLoadFailed')}</p>
                : null}
              {state.repositories.rows.length === 0
                ? <p className="ghr-empty">{props.t('repositoriesEmpty')}</p>
                : (
                  <div className="ghr-rows">
                    {state.repositories.rows.map((row, index) => {
                      const repositoryOptions = state.repositoryCatalog.repositories
                        .filter(repository => repository.owner.localeCompare(row.owner, undefined, { sensitivity: 'base' }) === 0)
                        .map(repository => repository.repository)
                      const unknown = state.repositoryCatalog.loaded
                        && row.owner.trim() !== ''
                        && row.repository.trim() !== ''
                        && !state.repositoryCatalog.repositories.some(repository =>
                          repository.owner.localeCompare(row.owner, undefined, { sensitivity: 'base' }) === 0
                          && repository.repository.localeCompare(row.repository, undefined, { sensitivity: 'base' }) === 0)
                      const warningId = `github-reviewer-repository-${index}-warning`
                      const describedBy = unknown
                        ? `github-reviewer-repositories-hint ${warningId}`
                        : 'github-reviewer-repositories-hint'
                      return (
                        <div className="ghr-row" key={index}>
                          <RepositoryCombobox
                            label={props.t('repositoryOwner')}
                            value={row.owner}
                            options={ownerOptions}
                            disabled={disabled}
                            invalid={!row.owner.trim() || /[\s/]/.test(row.owner)}
                            describedBy={describedBy}
                            onLoad={props.ensureRepositoryCatalog}
                            onChange={(value) => { props.editRepository(index, 'owner', value) }}
                          />
                          <RepositoryCombobox
                            label={props.t('repositoryName')}
                            value={row.repository}
                            options={repositoryOptions}
                            disabled={disabled}
                            invalid={!row.repository.trim() || /[\s/]/.test(row.repository)}
                            describedBy={describedBy}
                            onLoad={props.ensureRepositoryCatalog}
                            onChange={(value) => { props.editRepository(index, 'repository', value) }}
                          />
                          <button
                            type="button"
                            className="ghr-icon-button ghr-remove"
                            disabled={disabled}
                            aria-label={`${props.t('remove')}: ${row.owner}/${row.repository}, ${props.t('position')} ${index + 1}`}
                            title={props.t('remove')}
                            onClick={() => { props.removeRepository(index) }}
                          >
                            <IconTrashOutline16 size={14} />
                          </button>
                          {unknown ? <p id={warningId} className="ghr-catalog-warning">{props.t('repositoryCatalogUnknown')}</p> : null}
                        </div>
                      )
                    })}
                  </div>
                  )}
              <div className="ghr-collection-footer">
                <p id="github-reviewer-repositories-hint" className={state.repositories.invalid ? 'ghr-invalid' : 'ghr-hint'}>
                  {props.t(state.repositories.invalid ? 'repositoriesInvalid' : 'repositoriesHint')}
                </p>
                <button
                  type="button"
                  className="ghr-icon-button"
                  disabled={disabled}
                  aria-label={props.t('addRepository')}
                  title={props.t('addRepository')}
                  onClick={props.addRepository}
                >
                  <IconPlusOutline16 size={14} />
                </button>
              </div>
            </section>

            <section className="ghr-field ghr-collection">
              <div className="ghr-field-head">
                <h4>{props.t('models')}</h4>
                <FieldMeta field="models" state={state.models} disabled={disabled} reset={props.reset} t={props.t} />
              </div>
              <span className="ghr-sr-only" aria-live="polite">{modelMoveAnnouncement}</span>
              {state.models.rows.length === 0
                ? <p className="ghr-empty">{props.t('modelsEmpty')}</p>
                : (
                  <div className="ghr-rows">
                    {state.models.rows.map((row, index) => {
                      const group = selectableModelGroups.find(entry => entry.id === row.provider)
                      const providerUnavailable = group === undefined
                      const modelUnavailable = group?.models.every(model => model.id !== row.model) ?? true
                      const rowClass = [
                        'ghr-row',
                        'ghr-model-row',
                        draggingModelIndex === index ? 'ghr-model-row-dragging' : '',
                        dropModelIndex === index ? 'ghr-model-row-target' : '',
                      ].filter(Boolean).join(' ')
                      return (
                        <div
                          className={rowClass}
                          key={index}
                          onDragEnter={(event) => {
                            if (disabled || draggingModelIndex === null || draggingModelIndex === index) return
                            event.preventDefault()
                            const depth = (modelDragDepths.current.get(index) ?? 0) + 1
                            modelDragDepths.current.set(index, depth)
                            setDropModelIndex(index)
                          }}
                          onDragLeave={() => {
                            const depth = Math.max(0, (modelDragDepths.current.get(index) ?? 0) - 1)
                            if (depth > 0) {
                              modelDragDepths.current.set(index, depth)
                              return
                            }
                            modelDragDepths.current.delete(index)
                            setDropModelIndex(current => current === index ? null : current)
                          }}
                          onDragOver={(event) => {
                            if (disabled || draggingModelIndex === null || draggingModelIndex === index) return
                            event.preventDefault()
                            event.dataTransfer.dropEffect = 'move'
                          }}
                          onDrop={(event) => {
                            event.preventDefault()
                            modelDragDepths.current.clear()
                            if (disabled) {
                              setDraggingModelIndex(null)
                              setDropModelIndex(null)
                              return
                            }
                            const encoded = event.dataTransfer.getData('text/plain')
                            const fromIndex = draggingModelIndex ?? (encoded === '' ? Number.NaN : Number(encoded))
                            if (Number.isInteger(fromIndex) && fromIndex !== index) {
                              props.moveModel(fromIndex, index)
                              setModelMoveAnnouncement(`${props.t('position')}: ${index + 1}`)
                            }
                            setDraggingModelIndex(null)
                            setDropModelIndex(null)
                          }}
                        >
                          <button
                            type="button"
                            className="ghr-drag-handle"
                            disabled={disabled}
                            draggable={!disabled}
                            ref={(element) => { modelHandles.current[index] = element }}
                            aria-label={`${props.t('moveModel')}: ${row.provider}/${row.model}, ${props.t('position')} ${index + 1}`}
                            title={props.t('modelsPriorityHint')}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', String(index))
                              const block = event.currentTarget.closest<HTMLElement>('.ghr-model-row')
                              if (block !== null && typeof event.dataTransfer.setDragImage === 'function') {
                                const rect = block.getBoundingClientRect()
                                const pointerX = Number.isFinite(event.clientX) ? event.clientX : rect.left
                                const pointerY = Number.isFinite(event.clientY) ? event.clientY : rect.top
                                const offsetX = Math.max(0, Math.min(rect.width, pointerX - rect.left))
                                const offsetY = Math.max(0, Math.min(rect.height, pointerY - rect.top))
                                event.dataTransfer.setDragImage(block, offsetX, offsetY)
                              }
                              modelDragDepths.current.clear()
                              setDraggingModelIndex(index)
                              setDropModelIndex(null)
                            }}
                            onDragEnd={() => {
                              modelDragDepths.current.clear()
                              setDraggingModelIndex(null)
                              setDropModelIndex(null)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowUp' && index > 0) {
                                event.preventDefault()
                                pendingModelFocus.current = index - 1
                                props.moveModel(index, index - 1)
                                setModelMoveAnnouncement(`${props.t('position')}: ${index}`)
                              } else if (event.key === 'ArrowDown' && index < state.models.rows.length - 1) {
                                event.preventDefault()
                                pendingModelFocus.current = index + 1
                                props.moveModel(index, index + 1)
                                setModelMoveAnnouncement(`${props.t('position')}: ${index + 2}`)
                              }
                            }}
                          >
                            <DragGrip />
                          </button>
                          <label>
                            <span>{props.t('provider')}</span>
                            <select
                              value={row.provider}
                              disabled={disabled || selectableModelGroups.length === 0}
                              aria-describedby="github-reviewer-models-hint"
                              onChange={(event) => { props.editModelProvider(index, event.target.value) }}
                            >
                              {providerUnavailable ? <option value={row.provider}>{row.provider} ({props.t('catalogUnavailable')})</option> : null}
                              {selectableModelGroups.map(entry => <option value={entry.id} key={entry.id}>{entry.name}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>{props.t('model')}</span>
                            <select
                              value={row.model}
                              disabled={disabled || group === undefined || group.models.length === 0}
                              aria-describedby="github-reviewer-models-hint"
                              onChange={(event) => { props.editModel(index, event.target.value) }}
                            >
                              {modelUnavailable ? <option value={row.model}>{row.model} ({props.t('catalogUnavailable')})</option> : null}
                              {group?.models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="ghr-icon-button ghr-remove"
                            disabled={disabled}
                            aria-label={`${props.t('remove')}: ${row.provider}/${row.model}, ${props.t('position')} ${index + 1}`}
                            title={props.t('remove')}
                            onClick={() => { props.removeModel(index) }}
                          >
                            <IconTrashOutline16 size={14} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  )}
              {state.modelCatalog.loading ? <p className="ghr-hint">{props.t('modelsLoading')}</p> : null}
              {state.modelCatalog.error !== null
                ? (
                  <p className="ghr-warning" role="status">
                    {props.t('modelsLoadFailed')}{' '}
                    <button type="button" disabled={state.modelCatalog.loading} onClick={props.retryModels}>{props.t('retry')}</button>
                  </p>
                  )
                : null}
              {state.modelCatalog.failures.map(failure => <p className="ghr-warning" role="status" key={failure}>{failure}</p>)}
              {state.modelCatalog.failures.length > 0 && state.modelCatalog.error === null
                ? <button type="button" className="ghr-retry" disabled={state.modelCatalog.loading} onClick={props.retryModels}>{props.t('retry')}</button>
                : null}
              <div className="ghr-collection-footer">
                <p id="github-reviewer-models-hint" className={state.models.invalid ? 'ghr-invalid' : 'ghr-hint'}>
                  {props.t(state.models.invalid ? 'modelsInvalid' : 'modelsHint')}
                </p>
                <button
                  type="button"
                  className="ghr-icon-button"
                  disabled={addModelDisabled}
                  aria-label={props.t('addModel')}
                  title={props.t('addModel')}
                  onClick={props.addModel}
                >
                  <IconPlusOutline16 size={14} />
                </button>
              </div>
            </section>

            <div className="ghr-grid">
              {fieldCopy.map((copy) => {
                const field = state.fields[copy.field]
                const id = `github-reviewer-${copy.field}`
                return (
                  <div className="ghr-field" key={copy.field}>
                    <div className="ghr-field-head">
                      <label htmlFor={id}>{props.t(copy.label)}</label>
                      <FieldMeta field={copy.field} state={field} disabled={disabled} reset={props.reset} t={props.t} />
                    </div>
                    {copy.multiline === true
                      ? (
                        <textarea
                          id={id}
                          value={field.text}
                          disabled={disabled}
                          aria-invalid={field.invalid || undefined}
                          aria-describedby={`${id}-hint`}
                          rows={copy.field === 'defaultInstructions' ? 6 : 3}
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
                          aria-describedby={`${id}-hint`}
                          onChange={(event) => { props.edit(copy.field, event.target.value) }}
                        />
                        )}
                    <p id={`${id}-hint`} className={field.invalid ? 'ghr-invalid' : 'ghr-hint'}>
                      {field.invalid ? props.t('invalid') : copy.hint === undefined ? '' : props.t(copy.hint)}
                    </p>
                  </div>
                )
              })}
            </div>
            <p className="ghr-hint">{props.t('savedHint')}</p>
            <footer className="ghr-actions">
              {state.failed ? <p className="ghr-warning" role="status">{props.t('saveFailed')}</p> : null}
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
          </div>
          )
        : null}
    </li>
  )
}
