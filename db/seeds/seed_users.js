const bcrypt = require('bcrypt');
const { pool } = require('../config');

async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 初始密码可用环境变量 SEED_PASSWORD 自定义（生产部署建议设置强密码），默认 password
    const seedPassword = process.env.SEED_PASSWORD || 'password';
    const users = [
      { username: 'admin', password: seedPassword, role: 'ssc', display_name: '超级管理员' },
      { username: 'ssc_admin', password: seedPassword, role: 'ssc', display_name: 'SSC 管理' },
      { username: 'recruiter1', password: seedPassword, role: 'recruiter', display_name: '招聘人员A' },
      { username: 'trainer1', password: seedPassword, role: 'trainer', display_name: '培训人员A' },
    ];

    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 10);
      // 仅新库插入；已存在的账号（含已改过的密码）一律不动，避免重启把密码重置回默认
      await client.query(
        `INSERT INTO users (username, password, role, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (username) DO NOTHING`,
        [u.username, hash, u.role, u.display_name]
      );
    }

    await client.query('COMMIT');
    console.log('Seeded users');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runSeed();
}

module.exports = runSeed;
