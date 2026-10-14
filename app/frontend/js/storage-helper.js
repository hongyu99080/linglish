/**
 * StorageHelper - Safe Storage Operations with Robust Error Handling
 * Fixes: JSON.parse undefined errors, storage access blocked, cache issues
 * Version: 2024.12.16.001
 */
(function (window) {
    'use strict';

    // Storage availability check
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

    const hasLocalStorage = isStorageAvailable('localStorage');
    const hasSessionStorage = isStorageAvailable('sessionStorage');

    console.log('[StorageHelper] Available:', {
        localStorage: hasLocalStorage,
        sessionStorage: hasSessionStorage
    });

    const StorageHelper = {
        /**
         * Safely get item from storage with JSON parsing
         * @param {string} key - Storage key
         * @param {*} defaultValue - Default value if key doesn't exist or parsing fails
         * @param {boolean} useSession - Use sessionStorage instead of localStorage
         * @returns {*} Parsed value or default
         */
        getItem: function (key, defaultValue = null, useSession = false) {
            if (!key) {
                console.warn('[StorageHelper] getItem: key is required');
                return defaultValue;
            }

            try {
                const storage = useSession ?
                    (hasSessionStorage ? sessionStorage : null) :
                    (hasLocalStorage ? localStorage : null);

                if (!storage) {
                    console.warn('[StorageHelper] Storage not available');
                    return defaultValue;
                }

                const value = storage.getItem(key);

                // Handle undefined, null, empty string
                if (value === null || value === undefined || value === '' || value === 'undefined' || value === 'null') {
                    return defaultValue;
                }

                // Try to parse as JSON
                try {
                    return JSON.parse(value);
                } catch (parseError) {
                    // If it's not valid JSON, return as string
                    return value;
                }
            } catch (error) {
                console.error('[StorageHelper] getItem error:', error.message);
                return defaultValue;
            }
        },

        /**
         * Safely set item to storage with JSON stringification
         * @param {string} key - Storage key
         * @param {*} value - Value to store (will be JSON.stringified)
         * @param {boolean} useSession - Use sessionStorage instead of localStorage
         * @returns {boolean} Success status
         */
        setItem: function (key, value, useSession = false) {
            if (!key) {
                console.warn('[StorageHelper] setItem: key is required');
                return false;
            }

            try {
                const storage = useSession ?
                    (hasSessionStorage ? sessionStorage : null) :
                    (hasLocalStorage ? localStorage : null);

                if (!storage) {
                    console.warn('[StorageHelper] Storage not available');
                    return false;
                }

                // Handle undefined and null
                if (value === undefined || value === null) {
                    storage.removeItem(key);
                    return true;
                }

                // Stringify value if it's an object
                const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
                storage.setItem(key, stringValue);
                return true;
            } catch (error) {
                console.error('[StorageHelper] setItem error:', error.message);
                return false;
            }
        },

        /**
         * Remove item from storage
         * @param {string} key - Storage key
         * @param {boolean} useSession - Use sessionStorage instead of localStorage
         * @returns {boolean} Success status
         */
        removeItem: function (key, useSession = false) {
            if (!key) {
                console.warn('[StorageHelper] removeItem: key is required');
                return false;
            }

            try {
                const storage = useSession ?
                    (hasSessionStorage ? sessionStorage : null) :
                    (hasLocalStorage ? localStorage : null);

                if (!storage) {
                    return false;
                }

                storage.removeItem(key);
                return true;
            } catch (error) {
                console.error('[StorageHelper] removeItem error:', error.message);
                return false;
            }
        },

        /**
         * Clear all items from storage
         * @param {boolean} useSession - Use sessionStorage instead of localStorage
         * @param {Array<string>} except - Keys to preserve
         * @returns {boolean} Success status
         */
        clear: function (useSession = false, except = []) {
            try {
                const storage = useSession ?
                    (hasSessionStorage ? sessionStorage : null) :
                    (hasLocalStorage ? localStorage : null);

                if (!storage) {
                    return false;
                }

                if (except.length === 0) {
                    storage.clear();
                    return true;
                }

                // Preserve excepted keys
                const preserved = {};
                except.forEach(key => {
                    const value = storage.getItem(key);
                    if (value !== null) {
                        preserved[key] = value;
                    }
                });

                // Clear all
                storage.clear();

                // Restore preserved
                Object.keys(preserved).forEach(key => {
                    storage.setItem(key, preserved[key]);
                });

                return true;
            } catch (error) {
                console.error('[StorageHelper] clear error:', error.message);
                return false;
            }
        },

        /**
         * Clear cache (remove all app-related keys except auth)
         * Fixes cache-related login issues
         * @returns {boolean} Success status
         */
        clearCache: function () {
            console.log('[StorageHelper] Clearing cache...');

            try {
                // Keys to preserve (authentication-related)
                const preserveKeys = [
                    'authToken',
                    'linglish_token',
                    'linglish_app_version',
                    'linglish_user_id'
                ];

                // Keys patterns to remove (cache and config)
                const removePatternsLocal = [
                    'userSettings',
                    'lastSync',
                    'appConfig',
                    'cachedData',
                    'is_guest',
                    'guest_id',
                    'isGuest',
                    'userEmail',
                    'config_',
                    'cache_',
                    'temp_'
                ];

                // Clear from localStorage
                if (hasLocalStorage) {
                    const keysToRemove = [];
                    for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        // Remove if matches pattern and not in preserve list
                        if (!preserveKeys.includes(key)) {
                            const shouldRemove = removePatternsLocal.some(pattern => key.includes(pattern));
                            if (shouldRemove) {
                                keysToRemove.push(key);
                            }
                        }
                    }
                    keysToRemove.forEach(key => {
                        try { localStorage.removeItem(key); } catch (e) { }
                    });
                    console.log('[StorageHelper] Removed from localStorage:', keysToRemove.length);
                }

                // Clear from sessionStorage (except preserve keys)
                if (hasSessionStorage) {
                    const keysToRemove = [];
                    for (let i = 0; i < sessionStorage.length; i++) {
                        const key = sessionStorage.key(i);
                        if (!preserveKeys.includes(key)) {
                            keysToRemove.push(key);
                        }
                    }
                    keysToRemove.forEach(key => {
                        try { sessionStorage.removeItem(key); } catch (e) { }
                    });
                    console.log('[StorageHelper] Removed from sessionStorage:', keysToRemove.length);
                }

                console.log('[StorageHelper] Cache cleared successfully');
                return true;
            } catch (error) {
                console.error('[StorageHelper] clearCache error:', error);
                return false;
            }
        },

        /**
         * Fix corrupted storage entries
         * Removes entries with invalid values (undefined, null strings, etc.)
         * @returns {number} Number of fixed entries
         */
        fixCorrupted: function () {
            console.log('[StorageHelper] Fixing corrupted entries...');
            let fixed = 0;

            try {
                const checkAndFix = (storage, storageName) => {
                    if (!storage) return;

                    const keysToRemove = [];
                    for (let i = 0; i < storage.length; i++) {
                        const key = storage.key(i);
                        const value = storage.getItem(key);

                        // Check for corrupted values
                        if (value === 'undefined' || value === 'null' || value === '' || value === 'NaN') {
                            keysToRemove.push(key);
                        }
                    }

                    keysToRemove.forEach(key => {
                        try {
                            storage.removeItem(key);
                            fixed++;
                            console.log(`[StorageHelper] Removed corrupted ${storageName} key:`, key);
                        } catch (e) { }
                    });
                };

                if (hasLocalStorage) {
                    checkAndFix(localStorage, 'localStorage');
                }

                if (hasSessionStorage) {
                    checkAndFix(sessionStorage, 'sessionStorage');
                }

                console.log(`[StorageHelper] Fixed ${fixed} corrupted entries`);
                return fixed;
            } catch (error) {
                console.error('[StorageHelper] fixCorrupted error:', error);
                return fixed;
            }
        },

        /**
         * Health check and auto-fix
         * @returns {Object} Health status
         */
        healthCheck: function () {
            console.log('[StorageHelper] Running health check...');

            const result = {
                healthy: true,
                issues: [],
                fixed: 0
            };

            try {
                // Fix corrupted entries
                const fixedCount = this.fixCorrupted();
                result.fixed = fixedCount;

                if (fixedCount > 0) {
                    result.issues.push(`Fixed ${fixedCount} corrupted entries`);
                }

                // Check storage availability
                if (!hasLocalStorage && !hasSessionStorage) {
                    result.healthy = false;
                    result.issues.push('No storage available');
                }

                console.log('[StorageHelper] Health check complete:', result);
                return result;
            } catch (error) {
                console.error('[StorageHelper] Health check failed:', error);
                return {
                    healthy: false,
                    issues: [error.message],
                    fixed: 0
                };
            }
        }
    };

    // Auto health check on load
    try {
        StorageHelper.healthCheck();
    } catch (e) {
        console.error('[StorageHelper] Auto health check failed:', e);
    }

    // Expose to window
    window.StorageHelper = StorageHelper;

    // Also add to AuthManager if it exists
    if (window.AuthManager) {
        window.AuthManager.clearCache = StorageHelper.clearCache;
        window.AuthManager.fixCorrupted = StorageHelper.fixCorrupted;
    }

})(window);
