const express = require('express');
const { pool } = require('../db/config');
const ExcelJS = require('exceljs');
const { ensureRole } = require('../middleware/auth');

const router = express.Router();

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}
function pickText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text).trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text || '').join('').trim();
    if (v.formula) return '';
    return '';
  }
  return String(v).trim();
}
function pickDetailCol(detail, idx) {
  if (Array.isArray(detail)) return pickText(detail[idx]);
  if (detail && typeof detail === 'object') {
    if (detail[idx] !== undefined) return pickText(detail[idx]);
    return pickText(detail[String(idx)]);
  }
  return '';
}

router.get('/', async (req, res) => {
  const { name = '', department = '', overall_result = '', page = 1 } = req.query;
  const pageSize = 20;
  const offset = (Number(page) - 1) * pageSize;

  try {
    // 培训端只能看到当前最新一批 source='upload' 的体检结果，历史批次自动被覆盖不可见
    const { rows: latestRows } = await pool.query(`
      SELECT check_date::text AS batch,
             COUNT(*)::int AS emp_count
      FROM (
        SELECT DISTINCT ON (employee_id) employee_id, check_date
        FROM health_checks
        WHERE source = 'upload'
          AND check_date IS NOT NULL
        ORDER BY employee_id, id DESC
      ) sub
      GROUP BY check_date
      ORDER BY check_date DESC
      LIMIT 1
    `);
    const latestBatch = latestRows.length ? latestRows[0] : null;
    const effectiveBatch = latestBatch ? latestBatch.batch : '';
    const batches = latestBatch ? [{ value: latestBatch.batch, label: latestBatch.batch + ' (' + latestBatch.emp_count + ' 人)' }] : [];
    const filters = { name, department, overall_result, batch: effectiveBatch };

    // 只看最新批次本次 SSC 上传的体检结果（source='upload'），不包含历史归档数据
    const conditions = [`hc.source = 'upload'`];
    const params = [];

    if (effectiveBatch) {
      params.push(effectiveBatch);
      conditions.push(`hc.check_date = $${params.length}::date`);
    }

    if (name) {
      params.push(`%${name}%`);
      conditions.push(`e.name ILIKE $${params.length}`);
    }
    // 部门以本次归档的体检数据（detail_json）为准，员工表仅兜底 —— 与 SSC 页面逻辑一致
    const DEPT_EXPR = `COALESCE(hc.detail_json->>'department', hc.detail_json->>'dept', e.department)`;
    if (department) {
      params.push(department);
      conditions.push(`${DEPT_EXPR} = $${params.length}`);
    }
    if (overall_result) {
      params.push(overall_result);
      conditions.push(`hc.overall_result = $${params.length}`);
    }

    // 获取当前可选部门列表（仅含本批次 source='upload' 的体检数据）
    const deptConditions = [`hc.source = 'upload'`];
    const deptParams = [];
    if (effectiveBatch) {
      deptParams.push(effectiveBatch);
      deptConditions.push(`hc.check_date = $${deptParams.length}::date`);
    }
    const deptQuery = `
      SELECT DISTINCT ${DEPT_EXPR} AS department
      FROM employees e
      JOIN health_checks hc ON hc.employee_id = e.id
      WHERE ${deptConditions.join(' AND ')}
        AND ${DEPT_EXPR} IS NOT NULL AND ${DEPT_EXPR} <> ''
      ORDER BY ${DEPT_EXPR}
    `;
    const { rows: deptRows } = await pool.query(deptQuery, deptParams);
    const departments = deptRows.map(r => r.department);

    const where = `WHERE ${conditions.join(' AND ')}`;

    // 计数：用 DISTINCT ON 保证每个员工只算一次（只算有 source='upload' 记录的员工）
    const countQuery = `
      SELECT COUNT(*) AS total FROM (
        SELECT DISTINCT ON (e.id) e.id
        FROM employees e
        JOIN health_checks hc ON hc.employee_id = e.id
        ${where}
        ORDER BY e.id, hc.id DESC NULLS LAST
      ) t
    `;
    const { rows: countRows } = await pool.query(countQuery, params);
    const total = Number(countRows[0].total || 0);
    const totalPages = Math.ceil(total / pageSize);

    params.push(pageSize, offset);
    // 取本次上传的体检结果，并按体检结果排序
    const wrappedQuery = `
      SELECT * FROM (
        SELECT DISTINCT ON (e.id)
               e.id, e.name, e.id_card, e.gender,
               EXTRACT(YEAR FROM AGE(COALESCE(hc.check_date::date, CURRENT_DATE), (SUBSTRING(e.id_card FROM 7 FOR 8))::date))::int AS age,
               e.position, ${DEPT_EXPR} AS department, e.expected_onboard_date,
               hc.check_date, hc.overall_result, hc.detail_json
        FROM employees e
        JOIN health_checks hc ON hc.employee_id = e.id
        ${where}
        ORDER BY e.id, hc.id DESC NULLS LAST
      ) sub
      ORDER BY
        CASE overall_result
          WHEN '红灯' THEN 0
          WHEN '复查' THEN 1
          WHEN '合格-有风险' THEN 2
          WHEN '合格' THEN 3
          WHEN '未参检' THEN 4
          ELSE 5
        END,
        check_date DESC NULLS LAST,
        id
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await pool.query(wrappedQuery, params);

    const queryString = new URLSearchParams({ name, department, overall_result, batch: effectiveBatch }).toString();

    res.render('training/index', {
      title: '培训视图',
      records: rows,
      error: null,
      filters,
      batches,
      departments,
      effectiveBatch,
      user: req.user,
      pagination: {
        currentPage: Number(page),
        totalPages,
        query: queryString
      }
    });
  } catch (error) {
    res.render('training/index', { title: '培训视图', records: [], error: error.message, filters, batches: [], departments: [], effectiveBatch: '', pagination: { currentPage: 1, totalPages: 0, query: '' } });
  }
});

router.get('/download', async (req, res) => {
  const { name = '', department = '', overall_result = '' } = req.query;
  const conditions = [];
  const params = [];

  // 培训端下载时同样只能导出最新 source='upload' 批次
  const { rows: latest } = await pool.query(`
    SELECT check_date::text AS b
    FROM (
      SELECT DISTINCT ON (employee_id) employee_id, check_date
      FROM health_checks
      WHERE source = 'upload'
        AND check_date IS NOT NULL
      ORDER BY employee_id, id DESC
    ) sub
    GROUP BY check_date
    ORDER BY check_date DESC
    LIMIT 1
  `);
  const effectiveBatch = latest.length ? latest[0].b : '';

  conditions.push(`hc.source = 'upload'`);
  if (effectiveBatch) {
    params.push(effectiveBatch);
    conditions.push(`hc.check_date = $${params.length}::date`);
  }

  if (name) {
    params.push(`%${name}%`);
    conditions.push(`e.name ILIKE $${params.length}`);
  }
  // 部门以本次归档的体检数据（detail_json）为准，员工表仅兜底 —— 与 SSC 页面逻辑一致
  const DEPT_EXPR = `COALESCE(hc.detail_json->>'department', hc.detail_json->>'dept', e.department)`;
  if (department) {
    params.push(department);
    conditions.push(`${DEPT_EXPR} = $${params.length}`);
  }
  if (overall_result) {
    params.push(overall_result);
    conditions.push(`hc.overall_result = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    // 导出选定/最新体检日期的本次上传体检结果（source='upload'）
    const query = `
      SELECT * FROM (
        SELECT DISTINCT ON (e.id)
               e.name, e.id_card, e.gender,
               EXTRACT(YEAR FROM AGE(COALESCE(hc.check_date::date, CURRENT_DATE), (SUBSTRING(e.id_card FROM 7 FOR 8))::date))::int AS age,
               e.position, ${DEPT_EXPR} AS department, e.expected_onboard_date,
               hc.check_date, hc.overall_result, hc.detail_json
        FROM employees e
        JOIN health_checks hc ON hc.employee_id = e.id
        ${where}
        ORDER BY e.id, hc.id DESC NULLS LAST
      ) sub
      ORDER BY
        CASE overall_result
          WHEN '红灯' THEN 0
          WHEN '复查' THEN 1
          WHEN '合格-有风险' THEN 2
          WHEN '合格' THEN 3
          WHEN '未参检' THEN 4
          ELSE 5
        END,
        check_date DESC NULLS LAST
    `;
    const { rows } = await pool.query(query, params);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('体检结果汇总');
    sheet.addRow(['序号', '身份证号', '体检人姓名', '性别', '年龄', '体检日期', '拟入职时间', '体检结果', '目前已存在异常', '复查建议及相关风险', '备注', '部门']);
    rows.forEach((row, idx) => {
      const detail = (typeof row.detail_json === 'string' ? safeJsonParse(row.detail_json) : row.detail_json) || {};
      const summary = (!Array.isArray(detail) && detail.summary) ? pickText(detail.summary) : pickDetailCol(detail, 9);
      const risk = (!Array.isArray(detail) && detail.risk) ? pickText(detail.risk) : pickDetailCol(detail, 10);
      const abnormal = (!Array.isArray(detail) && detail.abnormal) ? pickText(detail.abnormal) : pickDetailCol(detail, 11);
      sheet.addRow([
        idx + 1,
        row.id_card,
        row.name,
        row.gender || pickDetailCol(detail, 4) || '',
        row.age != null ? row.age : (pickDetailCol(detail, 5) || ''),
        row.check_date,
        row.expected_onboard_date || pickDetailCol(detail, 7) || '',
        row.overall_result,
        summary,
        risk,
        abnormal,
        row.department || pickDetailCol(detail, 12) || ''
      ]);
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=health-summary.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).send(`下载失败：${error.message}`);
  }
});

// SSC/管理员：一键删除当前最新批次的体检结果（只删 health_checks，保留 employees 基础信息）
router.post('/delete-latest-batch', ensureRole('ssc'), async (req, res) => {
  try {
    // 取最新 source='upload' 批次日期
    const { rows: latestRows } = await pool.query(`
      SELECT check_date::text AS batch
      FROM (
        SELECT DISTINCT ON (employee_id) employee_id, check_date
        FROM health_checks
        WHERE source = 'upload'
          AND check_date IS NOT NULL
        ORDER BY employee_id, id DESC
      ) sub
      GROUP BY check_date
      ORDER BY check_date DESC
      LIMIT 1
    `);
    if (!latestRows.length) {
      req.session.flash = { type: 'warning', message: '当前没有可删除的批次。' };
      return res.redirect('/training');
    }
    const latestBatch = latestRows[0].batch;

    const { rowCount } = await pool.query(`
      DELETE FROM health_checks
      WHERE source = 'upload' AND check_date = $1::date
    `, [latestBatch]);

    req.session.flash = { type: 'success', message: `已成功删除 ${latestBatch} 批次的 ${rowCount} 条体检结果。` };
    return res.redirect('/training');
  } catch (error) {
    req.session.flash = { type: 'danger', message: `删除失败：${error.message}` };
    return res.redirect('/training');
  }
});

module.exports = router;
