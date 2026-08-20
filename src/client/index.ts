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
.ghr-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}.ghr-card:hover,.ghr-card-open{border-color:var(--dsw-alias-label-dimmed)}.ghr-card-open{background:var(--dsw-alias-bg-layer-2)}
.ghr-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}.ghr-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.ghr-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.ghr-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}.ghr-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}.ghr-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}.ghr-chevron-open{transform:rotate(180deg)}.ghr-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.ghr-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:14px 0 8px;display:grid;gap:16px}.ghr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.ghr-field{display:grid;gap:6px}.ghr-field-head{display:flex;align-items:center;gap:8px}.ghr-field-head>label,.ghr-field-head h4{font:inherit;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 auto 0 0}
.ghr-field input,.ghr-field textarea,.ghr-field select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit}.ghr-field textarea{resize:vertical}.ghr-field [aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}.ghr-collection{grid-column:1/-1}.ghr-rows{display:grid;gap:8px}.ghr-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end;border-radius:8px}.ghr-model-row{grid-template-columns:auto minmax(0,1fr) minmax(0,1fr) auto;padding:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);box-shadow:0 1px 2px rgba(0,0,0,.08);transition:opacity .12s,background .12s,border-color .12s,box-shadow .12s}.ghr-model-row-dragging{opacity:.45}.ghr-model-row-target{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-brand-primary),0 10px 28px rgba(0,0,0,.2)}.ghr-row label{display:grid;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px}.ghr-empty{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:12px}.ghr-collection-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ghr-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}.ghr-badge-muted{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}.ghr-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ghr-field button,.ghr-actions button,.ghr-warning button{border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer}.ghr-field .ghr-icon-button,.ghr-field .ghr-drag-handle{width:30px;height:30px;padding:0;display:inline-flex;align-items:center;justify-content:center}.ghr-drag-handle{align-self:end;color:var(--dsw-alias-label-tertiary);cursor:grab}.ghr-drag-handle:active{cursor:grabbing}.ghr-icon-button:focus-visible,.ghr-drag-handle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.ghr-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}.ghr-actions .ghr-warning{margin-right:auto}.ghr-actions .ghr-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.ghr-card button:disabled,.ghr-card input:disabled,.ghr-card textarea:disabled,.ghr-card select:disabled{opacity:.5;cursor:not-allowed}.ghr-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}.ghr-invalid,.ghr-warning{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px}
@media(max-width:720px){.ghr-row{grid-template-columns:1fr}.ghr-model-row{grid-template-columns:auto 1fr}.ghr-model-row label{grid-column:1/-1}.ghr-drag-handle,.ghr-remove{justify-self:start}.ghr-collection-footer{align-items:flex-start;flex-direction:column}}
`

/** Required browser services; an incomplete Web composition leaves only this Client companion pending. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Register locale, styles, the settings controller, and the keyed card slot. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<ReviewerSettings>({ namespace: SETTINGS_NAMESPACE })
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new GithubReviewerCardController(scope, api)
  ctx.effect(() => () => controller.dispose(), 'github-reviewer settings controller')
  ctx.effect(() => {
    const refresh = (): void => { void controller.refreshModelCatalog() }
    const disposers = [
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'github-reviewer model catalog invalidations')
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
