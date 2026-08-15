/**
 * Wrap the tsdown ESM client bundle into the DSH Web client-loader format:
 * `window.__ModuleLoader__.load({ id, factory })`.
 *
 * Pattern follows the community standard (dsh-plugin-deepseek-balance, MIT).
 * The browser-side module system executes the bundle as a classic script and
 * requires it to REGISTER a factory under its package id; the factory receives
 * a synchronous `require` that resolves platform seeds (react, shell modules).
 */

import { readFile, writeFile } from 'node:fs/promises'

const ID = 'dsh-wechat-bridge'
const FILE = 'lib/client.js'

let src = await readFile(FILE, 'utf8')

const mapLine = src.match(/\/\/#\s*sourceMappingURL=.*$/m)?.[0] ?? ''
src = src.replace(/\/\/#\s*sourceMappingURL=.*$/m, '').trimEnd()

function toRequire(clause, spec) {
  const s = JSON.stringify(spec)
  const trimmed = clause.trim()
  if (trimmed.startsWith('* as ')) {
    return `var ${trimmed.slice(5).trim()} = require(${s});`
  }
  if (trimmed.startsWith('{')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner.length === 0) return `require(${s});`
    const pairs = inner
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [from, to] = part.split(/\s+as\s+/)
        return `${(to ?? from).trim()}: ${from.trim()}`
      })
    return `var { ${pairs.join(', ')} } = require(${s});`
  }
  return `var ${trimmed} = require(${s}).default ?? require(${s});`
}

// 1. Convert top-level imports into factory require() calls.
const importRe = /^import\s+([^;]+?)\s+from\s+["']([^"']+)["'];?\s*$/gm
const requires = []
src = src.replace(importRe, (match, clause, spec) => {
  requires.push(toRequire(clause, spec))
  return ''
})

// 2. Convert the trailing export list into CommonJS exports assignments.
const exportRe = /^export\s+\{\s*([^}]+?)\s*\};?\s*$/m
src = src.replace(exportRe, (match, names) =>
  names
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => `exports.${name} = ${name};`)
    .join('\n'),
)

function indent(text, level) {
  const pad = '\t'.repeat(level)
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n')
}

const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${requires.map((line) => '\t\t' + line).join('\n')}
${indent(src, 2)}
\t\treturn module.exports;
\t}
});
`

await writeFile(FILE, wrapped + (mapLine ? `\n${mapLine}` : ''))
console.log(`wrapped ${FILE} for __ModuleLoader__ id "${ID}"`)
