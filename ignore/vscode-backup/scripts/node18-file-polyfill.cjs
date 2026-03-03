/* eslint-disable no-undef */
if (typeof globalThis.File === 'undefined') {
  class FilePolyfill extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options)
      this.name = String(name || '')
      this.lastModified = Number.isFinite(options.lastModified) ? options.lastModified : Date.now()
    }
    get [Symbol.toStringTag]() {
      return 'File'
    }
  }
  globalThis.File = FilePolyfill
}
