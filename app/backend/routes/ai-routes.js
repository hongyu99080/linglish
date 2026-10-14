/**
 * AI Service Routes
 * API endpoints for AI features
 */

const express = require('express');
const router = express.Router();

/**
 * Initialize AI routes
 */
function initAIRoutes(db) {
  const AITutorService = require('../ai-services/ai-tutor-service');
  const CostTracker = require('../utils/cost-tracker');

  const aiTutor = new AITutorService(db);
  const costTracker = new CostTracker(db);

  /**
   * GET /api/ai/daily-plan
   * Get today's personalized learning plan
   */
  router.get('/daily-plan', async (req, res) => {
    try {
      const userId = req.user?.id || 1; // TODO: Get from auth middleware

      const plan = await aiTutor.generateDailyPlan(userId);

      res.json({
        success: true,
        plan
      });
    } catch (error) {
      console.error('Daily plan error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * POST /api/ai/chat
   * Chat with AI assistant
   */
  router.post('/chat', async (req, res) => {
    try {
      const userId = req.user?.id || 1;
      const { message, conversationId } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Message is required'
        });
      }

      const result = await aiTutor.chat(userId, message, conversationId);

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('Chat error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * GET /api/ai/cost/today
   * Get today's AI cost
   */
  router.get('/cost/today', async (req, res) => {
    try {
      const cost = await costTracker.getTodayCost();

      res.json({
        success: true,
        cost,
        currency: 'USD'
      });
    } catch (error) {
      console.error('Cost tracking error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * GET /api/ai/cost/budget
   * Check budget status
   */
  router.get('/cost/budget', async (req, res) => {
    try {
      const budget = await costTracker.checkBudget();

      res.json({
        success: true,
        budget
      });
    } catch (error) {
      console.error('Budget check error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * GET /api/ai/cost/stats
   * Get cost statistics
   */
  router.get('/cost/stats', async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const stats = await costTracker.getStatistics(days);

      res.json({
        success: true,
        stats
      });
    } catch (error) {
      console.error('Stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * POST /api/ai/plan/feedback
   * Submit feedback on daily plan
   */
  router.post('/plan/feedback', async (req, res) => {
    try {
      const userId = req.user?.id || 1;
      const { planId, rating, feedback, difficulty } = req.body;

      await db.query(`
        UPDATE daily_plans
        SET user_rating = $1,
            user_feedback = $2,
            difficulty_feedback = $3,
            feedback_submitted_at = NOW()
        WHERE id = $4 AND user_id = $5
      `, [rating, feedback, difficulty, planId, userId]);

      res.json({
        success: true,
        message: 'Feedback recorded'
      });
    } catch (error) {
      console.error('Feedback error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = initAIRoutes;
