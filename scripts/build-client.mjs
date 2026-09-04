// 构建 lib/client.js：把 lib/qr.js（去掉 export 关键字）+ lib/client-src.js
// 打进 window.__ModuleLoader__.load 的 factory 闭包。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const qrRaw = readFileSync(join(root, 'lib', 'qr.js'), 'utf8')
  .replace(/^export\s+/gm, '');
const srcRaw = readFileSync(join(root, 'lib', 'client-src.js'), 'utf8');

const bundle = `// dsh-gb client bundle — rebuilt by scripts/build-client.mjs
window.__ModuleLoader__.load({
  id: 'dsh-gb',
  factory: (require) => {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;
    //#region lib/qr.js (inlined)
${qrRaw}
    //#endregion
    //#region lib/client-src.js
${srcRaw}
    //#endregion
    exports.apply = apply;
    exports.inject = inject;
    exports._qr = { encodeQr: encodeQr, qrSvg: qrSvg };
    return module.exports;
  }
});
`;

writeFileSync(join(root, 'lib', 'client.js'), bundle);
console.log('lib/client.js written (%d bytes)', bundle.length);
