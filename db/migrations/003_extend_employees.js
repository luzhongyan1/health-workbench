const { pool } = require('../config');

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS actual_onboard_date DATE`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_location VARCHAR(100)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_category VARCHAR(50)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS recruiter VARCHAR(100)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS provided_date DATE`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS check_date DATE`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS check_time VARCHAR(20)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS check_address TEXT`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender VARCHAR(10)`);
    await client.query('COMMIT');
    return { success: true, message: 'employees 表已扩展 9 个新字段' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigration()
    .then(r => { console.log(r.message); process.exit(0); })
    .catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
}

module.exports = { runMigration };