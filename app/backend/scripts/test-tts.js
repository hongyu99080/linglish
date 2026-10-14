#!/usr/bin/env node
/**
 * Test TTS functionality
 */

const ttsService = require('../services/tts');

async function testTTS() {
  console.log('Testing TTS Service...\n');

  try {
    // Test English
    console.log('1. Generating English TTS...');
    const englishAudio = await ttsService.textToSpeech('Hello, this is a test.', {
      lang: 'en',
      slow: false
    });
    console.log(`✓ English audio generated: ${englishAudio}\n`);

    // Test Chinese
    console.log('2. Generating Chinese TTS...');
    const chineseAudio = await ttsService.textToSpeech('你好,这是一个测试。', {
      lang: 'zh-CN',
      slow: false
    });
    console.log(`✓ Chinese audio generated: ${chineseAudio}\n`);

    // Test cache (should use cached file)
    console.log('3. Testing cache (re-generating English)...');
    const cachedAudio = await ttsService.textToSpeech('Hello, this is a test.', {
      lang: 'en',
      slow: false
    });
    console.log(`✓ Cached audio: ${cachedAudio}\n`);

    // Test available voices
    console.log('4. Getting available voices...');
    const voices = await ttsService.getAvailableVoices();
    console.log(`✓ Available voices: ${voices.length}`);
    voices.forEach(v => console.log(`  - ${v.label} (${v.value})`));

    console.log('\n✅ All TTS tests passed!');
    console.log('\nYou can play the audio files with:');
    console.log(`  afplay ${englishAudio}`);
    console.log(`  afplay ${chineseAudio}`);

  } catch (err) {
    console.error('\n❌ TTS test failed:', err);
    process.exit(1);
  }
}

testTTS();
