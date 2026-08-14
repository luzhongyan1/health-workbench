const { pool } = require('../config');

/**
 * 005_complete_schema.js
 *
 * 把散落在 scripts/ 一次性脚本里的表结构改动全部并入迁移链，保证
 * 换环境（或 PaaS 部署）只需按顺序执行 001~005 即可重建完整 schema：
 *
 *   - employees.uploaded_by      ← scripts/add_uploaded_by.js（RBAC 行级隔离依赖）
 *   - employees.upload_batch_id  ← scripts/migrate-batch-id.js（批次归属）
 *   - 003/004 的扩展字段         ← 合并进来，任何执行路径都完整
 *   - 短字段升 TEXT              ← scripts/migrate-lift-varchar30.sql、migrate-standards-text.js
 *
 * 全部幂等（ADD COLUMN IF NOT EXISTS / ALTER TYPE），可重复执行。
 * 运行：node db/migrations/005_complete_schema.js
 */
async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── employees 归属与批次字段（原一次性脚本）──
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS uploaded_by TEXT`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS upload_batch_id TEXT`);

    // ── 003 扩展字段（幂等合并，保证单链完整）──
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS actual_onboard_date DATE`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_location VARCHAR(500)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_category VARCHAR(200)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS recruiter VARCHAR(200)`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS provided_date DATE`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS check_date DATE`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS check_time TEXT`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS check_address TEXT`);
    await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender VARCHAR(50)`);

    // ── 短字段升 TEXT，避免长内容截断报错（原 migrate-lift-varchar30.sql）──
    await client.query(`ALTER TABLE employees ALTER COLUMN id_card TYPE TEXT`);
    await client.query(`ALTER TABLE employees ALTER COLUMN phone TYPE TEXT`);
    await client.query(`ALTER TABLE employees ALTER COLUMN status TYPE TEXT`);
    await client.query(`ALTER TABLE health_checks ALTER COLUMN overall_result TYPE TEXT`);
    await client.query(`ALTER TABLE health_checks ALTER COLUMN source TYPE TEXT`);
    await client.query(`ALTER TABLE health_checks ALTER COLUMN vendor TYPE TEXT`);

    // ── standards 表短字段放宽为 TEXT（原 migrate-standards-text.js）──
    await client.query(`ALTER TABLE standards ALTER COLUMN name TYPE TEXT`);
    await client.query(`ALTER TABLE standards ALTER COLUMN item_name TYPE TEXT`);
    await client.query(`ALTER TABLE standards ALTER COLUMN unit TYPE TEXT`);
    await client.query(`ALTER TABLE standards ALTER COLUMN pass_range TYPE TEXT`);
    await client.query(`ALTER TABLE standards ALTER COLUMN red_threshold TYPE TEXT`);
    await client.query(`ALTER TABLE standards ALTER COLUMN recheck_threshold TYPE TEXT`);

    await client.query('COMMIT');
    return { success: true, message: '005 完整 schema 已就绪（uploaded_by / upload_batch_id / 字段放宽）' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigration()
    .then((r) => { console.log(r.message); process.exit(0); })
    .catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
}

module.exports = { runMigration };
