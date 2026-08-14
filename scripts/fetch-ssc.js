const http = require('http');
const fs = require('fs');
http.get('http://localhost:3000/ssc', (res) => {
  let d = '';
  res.on('data', (c) => d += c);
  res.on('end', () => {
    fs.writeFileSync('ssc-page.html', d);
    console.log('已保存 ssc-page.html, 长度:', d.length);
  });
});
