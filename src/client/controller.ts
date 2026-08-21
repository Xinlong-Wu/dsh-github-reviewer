/** Reactive staged form controller for the GitHub reviewer settings card. */

import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
  type SettingsScope,
  type SettingsScopeSnapshot,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { AccessibleRepository, RepositoryCatalog } from '../repository-catalog-contract.ts'
import type { ReviewerSettings, ReviewerSettingsModel } from '../settings-contract.ts'

export const SETTINGS_NAMESPACE = 'github-reviewer'

export type ReviewerTextField =
  | 'pollIntervalMs'
  | 'workspaceDir'
  | 'workspaceTitle'
  | 'maxToolCalls'
  | 'toolTimeoutMs'
  | 'toolResultLimit'
  | 'timeoutMs'
  | 'defaultInstructions'
  | 'commandAuthorAssociations'

export type ReviewerField = ReviewerTextField | 'repositories' | 'models'

export interface ReviewerFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface RepositoryDraft {
  owner: string
  repository: string
}

export interface ReviewerCollectionState<T> {
  rows: T[]
  overridden: boolean
  invalid: boolean
}

export interface ReviewerModelCatalogModel {
  id: string
  name: string
}

export interface ReviewerModelCatalogGroup {
  id: string
  name: string
  models: ReviewerModelCatalogModel[]
}

export interface ReviewerModelCatalogState {
  loading: boolean
  error: string | null
  failures: string[]
  groups: ReviewerModelCatalogGroup[]
}

export interface ReviewerRepositoryCatalogState {
  loading: boolean
  loaded: boolean
  error: string | null
  repositories: AccessibleRepository[]
}

export type RepositoryCatalogLoader = (signal?: AbortSignal) => Promise<RepositoryCatalog>

export interface GithubReviewerCardState {
  available: boolean
  writable: boolean
  saving: boolean
  dirty: boolean
  failed: boolean
  fields: Record<ReviewerTextField, ReviewerFieldState>
  repositories: ReviewerCollectionState<RepositoryDraft>
  repositoryCatalog: ReviewerRepositoryCatalogState
  models: ReviewerCollectionState<ReviewerSettingsModel>
  modelCatalog: ReviewerModelCatalogState
}

export interface GithubReviewerCardFace {
  hooks: { githubReviewerCard: SnapshotStore<GithubReviewerCardState> }
  edit(field: ReviewerTextField, text: string): void
  reset(field: ReviewerField): void
  addRepository(): void
  editRepository(index: number, key: keyof RepositoryDraft, text: string): void
  ensureRepositoryCatalog(): void
  retryRepositoryCatalog(): void
  removeRepository(index: number): void
  addModel(): void
  editModelProvider(index: number, provider: string): void
  editModel(index: number, model: string): void
  removeModel(index: number): void
  moveModel(fromIndex: number, toIndex: number): void
  retryModels(): void
  save(): void
  discard(): void
}

type ReviewerApi = Pick<IApiClient, 'settings' | 'llm'>

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

const specs: Record<ReviewerTextField, FieldSpec> = {
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
}

const paths: Record<ReviewerField, readonly string[]> = {
  pollIntervalMs: ['pollIntervalMs'],
  workspaceDir: ['workspaceDir'],
  workspaceTitle: ['workspaceTitle'],
  maxToolCalls: ['review', 'maxToolCalls'],
  toolTimeoutMs: ['review', 'toolTimeoutMs'],
  toolResultLimit: ['review', 'toolResultLimit'],
  timeoutMs: ['review', 'timeoutMs'],
  defaultInstructions: ['review', 'defaultInstructions'],
  commandAuthorAssociations: ['review', 'commandAuthorAssociations'],
  repositories: ['repositories'],
  models: ['review', 'models'],
}

const emptyFields = (): Record<ReviewerTextField, ReviewerFieldState> => Object.fromEntries(
  (Object.keys(specs) as ReviewerTextField[]).map(field => [field, { text: '', overridden: false, invalid: false }]),
) as Record<ReviewerTextField, ReviewerFieldState>

function hasPath(value: unknown, path: readonly string[]): boolean {
  let current: unknown = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return false
    current = (current as Record<string, unknown>)[segment]
  }
  return true
}

function repositoriesFromSettings(values: readonly string[]): RepositoryDraft[] {
  return values.map((value) => {
    const slash = value.indexOf('/')
    return slash < 0
      ? { owner: value, repository: '' }
      : { owner: value.slice(0, slash), repository: value.slice(slash + 1) }
  })
}

function validRepositoryPart(value: string): boolean {
  return value.trim() !== '' && !/[\s/]/.test(value)
}

function repositoriesInvalid(rows: readonly RepositoryDraft[]): boolean {
  return rows.some(row => !validRepositoryPart(row.owner) || !validRepositoryPart(row.repository))
}

function modelsInvalid(rows: readonly ReviewerSettingsModel[]): boolean {
  return rows.some(row => row.provider.trim() === '' || row.model.trim() === '')
}

/** Own staged edits, the model directory, and one revision-fenced mutation per Save. */
export class GithubReviewerCardController {
  private readonly store = createSnapshotStore<GithubReviewerCardState>({
    available: false,
    writable: false,
    saving: false,
    dirty: false,
    failed: false,
    fields: emptyFields(),
    repositories: { rows: [], overridden: false, invalid: false },
    repositoryCatalog: { loading: false, loaded: false, error: null, repositories: [] },
    models: { rows: [], overridden: false, invalid: false },
    modelCatalog: { loading: false, error: null, failures: [], groups: [] },
  })
  private readonly dirty = new Set<ReviewerField>()
  private readonly resets = new Set<ReviewerField>()
  private readonly fieldVersions = new Map<ReviewerField, number>()
  private editVersion = 0
  private draftRevision: number | undefined
  private disposed = false
  private saveTail: Promise<void> = Promise.resolve()
  private modelGeneration = 0
  private repositoryGeneration = 0
  private repositoryAbort: AbortController | undefined
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: SettingsScope<ReviewerSettings>,
    private readonly api: ReviewerApi,
    private readonly loadRepositoryCatalog: RepositoryCatalogLoader = async () => ({ repositories: [] }),
  ) {
    this.unsubscribe = scope.subscribe(() => { this.acceptScope() })
    this.acceptScope()
    void this.refreshModelCatalog()
  }

  inject(): GithubReviewerCardFace {
    return {
      hooks: { githubReviewerCard: this.store },
      edit: (field, text) => { this.edit(field, text) },
      reset: field => { this.reset(field) },
      addRepository: () => { this.addRepository() },
      editRepository: (index, key, text) => { this.editRepository(index, key, text) },
      ensureRepositoryCatalog: () => { this.ensureRepositoryCatalog() },
      retryRepositoryCatalog: () => { void this.refreshRepositoryCatalog() },
      removeRepository: index => { this.removeRepository(index) },
      addModel: () => { this.addModel() },
      editModelProvider: (index, provider) => { this.editModelProvider(index, provider) },
      editModel: (index, model) => { this.editModel(index, model) },
      removeModel: index => { this.removeModel(index) },
      moveModel: (fromIndex, toIndex) => { this.moveModel(fromIndex, toIndex) },
      retryModels: () => { void this.refreshModelCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    ++this.modelGeneration
    ++this.repositoryGeneration
    this.repositoryAbort?.abort()
    this.repositoryAbort = undefined
    this.unsubscribe()
    await this.saveTail
  }

  ensureRepositoryCatalog(): void {
    const catalog = this.store.getSnapshot().repositoryCatalog
    if (catalog.loading || catalog.loaded || catalog.error !== null) return
    void this.refreshRepositoryCatalog()
  }

  invalidateRepositoryCatalog(): void {
    if (this.disposed) return
    ++this.repositoryGeneration
    this.repositoryAbort?.abort()
    this.repositoryAbort = undefined
    this.store.update((draft) => {
      draft.repositoryCatalog.loading = false
      draft.repositoryCatalog.loaded = false
      draft.repositoryCatalog.error = null
      draft.repositoryCatalog.repositories = []
    })
  }

  async refreshRepositoryCatalog(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.repositoryGeneration
    this.repositoryAbort?.abort()
    const abort = new AbortController()
    this.repositoryAbort = abort
    this.store.update((draft) => {
      draft.repositoryCatalog.loading = true
      draft.repositoryCatalog.error = null
    })
    try {
      const catalog = await this.loadRepositoryCatalog(abort.signal)
      if (this.disposed || abort.signal.aborted || generation !== this.repositoryGeneration) return
      this.store.update((draft) => {
        draft.repositoryCatalog.loading = false
        draft.repositoryCatalog.loaded = true
        draft.repositoryCatalog.error = null
        draft.repositoryCatalog.repositories = catalog.repositories.map(repository => ({ ...repository }))
      })
    } catch (error) {
      if (this.disposed || abort.signal.aborted || generation !== this.repositoryGeneration) return
      this.store.update((draft) => {
        draft.repositoryCatalog.loading = false
        draft.repositoryCatalog.loaded = false
        draft.repositoryCatalog.error = error instanceof Error ? error.message : String(error)
        draft.repositoryCatalog.repositories = []
      })
    } finally {
      if (this.repositoryAbort === abort) this.repositoryAbort = undefined
    }
  }

  async refreshModelCatalog(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.modelGeneration
    this.store.update((draft) => {
      draft.modelCatalog.loading = true
      draft.modelCatalog.error = null
    })
    try {
      const response = await this.api.llm.models({})
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (this.disposed || generation !== this.modelGeneration) return
      const { groups, failures } = response.result.value
      this.store.update((draft) => {
        draft.modelCatalog.loading = false
        draft.modelCatalog.error = null
        draft.modelCatalog.failures = failures.map(failure => `${failure.name}: ${failure.message}`)
        draft.modelCatalog.groups = groups.map(group => ({
          id: group.id,
          name: group.name,
          models: group.models.map(model => ({ id: model.id, name: model.name })),
        }))
      })
    } catch (error) {
      if (this.disposed || generation !== this.modelGeneration) return
      this.store.update((draft) => {
        draft.modelCatalog.loading = false
        draft.modelCatalog.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  private markDirty(field: ReviewerField): void {
    if (this.dirty.size === 0) this.draftRevision = this.scope.getSnapshot().revision
    this.dirty.add(field)
    this.resets.delete(field)
    this.fieldVersions.set(field, ++this.editVersion)
    this.store.update((draft) => {
      draft.dirty = true
      draft.failed = false
      if (field === 'repositories' || field === 'models') draft[field].overridden = true
      else draft.fields[field].overridden = true
    })
  }

  private edit(field: ReviewerTextField, text: string): void {
    const parsed = specs[field].parse(text)
    this.markDirty(field)
    this.store.update((draft) => {
      draft.fields[field].text = text
      draft.fields[field].invalid = parsed === undefined
    })
  }

  private addRepository(): void {
    this.markDirty('repositories')
    this.store.update((draft) => {
      draft.repositories.rows.push({ owner: '', repository: '' })
      draft.repositories.invalid = true
    })
  }

  private editRepository(index: number, key: keyof RepositoryDraft, text: string): void {
    if (this.store.getSnapshot().repositories.rows[index] === undefined) return
    this.markDirty('repositories')
    this.store.update((draft) => {
      const row = draft.repositories.rows[index]
      if (row === undefined) return
      row[key] = text
      draft.repositories.invalid = repositoriesInvalid(draft.repositories.rows)
    })
  }

  private removeRepository(index: number): void {
    if (this.store.getSnapshot().repositories.rows[index] === undefined) return
    this.markDirty('repositories')
    this.store.update((draft) => {
      draft.repositories.rows.splice(index, 1)
      draft.repositories.invalid = repositoriesInvalid(draft.repositories.rows)
    })
  }

  private addModel(): void {
    const group = this.store.getSnapshot().modelCatalog.groups.find(entry => entry.models.length > 0)
    const model = group?.models[0]
    if (group === undefined || model === undefined) return
    this.markDirty('models')
    this.store.update((draft) => {
      draft.models.rows.push({ provider: group.id, model: model.id })
      draft.models.invalid = modelsInvalid(draft.models.rows)
    })
  }

  private editModelProvider(index: number, provider: string): void {
    if (this.store.getSnapshot().models.rows[index] === undefined) return
    const group = this.store.getSnapshot().modelCatalog.groups.find(entry => entry.id === provider)
    const model = group?.models[0]
    if (group === undefined || model === undefined) return
    this.markDirty('models')
    this.store.update((draft) => {
      const row = draft.models.rows[index]
      if (row === undefined) return
      row.provider = provider
      row.model = model.id
      draft.models.invalid = modelsInvalid(draft.models.rows)
    })
  }

  private editModel(index: number, model: string): void {
    if (this.store.getSnapshot().models.rows[index] === undefined) return
    this.markDirty('models')
    this.store.update((draft) => {
      const row = draft.models.rows[index]
      if (row === undefined) return
      row.model = model
      draft.models.invalid = modelsInvalid(draft.models.rows)
    })
  }

  private removeModel(index: number): void {
    if (this.store.getSnapshot().models.rows[index] === undefined) return
    this.markDirty('models')
    this.store.update((draft) => {
      draft.models.rows.splice(index, 1)
      draft.models.invalid = modelsInvalid(draft.models.rows)
    })
  }

  private moveModel(fromIndex: number, toIndex: number): void {
    const snapshot = this.store.getSnapshot()
    if (!snapshot.writable || snapshot.saving) return
    const rows = snapshot.models.rows
    if (fromIndex === toIndex || rows[fromIndex] === undefined || rows[toIndex] === undefined) return
    this.markDirty('models')
    this.store.update((draft) => {
      const [row] = draft.models.rows.splice(fromIndex, 1)
      if (row === undefined) return
      draft.models.rows.splice(toIndex, 0, row)
    })
  }

  private reset(field: ReviewerField): void {
    const snapshot = this.scope.getSnapshot()
    const base = snapshot.base
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return
    const value = base as ReviewerSettings
    this.markDirty(field)
    this.resets.add(field)
    this.store.update((draft) => {
      if (field === 'repositories') {
        draft.repositories.rows = repositoriesFromSettings(value.repositories)
        draft.repositories.invalid = false
        draft.repositories.overridden = false
      } else if (field === 'models') {
        draft.models.rows = value.review.models.map(model => ({ ...model }))
        draft.models.invalid = false
        draft.models.overridden = false
      } else {
        draft.fields[field].text = specs[field].format(value)
        draft.fields[field].invalid = false
        draft.fields[field].overridden = false
      }
      draft.dirty = true
      draft.failed = false
    })
  }

  private discard(): void {
    this.dirty.clear()
    this.resets.clear()
    this.fieldVersions.clear()
    this.draftRevision = undefined
    this.acceptScope(true)
  }

  private save(): Promise<void> {
    const task = this.saveTail.then(async () => {
      if (this.disposed || this.dirty.size === 0) return
      const snapshot = this.scope.getSnapshot()
      if (snapshot.status !== 'ready' || !snapshot.writable) return
      const state = this.store.getSnapshot()
      const submitted = [...this.dirty].map(field => ({ field, version: this.fieldVersions.get(field) ?? 0 }))
      const ops: SettingsPathOpView[] = []
      for (const { field } of submitted) {
        if (this.resets.has(field)) {
          ops.push({ op: 'unset', path: [...paths[field]] })
          continue
        }
        if (field === 'repositories') {
          if (state.repositories.invalid) return
          ops.push({
            op: 'set',
            path: [...paths.repositories],
            value: state.repositories.rows.map(row => `${row.owner.trim()}/${row.repository.trim()}`),
          })
          continue
        }
        if (field === 'models') {
          if (state.models.invalid) return
          ops.push({
            op: 'set',
            path: [...paths.models],
            value: state.models.rows.map(row => ({ provider: row.provider.trim(), model: row.model.trim() })),
          })
          continue
        }
        const value = specs[field].parse(state.fields[field].text)
        if (value === undefined) return
        ops.push({ op: 'set', path: [...paths[field]], value })
      }
      const expectedRevision = this.draftRevision
      this.store.update((draft) => { draft.saving = true; draft.failed = false })
      try {
        const response = await this.api.settings.mutate({
          ns: SETTINGS_NAMESPACE,
          ops,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        })
        if (!response.result.ok) throw new Error(response.result.error.message)
        const view = response.result.value
        const savedValue = view.value as ReviewerSettings
        for (const { field, version } of submitted) {
          if (this.fieldVersions.get(field) !== version) continue
          this.dirty.delete(field)
          this.resets.delete(field)
          this.fieldVersions.delete(field)
        }
        this.draftRevision = this.dirty.size === 0 ? undefined : view.revision
        this.store.update((draft) => {
          for (const { field, version } of submitted) {
            if (this.fieldVersions.get(field) !== undefined && this.fieldVersions.get(field) !== version) continue
            if (field === 'repositories') {
              draft.repositories.rows = repositoriesFromSettings(savedValue.repositories)
              draft.repositories.overridden = hasPath(view.user, paths.repositories)
              draft.repositories.invalid = false
            } else if (field === 'models') {
              draft.models.rows = savedValue.review.models.map(model => ({ ...model }))
              draft.models.overridden = hasPath(view.user, paths.models)
              draft.models.invalid = false
            } else {
              draft.fields[field].text = specs[field].format(savedValue)
              draft.fields[field].overridden = hasPath(view.user, specs[field].path)
              draft.fields[field].invalid = false
            }
          }
          draft.saving = false
          draft.dirty = this.dirty.size > 0
          draft.failed = false
        })
      } catch {
        this.store.update((draft) => { draft.saving = false; draft.failed = true })
      }
    })
    this.saveTail = task.catch(() => {})
    return task
  }

  private acceptScope(force = false): void {
    if (this.disposed) return
    const snapshot: SettingsScopeSnapshot<ReviewerSettings> = this.scope.getSnapshot()
    const value = snapshot.value
    this.store.update((draft) => {
      draft.available = snapshot.status === 'ready' && value !== undefined
      draft.writable = snapshot.writable
    })
    if (!force && this.dirty.size > 0) return
    this.draftRevision = undefined
    this.store.update((draft) => {
      if (value === undefined) return
      for (const field of Object.keys(specs) as ReviewerTextField[]) {
        draft.fields[field].text = specs[field].format(value)
        draft.fields[field].overridden = hasPath(snapshot.user, specs[field].path)
        draft.fields[field].invalid = false
      }
      draft.repositories.rows = repositoriesFromSettings(value.repositories)
      draft.repositories.overridden = hasPath(snapshot.user, paths.repositories)
      draft.repositories.invalid = false
      draft.models.rows = value.review.models.map(model => ({ ...model }))
      draft.models.overridden = hasPath(snapshot.user, paths.models)
      draft.models.invalid = false
      draft.dirty = false
      draft.failed = false
    })
  }
}
