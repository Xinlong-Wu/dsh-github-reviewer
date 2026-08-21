import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { GithubReviewerCardController } from '../src/client/controller.ts'
import type { ReviewerSettings } from '../src/settings-contract.ts'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore<T>(initial: T) {
    let snapshot = structuredClone(initial)
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update(recipe: (draft: T) => void) {
        const next = structuredClone(snapshot)
        recipe(next)
        snapshot = next
        for (const listener of listeners) listener()
      },
    }
  },
}))

const value: ReviewerSettings = {
  pollIntervalMs: 120_000,
  repositories: ['owner/repo'],
  workspaceDir: '/tmp/reviewer',
  workspaceTitle: 'GithubReviewer',
  review: {
    maxToolCalls: 30,
    toolTimeoutMs: 30_000,
    toolResultLimit: 60_000,
    timeoutMs: 900_000,
    defaultInstructions: '',
    commandAuthorAssociations: ['OWNER'],
    models: [],
  },
}

function scope(user: unknown = {}, current: ReviewerSettings = value): SettingsScope<ReviewerSettings> {
  const snapshot: SettingsScopeSnapshot<ReviewerSettings> = {
    status: 'ready',
    value: current,
    base: current,
    user,
    revision: 7,
    writable: true,
    mode: 'host',
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: vi.fn(),
    unset: vi.fn(),
  }
}

function mutableScope() {
  let snapshot: SettingsScopeSnapshot<ReviewerSettings> = {
    status: 'ready',
    value,
    base: value,
    user: {},
    revision: 7,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: vi.fn(),
      unset: vi.fn(),
    } as SettingsScope<ReviewerSettings>,
    publish(patch: Partial<SettingsScopeSnapshot<ReviewerSettings>>) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    },
  }
}

function successResponse(savedValue: ReviewerSettings = value, revision = 8) {
  return {
    id: 1,
    result: {
      ok: true as const,
      value: {
        ns: 'github-reviewer',
        value: savedValue,
        base: value,
        user: {},
        revision,
        schema: {},
        secrets: {},
        applies: 'live' as const,
      },
    },
  }
}

function reviewerApi(
  mutate = vi.fn(async () => successResponse()),
  models = vi.fn(async () => ({
    id: 1,
    result: {
      ok: true as const,
      value: {
        groups: [
          { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }, { id: 'mini', name: 'Mini' }] },
          { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] },
        ],
        failures: [],
      },
    },
  })),
) {
  return { settings: { mutate }, llm: { models } } as never
}

describe('GithubReviewerCardController', () => {
  it('submits structured repository rows and text edits in one revision-fenced batch', async () => {
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate))
    const face = controller.inject()

    face.editRepository(0, 'owner', 'one')
    face.addRepository()
    face.editRepository(1, 'owner', 'two')
    face.editRepository(1, 'repository', 'repo')
    face.edit('pollIntervalMs', '60000')
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))

    expect(mutate).toHaveBeenCalledWith({
      ns: 'github-reviewer',
      expectedRevision: 7,
      ops: [
        { op: 'set', path: ['repositories'], value: ['one/repo', 'two/repo'] },
        { op: 'set', path: ['pollIntervalMs'], value: 60_000 },
      ],
    })
    await controller.dispose()
  })

  it('fences a draft against the revision it was first edited from', async () => {
    const harness = mutableScope()
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(harness.scope, reviewerApi(mutate))
    const face = controller.inject()

    face.edit('workspaceTitle', 'Draft')
    harness.publish({ revision: 8, value: { ...value, workspaceTitle: 'Concurrent' } })
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))

    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 7 })
    await controller.dispose()
  })

  it('preserves an edit made while a previous save is in flight', async () => {
    let resolveFirst: ((response: ReturnType<typeof successResponse>) => void) | undefined
    const first = new Promise<ReturnType<typeof successResponse>>(resolve => { resolveFirst = resolve })
    const mutate = vi.fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(async () => successResponse({ ...value, pollIntervalMs: 60_000 }, 9))
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate))
    const face = controller.inject()

    face.edit('workspaceTitle', 'First save')
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    face.edit('pollIntervalMs', '60000')
    resolveFirst?.(successResponse({ ...value, workspaceTitle: 'First save' }, 8))
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().saving).toBe(false))

    expect(face.hooks.githubReviewerCard.getSnapshot().dirty).toBe(true)
    expect(face.hooks.githubReviewerCard.getSnapshot().fields.pollIntervalMs.text).toBe('60000')
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      expectedRevision: 8,
      ops: [{ op: 'set', path: ['pollIntervalMs'], value: 60_000 }],
    })
    await controller.dispose()
  })

  it('keeps draft values but updates writability while scope changes', async () => {
    const harness = mutableScope()
    const controller = new GithubReviewerCardController(harness.scope, reviewerApi())
    const face = controller.inject()

    face.edit('workspaceTitle', 'Draft')
    harness.publish({ writable: false })

    const snapshot = face.hooks.githubReviewerCard.getSnapshot()
    expect(snapshot.writable).toBe(false)
    expect(snapshot.fields.workspaceTitle.text).toBe('Draft')
    await controller.dispose()
  })

  it('adopts canonical Host values after a successful save', async () => {
    const saved = { ...value, workspaceTitle: 'Canonical title' }
    const mutate = vi.fn(async () => successResponse(saved))
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate))
    const face = controller.inject()

    face.edit('workspaceTitle', '  Canonical title  ')
    face.save()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().dirty).toBe(false))

    expect(face.hooks.githubReviewerCard.getSnapshot().fields.workspaceTitle.text).toBe('Canonical title')
    await controller.dispose()
  })

  it('saves an empty repository list', async () => {
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate))
    const face = controller.inject()

    face.removeRepository(0)
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))

    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      ops: [{ op: 'set', path: ['repositories'], value: [] }],
    })
    await controller.dispose()
  })

  it('blocks save while a repository row is incomplete', async () => {
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate))
    const face = controller.inject()

    face.addRepository()
    face.editRepository(1, 'owner', 'incomplete')
    face.save()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(face.hooks.githubReviewerCard.getSnapshot().repositories.invalid).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('moves model candidates and saves their priority order', async () => {
    const configured: ReviewerSettings = {
      ...value,
      review: {
        ...value.review,
        models: [
          { provider: 'openai', model: 'gpt' },
          { provider: 'deepseek', model: 'chat' },
          { provider: 'openai', model: 'mini' },
        ],
      },
    }
    const reordered: ReviewerSettings = {
      ...configured,
      review: {
        ...configured.review,
        models: [
          { provider: 'deepseek', model: 'chat' },
          { provider: 'openai', model: 'mini' },
          { provider: 'openai', model: 'gpt' },
        ],
      },
    }
    const mutate = vi.fn(async () => successResponse(reordered))
    const controller = new GithubReviewerCardController(scope({}, configured), reviewerApi(mutate))
    const face = controller.inject()

    face.moveModel(0, 2)
    expect(face.hooks.githubReviewerCard.getSnapshot().models.rows).toEqual(reordered.review.models)
    face.moveModel(2, 2)
    face.moveModel(-1, 1)
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))

    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      ops: [{ op: 'set', path: ['review', 'models'], value: reordered.review.models }],
    })
    await controller.dispose()
  })

  it('loads configured models and changes model when provider changes', async () => {
    const mutate = vi.fn(async () => successResponse())
    const models = vi.fn(reviewerApi().llm.models)
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate, models))
    const face = controller.inject()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().modelCatalog.groups).toHaveLength(2))

    face.addModel()
    expect(face.hooks.githubReviewerCard.getSnapshot().models.rows).toEqual([{ provider: 'openai', model: 'gpt' }])
    face.editModelProvider(0, 'deepseek')
    expect(face.hooks.githubReviewerCard.getSnapshot().models.rows).toEqual([{ provider: 'deepseek', model: 'chat' }])
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))

    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      ops: [{ op: 'set', path: ['review', 'models'], value: [{ provider: 'deepseek', model: 'chat' }] }],
    })
    await controller.dispose()
  })

  it('keeps the last model catalog when a refresh fails', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce(reviewerApi().llm.models())
      .mockResolvedValueOnce({ id: 2, result: { ok: false, error: { code: 'failed', message: 'offline' } } })
    const controller = new GithubReviewerCardController(scope(), reviewerApi(undefined, models))
    const face = controller.inject()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().modelCatalog.groups).toHaveLength(2))

    await controller.refreshModelCatalog()

    const catalog = face.hooks.githubReviewerCard.getSnapshot().modelCatalog
    expect(catalog.groups).toHaveLength(2)
    expect(catalog.error).toBe('offline')
    await controller.dispose()
  })

  it('uses unset to restore a field to the composition base', async () => {
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(scope({ workspaceTitle: 'Custom' }), reviewerApi(mutate))
    const face = controller.inject()

    face.reset('workspaceTitle')
    face.save()
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))

    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      ops: [{ op: 'unset', path: ['workspaceTitle'] }],
      expectedRevision: 7,
    })
    await controller.dispose()
  })

  it('lazy-loads the repository catalog once without touching staged rows or dirty state', async () => {
    let resolveCatalog: ((value: { repositories: Array<{ owner: string; repository: string; fullName: string; private: boolean }> }) => void) | undefined
    const loadCatalog = vi.fn(() => new Promise<{ repositories: Array<{ owner: string; repository: string; fullName: string; private: boolean }> }>((resolve) => {
      resolveCatalog = resolve
    }))
    const controller = new GithubReviewerCardController(scope(), reviewerApi(), loadCatalog)
    const face = controller.inject()

    face.ensureRepositoryCatalog()
    face.ensureRepositoryCatalog()
    face.editRepository(0, 'repository', 'draft')
    expect(loadCatalog).toHaveBeenCalledTimes(1)
    resolveCatalog?.({ repositories: [{ owner: 'owner', repository: 'repo', fullName: 'owner/repo', private: false }] })
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().repositoryCatalog.loaded).toBe(true))

    const snapshot = face.hooks.githubReviewerCard.getSnapshot()
    expect(snapshot.repositories.rows).toEqual([{ owner: 'owner', repository: 'draft' }])
    expect(snapshot.dirty).toBe(true)
    controller.invalidateRepositoryCatalog()
    const invalidated = face.hooks.githubReviewerCard.getSnapshot()
    expect(invalidated.repositoryCatalog).toEqual({ loading: false, loaded: false, error: null, repositories: [] })
    expect(invalidated.repositories.rows).toEqual([{ owner: 'owner', repository: 'draft' }])
    expect(invalidated.dirty).toBe(true)
    await controller.dispose()
  })

  it('reports repository catalog failure without affecting manual edits or retry', async () => {
    const loadCatalog = vi.fn()
      .mockResolvedValueOnce({
        repositories: [{ owner: 'old', repository: 'repo', fullName: 'old/repo', private: false }],
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ repositories: [] })
    const controller = new GithubReviewerCardController(scope(), reviewerApi(), loadCatalog)
    const face = controller.inject()

    face.ensureRepositoryCatalog()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().repositoryCatalog.loaded).toBe(true))
    face.retryRepositoryCatalog()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().repositoryCatalog.error).toBe('offline'))
    expect(face.hooks.githubReviewerCard.getSnapshot().repositoryCatalog.repositories).toEqual([])
    face.ensureRepositoryCatalog()
    expect(loadCatalog).toHaveBeenCalledTimes(2)
    face.editRepository(0, 'owner', 'manual')
    expect(face.hooks.githubReviewerCard.getSnapshot().repositories.rows[0]?.owner).toBe('manual')

    face.retryRepositoryCatalog()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().repositoryCatalog.loaded).toBe(true))
    expect(loadCatalog).toHaveBeenCalledTimes(3)
    await controller.dispose()
  })

  it('fences late repository catalog generations', async () => {
    const resolvers: Array<(value: { repositories: Array<{ owner: string; repository: string; fullName: string; private: boolean }> }) => void> = []
    const loadCatalog = vi.fn(() => new Promise<{ repositories: Array<{ owner: string; repository: string; fullName: string; private: boolean }> }>((resolve) => {
      resolvers.push(resolve)
    }))
    const controller = new GithubReviewerCardController(scope(), reviewerApi(), loadCatalog)
    const face = controller.inject()

    const first = controller.refreshRepositoryCatalog()
    const second = controller.refreshRepositoryCatalog()
    resolvers[1]?.({ repositories: [{ owner: 'new', repository: 'repo', fullName: 'new/repo', private: false }] })
    await second
    resolvers[0]?.({ repositories: [{ owner: 'stale', repository: 'repo', fullName: 'stale/repo', private: false }] })
    await first

    expect(face.hooks.githubReviewerCard.getSnapshot().repositoryCatalog.repositories[0]?.owner).toBe('new')
    face.editRepository(0, 'owner', 'manual')
    expect(face.hooks.githubReviewerCard.getSnapshot().repositories.rows[0]?.owner).toBe('manual')
    await controller.dispose()
  })

  it('preserves a draft when the Host rejects the batch', async () => {
    const mutate = vi.fn(async () => ({
      id: 1,
      result: { ok: false as const, error: { code: 'settings-conflict', message: 'conflict' } },
    }))
    const controller = new GithubReviewerCardController(scope(), reviewerApi(mutate))
    const face = controller.inject()

    face.edit('workspaceTitle', 'Draft title')
    face.save()
    await vi.waitFor(() => expect(face.hooks.githubReviewerCard.getSnapshot().failed).toBe(true))

    const state = face.hooks.githubReviewerCard.getSnapshot()
    expect(state.dirty).toBe(true)
    expect(state.fields.workspaceTitle.text).toBe('Draft title')
    await controller.dispose()
  })
})
