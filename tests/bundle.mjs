// 等价复现 DSH 的 bundlePatchFiles 校验 + 组合包完整性检查
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))

let failed = false
const fail = (m) => { console.log('FAIL: ' + m); failed = true }
const pass = (m) => console.log('PASS: ' + m)

// 1) dsh.bundle 必须存在 —— 这正是 "declares no dsh.bundle" 报错的来源
const bundle = manifest.dsh?.bundle
if (bundle === undefined) fail('未声明 dsh.bundle（安装会报 declares no dsh.bundle）')
else pass('声明了 dsh.bundle')

// 2) 精确复现 bundlePatchFiles 的类型校验
if (bundle !== undefined) {
  const declared = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
  if (!Array.isArray(declared) || !declared.every((f) => typeof f === 'string')) {
    fail('dsh.bundle.patch must be a file path or a list of file paths')
  } else {
    pass('dsh.bundle.patch 类型合法，共 ' + declared.length + ' 个文件')
    for (const f of declared) {
      const abs = path.resolve(dir, f)
      if (fs.existsSync(abs)) pass('  patch 文件存在: ' + f)
      else fail('  patch 文件缺失: ' + f)
    }
  }
}

// 3) exports 必须导出 patch 文件（官方 bundle 都这么做）
const ex = manifest.exports ?? {}
if (ex['./cordis.patch.yml'] === undefined) console.log('WARN: exports 未导出 ./cordis.patch.yml')
else pass('exports 导出了 ./cordis.patch.yml')

// 4) UI 插件必需的 client 面
if (ex['./client'] === undefined) fail('缺 ./client 导出')
else pass('有 ./client 导出')
if (manifest.dsh?.client?.platform === undefined) fail('缺 dsh.client.platform')
else pass('dsh.client.platform = ' + manifest.dsh.client.platform)

// 5) 主入口存在
const main = path.resolve(dir, manifest.main ?? '')
if (!fs.existsSync(main)) fail('main 入口缺失: ' + manifest.main)
else pass('main 入口存在: ' + manifest.main)

// 6) 有 peerDependencies 时才会触发兼容性检查；确认我们没有误声明
const peers = manifest.peerDependencies
if (peers === undefined) pass('未声明 peerDependencies（evaluatePluginCompatibility 直接放行）')
else console.log('NOTE: 声明了 peerDependencies，会触发版本兼容性检查: ' + JSON.stringify(peers))

// 7) files[] 里列的文件必须真实存在（当初 cordis.patch.yml 就缺过）
for (const f of manifest.files ?? []) {
  if (f.includes('*')) continue
  if (!fs.existsSync(path.resolve(dir, f))) fail('files[] 列了不存在的文件: ' + f)
}
pass('files[] 列出的文件都存在')

console.log('')
console.log(failed ? '=== 结果：有问题 ===' : '=== 结果：组合包声明完整 ===')
process.exit(failed ? 1 : 0)
