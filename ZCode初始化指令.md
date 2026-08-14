# ZCode 初始化指令 — 员工入职体检管理平台

请复制以下内容，在 ZCode 面板发送：

---

请帮我搭建一个**员工入职体检管理平台**，前后端一体（Node.js + Express），数据库用 PostgreSQL，前端用 EJS 模板引擎，简洁后台管理风格。

## 项目概述

这是一个 SSC（共享服务中心）使用的体检管理线上化平台，核心解决：人工查重繁琐、体检结果靠邮件传递易遗漏、风险判断靠人眼比对标准表工作量大等问题。

## 涉及角色

| 角色 | 核心操作 | 系统入口 |
|------|---------|---------|
| 招聘 | 导入待参培名单，接收体检结果推送 | Web后台 |
| 培训师 | 更新参培情况，接收体检结果推送 | Web后台 |
| SSC | 查重（系统自动）、审核AI判断结果、发布最终体检结论、跟进复查 | SSC后台模块 |
| 体检供应商 | （外部）回传体检结果表 | 公邮/文件上传 |
| 系统(AI) | 自动查重、匹配标准、输出建议结论 | 后台引擎 |

## 一期（P0）功能模块

### 1. 名单同步与查重（自动）
- SSC或招聘在系统中导入待参培人员名单（Excel上传：姓名、身份证号、手机号、岗位、部门、预计入职日期）
- 系统自动与体检台账比对：身份证号 + 体检日期，判断3个月内（90个自然日）是否已有体检记录
- 有记录且结论为"通过" → 自动标注"免检"，推送通知
- 无记录或超期 → 生成"需体检名单"，推送到SSC工作台
- 复查中/红灯/人工判定记录不自动免检，进入SSC人工确认

### 2. 体检预约管理
- SSC后台查看需体检名单
- 一键导出预约表（Excel：姓名、身份证号、手机号、预约日期、体检中心、城市）
- 支持手动上传体检中心回传的结果表（Excel/CSV）
- 按身份证号自动匹配结果到对应人员

### 3. AI体检结果判断引擎
- 输入：体检中心回传的原始表格 + 内部体检标准表（支持页面配置增删改查）
- 体检标准表字段：项目名称、合格范围、红灯阈值、复查阈值、风险话术模板
- 逐条判断每个体检项目：
  - 符合标准 → "合格"
  - 超出红灯阈值 → "红灯-不录用"
  - 超出复查阈值但未达红灯 → "复查-待跟进"
  - 无法识别 → "人工判定"并高亮
- 生成对应风险话术
- 总体结论按最严重项判定
- 判断时间 ≤30秒/1000条

### 4. 审核与发布
- SSC审核界面：列表展示体检人员（含AI结论、原始数值、标准阈值）
- SSC可执行：
  - 接受AI结论 → 点击"一键发布"
  - 修改结论（如红灯→复查）→ 填写修改原因后发布
- 支持批量发布
- 发布后：系统生成结构化结果，推送通知给招聘和培训师
- 所有修改操作记录日志（人、时间、修改前后值）

### 5. 体检台账
- 集中存储所有员工体检记录（含历史导入）
- 支持按姓名/身份证号/日期/结论查询
- 支持历史数据Excel批量导入

### 6. 体检标准表管理
- SSC可在页面配置体检标准（增删改查）
- 字段：项目名称、单位、合格范围、红灯阈值、复查阈值、话术模板
- 支持多套标准（如不同岗位）
- 修改记录留痕

## 数据库设计（参考）

- **employees**（员工/待检人员）：id, name, id_card, phone, position, department, expected_onboard_date, status
- **health_checks**（体检记录）：id, employee_id, check_date, vendor, overall_result(red/recheck/pass), detail_json, source(upload/email), created_at
- **check_items**（体检项目明细）：id, health_check_id, item_name, item_value, unit, ai_result(pass/red/recheck/manual), standard_id
- **standards**（体检标准表）：id, name, item_name, unit, pass_range, red_threshold, recheck_threshold, risk_text, version, is_active
- **audit_logs**（操作日志）：id, user, action, target_type, target_id, old_value, new_value, reason, created_at
- **notifications**（推送消息）：id, recipient_role, 


recipient_id, content, type, is_read, created_at

## 技术要求

- Node.js + Express，前后端一体不拆分
- PostgreSQL 数据库
- EJS 模板引擎渲染页面
- Bootstrap 5 做UI（简洁后台风格）
- Excel 上传/导出用 exceljs 库
- 页面需响应式，支持表格筛选、搜索、分页
- 所有操作记录日志，可追溯

## 请按以下顺序搭建

1. 先创建项目骨架：package.json、app.js入口、目录结构、数据库连接配置
2. 创建数据库迁移脚本（建表）
3. 实现体检标准表管理页面（CRUD）
4. 实现名单导入与自动查重
5. 实现体检结果上传与AI判断引擎
6. 实现SSC审核与发布
7. 实现体检台账查询
8. 实现操作日志和消息推送

先做第1步和第2步，完成后告诉我，我们再逐步推进。
