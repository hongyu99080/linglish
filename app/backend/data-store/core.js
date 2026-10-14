const { Pool } = require('pg');
const performanceConfig = require('../config/performance');

// Database URL must be configured via DATABASE_URL environment variable
if (!process.env.DATABASE_URL) {
  console.warn('[DataStore] DATABASE_URL not set in environment, database will be unavailable');
}

// Connection pool configuration with performance optimizations
const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: performanceConfig.connectionPool.max,
  min: performanceConfig.connectionPool.min,
  idleTimeoutMillis: performanceConfig.connectionPool.idleTimeoutMillis,
  connectionTimeoutMillis: performanceConfig.connectionPool.connectionTimeoutMillis,
};

const pool = new Pool(poolConfig);

// Log pool configuration on startup
console.log(`[DataStore] Connection pool configured: max=${poolConfig.max}, min=${poolConfig.min}, idleTimeout=${poolConfig.idleTimeoutMillis}ms`);

let isReady = false;
let dbUnavailable = false;

function assertDbAvailable() {
  if (dbUnavailable) {
    throw new Error('DATASTORE_UNAVAILABLE');
  }
}

function isDatabaseAvailable() {
  return !dbUnavailable;
}

async function init() {
  if (dbUnavailable) return null;
  if (isReady) return pool;

  // Import schema/seed modules here to avoid circular dependency issues
  const { ensureAuxTables } = require('./schema');
  const { ensureSeedData } = require('./seed');

  try {
    await pool.query('SELECT 1');
    await ensureSeedData();
    await ensureAuxTables();
    isReady = true;
    return pool;
  } catch (err) {
    dbUnavailable = true;
    console.warn('[DataStore] Database unavailable, switching to fallback mode:', err.message);
    return null;
  }
}

module.exports = {
  pool,
  init,
  isDatabaseAvailable,
  assertDbAvailable,
  dbUnavailable: () => dbUnavailable,
  setDbUnavailable: (value) => { dbUnavailable = value; },
};
