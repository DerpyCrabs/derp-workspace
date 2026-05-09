import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const schemaDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(schemaDir, '..')
const schema = JSON.parse(readFileSync(path.join(schemaDir, 'schema.json'), 'utf8'))
const check = process.argv.includes('--check')

function pascal(name, prefix) {
  return name
    .replace(prefix, '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
}

function rustValue(value) {
  return String(value)
}

function tsValue(value) {
  return String(value)
}

function byteArray(bytes) {
  return `[${bytes.map((value) => `0x${value.toString(16).padStart(2, '0')}`).join(', ')}]`
}

function scalarConstRust(item) {
  return `pub const ${item.name}: ${item.rustType ?? 'u32'} = ${rustValue(item.value)};`
}

function scalarConstTs(item) {
  return `export const ${item.name} = ${tsValue(item.value)} as const`
}

function renderRustItem(item) {
  if (item.kind === 'struct') {
    return [
      `#[derive(${item.derives.join(', ')})]`,
      `pub struct ${item.name} {`,
      ...item.fields.map((field) => `    pub ${field.name}: ${field.type},`),
      '}',
    ].join('\n')
  }
  if (item.kind === 'enum') {
    const lines = [`#[derive(${item.derives.join(', ')})]`, `pub enum ${item.name} {`]
    for (const variant of item.variants) {
      if (variant.fields) {
        lines.push(`    ${variant.name} {`)
        for (const field of variant.fields) lines.push(`        ${field.name}: ${field.type},`)
        lines.push('    },')
      } else if (variant.tuple) {
        lines.push(`    ${variant.name}(${variant.tuple.join(', ')}),`)
      } else {
        lines.push(`    ${variant.name},`)
      }
    }
    lines.push('}')
    return lines.join('\n')
  }
  throw new Error(`unknown Rust item kind: ${item.kind}`)
}

function rustEnum(name, repr, values, prefix) {
  return [
    '#[derive(Clone, Copy, Debug, Eq, PartialEq)]',
    `#[repr(${repr})]`,
    `pub enum ${name} {`,
    ...values.map((item) => `    ${pascal(item.name, prefix)} = ${rustValue(item.value)},`),
    '}',
  ].join('\n')
}

function tsObject(name, values) {
  return [
    `export const ${name} = {`,
    ...values.map((item) => `  ${item.name}: ${item.name},`),
    '} as const',
  ].join('\n')
}

function tsType(name, objectName) {
  return `export type ${name} = (typeof ${objectName})[keyof typeof ${objectName}]`
}

function generatedConstants() {
  const snapshot = [schema.snapshot.magic, schema.snapshot.chunksMagic, ...schema.snapshot.domains, ...schema.snapshot.sizes]
  const hot = [...schema.hotBatch.tags, ...schema.hotBatch.sizes]
  const sharedState = [
    schema.sharedState.magic,
    ...schema.sharedState.kinds,
    ...schema.sharedState.sizes,
  ]
  return [...schema.messages, ...snapshot, ...schema.scalars, ...schema.byteSizes, ...hot, ...sharedState]
}

function groupedScalars(group) {
  return schema.scalars.filter((item) => item.group === group)
}

function renderRust() {
  if (schema.snapshot.sizes.find((item) => item.name === 'SHELL_SNAPSHOT_DOMAIN_COUNT')?.value !== schema.snapshot.domains.length) {
    throw new Error('SHELL_SNAPSHOT_DOMAIN_COUNT does not match snapshot domain list')
  }
  if (schema.snapshot.sizes.find((item) => item.name === 'SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES')?.value !== schema.snapshot.domains.length * 8) {
    throw new Error('SHELL_SNAPSHOT_DOMAIN_REVISION_BYTES does not match snapshot domain list')
  }
  const lines = []
  for (const item of schema.rustTypes ?? []) {
    lines.push(renderRustItem(item))
    lines.push('')
  }
  lines.push(rustEnum('ShellWireMessage', 'u32', schema.messages, 'MSG_'))
  lines.push('')
  lines.push(rustEnum('ShellSnapshotDomain', 'u32', schema.snapshot.domains, 'SHELL_SNAPSHOT_DOMAIN_'))
  lines.push('')
  lines.push(rustEnum('HotBatchTag', 'u8', schema.hotBatch.tags, 'HOT_DETAIL_'))
  lines.push('')
  for (const item of schema.messages) lines.push(scalarConstRust({ ...item, rustType: 'u32' }))
  lines.push('')
  for (const item of schema.snapshot.domains) lines.push(scalarConstRust({ ...item, rustType: 'u32' }))
  for (const item of [schema.snapshot.magic, schema.snapshot.chunksMagic, ...schema.snapshot.sizes]) lines.push(scalarConstRust(item))
  lines.push('')
  lines.push(`pub const ${schema.hotBatch.magic.name}: [u8; ${schema.hotBatch.magic.bytes.length}] = ${byteArray(schema.hotBatch.magic.bytes)};`)
  for (const item of schema.hotBatch.tags) lines.push(scalarConstRust({ ...item, rustType: 'u8' }))
  for (const item of schema.hotBatch.sizes) lines.push(scalarConstRust(item))
  lines.push('')
  for (const item of [schema.sharedState.magic, ...schema.sharedState.kinds, ...schema.sharedState.sizes]) lines.push(scalarConstRust(item))
  lines.push('')
  for (const item of schema.scalars) lines.push(scalarConstRust(item))
  lines.push('')
  for (const item of schema.byteSizes) lines.push(scalarConstRust(item))
  lines.push('')
  lines.push(`pub const SHELL_WIRE_MESSAGE_VALUES: &[u32] = &[${schema.messages.map((item) => item.name).join(', ')}];`)
  lines.push(`pub const SHELL_SNAPSHOT_DOMAIN_VALUES: &[u32] = &[${schema.snapshot.domains.map((item) => item.name).join(', ')}];`)
  lines.push(`pub const HOT_BATCH_TAG_VALUES: &[u8] = &[${schema.hotBatch.tags.map((item) => item.name).join(', ')}];`)
  lines.push(`pub const SHELL_SHARED_STATE_KIND_VALUES: &[u32] = &[${schema.sharedState.kinds.map((item) => item.name).join(', ')}];`)
  lines.push('')
  return `${lines.join('\n')}`
}

function renderTs() {
  const lines = []
  for (const item of schema.tsImports ?? []) lines.push(item)
  if ((schema.tsImports ?? []).length > 0) lines.push('')
  for (const item of generatedConstants()) lines.push(scalarConstTs(item))
  lines.push(`export const ${schema.hotBatch.magic.name} = ${byteArray(schema.hotBatch.magic.bytes)} as const`)
  lines.push('')
  lines.push(tsObject('SHELL_WIRE_MESSAGES', schema.messages))
  lines.push(tsType('ShellWireMessage', 'SHELL_WIRE_MESSAGES'))
  lines.push('')
  lines.push(tsObject('SHELL_SNAPSHOT_DOMAINS', schema.snapshot.domains))
  lines.push(tsType('ShellSnapshotDomain', 'SHELL_SNAPSHOT_DOMAINS'))
  lines.push('')
  lines.push(tsObject('HOT_BATCH_TAGS', schema.hotBatch.tags))
  lines.push(tsType('HotBatchTag', 'HOT_BATCH_TAGS'))
  lines.push('')
  lines.push(tsObject('SHELL_SHARED_STATE_KINDS', schema.sharedState.kinds))
  lines.push(tsType('ShellSharedStateKind', 'SHELL_SHARED_STATE_KINDS'))
  lines.push('')
  lines.push(tsObject('WIRE_BYTE_SIZES', [...schema.snapshot.sizes, ...schema.hotBatch.sizes, ...schema.sharedState.sizes, ...schema.byteSizes]))
  lines.push(tsType('WireByteSize', 'WIRE_BYTE_SIZES'))
  lines.push('')
  lines.push(tsObject('TOUCH_PHASES', groupedScalars('touchPhases')))
  lines.push(tsType('TouchPhase', 'TOUCH_PHASES'))
  lines.push('')
  lines.push(tsObject('RESIZE_EDGES', groupedScalars('resizeEdges')))
  lines.push(tsType('ResizeEdge', 'RESIZE_EDGES'))
  lines.push('')
  lines.push(tsObject('CEF_KEY_EVENTS', groupedScalars('cefKeyEvents')))
  lines.push(tsType('CefKeyEventType', 'CEF_KEY_EVENTS'))
  lines.push('')
  lines.push(tsObject('TASKBAR_SIDES', groupedScalars('taskbarSides')))
  lines.push(tsType('TaskbarSide', 'TASKBAR_SIDES'))
  lines.push('')
  for (const item of schema.tsTypes ?? []) {
    lines.push(item.source)
    lines.push('')
  }
  return `${lines.join('\n')}`
}

function writeOrCheck(file, content) {
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (current !== content) {
      process.stderr.write(`wire schema: generated file is stale: ${path.relative(repoRoot, file).replace(/\\/g, '/')}\n`)
      process.exitCode = 1
    }
    return
  }
  writeFileSync(file, content)
}

writeOrCheck(path.join(repoRoot, 'shell_wire', 'src', 'wire_schema_generated.rs'), renderRust())
writeOrCheck(path.join(repoRoot, 'shell', 'src', 'features', 'bridge', 'wireSchema.generated.ts'), renderTs())
