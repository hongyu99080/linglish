/**
 * Polyfill for Node.js 18 compatibility
 * Adds the File class which is required by undici but only available in Node 20+
 */

// Check if File is already defined (Node 20+)
if (typeof File === 'undefined') {
  const { Blob } = require('buffer');

  /**
   * File class polyfill for Node 18
   * Minimal implementation to satisfy undici's type checking
   */
  class File extends Blob {
    constructor(fileBits, fileName, options = {}) {
      super(fileBits, options);
      this.name = fileName;
      this.lastModified = options.lastModified || Date.now();
    }
  }

  // Add File to both global and globalThis for maximum compatibility
  global.File = File;
  globalThis.File = File;

  console.log('[Polyfill] File class added for Node.js 18 compatibility');
}
