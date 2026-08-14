const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../db/config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// parseDate(value, kind)
//   kind = 'date' → 输出 YYYY-MM-DD
//   kind = 'time' → 输出 HH:MM（处理 ExcelJS 把 datetime.time 包成 1899-12-30 + 实际时间）
function parseDate(value, kind = 'date') {
  if (value === null || value === undefined || value === '') return null;

  // ExcelJS 把 datetime.time 解析成 Date 对象（基准 1899-12-30 + 实际时分秒）
  // 例如 datetime.time(8, 0) 会变成 1899-12-30 08:00:00 这种 Date
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    if (kind === 'time' || (y === 1899 && value.getUTCMonth() === 11 && value.getUTCDate() === 30)) {
      const h = value.getUTCHours().toString().padStart(2, '0');
      const m = value.getUTCMinutes().toString().padStart(2, '0');
      return `${h}:${m}`;
    }
    if (Number.isNaN(value.getTime())) return null;
    const yy = value.getFullYear();
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const dd = String(value.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  // 字符串输入
  const s = String(value).trim();
  if (!s) return null;

  if (kind === 'time') {
    // ISO 完整串里截取 HH:MM
    const m1 = s.match(/T(\d{2}:\d{2})/);
    if (m1) return m1[1];
    // 已是 HH:MM[:SS]
    const m2 = s.match(/^(\d{1,2}:\d{2})/);
    if (m2) {
      const [hh, mm] = m2[1].split(':');
      return `${hh.padStart(2, '0')}:${mm}`;
    }
    // 1899-12-30 08:00 形式
    const m3 = s.match(/1899-12-30\s+(\d{1,2}:\d{2})/);
    if (m3) {
      const [hh, mm] = m3[1].split(':');
      return `${hh.padStart(2, '0')}:${mm}`;
    }
    return s;
  }

  // date 模式：ISO 截前 10
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) {
    const yy = fallback.getFullYear();
    const mm = String(fallback.getMonth() + 1).padStart(2, '0');
    const dd = String(fallback.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}

function fmt(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    const yy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  return String(v);
}

// SELECT 字段列表（去掉 department，加上 9 个新字段）
const SELECT_FIELDS = `id, name, id_card, phone, position, expected_onboard_date,
       actual_onboard_date, work_location, employee_category, recruiter,
       provided_date, check_date, check_time, check_address, gender`;

/**
 * 共享 SQL 片段：「最新真实招聘批次」
 * UI 只看最新一批招聘上传的名单（batch_real_ 前缀）
 * 测试数据（batch_test_ 前缀）和历史批次被自动排除
 */
const LATEST_REAL_BATCH = `
  employees.upload_batch_id = (
    SELECT MAX(upload_batch_id) FROM employees
    WHERE upload_batch_id LIKE 'batch_real_%'
  )
`;

/**
 * 数据行级隔离：
 *   - SSC / admin → 看全部招聘数据（不加归属条件）
 *   - recruiter   → 只能看自己导入的名单（uploaded_by = 当前登录账号）
 * 返回 { ownerSql, ownerParams }，ownerSql 形如 " AND uploaded_by = $1"
 */
function ownershipScope(user) {
  if (user.role === 'ssc' || user.role === 'admin') {
    return { ownerSql: '', ownerParams: [] };
  }
  return { ownerSql: ' AND uploaded_by = $1', ownerParams: [user.username] };
}

router.get('/', async (req, res) => {
  try {
    // 当前用户是否 SSC/admin（拥有「视角切换」能力）
    const canSwitch = (req.user.role === 'ssc' || req.user.role === 'admin');
    // 招聘账号列表（视角切换下拉的数据源）
    const { rows: recruiterRows } = await pool.query(
      `SELECT username, COALESCE(NULLIF(display_name,''), username) AS display_name
       FROM users WHERE role = 'recruiter' ORDER BY username`
    );
    const recruiterUsers = recruiterRows.map(r => ({ username: r.username, display_name: r.display_name }));

    // 视角切换：SSC/admin 可通过 ?view_as=招聘账号 临时以该招聘账号视角查看（只读）
    let viewAs = '';
    if (canSwitch && req.query.view_as) {
      const target = recruiterUsers.find(u => u.username === req.query.view_as);
      if (target) viewAs = target.username;
    }

    // 数据归属过滤：以招聘视角查看 → 只看该账号导入的数据；否则按登录角色
    let ownerSql = '', ownerParams = [];
    if (viewAs) {
      ownerSql = ' AND uploaded_by = $1';
      ownerParams = [viewAs];
    } else {
      const scope = ownershipScope(req.user);
      ownerSql = scope.ownerSql;
      ownerParams = scope.ownerParams;
    }

    const [{ count: pendingCount }] = (await pool.query(`SELECT COUNT(*) AS count FROM employees WHERE ${LATEST_REAL_BATCH} AND status = 'needs_appointment'${ownerSql}`, ownerParams)).rows;
    const [{ count: exemptCount }] = (await pool.query(`SELECT COUNT(*) AS count FROM employees WHERE ${LATEST_REAL_BATCH} AND status = 'exempt'${ownerSql}`, ownerParams)).rows;
    // 历史已预约人数：统计所有真实批次中已被 SSC 归档，并且存在本次上传体检结果（source='upload'）的员工数
    // 注意：剔除因近 90 天内历史合格而被自动免试的员工（他们没有本次 source='upload' 记录）
    const [{ count: archivedCount }] = (await pool.query(
      `SELECT COUNT(DISTINCT e.id) AS count
       FROM employees e
       WHERE e.upload_batch_id LIKE 'batch_real_%'
         AND e.status = 'archived'
         AND EXISTS (
           SELECT 1 FROM health_checks hc
           WHERE hc.employee_id = e.id AND hc.source = 'upload'
         )${ownerSql}`, ownerParams
    )).rows;
    const { rows: pendingList } = await pool.query(
      `SELECT ${SELECT_FIELDS} FROM employees WHERE ${LATEST_REAL_BATCH} AND status = 'needs_appointment'${ownerSql} ORDER BY id ASC LIMIT 200`, ownerParams
    );
    const { rows: exemptList } = await pool.query(
      `SELECT ${SELECT_FIELDS} FROM employees WHERE ${LATEST_REAL_BATCH} AND status = 'exempt'${ownerSql} ORDER BY id ASC LIMIT 200`, ownerParams
    );
    res.render('recruiter/index', {
      title: '招聘管理', pendingCount, exemptCount, archivedCount, pendingList, exemptList,
      error: null, deleted: req.query.deleted || '', cleared: req.query.cleared || '',
      isGlobalView: ownerSql === '', viewAs, recruiterUsers, canSwitch
    });
  } catch (error) {
    res.render('recruiter/index', {
      title: '招聘管理', pendingCount: 0, exemptCount: 0, archivedCount: 0, pendingList: [], exemptList: [],
      error: error.message, deleted: '', cleared: '', isGlobalView: false, viewAs: '', recruiterUsers: [], canSwitch: false
    });
  }
});

router.post('/clear/:status', async (req, res) => {
  const allowed = ['needs_appointment', 'exempt'];
  const status = req.params.status;
  if (!allowed.includes(status)) {
    return res.render('recruiter/index', { title: '招聘管理', pendingCount: 0, exemptCount: 0, archivedCount: 0, pendingList: [], exemptList: [], error: '非法的状态值', deleted: '', cleared: '', isGlobalView: false });
  }
  try {
    const { ownerSql, ownerParams } = ownershipScope(req.user);
    const { rowCount } = await pool.query(`DELETE FROM employees WHERE ${LATEST_REAL_BATCH} AND status = $1${ownerSql}`, [status, ...ownerParams]);
    const labelMap = { needs_appointment: '需预约体检', exempt: '免检人员' };
    res.redirect('/recruiter?cleared=' + encodeURIComponent(labelMap[status]) + '&count=' + rowCount);
  } catch (error) {
    res.render('recruiter/index', { title: '招聘管理', pendingCount: 0, exemptCount: 0, archivedCount: 0, pendingList: [], exemptList: [], error: error.message, deleted: '', cleared: '', isGlobalView: false });
  }
});

router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    return res.render('recruiter/index', { title: '招聘管理', pendingCount: 0, exemptCount: 0, archivedCount: 0, pendingList: [], exemptList: [], error: '非法的员工 ID', deleted: '', cleared: '', isGlobalView: false });
  }
  try {
    const { ownerSql, ownerParams } = ownershipScope(req.user);
    const { rowCount } = await pool.query(`DELETE FROM employees WHERE id = $1${ownerSql}`, [id, ...ownerParams]);
    if (!rowCount) {
      return res.render('recruiter/index', { title: '招聘管理', pendingCount: 0, exemptCount: 0, archivedCount: 0, pendingList: [], exemptList: [], error: '未找到指定员工（或无权操作该员工）', deleted: '', cleared: '', isGlobalView: false });
    }
    res.redirect('/recruiter?deleted=' + encodeURIComponent(id));
  } catch (error) {
    res.render('recruiter/index', { title: '招聘管理', pendingCount: 0, exemptCount: 0, archivedCount: 0, pendingList: [], exemptList: [], error: error.message, deleted: '', cleared: '', isGlobalView: false });
  }
});

router.get('/import', (req, res) => {
  res.render('recruiter/import', { title: '导入体检名单', error: null, result: null });
});

// Excel 模板有 2 行表头（第1行合并标题，第2行列名），数据从第3行开始
// 列位映射（Excel 字母 → 数据库字段）：
// B=体检人姓名(name), C=身份证号(id_card), D=手机号(phone), E=拟入职时间(expected_onboard_date),
// F=办理入职时间(actual_onboard_date), G=工作地(work_location), H=员工分类(employee_category),
// I=名单提供人(recruiter), J=提供日期(provided_date), K=体检日期(check_date),
// L=体检时间(check_time), M=体检地址(check_address), N=性别(gender), Q=岗位(position)
// A=序号(跳过), O=性别验证(公式), P=身份证号验证(公式) → 跳过
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('recruiter/import', { title: '导入体检名单', error: '请上传 Excel 文件', result: null });
  }
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const worksheet = workbook.worksheets[0];
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= 2) return; // 跳过 2 行表头
      const name = (row.getCell(2).text || '').trim();
      const id_card = (row.getCell(3).text || '').trim();
      if (!name || !id_card) return;
      rows.push({
        name,
        id_card,
        phone: (row.getCell(4).text || '').trim(),
        expected_onboard_date: parseDate(row.getCell(5).value, 'date'),
        actual_onboard_date: parseDate(row.getCell(6).value, 'date'),
        work_location: (row.getCell(7).text || '').trim(),
        employee_category: (row.getCell(8).text || '').trim(),
        recruiter: (row.getCell(9).text || '').trim(),
        provided_date: parseDate(row.getCell(10).value, 'date'),
        check_date: parseDate(row.getCell(11).value, 'date'),
        check_time: parseDate(row.getCell(12).value, 'time'),
        check_address: (row.getCell(13).text || '').trim(),
        gender: (row.getCell(14).text || '').trim(),
        position: (row.getCell(17).text || '').trim()
      });
    });

    const results = { imported: 0, exempt: 0, needsAppointment: 0 };
    const now = new Date();
    const compareDate = new Date(now);
    compareDate.setDate(now.getDate() - 90);
    const compareKey = `${compareDate.getFullYear()}-${String(compareDate.getMonth() + 1).padStart(2, '0')}-${String(compareDate.getDate()).padStart(2, '0')}`;

    // 生成本次上传的唯一批次号（batch_real_YYYYMMDDHHmmss）
    const pad = (n) => String(n).padStart(2, '0');
    const batchId = `batch_real_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    for (const item of rows) {
      const { rows: existing } = await pool.query('SELECT id FROM employees WHERE id_card = $1', [item.id_card]);
      let employeeId;
      if (existing.length) {
        employeeId = existing[0].id;
        await pool.query(
          `UPDATE employees SET name=$1, phone=$2, position=$3, expected_onboard_date=$4,
              actual_onboard_date=$5, work_location=$6, employee_category=$7, recruiter=$8,
              provided_date=$9, check_date=$10, check_time=$11, check_address=$12, gender=$13,
              upload_batch_id=$14, uploaded_by=$15
           WHERE id=$16`,
          [item.name, item.phone, item.position, item.expected_onboard_date,
           item.actual_onboard_date, item.work_location, item.employee_category, item.recruiter,
           item.provided_date, item.check_date, item.check_time, item.check_address, item.gender,
           batchId, req.user.username, employeeId]
        );
      } else {
        const insert = await pool.query(
          `INSERT INTO employees (name, id_card, phone, position, expected_onboard_date,
              actual_onboard_date, work_location, employee_category, recruiter,
              provided_date, check_date, check_time, check_address, gender, status, upload_batch_id, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16) RETURNING id`,
          [item.name, item.id_card, item.phone, item.position, item.expected_onboard_date,
           item.actual_onboard_date, item.work_location, item.employee_category, item.recruiter,
           item.provided_date, item.check_date, item.check_time, item.check_address, item.gender,
           batchId, req.user.username]
        );
        employeeId = insert.rows[0].id;
      }

      const { rows: checkRows } = await pool.query(
        `SELECT hc.id FROM health_checks hc
         WHERE hc.id_card = $1 AND hc.check_date >= $2
           AND hc.source = 'history'
           AND LOWER(hc.overall_result) IN ('pass', '合格', '合格-有风险', 'pass-risk', 'pass_risk')
         ORDER BY hc.check_date DESC LIMIT 1`,
        [item.id_card, compareKey]
      );

      if (checkRows.length) {
        await pool.query("UPDATE employees SET status = 'exempt' WHERE id = $1", [employeeId]);
        results.exempt += 1;
      } else {
        await pool.query("UPDATE employees SET status = 'needs_appointment' WHERE id = $1", [employeeId]);
        results.needsAppointment += 1;
      }
      results.imported += 1;
    }

    res.render('recruiter/import', { title: '导入体检名单', error: null, result: results });
  } catch (error) {
    res.render('recruiter/import', { title: '导入体检名单', error: error.message, result: null });
  }
});

module.exports = router;
