const express = require('express');
const path = require('path');
const { pool } = require('../db/config');
const multer = require('multer');
const ExcelJS = require('exceljs');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const router = express.Router();

// 上传页面期望的 3 个核心列（用户 Excel 实际用的格式）
const COL_ITEM_NAME = '入职参照异常指标范围';
const COL_RATING    = '体检结果评级';
const COL_RISK      = '相关风险提示';

router.get('/', async (req, res) => {
  const { search = '', cleared = '', error = '' } = req.query;
  const query = `SELECT * FROM standards WHERE name ILIKE $1 OR item_name ILIKE $1 ORDER BY created_at DESC`;
  const values = [`%${search}%`];

  try {
    const { rows } = await pool.query(query, values);
    res.render('standards/index', { standards: rows, search, error, cleared, title: '体检标准管理' });
  } catch (e) {
    res.render('standards/index', { standards: [], search, error: e.message, cleared: '', title: '体检标准管理' });
  }
});

router.get('/upload', (req, res) => {
  res.render('standards/upload', { error: null, success: null, preview: null, title: '批量导入标准' });
});

// 下载模板：按用户的 Excel 格式生成（入职参照异常指标范围 / 体检结果评级 / 相关风险提示）
router.get('/template', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('体检标准');
  // 第 1 列空（标准名称可选），第 2-4 列就是用户的列名（与原 Excel 完全一致）
  sheet.addRow(['', COL_ITEM_NAME, COL_RATING, COL_RISK]);
  sheet.addRow(['', '心电图：心率120以上', '红灯', '心动过速病理原因可能为冠状动脉粥样硬化性心脏病、心包炎、甲状腺功能亢进等。危害：影响心脏供血、长期可致心力衰竭。']);
  sheet.addRow(['', '心电图：心率110-119', '合格-有风险', '心动过速可能为病理性原因，建议复查。']);
  sheet.addRow(['', '恶性肿瘤', '红灯', '不考虑入职']);
  sheet.addRow(['', '男性胸透未检', '复查', '男性胸透未检，业务评估是否正常推进入职办理，如入职，办理前辛苦邮件备案（如有半年内胸透报告上传为附件）']);

  // 设置列宽
  sheet.getColumn(1).width = 18;
  sheet.getColumn(2).width = 40;
  sheet.getColumn(3).width = 18;
  sheet.getColumn(4).width = 80;
  sheet.getRow(1).font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=体检标准模板.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

// 批量上传：按 3 列解析（入职参照异常指标范围 / 体检结果评级 / 相关风险提示）
router.post('/upload', upload.single('file'), async (req, res) => {
  const renderError = (msg) => res.render('standards/upload', {
    error: msg, success: null, preview: null, title: '批量导入标准'
  });

  if (!req.file) return renderError('请选择一个 .xlsx 文件');

  const workbook = new ExcelJS.Workbook();
  let sheet;
  try {
    await workbook.xlsx.load(req.file.buffer);
    sheet = workbook.worksheets[0];
  } catch (err) {
    return renderError('Excel 解析失败：' + err.message);
  }
  if (!sheet) return renderError('Excel 文件不包含 sheet');

  // 表头 -> 列号映射
  const headerMap = {};
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    const v = (cell.value == null ? '' : cell.value).toString().trim();
    if (v) headerMap[v] = col;
  });

  const colItem  = headerMap[COL_ITEM_NAME];
  const colRate  = headerMap[COL_RATING];
  const colRisk  = headerMap[COL_RISK];

  if (!colItem) {
    return renderError(
      `表头缺少必需列「${COL_ITEM_NAME}」。请下载模板后按格式填入。`
    );
  }

  // 评级字符串 → 数据库字段映射
  //  把"红灯/复查/合格/合格-有风险/其他"分别落到对应阈值字段，其余留空
  const mapRating = (rating) => {
    const r = (rating || '').trim();
    if (!r) return { pass_range: '', red_threshold: '', recheck_threshold: '' };
    if (r.includes('红灯'))     return { pass_range: '', red_threshold: '该项触发红灯', recheck_threshold: '' };
    if (r.includes('复查'))     return { pass_range: '', red_threshold: '', recheck_threshold: '该项触发复查' };
    if (r.includes('有风险'))   return { pass_range: '合格-有风险', red_threshold: '', recheck_threshold: '' };
    if (r.includes('合格'))     return { pass_range: '合格', red_threshold: '', recheck_threshold: '' };
    // 未识别的评级，全放进 pass_range 留存
    return { pass_range: r, red_threshold: '', recheck_threshold: '' };
  };

  const rows = [];
  const preview = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (c) => c
      ? ((row.getCell(c).value == null ? '' : row.getCell(c).value).toString().trim())
      : '';
    const item_name = get(colItem);
    if (!item_name) return; // 跳过空行

    const rating   = get(colRate);
    const risk     = get(colRisk);
    const threshold = mapRating(rating);

    const rowData = {
      name: item_name,           // 具体指标存入 name（便于按指标名搜索）
      item_name,                // 具体指标
      unit: rating,             // 评级（红灯/复查/合格-有风险/合格）
      pass_range:        threshold.pass_range,
      red_threshold:     threshold.red_threshold,
      recheck_threshold: threshold.recheck_threshold,
      risk_text:         risk,
      version: 1,
      is_active: true
    };
    rows.push([
      rowData.name, rowData.item_name, rowData.unit,
      rowData.pass_range, rowData.red_threshold, rowData.recheck_threshold, rowData.risk_text,
      rowData.version, rowData.is_active
    ]);
    if (preview.length < 10) preview.push(rowData);
  });

  if (rows.length === 0) return renderError('Excel 没有有效数据行');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO standards (name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, version, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        r
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return renderError('导入失败：' + e.message);
  } finally {
    client.release();
  }

  res.render('standards/upload', {
    error: null,
    success: `成功导入 ${rows.length} 条标准规则`,
    preview,
    title: '批量导入标准'
  });
});

router.get('/new', (req, res) => {
  res.render('standards/form', { standard: {}, action: '/standards', method: 'POST', error: null, title: '新增标准规则' });
});

// 一键清空所有标准（用于清理上传错误的数据）
// 注意：必须放在 /:id 路由之前，否则 "clear-all" 会被当成 id
router.post('/clear-all/delete', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM standards');
    res.redirect('/standards?cleared=' + rowCount);
  } catch (error) {
    res.redirect('/standards?error=' + encodeURIComponent(error.message));
  }
});

router.post('/', async (req, res) => {
  const { name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, version, is_active } = req.body;

  try {
    await pool.query(
      `INSERT INTO standards (name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, version, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, Number(version) || 1, is_active === 'on']
    );
    res.redirect('/standards');
  } catch (error) {
    res.render('standards/form', { standard: req.body, action: '/standards', method: 'POST', error: error.message, title: '新增标准规则' });
  }
});

router.get('/:id/edit', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM standards WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.redirect('/standards');
    res.render('standards/form', { standard: rows[0], action: `/standards/${req.params.id}`, method: 'POST', error: null, title: '编辑标准规则' });
  } catch (error) {
    res.redirect('/standards');
  }
});

router.post('/:id', async (req, res) => {
  const { name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, version, is_active } = req.body;

  try {
    await pool.query(
      `UPDATE standards SET name=$1, item_name=$2, unit=$3, pass_range=$4, red_threshold=$5, recheck_threshold=$6, risk_text=$7, version=$8, is_active=$9 WHERE id=$10`,
      [name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, Number(version) || 1, is_active === 'on', req.params.id]
    );
    res.redirect('/standards');
  } catch (error) {
    res.render('standards/form', { standard: { ...req.body, id: req.params.id }, action: `/standards/${req.params.id}`, method: 'POST', error: error.message, title: '编辑标准规则' });
  }
});

router.post('/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM standards WHERE id=$1', [req.params.id]);
    res.redirect('/standards');
  } catch (error) {
    res.redirect('/standards');
  }
});

module.exports = router;
