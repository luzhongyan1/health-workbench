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

// 关键词匹配中的"泛化词"——这些词单独命中不能作为匹配依据
// 防止 "ST异常" 通过关键词"异常"误命中 "非特异性ST波异常" 这类不同项目
const GENERIC_KEYWORDS = new Set([
  '异常', '改变', '偏高', '偏低', '增高', '降低', '阳性', '阴性',
  '以上', '以下', '未检', '增大', '减小', '建议', '复查',
]);

// 分类名——作为关键词时不能参与匹配（"心电图：频发性室性早搏" 不应因含"心电图"
// 而命中 "有心肌梗塞字样心电图"）；裸分类名（单独一行"心电图"）也不作为测试项
const CATEGORY_KEYWORDS = new Set([
  '心电图', '血常规', '尿常规', '肝功能', '血压', '胸透', '胸片',
  'B超', '彩超', '体检', '检查',
]);
const KEYWORD_BLACKLIST = new Set([...GENERIC_KEYWORDS, ...CATEGORY_KEYWORDS]);

const BARE_CATEGORY_RE = /^(心电图|血常规|尿常规|肝功能|血压|B超|彩超|胸片|体检|体检报告)$/;

// 严重程度词权重（用于 "中度及以上" 这类分级标准）
const SEVERITY_WEIGHT = { '轻度': 1, '中度': 2, '重度': 3 };

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

  // 【性别双阈值】"血红蛋白男性低于90g/L、女性低于80g/L" → 主阈值(男) + femaleValue(女)
  //   必须先于通用"低于N"解析执行，否则只会抓到男性阈值
  const maleM = core.match(/男性[^0-9]*低于\s*(\d+(?:\.\d+)?)/);
  const femaleM = core.match(/女性[^0-9]*低于\s*(\d+(?:\.\d+)?)/);
  if (maleM && femaleM) {
    condition = { type: 'lte', value: parseFloat(maleM[1]), femaleValue: parseFloat(femaleM[1]) };
    core = core.replace(/男性[\s\S]*$/, '').trim();
  }

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

  // 格式1: [名称] [偏高/偏低] [数值] [单位] [↑/↓]（单位含上标字符如 kg/m²、10⁹）
  const m1 = cleaned.match(/^(.+?)\s*(?:偏高|偏低|增高|降低|异常|阳性|阴性)?\s*(\d+(?:\.\d+)?)\s*([A-Za-z/%^①-⑳\d²³¹⁰⁴⁵⁶⁷⁸⁹·μ°]+)?\s*[↑↓]?\s*$/);
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

    // 关键词匹配：两侧关键词均需长度>=2 且不在黑名单（泛化词/分类名）中
    const testKws = extractKeywords(testName);
    const stdKws = extractKeywords(sn);
    let kwHit = false;
    for (const k of testKws) {
      if (k.length < 2 || KEYWORD_BLACKLIST.has(k)) continue;
      for (const sk of stdKws) {
        if (sk.length < 2 || KEYWORD_BLACKLIST.has(sk)) continue;
        if (sk.includes(k) || k.includes(sk)) { kwHit = true; break; }
      }
      if (kwHit) break;
    }
    if (kwHit) {
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
function conditionMatches(testItem, condition, gender) {
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
    case 'lte': {
      // 性别双阈值（如 血红蛋白 男性低于90、女性低于80）
      const limit = (condition.femaleValue != null && gender === 'female')
        ? condition.femaleValue
        : condition.value;
      return numVal <= limit;
    }
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
// 辅助：性别 / 分级门槛
// =============================================================

// 从身份证号第 17 位推断性别（奇数=男，偶数=女）
function deriveGender(idCard) {
  if (!idCard) return null;
  const s = idCard.toString().replace(/\s/g, '');
  if (!/^\d{17}[\dXx]?$/.test(s)) return null;
  const d = parseInt(s[16], 10);
  if (Number.isNaN(d)) return null;
  return d % 2 === 1 ? 'male' : 'female';
}

// 标准条目的性别限定：'female' / 'male' / 'both'(男女都提到) / null(无性别限定)
function standardGenderScope(itemName) {
  const hasF = /女性/.test(itemName);
  const hasM = /男性/.test(itemName);
  if (hasF && hasM) return 'both';
  if (hasF) return 'female';
  if (hasM) return 'male';
  return null;
}

// 解析 "中度及以上" 这类分级门槛；数值阈值从描述行提取（如 "中度一般在10-15mm" → 10）
function buildSeverityGate(primaryLine, fullItemName) {
  const m = (primaryLine || '').match(/(轻度|中度|重度)\s*(及以上|以上)/);
  if (!m) return null;
  const minSev = SEVERITY_WEIGHT[m[1]];
  let numTh = null;
  try {
    const nm = fullItemName.match(new RegExp(m[1] + '[^0-9]{0,10}(\\d+(?:\\.\\d+)?)'));
    if (nm) numTh = parseFloat(nm[1]);
  } catch (e) { /* 忽略 */ }
  return { word: m[1], minSev, numTh };
}

// 命中行是否满足分级门槛：需含相应严重度词，或数值达到描述行给出的阈值
function severityOk(sevGate, lineText) {
  if (!sevGate) return true;
  const t = (lineText || '').toString();
  if (/重度/.test(t)) return 3 >= sevGate.minSev;
  if (/中度/.test(t)) return 2 >= sevGate.minSev;
  if (/轻度/.test(t)) return 1 >= sevGate.minSev;
  if (sevGate.numTh != null) {
    const nums = (t.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.some(n => n >= sevGate.numTh)) return true;
  }
  return false;
}

// =============================================================
// 核心：按体检标准判定（本地规则引擎）
// =============================================================
function judgeByStandards(abnormalText, missingText, standards, options) {
  const result = {
    overall: '合格',
    abnormalItems: [],
    missingItems: [],
    riskText: '',
    hits: [],
    itemDetails: [],
  };

  if (!standards || standards.length === 0) return result;

  const gender = (options && options.gender) || null;

  const fullAbnormalText = (abnormalText || '').toString();
  const fullMissingText = (missingText || '').toString();

  // 规则 A：未到检 / 未参检 直接判定（最低优先级档）
  const notAttendedRegex = /^\s*(未到检|未参检|未参加体检|未体检)\s*$/;
  if (notAttendedRegex.test(fullAbnormalText) || notAttendedRegex.test(fullMissingText)) {
    result.overall = '未参检';
    return result;
  }
  // 注：不再因「未见明显异常」提前返回合格——仍需按标准核对缺项
  //（例如"女性胸透未检"在缺项列时应判红灯），未命中任何标准时结果自然为合格。

  // 解析异常文本和缺项文本为结构化测试项
  const testItems = parseAbnormalText(abnormalText);
  const missingItemsParsed = parseAbnormalText(missingText);

  // 【合格项保护】评级为"合格"的标准条目（如"心电图：ST异常"）——
  //   与之完全同名的测试项不再参与其他标准的匹配，
  //   防止"ST异常"通过关键词"异常"误命中"非特异性ST波异常"(复查)等条目
  const passPhrases = new Set();
  for (const std of standards) {
    if (ratingOfStandard(std) !== '合格') continue;
    const p = parseStandardItemName(std.item_name || '');
    for (const tn of p.testNames) {
      if (tn && tn.length >= 2) passPhrases.add(tn);
    }
  }
  const isProtectedPassItem = (testName) => {
    const n = (testName || '').trim();
    if (!n) return false;
    for (const p of passPhrases) {
      if (n === p || n.endsWith('：' + p) || n.endsWith(':' + p)) return true;
    }
    return false;
  };

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

    // 【性别限定】标准写明"女性…"/"男性…"（单性别）且已从身份证判断出性别时，
    //   只对相应性别生效——男性缺胸透不能命中"女性胸透未检"(红灯)
    const scope = standardGenderScope(itemName);
    if (scope && scope !== 'both' && gender && gender !== scope) continue;

    // 【多行标准】只解析首行的名称与数值条件；其余行（如"描述：胰腺壁增厚…"）
    //   不参与条件解析（避免"10-15mm"这类描述数字被误认为判定阈值），转作补充匹配短语
    const lines = itemName.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const primaryLine = lines[0] || itemName;
    const parsed = parseStandardItemName(primaryLine);

    // 补充匹配短语：描述行按 、，,；; 拆分（≥4 字），以及 "有X字样" 提取（如 心肌梗塞）
    const descPhrases = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].replace(/^描述[：:]\s*/, '').trim();
      if (!l) continue;
      for (const p of l.split(/[、，,；;]/)) {
        const t = p.trim();
        if (t.length >= 4) descPhrases.push(t);
      }
    }
    const ziYang = primaryLine.match(/有(.{2,10}?)字样/);
    if (ziYang) descPhrases.push(ziYang[1]);

    // 【分级门槛】"中度及以上"类标准：命中行需含相应严重度词或数值达标
    const sevGate = buildSeverityGate(primaryLine, itemName);

    let matchedItem = null;
    let source = null;

    // 1. 在异常测试项中匹配
    const isHeartRateStd = parsed.testNames.some(n => n === '心率' || n === 'HR');
    for (const ti of testItems) {
      // 裸分类名（如单独一行"心电图"）不是测试项，跳过
      if (ti.value == null && BARE_CATEGORY_RE.test((ti.name || '').trim())) continue;
      if (isProtectedPassItem(ti.name)) continue;
      // 内科常规检查的心率不是心电图心率，不纳入考核
      if (isHeartRateStd && (ti.category || '').includes('内科') && (ti.name || '').includes('心率')) {
        continue;
      }
      if (nameMatches(ti.name, parsed.testNames, parsed.original)
          && conditionMatches(ti, parsed.condition, gender)
          && severityOk(sevGate, ti.rawLine || ti.raw || '')) {
        matchedItem = ti;
        source = 'abnormal';
        break;
      }
    }

    // 2. 在缺项中匹配（如"女性胸透未检"/"男性胸透未检"）
    if (!matchedItem) {
      for (const mi of missingItemsParsed) {
        if (nameMatches(mi.name, parsed.testNames, parsed.original)) {
          matchedItem = mi;
          source = 'missing';
          break;
        }
      }
    }

    // 3. 回退到全文本包含匹配（标准名 + 描述短语），处理解析不出来的情况
    if (!matchedItem) {
      const phrases = [...parsed.testNames.filter(Boolean), ...descPhrases];
      for (const ph of phrases) {
        if (!ph || ph.length < 2) continue;
        const inAbnormal = fullAbnormalText.includes(ph);
        const inMissing = fullMissingText.includes(ph);
        if (!inAbnormal && !inMissing) continue;
        const container = inAbnormal ? fullAbnormalText : fullMissingText;
        if (!parsed.condition || textContainsMatchingNumber(container, parsed.condition, parsed.testNames, gender)) {
          const hitLine = container.split(/\r?\n/).find(ln => ln.includes(ph)) || '';
          if (severityOk(sevGate, hitLine)) {
            matchedItem = { name: ph, value: null, raw: ph };
            source = (inMissing && !inAbnormal) ? 'missing' : 'abnormal';
            break;
          }
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
//   - 名称变体扩展：体重指数 ↔ BMI 等术语别名
//   - 只取名称后第一个数字作为检测值（单位里的数字如 10^9/L 的 10 不算）
//   - 支持性别双阈值（血红蛋白 男90/女80）
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textContainsMatchingNumber(text, condition, testNames, gender) {
  if (!condition) return true;
  const variants = new Set();
  for (const tn of testNames) {
    if (!tn) continue;
    variants.add(tn);
    for (const g of TERM_ALIASES) {
      const hit = g.aliases.some(a => tn.includes(a)) || tn.includes(g.canonical);
      if (hit) {
        variants.add(g.canonical);
        g.aliases.forEach(a => variants.add(a));
      }
    }
  }
  const lines = text.toString().split(/\r?\n/);
  for (const line of lines) {
    for (const v of variants) {
      const re = new RegExp(escapeRegExp(v) + '[^0-9]{0,8}(\\d+(?:\\.\\d+)?)');
      const m = line.match(re);
      if (!m) continue;
      const n = parseFloat(m[1]);
      switch (condition.type) {
        case 'range': if (n >= condition.min && n <= condition.max) return true; break;
        case 'gte': if (n >= condition.value) return true; break;
        case 'lte': {
          const limit = (condition.femaleValue != null && gender === 'female')
            ? condition.femaleValue : condition.value;
          if (n <= limit) return true; break;
        }
        case 'urine': break; // 尿常规在文本匹配中跳过
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
  deriveGender,
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
