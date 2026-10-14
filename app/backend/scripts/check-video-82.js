const dataStore = require('../data-store');

async function checkVideo82() {
  try {
    console.log('Checking video ID 82...\n');

    const video = await dataStore.getVideoResourceById(82);

    if (!video) {
      console.log('Video 82 not found!');
      return;
    }

    console.log('Video Details:');
    console.log('- ID:', video.id);
    console.log('- Title:', video.title);
    console.log('- YouTube ID:', video.youtube_video_id);
    console.log('- has_subtitles:', video.has_subtitles);
    console.log('- status:', video.status);
    console.log('- video_type:', video.video_type);
    console.log('\nTranscript Info:');
    console.log('- transcript length:', video.transcript ? video.transcript.length : 0);
    console.log('- transcript_segments type:', typeof video.transcript_segments);

    if (typeof video.transcript_segments === 'string') {
      console.log('- transcript_segments (string):', video.transcript_segments);
      try {
        const parsed = JSON.parse(video.transcript_segments);
        console.log('- transcript_segments (parsed length):', Array.isArray(parsed) ? parsed.length : 'not array');
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('- First segment:', parsed[0]);
        }
      } catch (e) {
        console.log('- Failed to parse transcript_segments:', e.message);
      }
    } else if (Array.isArray(video.transcript_segments)) {
      console.log('- transcript_segments (array length):', video.transcript_segments.length);
      if (video.transcript_segments.length > 0) {
        console.log('- First segment:', video.transcript_segments[0]);
      }
    } else {
      console.log('- transcript_segments value:', video.transcript_segments);
    }

    // Check video_sentences table
    console.log('\nChecking video_sentences table...');
    const result = await dataStore.query(
      'SELECT COUNT(*) as count FROM video_sentences WHERE video_id = $1',
      [82]
    );
    console.log('- video_sentences count:', result.rows[0].count);

    if (parseInt(result.rows[0].count) > 0) {
      const sampleResult = await dataStore.query(
        'SELECT sentence_index, text, start_time_sec, end_time_sec, speaker FROM video_sentences WHERE video_id = $1 ORDER BY sentence_index LIMIT 3',
        [82]
      );
      console.log('- Sample sentences:');
      sampleResult.rows.forEach(row => {
        console.log(`  [${row.sentence_index}] ${row.text.substring(0, 50)}... (${row.start_time_sec}-${row.end_time_sec}s)`);
      });
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

checkVideo82();
