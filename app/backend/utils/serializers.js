/**
 * Data serialization utilities
 */

function serializeVideoResource(resource) {
  if (!resource) return null;
  let segments = [];
  if (Array.isArray(resource.transcript_segments)) {
    segments = resource.transcript_segments;
  } else if (resource.transcript_segments) {
    if (typeof resource.transcript_segments === 'string') {
      try {
        segments = JSON.parse(resource.transcript_segments);
      } catch (err) {
        segments = [];
      }
    } else {
      segments = resource.transcript_segments;
    }
  }

  return {
    id: resource.id,
    uploader_id: resource.uploader_id,
    title: resource.title,
    description: resource.description,
    video_path: resource.video_path,
    thumbnail_path: (typeof resource.thumbnail_path === 'string' && resource.thumbnail_path.includes('${')) ? null : resource.thumbnail_path,
    original_filename: resource.original_filename,
    transcript: resource.transcript,
    transcript_segments: segments,
    language: resource.language,
    duration_sec: resource.duration_sec,
    status: resource.status,
    failure_reason: resource.failure_reason,
    is_public: resource.is_public !== undefined ? resource.is_public : true,
    is_featured: resource.is_featured === true,
    is_vip_only: resource.is_vip_only === true,
    created_at: resource.created_at,
    updated_at: resource.updated_at,
  };
}

function serializePracticeRecording(recording) {
  if (!recording) return null;
  return {
    id: recording.id,
    video_id: recording.video_resource_id,
    user_id: recording.user_id,
    speaker: recording.speaker,
    segment_index: recording.segment_index,
    audio_url: recording.audio_path,
    duration_sec: recording.duration_sec,
    created_at: recording.created_at,
    updated_at: recording.updated_at,
  };
}

module.exports = {
  serializeVideoResource,
  serializePracticeRecording,
};
