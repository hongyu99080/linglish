/**
 * Enhanced Error Filter for Browser Extensions
 *
 * Suppresses noisy errors from browser extensions (e.g., JSON.parse errors from
 * extension scripts like metadata.js, content.js, iosMetadata.js) that do not
 * affect application logic.
 *
 * IMPORTANT: Include this script FIRST in your HTML <head> to ensure it catches
 * all extension errors before they're logged to the console.
 *
 * Usage:
 * <script src="./error-filter.js"></script>
 */
(function() {
  'use strict';

  // Comprehensive error patterns to filter
  const errorPatterns = [
    /\"undefined\" is not valid JSON/i,
    /\"null\" is not valid JSON/i,
    /Unexpected token \'u\'/i,
    /Unexpected token \'n\'/i,
    /Unexpected token u in JSON/i,
    /Unexpected token n in JSON/i,
    /SyntaxError.*undefined/i,
    /SyntaxError.*null/i,
    /JSON\.parse/i,
    /updateConfig/i,
    /initConfig/i,
    /metadata\.js/i,
    /content\.js/i,
    /iosMetadata\.js/i,
    /Wu\.updateConfig/i,
    /ll\.updateConfig/i,
    /ul\.updateConfig/i,
    /VM\d+:/i,
    /cloudflareinsights/i,
    /beacon\.min\.js/i,
    /integrity.*sha512/i,
    /CORS.*cloudflare/i,
    /同源策略/i,
    /跨源请求/i,
  ];

  // Extension file patterns
  const extensionPatterns = [
    /chrome-extension:\/\//i,
    /moz-extension:\/\//i,
    /safari-extension:\/\//i,
    /webkit-masked-url:\/\//i,
    /^VM\d+$/i,
    /metadata\.js/i,
    /content\.js/i,
    /iosMetadata\.js/i,
    /cloudflare/i,
    /beacon/i,
  ];

  // Fast pattern matcher
  const matchesPattern = (str, patterns) => {
    if (!str) return false;
    const s = String(str);
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(s)) return true;
    }
    return false;
  };

  // Check if error should be filtered
  const isFilteredError = (error, message, filename, stack) => {
    try {
      // Check message
      if (message && matchesPattern(message, errorPatterns)) return true;

      // Check filename
      if (filename && matchesPattern(filename, extensionPatterns)) return true;

      // Check error object
      if (error) {
        const errMsg = error.message || '';
        const errName = error.name || '';
        const errStack = error.stack || '';

        if (matchesPattern(errMsg, errorPatterns)) return true;
        if (matchesPattern(errName, errorPatterns)) return true;
        if (matchesPattern(errStack, extensionPatterns)) return true;
      }

      // Check stack
      if (stack && matchesPattern(stack, extensionPatterns)) return true;

      return false;
    } catch (_) {
      return false;
    }
  };

  // Override console methods to suppress extension errors
  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = function(...args) {
    if (args.length > 0) {
      const firstArg = args[0];
      const msg = String(firstArg || '');

      if (matchesPattern(msg, errorPatterns)) return;
      if (firstArg instanceof Error && isFilteredError(firstArg, firstArg.message, '', firstArg.stack)) return;
    }
    return originalError.apply(console, args);
  };

  console.warn = function(...args) {
    if (args.length > 0) {
      const firstArg = args[0];
      const msg = String(firstArg || '');

      if (matchesPattern(msg, errorPatterns)) return;
      if (firstArg instanceof Error && isFilteredError(firstArg, firstArg.message, '', firstArg.stack)) return;
    }
    return originalWarn.apply(console, args);
  };

  // Intercept unhandled promise rejections
  const handleUnhandledRejection = (event) => {
    try {
      const reason = event.reason;
      const message = (reason && reason.message) || String(reason || '');
      const stack = (reason && reason.stack) || '';

      if (isFilteredError(reason, message, '', stack)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return false;
      }
    } catch (_) {}
  };

  // Intercept global errors
  const handleError = (event) => {
    try {
      const message = event.message || '';
      const filename = event.filename || '';
      const error = event.error;

      if (isFilteredError(error, message, filename, error && error.stack)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return false;
      }
    } catch (_) {}
  };

  // Add event listeners with capture phase (highest priority)
  window.addEventListener('unhandledrejection', handleUnhandledRejection, true);
  window.addEventListener('error', handleError, true);

  // Also add to document for even earlier capture
  if (document) {
    document.addEventListener('error', handleError, true);
  }

  // Mark as loaded
  window.__errorFilterLoaded = true;

})();
