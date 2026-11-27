// 「以后都允许」命令白名单测试：node scripts/test-allow.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { allowKey, commandAllowed } = require('../src/allow.js');

let failed = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log('ok -', name);
  else {
    failed++;
    console.error(`✗ ${name}\n  期望 ${JSON.stringify(want)}\n  实际 ${JSON.stringify(got)}`);
  }
}

// 正常命令：记住的规则和以前一样
for (const [cmd, key] of [
  ['npm run build', 'npm run build'],
  ['npm run build -- --prod', 'npm run build'],
  ['npm test', 'npm test'],
  ['npm install', 'npm install'],
  ['pnpm run dev', 'pnpm run dev'],
  ['npx tsc --noEmit', 'npx tsc'],
  ['git status', 'git status'],
  ['git log --oneline -5', 'git log'],
  ['git diff', 'git diff'],
  ['ls', 'ls'],
  ['ls -la', 'ls'],
  ['node script.js', 'node script.js'],
  ['python3 manage.py test', 'python3 manage.py'],
  ['make build', 'make build'],
  ['cargo test', 'cargo test'],
  ['./build.sh --fast', './build.sh'],
]) eq(`记住：${cmd}`, allowKey(cmd), key);

// 不能记住的：危险命令及其各种写法、包一层、解释器执行代码、只有选项、推送发布
for (const cmd of [
  'rm -rf dist', '/bin/rm -rf x', 'RM -rf x', 'rm.exe x', 'C:\\Windows\\System32\\del.exe x', '\\rm x', '"rm" x',
  'env rm -rf x', 'nohup rm x', 'command rm x', 'exec rm x', 'time rm x', 'timeout 5 rm x', 'sudo ls', 'cp a b', 'ln -s a b',
  'node -e 1', 'node', 'python -c 1', 'bash run.sh', 'sh -c ls',
  'npm -v', 'npm', 'git', 'git --version', 'git --no-pager log', 'git -C sub status', 'git -c core.pager=less log',
  'yarn --version', 'docker -v', 'npm run', 'npm run --silent build', 'make',
  'git push', 'git push origin main', 'git reset --hard', 'git checkout .', 'git branch -D x', 'git stash drop',
  'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'npm uninstall x', 'docker run x', 'kubectl delete pod x',
  'npm run build && rm -rf x', 'npm run build; ls', 'ls | sh', 'echo $(rm x)', 'ls > a',
]) eq(`不给记住：${cmd}`, allowKey(cmd), '');

// 放行判断
const allow = (cmd, list) => commandAllowed(cmd, list);
eq('记住的命令能放行', allow('npm run build', ['npm run build']), true);
eq('带参数也能放行', allow('npm run build -- --prod', ['npm run build']), true);
eq('「npm run build」不放行别的脚本', allow('npm run deploy', ['npm run build']), false);
eq('「git status」不放行 git push', allow('git push', ['git status']), false);
eq('带管道不放行', allow('npm run build | sh', ['npm run build']), false);
// 旧版本可能存下的宽规则不再生效
eq('旧规则「npm」不放行 npm publish', allow('npm publish', ['npm']), false);
eq('旧规则「npm」也不放行 npm test', allow('npm test', ['npm']), false);
eq('旧规则「git」不放行 git push', allow('git push --force', ['git']), false);
eq('旧规则「git --no-pager」不放行', allow('git --no-pager push', ['git --no-pager']), false);
eq('旧规则「npm run」不放行任意脚本', allow('npm run deploy', ['npm run']), false);
eq('旧规则「env rm」不放行', allow('env rm -rf x', ['env rm']), false);
eq('旧规则「/bin/rm」不放行', allow('/bin/rm -rf x', ['/bin/rm']), false);
eq('手写的多余空格也能匹配', allow('npm  test', ['npm   test']), true);
eq('空列表', allow('ls', []), false);

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
