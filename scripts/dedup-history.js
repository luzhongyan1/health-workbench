// 1. 清掉 health_checks 表中重复的历史记录（同 employee_id + check_date + vendor 保留最早一条）
// 2. 加唯一索引防止以后再被插入重复行
const { pool } = require('../db/config');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 统计清理前的数量
    const before = await client.query("SELECT COUNT(*) AS n FROM health_checks WHERE source = 'history'");
    console.log('清理前 history 记录条数：', before.rows[0].n);

    // 用 row_number 找出每组重复里 id 较大的（保留 id 最小那条）
    const deleted = await client.query(`
      WITH dups AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY employee_id, check_date, vendor, source
                 ORDER BY id ASC
               ) AS rn
        FROM health_checks
        WHERE source = 'history'
      )
      DELETE FROM health_checks
      WHERE id IN (SELECT id FROM dups WHERE rn > 1)
      RETURNING id
    `);
    console.log('已删除重复记录条数：', deleted.rowCount);

    const after = await client.query("SELECT COUNT(*) AS n FROM health_checks WHERE source = 'history'");
    console.log('清理后 history 记录条数：', after.rows[0].n);

    // 加唯一索引（部分索引，只对 source='history' 生效）
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_health_checks_history
      ON health_checks (employee_id, check_date, vendor, source)
      WHERE source = 'history'
    `);
    console.log('已创建唯一索引 uq_health_checks_history');

    await client.query('COMMIT');
    console.log('✅ 去重清理 + 唯一索引完成');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('失败：', e.message);
    process.exit(1);
  } finally {
    client.release();
  }
  process.exit(0);
}

run();
