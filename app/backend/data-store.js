/**
 * Data Store - Main entry point
 *
 * This file has been refactored into a modular structure.
 * All functionality is now organized in domain-specific modules under ./data-store/
 *
 * Structure:
 * - index.js: Main entry point with pool initialization
 * - schema.js: Database table creation logic
 * - seed.js: Seed data loading
 * - queries/users.js: User management and authentication
 * - queries/training.js: Training sessions, events, and AI scores
 * - queries/videos.js: Video resources and articles
 * - queries/vocabulary.js: Vocabulary learning and management
 * - queries/pronunciation.js: Pronunciation assessments
 * - queries/roleplay.js: Scene quests, roleplay runs, and rewards
 * - queries/feedback.js: User feedback management
 * - queries/analytics.js: Usage statistics and analytics
 * - utils/helpers.js: Utility functions
 */

module.exports = require('./data-store/index');
