const fs = require('fs');
const target = 'X:\\\\VCP\\\\docs\\\\VCPDesktop_NativeFileMoun\\\\方案重构\\\\10_推送反馈设计.md';
const content = fs.readFileSync('E:\\\\vcpchat\\\\_doc_content.txt', 'utf8');
fs.writeFileSync(target, content, 'utf8');
console.log('Written', content.length, 'chars');