// =============================================================
// 健康评级服务——按用户上传的体检标准 (standards 表) 严格判定
// =============================================================
//
// 核心规则：
//   1. 评级只有 5 档：红灯 / 复查 / 合格-有风险 / 合格 / 未参检
//   2. 优先级：红灯 > 复查 > 合格-有风险 > 合格 > 未参检
//   3. 完全按 standards 表的字面规则匹配——禁止从医学角度扩大异常范围
//   4. 不在 standards 表里的项目 = 合格
//   5. 异常项、缺项、风险提示都从 standards 表里命中项聚合

const RATING_SEVERITY = {
  '合格': 0,
  '合格-有风险': 1,
  '复查': 2,
  '红灯': 3,
};

// =============================================================
// 医学术语别名映射（中文 ↔ 英文缩写）
// =============================================================
const TERM_ALIASES = [
  { canonical: 'ALT', aliases: ['丙氨酸氨基转移酶', '谷丙转氨酶', 'ALT'] },
  { canonical: 'AST', aliases: ['天门冬氨酸氨基转移酶', '谷草转氨酶', 'AST'] },
  { canonical: 'BMI', aliases: ['体重指数', 'BMI'] },
  { canonical: '收缩压', aliases: ['收缩压', '高压'] },
  { canonical: '舒张压', aliases: ['舒张压', '低压'] },
  { canonical: '血小板', aliases: ['血小板', 'PLT'] },
  { canonical: '血红蛋白', aliases: ['血红蛋白', 'HGB', 'Hb'] },
  { canonical: '白细胞', aliases: ['白细胞', 'WBC'] },
  { canonical: '淋巴细胞百分比', aliases: ['淋巴细胞百分比', 'LYM%'] },
  { canonical: '淋巴细胞数', aliases: ['淋巴细胞数', 'LYM#'] },
  { canonical: '尿蛋白', aliases: ['尿蛋白', '尿蛋白质', 'PRO'] },
  { canonical: '尿白细胞', aliases: ['尿白细胞', 'LEU'] },
  { canonical: '尿隐血', aliases: ['尿隐血', '尿潜血', 'BLD'] },
  { canonical: '尿酮体', aliases: ['尿酮体', '酮体', 'KET'] },
  { canonical: '心率', aliases: ['心率', 'HR'] },
  { canonical: '血压', aliases: ['血压', 'BP'] },
];

// 被排除的相似词——防止误匹配（如"谷草谷丙比值"不应匹配 ALT/AST）
const EXCLUDE_TERMS = new Set([
  '谷草谷丙比值', '比值', '谷草比', '谷丙比', 'DeRitis',
]);

// 子串匹配排除后缀——当标准名是测试名的子串，但后缀表示不同检验项目时不匹配
// 例如 "血小板压积" 不应匹配标准 "血小板"，"淋巴细胞百分比" 不应匹配 "淋巴细胞"
const SUBSTRING_EXCLUDE_SUFFIXES = [
  '压积', '百分比', '比值', '体积', '分布宽度', '比率', '计数', '绝对值',
  '大型', '小型', '中间', '分类', '分类计数',
];

const RE_CJK = /[㐀-鿿]+/g;
const RE_LATIN = /[A-Za-z]+/g;

// =============================================================
// 解析体检标准条目：提取测试名称和数值条件
// =============================================================
function parseStandardItemName(itemName) {
  const original = itemName.toString().trim();
  // 去掉分类前缀（"肝功能:" "血压:" "尿常规:" "心电图：" 等）
  let core = original.replace(/^[^：:]+[：:]\s*/, '');

  let condition = null;

  // 范围条件："45-50" 或 "150-200"
  const rangeMatch = core.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) {
    condition = { type: 'range', min: parseFloat(rangeMatch[1]), max: parseFloat(rangeMatch[2]) };
    core = core.replace(rangeMatch[0], '').trim();
  }

  // >= 或 ≥ 或 "高于N"
  if (!condition) {
    const geMatch = core.match(/[>=≥]+\s*(\d+(?:\.\d+)?)/);
    if (geMatch) {
      condition = { type: 'gte', value: parseFloat(geMatch[1]) };
      core = core.replace(geMatch[0], '').trim();
    }
  }
  // "高于N" → >= N
  if (!condition) {
    const higherMatch = core.match(/高于\s*(\d+(?:\.\d+)?)/);
    if (higherMatch) {
      condition = { type: 'gte', value: parseFloat(higherMatch[1]) };
      core = core.replace(higherMatch[0], '').trim();
    }
  }

  // "N以上" → >= N
  if (!condition) {
    const aboveMatch = core.match(/(\d+(?:\.\d+)?)\s*以上/);
    if (aboveMatch) {
      condition = { type: 'gte', value: parseFloat(aboveMatch[1]) };
      core = core.replace(aboveMatch[0], '').trim();
    }
  }

  // "N以下" 或 "低于N" → <= N
  if (!condition) {
    const belowMatch = core.match(/(?:低于|小于|<|≤)\s*(\d+(?:\.\d+)?)/);
    if (belowMatch) {
      condition = { type: 'lte', value: parseFloat(belowMatch[1]) };
      core = core.replace(belowMatch[0], '').trim();
    }
  }
  if (!condition) {
    const belowMatch2 = core.match(/(\d+(?:\.\d+)?)\s*以下/);
    if (belowMatch2) {
      condition = { type: 'lte', value: parseFloat(belowMatch2[1]) };
      core = core.replace(belowMatch2[0], '').trim();
    }
  }

  // 尿常规级别："3+" "2+" 等
  if (!condition) {
    const urineMatch = core.match(/(\d+)\s*\+/);
    if (urineMatch) {
      condition = { type: 'urine', level: parseInt(urineMatch[1]) };
      core = core.replace(urineMatch[0], '').trim();
    }
  }

  // 按 "/" 拆分别名（如 "ALT/AST" 表示 ALT 或 AST）
  const alternatives = core.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);

  // 从括号中提取别名（如 "舒张压（低压）" → 舒张压, 低压）
  const testNames = [];
  for (const alt of alternatives) {
    const parenMatch = alt.match(/^([^(（]+)[(（]([^)）]+)[)）]/);
    if (parenMatch) {
      testNames.push(parenMatch[1].trim());
      testNames.push(parenMatch[2].trim());
    } else {
      testNames.push(alt);
    }
  }

  return { testNames, condition, original };
}

// =============================================================
// 解析体检报告异常文本行 → 结构化测试项
// =============================================================
function parseTestItem(line) {
  const cleaned = line.trim();
  if (!cleaned) return null;

  // 格式1: [名称] [偏高/偏低/异常] [数值] [单位] [↑/↓]
  const m1 = cleaned.match(/^(.+?)\s*(?:偏高|偏低|增高|降低|异常|阳性|阴性)?\s*(\d+(?:\.\d+)?)\s*([A-Za-z/%^①-⑳\d]+)?\s*[↑↓]?\s*$/);
  if (m1) {
    const name = m1[1].replace(/[\s↑↓]+$/, '').trim();
    // 排除"序号、项目名"这种被误匹配的情况
    if (name.length >= 2) {
      return { name, value: parseFloat(m1[2]), unit: m1[3] || '', raw: cleaned };
    }
  }

  // 格式2: [名称] [+N / +- / -N / N+]
  const m2 = cleaned.match(/^(.+?)\s*([+\-]\d+|[\d]+\+|\+-|-\+|-)\s*$/);
  if (m2) {
    const name = m2[1].trim();
    if (name.length >= 2) {
      return { name, value: m2[2], unit: '', raw: cleaned };
    }
  }

  // 格式3: 纯文本描述（如 "轻度脂肪肝"）
  return { name: cleaned, value: null, unit: '', raw: cleaned };
}

function parseAbnormalText(text) {
  if (!text) return [];
  const items = [];
  const lines = text.toString().split(/\r?\n/);
  let currentCategory = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 识别分类标题行，如 "1、一般检查（5项）" "2、内科常规检查（5项）"
    const catMatch = trimmed.match(/^\d+[、.．]\s*(.+?)[（(]\s*\d+\s*[项)）]/);
    if (catMatch) {
      currentCategory = catMatch[1].trim();
      continue;
    }

    // 跳过分类标题行，如 "1、一般检查（5项）" "2、肝功能3项(251024)"
    if (/^\d+[、.．]\s*.+[（(]\s*\d+\s*[项)）]/.test(trimmed)) continue;
    if (/^\d+[、.．]\s*[\u4e00-\u9fa5A-Za-z]+\d*[（(]/.test(trimmed) && !/\d+\.?\d*\s*(U\/L|mmHg|%|g\/L|10)/.test(trimmed)) continue;

    // 去掉行首序号 "(1)" "1." "2、"
    const deNumbered = trimmed
      .replace(/^[(（]?\s*\d+\s*[)）]?\s*[\.、.．:：]?\s*/, '')
      .trim();
    if (!deNumbered) continue;

    const item = parseTestItem(deNumbered);
    if (item) {
      item.category = currentCategory;
      item.rawLine = trimmed;
      items.push(item);
    }
  }
  return items;
}

// =============================================================
// 名称匹配：检查测试项名称是否与标准条目名称匹配
// =============================================================
function nameMatches(testItemName, stdTestNames, standardOriginal) {
  const testName = testItemName.toString();

  // 检查排除词
  for (const ex of EXCLUDE_TERMS) {
    if (testName.includes(ex)) return false;
  }

  // 如果测试项以"尿"开头，但标准不属于尿常规——不匹配（防止"尿白细胞"匹配"白细胞"）
  const testIsUrine = /^尿/.test(testName);
  const stdIsUrine = (standardOriginal || '').includes('尿') || stdTestNames.some(n => (n || '').includes('尿'));
  if (testIsUrine && !stdIsUrine) return false;

  // 如果标准是血常规类，测试项以"尿"开头——不匹配
  const stdIsBlood = /血常规|血细胞/.test(standardOriginal || '');
  if (stdIsBlood && testIsUrine) return false;

  for (const stdName of stdTestNames) {
    if (!stdName) continue;
    const sn = stdName.trim();
    if (!sn) continue;

    // 直接包含
    if (testName === sn || testName.includes(sn) || sn.includes(testName)) {
      // 子串匹配时检查后缀排除
      if (testName !== sn && testName.includes(sn) && testName.length > sn.length) {
        const suffix = testName.replace(sn, '');
        if (SUBSTRING_EXCLUDE_SUFFIXES.some(sfx => suffix.includes(sfx))) {
          continue; // 后缀表示不同检验项目，跳过
        }
      }
      return true;
    }

    // 通过别名匹配
    for (const group of TERM_ALIASES) {
      const testHit = group.aliases.some(a => testName.includes(a)) || testName.includes(group.canonical);
      const stdHit = group.aliases.some(a => sn.includes(a)) || sn.includes(group.canonical);
      if (testHit && stdHit) {
        // 别名匹配也要检查后缀排除
        if (testName.length > 2) {
          for (const sfx of SUBSTRING_EXCLUDE_SUFFIXES) {
            if (testName.includes(sfx) && !sn.includes(sfx)) {
              // 测试名有排除后缀但标准名没有——可能是不同项目
              // 但如果别名精确匹配则仍然算匹配
              const exactAlias = group.aliases.some(a => testName === a || testName.includes(a + ' '));
              if (!exactAlias) continue;
            }
          }
        }
        return true;
      }
    }

    // 关键词匹配（CJK 长度>=2）
    const testKws = extractKeywords(testName);
    const stdKws = extractKeywords(sn);
    const common = testKws.filter(k => stdKws.some(sk => sk.includes(k) || k.includes(sk)));
    if (common.length >= 1 && common.some(k => k.length >= 2)) {
      // 关键词匹配也检查后缀排除
      if (testName.length > sn.length) {
        const suffix = testName.replace(sn, '');
        if (SUBSTRING_EXCLUDE_SUFFIXES.some(sfx => suffix.includes(sfx))) {
          continue;
        }
      }
      return true;
    }
  }

  return false;
}

// =============================================================
// 数值条件匹配
// =============================================================
function conditionMatches(testItem, condition) {
  if (!condition) return true; // 无条件 = 纯文本匹配
  if (testItem.value == null) return false;

  // 尿常规级别
  if (condition.type === 'urine') {
    const val = testItem.value.toString();
    const m = val.match(/(\d+)/);
    if (!m) return false;
    return parseInt(m[1]) >= condition.level;
  }

  // 数值条件
  const numVal = typeof testItem.value === 'number' ? testItem.value : parseFloat(testItem.value);
  if (isNaN(numVal)) return false;

  switch (condition.type) {
    case 'range': return numVal >= condition.min && numVal <= condition.max;
    case 'gte': return numVal >= condition.value;
    case 'lte': return numVal <= condition.value;
    default: return true;
  }
}

// =============================================================
// 从 standard 行抽出最严重的判定标签
// =============================================================
function ratingOfStandard(std) {
  const red = (std.red_threshold || '').toString().trim();
  const recheck = (std.recheck_threshold || '').toString().trim();
  const pass = (std.pass_range || '').toString().trim();
  const unit = (std.unit || '').toString().trim();

  if (red && /红灯/.test(red)) return '红灯';
  if (recheck && /复查/.test(recheck)) return '复查';
  // unit 字段也可能存了评级
  if (unit === '红灯') return '红灯';
  if (unit === '复查') return '复查';
  if (unit === '合格-有风险' || pass === '合格-有风险') return '合格-有风险';
  if (unit === '合格' || pass === '合格') return '合格';
  return normalizeRating(pass) || normalizeRating(unit);
}

function normalizeRating(v) {
  if (!v) return '';
  const s = v.toString().trim();
  if (s.includes('红灯')) return '红灯';
  if (s.includes('复查')) return '复查';
  if (s.includes('风险')) return '合格-有风险';
  if (s.includes('合格')) return '合格';
  return '';
}

// =============================================================
// 核心：按体检标准判定（本地规则引擎）
// =============================================================
function judgeByStandards(abnormalText, missingText, standards) {
  const result = {
    overall: '合格',
    abnormalItems: [],
    missingItems: [],
    riskText: '',
    hits: [],
    itemDetails: [],
  };

  if (!standards || standards.length === 0) return result;

  const fullAbnormalText = (abnormalText || '').toString();
  const fullMissingText = (missingText || '').toString();

  // 规则 A：未到检 / 未参检 直接判定
  const notAttendedRegex = /^\s*(未到检|未参检|未参加体检|未体检)\s*$/;
  if (notAttendedRegex.test(fullAbnormalText) || notAttendedRegex.test(fullMissingText)) {
    result.overall = '未参检';
    return result;
  }

  // 规则 B：体检报告明确写“未见明显异常”即视为合格，禁止自行联想
  if (/未见(明显)?异常/.test(fullAbnormalText)) {
    result.overall = '合格';
    return result;
  }

  // 解析异常文本和缺项文本为结构化测试项
  const testItems = parseAbnormalText(abnormalText);
  const missingItemsParsed = parseAbnormalText(missingText);

  const riskSet = new Set();
  const abnormalNameSet = new Set();
  const missingNameSet = new Set();
  let worstRating = '合格';

  for (const std of standards) {
    if (!std.item_name) continue;
    const itemName = std.item_name.toString().trim();
    if (!itemName || itemName === '[object Object]') continue;

    const rating = ratingOfStandard(std);
    if (!rating || rating === '合格') continue; // 跳过"合格"标准，不产生命中

    const parsed = parseStandardItemName(itemName);

    let matchedItem = null;
    let source = null;

    // 1. 在异常测试项中匹配
    const isHeartRateStd = parsed.testNames.some(n => n === '心率' || n === 'HR');
    for (const ti of testItems) {
      // 内科常规检查的心率不是心电图心率，不纳入考核
      if (isHeartRateStd && (ti.category || '').includes('内科') && (ti.name || '').includes('心率')) {
        continue;
      }
      if (nameMatches(ti.name, parsed.testNames, parsed.original) && conditionMatches(ti, parsed.condition)) {
        matchedItem = ti;
        source = 'abnormal';
        break;
      }
    }

    // 2. 在缺项中匹配
    if (!matchedItem) {
      for (const mi of missingItemsParsed) {
        if (nameMatches(mi.name, parsed.testNames, parsed.original)) {
          matchedItem = mi;
          source = 'missing';
          break;
        }
      }
    }

    // 3. 回退到全文本匹配（处理解析不出来的情况）
    if (!matchedItem) {
      if (fullAbnormalText.includes(itemName) || fullMissingText.includes(itemName)) {
        // 检查数值条件是否满足
        if (!parsed.condition || textContainsMatchingNumber(fullAbnormalText, parsed.condition, parsed.testNames)) {
          matchedItem = { name: itemName, value: null, raw: itemName };
          source = fullMissingText.includes(itemName) ? 'missing' : 'abnormal';
        }
      }
    }

    if (!matchedItem) continue;

    result.hits.push({ source, text: matchedItem.raw, standard: std, rating });
    result.itemDetails.push({ itemName, rating, risk: std.risk_text || '' });

    if (source === 'abnormal' && !abnormalNameSet.has(itemName)) {
      abnormalNameSet.add(itemName);
      result.abnormalItems.push(itemName);
    } else if (source === 'missing' && !missingNameSet.has(itemName)) {
      missingNameSet.add(itemName);
      result.missingItems.push(itemName);
    }

    if (std.risk_text && !riskSet.has(std.risk_text)) {
      riskSet.add(std.risk_text);
    }

    if (RATING_SEVERITY[rating] != null && RATING_SEVERITY[rating] > (RATING_SEVERITY[worstRating] || 0)) {
      worstRating = rating;
    }
  }

  result.overall = worstRating;
  result.riskText = Array.from(riskSet).filter(Boolean).join('\n');
  return result;
}

// 全文本中查找匹配数值条件的内容
function textContainsMatchingNumber(text, condition, testNames) {
  if (!condition) return true;
  const lines = text.toString().split(/\r?\n/);
  for (const line of lines) {
    for (const tn of testNames) {
      if (!line.includes(tn)) continue;
      const nums = (line.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      for (const n of nums) {
        switch (condition.type) {
          case 'range': if (n >= condition.min && n <= condition.max) return true; break;
          case 'gte': if (n >= condition.value) return true; break;
          case 'lte': if (n <= condition.value) return true; break;
          case 'urine': break; // 尿常规在文本匹配中跳过
        }
      }
    }
  }
  return false;
}

// =============================================================
// 辅助函数（保持向后兼容）
// =============================================================
function splitLines(text) {
  if (!text) return [];
  return text.toString()
    .split(/\r?\n|(?=[(（]\s*\d+\s*[)）])|\s*[;,，；]\s*(?=\d+[\.、)）]\s*)/)
    .map((s) => s.replace(/^[(（]\s*\d+\s*[)）]\s*[\.、:：]?\s*/, '').trim())
    .filter(Boolean);
}

function extractKeywords(itemName) {
  if (!itemName) return [];
  const text = itemName.toString().trim();
  const segments = [];
  const cjk = text.match(RE_CJK) || [];
  const lat = text.match(RE_LATIN) || [];
  for (const s of cjk) if (s.length >= 2) segments.push(s);
  for (const s of lat) segments.push(s);
  return segments;
}

function stripLineNumbers(text) {
  return text.toString()
    .replace(/[(（]\s*\d+\s*[)）]\s*[\.、:：]?\s*/g, ' ')
    .replace(/(?:^|\n)\s*\d+\s*[\.、:：]\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

function extractNumbers(text) {
  const m = text.match(/\d+(?:\.\d+)?/g) || [];
  return m.map(Number);
}

function numericOk(itemName, text) {
  const parsed = parseStandardItemName(itemName);
  if (!parsed.condition) return true;
  const testItems = parseAbnormalText(text);
  for (const ti of testItems) {
    if (nameMatches(ti.name, parsed.testNames, parsed.original) && conditionMatches(ti, parsed.condition)) return true;
  }
  return textContainsMatchingNumber(text, parsed.condition, parsed.testNames);
}

function matchByText(text, standard) {
  if (!text || !standard || !standard.item_name) return false;
  const parsed = parseStandardItemName(standard.item_name);
  const testItems = parseAbnormalText(text);
  for (const ti of testItems) {
    if (nameMatches(ti.name, parsed.testNames, parsed.original) && conditionMatches(ti, parsed.condition)) return true;
  }
  return text.toString().includes(standard.item_name.toString());
}

function parseRange(value) {
  if (!value) return null;
  const clean = value.toString().trim();
  const rangeMatch = clean.match(/^(\d+(?:\.\d+)?)[-~](\d+(?:\.\d+)?)$/);
  if (rangeMatch) return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  const number = Number(clean);
  if (!Number.isNaN(number)) return { min: number, max: number };
  return null;
}

function compareValue(valueText, thresholdText) {
  if (valueText == null || thresholdText == null) return false;
  const value = Number(valueText.toString().replace(/[^\d.\-]/g, ''));
  const threshold = Number(thresholdText.toString().replace(/[^\d.\-]/g, ''));
  if (Number.isNaN(value) || Number.isNaN(threshold)) return false;
  return value > threshold;
}

function judgeItem(itemValue, standard) {
  const valueNumber = Number(itemValue);
  const red = parseRange(standard.red_threshold);
  const recheck = parseRange(standard.recheck_threshold);
  const pass = parseRange(standard.pass_range);
  if (!Number.isNaN(valueNumber) && red) {
    if (valueNumber >= red.min && valueNumber <= (red.max ?? red.min)) {
      return { result: 'red', reason: standard.risk_text || '红灯异常' };
    }
  }
  if (!Number.isNaN(valueNumber) && recheck) {
    if (valueNumber >= recheck.min && valueNumber <= (recheck.max ?? recheck.min)) {
      return { result: 'recheck', reason: standard.risk_text || '复查异常' };
    }
  }
  return { result: 'pass', reason: '' };
}

function rankOverall(results) {
  if (results.some((item) => item.result === 'red')) return '红灯';
  if (results.some((item) => item.result === 'recheck')) return '复查';
  if (results.some((item) => item.result === 'manual')) return '人工判定';
  return '合格';
}

// =============================================================
// DeepSeek 深度思考 AI 评级（保留接口，本地无 Key 时自动跳过）
// =============================================================
const deepseek = require('./deepseek');

const RATING_ORDER = ['红灯', '复查', '合格-有风险', '合格', '未参检'];

function standardToText(std) {
  const name = (std.item_name || '').trim();
  const rating = std.red_threshold ? '红灯'
    : std.recheck_threshold ? '复查'
    : (std.pass_range || '').includes('风险') ? '合格-有风险'
    : (std.pass_range || '').includes('合格') ? '合格'
    : '';
  const risk = (std.risk_text || '').trim();
  return `- 项目名称：${name}\n  评级：${rating || '未指定'}\n  风险提示：${risk || '无'}`;
}

function buildSystemPrompt() {
  return `你是一位严格按公司体检标准执行审核的助手。你的任务是把员工的体检结果和「缺项」与上传的体检标准进行一一比对，给出最终评级。

【核心规则】
1. 严格按照体检标准对体检结果进行评级，评级结果只能是：红灯、复查、合格-有风险、合格、未参检。优先级从高到低：红灯 > 复查 > 合格-有风险 > 合格 > 未参检。
2. 必须严格按「体检标准」中的项目文字进行匹配。只有标准中明确列出的异常/缺项才能触发对应评级。
3. 不在体检标准中的检查项目或异常描述，一律视为「合格」，禁止从医学角度扩大异常范围。
4. 如果员工的异常/缺项与某条标准描述的是同一项目且条件满足，则命中该标准。
5. 最终评级取所有命中标准中优先级最高的那一档。
6. 如果没有任何标准被命中，最终评级为「合格」。
7. 如果员工体检结果为空、缺失或明确标记为未参检，则最终评级为「未参检」。
8. 风险提示只汇总命中标准里的 risk_text，不要自己补充医学解释。

【输出格式】
必须返回合法 JSON，格式如下：
{
  "results": [
    {
      "id_card": "身份证号",
      "name": "姓名",
      "overall": "红灯|复查|合格-有风险|合格|未参检",
      "matchedAbnormalItems": [
        {"name": "标准项目名称", "rating": "红灯|复查|合格-有风险", "risk": "对应风险提示"}
      ],
      "matchedMissingItems": [
        {"name": "标准项目名称", "rating": "红灯|复查|合格-有风险", "risk": "对应风险提示"}
      ],
      "riskText": "所有命中项的风险提示汇总，无则留空字符串"
    }
  ]
}

注意：
- 只输出 JSON，不要输出任何解释文字。
- 禁止增加或者从医学角度扩大异常范围，不在表格中的属于合格项。`;
}

function buildUserPrompt(persons, standards) {
  const standardsText = standards.length
    ? standards.map(standardToText).join('\n\n')
    : '（未上传体检标准）';

  const personsText = persons.map((p, idx) => {
    const abnormal = (p.abnormal || p.summary || '').trim();
    const missing = (p.missing || '').trim();
    return `【人员 ${idx + 1}】
身份证号：${p.id_card || ''}
姓名：${p.name || ''}
目前已存在异常：${abnormal || '无'}
缺项：${missing || '无'}`;
  }).join('\n\n---\n\n');

  return `以下是公司体检标准（共 ${standards.length} 条）：

${standardsText}

===============================

以下是待审核员工（共 ${persons.length} 人）：

${personsText}

请严格按照上述标准，对每个人给出最终评级和命中项。返回 JSON。`;
}

function normalizeAiRating(r) {
  const s = String(r || '').trim();
  if (s.includes('红灯')) return '红灯';
  if (s.includes('复查')) return '复查';
  if (s.includes('风险')) return '合格-有风险';
  if (s === '未参检') return '未参检';
  if (s.includes('合格')) return '合格';
  return '';
}

function pickWorstRating(items) {
  let worst = '合格';
  const severity = { '未参检': 0, '合格': 1, '合格-有风险': 2, '复查': 3, '红灯': 4 };
  for (const it of items) {
    const r = normalizeAiRating(it.rating);
    if (r && severity[r] > severity[worst]) worst = r;
  }
  return worst;
}

async function judgeBatchByStandardsWithAI(persons, standards) {
  if (!deepseek.isConfigured()) {
    throw new Error('DEEPSEEK_API_KEY 未配置');
  }
  if (!persons || persons.length === 0) return [];

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(persons, standards);

  const content = await deepseek.chatCompletions([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], { temperature: 0.05, maxTokens: 8192, timeoutMs: 180000 });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('DeepSeek 返回不是有效 JSON');
    parsed = JSON.parse(jsonMatch[0]);
  }

  const results = Array.isArray(parsed.results) ? parsed.results : (Array.isArray(parsed) ? parsed : []);
  const byKey = new Map();
  for (const r of results) {
    const key = `${r.id_card || ''}|${r.name || ''}`;
    byKey.set(key, r);
  }

  return persons.map((p) => {
    const key = `${p.id_card || ''}|${p.name || ''}`;
    const r = byKey.get(key) || {};
    const abnormalItems = Array.isArray(r.matchedAbnormalItems) ? r.matchedAbnormalItems : [];
    const missingItems = Array.isArray(r.matchedMissingItems) ? r.matchedMissingItems : [];
    const allMatched = [...abnormalItems, ...missingItems];

    let overall = normalizeAiRating(r.overall);
    if (!overall) overall = pickWorstRating(allMatched) || '合格';

    let riskText = (r.riskText || '').trim();
    if (!riskText && allMatched.length) {
      riskText = allMatched
        .filter((it) => it.risk)
        .map((it) => `${it.name}：${it.risk}`)
        .join('\n');
    }

    return {
      id_card: p.id_card,
      name: p.name,
      overall,
      matchedAbnormalItems: abnormalItems,
      matchedMissingItems: missingItems,
      matchedItems: allMatched,
      riskText
    };
  });
}

module.exports = {
  judgeByStandards,
  judgeBatchByStandardsWithAI,
  parseAbnormalText,
  parseStandardItemName,
  nameMatches,
  conditionMatches,
  matchByText,
  normalizeRating,
  ratingOfStandard,
  splitLines,
  stripLineNumbers,
  extractNumbers,
  extractKeywords,
  numericOk,
  RATING_SEVERITY,
  parseRange,
  compareValue,
  judgeItem,
  rankOverall,
};
