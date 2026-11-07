/** Editable configuration page for the github-reviewer bundle row. */

// Type-only: pulls the 'plugins.row.config' SlotMap merge (view + form props).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GithubReviewerConfigFormSection } from './ConfigFormSection.tsx'

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
    readonly form?: {
      readonly state: {
        readonly status: 'loading' | 'ready' | 'unavailable'
        readonly value?: Record<string, unknown>
        readonly revision?: number
        readonly writable?: boolean
      }
      mutate(
        ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
        expectedRevision?: number,
      ): Promise<boolean>
    } | undefined
  }

/** Render the summary one-liner or the editable page for the bundle row. */
export function GithubReviewerRowConfigPage(props: GithubReviewerRowConfigProps) {
  const snapshot = props.form?.state

  if (props.view === 'summary') {
    const count = snapshot?.value === undefined ? undefined
      : Array.isArray(snapshot.value.repositories) ? snapshot.value.repositories.length : undefined
    return <>{count === undefined ? '' : props.t('repositoriesSummary').replace('%1', String(count))}</>
  }

  if (props.form === undefined || snapshot === undefined || snapshot.status !== 'ready' || snapshot.value === undefined) {
    return <p className="ghr-note">{props.t('unavailable')}</p>
  }

  return (
    <>
      <h3 className="ghr-heading">{props.t('configSection')}</h3>
      <GithubReviewerConfigFormSection snapshot={snapshot} mutate={props.form.mutate} t={props.t} />
    </>
  )
}
