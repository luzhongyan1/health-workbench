const { pool } = require('../config');

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        id_card VARCHAR(30) UNIQUE NOT NULL,
        phone VARCHAR(30),
        position VARCHAR(100),
        department VARCHAR(100),
        expected_onboard_date DATE,
        status VARCHAR(30) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS health_checks (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        id_card VARCHAR(30),
        check_date DATE,
        vendor VARCHAR(100),
        overall_result VARCHAR(30) DEFAULT 'pending',
        detail_json JSONB DEFAULT '{}'::jsonb,
        source VARCHAR(50) DEFAULT 'upload',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS check_items (
        id SERIAL PRIMARY KEY,
        health_check_id INTEGER REFERENCES health_checks(id) ON DELETE CASCADE,
        item_name VARCHAR(100) NOT NULL,
        item_value NUMERIC(10,2),
        unit VARCHAR(50),
        ai_result VARCHAR(30) DEFAULT 'manual',
        standard_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS standards (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        item_name TEXT NOT NULL,
        unit TEXT,
        pass_range TEXT,
        red_threshold TEXT,
        recheck_threshold TEXT,
        risk_text TEXT,
        version INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_name VARCHAR(100),
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(100),
        target_id INTEGER,
        old_value JSONB DEFAULT '{}'::jsonb,
        new_value JSONB DEFAULT '{}'::jsonb,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        recipient_role VARCHAR(50),
        recipient_id INTEGER,
        content TEXT NOT NULL,
        type VARCHAR(50),
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employees_id_card ON employees(id_card)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_health_checks_employee_id ON health_checks(employee_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id)
    `);

    await client.query('COMMIT');

    return { success: true, message: 'Database migrated successfully.' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then((result) => {
      console.log(result.message);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  runMigrations
};
