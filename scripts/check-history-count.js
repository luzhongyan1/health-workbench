// 快速核对数据库里历史体检记录的条数
const { pool } = require('../db/config');

(async () => {
  try {
    const r1 = await pool.query("SELECT COUNT(*) AS total FROM health_checks WHERE source = 'history'");
    const r2 = await pool.query("SELECT COUNT(*) AS total FROM health_checks");
    const r3 = await pool.query("SELECT COUNT(DISTINCT employee_id) AS people FROM health_checks WHERE source = 'history'");
    const r4 = await pool.query("SELECT COUNT(*) AS total FROM employees");
    const r5 = await pool.query(`
      SELECT check_date, COUNT(*) AS cnt
      FROM health_checks
      WHERE source = 'history'
      GROUP BY check_date
      ORDER BY check_date DESC
      LIMIT 5
    `);
    console.log('历史体检记录条数 (source=history)：', r1.rows[0].total);
    console.log('健康记录总条数：', r2.rows[0].total);
    console.log('历史体检覆盖员工人数：', r3.rows[0].people);
    console.log('系统员工总人数：', r4.rows[0].total);
    console.log('最近 5 个体检日期的记录数：');
    r5.rows.forEach(row => console.log(`  ${row.check_date}: ${row.cnt} 条`));
    process.exit(0);
  } catch (e) {
    console.error('查询失败：', e.message);
    process.exit(1);
  }
})();
