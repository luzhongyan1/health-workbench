// 把 standards 表的所有短字段都放宽为 TEXT，避免 Excel 内容过长插入失败
const { pool } = require('../db/config');

async function up() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE standards
        ALTER COLUMN name TYPE TEXT,
        ALTER COLUMN item_name TYPE TEXT,
        ALTER COLUMN unit TYPE TEXT,
        ALTER COLUMN pass_range TYPE TEXT,
        ALTER COLUMN red_threshold TYPE TEXT,
        ALTER COLUMN recheck_threshold TYPE TEXT
    `);
    console.log('standards 表字段已放宽为 TEXT');
  } finally {
    client.release();
  }
}

if (require.main === module) {
  up()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('迁移失败：', e.message);
      process.exit(1);
    });
}

module.exports = { up };
