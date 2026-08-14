/**
 * 一次性脚本：为 employees 表增加 uploaded_by（导入人归属）字段
 *
 * 背景：
 *   - 招聘端需要"只看自己导入的数据"（数据行级隔离）
 *   - employees 表原本没有导入人字段
 *   - 历史数据（batch_real_* 最新真实批次）回填给 recruiter1 账号，
 *     保证招聘人员登录后能看到当前批次效果；此后新导入的名单自动归属到导入账号
 *
 * 运行：node scripts/add_uploaded_by.js
 */
const { pool } = require('../db/config');

async function main() {
  // 1. 加列（幂等）
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS uploaded_by TEXT`);
  console.log('[1/3] employees.uploaded_by 列已就绪');

  // 2. 回填最新真实批次（batch_real_* 且未设置归属的）给 recruiter1
  const { rowCount: backfilled } = await pool.query(`
    UPDATE employees
    SET uploaded_by = 'recruiter1'
    WHERE uploaded_by IS NULL
      AND upload_batch_id LIKE 'batch_real_%'
  `);
  console.log(`[2/3] 已回填 ${backfilled} 条最新真实批次数据 → 归属 recruiter1`);

  // 3. 校验
  const { rows } = await pool.query(`
    SELECT COALESCE(uploaded_by, '(未归属)') AS owner, COUNT(*)::int AS cnt
    FROM employees
    GROUP BY uploaded_by
    ORDER BY cnt DESC
  `);
  console.log('[3/3] 归属分布:', JSON.stringify(rows, null, 2));
  pool.end();
}

main().catch((e) => { console.error('迁移失败:', e.message); pool.end(); process.exit(1); });
