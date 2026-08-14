const express = require('express');
const { pool, testConnection } = require('../db/config');
const { LATEST_REAL_BATCH, PASS_IN_HISTORY_FILTER, HAS_UPLOAD_FILTER } = require('../db/query-filters');
const { runMigrations } = require('../db/migrations/001_init');
const { ensureAuthenticated, ensureRole } = require('../middleware/auth');

const router = express.Router();

// 首页按角色分流：
//   - 未登录 → 登录页
//   - 招聘端 → 直接进入招聘端视角
//   - 培训师 → 直接进入培训端视角
//   - SSC（含 admin）→ 全局首页（数据概览）
router.get('/', ensureAuthenticated, async (req, res) => {
  const role = req.user.role;
  if (role === 'recruiter') return res.redirect('/recruiter');
  if (role === 'trainer') return res.redirect('/training');
  // SSC 及以上 → 渲染全局首页
  try {
    const dbTime = await testConnection();

    // 【首页只关心一件事】「最新真实招聘批次」里还需要去体检的人 = 待检人员
    //   - 已上传本次体检结果，或 90 天内历史体检合格，均视为已处理，不计入待检
    //   - 复用 SSC 工作台的同一套 SQL 片段，保证两边数字一致
    const { rows: needsCountRows } = await pool.query(`
      SELECT COUNT(*)::int AS count FROM employees
      WHERE ${LATEST_REAL_BATCH}
        AND NOT ${HAS_UPLOAD_FILTER}
        AND NOT EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.employee_id = employees.id AND ${PASS_IN_HISTORY_FILTER}
        )
    `);

    res.render('index', {
      title: '首页',
      dbTime,
      needsCount: needsCountRows[0].count,
      error: null
    });
  } catch (error) {
    res.render('index', {
      title: '首页',
      dbTime: null,
      needsCount: 0,
      error: error.message
    });
  }
});

router.post('/setup', async (req, res) => {
  try {
    const result = await runMigrations();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
