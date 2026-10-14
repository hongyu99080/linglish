/**
 * TTS Voice Selector Module
 * Handles Text-to-Speech voice selection and management
 * This is a placeholder for future TTS functionality
 */

/**
 * TTS Voice Manager Class
 */
export class TTSVoiceManager {
  constructor() {
    this.voices = [];
    this.selectedVoice = null;
    this.synthesis = null;
    this.initialized = false;
  }

  /**
   * Initialize TTS voice manager
   * @returns {Promise} - Promise that resolves when initialized
   */
  async initialize() {
    if (this.initialized) return;

    try {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        console.warn('[TTS] Speech synthesis not supported');
        return;
      }

      this.synthesis = window.speechSynthesis;

      // Load available voices
      await this.loadVoices();

      this.initialized = true;
      console.log('[TTS] Voice manager initialized');
    } catch (error) {
      console.error('[TTS] Initialization failed:', error);
    }
  }

  /**
   * Load available voices
   * @returns {Promise<Array>} - Promise that resolves with voices array
   */
  async loadVoices() {
    return new Promise((resolve) => {
      if (!this.synthesis) {
        resolve([]);
        return;
      }

      const getVoices = () => {
        this.voices = this.synthesis.getVoices();
        if (this.voices.length > 0) {
          console.log(`[TTS] Loaded ${this.voices.length} voices`);
          resolve(this.voices);
        }
      };

      // Get voices immediately
      getVoices();

      // Also listen for voiceschanged event (some browsers need this)
      if (this.synthesis.addEventListener) {
        this.synthesis.addEventListener('voiceschanged', () => {
          getVoices();
        });
      }

      // Timeout fallback
      setTimeout(() => {
        if (this.voices.length === 0) {
          console.warn('[TTS] No voices loaded after timeout');
          resolve([]);
        }
      }, 1000);
    });
  }

  /**
   * Get available voices filtered by language
   * @param {string} lang - Language code (e.g., 'en-US', 'zh-CN')
   * @returns {Array} - Filtered voices array
   */
  getVoicesByLanguage(lang) {
    if (!lang) return this.voices;
    return this.voices.filter(voice => voice.lang.startsWith(lang));
  }

  /**
   * Select a voice
   * @param {SpeechSynthesisVoice} voice - Voice to select
   */
  selectVoice(voice) {
    this.selectedVoice = voice;
    console.log(`[TTS] Selected voice: ${voice.name} (${voice.lang})`);
  }

  /**
   * Speak text with selected voice
   * @param {string} text - Text to speak
   * @param {Object} options - Speech options
   * @returns {Promise} - Promise that resolves when speech is complete
   */
  async speak(text, options = {}) {
    if (!this.synthesis || !this.initialized) {
      console.warn('[TTS] Not initialized');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        // Cancel any ongoing speech
        this.synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);

        if (this.selectedVoice) {
          utterance.voice = this.selectedVoice;
        }

        // Apply options
        utterance.rate = options.rate || 1.0;
        utterance.pitch = options.pitch || 1.0;
        utterance.volume = options.volume || 1.0;

        utterance.onend = () => {
          console.log('[TTS] Speech complete');
          resolve();
        };

        utterance.onerror = (event) => {
          console.error('[TTS] Speech error:', event);
          reject(event);
        };

        this.synthesis.speak(utterance);
      } catch (error) {
        console.error('[TTS] Speak failed:', error);
        reject(error);
      }
    });
  }

  /**
   * Stop current speech
   */
  stop() {
    if (this.synthesis) {
      this.synthesis.cancel();
    }
  }

  /**
   * Pause current speech
   */
  pause() {
    if (this.synthesis && this.synthesis.speaking) {
      this.synthesis.pause();
    }
  }

  /**
   * Resume paused speech
   */
  resume() {
    if (this.synthesis && this.synthesis.paused) {
      this.synthesis.resume();
    }
  }
}

/**
 * Create and return a new TTS voice manager instance
 * @returns {TTSVoiceManager} - TTS voice manager instance
 */
export function createTTSVoiceManager() {
  return new TTSVoiceManager();
}

/**
 * Check if TTS is supported
 * @returns {boolean} - True if supported
 */
export function isTTSSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Get recommended voice for language
 * @param {string} lang - Language code
 * @returns {Promise<SpeechSynthesisVoice|null>} - Recommended voice or null
 */
export async function getRecommendedVoice(lang) {
  if (!isTTSSupported()) return null;

  const manager = createTTSVoiceManager();
  await manager.initialize();

  const voices = manager.getVoicesByLanguage(lang);
  if (voices.length === 0) return null;

  // Prefer local voices
  const localVoices = voices.filter(v => v.localService);
  if (localVoices.length > 0) {
    return localVoices[0];
  }

  return voices[0];
}
