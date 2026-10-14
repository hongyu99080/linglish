#!/usr/bin/env node

/**
 * Batch update video metadata from JSON config file
 *
 * Usage:
 *   node scripts/batch-update-videos.js [config-file.json]
 *
 * Config file format:
 * {
 *   "defaultTags": ["我的", "生活"],
 *   "defaultCategory": "daily_life",
 *   "defaultDifficulty": "intermediate",
 *   "defaultIsPublic": true,
 *   "videos": [
 *     {
 *       "id": 1,
 *       "tags": ["职场", "商务"],
 *       "category": "business",
 *       "difficulty_level": "advanced"
 *     }
 *   ]
 * }
 */

const dataStore = require('../data-store');
const fs = require('fs').promises;
const path = require('path');

async function loadConfig(configPath) {
  try {
    const content = await fs.readFile(configPath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`无法读取配置文件 ${configPath}:`, err.message);
    process.exit(1);
  }
}

async function main() {
  try {
    console.log('批量视频元数据更新工具\n');

    // Get config file path from arguments or use default
    const configPath = process.argv[2] || path.join(__dirname, 'video-metadata-config.json');

    console.log(`读取配置文件: ${configPath}\n`);

    // Check if config file exists
    try {
      await fs.access(configPath);
    } catch (err) {
      console.error(`配置文件不存在: ${configPath}`);
      console.log('\n创建示例配置文件...\n');

      // Create example config
      const exampleConfig = {
        "defaultTags": ["我的"],
        "defaultCategory": "daily_life",
        "defaultDifficulty": "intermediate",
        "defaultIsPublic": true,
        "videos": [
          {
            "id": 1,
            "tags": ["职场"],
            "category": "business",
            "difficulty_level": "advanced",
            "description": "商务英语对话"
          }
        ]
      };

      await fs.writeFile(configPath, JSON.stringify(exampleConfig, null, 2), 'utf8');
      console.log(`已创建示例配置文件: ${configPath}`);
      console.log('请编辑配置文件后重新运行此脚本\n');
      process.exit(0);
    }

    // Load config
    const config = await loadConfig(configPath);

    // Initialize database
    await dataStore.init();

    if (dataStore.isDatabaseAvailable && !dataStore.isDatabaseAvailable()) {
      console.error('错误: 数据库不可用');
      process.exit(1);
    }

    // Get all videos
    const allVideos = await dataStore.listVideoResources();
    console.log(`数据库中共有 ${allVideos.length} 个视频\n`);

    let updatedCount = 0;
    let errorCount = 0;

    // Process videos from config
    if (config.videos && Array.isArray(config.videos)) {
      console.log(`配置文件中指定了 ${config.videos.length} 个视频\n`);

      for (const videoConfig of config.videos) {
        const videoId = videoConfig.id;
        if (!videoId) {
          console.error('跳过: 视频配置缺少 id');
          errorCount++;
          continue;
        }

        // Get video from database
        const video = await dataStore.getVideoResourceById(videoId);
        if (!video) {
          console.error(`跳过: 视频 ${videoId} 不存在`);
          errorCount++;
          continue;
        }

        // Build updates object
        const updates = {};

        // Apply video-specific overrides or defaults
        if (videoConfig.tags !== undefined) {
          updates.tags = videoConfig.tags;
        } else if (config.defaultTags) {
          updates.tags = config.defaultTags;
        }

        if (videoConfig.category !== undefined) {
          updates.category = videoConfig.category;
        } else if (config.defaultCategory) {
          updates.category = config.defaultCategory;
        }

        if (videoConfig.difficulty_level !== undefined) {
          updates.difficulty_level = videoConfig.difficulty_level;
        } else if (config.defaultDifficulty) {
          updates.difficulty_level = config.defaultDifficulty;
        }

        if (videoConfig.is_public !== undefined) {
          updates.is_public = videoConfig.is_public;
        } else if (config.defaultIsPublic !== undefined) {
          updates.is_public = config.defaultIsPublic;
        }

        // Optional fields
        if (videoConfig.description !== undefined) {
          updates.description = videoConfig.description;
        }
        if (videoConfig.title !== undefined) {
          updates.title = videoConfig.title;
        }

        // Update video
        if (Object.keys(updates).length > 0) {
          try {
            await dataStore.updateVideoResource(videoId, updates);
            console.log(`✓ 已更新视频 ${videoId}: ${video.title}`);
            console.log(`  更新内容:`, updates);
            updatedCount++;
          } catch (err) {
            console.error(`✗ 更新视频 ${videoId} 失败:`, err.message);
            errorCount++;
          }
        } else {
          console.log(`跳过视频 ${videoId}: 没有更新内容`);
        }
      }
    } else {
      // Apply defaults to all videos
      console.log('应用默认设置到所有视频\n');

      const defaultUpdates = {};
      if (config.defaultTags) defaultUpdates.tags = config.defaultTags;
      if (config.defaultCategory) defaultUpdates.category = config.defaultCategory;
      if (config.defaultDifficulty) defaultUpdates.difficulty_level = config.defaultDifficulty;
      if (config.defaultIsPublic !== undefined) defaultUpdates.is_public = config.defaultIsPublic;

      if (Object.keys(defaultUpdates).length === 0) {
        console.log('配置文件中没有指定任何更新');
        process.exit(0);
      }

      console.log('默认更新内容:');
      console.log(JSON.stringify(defaultUpdates, null, 2));
      console.log('');

      for (const video of allVideos) {
        try {
          await dataStore.updateVideoResource(video.id, defaultUpdates);
          console.log(`✓ 已更新视频 ${video.id}: ${video.title}`);
          updatedCount++;
        } catch (err) {
          console.error(`✗ 更新视频 ${video.id} 失败:`, err.message);
          errorCount++;
        }
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`完成! 成功: ${updatedCount}, 失败: ${errorCount}`);
    console.log('='.repeat(60) + '\n');

    process.exit(errorCount > 0 ? 1 : 0);
  } catch (err) {
    console.error('错误:', err);
    process.exit(1);
  }
}

main();
