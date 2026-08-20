/** JSON fields shared by the Host settings namespace and browser card. */

export interface ReviewerSettingsModel {
  provider: string
  model: string
}

export interface ReviewerSettingsReview {
  maxToolCalls: number
  toolTimeoutMs: number
  toolResultLimit: number
  timeoutMs: number
  defaultInstructions: string
  commandAuthorAssociations: string[]
  models: ReviewerSettingsModel[]
}

/** Non-secret account fields that the optional Web settings card may override. */
export interface ReviewerSettings {
  pollIntervalMs: number
  repositories: string[]
  workspaceDir: string
  workspaceTitle: string
  review: ReviewerSettingsReview
}
