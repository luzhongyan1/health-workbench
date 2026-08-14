# 员工入职体检管理平台

一个面向企业 SSC（共享服务中心）的入职体检全流程管理平台：招聘端提交体检预约名单 → SSC 归档体检结果 → 培训端按部门查询体检结论，支持 AI 体检评级与多角色权限控制。

## ✨ 功能特性

- **RBAC 多角色权限**：SSC 管理 / 招聘人员 / 培训人员 三种角色，页面与数据访问权限隔离
- **招聘端**：Excel 名单导入、历史已预约统计（已剔除免检人员）、SSC 可切换视角查看招聘人员数据
- **SSC 端**：体检结果归档、历史记录、标准规则管理（含 Excel 模板上传下载）
- **培训端**：按部门筛选体检结果，结论下拉限定（红灯/复查/合格-有风险/合格/未参检）
- **AI 体检评级**：接入 DeepSeek 深度思考模型自动评级（未配置 Key 时自动降级为本地规则引擎）
- **全流程留痕**：审计日志（audit_logs）

## 🧰 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js + Express 4 |
| 前端 | EJS 模板 + Bootstrap 5（CDN） |
| 数据库 | PostgreSQL（pg 驱动） |
| 文件 | ExcelJS（Excel 导入导出）、Multer（上传） |
| 测试 | Mocha + Chai + Supertest |
| 进程管理 | PM2（本地） |

## 👥 默认账号（密码均为 `password`）

| 账号 | 角色 | 权限 |
|------|------|------|
| `ssc_admin` | SSC 管理 | 全部功能，可切换视角查看招聘数据 |
| `recruiter1` | 招聘人员A | 仅招聘名单（只能看自己导入的数据） |
| `trainer1` | 培训人员A | 仅培训查询 |

> 另有 `scripts/seed-admin.js` 可创建 `admin / 123456` 管理员账号。

## 🚀 本地启动

前置：已安装 Node.js ≥ 18 与 PostgreSQL。

```bash
# 1. 安装依赖
npm install

# 2. 创建数据库（PostgreSQL 中执行）
CREATE DATABASE health_platform;

# 3. 配置环境变量
copy .env.example .env   # Windows
# cp .env.example .env   # macOS / Linux
# 修改 .env 中的 DB_USER / DB_PASSWORD

# 4. 初始化数据库（自动执行 001~005 迁移 + 种子账号）
npm run db:init

# 5. 启动服务
npm start
```

访问 http://localhost:3000

> 应用启动时会自动执行幂等的 schema 初始化（`db/ensure-schema.js`），确保表结构与种子账号就绪，已有数据不受影响。

## ☁️ 部署到 Zeabur（免费 PaaS，国内可访问）

1. 把本项目推送到 GitHub 仓库（`git push`）
2. 打开 [zeabur.com](https://zeabur.com)，用 GitHub 账号登录（界面有中文）
3. 新建项目 → 添加服务 → **GitHub** → 选择本仓库 → 自动识别 Node.js 并部署
4. 添加 **PostgreSQL** 服务（免费额度内）：
   - 项目内 添加服务 → **Database** → **PostgreSQL**
5. 配置环境变量（服务 → 配置 → 变量）：
   - `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` ← 填 PostgreSQL 服务提供的信息
   - 或直接设置 `DATABASE_URL`（PostgreSQL 服务的连接串）
   - `SESSION_SECRET`：随便填一串随机字符
   - 若连接要求 SSL，额外设置 `DB_SSL=true`
6. 等待部署完成后，在 **域名** 标签绑定免费域名 `xxx.zeabur.app`
7. 打开网址 → 用默认账号登录即可使用

> 应用启动时会自动建表并写入种子账号，部署完成即开箱即用，无需手动执行迁移命令。

## 📁 目录结构

```
├── app.js                 # Express 入口（启动时自动初始化 schema）
├── routes/                # index / recruiter / ssc / standards / training
├── views/                 # EJS 模板（login / error / 各角色页面）
│   └── partials/          # header / footer
├── middleware/auth.js     # 登录拦截 + RBAC 越权
├── services/              # deepseek.js（AI 评级）、healthRating.js（规则引擎）
├── db/
│   ├── config.js          # PostgreSQL 连接池
│   ├── ensure-schema.js   # 启动时自动迁移（001~005 + seeds）
│   ├── migrations/        # 001 基础表 ~ 005 完整 schema
│   └── seeds/seed_users.js# 种子账号
├── public/templates/      # 体检预约模板（下载功能）
├── scripts/               # 运维 / 一次性数据脚本
├── samples/               # 示例模板 xlsx
└── tests/                 # Mocha 测试
```

## 🧪 测试

```bash
npm test
```

## 📝 版本历史

- v1.0.0：项目骨架 + 基础初始化
- v1.1.0：RBAC 权限控制（招聘端数据行级隔离）
- v1.1.1：培训端按部门筛选、体检结果下拉限定
- v1.1.2：SSC 视角切换（view_as）、历史已预约口径修正（剔除免检）
- v1.2.0：可部署化改造（完整迁移链、启动自动初始化、Zeabur 部署支持）
