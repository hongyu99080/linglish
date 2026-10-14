/**
 * AuthManager - Centralized Authentication Handling
 * Handles token storage with robust fallback to Cookies/Memory when localStorage is blocked.
 */
(function (window) {
    // --- Storage Polyfill Logic (Internal) ---

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
        }
    };

    const MemoryStore = {
        _data: {},
        getItem: function (k) { return this._data[k] || null; },
        setItem: function (k, v) { this._data[k] = String(v); },
        removeItem: function (k) { delete this._data[k]; }
    };

    // Determine best storage mechanism
    let useLocalStorage = isStorageAvailable('localStorage');
    let useSessionStorage = isStorageAvailable('sessionStorage');
    let useCookies = navigator.cookieEnabled;

    let mediaClearPromise = null;

    function clearMediaSession() {
        if (mediaClearPromise) return mediaClearPromise;
        const request = window.LinglishMediaSession
            ? window.LinglishMediaSession.clear()
            : fetch('/auth/media-session', { method: 'DELETE', credentials: 'include' });
        const serialized = Promise.resolve(request).catch(function () { });
        const tracked = serialized.finally(function () {
            if (mediaClearPromise === tracked) mediaClearPromise = null;
        });
        mediaClearPromise = tracked;
        return tracked;
    }

    function clearStoredTokens() {
        if (useLocalStorage) {
            try { localStorage.removeItem('authToken'); localStorage.removeItem('linglish_token'); } catch (e) { }
        }
        if (useSessionStorage) {
            try { sessionStorage.removeItem('authToken'); sessionStorage.removeItem('linglish_token'); } catch (e) { }
        }
        if (useCookies) {
            CookieStore.removeItem('authToken');
            CookieStore.removeItem('linglish_token');
        }
        MemoryStore.removeItem('authToken');
        MemoryStore.removeItem('linglish_token');
    }

    console.log(`[AuthManager] Storage Status: LS=${useLocalStorage}, SS=${useSessionStorage}, Cookies=${useCookies}`);

    // --- AuthManager API ---

    const AuthManager = {
        /**
         * Set auth token
         * @param {string} token - The access token
         * @param {boolean} remember - If true, persist across sessions (localStorage/Cookie). If false, session only.
         */
        setToken: async function (token, remember) {
            if (!token) {
                console.warn('[AuthManager] setToken: no token provided');
                return false;
            }

            const previousToken = this.getToken();
            if (previousToken && previousToken !== token) {
                clearStoredTokens();
                await clearMediaSession();
            } else if (mediaClearPromise) {
                await mediaClearPromise;
            }
            console.log('[AuthManager] setToken: attempting to save token, remember=' + remember);

            // 1. Try Native Storage first if available
            if (remember && useLocalStorage) {
                try {
                    localStorage.setItem('authToken', token);
                    localStorage.setItem('linglish_token', token);
                    console.log('[AuthManager] Token saved to localStorage');
                    return true;
                } catch (e) {
                    console.warn('[AuthManager] localStorage failed:', e.message);
                }
            } else if (!remember && useSessionStorage) {
                try {
                    sessionStorage.setItem('authToken', token);
                    sessionStorage.setItem('linglish_token', token);
                    console.log('[AuthManager] Token saved to sessionStorage');
                    return true;
                } catch (e) {
                    console.warn('[AuthManager] sessionStorage failed:', e.message);
                }
            }

            // 2. Fallback to Cookies
            console.log('[AuthManager] Trying Cookie fallback...');
            if (useCookies) {
                try {
                    const expires = remember ? 31536000 : null; // 1 year or session
                    CookieStore.setItem('authToken', token, expires);
                    CookieStore.setItem('linglish_token', token, expires);
                    console.log('[AuthManager] Token saved to Cookies');
                    return true;
                } catch (e) {
                    console.warn('[AuthManager] Cookie storage failed:', e.message);
                }
            }

            // 3. Fallback to Memory (Last resort, will be lost on reload)
            console.warn('[AuthManager] Using Memory storage (will be lost on reload)');
            MemoryStore.setItem('authToken', token);
            MemoryStore.setItem('linglish_token', token);
            console.log('[AuthManager] Token saved to Memory');
            return true;
        },

        /**
         * Get auth token
         * Checks: LocalStorage -> SessionStorage -> Cookies -> Memory
         * Auto-clears expired tokens
         * @returns {string|null}
         */
        getToken: function () {
            let token = null;

            // Check LocalStorage
            if (useLocalStorage) {
                try {
                    token = localStorage.getItem('authToken') || localStorage.getItem('linglish_token');
                    if (token && token !== 'null' && token !== 'undefined') {
                        // Validate token expiry
                        if (this.isTokenExpired(token)) {
                            // Only clear this tier — a fresh token may exist in sessionStorage/cookies
                            console.warn('[AuthManager] Token in localStorage is expired, removing localStorage copies...');
                            localStorage.removeItem('authToken');
                            localStorage.removeItem('linglish_token');
                        } else {
                            return token;
                        }
                    }
                } catch (e) {
                    console.warn('[AuthManager] localStorage read failed:', e.message);
                }
            }

            // Check SessionStorage
            if (useSessionStorage) {
                try {
                    token = sessionStorage.getItem('authToken') || sessionStorage.getItem('linglish_token');
                    if (token && token !== 'null' && token !== 'undefined') {
                        if (this.isTokenExpired(token)) {
                            console.warn('[AuthManager] Token in sessionStorage is expired, removing sessionStorage copies...');
                            sessionStorage.removeItem('authToken');
                            sessionStorage.removeItem('linglish_token');
                        } else {
                            return token;
                        }
                    }
                } catch (e) {
                    console.warn('[AuthManager] sessionStorage read failed:', e.message);
                }
            }

            // Check Cookies
            if (useCookies) {
                try {
                    token = CookieStore.getItem('authToken') || CookieStore.getItem('linglish_token');
                    if (token && token !== 'null' && token !== 'undefined') {
                        if (this.isTokenExpired(token)) {
                            console.warn('[AuthManager] Token in Cookies is expired, removing cookie copies...');
                            CookieStore.removeItem('authToken');
                            CookieStore.removeItem('linglish_token');
                        } else {
                            return token;
                        }
                    }
                } catch (e) {
                    console.warn('[AuthManager] Cookie read failed:', e.message);
                }
            }

            // Check Memory
            try {
                token = MemoryStore.getItem('authToken') || MemoryStore.getItem('linglish_token');
                if (token && token !== 'null' && token !== 'undefined') {
                    if (this.isTokenExpired(token)) {
                        console.warn('[AuthManager] Token in Memory is expired, removing memory copies...');
                        MemoryStore.removeItem('authToken');
                        MemoryStore.removeItem('linglish_token');
                    } else {
                        return token;
                    }
                }
            } catch (e) {
                console.warn('[AuthManager] Memory read failed:', e.message);
            }

            return null;
        },

        /**
         * Check if token is expired
         * @param {string} token - JWT token
         * @returns {boolean}
         */
        isTokenExpired: function (token) {
            if (!token || typeof token !== 'string') return true;

            try {
                // JWT format: header.payload.signature
                const parts = token.split('.');
                if (parts.length !== 3) return true;

                // Decode payload (base64url)
                const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

                // Check expiry
                if (payload.exp) {
                    const now = Math.floor(Date.now() / 1000);
                    if (payload.exp < now) {
                        console.log('[AuthManager] Token expired:', {
                            exp: payload.exp,
                            now: now,
                            expiredBy: now - payload.exp + ' seconds'
                        });
                        return true;
                    }
                }

                return false;
            } catch (err) {
                console.warn('[AuthManager] Failed to decode token:', err.message);
                return true; // Treat invalid tokens as expired
            }
        },

        /**
         * Clear all auth tokens from all possible storages
         */
        clearToken: function (options) {
            clearStoredTokens();
            if (options && options.skipMediaSession) return Promise.resolve();
            return clearMediaSession();
        },

        /**
         * Check if user is logged in
         * @returns {boolean}
         */
        isLoggedIn: function () {
            return !!this.getToken();
        },

        /**
         * Validate token format (basic JWT structure check)
         * @param {string} token - Token to validate
         * @returns {boolean}
         */
        isValidTokenFormat: function (token) {
            if (!token || typeof token !== 'string') return false;
            if (token === 'undefined' || token === 'null') return false;
            // JWT tokens have 3 parts separated by dots
            const parts = token.split('.');
            return parts.length === 3;
        },

        /**
         * Health check: Validate and clean corrupted tokens
         * @returns {boolean} - True if healthy or cleaned, false if critical failure
         */
        healthCheck: function () {
            try {
                const token = this.getToken();
                if (token && !this.isValidTokenFormat(token)) {
                    console.warn('[AuthManager] Invalid token detected, clearing...');
                    this.clearToken();
                    return true; // Cleaned up
                }
                return true; // Healthy
            } catch (e) {
                console.error('[AuthManager] Health check failed:', e);
                try {
                    this.clearToken();
                } catch (clearError) {
                    console.error('[AuthManager] Failed to clear corrupted data:', clearError);
                }
                return false;
            }
        },

        /**
         * Version check: Clear cache if app version changed
         * @param {string} currentVersion - Current app version
         * @returns {boolean} - True if version matches or was updated
         */
        versionCheck: function (currentVersion) {
            const VERSION_KEY = 'linglish_app_version';
            try {
                let storedVersion = null;

                // Get stored version
                if (useLocalStorage) {
                    storedVersion = localStorage.getItem(VERSION_KEY);
                } else if (useCookies) {
                    storedVersion = CookieStore.getItem(VERSION_KEY);
                } else {
                    storedVersion = MemoryStore.getItem(VERSION_KEY);
                }

                // If version mismatch, clear all data
                if (storedVersion !== currentVersion) {
                    console.log('[AuthManager] Version mismatch. Clearing cache...', {
                        stored: storedVersion,
                        current: currentVersion
                    });

                    // Clear authentication data
                    this.clearToken();

                    // Clear other app data keys
                    const keysToRemove = ['userSettings', 'lastSync', 'appConfig', 'cachedData',
                                          'is_guest', 'guest_id', 'isGuest', 'userEmail'];
                    keysToRemove.forEach(key => {
                        if (useLocalStorage) {
                            try { localStorage.removeItem(key); } catch (e) { }
                        }
                        if (useSessionStorage) {
                            try { sessionStorage.removeItem(key); } catch (e) { }
                        }
                        if (useCookies) {
                            CookieStore.removeItem(key);
                        }
                        MemoryStore.removeItem(key);
                    });

                    // Set new version
                    if (useLocalStorage) {
                        localStorage.setItem(VERSION_KEY, currentVersion);
                    } else if (useCookies) {
                        CookieStore.setItem(VERSION_KEY, currentVersion, Infinity);
                    } else {
                        MemoryStore.setItem(VERSION_KEY, currentVersion);
                    }

                    console.log('[AuthManager] Cache cleared. New version:', currentVersion);
                }

                return true;
            } catch (e) {
                console.error('[AuthManager] Version check failed:', e);
                return false;
            }
        }
    };

    // App version - update this when making breaking changes
    // Updated: 2024.12.16 - Added StorageHelper, fixed cache issues, auto-clear expired tokens
    const APP_VERSION = '2024.12.16.002';

    // Run version check and health check on load
    try {
        AuthManager.versionCheck(APP_VERSION);
        AuthManager.healthCheck();

        // Auto-clear expired tokens on page load
        const currentToken = AuthManager.getToken();
        if (currentToken === null) {
            console.log('[AuthManager] No token or expired token detected, cleared automatically');
        }
    } catch (e) {
        console.error('[AuthManager] Initialization checks failed:', e);
    }

    // Expose to window
    window.AuthManager = AuthManager;

})(window);
