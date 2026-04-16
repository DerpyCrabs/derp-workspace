import { describe, expect, it } from 'vitest'
import {
  clearPrimedFileBrowserWindowPath,
  consumeFileBrowserWindowPath,
  primeFileBrowserWindowPath,
} from './fileBrowserState'

describe('fileBrowserWindowPath priming', () => {
  it('consumes the primed path once per window id', () => {
    primeFileBrowserWindowPath(9201, '/tmp/fixture/nested/media')
    expect(consumeFileBrowserWindowPath(9201)).toBe('/tmp/fixture/nested/media')
    expect(consumeFileBrowserWindowPath(9201)).toBe(null)
  })

  it('clears primed path without consuming', () => {
    primeFileBrowserWindowPath(9202, '/a/b')
    clearPrimedFileBrowserWindowPath(9202)
    expect(consumeFileBrowserWindowPath(9202)).toBe(null)
  })

  it('does not overwrite a non-null primed path with null', () => {
    primeFileBrowserWindowPath(9203, '/tmp/a')
    primeFileBrowserWindowPath(9203, null)
    expect(consumeFileBrowserWindowPath(9203)).toBe('/tmp/a')
  })
})
