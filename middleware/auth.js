module.exports = {
  ensureAuthenticated: (req, res, next) => {
    if (req.session && req.session.user) {
      req.user = req.session.user;
      res.locals.currentUser = req.user;
      return next();
    }
    return res.redirect('/login');
  },

  ensureRole: (...allowedRoles) => (req, res, next) => {
    if (!(req.session && req.session.user)) return res.redirect('/login');
    const role = req.session.user.role;
    // SSC role has global access
    if (role === 'ssc' || allowedRoles.includes(role)) {
      req.user = req.session.user;
      res.locals.currentUser = req.user;
      return next();
    }
    return res.status(403).render('error', { title: '无权限', error: '您没有访问该页面的权限' });
  }
};
