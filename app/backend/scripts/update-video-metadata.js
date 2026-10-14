#!/usr/bin/env node

/**
 * Script to update video metadata and tags
 *
 * Usage:
 *   node scripts/update-video-metadata.js
 *
 * This script helps migrate video resources to use the new metadata fields
 * added in V9 and V10 migrations, including:
 * - tags (array of tag names)
 * - category
 * - difficulty_level
 * - is_public
 * - characters (roleplay characters)
 * - is_roleplay_enabled
 * - default_user_character
 */

const dataStore = require('../data-store');
const readline = require('readline');

// Predefined tag options (matching frontend video-tag-system.js)
const PRESET_TAGS = [
  { id: 'my', name: '我的', icon: '⭐', color: '#6366f1' },
  { id: 'work', name: '职场', icon: '💼', color: '#8b5cf6' },
  { id: 'shopping', name: '购物', icon: '🛒', color: '#ec4899' },
  { id: 'life', name: '生活', icon: '🏠', color: '#14b8a6' },
  { id: 'entertainment', name: '影视', icon: '🎬', color: '#f59e0b' },
  { id: 'kids', name: '儿童', icon: '🧸', color: '#38bdf8' },
  { id: 'family', name: '亲子', icon: '👨‍👩‍👧‍👦', color: '#22c55e' },
  { id: 'animation', name: '动画', icon: '🎨', color: '#f97316' },
  { id: 'story', name: '故事', icon: '📖', color: '#0ea5e9' },
  { id: 'campus', name: '校园', icon: '🏫', color: '#10b981' },
  { id: 'speech', name: '演讲', icon: '🎤', color: '#ef4444' },
  { id: 'course', name: '课程', icon: '📚', color: '#a855f7' }
];

// Difficulty levels
const DIFFICULTY_LEVELS = ['beginner', 'intermediate', 'advanced'];

// Categories (you can customize these)
const CATEGORIES = [
  'conversation',    // 对话
  'business',        // 商务
  'daily_life',      // 日常生活
  'entertainment',   // 娱乐
  'education',       // 教育
  'news',            // 新闻
  'interview',       // 采访
  'presentation',    // 演讲
  'other'            // 其他
];

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify question
function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// Display menu
function displayTagMenu() {
  console.log('\n可用标签:');
  PRESET_TAGS.forEach((tag, index) => {
    console.log(`  ${index + 1}. ${tag.icon} ${tag.name}`);
  });
  console.log('  0. 跳过\n');
}

function displayCategoryMenu() {
  console.log('\n可用分类:');
  CATEGORIES.forEach((cat, index) => {
    console.log(`  ${index + 1}. ${cat}`);
  });
  console.log('  0. 跳过\n');
}

function displayDifficultyMenu() {
  console.log('\n难度级别:');
  DIFFICULTY_LEVELS.forEach((level, index) => {
    console.log(`  ${index + 1}. ${level}`);
  });
  console.log('  0. 跳过\n');
}

async function updateVideoInteractive(video) {
  console.log('\n' + '='.repeat(60));
  console.log(`视频 ID: ${video.id}`);
  console.log(`标题: ${video.title}`);
  console.log(`描述: ${video.description || '(无)'}`);
  console.log(`时长: ${video.duration_sec ? Math.round(video.duration_sec) + '秒' : '(未知)'}`);
  console.log(`当前标签: ${video.tags && video.tags.length > 0 ? video.tags.join(', ') : '(无)'}`);
  console.log(`当前分类: ${video.category || '(无)'}`);
  console.log(`当前难度: ${video.difficulty_level || '(无)'}`);
  console.log('='.repeat(60));

  const updates = {};

  // Ask for tags
  displayTagMenu();
  const tagInput = await question('选择标签 (多个用逗号分隔，如 1,3,4): ');
  if (tagInput.trim() && tagInput.trim() !== '0') {
    const selectedIndices = tagInput.split(',').map(s => parseInt(s.trim()) - 1);
    const selectedTags = selectedIndices
      .filter(i => i >= 0 && i < PRESET_TAGS.length)
      .map(i => PRESET_TAGS[i].name);
    if (selectedTags.length > 0) {
      updates.tags = selectedTags;
      console.log(`✓ 已选择标签: ${selectedTags.join(', ')}`);
    }
  }

  // Ask for category
  displayCategoryMenu();
  const categoryInput = await question('选择分类 (输入数字): ');
  if (categoryInput.trim() && categoryInput.trim() !== '0') {
    const categoryIndex = parseInt(categoryInput.trim()) - 1;
    if (categoryIndex >= 0 && categoryIndex < CATEGORIES.length) {
      updates.category = CATEGORIES[categoryIndex];
      console.log(`✓ 已选择分类: ${updates.category}`);
    }
  }

  // Ask for difficulty
  displayDifficultyMenu();
  const difficultyInput = await question('选择难度 (输入数字): ');
  if (difficultyInput.trim() && difficultyInput.trim() !== '0') {
    const difficultyIndex = parseInt(difficultyInput.trim()) - 1;
    if (difficultyIndex >= 0 && difficultyIndex < DIFFICULTY_LEVELS.length) {
      updates.difficulty_level = DIFFICULTY_LEVELS[difficultyIndex];
      console.log(`✓ 已选择难度: ${updates.difficulty_level}`);
    }
  }

  // Ask for public/private
  const publicInput = await question('是否公开? (y/n，默认 y): ');
  if (publicInput.trim().toLowerCase() === 'n') {
    updates.is_public = false;
    console.log('✓ 设置为私有');
  } else {
    updates.is_public = true;
    console.log('✓ 设置为公开');
  }

  return updates;
}

async function updateVideoBatch(videos, defaultUpdates) {
  console.log('\n批量更新模式');
  console.log('将对所有视频应用相同的更新:');
  console.log(JSON.stringify(defaultUpdates, null, 2));

  const confirm = await question('\n确认批量更新? (y/n): ');
  if (confirm.trim().toLowerCase() !== 'y') {
    console.log('已取消批量更新');
    return 0;
  }

  let updated = 0;
  for (const video of videos) {
    try {
      await dataStore.updateVideoResource(video.id, defaultUpdates);
      console.log(`✓ 已更新视频 ${video.id}: ${video.title}`);
      updated++;
    } catch (err) {
      console.error(`✗ 更新视频 ${video.id} 失败:`, err.message);
    }
  }

  return updated;
}

async function main() {
  try {
    console.log('视频元数据更新工具');
    console.log('='.repeat(60));

    // Initialize database connection
    await dataStore.init();

    // Check if database is available
    if (dataStore.isDatabaseAvailable && !dataStore.isDatabaseAvailable()) {
      console.error('错误: 数据库不可用。请检查数据库连接。');
      process.exit(1);
    }

    // Get all videos
    const videos = await dataStore.listVideoResources();
    console.log(`\n找到 ${videos.length} 个视频\n`);

    if (videos.length === 0) {
      console.log('没有视频需要更新');
      rl.close();
      process.exit(0);
    }

    // Ask for mode
    console.log('更新模式:');
    console.log('  1. 交互式 - 逐个视频更新');
    console.log('  2. 批量 - 对所有视频应用相同设置');
    console.log('  3. 退出\n');

    const modeInput = await question('选择模式 (1/2/3): ');
    const mode = parseInt(modeInput.trim());

    if (mode === 1) {
      // Interactive mode
      let updatedCount = 0;
      for (const video of videos) {
        const shouldUpdate = await question(`\n更新视频 "${video.title}"? (y/n/q退出): `);
        if (shouldUpdate.trim().toLowerCase() === 'q') {
          break;
        }
        if (shouldUpdate.trim().toLowerCase() !== 'y') {
          continue;
        }

        const updates = await updateVideoInteractive(video);

        if (Object.keys(updates).length > 0) {
          const confirm = await question('\n确认更新? (y/n): ');
          if (confirm.trim().toLowerCase() === 'y') {
            try {
              await dataStore.updateVideoResource(video.id, updates);
              console.log(`✓ 视频 ${video.id} 已更新`);
              updatedCount++;
            } catch (err) {
              console.error(`✗ 更新失败:`, err.message);
            }
          }
        } else {
          console.log('没有更新内容');
        }
      }

      console.log(`\n完成! 共更新 ${updatedCount} 个视频`);
    } else if (mode === 2) {
      // Batch mode - configure once, apply to all
      console.log('\n配置批量更新设置:\n');

      // Configure default updates
      const defaultUpdates = {};

      displayTagMenu();
      const tagInput = await question('选择标签 (多个用逗号分隔): ');
      if (tagInput.trim() && tagInput.trim() !== '0') {
        const selectedIndices = tagInput.split(',').map(s => parseInt(s.trim()) - 1);
        const selectedTags = selectedIndices
          .filter(i => i >= 0 && i < PRESET_TAGS.length)
          .map(i => PRESET_TAGS[i].name);
        if (selectedTags.length > 0) {
          defaultUpdates.tags = selectedTags;
        }
      }

      displayCategoryMenu();
      const categoryInput = await question('选择分类: ');
      if (categoryInput.trim() && categoryInput.trim() !== '0') {
        const categoryIndex = parseInt(categoryInput.trim()) - 1;
        if (categoryIndex >= 0 && categoryIndex < CATEGORIES.length) {
          defaultUpdates.category = CATEGORIES[categoryIndex];
        }
      }

      displayDifficultyMenu();
      const difficultyInput = await question('选择难度: ');
      if (difficultyInput.trim() && difficultyInput.trim() !== '0') {
        const difficultyIndex = parseInt(difficultyInput.trim()) - 1;
        if (difficultyIndex >= 0 && difficultyIndex < DIFFICULTY_LEVELS.length) {
          defaultUpdates.difficulty_level = DIFFICULTY_LEVELS[difficultyIndex];
        }
      }

      const publicInput = await question('是否公开? (y/n，默认 y): ');
      if (publicInput.trim().toLowerCase() === 'n') {
        defaultUpdates.is_public = false;
      } else {
        defaultUpdates.is_public = true;
      }

      const updatedCount = await updateVideoBatch(videos, defaultUpdates);
      console.log(`\n完成! 共更新 ${updatedCount} 个视频`);
    } else {
      console.log('已退出');
    }

    rl.close();
    process.exit(0);
  } catch (err) {
    console.error('错误:', err);
    rl.close();
    process.exit(1);
  }
}

// Handle exit
rl.on('close', () => {
  console.log('\n再见!');
  process.exit(0);
});

main();
