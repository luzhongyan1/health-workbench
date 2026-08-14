const bcrypt = require('bcrypt');
const { pool } = require('../config');

async function runSeed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const users = [
      { username: 'ssc_admin', password: 'password', role: 'ssc', display_name: 'SSC 管理' },
      { username: 'recruiter1', password: 'password', role: 'recruiter', display_name: '招聘人员A' },
      { username: 'trainer1', password: 'password', role: 'trainer', display_name: '培训人员A' },
    ];

    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 10);
      await client.query(
        `INSERT INTO users (username, password, role, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role, display_name = EXCLUDED.display_name`,
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
