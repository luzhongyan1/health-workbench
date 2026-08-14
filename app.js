require('dotenv').config();

const express = require('express');
const path = require('path');
const { testConnection } = require('./db/config');
const indexRouter = require('./routes/index');
const standardsRouter = require('./routes/standards');
const recruiterRouter = require('./routes/recruiter');
const sscRouter = require('./routes/ssc');
const trainingRouter = require('./routes/training');
const session = require('express-session');
const { ensureAuthenticated } = require('./middleware/auth');
const { ensureSchema } = require('./db/ensure-schema');
const bcrypt = require('bcrypt');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
}));

// expose current user to templates if present
app.use((req, res, next) => {
  if (req.session && req.session.user) res.locals.currentUser = req.session.user;
  next();
});

// expose one-time flash messages to templates
app.use((req, res, next) => {
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
});

app.locals.appName = '员工入职体检管理平台';
app.use('/', indexRouter);
// 标准规则属于 SSC 管理功能：只允许 SSC（含 admin）访问
app.use('/standards', require('./middleware/auth').ensureRole('ssc'), standardsRouter);
app.use('/recruiter', require('./middleware/auth').ensureRole('recruiter'), recruiterRouter);
app.use('/ssc', require('./middleware/auth').ensureRole('ssc'), sscRouter);
app.use('/training', require('./middleware/auth').ensureRole('trainer'), trainingRouter);

// simple auth routes for demo
app.get('/login', (req, res) => {
  res.render('login', { title: '登录', error: null });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

async function startServer() {
  try {
    await testConnection();
    console.log('Database connection is ready.');
  } catch (error) {
    console.error('Database connection failed:', error.message);
  }

  // 启动时确保表结构与种子账号就绪（幂等：全新库自动建表，已有库空操作）
  try {
    await ensureSchema();
    console.log('Database schema is ready.');
  } catch (error) {
    console.error('Database schema init failed:', error.message);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

// login handler updated to use bcrypt for hashed passwords
app.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
  const { username, password } = req.body;
  try {
    const { pool } = require('./db/config');
    const { rows } = await pool.query('SELECT id, username, password, role FROM users WHERE username=$1 LIMIT 1', [username]);
    if (!rows.length) return res.render('login', { title: '登录', error: '用户名或密码错误' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.render('login', { title: '登录', error: '用户名或密码错误' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    return res.redirect('/');
  } catch (err) {
    return res.render('login', { title: '登录', error: err.message });
  }
});

if (require.main === module) {
  startServer();
}

module.exports = app;
