/**
 * Tags Queries
 *
 * Handles all video tag-related database operations:
 * - Tag management (create, list, delete)
 * - Tag assignments to videos
 * - Tag-based filtering
 */

const { pool } = require('../core');

/**
 * Get all tags available to a user (system tags + user's custom tags)
 * @param {number} userId - User ID
 * @returns {Promise<Array>} Array of tag objects
 */
async function getAvailableTags(userId) {
  const result = await pool.query(
    `SELECT id, name, icon, color, user_id, created_at
     FROM video_tags
     WHERE user_id IS NULL OR user_id = $1
     ORDER BY
       CASE WHEN user_id IS NULL THEN 0 ELSE 1 END,
       created_at ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get all system (preset) tags
 * @returns {Promise<Array>} Array of system tag objects
 */
async function getSystemTags() {
  const result = await pool.query(
    `SELECT id, name, icon, color, created_at
     FROM video_tags
     WHERE user_id IS NULL
     ORDER BY created_at ASC`
  );
  return result.rows;
}

/**
 * Get user's custom tags
 * @param {number} userId - User ID
 * @returns {Promise<Array>} Array of user's custom tag objects
 */
async function getUserCustomTags(userId) {
  const result = await pool.query(
    `SELECT id, name, icon, color, created_at
     FROM video_tags
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Create a custom tag for a user
 * @param {number} userId - User ID
 * @param {string} name - Tag name
 * @param {string} icon - Tag icon (emoji)
 * @param {string} color - Tag color (hex)
 * @returns {Promise<Object>} Created tag object
 */
async function createUserTag(userId, name, icon = '🏷️', color = '#667eea') {
  const result = await pool.query(
    `INSERT INTO video_tags (user_id, name, icon, color)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, icon, color, user_id, created_at, updated_at`,
    [userId, name, icon, color]
  );
  return result.rows[0];
}

/**
 * Delete a user's custom tag
 * @param {number} userId - User ID
 * @param {number} tagId - Tag ID
 * @returns {Promise<boolean>} True if deleted, false if not found or not owned by user
 */
async function deleteUserTag(userId, tagId) {
  const result = await pool.query(
    `DELETE FROM video_tags
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [tagId, userId]
  );
  return result.rowCount > 0;
}

/**
 * Get tags assigned to a video
 * @param {number} videoId - Video resource ID
 * @returns {Promise<Array>} Array of tag objects
 */
async function getVideoTags(videoId) {
  const result = await pool.query(
    `SELECT vt.id, vt.name, vt.icon, vt.color, vt.user_id
     FROM video_tags vt
     JOIN video_tag_assignments vta ON vt.id = vta.tag_id
     WHERE vta.video_resource_id = $1
     ORDER BY vta.created_at ASC`,
    [videoId]
  );
  return result.rows;
}

/**
 * Assign a tag to a video
 * @param {number} videoId - Video resource ID
 * @param {number} tagId - Tag ID
 * @returns {Promise<Object>} Created assignment object
 */
async function assignTagToVideo(videoId, tagId) {
  const result = await pool.query(
    `INSERT INTO video_tag_assignments (video_resource_id, tag_id)
     VALUES ($1, $2)
     ON CONFLICT (video_resource_id, tag_id) DO NOTHING
     RETURNING id, video_resource_id, tag_id, created_at`,
    [videoId, tagId]
  );
  return result.rows[0] || null;
}

/**
 * Remove a tag from a video
 * @param {number} videoId - Video resource ID
 * @param {number} tagId - Tag ID
 * @returns {Promise<boolean>} True if removed, false if not found
 */
async function removeTagFromVideo(videoId, tagId) {
  const result = await pool.query(
    `DELETE FROM video_tag_assignments
     WHERE video_resource_id = $1 AND tag_id = $2
     RETURNING id`,
    [videoId, tagId]
  );
  return result.rowCount > 0;
}

/**
 * Get videos by tag IDs (with optional uploader filter)
 * @param {Array<number>} tagIds - Array of tag IDs
 * @param {number} uploaderId - Optional uploader ID to filter
 * @returns {Promise<Array>} Array of video resource objects
 */
async function getVideosByTags(tagIds, uploaderId = null) {
  if (!tagIds || tagIds.length === 0) {
    return [];
  }

  let query = `
    SELECT DISTINCT vr.*
    FROM video_resources vr
    JOIN video_tag_assignments vta ON vr.id = vta.video_resource_id
    WHERE vta.tag_id = ANY($1)
  `;

  const params = [tagIds];

  if (uploaderId) {
    query += ` AND vr.uploader_id = $2`;
    params.push(uploaderId);
  }

  query += ` ORDER BY vr.created_at DESC`;

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get tag statistics for a user's videos
 * @param {number} userId - User ID
 * @returns {Promise<Array>} Array of {tag_id, tag_name, video_count}
 */
async function getTagStatistics(userId) {
  const result = await pool.query(
    `SELECT
       vt.id as tag_id,
       vt.name as tag_name,
       vt.icon as tag_icon,
       vt.color as tag_color,
       COUNT(vta.video_resource_id) as video_count
     FROM video_tags vt
     LEFT JOIN video_tag_assignments vta ON vt.id = vta.tag_id
     LEFT JOIN video_resources vr ON vta.video_resource_id = vr.id
     WHERE (vt.user_id IS NULL OR vt.user_id = $1)
       AND (vr.uploader_id = $1 OR vr.id IS NULL)
     GROUP BY vt.id, vt.name, vt.icon, vt.color
     ORDER BY video_count DESC, vt.created_at ASC`,
    [userId]
  );
  return result.rows;
}

/**
 * Batch assign tags to a video
 * @param {number} videoId - Video resource ID
 * @param {Array<number>} tagIds - Array of tag IDs
 * @returns {Promise<number>} Number of assignments created
 */
async function batchAssignTags(videoId, tagIds) {
  if (!tagIds || tagIds.length === 0) {
    return 0;
  }

  const values = tagIds.map((tagId, idx) =>
    `($1, $${idx + 2})`
  ).join(', ');

  const result = await pool.query(
    `INSERT INTO video_tag_assignments (video_resource_id, tag_id)
     VALUES ${values}
     ON CONFLICT (video_resource_id, tag_id) DO NOTHING
     RETURNING id`,
    [videoId, ...tagIds]
  );

  return result.rowCount;
}

/**
 * Replace all tags for a video
 * @param {number} videoId - Video resource ID
 * @param {Array<number>} tagIds - Array of tag IDs to set
 * @returns {Promise<number>} Number of final assignments
 */
async function replaceVideoTags(videoId, tagIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Remove all existing tags
    await client.query(
      'DELETE FROM video_tag_assignments WHERE video_resource_id = $1',
      [videoId]
    );

    // Add new tags if any
    let count = 0;
    if (tagIds && tagIds.length > 0) {
      const values = tagIds.map((tagId, idx) =>
        `($1, $${idx + 2})`
      ).join(', ');

      const result = await client.query(
        `INSERT INTO video_tag_assignments (video_resource_id, tag_id)
         VALUES ${values}
         RETURNING id`,
        [videoId, ...tagIds]
      );
      count = result.rowCount;
    }

    await client.query('COMMIT');
    return count;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getAvailableTags,
  getSystemTags,
  getUserCustomTags,
  createUserTag,
  deleteUserTag,
  getVideoTags,
  assignTagToVideo,
  removeTagFromVideo,
  getVideosByTags,
  getTagStatistics,
  batchAssignTags,
  replaceVideoTags,
};
