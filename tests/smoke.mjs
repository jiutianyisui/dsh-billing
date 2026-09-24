/**
 * dsh-billing 浏览器半的离线冒烟测试：不联网、不开浏览器，直接模拟 DSH 的模块表装载契约
 * （window.__ModuleLoader__.load({ id, factory })），把浏览器半求值出来，
 * 再用假投影 + 假 React 渲染一次，断言「落在哪个槽位」「显示成什么文本」「金额对不对」。
 *
 * 基准：价格 = src/client.js 里的 PRICES（当前：命中 0.02 / 未命中 1 / 输出 4 元每百万 token）
 *       格式 = ￥余额/总花费/每步（余额取不到时省略第一格），例如 ￥110.00/3.40/0.034
 *
 * 运行：  node tests\smoke.mjs        （本机沙箱下 node --test 会 spawn EPERM，所以直接跑）
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// ---- 1. 装载：模拟 __ModuleLoader__ 的 queue 模式 -----------------------------
let registration
const sandbox = { window: { __ModuleLoader__: { load: (row) => { registration = row } } }, console }
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

assert.equal(registration.id, 'dsh-billing', '注册的 id 必须是包名（= 插件图行 id）')
assert.equal(typeof registration.factory, 'function', 'factory 必须是函数')

// ---- 2. 模块表：只需要 react ------------------------------------------------
// 组件里会调 useState / useEffect（轮询余额）。测试里让它们退化成"永远停在初始值"，
// 于是渲染结果只取决于投影 —— 余额那一格交给下面直接测 formatCost。
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const exports = registration.factory((spec) => {
  assert.equal(spec, 'react', `浏览器半只应 require('react')，实际要求了 ${spec}`)
  return fakeReact
})

// 注意：vm 里造出来的数组与宿主 realm 的 Array 不同源，deepStrictEqual 会因原型不同而失败
assert.equal(exports.inject.join(','), 'slots', '客户端插件只依赖 slots 服务')
const internals = exports.__internals
assert.equal(typeof internals.formatCost, 'function', '要导出可单独测试的金额格式化函数')

// ---- 3. 装载插件体：假的 ctx.slots ------------------------------------------
let registered
const ctx = {
  slots: {
    inject: (key, register) => {
      assert.equal(key, 'conversation.input.right', '落点必须是合成器工具行里、模型选择器左边那一格')
      register()
    },
    register: (options, owner) => { registered = { options, owner } },
  },
}
exports.apply(ctx)
assert.equal(registered.options.name, 'conversation.input.right')
assert.equal(registered.options.id, 'billing')
const component = registered.owner
assert.equal(typeof component, 'function', 'apply 必须注册一个组件')

/** 用给定投影值渲染一次，取回元素树。 */
function renderTree(projections) {
  return component({ useProjection: (key) => projections[key], sessionId: 's1' })
}

/** 同上，但只取回显示文本（null 表示这个会话不显示）。 */
function render(projections) {
  const tree = renderTree(projections)
  return tree === null ? null : tree.children[0]
}

// ---- 4. 金额与格式（价格：miss 1 / hit 0.02 / out 4 元每百万 token） ----------
// 100 万未命中输入 = ¥1 + 2000 万命中输入 = ¥0.4 + 50 万输出 = ¥2  →  ¥3.40
const usage = {
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 20_000_000,
  cacheWriteTokens: 0,
  outputTokens: 500_000,
}
const selection = { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, next: null }

// 组件渲染（余额尚未取到 → 只剩两格）
assert.equal(
  render({ tokenUsage: usage, sessionStats: { steps: 100 }, modelSelection: selection }),
  '￥3.40/0.034',
  '100 步时的「总花费/每步」格式',
)
assert.equal(
  render({ tokenUsage: usage, sessionStats: { steps: 0 }, modelSelection: selection }),
  '￥3.40',
  '没有步数时只显示总花费，不写斜杠',
)
assert.equal(
  render({ tokenUsage: null, sessionStats: { steps: 3 }, modelSelection: selection }),
  null,
  '没有计费 token 时不显示',
)

// 三格格式（余额 + 总花费 + 每步）
assert.equal(internals.formatCost(3.4, 0.034, 110, 'CNY'), '￥110.00/3.40/0.034', '余额在第一位')
assert.equal(internals.formatCost(3.4, 0.034, 110, undefined), '￥110.00/3.40/0.034', '没有币种信息时按 ￥')
assert.equal(internals.formatCost(3.4, 0.034, 110, 'USD'), '$110.00/3.40/0.034', '美元用 $')
assert.equal(internals.formatCost(3.4, 0.034, 110, 'EUR'), 'EUR 110.00/3.40/0.034', '认不出的币种带币种码')
assert.equal(internals.formatCost(3.4, null, 110, 'CNY'), '￥110.00/3.40', '没有步数时省掉最后一格')
assert.equal(internals.formatCost(3.4, 0.034, 0, 'CNY'), '￥0.00/3.40/0.034', '余额为 0 也要显示')
assert.equal(internals.formatCost(3.4, 0.034, null, 'CNY'), '￥3.40/0.034', '余额取不到就只显示后两格')

// 金额刻度：大钱两位、小钱多给几位，别把 0.004￥ 显示成 0.00￥
assert.equal(internals.money(3.4), '3.40')
assert.equal(internals.money(0.034), '0.034')
assert.equal(internals.money(0.0004), '0.0004')
assert.equal(internals.money2(110), '110.00', '余额固定两位小数')

// 缓存命中比未命中便宜 50 倍：同样的 token 数，全部命中必然便宜得多
assert.equal(
  render({
    tokenUsage: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    sessionStats: { steps: 1 },
    modelSelection: selection,
  }),
  '￥1.00/1.00',
)
assert.equal(
  render({
    tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 },
    sessionStats: { steps: 1 },
    modelSelection: selection,
  }),
  '￥0.020/0.020',
)

// 缓存写入按未命中计价
assert.equal(
  render({
    tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0 },
    sessionStats: { steps: 1 },
    modelSelection: selection,
  }),
  '￥1.00/1.00',
)

// 未知模型 / 没有 modelSelection 时走 default 价，不抛错
assert.equal(
  render({ tokenUsage: usage, sessionStats: { steps: 100 }, modelSelection: undefined }),
  '￥3.40/0.034',
)
assert.equal(
  render({
    tokenUsage: usage,
    sessionStats: { steps: 100 },
    modelSelection: { lastUsed: { provider: 'x', model: 'unknown-model' }, next: null },
  }),
  '￥3.40/0.034',
)

// 真实计费里最小的一步（100 输出 token）也不能被显示成 0
assert.equal(
  render({
    tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
    sessionStats: { steps: 1 },
    modelSelection: selection,
  }),
  '￥0.0004/0.0004',
)

// 破损投影（负数 / 缺字段 / 非数字）不产生 NaN
assert.equal(
  render({
    tokenUsage: { uncachedInputTokens: -5, cacheReadTokens: 'x', outputTokens: 1_000_000 },
    sessionStats: { steps: 2 },
    modelSelection: selection,
  }),
  '￥4.00/2.00',
)

// 本会话真实量级（2026-09-16 实测 projcache）：15.86M 缓存读 + 158.6k 未命中 + 110.2k 输出 / 101 步
// = 0.1586 + 0.3128 + 0.4406 = ¥0.912（空闲价）
assert.equal(
  render({
    tokenUsage: {
      uncachedInputTokens: 158_586,
      cacheReadTokens: 15_640_832,
      cacheWriteTokens: 0,
      outputTokens: 110_154,
    },
    sessionStats: { steps: 101 },
    modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }, next: null },
  }),
  '￥0.912/0.0090',
)

// ---- 5. 版式与提示 ------------------------------------------------------------
// 它必须是工具行里的一个「行内贴片」：宽度与间距全交给那一行的 flex + gap；
// 不许自己撑满整行，更不许用负外边距去叠别人（2026-09-16 就这么盖住了「缓存命中 xx%」）。
const tree = renderTree({ tokenUsage: usage, sessionStats: { steps: 100 }, modelSelection: selection })
assert.equal(tree.type, 'span', '行内元素（span），不是整行的 div')
assert.equal(tree.props.style.width, undefined, '不得自己撑满整行')
assert.equal(tree.props.style.maxWidth, undefined, '不得自己定宽度上限')
assert.equal(tree.props.style.marginTop, undefined, '不得用负外边距叠到别人身上')
assert.equal(tree.props.style.whiteSpace, 'nowrap', '不许换行')
assert.equal(tree.props.style.fontSize, '13px', '字号与旁边的模型选择器一致')
assert.equal(tree.props.style.lineHeight, '20px', '行高与旁边的模型选择器一致')
assert.equal(tree.props.style.fontVariantNumeric, 'tabular-nums', '数字等宽，数值跳动时不抖')
assert.match(tree.props.style.color, /label-tertiary/, '用次级文字色，不与模型名抢眼')
assert.ok(tree.props.title.includes('总花费'), '悬停要说清哪个数是总花费')
assert.ok(tree.props.title.includes('每步'), '悬停要说清哪个数是每步')
assert.ok(tree.props.title.includes('账户余额'), '悬停要说清第一个数是账户余额')
assert.ok(tree.props.title.includes('deepseek-flash'), '悬停要交代按哪个模型的单价算')

// 悬停提示在余额取不到时要说清原因
const hint = internals.hoverHint(3.4, 0.034, null, undefined, { ok: false, reason: 'no-credential' }, 'deepseek-flash', {
  miss: 1, hit: 0.02, out: 4,
})
assert.ok(hint.includes('no-credential'), '余额取不到时要说明原因')

console.log('dsh-billing smoke: all checks passed')
