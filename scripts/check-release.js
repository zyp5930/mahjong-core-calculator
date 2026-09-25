const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
for (const file of walk(root)) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (file.endsWith('.json') && !path.basename(file).startsWith('database_export')) JSON.parse(fs.readFileSync(file, 'utf8'));
}
const app = JSON.parse(read('app.json'));
for (const page of app.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(path.join(root, `${page}.${ext}`)), `${page}.${ext} missing`);
assert.ok(app.pages.includes('pages/legal/legal'));
const config = require('../config/compliance');
assert.ok(config.operatorName && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail));
const project = JSON.parse(read('project.config.json'));
assert.equal(project.setting.urlCheck, true);
assert.ok(project.packOptions.ignore.some((item) => item.type === 'prefix' && item.value === 'database_export'));
for (const name of ['home', 'room']) {
  assert.ok(!/['"]0\.3['"]|例如 0\.3/.test(read(`pages/${name}/${name}.js`) + read(`pages/${name}/${name}.wxml`)));
}
assert.ok(!read('pages/room/room.js').includes('wx.cloud.database'));
assert.ok(!read('cloudfunctions/tableCode/index.js').includes("envVersion: 'trial'"));
for (const f of ['login', 'tableOps', 'tableCode']) assert.notEqual(JSON.parse(read(`cloudfunctions/${f}/package.json`)).dependencies['wx-server-sdk'], 'latest');
console.log('代码发布检查通过：语法、JSON、页面注册、倍率、隐私配置、权限入口与打包排除。');
console.log('未验证：微信后台类目/备案/隐私指引、云端权限、SDK真实部署、内容安全调用和双机扫码。请按 docs/release-checklist.md 完成。');
