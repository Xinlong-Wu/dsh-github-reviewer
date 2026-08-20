/** Reactive staged form controller for the GitHub reviewer settings card. */

import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
  type SettingsScope,
  type SettingsScopeSnapshot,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ReviewerSettings } from '../settings-contract.ts'

export const SETTINGS_NAMESPACE = 'github-reviewer'

export type ReviewerField =
  | 'repositories'
  | 'pollIntervalMs'
  | 'workspaceDir'
  | 'workspaceTitle'
  | 'maxToolCalls'
  | 'toolTimeoutMs'
  | 'toolResultLimit'
  | 'timeoutMs'
  | 'defaultInstructions'
  | 'commandAuthorAssociations'
  | 'models'

export interface ReviewerFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface GithubReviewerCardState {
  available: boolean
  writable: boolean
  saving: boolean
  dirty: boolean
  failed: boolean
  fields: Record<ReviewerField, ReviewerFieldState>
}

export interface GithubReviewerCardFace {
  hooks: { githubReviewerCard: SnapshotStore<GithubReviewerCardState> }
  edit(field: ReviewerField, text: string): void
  reset(field: ReviewerField): void
  save(): void
  discard(): void
}

type SettingsApi = Pick<IApiClient, 'settings'>['settings']

interface FieldSpec {
  path: readonly string[]
  format(value: ReviewerSettings): string
  parse(text: string): unknown | undefined
}

const positiveInteger = (text: string): number | undefined => {
  if (!/^\d+$/.test(text.trim())) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

const specs: Record<ReviewerField, FieldSpec> = {
  repositories: {
    path: ['repositories'],
    format: value => value.repositories.join('\n'),
    parse: (text) => {
      const values = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      return values.length > 0 && values.every(value => /^[^/\s]+\/[^/\s]+$/.test(value)) ? values : undefined
    },
  },
  pollIntervalMs: { path: ['pollIntervalMs'], format: value => String(value.pollIntervalMs), parse: positiveInteger },
  workspaceDir: { path: ['workspaceDir'], format: value => value.workspaceDir, parse: text => text.trim() || undefined },
  workspaceTitle: { path: ['workspaceTitle'], format: value => value.workspaceTitle, parse: text => text.trim() || undefined },
  maxToolCalls: { path: ['review', 'maxToolCalls'], format: value => String(value.review.maxToolCalls), parse: positiveInteger },
  toolTimeoutMs: { path: ['review', 'toolTimeoutMs'], format: value => String(value.review.toolTimeoutMs), parse: positiveInteger },
  toolResultLimit: { path: ['review', 'toolResultLimit'], format: value => String(value.review.toolResultLimit), parse: positiveInteger },
  timeoutMs: { path: ['review', 'timeoutMs'], format: value => String(value.review.timeoutMs), parse: positiveInteger },
  defaultInstructions: { path: ['review', 'defaultInstructions'], format: value => value.review.defaultInstructions, parse: text => text },
  commandAuthorAssociations: {
    path: ['review', 'commandAuthorAssociations'],
    format: value => value.review.commandAuthorAssociations.join(', '),
    parse: text => text.split(/[\n,]/).map(value => value.trim().toUpperCase()).filter(Boolean),
  },
  models: {
    path: ['review', 'models'],
    format: value => JSON.stringify(value.review.models, null, 2),
    parse: (text) => {
      try {
        const value: unknown = JSON.parse(text)
        if (!Array.isArray(value)) return undefined
        if (!value.every(entry => typeof entry === 'object' && entry !== null
          && typeof (entry as { provider?: unknown }).provider === 'string'
          && typeof (entry as { model?: unknown }).model === 'string')) return undefined
        return value
      } catch {
        return undefined
      }
    },
  },
}

const emptyFields = (): Record<ReviewerField, ReviewerFieldState> => Object.fromEntries(
  (Object.keys(specs) as ReviewerField[]).map(field => [field, { text: '', overridden: false, invalid: false }]),
) as Record<ReviewerField, ReviewerFieldState>

function hasPath(value: unknown, path: readonly string[]): boolean {
  let current: unknown = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return false
    current = (current as Record<string, unknown>)[segment]
  }
  return true
}

/** Own staged edits and submit one revision-fenced mutation per Save. */
export class GithubReviewerCardController {
  private readonly store = createSnapshotStore<GithubReviewerCardState>({
    available: false,
    writable: false,
    saving: false,
    dirty: false,
    failed: false,
    fields: emptyFields(),
  })
  private readonly dirty = new Set<ReviewerField>()
  private readonly resets = new Set<ReviewerField>()
  private disposed = false
  private saveTail: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: SettingsScope<ReviewerSettings>,
    private readonly api: SettingsApi,
  ) {
    this.unsubscribe = scope.subscribe(() => { this.acceptScope() })
    this.acceptScope()
  }

  inject(): GithubReviewerCardFace {
    return {
      hooks: { githubReviewerCard: this.store },
      edit: (field, text) => { this.edit(field, text) },
      reset: field => { this.reset(field) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    await this.saveTail
  }

  private edit(field: ReviewerField, text: string): void {
    const parsed = specs[field].parse(text)
    this.dirty.add(field)
    this.resets.delete(field)
    this.store.update((draft) => {
      draft.fields[field].text = text
      draft.fields[field].invalid = parsed === undefined
      draft.fields[field].overridden = true
      draft.dirty = true
      draft.failed = false
    })
  }

  private reset(field: ReviewerField): void {
    const snapshot = this.scope.getSnapshot()
    const base = snapshot.base
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return
    this.dirty.add(field)
    this.resets.add(field)
    this.store.update((draft) => {
      draft.fields[field].text = specs[field].format(base as ReviewerSettings)
      draft.fields[field].invalid = false
      draft.fields[field].overridden = false
      draft.dirty = true
      draft.failed = false
    })
  }

  private discard(): void {
    this.dirty.clear()
    this.resets.clear()
    this.acceptScope(true)
  }

  private save(): Promise<void> {
    const task = this.saveTail.then(async () => {
      if (this.disposed || this.dirty.size === 0) return
      const snapshot = this.scope.getSnapshot()
      if (snapshot.status !== 'ready' || !snapshot.writable) return
      const ops: SettingsPathOpView[] = []
      for (const field of this.dirty) {
        const spec = specs[field]
        if (this.resets.has(field)) {
          ops.push({ op: 'unset', path: [...spec.path] })
          continue
        }
        const state = this.store.getSnapshot().fields[field]
        const value = spec.parse(state.text)
        if (value === undefined) return
        ops.push({ op: 'set', path: [...spec.path], value })
      }
      this.store.update((draft) => { draft.saving = true; draft.failed = false })
      try {
        const response = await this.api.mutate({
          ns: SETTINGS_NAMESPACE,
          ops,
          ...(snapshot.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
        })
        if (!response.result.ok) throw new Error(response.result.error.message)
        this.dirty.clear()
        this.resets.clear()
        this.store.update((draft) => { draft.saving = false; draft.dirty = false })
      } catch {
        this.store.update((draft) => { draft.saving = false; draft.failed = true })
      }
    })
    this.saveTail = task.catch(() => {})
    return task
  }

  private acceptScope(force = false): void {
    if (this.disposed || (!force && this.dirty.size > 0)) return
    const snapshot: SettingsScopeSnapshot<ReviewerSettings> = this.scope.getSnapshot()
    const value = snapshot.value
    this.store.update((draft) => {
      draft.available = snapshot.status === 'ready' && value !== undefined
      draft.writable = snapshot.writable
      if (value === undefined) return
      for (const field of Object.keys(specs) as ReviewerField[]) {
        draft.fields[field].text = specs[field].format(value)
        draft.fields[field].overridden = hasPath(snapshot.user, specs[field].path)
        draft.fields[field].invalid = false
      }
      draft.dirty = false
      draft.failed = false
    })
  }
}
