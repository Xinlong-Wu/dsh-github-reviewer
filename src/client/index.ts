/** Browser registration for the GitHub reviewer settings card. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ReviewerSettings } from '../settings-contract.ts'
import { GithubReviewerCard } from './GithubReviewerCard.tsx'
import { GithubReviewerCardController, SETTINGS_NAMESPACE } from './controller.ts'
import { en, zh } from './locales.ts'

const LOCALE_NAMESPACE = 'settings.githubReviewer'

const styles = `
.ghr-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:18px;background:var(--dsw-alias-bg-layer-1);display:grid;gap:16px}
.ghr-header h3{margin:0;color:var(--dsw-alias-label-primary);font-size:16px}.ghr-header p,.ghr-hint{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.ghr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.ghr-field{display:grid;gap:6px}.ghr-field-head{display:flex;align-items:center;gap:8px}.ghr-field-head label{font-weight:600;color:var(--dsw-alias-label-primary);margin-right:auto}
.ghr-field input,.ghr-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}.ghr-field textarea{resize:vertical}.ghr-field [aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.ghr-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}.ghr-badge-muted{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ghr-field button,.ghr-actions button{border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer}.ghr-actions{display:flex;justify-content:flex-end;gap:8px}.ghr-actions .ghr-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}button:disabled{opacity:.5;cursor:not-allowed}.ghr-invalid,.ghr-warning{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px}
`

/** Required browser services; an incomplete Web composition leaves only this Client companion pending. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Register locale, styles, the settings controller, and the keyed card slot. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<ReviewerSettings>({ namespace: SETTINGS_NAMESPACE })
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new GithubReviewerCardController(scope, api.settings)
  ctx.effect(() => () => controller.dispose(), 'github-reviewer settings controller')
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'github-reviewer settings locale')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-github-reviewer'
    tag.textContent = styles
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'github-reviewer settings styles')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NAMESPACE,
    locale: LOCALE_NAMESPACE,
    inject: () => controller.inject(),
  }, GithubReviewerCard))
}
