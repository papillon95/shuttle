// electron-builder 的 Windows「签名」钩子（package.json → build.win.signtoolOptions.sign）
//
// 目前没有代码签名证书，这个钩子只做一件事：修正卸载程序的完整性校验值。
//
// 原因：在 macOS 上打 Windows 安装包时，electron-builder 不能运行 NSIS 去生成卸载程序，
// 而是从安装包里把卸载程序的数据“抠”出来拼成 exe（nsisUtil.UninstallerReader），
// 拼出来的文件末尾 CRC32 是错的。用户在 Windows 上卸载时就会弹
// “Installer integrity check has failed”。
// 卸载程序抠出来后 electron-builder 会立刻对它调用签名，所以在这里重新计算 CRC 写回去，
// 之后它才被打进安装包。
//
// NSIS 的校验规则：从第 512 字节开始，到「头部位置 + length_of_all_following_data - 4」为止
// 计算 CRC32，存放在最后 4 个字节。
//
// 以后买了代码签名证书：在这里修完 CRC 之后再调用真正的签名（签名必须在修 CRC 之后）。
const fs = require('fs');
const zlib = require('zlib');

const SIG = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex'); // 0xDEADBEEF + "NullsoftInst"
const FH_FLAGS_UNINSTALL = 1;
const FH_FLAGS_NO_CRC = 4;

function fixNsisCrc(file) {
  const buf = fs.readFileSync(file);
  let pos = -1;
  for (let o = 0; o + 28 <= buf.length; o += 512) {
    if (buf.subarray(o + 4, o + 20).equals(SIG)) {
      pos = o;
      break;
    }
  }
  if (pos < 0) return 'not-nsis';
  const flags = buf.readUInt32LE(pos);
  if (!(flags & FH_FLAGS_UNINSTALL) || flags & FH_FLAGS_NO_CRC) return 'skip';
  const end = pos + buf.readUInt32LE(pos + 24);
  if (end > buf.length || end < 516) throw new Error(`卸载程序长度异常：${file}`);
  const crc = zlib.crc32(buf.subarray(512, end - 4));
  if (buf.readUInt32LE(end - 4) === crc) return 'ok';
  buf.writeUInt32LE(crc, end - 4);
  fs.writeFileSync(file, buf.subarray(0, end));
  return 'fixed';
}

exports.default = async function sign(config) {
  if (!/\.exe$/i.test(config.path)) return;
  const r = fixNsisCrc(config.path);
  if (r === 'fixed') console.log(`  • 已修正卸载程序 CRC  file=${config.path}`);
};
exports.fixNsisCrc = fixNsisCrc;
