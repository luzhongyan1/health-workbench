const { pool } = require('../db/config');

async function main() {
  const { rows: toFix } = await pool.query(`
    SELECT h.id AS hid, u.id AS uid, h.id_card, h.check_date,
           h.detail_json AS hjson,
           u.detail_json->>'summary' AS usum,
           u.detail_json->>'risk' AS urisk,
           u.detail_json->>'abnormal' AS uabn,
           u.detail_json->>'missing' AS umiss
    FROM health_checks h
    JOIN health_checks u ON u.source = 'upload' AND u.id_card = h.id_card AND u.check_date = h.check_date
    WHERE h.source = 'history'
      AND jsonb_typeof(h.detail_json) = 'array'
      AND (h.detail_json->>9 = '' OR h.detail_json->>9 IS NULL)
      AND (h.detail_json->>10 = '' OR h.detail_json->>10 IS NULL)
      AND (h.detail_json->>11 = '' OR h.detail_json->>11 IS NULL)
    ORDER BY h.id
  `);

  console.log(`找到 ${toFix.length} 条需要修复的历史记录`);
  if (toFix.length === 0) return;

  let fixed = 0;
  for (const r of toFix) {
    const arr = Array.isArray(r.hjson) ? r.hjson : (r.hjson && r.hjson.slice ? r.hjson.slice() : []);
    // 12 列数组语义：9=目前已存在异常(summary) / 10=复查建议及相关风险(risk) / 11=备注(abnormal)
    arr[9] = r.usum || '';
    arr[10] = r.urisk || '';
    arr[11] = r.uabn || r.umiss || '';

    await pool.query('UPDATE health_checks SET detail_json = $1::jsonb WHERE id = $2', [JSON.stringify(arr), r.hid]);
    fixed += 1;
    console.log(`已修复 id=${r.hid} ${r.id_card}`);
  }

  console.log(`完成，共修复 ${fixed} 条`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
