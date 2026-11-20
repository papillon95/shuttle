// macOS 打包后、做 dmg 之前，给整个 App 补一个完整的 ad-hoc 签名（不需要苹果开发者账号）。
// 不签的话，Apple 芯片的 Mac 从网上下载后会提示「已损坏，无法打开」，而且没有「仍要打开」的选项；
// 签了以后提示的是「无法验证开发者」，用户可以在「系统设置 → 隐私与安全性」里点「仍要打开」。
// 以后有了开发者证书，换成正式签名 + 公证即可去掉这个钩子。
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log('  • ad-hoc signed', app);
};
