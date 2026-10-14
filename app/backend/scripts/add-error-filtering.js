#!/usr/bin/env node

/**
 * Script to add comprehensive error filtering to HTML files
 * This filters out noisy browser extension errors that don't affect app logic
 */

const fs = require('fs');
const path = require('path');

const ERROR_FILTER_SCRIPT = `  <script>
    // Filter noisy extension JSON.parse('undefined') errors (does not affect app logic)
    // IMPORTANT: This must be the first script to catch extension errors
    (function(){
      try {
        const patterns = [
          /\\"undefined\\" is not valid JSON/i,
          /\\"null\\" is not valid JSON/i,
          /Unexpected token 'u'.*JSON/i,
          /Unexpected token 'n'.*JSON/i,
          /SyntaxError.*undefined.*JSON/i,
          /SyntaxError.*null.*JSON/i,
          /JSON\\.parse/i,
          /updateConfig/i,
          /initConfig/i,
          /metadata\\.js/i,
          /content\\.js/i,
          /iosMetadata\\.js/i,
          /Wu\\.updateConfig/i,
          /ul\\.updateConfig/i,
          /cloudflareinsights/i,
          /beacon\\.min\\.js/i,
        ];
        const matchMsg = (msg) => {
          try { return patterns.some((re) => re.test(String(msg || ''))); } catch { return false; }
        };

        // Check if error is from extension (check stack trace)
        const isExtensionError = (error) => {
          try {
            if (!error) return false;
            const stack = error.stack || error.toString();
            const name = error.name || '';
            const message = error.message || '';

            // Check error message and name
            if (matchMsg(message) || matchMsg(name)) return true;

            // Check for common extension patterns
            if (/chrome-extension:\\/\\//i.test(stack)) return true;
            if (/moz-extension:\\/\\//i.test(stack)) return true;
            if (/safari-extension:\\/\\//i.test(stack)) return true;
            if (/webkit-masked-url:\\/\\//i.test(stack)) return true;
            if (/metadata\\.js/i.test(stack)) return true;
            if (/content\\.js/i.test(stack)) return true;
            if (/iosMetadata\\.js/i.test(stack)) return true;
            if (/updateConfig|initConfig/i.test(stack)) return true;
            if (/Wu\\.|ul\\./i.test(stack)) return true;
            if (/cloudflare|beacon/i.test(stack)) return true;
            return false;
          } catch (_) {
            return false;
          }
        };

        // Override console methods
        const ce = console.error ? console.error.bind(console) : null;
        const cw = console.warn ? console.warn.bind(console) : null;
        if (ce) {
          console.error = function(...args){
            const head = args && args.length ? String(args[0]) : '';
            if (matchMsg(head)) return;
            if (args[0] instanceof Error && isExtensionError(args[0])) return;
            return ce(...args);
          };
        }
        if (cw) {
          console.warn = function(...args){
            const head = args && args.length ? String(args[0]) : '';
            if (matchMsg(head)) return;
            if (args[0] instanceof Error && isExtensionError(args[0])) return;
            return cw(...args);
          };
        }

        // Catch unhandled promise rejections
        window.addEventListener('unhandledrejection', (ev) => {
          try {
            const reason = ev && ev.reason;
            if (reason && reason.name === 'SyntaxError') {
              const msg = reason.message || '';
              if (matchMsg(msg)) {
                ev.preventDefault();
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                return;
              }
            }
            const msg = (reason && reason.message) || (reason && reason.toString && reason.toString()) || reason;
            if (matchMsg(String(msg||''))) {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              return;
            }
            if (isExtensionError(reason)) {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              return;
            }
          } catch(_) {}
        }, true);

        // Catch error events
        window.addEventListener('error', (ev) => {
          try {
            const msg = (ev && ev.message) || '';
            if (matchMsg(String(msg))) {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              return;
            }
            if (ev && ev.error && isExtensionError(ev.error)) {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              return;
            }
            const filename = (ev && ev.filename) || '';
            if (/chrome-extension|moz-extension|safari-extension|webkit-masked-url|metadata\\.js|content\\.js|iosMetadata\\.js|^VM\\d+:/i.test(filename)) {
              ev.preventDefault();
              ev.stopPropagation();
              ev.stopImmediatePropagation();
              return;
            }
          } catch(_) {}
        }, true);
      } catch (_) {}
    })();
  </script>`;

const filesToUpdate = [
  'video-reader-desktop.html',
  'video-reader.html',
  'youtube-reader.html',
  'desktop-auth.html',
  'membership.html',
  'membership-en.html',
  'admin.html',
  'admin-dashboard.html',
  'admin-users.html',
  'youtube-import.html',
  'video-upload.html',
];

const frontendDir = path.join(__dirname, '../../frontend');

filesToUpdate.forEach(filename => {
  const filepath = path.join(frontendDir, filename);

  if (!fs.existsSync(filepath)) {
    console.log(`⚠️  Skipping ${filename} - file not found`);
    return;
  }

  let content = fs.readFileSync(filepath, 'utf8');

  // Check if already has error filtering
  if (content.includes('Filter noisy extension JSON.parse')) {
    console.log(`✓  ${filename} - already has error filtering`);
    return;
  }

  // Find the first <script> tag or insert after <head>
  const headMatch = content.match(/<head[^>]*>/i);
  if (!headMatch) {
    console.log(`⚠️  Skipping ${filename} - no <head> tag found`);
    return;
  }

  const insertPos = headMatch.index + headMatch[0].length;
  const newContent = content.slice(0, insertPos) + '\n' + ERROR_FILTER_SCRIPT + '\n' + content.slice(insertPos);

  fs.writeFileSync(filepath, newContent, 'utf8');
  console.log(`✓  ${filename} - error filtering added`);
});

console.log('\n✨ Done!');
