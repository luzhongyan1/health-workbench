const { runMigrations } = require('./migrations/001_init');
const { runMigration: usersMigration } = require('./migrations/002_users_roles');
const { runMigration: extendMigration } = require('./migrations/003_extend_employees');
const { runMigration: widenMigration } = require('./migrations/004_widen_employee_fields');
const { runMigration: completeMigration } = require('./migrations/005_complete_schema');
const seedUsers = require('./seeds/seed_users');

/**
 * ensureSchema()
 *
 * 串联全部迁移（001~005）+ 种子账号，供 app.js 启动时调用。
 * 全部幂等，任何环境（本地 / PaaS）执行都是安全的：
 *   - 全新数据库 → 自动建齐所有表、字段、索引与种子账号
 *   - 已初始化数据库 → 空操作，不破坏任何数据
 *
 * 这样 PaaS 部署时无需手动执行任何初始化命令，启动即就绪。
 */
async function ensureSchema() {
  await runMigrations();         // 001 基础表（employees/health_checks/check_items/standards/audit_logs/notifications）
  await usersMigration();        // 002 users 表（含 role 字段）
  await extendMigration();       // 003 employees 扩展 9 字段
  await widenMigration();        // 004 字段长度放宽
  await completeMigration();     // 005 完整 schema（归属/批次/升 TEXT，原一次性脚本并入）
  await seedUsers();             // 种子账号（ssc_admin/recruiter1/trainer1，幂等 upsert）
  console.log('[ensure-schema] Migrations 001-005 + seeds 全部就绪');
}

module.exports = { ensureSchema };
