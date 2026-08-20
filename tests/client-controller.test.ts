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

function scope(user: unknown = {}): SettingsScope<ReviewerSettings> {
  const snapshot: SettingsScopeSnapshot<ReviewerSettings> = {
    status: 'ready',
    value,
    base: value,
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

function successResponse() {
  return {
    id: 1,
    result: {
      ok: true as const,
      value: {
        ns: 'github-reviewer',
        value,
        base: value,
        user: {},
        revision: 8,
        schema: {},
        secrets: {},
        applies: 'live' as const,
      },
    },
  }
}

describe('GithubReviewerCardController', () => {
  it('submits staged field edits in one revision-fenced batch', async () => {
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(scope(), { mutate } as never)
    const face = controller.inject()

    face.edit('repositories', 'one/repo\ntwo/repo')
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

  it('uses unset to restore a field to the composition base', async () => {
    const mutate = vi.fn(async () => successResponse())
    const controller = new GithubReviewerCardController(scope({ workspaceTitle: 'Custom' }), { mutate } as never)
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

  it('preserves a draft when the Host rejects the batch', async () => {
    const mutate = vi.fn(async () => ({
      id: 1,
      result: { ok: false as const, error: { code: 'settings-conflict', message: 'conflict' } },
    }))
    const controller = new GithubReviewerCardController(scope(), { mutate } as never)
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
