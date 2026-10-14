/**
 * Storage Polyfill for Linglish
 * Handles cases where localStorage/sessionStorage is blocked (e.g. privacy settings, iframes)
 * Falls back to Cookies (persistent) or Memory (non-persistent)
 */
(function () {
    // 1. Check if storage is actually blocked
    function isStorageAvailable(type) {
        try {
            const storage = window[type];
            const x = '__storage_test__';
            storage.setItem(x, x);
            storage.removeItem(x);
            return true;
        } catch (e) {
            return false;
        }
    }

    // 2. Cookie Helpers
    const CookieStore = {
        getItem: function (sKey) {
            if (!sKey) { return null; }
            return decodeURIComponent(document.cookie.replace(new RegExp("(?:(?:^|.*;)\\s*" + encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, "\\$&") + "\\s*\\=\\s*([^;]*).*$)|^.*$"), "$1")) || null;
        },
        setItem: function (sKey, sValue, vEnd, sPath, sDomain, bSecure) {
            if (!sKey || /^(?:expires|max\-age|path|domain|secure)$/i.test(sKey)) { return false; }
            var sExpires = "";
            if (vEnd) {
                switch (vEnd.constructor) {
                    case Number:
                        sExpires = vEnd === Infinity ? "; expires=Fri, 31 Dec 9999 23:59:59 GMT" : "; max-age=" + vEnd;
                        break;
                    case String:
                        sExpires = "; expires=" + vEnd;
                        break;
                    case Date:
                        sExpires = "; expires=" + vEnd.toUTCString();
                        break;
                }
            }
            document.cookie = encodeURIComponent(sKey) + "=" + encodeURIComponent(sValue) + sExpires + (sDomain ? "; domain=" + sDomain : "") + (sPath ? "; path=" + sPath : "; path=/") + (bSecure ? "; secure" : "");
            return true;
        },
        removeItem: function (sKey, sPath, sDomain) {
            if (!this.hasItem(sKey)) { return false; }
            document.cookie = encodeURIComponent(sKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT" + (sDomain ? "; domain=" + sDomain : "") + (sPath ? "; path=" + sPath : "; path=/");
            return true;
        },
        hasItem: function (sKey) {
            if (!sKey || /^(?:expires|max\-age|path|domain|secure)$/i.test(sKey)) { return false; }
            return (new RegExp("(?:^|;\\s*)" + encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, "\\$&") + "\\s*\\=")).test(document.cookie);
        },
        keys: function () {
            var aKeys = document.cookie.replace(/((?:^|\s*;)[^\=]+)(?=;|$)|^\s*|\s*(?:\=[^;]*)?(?:\1|$)/g, "").split(/\s*(?:\=[^;]*)?;\s*/);
            for (var nLen = aKeys.length, nIdx = 0; nIdx < nLen; nIdx++) { aKeys[nIdx] = decodeURIComponent(aKeys[nIdx]); }
            return aKeys;
        }
    };

    // 3. Create Storage Interface
    function createCookieStorage(isSession) {
        return {
            getItem: function (key) {
                return CookieStore.getItem(key);
            },
            setItem: function (key, value) {
                // For localStorage, set a long expiration (1 year). For sessionStorage, no expiration (session cookie).
                const expires = isSession ? null : 31536000;
                CookieStore.setItem(key, String(value), expires);
            },
            removeItem: function (key) {
                CookieStore.removeItem(key);
            },
            clear: function () {
                const keys = CookieStore.keys();
                keys.forEach(key => CookieStore.removeItem(key));
            },
            key: function (index) {
                const keys = CookieStore.keys();
                return keys[index] || null;
            },
            get length() {
                return CookieStore.keys().length;
            }
        };
    }

    function createMemoryStorage() {
        console.warn('[Storage] Cookies also blocked, using Memory Storage (will be lost on reload)');
        const store = {};
        return {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
            clear: () => { Object.keys(store).forEach(k => delete store[k]); },
            key: (i) => Object.keys(store)[i] || null,
            get length() { return Object.keys(store).length; }
        };
    }

    // 4. Apply Polyfills
    const lsAvailable = isStorageAvailable('localStorage');
    const ssAvailable = isStorageAvailable('sessionStorage');

    if (!lsAvailable) {
        console.warn('[Storage] localStorage blocked, attempting Cookie fallback');
        try {
            // Test cookies
            if (navigator.cookieEnabled) {
                const cookieStore = createCookieStorage(false);
                // Define property to override the getter
                Object.defineProperty(window, 'localStorage', {
                    value: cookieStore,
                    writable: true,
                    configurable: true
                });
                console.log('[Storage] localStorage polyfilled with Cookies');
            } else {
                throw new Error('Cookies disabled');
            }
        } catch (e) {
            Object.defineProperty(window, 'localStorage', {
                value: createMemoryStorage(),
                writable: true,
                configurable: true
            });
        }
    }

    if (!ssAvailable) {
        console.warn('[Storage] sessionStorage blocked, attempting Cookie fallback');
        try {
            if (navigator.cookieEnabled) {
                const cookieStore = createCookieStorage(true);
                Object.defineProperty(window, 'sessionStorage', {
                    value: cookieStore,
                    writable: true,
                    configurable: true
                });
                console.log('[Storage] sessionStorage polyfilled with Session Cookies');
            } else {
                throw new Error('Cookies disabled');
            }
        } catch (e) {
            Object.defineProperty(window, 'sessionStorage', {
                value: createMemoryStorage(),
                writable: true,
                configurable: true
            });
        }
    }

})();
