/**
 * Study Groups Service
 * 学习小组服务
 *
 * 功能：
 * 1. 创建/管理学习小组
 * 2. 小组成员管理
 * 3. 小组挑战
 * 4. 小组排行榜
 */

const dataStore = require('../data-store');

class StudyGroupsService {

  /**
   * 创建学习小组
   */
  async createGroup(userId, groupData) {
    const {
      name,
      description,
      groupType = 'public',
      maxMembers = 50,
      learningGoal,
      targetLanguage = 'en',
      difficultyLevel
    } = groupData;

    try {
      // 创建小组
      const groupQuery = `
        INSERT INTO study_groups (
          name, description, owner_id, group_type, max_members,
          learning_goal, target_language, difficulty_level
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;
      const groupResult = await dataStore.query(groupQuery, [
        name, description, userId, groupType, maxMembers,
        learningGoal, targetLanguage, difficultyLevel
      ]);

      const group = groupResult.rows[0];

      // 自动将创建者加入小组
      await this.joinGroup(group.id, userId, 'owner');

      return group;
    } catch (error) {
      console.error('Error creating group:', error);
      throw error;
    }
  }

  /**
   * 加入学习小组
   */
  async joinGroup(groupId, userId, role = 'member') {
    try {
      // 检查小组是否存在
      const groupQuery = `SELECT * FROM study_groups WHERE id = $1 AND is_active = TRUE`;
      const groupResult = await dataStore.query(groupQuery, [groupId]);

      if (groupResult.rows.length === 0) {
        throw new Error('Group not found');
      }

      const group = groupResult.rows[0];

      // 检查是否已加入
      const memberQuery = `
        SELECT * FROM study_group_members
        WHERE group_id = $1 AND user_id = $2
      `;
      const memberResult = await dataStore.query(memberQuery, [groupId, userId]);

      if (memberResult.rows.length > 0) {
        throw new Error('Already a member');
      }

      // 检查人数限制
      if (group.member_count >= group.max_members) {
        throw new Error('Group is full');
      }

      // 加入小组
      const insertQuery = `
        INSERT INTO study_group_members (group_id, user_id, role, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING *
      `;
      const result = await dataStore.query(insertQuery, [groupId, userId, role]);

      // 更新小组成员数
      await dataStore.query(
        `UPDATE study_groups SET member_count = member_count + 1 WHERE id = $1`,
        [groupId]
      );

      return result.rows[0];
    } catch (error) {
      console.error('Error joining group:', error);
      throw error;
    }
  }

  /**
   * 离开学习小组
   */
  async leaveGroup(groupId, userId) {
    try {
      // 检查是否为组长
      const memberQuery = `
        SELECT * FROM study_group_members
        WHERE group_id = $1 AND user_id = $2
      `;
      const memberResult = await dataStore.query(memberQuery, [groupId, userId]);

      if (memberResult.rows.length === 0) {
        throw new Error('Not a member');
      }

      const member = memberResult.rows[0];

      if (member.role === 'owner') {
        throw new Error('Owner cannot leave. Transfer ownership or delete group.');
      }

      // 删除成员记录
      await dataStore.query(
        `DELETE FROM study_group_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
      );

      // 更新小组成员数
      await dataStore.query(
        `UPDATE study_groups SET member_count = member_count - 1 WHERE id = $1`,
        [groupId]
      );

      return true;
    } catch (error) {
      console.error('Error leaving group:', error);
      throw error;
    }
  }

  /**
   * 获取学习小组列表
   */
  async getGroups(filters = {}) {
    const { groupType, difficultyLevel, limit = 20, offset = 0 } = filters;

    let whereClause = 'WHERE is_active = TRUE';
    const params = [];
    let paramIndex = 1;

    if (groupType) {
      whereClause += ` AND group_type = $${paramIndex}`;
      params.push(groupType);
      paramIndex++;
    }

    if (difficultyLevel) {
      whereClause += ` AND difficulty_level = $${paramIndex}`;
      params.push(difficultyLevel);
      paramIndex++;
    }

    params.push(limit, offset);

    const query = `
      SELECT
        sg.*,
        u.username AS owner_name
      FROM study_groups sg
      JOIN users u ON sg.owner_id = u.id
      ${whereClause}
      ORDER BY sg.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const result = await dataStore.query(query, params);
    return result.rows;
  }

  /**
   * 获取小组详情
   */
  async getGroupDetail(groupId, userId = null) {
    const groupQuery = `
      SELECT
        sg.*,
        u.username AS owner_name
      FROM study_groups sg
      JOIN users u ON sg.owner_id = u.id
      WHERE sg.id = $1
    `;
    const groupResult = await dataStore.query(groupQuery, [groupId]);

    if (groupResult.rows.length === 0) {
      throw new Error('Group not found');
    }

    const group = groupResult.rows[0];

    // 获取成员列表
    const membersQuery = `
      SELECT
        sgm.*,
        u.username,
        u.level
      FROM study_group_members sgm
      JOIN users u ON sgm.user_id = u.id
      WHERE sgm.group_id = $1 AND sgm.status = 'active'
      ORDER BY sgm.contribution_xp DESC
      LIMIT 10
    `;
    const membersResult = await dataStore.query(membersQuery, [groupId]);

    // 检查当前用户是否已加入
    let isMember = false;
    let memberRole = null;
    if (userId) {
      const checkQuery = `
        SELECT role FROM study_group_members
        WHERE group_id = $1 AND user_id = $2 AND status = 'active'
      `;
      const checkResult = await dataStore.query(checkQuery, [groupId, userId]);
      if (checkResult.rows.length > 0) {
        isMember = true;
        memberRole = checkResult.rows[0].role;
      }
    }

    return {
      ...group,
      members: membersResult.rows,
      is_member: isMember,
      member_role: memberRole
    };
  }

  /**
   * 获取用户的小组列表
   */
  async getUserGroups(userId) {
    const query = `
      SELECT
        sg.*,
        sgm.role,
        sgm.contribution_xp,
        u.username AS owner_name
      FROM study_group_members sgm
      JOIN study_groups sg ON sgm.group_id = sg.id
      JOIN users u ON sg.owner_id = u.id
      WHERE sgm.user_id = $1 AND sgm.status = 'active' AND sg.is_active = TRUE
      ORDER BY sgm.joined_at DESC
    `;
    const result = await dataStore.query(query, [userId]);
    return result.rows;
  }

  /**
   * 更新小组成员贡献
   */
  async updateMemberContribution(groupId, userId, xp, studyMinutes) {
    const query = `
      UPDATE study_group_members
      SET
        contribution_xp = contribution_xp + $3,
        study_minutes = study_minutes + $4,
        active_days = active_days + 1,
        last_active_at = CURRENT_TIMESTAMP
      WHERE group_id = $1 AND user_id = $2
      RETURNING *
    `;
    const result = await dataStore.query(query, [groupId, userId, xp, studyMinutes]);

    // 更新小组总数据
    await dataStore.query(
      `UPDATE study_groups
       SET total_study_minutes = total_study_minutes + $2,
           total_xp = total_xp + $3
       WHERE id = $1`,
      [groupId, studyMinutes, xp]
    );

    return result.rows[0];
  }

  /**
   * 创建小组挑战
   */
  async createChallenge(groupId, userId, challengeData) {
    const {
      title,
      description,
      challengeType,
      targetValue,
      startDate,
      endDate
    } = challengeData;

    try {
      const query = `
        INSERT INTO group_challenges (
          group_id, title, description, challenge_type,
          target_value, start_date, end_date,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;
      const result = await dataStore.query(query, [
        groupId, title, description, challengeType,
        targetValue, startDate, endDate,
        userId
      ]);

      return result.rows[0];
    } catch (error) {
      console.error('Error creating challenge:', error);
      throw error;
    }
  }

  /**
   * 参加小组挑战
   */
  async joinChallenge(challengeId, userId) {
    try {
      const query = `
        INSERT INTO group_challenge_participants (challenge_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT (challenge_id, user_id) DO NOTHING
        RETURNING *
      `;
      const result = await dataStore.query(query, [challengeId, userId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error joining challenge:', error);
      throw error;
    }
  }

  /**
   * 更新挑战进度
   */
  async updateChallengeProgress(challengeId, userId, progressValue) {
    try {
      // 更新用户进度
      const updateQuery = `
        UPDATE group_challenge_participants
        SET
          progress = progress + $3,
          updated_at = NOW()
        WHERE challenge_id = $1 AND user_id = $2
        RETURNING *
      `;
      const result = await dataStore.query(updateQuery, [challengeId, userId, progressValue]);

      // 更新挑战总进度
      const sumQuery = `
        SELECT SUM(progress) AS total
        FROM group_challenge_participants
        WHERE challenge_id = $1
      `;
      const sumResult = await dataStore.query(sumQuery, [challengeId]);
      const totalProgress = sumResult.rows[0].total || 0;

      await dataStore.query(
        `UPDATE group_challenges SET current_value = $2 WHERE id = $1`,
        [challengeId, totalProgress]
      );

      return result.rows[0];
    } catch (error) {
      console.error('Error updating challenge progress:', error);
      throw error;
    }
  }

  /**
   * 获取小组挑战列表
   */
  async getGroupChallenges(groupId) {
    const query = `
      SELECT
        gc.*,
        COUNT(gcp.id) AS participant_count,
        u.username AS creator_name
      FROM group_challenges gc
      LEFT JOIN group_challenge_participants gcp ON gc.id = gcp.challenge_id
      LEFT JOIN users u ON gc.created_by = u.id
      WHERE gc.group_id = $1
      GROUP BY gc.id, u.username
      ORDER BY gc.created_at DESC
    `;
    const result = await dataStore.query(query, [groupId]);
    return result.rows;
  }

  /**
   * 获取小组排行榜
   */
  async getGroupLeaderboard(groupId, metric = 'contribution_xp') {
    let orderByClause = 'sgm.contribution_xp DESC';

    switch (metric) {
      case 'study_minutes':
        orderByClause = 'sgm.study_minutes DESC';
        break;
      case 'active_days':
        orderByClause = 'sgm.active_days DESC';
        break;
    }

    const query = `
      SELECT
        sgm.*,
        u.username,
        u.level,
        ROW_NUMBER() OVER (ORDER BY ${orderByClause}) AS rank
      FROM study_group_members sgm
      JOIN users u ON sgm.user_id = u.id
      WHERE sgm.group_id = $1 AND sgm.status = 'active'
      ORDER BY ${orderByClause}
      LIMIT 50
    `;
    const result = await dataStore.query(query, [groupId]);
    return result.rows;
  }

  /**
   * 发布小组动态
   */
  async postActivity(groupId, userId, activityType, content, activityData = {}) {
    const query = `
      INSERT INTO group_activities (
        group_id, user_id, activity_type, content, activity_data
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await dataStore.query(query, [
      groupId, userId, activityType, content, JSON.stringify(activityData)
    ]);
    return result.rows[0];
  }

  /**
   * 获取小组动态
   */
  async getGroupActivities(groupId, limit = 20, activityType = null) {
    const conditions = ['ga.group_id = $1'];
    const params = [groupId];
    if (activityType) {
      params.push(activityType);
      conditions.push(`ga.activity_type = $${params.length}`);
    }
    params.push(limit);
    const query = `
      SELECT
        ga.*,
        u.username
      FROM group_activities ga
      LEFT JOIN users u ON ga.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ga.created_at DESC
      LIMIT $${params.length}
    `;
    const result = await dataStore.query(query, params);
    return result.rows;
  }
}

module.exports = new StudyGroupsService();
