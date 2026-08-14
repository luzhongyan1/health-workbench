const { pool } = require('../config');

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ExcelJS 解析 datetime.time 时 .text 会返回完整 ISO 字符串（如 "1899-12-30T08:00:00.000Z"），远超 20 字符
    await client.query(`ALTER TABLE employees ALTER COLUMN check_time TYPE TEXT`);
    // 性别如果填"未说明（待人工补充）"等中文长描述会超 10 字符
    await client.query(`ALTER TABLE employees ALTER COLUMN gender TYPE VARCHAR(50)`);
    // 员工分类（兼职/全职/校招/社招/外包/管培生...）需灵活空间
    await client.query(`ALTER TABLE employees ALTER COLUMN employee_category TYPE VARCHAR(200)`);
    // 工作地可能写完整地址
    await client.query(`ALTER TABLE employees ALTER COLUMN work_location TYPE VARCHAR(500)`);
    // 名单提供人（含部门 + 名字）
    await client.query(`ALTER TABLE employees ALTER COLUMN recruiter TYPE VARCHAR(200)`);
    await client.query('COMMIT');
    return { success: true, message: 'employees 字段长度已拉宽（check_time=TEXT、gender=VARCHAR(50)、employee_category=VARCHAR(200)、work_location=VARCHAR(500)、recruiter=VARCHAR(200)）' };
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
