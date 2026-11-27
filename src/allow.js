// 「以后都允许」的命令白名单：按命令开头（前一两个词）记住，以后同样开头的命令不再询问。
// 纯函数，不碰 Electron，方便单测（scripts/test-allow.mjs）。
//
// 不提供「以后都允许」的情况：
//   - 带管道、重定向、多条命令、命令替换的
//   - 删除、提权、联网下载、换个 shell 执行这类危险命令（不管是 rm、/bin/rm、rm.exe 还是 \rm 的写法）
//   - 用 env、nohup、time 这类「包一层再执行别的命令」的写法
//   - 解释器直接执行代码（node -e、python -c）
//   - 有子命令的工具（git、npm…）后面没有子命令、只有选项（npm -v、git -C x status）：只能记成「git」「npm」，会放行这个工具的一切操作
//   - 推送、发布、删改历史这类子命令（git push、npm publish…）
// 已经存的规则也按同样的标准检查，旧版本可能存下的「npm」「git」这类宽规则不再生效。

const SHELL_OPS = /[;&|<>`$\n\r]/;
const RISKY_CMDS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'unlink', 'shred', 'trash',
  'sudo', 'su', 'doas', 'runas', 'pkexec',
  'dd', 'mkfs', 'fdisk', 'diskpart', 'diskutil', 'shutdown', 'reboot', 'halt', 'poweroff', 'format',
  'chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'attrib',
  'kill', 'pkill', 'killall', 'taskkill',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat', 'telnet',
  'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy', 'ln',
  'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'cmd', 'wsl', 'osascript',
  'eval', 'source', 'xargs', 'find', 'crontab', 'launchctl', 'systemctl', 'reg', 'schtasks', 'setx',
  // 包一层再执行别的命令：env rm -rf x、nohup rm x……
  'env', 'nohup', 'command', 'exec', 'builtin', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'unbuffer',
  'caffeinate', 'watch', 'script', 'setsid', 'chroot', 'strace', 'dtruss', 'start', 'call',
]);
// 直接执行代码的解释器：带选项（node -e、python -c）或什么都不带（读标准输入）都不提供
const INTERPRETERS = /^(node|nodejs|python[0-9.]*|py|ruby|perl|php|deno|bun|lua|java|osascript|tclsh|Rscript)$/i;
// 有子命令的工具：第二个词必须是子命令
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'uv', 'uvx', 'pip', 'pip3', 'pipx', 'poetry', 'conda',
  'cargo', 'rustup', 'go', 'dotnet', 'mvn', 'gradle', 'composer', 'gem', 'bundle',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'winget', 'choco', 'scoop',
  'gh', 'aws', 'gcloud', 'az', 'pm2', 'flutter', 'dart', 'swift', 'xcodebuild', 'adb', 'make',
]);
// 运行脚本 / 包的子命令：再带上第三个词（脚本名、包名）
const RUNNERS = /^(npm|pnpm|yarn|bun|npx|uv|poetry|cargo|go|dotnet|mvn|gradle)$/i;
const RUN_SUBS = /^(run|exec|x|run-script|dlx)$/;
// 推送、发布、删改历史、改配置这类，按「工具 子命令」整体不给记住
const RISKY_SUBS = /^(git (push|reset|clean|checkout|switch|restore|rebase|rm|mv|branch|tag|stash|remote|config|filter-branch|filter-repo|update-ref|reflog|gc|prune|worktree|submodule|lfs)|(npm|pnpm|yarn|bun) (publish|unpublish|deprecate|owner|access|token|login|adduser|logout|dist-tag|config|cache)|cargo (publish|yank|owner|login)|(mvn|gradle) (deploy|publish)|dotnet nuget|(pip|pip3|pipx|uv|poetry|conda|gem|brew|apt|apt-get|yum|dnf|winget|choco|scoop|rustup|npm|pnpm|yarn|bun|composer) (uninstall|remove|rm|purge|autoremove)|docker (rm|rmi|system|volume|network|run|exec|push|login)|podman (rm|rmi|system|volume|run|exec|push|login)|kubectl (delete|apply|exec|replace|patch|drain|cordon|scale|edit)|helm (uninstall|delete|install|upgrade|rollback)|terraform (apply|destroy|import|state)|gh (release|repo|secret|auth|api|gist|ssh-key|gpg-key)|(aws|gcloud|az) [a-z0-9-]+|adb (shell|uninstall|install|push))$/;

// 命令名：去掉引号、开头的反斜杠（\rm 能绕过别名）、路径和 Windows 扩展名，用来判断危险命令（/bin/rm、RM.EXE 都算 rm）
function baseName(word) {
  return String(word || '')
    .replace(/["']/g, '')
    .replace(/^\\+/, '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
    .toLowerCase();
}

/** 能「以后都允许」的话返回记住的规则（命令开头），不能的话返回 '' */
function allowKey(command) {
  const c = String(command || '').trim();
  if (!c || SHELL_OPS.test(c)) return '';
  const t = c.split(/\s+/);
  const name = baseName(t[0]);
  if (!name || RISKY_CMDS.has(name)) return '';
  if (INTERPRETERS.test(name) && (!t[1] || t[1].startsWith('-'))) return '';
  const sub = SUBCOMMAND_TOOLS.has(name);
  // 有子命令的工具，后面直接跟选项或什么都没有，就只能记成工具名本身，等于放行这个工具的所有操作
  if (sub && (!t[1] || t[1].startsWith('-'))) return '';
  let key = t[0];
  // 第二个词不是选项就带上（脚本名、子命令）；npm run xxx 这类再带上脚本名
  if (t[1] && !t[1].startsWith('-')) key += ' ' + t[1];
  if (RUNNERS.test(name) && RUN_SUBS.test(t[1] || '')) {
    // npm run 后面没有脚本名、或者跟的是选项，记成「npm run」会放行所有脚本
    if (!t[2] || t[2].startsWith('-')) return '';
    key += ' ' + t[2];
  }
  if (RISKY_SUBS.test(name + ' ' + String(t[1] || '').toLowerCase())) return '';
  return key;
}

/** 命令是否被已存的规则放行（按开头逐词匹配）；不安全的规则（本来就不会被记住的）跳过 */
function commandAllowed(command, list) {
  const c = String(command || '').trim();
  if (!c || !list?.length || SHELL_OPS.test(c)) return false;
  // 命令本身拿不到「以后都允许」的（危险命令、包一层的写法……），不管存了什么规则都要问
  if (!allowKey(c)) return false;
  const t = c.split(/\s+/);
  return list.some((k) => {
    const rule = String(k || '').trim().replace(/\s+/g, ' ');
    // 规则本身必须是 allowKey 会给出的样子：「npm」「git」这类宽规则、危险命令的规则都不生效
    if (!rule || allowKey(rule) !== rule) return false;
    const kt = rule.split(' ');
    return kt.every((x, i) => t[i] === x);
  });
}

module.exports = { SHELL_OPS, RISKY_CMDS, allowKey, commandAllowed };
