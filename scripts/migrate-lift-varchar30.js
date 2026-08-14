// 一次性运行：把路由相关 VARCHAR(30) 字段扩到 TEXT
const { pool } = require('../db/config');

(async () => {
  const alters = [
    "ALTER TABLE employees ALTER COLUMN id_card TYPE TEXT",
    "ALTER TABLE employees ALTER COLUMN phone TYPE TEXT",
    "ALTER TABLE employees ALTER COLUMN status TYPE TEXT",
    "ALTER TABLE health_checks ALTER COLUMN overall_result TYPE TEXT",
    "ALTER TABLE health_checks ALTER COLUMN source TYPE TEXT",
    "ALTER TABLE health_checks ALTER COLUMN vendor TYPE TEXT"
  ];
  for (const sql of alters) {
    try {
      await pool.query(sql);
      console.log('OK', sql);
    } catch (e) {
      console.log('SKIP', sql, '|', e.message);
    }
  }

  // 校验
  const r = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_name IN ('employees','health_checks')
      AND column_name IN ('id_card','phone','status','overall_result','source','vendor')
    ORDER BY table_name, column_name
  `);
  console.log('\n=== after migration ===');
  r.rows.forEach(row => console.log(' ', row.table_name + '.' + row.column_name, '=>', row.data_type));

  await pool.end();
})();
