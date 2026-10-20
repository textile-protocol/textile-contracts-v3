import { expect } from 'chai'
import { existsSync, readdirSync, readFileSync } from 'fs'
import path from 'path'

// The vendored UniswapX reactor is GPL-2.0-or-later and pulls in AGPL-3.0-only
// solmate. Any Textile file compiled together with that code has to be under a
// GPL-compatible license, so those files are GPL-2.0-or-later. Files that never
// touch it may stay BUSL-1.1. See contracts/v3/filler/vendor/VENDORED.md.

const PROTOCOL_DIR = path.resolve(__dirname, '../../..')
const SOURCE_DIRS = ['contracts/v3', 'test/foundry/v3'].map((dir) =>
  path.join(PROTOCOL_DIR, dir)
)
const VENDOR_DIR = path.join(PROTOCOL_DIR, 'contracts/v3/filler/vendor')

const solidityFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return solidityFiles(full)
    return entry.name.endsWith('.sol') ? [full] : []
  })

const spdx = (file: string): string | undefined =>
  readFileSync(file, 'utf8').match(/SPDX-License-Identifier:\s*(\S+)/)?.[1]

const isCopyleft = (license: string | undefined): boolean =>
  /GPL/.test(license ?? '')

const relativeImports = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /^\s*import\b[^;]*?["']([^"']+)["']/gm
    ),
  ]
    .map((m) => m[1])
    .filter((importPath) => importPath.startsWith('.'))
    .map((importPath) => path.resolve(path.dirname(file), importPath))

const importClosure = (file: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(file)) return seen
  seen.add(file)
  relativeImports(file).forEach((imported) => importClosure(imported, seen))
  return seen
}

const relative = (file: string): string => path.relative(PROTOCOL_DIR, file)

describe('v3 license boundary', () => {
  const files = SOURCE_DIRS.flatMap(solidityFiles)

  // Checked per compilation unit, both ways: a BUSL file must not pull in GPL or
  // AGPL code, and a GPL file must not pull in a BUSL file.
  it('never compiles BUSL and GPL or AGPL code together', () => {
    const offenders = files.flatMap((file) => {
      const unit = [...importClosure(file)]
      const busl = unit.filter((member) => spdx(member) === 'BUSL-1.1')
      const copyleft = unit.filter((member) => isCopyleft(spdx(member)))
      if (busl.length === 0 || copyleft.length === 0) return []
      return [
        `${relative(file)}: BUSL ${busl.map(relative).join(', ')} with ` +
          `${copyleft.length} GPL/AGPL file(s)`,
      ]
    })
    expect(offenders).to.deep.equal([])
  })

  it('licenses the FX contracts under GPL-2.0-or-later', () => {
    const fxContracts = [
      'contracts/v3/filler/SellFirstFeeController.sol',
      'contracts/v3/filler/PreferredFillerValidation.sol',
      'contracts/v3/filler/vault/OperatorVault.sol',
      'contracts/v3/filler/vault/OperatorVaultFactory.sol',
      'contracts/v3/filler/vault/VaultOrderExecutor.sol',
    ]
    const licenses = fxContracts.map((file) =>
      spdx(path.join(PROTOCOL_DIR, file))
    )
    expect(licenses).to.deep.equal(fxContracts.map(() => 'GPL-2.0-or-later'))
  })

  it('ships the license text for every license in use', () => {
    const texts = [
      'licenses/BUSL_LICENSE',
      'licenses/GPL_LICENSE',
      'contracts/v3/filler/vendor/uniswapx/LICENSE',
      'contracts/v3/filler/vendor/solmate/LICENSE',
      'contracts/v3/filler/vendor/permit2/LICENSE',
    ]
    const missing = texts.filter(
      (text) => !existsSync(path.join(PROTOCOL_DIR, text))
    )
    expect(missing).to.deep.equal([])
  })

  // The public export ships public-repo/package.json as its root package.json,
  // next to GPL_LICENSE as its root LICENSE. Registries read the license field.
  it('publishes the swap package under its root license', () => {
    const publishedManifest = [
      path.join(PROTOCOL_DIR, 'public-repo/package.json'),
      path.join(PROTOCOL_DIR, 'package.json'),
    ].find((manifest) => existsSync(manifest)) as string
    const { license } = JSON.parse(readFileSync(publishedManifest, 'utf8'))
    expect(license).to.equal('GPL-2.0-or-later')
  })

  it('keeps upstream licenses on vendored code', () => {
    const expected: Record<string, string[]> = {
      uniswapx: ['GPL-2.0-or-later'],
      solmate: ['AGPL-3.0-only'],
      permit2: ['MIT'],
    }
    for (const [dependency, licenses] of Object.entries(expected)) {
      const found = new Set(
        solidityFiles(path.join(VENDOR_DIR, dependency)).map(spdx)
      )
      expect([...found], dependency).to.have.members(licenses)
    }
  })
})
