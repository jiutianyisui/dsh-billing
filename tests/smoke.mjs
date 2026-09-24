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
// 沙箱里放一个**可替换**的 fetch：模块在 vm 上下文里求值，它看到的 fetch 是这个，
// 而测试文件里的 globalThis.fetch 到不了那边。默认实现是「网络不可用」，需要时替换。
let sandboxFetch = async () => { throw new Error('fetch not stubbed') }
const sandbox = {
  window: { __ModuleLoader__: { load: (row) => { registration = row } } },
  console,
  fetch: (...args) => sandboxFetch(...args),
}
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

// ---- 7. 双路余额：桌面端账号服务优先，退回宿主路由 --------------------------
// 起因：本机没有 DEEPSEEK_API_KEY，余额一直取不到；而 DSH 桌面端自带
// ctx.remote.account.getBalance()（账号登录态），不需要 API key。所以做成双路。
{
  const nb = internals.normalizeAccountBalance

  // --- 账号服务返回值的归一化 ---
  const cny = nb({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '110.00' }], bonusWallets: [] } })
  assert.equal(cny.ok, true, '账号服务：ok')
  assert.equal(cny.currency, 'CNY', '账号服务：币种')
  assert.equal(cny.total, 110, '账号服务：CNY 余额是数字 110')
  assert.equal(cny.granted, 0, '账号服务：没有赠金时 granted 为 0')
  assert.equal(cny.source, 'account', '账号服务：来源标记')
  // balance 是字符串，必须转成数字（保留精度是上游的要求）
  const usd = nb({ ok: true, value: { status: 'ready', value: [{ currency: 'USD', balance: '15.50' }], bonusWallets: [] } })
  assert.equal(usd.total, 15.5)
  assert.equal(usd.currency, 'USD')
  // 没有 CNY 时用第一条
  assert.equal(
    nb({ ok: true, value: { status: 'ready', value: [{ currency: 'USD', balance: '1' }], bonusWallets: [] } }).currency,
    'USD',
    '没有 CNY 就用第一条钱包',
  )
  // 赠金余额累加
  assert.equal(
    nb({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '10' }], bonusWallets: [{ currency: 'CNY', balance: '2.5' }, { currency: 'USD', balance: '3' }] } }).granted,
    5.5,
    '赠金余额累加成 granted',
  )
  // 失败/未登录/空钱包
  assert.equal(nb(null).ok, false, '账号服务返回 null -> 不 ok')
  assert.equal(nb(null).reason, 'account-null')
  assert.equal(nb({ ok: false }).reason, 'account-rpc-failed', 'RPC 失败')
  assert.equal(nb({ ok: true, value: null }).reason, 'account-signed-out', '未登录')
  assert.equal(nb({ ok: true, value: { status: 'failed' } }).reason, 'account-failed', '账号服务报 failed')
  assert.equal(
    nb({ ok: true, value: { status: 'ready', value: [], bonusWallets: [] } }).reason,
    'account-no-wallet',
    '没有钱包',
  )
  assert.equal(
    nb({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: 'abc' }], bonusWallets: [] } }).reason,
    'account-no-balance-field',
    '余额不是数字',
  )

  // --- lookupAccountService：可选读取，缺失时不抛 ---
  assert.equal(internals.lookupAccountService(undefined), undefined, '没有 ctx -> undefined')
  assert.equal(internals.lookupAccountService({}), undefined, 'ctx 没有 get -> undefined')
  assert.equal(
    internals.lookupAccountService({ get: () => { throw new Error('missing') } }),
    undefined,
    'ctx.get 抛错也要安静地返回 undefined（web 端就是这条）',
  )
  const fakeService = { getBalance: async () => ({ ok: true }) }
  assert.equal(
    internals.lookupAccountService({ get: (n) => (n === 'remote.account' ? fakeService : undefined) }),
    fakeService,
    "ctx.get('remote.account') 能拿到服务",
  )

  // --- readBalance：优先级与兜底 ---
  const savedFetch = sandboxFetch
  try {
    // 路 1 成功：不该去 fetch
    let fetchCount = 0
    sandboxFetch = async () => { fetchCount += 1; throw new Error('不该走这条') }
    const viaAccount = await internals.readBalance({
      get: () => ({ getBalance: async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '88' }], bonusWallets: [] } }) }),
    })
    assert.equal(viaAccount.ok, true)
    assert.equal(viaAccount.total, 88)
    assert.equal(viaAccount.source, 'account', '桌面端走账号服务')
    assert.equal(fetchCount, 0, '账号服务成功时不该再打路由')

    // 路 1 不可用（web）-> 退回路由
    sandboxFetch = async () => ({ ok: true, json: async () => ({ ok: true, currency: 'CNY', total: 42 }) })
    const viaRoute = await internals.readBalance({ get: () => undefined })
    assert.equal(viaRoute.ok, true)
    assert.equal(viaRoute.total, 42, '没有账号服务时退回路由')
    assert.equal(viaRoute.source, 'route')

    // 路 1 未登录 + 路 2 也失败 -> 返回账号服务那边的原因（更有信息量）
    sandboxFetch = async () => ({ ok: true, json: async () => ({ ok: false, reason: 'no-credential' }) })
    const bothFail = await internals.readBalance({
      get: () => ({ getBalance: async () => ({ ok: true, value: null }) }),
    })
    assert.equal(bothFail.ok, false)
    assert.equal(bothFail.reason, 'account-signed-out', '两条都失败时给账号服务的原因')

    // 路 1 抛错 -> 安静退回路 2
    sandboxFetch = async () => ({ ok: true, json: async () => ({ ok: true, currency: 'CNY', total: 7 }) })
    const threw = await internals.readBalance({
      get: () => ({ getBalance: async () => { throw new Error('rpc down') } }),
    })
    assert.equal(threw.ok, true)
    assert.equal(threw.total, 7, '账号服务抛错要退回路由')

    // 路由 HTTP 非 2xx
    sandboxFetch = async () => ({ ok: false, status: 502 })
    assert.equal((await internals.readBalance({ get: () => undefined })).reason, 'route-http-502')
    // 网络异常
    sandboxFetch = async () => { throw new Error('offline') }
    assert.equal((await internals.readBalance({ get: () => undefined })).reason, 'route-error')
  } finally {
    sandboxFetch = savedFetch
  }
}

console.log('dsh-billing smoke: all checks passed')
