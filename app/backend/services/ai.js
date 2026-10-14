const dataStore = require('../data-store');
const pronunciationService = require('./pronunciation');
const prosodyAnalysis = require('./prosody-analysis');
const reviewScheduler = require('./review-scheduler');
const fs = require('fs/promises');

function deterministicMetric(sessionId, name) {
  const seed = Math.abs(Math.sin(sessionId * name.length));
  return Number((0.5 + seed * 0.5).toFixed(2));
}

/**
 * Enhanced AI scoring with Prosody analysis
 * Analyzes pronunciation, fluency, and prosody features
 *
 * @param {number} userId - User ID
 * @param {number} sessionId - Training session ID
 * @param {Object} options - Scoring options
 * @returns {Object} Complete scoring results
 */
async function triggerScore(userId, sessionId, options = {}) {
  const session = await dataStore.getSessionById(sessionId);
  if (!session || session.user_id !== userId) {
    throw new Error('SESSION_NOT_FOUND');
  }

  let metrics = {};
  let prosody = null;
  let audioPath = options.audioPath || null;
  let referenceText = options.referenceText || null;
  let hypothesisText = null;
  let grade = 'B';

  try {
    // If audio is provided, perform real speech analysis
    if (options.audioBuffer || audioPath) {
      const audioBuffer = options.audioBuffer || (audioPath ? await fs.readFile(audioPath) : null);

      if (audioBuffer && referenceText) {
        // 1. Pronunciation assessment (ASR + similarity)
        const pronunciation = await pronunciationService.assessWithAsr(
          audioBuffer,
          referenceText,
          {
            format: options.audioFormat || 'pcm',
            sampleRate: options.sampleRate || 16000,
            language: options.language || 'en'
          }
        );

        hypothesisText = pronunciation.hypothesis;

        // 2. Prosody analysis (pitch, rhythm, linking, intonation)
        prosody = await prosodyAnalysis.analyzeProsody(
          audioBuffer,
          hypothesisText,
          {
            sampleRate: options.sampleRate || 16000
          }
        );

        // 3. Combined metrics
        metrics = {
          // Pronunciation metrics
          overall_accuracy: pronunciation.overall,
          accuracy: pronunciation.accuracy,
          fluency: pronunciation.fluency,
          completeness: pronunciation.completeness,

          // Prosody metrics
          prosody_score: prosody.overall_score,
          pitch_score: prosody.pitch.score,
          rhythm_score: prosody.rhythm.score,
          linking_score: prosody.linking.score,
          intonation_score: prosody.intonation.score,

          // Traditional metrics (for backward compatibility)
          stress_hit: prosody.pitch.score / 100,
          timing_var: Number((1 - prosody.rhythm.consistency).toFixed(2)),
          wpm: prosody.rhythm.tempo_wpm || Math.round(120 + deterministicMetric(sessionId, 'wpm') * 40),
        };

        // Calculate grade based on comprehensive scores
        const overallScore = (
          metrics.overall_accuracy * 0.4 +
          metrics.prosody_score * 0.3 +
          metrics.fluency * 0.2 +
          metrics.completeness * 0.1
        );

        if (overallScore >= 90) grade = 'A';
        else if (overallScore >= 80) grade = 'B+';
        else if (overallScore >= 70) grade = 'B';
        else if (overallScore >= 60) grade = 'C';
        else grade = 'D';
      } else {
        // Only prosody analysis (no reference text)
        prosody = await prosodyAnalysis.analyzeProsody(
          audioBuffer,
          '',
          {
            sampleRate: options.sampleRate || 16000
          }
        );

        metrics = {
          prosody_score: prosody.overall_score,
          pitch_score: prosody.pitch.score,
          rhythm_score: prosody.rhythm.score,
          stress_hit: prosody.pitch.score / 100,
          timing_var: Number((1 - prosody.rhythm.consistency).toFixed(2)),
          wpm: prosody.rhythm.tempo_wpm || Math.round(120 + deterministicMetric(sessionId, 'wpm') * 40),
        };

        grade = prosody.overall_score >= 80 ? 'A' : prosody.overall_score >= 70 ? 'B' : 'C';
      }
    } else {
      // Fallback to deterministic metrics (original behavior)
      metrics = {
        stress_hit: deterministicMetric(sessionId, 'stress'),
        timing_var: Number((1 - deterministicMetric(sessionId, 'timing')).toFixed(2)),
        wpm: Math.round(120 + deterministicMetric(sessionId, 'wpm') * 40),
      };
      grade = metrics.stress_hit > 0.75 && metrics.timing_var < 0.35 ? 'A' : 'B';
    }
  } catch (error) {
    console.error('Error during AI scoring:', error);
    // Fallback to deterministic metrics on error
    metrics = {
      stress_hit: deterministicMetric(sessionId, 'stress'),
      timing_var: Number((1 - deterministicMetric(sessionId, 'timing')).toFixed(2)),
      wpm: Math.round(120 + deterministicMetric(sessionId, 'wpm') * 40),
      error: error.message
    };
    grade = 'B';
  }

  // Save enhanced score
  const score = await dataStore.saveAiScore({
    session_id: sessionId,
    metrics,
    prosody,
    audio_path: audioPath,
    reference_text: referenceText,
    hypothesis_text: hypothesisText,
    grade,
    cost_cents: 12,
  });

  // Create event
  await dataStore.createEvent({
    user_id: userId,
    event_time: new Date().toISOString(),
    event_name: 'ai_score_done',
    properties: {
      session_id: sessionId,
      grade,
      has_prosody: !!prosody,
      overall_accuracy: metrics.overall_accuracy || null
    },
    source: 'web',
  });

  // If this is a Dictogloss session, process vocabulary
  if (session.type === 'dictogloss' && session.output_blob) {
    try {
      const outputData = typeof session.output_blob === 'string'
        ? JSON.parse(session.output_blob)
        : session.output_blob;

      await reviewScheduler.processDictoglossSession(userId, sessionId, outputData);
    } catch (error) {
      console.error('Error processing Dictogloss vocabulary:', error);
    }
  }

  return score;
}

async function getScore(sessionId) {
  const score = await dataStore.getAiScoreBySession(sessionId);
  if (!score) {
    throw new Error('SCORE_NOT_FOUND');
  }
  return score;
}

module.exports = {
  triggerScore,
  getScore,
};
