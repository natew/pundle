/* @flow */

// TODO: Implement HMR specific stuff
import type { ModuleNormal } from '../types'

const global = (typeof window !== 'undefined' && window) || (typeof self !== 'undefined' && self) || {}
const GLOBAL = global
const root = global

const __sbPundle = {
  defaultExport: {},
  cache: {},
  extensions: [],
  resolve(path) {
    return path
  },
  resolutionMap: {},
  registerMappings(mappings) {
    for (const key in mappings) {
      mappings[key].forEach(value => {
        this.resolutionMap[value] = key
      })
    }
  },
  registerModule(moduleId, callback) {
    if (this.cache[moduleId]) {
      this.cache[moduleId].callback = callback
    } else {
      this.cache[moduleId] = {
        id: moduleId,
        callback,
        exports: this.defaultExport,
        parents: [],
      }
    }
  },
  requireModule(fromModule: string, givenRequest: string) {
    const request = this.resolutionMap[givenRequest] || givenRequest
    const module: ?ModuleNormal = this.cache[request]
    if (!module) {
      throw new Error('Module not found')
    }
    if (module.parents.indexOf(fromModule) === -1 && fromModule !== '$root') {
      module.parents.push(fromModule)
    }
    if (module.exports === this.defaultExport) {
      module.exports = {}
      module.callback.call(module.exports, module.id, '/', this.generateRequire(fromModule), module, module.exports)
    }
    return module.exports
  },
  generateRequire(fromModule: string) {
    const require = this.requireModule.bind(this, fromModule)
    require.cache = this.cache
    require.extensions = this.extensions
    require.resolve = this.resolve
    return require
  },
  require(request: string) {
    return this.requireModule('$root', request)
  },
}