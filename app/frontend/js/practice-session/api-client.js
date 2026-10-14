/**
 * API Client Module
 * Handles all API communication for practice session
 */

const API_BASE = '';

/**
 * Get authorization token from storage
 * @returns {string|null} - Auth token or null
 */
export function getAuthToken() {
  const keys = ['linglish_token', 'authToken'];
  for (const key of keys) {
    try {
      const value = localStorage.getItem(key);
      if (value && value !== 'null' && value !== 'undefined') return value;
    } catch (_) {}
  }
  for (const key of keys) {
    try {
      const value = sessionStorage.getItem(key);
      if (value && value !== 'null' && value !== 'undefined') return value;
    } catch (_) {}
  }
  return null;
}

export async function setProtectedMediaSource(element, rawPath) {
  if (!element || !rawPath) throw new Error('MEDIA_SOURCE_REQUIRED');
  const source = String(rawPath);
  if (source.startsWith('data:') || source.startsWith('blob:')) {
    element.src = source;
    return source;
  }

  const baseUrl = window.location?.href || 'http://localhost/';
  let target;
  let current;
  try {
    target = new URL(source, baseUrl);
    current = new URL(baseUrl);
  } catch (_) {
    element.src = source;
    return source;
  }
  const protectedPath = ['/videos/', '/recordings/', '/pdfs/'].some(prefix => (
    target.pathname.startsWith(prefix) && target.pathname.length > prefix.length
  ));
  if (target.origin !== current.origin || !protectedPath) {
    element.src = source;
    return source;
  }

  const token = getAuthToken();
  const mediaSession = window.LinglishMediaSession;
  if (!token || !mediaSession) throw new Error('MEDIA_SESSION_UNAVAILABLE');

  const state = await mediaSession.ensure({ token });
  return mediaSession.setElementSource(element, source, {
    mode: state.mode,
    legacyToken: token,
  });
}

function normalizeVideoResource(video) {
  if (!video || typeof video !== 'object') return video;
  const videoUrl = video.local_video_path || video.video_path || video.videoUrl || '';
  return {
    ...video,
    videoUrl,
    segments: Array.isArray(video.transcript_segments) ? video.transcript_segments : (video.segments || []),
  };
}

/**
 * Load role profile for a video
 * @param {string} videoId - Video ID
 * @returns {Promise<Object|null>} - Role profile or null
 */
export async function loadRoleProfile(videoId) {
  try {
    const token = getAuthToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`${API_BASE}/video-role-profiles?video_id=${encodeURIComponent(videoId)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.profile) || null;
  } catch (e) {
    console.warn('[Practice] loadRoleProfile failed:', e);
    return null;
  }
}

/**
 * Save role profile for a video
 * @param {Object} params - Parameters
 * @param {string} params.videoId - Video ID
 * @param {string} params.scope - Scope ('user' or 'global')
 * @param {number} params.roleCount - Number of roles
 * @param {number} params.roleRotation - Role rotation offset
 * @param {Array<string>} params.roleNames - Role names
 * @param {string} params.inferMode - Inference mode
 * @returns {Promise<Object|null>} - Saved profile or null
 */
export async function saveRoleProfile({
  videoId,
  scope = 'user',
  roleCount,
  roleRotation,
  roleNames,
  inferMode
}) {
  try {
    if (!videoId) return null;
    const token = getAuthToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    const body = {
      video_resource_id: videoId,
      scope,
      role_count: roleCount,
      role_rotation: roleRotation || 0,
      role_names: roleNames,
      infer_mode: inferMode,
    };
    const res = await fetch(`${API_BASE}/video-role-profiles`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[Practice] saveRoleProfile failed status', res.status);
      return null;
    }
    const data = await res.json();
    return (data && data.profile) || null;
  } catch (e) {
    console.warn('[Practice] saveRoleProfile failed:', e);
    return null;
  }
}

/**
 * Fetch video data
 * @param {string} videoId - Video ID
 * @returns {Promise<Object|null>} - Video data or null
 */
export async function fetchVideoData(videoId) {
  try {
    const token = getAuthToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(videoId)}`, { headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch video: ${res.status}`);
    }
    const data = await res.json();
    return normalizeVideoResource(data?.video || data);
  } catch (err) {
    console.error('[API] fetchVideoData failed:', err);
    throw err;
  }
}

/**
 * Fetch video list
 * @returns {Promise<Array>} - Array of videos
 */
export async function fetchVideoList() {
  try {
    const token = getAuthToken();
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch videos: ${res.status}`);
    }
    const data = await res.json();
    const items = (data && (data.items || data.videos)) || [];
    return items.map(normalizeVideoResource);
  } catch (err) {
    console.error('[API] fetchVideoList failed:', err);
    return [];
  }
}

/**
 * Upload recording to server
 * @param {Object} params - Upload parameters
 * @param {string} params.videoId - Video ID
 * @param {string|number} params.segmentIndex - Segment index
 * @param {string} params.speaker - Speaker name
 * @param {string} params.audioData - Audio data URL
 * @param {number|null} params.durationSec - Duration in seconds
 * @returns {Promise<Object|null>} - Uploaded recording data or null
 */
export async function uploadRecordingToServer({
  videoId,
  segmentIndex,
  speaker,
  audioData,
  durationSec = null
}) {
  try {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No auth token available');
    }

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    const body = {
      segmentIndex,
      speaker,
      audioData,
      durationSec
    };

    const res = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(videoId)}/recordings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Upload failed: ${res.status}`);
    }

    const data = await res.json();
    return (data && data.recording) || null;
  } catch (err) {
    console.error('[API] uploadRecordingToServer failed:', err);
    throw err;
  }
}

/**
 * Fetch user recordings for a video
 * @param {string} videoId - Video ID
 * @param {string|null} speaker - Speaker filter (optional)
 * @returns {Promise<Array>} - Array of recordings
 */
export async function fetchUserRecordings(videoId, speaker = null) {
  try {
    const token = getAuthToken();
    if (!token) {
      console.warn('[API] No auth token for fetching recordings');
      return [];
    }

    const headers = { 'Authorization': `Bearer ${token}` };
    let url = `${API_BASE}/video-resources/${encodeURIComponent(videoId)}/recordings`;
    if (speaker) {
      url += `?speaker=${encodeURIComponent(speaker)}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn('[API] fetchUserRecordings failed:', res.status);
      return [];
    }

    const data = await res.json();
    return (data && (data.items || data.recordings)) || [];
  } catch (err) {
    console.error('[API] fetchUserRecordings failed:', err);
    return [];
  }
}

/**
 * Delete a user recording
 * @param {string|number} recordingId - Recording ID
 * @returns {Promise<boolean>} - Success status
 */
export async function deleteUserRecording(recordingId) {
  try {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No auth token available');
    }

    const headers = { 'Authorization': `Bearer ${token}` };
    const res = await fetch(`${API_BASE}/user-recordings/${recordingId}`, {
      method: 'DELETE',
      headers,
    });

    return res.ok;
  } catch (err) {
    console.error('[API] deleteUserRecording failed:', err);
    return false;
  }
}

/**
 * Evaluate user speech against reference text
 * @param {Object} params - Evaluation parameters
 * @param {Blob|string} params.audioBlob - Audio blob or data URL
 * @param {string} params.referenceText - Reference text
 * @param {string} params.language - Language code
 * @returns {Promise<Object|null>} - Evaluation result or null
 */
export async function evaluateSpeech({ audioBlob, referenceText, language = 'en-US' }) {
  try {
    const token = getAuthToken();
    if (!token) {
      throw new Error('No auth token available');
    }

    // Convert blob to base64 data URL if necessary
    let audioData = audioBlob;
    if (audioBlob instanceof Blob) {
      audioData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read audio blob'));
        reader.readAsDataURL(audioBlob);
      });
    }

    const res = await fetch(`${API_BASE}/pronunciation/assess`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: referenceText,
        audio_data: audioData,
        language,
      }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      if (res.status === 402 && errorData.code === 'PRONUNCIATION_DAILY_LIMIT_REACHED') {
        const quota = errorData.quota || {};
        const tier = String(quota.tier || 'free').toLowerCase();
        const paywall = errorData.paywall || null;
        const message = paywall?.message || (tier === 'free'
          ? `今日免费发音评测 ${quota.limit || 0} 次已用完，升级会员可继续练习。`
          : `今日发音评测额度已用完，明天会自动恢复。`);
        const err = new Error(message);
        err.code = errorData.code;
        err.quota = quota;
        err.paywall = paywall;
        throw err;
      }
      throw new Error(errorData.message || `Evaluation failed: ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    console.error('[API] evaluateSpeech failed:', err);
    throw err;
  }
}
