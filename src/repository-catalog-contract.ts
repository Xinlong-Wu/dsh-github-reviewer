/** JSON fields shared by the Host repository catalog Remote and browser settings card. */

/** One GitHub repository visible to the configured reviewer credential. */
export interface AccessibleRepository {
  owner: string
  repository: string
  fullName: string
  private: boolean
}

/** Complete repository catalog returned to the browser. */
export interface RepositoryCatalog {
  repositories: AccessibleRepository[]
}
