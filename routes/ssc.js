const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../db/config');
const { judgeItem, rankOverall, judgeByStandards, judgeBatchByStandardsWithAI } = require('../services/healthRating');
const deepseek = require('../services/deepseek');
const { LATEST_REAL_BATCH, PASS_IN_HISTORY_FILTER, HAS_UPLOAD_FILTER } = require('../db/query-filters');

// 把 ExcelJS 日期单元格安全转成 'YYYY-MM-DD'（取本地时区，避免 UTC 偏移）
function cellToDateStr(cell) {
  if (!cell) return '';
  const v = cell.value;
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    const yy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  if (typeof v === 'number') {
    // Excel serial date → JS Date (25569 = days between 1900-01-01 and 1970-01-01)
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      const yy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    }
  }
  const s = String(v).trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s;
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// 通用日期格式化：取本地时区年月日，避免 toISOString 的 UTC 偏移
function fmtDateStr(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// 「合格」白名单：overall_result 取这些值时算作体检合格
const PASS_RESULTS = ['pass', '合格', '合格-有风险', 'pass-risk', 'pass_risk', '合格有风险'];

/**
 * 自动重算 employees.status（只重算最新 real 批次）
 */
async function autoRecompute() {
  // 已上传本次体检结果 或 近90天历史合格 → 该批次已处理，不在工作台展示
  const archivedResult = await pool.query(`
    UPDATE employees SET status = 'archived'
    WHERE ${LATEST_REAL_BATCH}
      AND (
        ${HAS_UPLOAD_FILTER}
        OR EXISTS (
          SELECT 1 FROM health_checks hc
          WHERE hc.employee_id = employees.id AND ${PASS_IN_HISTORY_FILTER}
        )
      )
    RETURNING id
  `);
  // 未上传且无历史合格 → 需预约
  const needsResult = await pool.query(`
    UPDATE employees SET status = 'needs_appointment'
    WHERE ${LATEST_REAL_BATCH}
      AND NOT ${HAS_UPLOAD_FILTER}
      AND NOT EXISTS (
        SELECT 1 FROM health_checks hc
        WHERE hc.employee_id = employees.id AND ${PASS_IN_HISTORY_FILTER}
      )
    RETURNING id
  `);
  return { archived: archivedResult.rowCount, exempt: 0, needs: needsResult.rowCount };
}

router.get('/', async (req, res) => {
  try {
    // 【实时比对 + 批次隔离】只看最新真实招聘批次
    // 已上传本次体检结果的人员（status='archived'）不再出现在工作台
    const { rows: needs } = await pool.query(`
      SELECT * FROM employees
      WHERE ${LATEST_REAL_BATCH} AND status = 'needs_appointment'
      ORDER BY expected_onboard_date DESC NULLS LAST, id DESC LIMIT 200
    `);
    const [{ count: needsCount }] = (await pool.query(`
      SELECT COUNT(*)::int AS count FROM employees
      WHERE ${LATEST_REAL_BATCH} AND status = 'needs_appointment'
    `)).rows;
    const [{ count: exemptCount }] = (await pool.query(`
      SELECT COUNT(*)::int AS count FROM employees
      WHERE ${LATEST_REAL_BATCH} AND status = 'exempt'
    `)).rows;
    const [{ count: archivedCount }] = (await pool.query(`
      SELECT COUNT(*)::int AS count FROM employees
      WHERE ${LATEST_REAL_BATCH} AND status = 'archived'
    `)).rows;
    const [{ count: historyCount }] = (await pool.query("SELECT COUNT(*)::int AS count FROM health_checks WHERE source = 'history'")).rows;
    res.render('ssc/index', {
      title: 'SSC 工作台', needs, needsCount, exemptCount, historyCount, archivedCount,
      error: null,
      deleted: req.query.deleted || '',
      archived: req.query.archived || ''
    });
  } catch (error) {
    res.render('ssc/index', { title: 'SSC 工作台', needs: [], needsCount: 0, exemptCount: 0, archivedCount: 0, historyCount: 0, error: error.message, deleted: '', archived: '' });
  }
});

// 重算路由保留（后台自动调用 + 兜底手动入口）
router.post('/recompute', async (req, res) => {
  try {
    const { archived, exempt, needs } = await autoRecompute();
    res.redirect(`/ssc?archived=0`);
  } catch (error) {
    res.render('ssc/index', { title: 'SSC 工作台', needs: [], needsCount: 0, exemptCount: 0, archivedCount: 0, historyCount: 0, error: error.message, deleted: '', archived: '' });
  }
});

// 一键清空「需预约体检」员工
router.post('/clear-needs/delete', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM employees
      WHERE ${LATEST_REAL_BATCH} AND status = 'needs_appointment'
    `);
    res.redirect('/ssc?deleted=' + rowCount);
  } catch (error) {
    res.render('ssc/index', { title: 'SSC 工作台', needs: [], needsCount: 0, exemptCount: 0, archivedCount: 0, historyCount: 0, error: error.message, deleted: '', archived: '' });
  }
});

// 删除一条员工预约（连带 health_checks 一起删除，FK 级联）
router.post('/employees/:id/delete', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM employees WHERE id=$1', [req.params.id]);
    if (rowCount === 0) {
      return res.render('ssc/index', { title: 'SSC 工作台', needs: [], needsCount: 0, exemptCount: 0, archivedCount: 0, historyCount: 0, error: '记录不存在或已被删除', deleted: '', archived: '' });
    }
    res.redirect('/ssc?deleted=' + rowCount);
  } catch (error) {
    res.render('ssc/index', { title: 'SSC 工作台', needs: [], needsCount: 0, exemptCount: 0, archivedCount: 0, historyCount: 0, error: error.message, deleted: '', archived: '' });
  }
});

router.get('/upload-standards', (req, res) => {
  res.render('ssc/upload-standards', { title: '上传体检标准', error: null, result: null });
});

router.post('/upload-standards', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('ssc/upload-standards', { title: '上传体检标准', error: '请上传 Excel 文件', result: null });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    const results = { imported: 0 };

    for (let i = 2; i <= worksheet.rowCount; i += 1) {
      const row = worksheet.getRow(i);
      const name = row.getCell(1).text.trim();
      const item_name = row.getCell(2).text.trim();
      const unit = row.getCell(3).text.trim();
      const pass_range = row.getCell(4).text.trim();
      const red_threshold = row.getCell(5).text.trim();
      const recheck_threshold = row.getCell(6).text.trim();
      const risk_text = row.getCell(7).text.trim();
      if (!name || !item_name) continue;
      await pool.query(
        `INSERT INTO standards (name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, version, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,true)`,
        [name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text]
      );
      results.imported += 1;
    }

    res.render('ssc/upload-standards', { title: '上传体检标准', error: null, result: results });
  } catch (error) {
    res.render('ssc/upload-standards', { title: '上传体检标准', error: error.message, result: null });
  }
});

router.get('/upload-history', (req, res) => {
  res.render('ssc/upload-history', { title: '上传历史体检底表', error: null, result: null });
});

// 查看历史体检记录列表
router.get('/history-list', async (req, res) => {
  const search = (req.query.search || '').trim();
  const dateFrom = (req.query.dateFrom || '').trim();
  const dateTo = (req.query.dateTo || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  try {
    const params = [];
    let paramIdx = 1;

    const searchParam = `%${search}%`;
    params.push(searchParam);

    let dateFilter = '';
    if (dateFrom) {
      params.push(dateFrom);
      dateFilter += ` AND hc.check_date >= $${++paramIdx}`;
    }
    if (dateTo) {
      params.push(dateTo);
      dateFilter += ` AND hc.check_date <= $${++paramIdx}`;
    }

    const baseQuery = `
      FROM health_checks hc
      LEFT JOIN employees e ON e.id = hc.employee_id
      WHERE hc.source = 'history'
        AND ($1 = '' OR COALESCE(e.name, hc.detail_json->>'name') ILIKE $1 OR hc.id_card ILIKE $1)
        ${dateFilter}
    `;
    const countResult = await pool.query(`SELECT COUNT(*) AS total ${baseQuery}`, params);
    const totalCount = parseInt(countResult.rows[0].total, 10);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    const { rows } = await pool.query(
      `SELECT hc.id,
              COALESCE(e.name, hc.detail_json->>'name') AS name,
              COALESCE(e.id_card, hc.id_card) AS id_card,
              COALESCE(e.position, hc.detail_json->>'position') AS position,
              COALESCE(hc.detail_json->>'department', hc.detail_json->>'dept', e.department) AS department,
              hc.check_date, hc.vendor, hc.overall_result, hc.created_at, hc.detail_json,
              COALESCE(e.expected_onboard_date, (hc.detail_json->>'expected_onboard_date')::date) AS expected_onboard_date,
              COALESCE(e.gender, hc.detail_json->>'gender') AS gender
       ${baseQuery}
       ORDER BY hc.check_date DESC NULLS LAST, hc.id DESC
       LIMIT $${++paramIdx} OFFSET $${++paramIdx}`,
      [...params, pageSize, offset]
    );
    res.render('ssc/history-list', { title: '历史体检记录', rows, totalCount, totalPages, page, search, dateFrom, dateTo, offset, deleted: req.query.deleted || '', error: req.query.error || '' });
  } catch (err) {
    res.render('ssc/history-list', { title: '历史体检记录', rows: [], totalCount: 0, totalPages: 1, page: 1, search, dateFrom, dateTo, offset: 0, deleted: '', error: err.message });
  }
});

// 删除单条历史体检记录
router.post('/history-list/:id/delete', async (req, res) => {
  const backParams = new URLSearchParams({
    search: req.body.search || '',
    dateFrom: req.body.dateFrom || '',
    dateTo: req.body.dateTo || '',
    page: req.body.page || ''
  });
  const qs = backParams.toString();
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM health_checks WHERE id = $1 AND source = 'history'",
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.redirect('/ssc/history-list?' + qs + '&error=' + encodeURIComponent('记录不存在或已被删除'));
    }
    res.redirect('/ssc/history-list?' + qs + '&deleted=' + rowCount);
  } catch (err) {
    res.redirect('/ssc/history-list?' + qs + '&error=' + encodeURIComponent(err.message));
  }
});

// 一键清空所有历史体检记录
router.post('/history-list/clear-all', async (req, res) => {
  try {
    const { rowCount } = await pool.query("DELETE FROM health_checks WHERE source = 'history'");
    res.redirect('/ssc/history-list?deleted=' + rowCount);
  } catch (err) {
    res.redirect('/ssc/history-list?error=' + encodeURIComponent(err.message));
  }
});

router.post('/upload-history', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('ssc/upload-history', { title: '上传历史体检底表', error: '请上传 Excel 文件', result: null });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    const result = { imported: 0, updated: 0, skipped: 0 };

    // 新 12 列模板：序号 / 身份证号 / 体检人姓名 / 性别 / 年龄 / 体检日期 / 拟入职时间 / 体检结果 / 目前已存在异常 / 复查建议及相关风险 / 备注 / 部门
    for (let i = 2; i <= worksheet.rowCount; i += 1) {
      const row = worksheet.getRow(i);
      const id_card = pickText(row.getCell(2));
      const name = pickText(row.getCell(3));
      const gender = pickText(row.getCell(4));
      const age = pickText(row.getCell(5));
      const check_date = cellToDateStr(row.getCell(6));
      const expected_onboard_date = cellToDateStr(row.getCell(7));
      const overall_result = pickText(row.getCell(8)) || 'pass';
      const abnormal = pickText(row.getCell(9));
      const risk = pickText(row.getCell(10));
      const remark = pickText(row.getCell(11));
      const department = pickText(row.getCell(12));
      const vendor = '历史数据';
      if (!name || !id_card) continue;

      const { rows: existing } = await pool.query('SELECT id FROM employees WHERE id_card=$1 LIMIT 1', [id_card]);
      let employeeId;
      if (existing.length) {
        employeeId = existing[0].id;
        await pool.query(
          `UPDATE employees SET name=$1, gender=$2, department=$3, expected_onboard_date=$4 WHERE id=$5`,
          [name, gender, department, expected_onboard_date || null, employeeId]
        );
        result.updated += 1;
      } else {
        const insert = await pool.query(
          `INSERT INTO employees (name, id_card, gender, department, expected_onboard_date, status)
           VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
          [name, id_card, gender, department, expected_onboard_date || null]
        );
        employeeId = insert.rows[0].id;
      }

      // 去重：同一员工 + 同一体检日期  已存在 history 记录则跳过
      const { rows: dup } = await pool.query(
        `SELECT 1 FROM health_checks
         WHERE employee_id=$1 AND check_date=$2 AND source='history'
         LIMIT 1`,
        [employeeId, check_date || null]
      );
      if (dup.length > 0) {
        result.skipped += 1;
        continue;
      }

      // detail_json 存完整列位（序号在 values[1]，列从 2 开始）
      const detailJson = JSON.stringify(row.values);
      await pool.query(
        `INSERT INTO health_checks (employee_id, id_card, check_date, vendor, overall_result, detail_json, source)
         VALUES ($1,$2,$3,$4,$5,$6,'history')`,
        [employeeId, id_card, check_date || null, vendor, overall_result, detailJson]
      );
      result.imported += 1;
    }

    // 上传历史底表后自动重算 status 分流
    try {
      const rc = await autoRecompute();
      result.recompute = rc;
    } catch (_e) { /* 重算失败不影响上传结果展示 */ }

    res.render('ssc/upload-history', { title: '上传历史体检底表', error: null, result });
  } catch (error) {
    res.render('ssc/upload-history', { title: '上传历史体检底表', error: error.message, result: null });
  }
});

router.get('/export-appointment', async (req, res) => {
  try {
    // 导出「需预约体检」名单（最新 real 批次 + status 过滤）
    const { rows } = await pool.query(`
      SELECT name, id_card, phone, expected_onboard_date,
             actual_onboard_date, work_location, employee_category, recruiter,
             provided_date, check_date, check_time, check_address, gender, position
      FROM employees
      WHERE ${LATEST_REAL_BATCH} AND status = 'needs_appointment'
      ORDER BY expected_onboard_date DESC NULLS LAST, id ASC
    `);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('预约名单');

    // 第1行：合并标题（模拟招聘端模板的合并标题行）
    sheet.mergeCells('A1:Q1');
    sheet.getCell('A1').value = '体检预约名单';
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getCell('A1').font = { bold: true, size: 14 };

    // 第2行：列名（与招聘端 POST /recruiter/import 的列位完全一致）
    sheet.addRow([
      '序号',       // A
      '体检人姓名', // B
      '身份证号',   // C
      '手机号',     // D
      '拟入职时间', // E
      '办理入职时间', // F
      '工作地',     // G
      '员工分类',   // H
      '名单提供人', // I
      '提供日期',   // J
      '体检日期',   // K
      '体检时间',   // L
      '体检地址',   // M
      '性别',       // N
      '性别验证',   // O（公式列，导出留空）
      '身份证号验证', // P（公式列，导出留空）
      '岗位'        // Q
    ]);
    sheet.getRow(2).font = { bold: true };

    // 数据从第3行开始
    rows.forEach((r, idx) => {
      sheet.addRow([
        idx + 1,                  // A 序号
        r.name || '',             // B 体检人姓名
        r.id_card || '',          // C 身份证号
        r.phone || '',            // D 手机号
        fmtDateStr(r.expected_onboard_date), // E 拟入职时间
        fmtDateStr(r.actual_onboard_date),   // F 办理入职时间
        r.work_location || '',   // G 工作地
        r.employee_category || '', // H 员工分类
        r.recruiter || '',        // I 名单提供人
        fmtDateStr(r.provided_date), // J 提供日期
        fmtDateStr(r.check_date),    // K 体检日期
        r.check_time || '',       // L 体检时间
        r.check_address || '',   // M 体检地址
        r.gender || '',          // N 性别
        '',                       // O 性别验证
        '',                       // P 身份证号验证
        r.position || ''          // Q 岗位
      ]);
    });

    // 列宽
    sheet.getColumn(1).width = 6;   // 序号
    sheet.getColumn(2).width = 12; // 姓名
    sheet.getColumn(3).width = 22; // 身份证号
    sheet.getColumn(4).width = 14; // 手机号
    sheet.getColumn(5).width = 14; // 拟入职
    sheet.getColumn(6).width = 14; // 办理入职
    sheet.getColumn(7).width = 12; // 工作地
    sheet.getColumn(8).width = 12; // 员工分类
    sheet.getColumn(9).width = 12; // 名单提供人
    sheet.getColumn(10).width = 14; // 提供日期
    sheet.getColumn(11).width = 14; // 体检日期
    sheet.getColumn(12).width = 10; // 体检时间
    sheet.getColumn(13).width = 30; // 体检地址
    sheet.getColumn(14).width = 8;  // 性别
    sheet.getColumn(15).width = 12; // 性别验证
    sheet.getColumn(16).width = 16; // 身份证号验证
    sheet.getColumn(17).width = 14; // 岗位

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename=\"appointment.xlsx\"; filename*=UTF-8''" + encodeURIComponent('体检预约名单.xlsx'));
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.render('ssc/index', { title: 'SSC 工作台', needs: [], needsCount: 0, exemptCount: 0, archivedCount: 0, historyCount: 0, error: error.message, deleted: '', archived: '' });
  }
});

// 导出历史体检底表（按 Excel 模板 12 列）
// 列：序号(公式) | 身份证号 | 体检人姓名 | 性别 | 年龄 | 体检日期 | 拟入职时间 | 体检结果 | 目前已存在异常 | 复查建议及相关风险 | 备注 | 部门
router.get('/export-history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.id_card, e.name, e.gender, e.department, e.expected_onboard_date,
             hc.check_date, hc.overall_result, hc.detail_json
      FROM health_checks hc
      JOIN employees e ON e.id = hc.employee_id
      WHERE hc.source = 'history'
      ORDER BY hc.check_date DESC NULLS LAST, hc.id DESC
    `);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('底表');
    sheet.addRow(['序号', '身份证号', '体检人姓名', '性别', '年龄', '体检日期', '拟入职时间', '体检结果', '目前已存在异常', '复查建议及相关风险', '备注', '部门']);

    rows.forEach((r, idx) => {
      // detail_json 是上传时存的 row.values，索引从 1 开始
      // 序号（公式）跳过；4=性别、5=年龄 优先从 detail_json 取（身份证号有时缺失）
      const detail = Array.isArray(r.detail_json) ? r.detail_json : (r.detail_json || {});
      const gender = pickText(pickCol(detail, 4)) || r.gender || '';
      const age = pickText(pickCol(detail, 5));
      // 12 列数组语义：9=目前已存在异常 / 10=复查建议及相关风险 / 11=备注
      const summary = pickText(pickCol(detail, 9)) || '';
      const risk = pickText(pickCol(detail, 10)) || '';
      const abnormal = pickText(pickCol(detail, 11)) || '';
      const department = pickText(pickCol(detail, 12)) || r.department || '';

      const row = sheet.addRow([
        idx + 1,
        r.id_card || '',
        r.name || '',
        gender,
        age,
        fmtDateStr(r.check_date),
        fmtDateStr(r.expected_onboard_date),
        r.overall_result || '',
        summary,
        risk,
        abnormal,
        department
      ]);
      // 序号列公式
      row.getCell(1).value = { formula: `ROW()-1` };
      // 体检结果列 C8：列宽放大
      sheet.getColumn(8).width = 30;
      sheet.getColumn(9).width = 50;
      sheet.getColumn(10).width = 50;
      sheet.getColumn(11).width = 30;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename=\"history.xlsx\"; filename*=UTF-8''" + encodeURIComponent('历史体检底表.xlsx'));
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.render('ssc/history-list', { title: '历史体检记录', rows: [], totalCount: 0, totalPages: 1, page: 1, search: '', offset: 0, error: error.message });
  }
});

// 从 ExcelJS cell 安全拿到字符串
function pickText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v && v.text) return String(v.text).trim();
    if (v && v.result !== undefined) return String(v.result).trim();
    if (v && Array.isArray(v.richText)) return v.richText.map(rt => rt.text || '').join('').trim();
    if (v && v.formula) return '';
    return '';
  }
  return String(v).trim();
}

// 兼容 detail_json 为数组或稀疏对象（JSON.stringify({5: 23}) 会序列化成 object）
function pickCol(detail, idx) {
  if (Array.isArray(detail)) return detail[idx];
  if (detail && typeof detail === 'object') {
    if (detail[idx] !== undefined) return detail[idx];
    return detail[String(idx)];
  }
  return undefined;
}

router.get('/import-results', (req, res) => {
  // 如果 session 里有未归档的 preview（用户上次上传过 Excel 还没点确认/放弃），恢复显示
  const preview = req.session.previewData || null;
  res.render('ssc/import-results', {
    title: '上传体检结果',
    error: null,
    result: preview && preview.length ? { imported: preview.length, pendingArchive: true } : null,
    preview
  });
});

// 【列名 alias 表】按表头文字定位每列语义，对列顺序/多列/前缀列都鲁棒
//   用户 Excel 实际是「胖模板」：姓名 / 身份证 / 评级 / 汇总 / 异常 / 缺项 / 风险提示 直接是列
const COLUMN_ALIASES = {
  name: ['姓名', '体检人姓名', '名字', '员工姓名'],
  id_card: ['身份证号', '身份证', '身份证号码', '证件号', '身份证号(18位)'],
  // 【P0 用户语义】第 8 列「体检结果」= AI 评级（合格/复查/红灯/人工判定/合格-有风险）
  //   注意：alias 是「体检结果评级」「体检结论」这种**带评级词的**描述，绝不能是「体检结果」单字
  //   「体检结果」单字是描述列（详细文字），必须留给 summary
  overall: ['体检结果评级', '体检结果等级', '体检结论', '体检等级', '综合评级', '总评', '体检评级', '评级结论', '评级', '结论'],
  // 【P0 用户语义】第 9 列「目前已存在异常」= 用户 Excel 里「体检结果」这一列的内容（描述段文字）
  //   「体检结果」单字是第一 alias（按 key 顺序在 overall 之后遍历，但 alias 内按长度倒序，"体检结果"短词能命中描述列）
  //   KEY 顺序是 name→id_card→overall→summary→...，先扫 overall（要求带评级词）；再扫 summary 时「体检结果」单字能命中描述列
  summary: ['目前已存在异常', '体检结果汇总描述', '体检结果汇总', '体检结果描述', '体检描述', '体检结果', '结果描述', '描述', '汇总', '结论描述', '主要结果', '体检摘要'],
  abnormal: ['异常项', '异常情况', '异常指标', '异常详情', '异常明细'],
  missing: ['缺项', '未检项目', '缺检项目', '缺', '漏检'],
  risk: ['复查建议及相关风险', '风险提示及建议', '复查建议', '风险提示', '风险', '注意事项', '建议'],
  department: ['部门', '所属部门', '单位部门', '机构']
};

function matchColumn(headerText, aliases) {
  const t = String(headerText || '').trim();
  if (!t) return false;
  for (const a of aliases) {
    if (t === a) return true;
    if (a.length >= 2 && t.includes(a)) return true;
  }
  return false;
}

// 扫描前 8 行找真表头：选「命中 alias 数最多」的行，且必须命中「姓名」
function findHeaderRow(worksheet) {
  let bestRow = 1;
  let bestScore = -1;
  const maxRows = Math.min(8, worksheet.rowCount);
  for (let i = 1; i <= maxRows; i++) {
    const r = worksheet.getRow(i);
    let score = 0;
    let hasName = false;
    for (let c = 1; c <= worksheet.columnCount; c++) {
      const txt = pickText(r.getCell(c).text);
      for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (matchColumn(txt, aliases)) {
          score += 1;
          if (aliases[0] === '姓名') hasName = true;
        }
      }
    }
    if (hasName && score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return { rowNum: bestRow, score: bestScore };
}

// 把表头每列映射到语义 key
//   关键策略：【跨 KEY 按 alias 长度倒序统一匹配】——更具体的（如「体检结果汇总」）优先于更宽泛的（如「体检结果」）
//   解决：用户 Excel 同时有「体检结果」+「体检结果汇总」时，会优先认领长 alias 的「体检结果汇总」为 summary，而不是被「体检结果」单字抢走
//   容错（包含匹配）只在所有 alias 都没精确命中时才用，且 alias 长度 >= 2 防止单字歧义
function mapColumns(worksheet, headerRowNum) {
  const hdr = worksheet.getRow(headerRowNum);
  const map = { name: -1, id_card: -1, overall: -1, summary: -1, abnormal: -1, missing: -1, risk: -1, department: -1 };
  const usedCols = new Set();
  const usedKeys = new Set();
  const KEY_ORDER = ['name', 'id_card', 'overall', 'summary', 'abnormal', 'missing', 'risk', 'department'];

  // 第一遍：跨 KEY 按 alias 长度倒序收集所有精确匹配
  const exactMatches = [];
  for (let c = 1; c <= worksheet.columnCount; c++) {
    const txt = pickText(hdr.getCell(c).text);
    if (!txt) continue;
    for (const key of KEY_ORDER) {
      const aliases = COLUMN_ALIASES[key] || [];
      for (const alias of aliases) {
        if (alias.length < 2) continue;
        if (txt === alias) exactMatches.push({ col: c, key, alias, length: alias.length });
      }
    }
  }
  // 长度倒序 → 同长度按 col 升序
  exactMatches.sort((a, b) => b.length - a.length || a.col - b.col);
  for (const m of exactMatches) {
    if (usedCols.has(m.col) || usedKeys.has(m.key)) continue;
    map[m.key] = m.col;
    usedCols.add(m.col);
    usedKeys.add(m.key);
  }

  // 第二遍：容错（contains）兜底——只在精确匹配还有 key 未认领时才用
  for (let c = 1; c <= worksheet.columnCount; c++) {
    if (usedCols.has(c)) continue;
    const txt = pickText(hdr.getCell(c).text);
    if (!txt) continue;
    // 每个 KEY 都尝试，找一个还能用的
    const candidates = [];
    for (const key of KEY_ORDER) {
      if (usedKeys.has(key)) continue;
      const aliases = COLUMN_ALIASES[key] || [];
      for (const alias of aliases) {
        if (alias.length < 2) continue;
        // 容错：用更长的 alias（避免「体」「检」等单字被散列匹配）
        if (txt.includes(alias)) candidates.push({ key, alias, length: alias.length });
      }
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => b.length - a.length);  // 优先匹配最长 alias
    const pick = candidates[0];
    map[pick.key] = c;
    usedCols.add(c);
    usedKeys.add(pick.key);
  }
  return map;
}

// 胖模板：直接按列名读 [name, id_card, overall, summary, abnormal, missing, risk]
function readFatTemplate(worksheet, headerRowNum, colMap) {
  const rows = [];
  for (let i = headerRowNum + 1; i <= worksheet.rowCount; i += 1) {
    const row = worksheet.getRow(i);
    const name = pickText(row.getCell(colMap.name).text);
    const id_card_raw = pickText(row.getCell(colMap.id_card).text);
    if (!name || !id_card_raw) continue;
    const idClean = id_card_raw.toUpperCase().replace(/\s+/g, '');
    if (!/^\d{17}[\dXx]$/.test(idClean)) continue;
    rows.push({
      name,
      id_card: idClean,
      overall: colMap.overall > 0 ? pickText(row.getCell(colMap.overall).text) : '',
      summary: colMap.summary > 0 ? pickText(row.getCell(colMap.summary).text) : '',
      abnormal: colMap.abnormal > 0 ? pickText(row.getCell(colMap.abnormal).text) : '',
      missing: colMap.missing > 0 ? pickText(row.getCell(colMap.missing).text) : '',
      risk: colMap.risk > 0 ? pickText(row.getCell(colMap.risk).text) : '',
      department: colMap.department > 0 ? pickText(row.getCell(colMap.department).text) : ''
    });
  }
  return { mode: 'fat', rows };
}

// 瘦模板：按 itemName + itemValue 交替列读（保底 fallback）
function readThinTemplate(worksheet, headerRowNum) {
  const realHeader = worksheet.getRow(headerRowNum);
  const itemHeaders = [];
  for (let col = 3; col <= worksheet.columnCount; col += 2) {
    const itemName = pickText(realHeader.getCell(col).text);
    if (!itemName) break;
    itemHeaders.push({ name: itemName, valueCol: col + 1 });
  }
  const rows = [];
  for (let i = headerRowNum + 1; i <= worksheet.rowCount; i += 1) {
    const row = worksheet.getRow(i);
    const name = pickText(row.getCell(1).text);
    const id_card = pickText(row.getCell(2).text);
    if (!name || !id_card) continue;
    const items = itemHeaders.map((h) => ({ itemName: h.name, itemValue: pickText(row.getCell(h.valueCol).text) }));
    rows.push({ name, id_card, items });
  }
  return { mode: 'thin', rows };
}

router.post('/import-results', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('ssc/import-results', { title: '上传体检结果', error: '请上传 Excel 文件', result: null, preview: null });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    const preview = [];
    const rows = [];

    // 【列名 alias 匹配】找真表头行，胖模板直接读 4 列现成内容
    const { rowNum: headerRowNum, score } = findHeaderRow(worksheet);
    if (score < 2) {
      return res.render('ssc/import-results', {
        title: '上传体检结果',
        error: '未识别到表头行。请确保 Excel 表头包含「姓名」「身份证号」「体检结果」等列名。',
        result: null,
        preview: null
      });
    }
    const colMap = mapColumns(worksheet, headerRowNum);

    console.log('[import-results] colMap:', JSON.stringify(colMap));

    let parsed;
    // 【胖模板优先】name + id_card + 至少一个语义列（汇总/异常/缺项/风险/评级）——走胖模板
    const hasSemanticCol = colMap.summary > 0 || colMap.abnormal > 0 || colMap.missing > 0 || colMap.risk > 0 || colMap.overall > 0;
    if (colMap.name > 0 && colMap.id_card > 0 && hasSemanticCol) {
      parsed = readFatTemplate(worksheet, headerRowNum, colMap);
    } else if (colMap.name > 0 && colMap.id_card > 0) {
      return res.render('ssc/import-results', {
        title: '上传体检结果',
        error: '未识别到体检结果相关列。请确认 Excel 表头包含「体检结果」（描述段）、「体检结果评级 / 体检结论」（评级）、「风险提示 / 注意事项」、「缺项」、「异常项」等列名，并尝试重新上传。',
        result: null,
        preview: null
      });
    } else {
      parsed = readThinTemplate(worksheet, headerRowNum);
    }

    // 【加载体检标准】胖模板和瘦模板都要用
    const { rows: standards } = await pool.query('SELECT * FROM standards WHERE is_active = true');

    if (parsed.mode === 'fat') {
      // 【胖模板】按 standards 表严格重判——不信任 Excel 写的 overall
      //   优先使用 DeepSeek 深度思考模型；未配置或失败时回退到本地规则引擎
      let aiError = null;
      let aiResults = [];

      if (deepseek.isConfigured() && standards.length > 0) {
        try {
          aiResults = await judgeBatchByStandardsWithAI(parsed.rows, standards);
        } catch (err) {
          aiError = err.message;
          console.error('[import-results] DeepSeek 评级失败，回退到本地规则：', err.message);
        }
      }

      const aiByKey = new Map();
      for (const r of aiResults) {
        aiByKey.set(`${r.id_card}|${r.name}`, r);
      }

      for (const r of parsed.rows) {
        const ai = aiByKey.get(`${r.id_card}|${r.name}`);
        if (ai) {
          const matchedNames = ai.matchedItems.map((it) => it.name).filter(Boolean);
          // 【关键】risk 只从命中标准项的 risk 字段聚合（来源于 standards 表），
          //   不用 ai.riskText（DeepSeek 会"无中生有"凭空生成医学解释，如"高回声团""血管瘤"）
          const aggregatedRisk = ai.matchedItems
            .map((it) => it.risk)
            .filter(Boolean)
            .join('\n');
          preview.push({
            name: r.name,
            id_card: r.id_card,
            overall: ai.overall,
            summary: r.summary || r.abnormal || '', // 目前已存在异常：保留原始异常描述（优先用 summary 列）
            abnormal: r.abnormal || matchedNames.join('; ') || '', // 备注：优先用 Excel 原文，无原文再用命中项名
            missing: r.missing || '', // 缺项
            risk: r.risk || aggregatedRisk || '', // 复查建议及相关风险：优先 Excel 原文 → 命中标准 risk 汇总 → 空
            itemDetails: ai.matchedItems.map((it) => ({
              itemName: it.name,
              result: it.rating,
              risk: it.risk || ''
            })),
            aiJudged: true
          });
        } else {
          // 回退到本地规则引擎
          const judgeText = r.summary || r.abnormal || '';
          const judged = judgeByStandards(judgeText, r.missing || '', standards);
          preview.push({
            name: r.name,
            id_card: r.id_card,
            overall: judged.overall,
            summary: r.summary || r.abnormal || '', // 目前已存在异常：优先用 summary 列，保持与评级输入一致
            abnormal: r.abnormal || judged.abnormalItems.concat(judged.missingItems).join('; ') || '',
            missing: r.missing || '',
            risk: r.risk || judged.riskText || '',
            itemDetails: judged.itemDetails || [],
            aiJudged: false
          });
        }
      }

      if (aiError) {
        preview._aiError = aiError;
      }
    } else {
      // 【瘦模板】按体检项目逐项判定
      for (const person of parsed.rows) {
        const itemDetails = [];
        const summaryParts = [];
        const abnormalItems = [];
        const missingItems = [];
        let hasRisk = false;

        for (const item of person.items) {
          if (!item.itemValue) {
            missingItems.push(item.itemName);
            continue;
          }
          const standard = standards.find((s) => s.item_name === item.itemName);
          if (!standard) {
            summaryParts.push(`${item.itemName}:${item.itemValue}`);
            continue;
          }
          const judged = judgeItem(item.itemValue, standard);
          let resultLabel = '合格';
          if (judged.result === 'red') resultLabel = '红灯';
          else if (judged.result === 'recheck') resultLabel = '复查';
          else if (judged.result === 'manual') resultLabel = '人工判定';
          else if (judged.result === 'pass' && standard.risk_text) {
            resultLabel = '合格-有风险';
            hasRisk = true;
          }

          itemDetails.push({
            itemName: item.itemName,
            itemValue: item.itemValue,
            result: resultLabel,
            risk: judged.reason || standard.risk_text || ''
          });
          summaryParts.push(`${item.itemName}:${item.itemValue}`);
          if (resultLabel !== '合格') abnormalItems.push(item.itemName);
          if (resultLabel === '合格-有风险') hasRisk = true;
        }

        const overall = rankOverall(itemDetails.map((item) => ({ result: item.result === '红灯' ? 'red' : item.result === '复查' ? 'recheck' : item.result === '人工判定' ? 'manual' : 'pass' })));
        let overallLabel = overall;
        if (overall === '合格' && hasRisk) overallLabel = '合格-有风险';

        preview.push({
          name: person.name,
          id_card: person.id_card,
          overall: overallLabel,
          summary: summaryParts.join('; '),
          abnormal: abnormalItems.join('; '),
          missing: missingItems.join('; '),
          risk: itemDetails.filter((it) => it.risk).map((it) => `${it.itemName}:${it.risk}`).join('; '),
          itemDetails
        });
      }
    }

    // 解析完后再用 id_card 批量 JOIN employees 拉取入参（部门/体检日期/拟入职时间/性别/年龄）
    //  目的：预览页直接显示完整 12 列表头，跟用户截图的体检预约名单/导出 Excel 一致
    //  【P2 增强】id_card 命中不了时，按 name + 身份证前 6 位（地区码）二次匹配 —— 兼容身份证号大小写/typo/补 0 等小差异
    if (preview.length) {
      const idCards = preview.map((p) => p.id_card);
      const empRes = await pool.query(
        `SELECT id_card, name, position, department, expected_onboard_date, check_date, gender,
                EXTRACT(YEAR FROM AGE(COALESCE(check_date::date, CURRENT_DATE), (SUBSTRING(id_card FROM 7 FOR 8))::date))::int AS age
         FROM employees
         WHERE id_card = ANY($1::text[]) OR name = ANY($2::text[])`,
        [idCards, preview.map((p) => p.name)]
      );
      const byIdCard = new Map();
      const byName = new Map();
      for (const e of empRes.rows) {
        byIdCard.set(e.id_card, e);
        if (!byName.has(e.name)) byName.set(e.name, e);
      }
      for (const p of preview) {
        let e = byIdCard.get(p.id_card);
        if (!e) e = byName.get(p.name);  // name 兜底
        e = e || {};
        p.position = e.position || '';
        // 部门以本次招聘端上传的体检预约名单里的岗位(position)为准
        p.department = p.department || e.position || '';
        p.expected_onboard_date = fmtDateStr(e.expected_onboard_date);
        p.check_date = fmtDateStr(e.check_date);
        p.gender = e.gender || '';
        p.age = e.age != null ? e.age : '';
      }
    }

    // 按 红灯 > 复查 > 合格-有风险 > 合格 > 未参检 排序展示
    const overallOrder = { '红灯': 0, '复查': 1, '合格-有风险': 2, '合格': 3, '未参检': 4 };
    preview.sort((a, b) => {
      const oa = overallOrder[a.overall] ?? 99;
      const ob = overallOrder[b.overall] ?? 99;
      return oa - ob;
    });

    // 仅生成 preview，不写库；数据存 session，等用户点「确认归档」后才写入
    req.session.previewData = preview;
    req.session.previewTimestamp = Date.now();

    res.render('ssc/import-results', {
      title: '上传体检结果',
      error: null,
      result: { imported: preview.length, pendingArchive: true },
      preview
    });
  } catch (error) {
    res.render('ssc/import-results', { title: '上传体检结果', error: error.message, result: null, preview: null });
  }
});

// 确认归档：把 preview 数据写入 health_checks（source='upload' + source='history' 两份）
// 写完后自动触发 autoRecompute，让 needs_appointment / exempt 状态自动同步
router.post('/archive-results', async (req, res) => {
  try {
    const preview = req.session.previewData;
    if (!preview || !Array.isArray(preview) || preview.length === 0) {
      return res.render('ssc/import-results', {
        title: '上传体检结果',
        error: '没有待归档的预览数据，请重新上传。',
        result: null,
        preview: null
      });
    }

    const today = fmtDateStr(new Date());
    let archived = 0;
    let notFound = 0;

    for (const person of preview) {
      const { rows: employeeRows } = await pool.query('SELECT id, check_date FROM employees WHERE id_card=$1 LIMIT 1', [person.id_card]);
      if (!employeeRows.length) {
        notFound += 1;
        continue;
      }
      const employeeId = employeeRows[0].id;
      // 用 employees 表里的 check_date 作「体检日期」，没有则用今天
      const empCheckDate = fmtDateStr(employeeRows[0].check_date) || today;
      // history 底表存 12 列数组，与 upload-history 的 row.values 格式完全一致
      // 列位：1序号 / 2身份证号 / 3姓名 / 4性别 / 5年龄 / 6体检日期 / 7拟入职时间 / 8体检结果 / 9目前已存在异常 / 10复查建议及相关风险 / 11备注 / 12部门
      const historyDetailJson = JSON.stringify([
        null,
        '',
        person.id_card,
        person.name,
        person.gender,
        person.age,
        person.check_date,
        person.expected_onboard_date,
        person.overall,
        person.summary || person.missing || '',  // 9 目前已存在异常
        person.risk,                             // 10 复查建议及相关风险
        person.abnormal,                         // 11 备注（异常项清单）
        person.department
      ]);
      // upload 留痕存完整 preview 行（供培训视图展示完整表头）
      const uploadDetailJson = JSON.stringify({
        name: person.name,
        id_card: person.id_card,
        gender: person.gender,
        age: person.age,
        check_date: person.check_date,
        expected_onboard_date: person.expected_onboard_date,
        overall: person.overall,
        summary: person.summary,
        abnormal: person.abnormal,
        missing: person.missing,
        risk: person.risk,
        department: person.department,
        position: person.position,
        itemDetails: person.itemDetails
      });

      // 一份 source='upload'（本次体检结果留痕）
      await pool.query(
        `INSERT INTO health_checks (employee_id, id_card, check_date, vendor, overall_result, detail_json, source)
         VALUES ($1,$2,$3,$4,$5,$6,'upload')`,
        [employeeId, person.id_card, empCheckDate, '体检机构', person.overall, uploadDetailJson]
      );

      // 一份 source='history'（归档到历史体检底表，下次 3 个月内免检判断能命中）
      await pool.query(
        `INSERT INTO health_checks (employee_id, id_card, check_date, vendor, overall_result, detail_json, source)
         VALUES ($1,$2,$3,$4,$5,$6,'history')`,
        [employeeId, person.id_card, empCheckDate, '体检机构', person.overall, historyDetailJson]
      );

      archived += 1;
    }

    // 归档后自动重算 status 分流
    await autoRecompute();

    // 清空 session 中的预览数据
    delete req.session.previewData;
    delete req.session.previewTimestamp;

    const msg = notFound > 0 ? `&notfound=${notFound}` : '';
    res.redirect(`/ssc?archived=${archived}${msg}`);
  } catch (error) {
    res.render('ssc/import-results', { title: '上传体检结果', error: error.message, result: null, preview: null });
  }
});

// 放弃归档：清空 session 中的预览数据
router.post('/discard-results', (req, res) => {
  delete req.session.previewData;
  delete req.session.previewTimestamp;
  res.redirect('/ssc/import-results');
});

// SSC 在预览页直接修改任意文本字段（复查建议及相关风险 / 备注 / 目前已存在异常）
// 仅更新 session.previewData[index]，不影响 DB，直到点「确认归档」才落库
router.post('/update-preview-field', express.json(), (req, res) => {
  const preview = req.session.previewData;
  if (!preview || !Array.isArray(preview)) {
    return res.status(400).json({ success: false, message: '没有待编辑的预览数据' });
  }
  const index = Number(req.body.index);
  const field = String(req.body.field || '').trim();
  const value = String(req.body.value || '');
  if (!Number.isInteger(index) || index < 0 || index >= preview.length) {
    return res.status(400).json({ success: false, message: '行号无效' });
  }
  const ALLOWED = ['risk', 'abnormal', 'summary'];
  if (!ALLOWED.includes(field)) {
    return res.status(400).json({ success: false, message: '字段不允许编辑' });
  }
  preview[index][field] = value;
  res.json({ success: true, field, value });
});

// SSC 在预览页直接修改某行体检结果评级
// 仅更新 session.previewData[index]，不影响 DB，直到点「确认归档」才落库
router.post('/update-preview-result', express.json(), (req, res) => {
  const preview = req.session.previewData;
  if (!preview || !Array.isArray(preview)) {
    return res.status(400).json({ success: false, message: '没有待编辑的预览数据' });
  }
  const index = Number(req.body.index);
  const newOverall = String(req.body.overall || '').trim();
  if (!Number.isInteger(index) || index < 0 || index >= preview.length) {
    return res.status(400).json({ success: false, message: '行号无效' });
  }
  // 评级白名单（必须能映射到下游归档逻辑）
  const VALID = ['未参检', '合格', '合格-有风险', '复查', '红灯'];
  if (!VALID.includes(newOverall)) {
    return res.status(400).json({ success: false, message: '评级值无效' });
  }

  const row = preview[index];
  row.overall = newOverall;

  // 未参检时不保留异常/风险；其他评级按命中项重算
  if (newOverall === '未参检') {
    row.abnormal = '';
    row.risk = '';
  } else {
    const abnormalItems = [];
    let riskParts = [];
    for (const it of (row.itemDetails || [])) {
      if (it.result !== '合格') abnormalItems.push(it.itemName);
      if (it.risk) riskParts.push(`${it.itemName}:${it.risk}`);
    }
    row.abnormal = abnormalItems.join('; ');
    row.risk = riskParts.join('; ');
  }

  // badge 颜色类（前端直接用）
  const badgeClassMap = {
    '未参检': 'bg-secondary',
    '合格': 'bg-success',
    '合格-有风险': 'bg-warning text-dark',
    '复查': 'bg-warning text-dark',
    '红灯': 'bg-danger'
  };
  res.json({
    success: true,
    overall: row.overall,
    badgeClass: badgeClassMap[newOverall] || 'bg-info text-dark',
    abnormal: row.abnormal,
    risk: row.risk
  });
});

module.exports = router;
