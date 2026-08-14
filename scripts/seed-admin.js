// scripts/seed-admin.js
// 创建默认管理员账号：admin / 123456
// 把 PowerShell 里的 $-变量吃掉问题绕开，直接用 Node 脚本跑 SQL
const bcrypt = require('bcrypt');
const { pool } = require('../db/config');

(async () => {
  try {
    const username = 'admin';
    const password = '123456';
    const role = 'ssc';
    const displayName = '管理员';

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO users (username, password, role, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
         SET password = EXCLUDED.password,
             role = EXCLUDED.role,
             display_name = EXCLUDED.display_name`,
      [username, hash, role, displayName]
    );

    console.log(`账号创建成功：${username} / ${password} (角色: ${role})`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('创建失败：', err.message);
    process.exit(1);
  }
})();
