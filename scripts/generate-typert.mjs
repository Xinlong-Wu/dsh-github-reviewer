import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = 'dsh-github-reviewer'
const temporary = await mkdtemp(join(tmpdir(), 'dsh-github-reviewer-typert-'))
const packageRoot = join(temporary, 'packages', packageName)

const protocolDeclaration = `declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertLookup<Host, Wire> {
    readonly host: Host
    readonly wire: Wire
  }

  export interface TypertContext<Wire> {
    readonly wire: Wire
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}

  export interface RemoteFailure {
    readonly code: string
    readonly message: string
    readonly details: object
  }

  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  export type TypertRemoteNamespace<Namespace extends string> = {
    [Endpoint in keyof TypertRemoteMap as Endpoint extends \`${'${Namespace}'}\/${'${infer Method}'}\`
      ? Method
      : never]: TypertRemoteMap[Endpoint]
  }

  export interface TypertRemoteNamespaceMap {}

  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }

  export abstract class TypertRemoteService {
    readonly typertRemote: {
      readonly service: TypertRemoteService
      readonly serviceKey: string
      readonly namespace: string
    }
    protected constructor(
      ctx: unknown,
      serviceKey: string,
      options?: { readonly namespace?: string },
    )
  }

  export function bindTypertRemote<Service extends object>(
    service: Service,
    serviceKey: string,
    options?: { readonly namespace?: string },
  ): { readonly service: Service; readonly serviceKey: string; readonly namespace: string }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function Remote(exportName: string):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  export function RemoteScope(key: Extract<keyof TypertContextMap, string>, exportName?: string):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
`

try {
  await mkdir(packageRoot, { recursive: true })
  await cp(join(root, 'src'), join(packageRoot, 'src'), { recursive: true })
  await cp(join(root, 'package.json'), join(packageRoot, 'package.json'))
  await cp(join(root, 'tsconfig.json'), join(packageRoot, 'tsconfig.json'))
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir')
  await writeFile(join(temporary, 'typert-protocol.d.ts'), protocolDeclaration)
  await writeFile(join(temporary, 'tsconfig.host.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2023', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./typert-protocol.d.ts'],
      },
      types: ['node'],
    },
    files: [],
    references: [{ path: `./packages/${packageName}/tsconfig.json` }],
  }, null, 2)}\n`)

  const artifacts = new WorkspaceTypertGenerator(temporary).generate([packageName], ['host'])
  const artifact = artifacts.find(candidate => candidate.package === packageName && candidate.face === 'host')
  if (artifact === undefined) throw new Error(`missing Host Typert artifact for ${packageName}`)
  if (artifact.remote === undefined) throw new Error(`missing Remote Typert artifact for ${packageName}`)

  const output = join(root, 'lib')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'typert.host.js'), artifact.js)
  await writeFile(join(output, 'typert.host.d.ts'), artifact.dts)
  await writeFile(join(output, 'typert.remote-client.js'), artifact.remote.js)
  await writeFile(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
  await writeFile(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)

  const declaration = await readFile(join(output, 'typert.remote-client.d.ts'), 'utf8')
  if (!declaration.includes('githubReviewerCatalog')) {
    throw new Error('generated Remote declaration does not include githubReviewerCatalog')
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
