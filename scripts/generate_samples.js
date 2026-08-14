const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function writeRecruiter() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('预约名单');
  ws.addRow(['姓名','身份证号','手机号','岗位','部门','预计入职日期']);
  ws.addRow(['张三','110101199001011234','13800000001','工程师','技术部','2026-09-01']);
  ws.addRow(['李四','110101199202022345','13800000002','产品','产品部','2026-09-15']);
  const p = path.join(__dirname, '..', 'samples', 'recruiter_template.xlsx');
  await wb.xlsx.writeFile(p);
  console.log('Wrote', p);
}

async function writeStandards() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('标准');
  ws.addRow(['标准名称','体检项目','单位','合格范围','红灯阈值','复查阈值','风险话术']);
  ws.addRow(['默认标准','血压','mmHg','90-140','180','150','血压过高，请复查']);
  ws.addRow(['默认标准','血糖','mmol/L','3.9-6.1','11.1','7.0','血糖异常，请复查']);
  const p = path.join(__dirname, '..', 'samples', 'standards_template.xlsx');
  await wb.xlsx.writeFile(p);
  console.log('Wrote', p);
}

async function writeResults() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('本次结果');
  // Header: Name, ID, Item1, Value1, Item2, Value2 ...
  ws.addRow(['姓名','身份证号','血压','血压值','血糖','血糖值']);
  ws.addRow(['张三','110101199001011234','血压','185','血糖','5.8']);
  ws.addRow(['李四','110101199202022345','血压','130','血糖','7.5']);
  const p = path.join(__dirname, '..', 'samples', 'results_template.xlsx');
  await wb.xlsx.writeFile(p);
  console.log('Wrote', p);
}

async function writeHistory() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('历史体检');
  ws.addRow(['姓名','身份证号','手机号','岗位','部门','体检日期','体检机构','体检结论']);
  ws.addRow(['王五','110101198803033456','13800000003','销售','销售部','2026-06-01','机构A','pass']);
  ws.addRow(['赵六','110101199403044567','13800000004','运营','运营部','2026-05-10','机构B','pass']);
  const p = path.join(__dirname, '..', 'samples', 'history_template.xlsx');
  await wb.xlsx.writeFile(p);
  console.log('Wrote', p);
}

async function main() {
  try {
    if (!fs.existsSync(path.join(__dirname, '..', 'samples'))) fs.mkdirSync(path.join(__dirname, '..', 'samples'));
    await writeRecruiter();
    await writeStandards();
    await writeResults();
    await writeHistory();
    console.log('All sample files generated in /samples');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
