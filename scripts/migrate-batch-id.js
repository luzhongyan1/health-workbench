/**
 * Migration: 给 employees 表加 upload_batch_id 字段
 * 并给现有 978 条数据打批次标签：
 *   - 15:26:00 的 23 条 → batch_real_20260812152600（真实上传）
 *   - 15:26:34~35 的 955 条 → batch_test_001（测试数据）
 *
 * 以后招聘上传时，每次生成 batch_real_YYYYMMDDHHmmss 格式的批次号
 * UI 只看 MAX(upload_batch_id) WHERE upload_batch_id LIKE 'batch_real_%'
 */
const { Pool } = require('pg');
const pool = new Pool({ host:'localhost', port:5432, user:'postgres', password:'19990614', database:'health_platform' });

(async () => {
  try {
    // 1. 备份
    const backupExists = (await pool.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name='employees_backup_20260812'
    `)).rows.length > 0;
    if (!backupExists) {
      await pool.query('CREATE TABLE employees_backup_20260812 AS SELECT * FROM employees');
      console.log('✅ 备份完成: employees_backup_20260812');
    } else {
      console.log('⚠️  备份表已存在，跳过');
    }

    // 2. 加字段
    await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS upload_batch_id TEXT');
    console.log('✅ 加字段: upload_batch_id');

    // 3. 打标签 - 23 条真实数据 (15:26:00)
    const r1 = await pool.query(`
      UPDATE employees SET upload_batch_id = 'batch_real_20260812152600'
      WHERE TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') = '2026-08-12 15:26:00'
    `);
    console.log(`✅ 真实批次: ${r1.rowCount} 条 → batch_real_20260812152600`);

    // 4. 打标签 - 955 条测试数据 (15:26:34~35)
    const r2 = await pool.query(`
      UPDATE employees SET upload_batch_id = 'batch_test_001'
      WHERE upload_batch_id IS NULL
    `);
    console.log(`✅ 测试批次: ${r2.rowCount} 条 → batch_test_001`);

    // 5. 验证
    const dist = (await pool.query(`
      SELECT upload_batch_id, COUNT(*)::int c FROM employees GROUP BY upload_batch_id ORDER BY upload_batch_id
    `)).rows;
    console.log('\n=== 批次分布 ===');
    dist.forEach(r => console.log(`  ${r.upload_batch_id}: ${r.c} 条`));

    // 6. 模拟 UI 计算：只看最新 real 批次
    const realBatchStats = (await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.employee_id = employees.id AND hc.source='history'
            AND hc.check_date >= CURRENT_DATE - INTERVAL '90 day'
            AND LOWER(hc.overall_result) IN ('pass','合格','合格-有风险','pass-risk','pass_risk','合格有风险')
        ))::int AS exempt,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.employee_id = employees.id AND hc.source='history'
            AND hc.check_date >= CURRENT_DATE - INTERVAL '90 day'
            AND LOWER(hc.overall_result) IN ('pass','合格','合格-有风险','pass-risk','pass_risk','合格有风险')
        ))::int AS needs
      FROM employees
      WHERE upload_batch_id = (
        SELECT MAX(upload_batch_id) FROM employees WHERE upload_batch_id LIKE 'batch_real_%'
      )
    `)).rows[0];
    console.log('\n=== 最新 real 批次统计（UI 应显示的数字）===');
    console.log(`  总人数: ${realBatchStats.total}`);
    console.log(`  需预约: ${realBatchStats.needs}`);
    console.log(`  免检: ${realBatchStats.exempt}`);

    console.log('\n✅ Migration 完成');
  } catch (err) {
    console.error('❌ Migration 失败:', err.message);
    process.exit(1);
  }
  await pool.end();
})();
