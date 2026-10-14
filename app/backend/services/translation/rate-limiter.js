/**
 * Global rate limiter for translation providers
 * Tracks failures and temporarily disables providers that are being rate limited
 */

class ProviderRateLimiter {
  constructor() {
    // Track provider status: { providerName: { disabled: boolean, disabledUntil: timestamp, failureCount: number } }
    this.providers = {};

    // Configuration
    this.MAX_FAILURES_BEFORE_DISABLE = 2; // Disable after 2 consecutive failures (faster response to rate limits)
    this.DISABLE_DURATION_MS = 180000; // Disable for 3 minutes (180 seconds) to avoid aggressive retries
  }

  /**
   * Check if a provider is currently disabled due to rate limiting
   * @param {string} providerName - Name of the provider (e.g., 'google', 'libretranslate')
   * @returns {boolean} - True if provider is disabled
   */
  isDisabled(providerName) {
    const provider = this.providers[providerName];
    if (!provider || !provider.disabled) {
      return false;
    }

    // Check if disable period has expired
    const now = Date.now();
    if (now >= provider.disabledUntil) {
      // Re-enable provider
      console.log(`[Rate Limiter] Re-enabling ${providerName} after cooldown period`);
      provider.disabled = false;
      provider.failureCount = 0;
      return false;
    }

    return true;
  }

  /**
   * Record a successful translation
   * @param {string} providerName - Name of the provider
   */
  recordSuccess(providerName) {
    if (!this.providers[providerName]) {
      this.providers[providerName] = { disabled: false, disabledUntil: 0, failureCount: 0 };
    }

    // Reset failure count on success
    this.providers[providerName].failureCount = 0;
  }

  /**
   * Record a failure (especially rate limit errors)
   * @param {string} providerName - Name of the provider
   * @param {Error} error - The error that occurred
   */
  recordFailure(providerName, error) {
    if (!this.providers[providerName]) {
      this.providers[providerName] = { disabled: false, disabledUntil: 0, failureCount: 0 };
    }

    const provider = this.providers[providerName];
    const errorMessage = error?.message || '';
    const isRateLimit = errorMessage.includes('429') ||
                       errorMessage.includes('Too Many Requests') ||
                       errorMessage.includes('TooManyRequests') ||
                       errorMessage.includes('rate limit') ||
                       errorMessage.includes('RATE_LIMIT');

    if (isRateLimit) {
      provider.failureCount++;
      console.log(`[Rate Limiter] ${providerName} rate limit failure ${provider.failureCount}/${this.MAX_FAILURES_BEFORE_DISABLE}`);

      if (provider.failureCount >= this.MAX_FAILURES_BEFORE_DISABLE) {
        // Disable provider temporarily
        const now = Date.now();
        provider.disabled = true;
        provider.disabledUntil = now + this.DISABLE_DURATION_MS;

        const disableSeconds = Math.round(this.DISABLE_DURATION_MS / 1000);
        console.log(`[Rate Limiter] ⚠️ Disabling ${providerName} for ${disableSeconds}s due to rate limiting`);
      }
    }
  }

  /**
   * Get the status of all providers
   * @returns {Object} - Status of all providers
   */
  getStatus() {
    const status = {};
    for (const [name, provider] of Object.entries(this.providers)) {
      status[name] = {
        disabled: provider.disabled,
        failureCount: provider.failureCount,
        disabledUntil: provider.disabledUntil ? new Date(provider.disabledUntil).toISOString() : null
      };
    }
    return status;
  }
}

// Global singleton instance
const rateLimiter = new ProviderRateLimiter();

module.exports = rateLimiter;
