/**
 * 共享 SQL 片段 — UI 计算「待检人员」时统一使用，保证 dashboard / SSC 工作台 / 导出 Excel
 * 看到的人数一致。
 */

/**
 * 「历史体检合格」过滤条件
 *
 * 判断一名员工是否在最近 90 天内做过体检且结论合格：
 *   - hc.source = 'history'：只用历史底表，不把"上传的本批次体检结果"当作豁免依据
 *   - check_date >= CURRENT_DATE - 90 day：3 个月内有效（过期要重做）
 *   - overall_result in (pass 白名单)：含风险项也算基本合格
 */
const PASS_IN_HISTORY_FILTER = `
  hc.source = 'history'
  AND hc.id_card = employees.id_card
  AND hc.check_date >= (CURRENT_DATE - INTERVAL '90 day')
  AND LOWER(hc.overall_result) IN ('pass','合格','合格-有风险','pass-risk','pass_risk','合格有风险')
`;

/**
 * 「已上传本次体检结果」过滤条件
 *
 * 一旦某员工有了 source='upload' 的体检结果，就不再在 SSC/招聘端工作台展示，
 * 视为该批次已处理完毕。
 */
const HAS_UPLOAD_FILTER = `
  EXISTS (
    SELECT 1 FROM health_checks hc
    WHERE hc.employee_id = employees.id AND hc.source = 'upload'
  )
`;

/**
 * 「最新真实招聘批次」过滤条件
 *
 * employees 表是累积表（多次招聘上传 + 测试数据），UI 只看最新一批真实上传：
 *   - upload_batch_id LIKE 'batch_real_%'：测试数据（batch_test_）和空值自动排除
 *   - SELECT MAX(...)：取最近一次上传
 */
const LATEST_REAL_BATCH = `
  employees.upload_batch_id = (
    SELECT MAX(upload_batch_id) FROM employees
    WHERE upload_batch_id LIKE 'batch_real_%'
  )
`;

module.exports = {
  PASS_IN_HISTORY_FILTER,
  HAS_UPLOAD_FILTER,
  LATEST_REAL_BATCH
};
