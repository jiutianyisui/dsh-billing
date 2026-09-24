/**
 * dsh-billing 宿主半（Node）的离线测试：不联网、不启动 DSH。
 *
 * 用假 ctx 驱动 lib/index.js：
 *   · 断言它挂在 webServer 上的路由（exact / 路径）
 *   · 断言上游查询的用法（Bearer key、超时、币种挑选）
 *   · 断言**响应体永不含 API key**
 *   · 断言错误分支（没凭据 / 上游 4xx / 响应缺字段 / 超时）都变成 { ok: false, reason }
 *   · 断言进程内缓存与 ?fresh=1
 *
 * 运行：  node tests\host.mjs
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

assert.equal(plugin.name, 'billing', '登录名（Cordis 插件名）')
assert.equal(plugin.ROUTE, '/dsh-billing/balance', '路由路径')
assert.equal(typeof plugin.apply, 'function', 'Node 半要导出 apply')

// ---- 假 ctx：记录注入的依赖、注册的路由 --------------------------------------
const seen = { deps: null, route: null, ref: null, disposer: null }
let resolveImpl = async () => ({ value: 'sk-test-key', source: 'file' })

function fakeApply() {
  seen.route = null
  const scope = {
    webServer: {
      register: (route) => {
        seen.route = route
        return () => { seen.route = null }
      },
    },
    credentials: {
      resolve: (ref) => {
        seen.ref = ref
        return resolveImpl()
      },
    },
    effect: (fn) => {
      seen.disposer = fn()
      return seen.disposer
    },
  }
  plugin.apply({
    inject: (deps, callback) => {
      seen.deps = deps
      callback(scope)
    },
  })
}

fakeApply()
assert.equal(seen.deps.join(','), 'webServer,credentials', '两个服务齐了才挂路由')
assert.equal(seen.route.kind, 'exact')
assert.equal(seen.route.path, plugin.ROUTE)

// ---- 假的 fetch + 假 req/res -------------------------------------------------
let fetchCalls = []
function stubFetch(impl) {
  fetchCalls = []
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options })
    return impl(url, options)
  }
}

/** 驱动一次路由处理，取回状态码 / 响应头 / JSON。 */
async function call(query = '') {
  let status
  let headers
  let text
  const res = {
    writeHead: (code, hdrs) => { status = code; headers = hdrs },
    end: (body) => { text = body },
  }
  await seen.route.handler({ url: plugin.ROUTE + query }, res)
  return { status, headers, text, json: JSON.parse(text) }
}

function okPayload() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      is_available: true,
      balance_infos: [
        { currency: 'USD', total_balance: '15.00', granted_balance: '0.00', topped_up_balance: '15.00' },
        { currency: 'CNY', total_balance: '110.00', granted_balance: '2.50', topped_up_balance: '107.50' },
      ],
    }),
  }
}

// ---- 成功：挑 CNY 那一行、带上 Bearer key、响应体里不能有 key -------------------
stubFetch(async () => okPayload())
const success = await call('?fresh=1')
assert.equal(success.status, 200)
assert.equal(success.headers['content-type'], 'application/json; charset=utf-8')
assert.equal(success.headers['cache-control'], 'no-store')
assert.deepEqual(success.json, {
  ok: true,
  available: true,
  currency: 'CNY',
  total: 110,
  granted: 2.5,
  toppedUp: 107.5,
})
assert.equal(fetchCalls[0].url, 'https://api.deepseek.com/user/balance')
assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer sk-test-key', 'key 用在宿主侧')
assert.equal(seen.ref, 'DEEPSEEK_API_KEY', '凭据引用名要和 provider 的 apiKeyEnv 一致')
assert.ok(!success.text.includes('sk-test-key'), '响应体绝不能带出 API key')

// ---- 缓存：紧接着再问一次，不再打上游 -----------------------------------------
const cached = await call()
assert.equal(cached.json.total, 110)
assert.equal(fetchCalls.length, 1, '第二个请求应命中进程内缓存')

// ?fresh=1 跳过缓存
await call('?fresh=1')
assert.equal(fetchCalls.length, 2, '?fresh=1 必须重新查')

// ---- 没凭据 ------------------------------------------------------------------
resolveImpl = async () => undefined
stubFetch(async () => okPayload())
assert.deepEqual(await call('?fresh=1').then((r) => r.json), { ok: false, reason: 'no-credential' })
assert.equal(fetchCalls.length, 0, '没 key 就不该打上游')

// ---- 上游 4xx（key 无效 / 余额接口不存在）-------------------------------------
resolveImpl = async () => ({ value: 'sk-bad', source: 'file' })
stubFetch(async () => ({ ok: false, status: 402, json: async () => ({}) }))
assert.deepEqual(await call('?fresh=1').then((r) => r.json), { ok: false, reason: 'http-402' })

// ---- 响应缺字段 --------------------------------------------------------------
stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ is_available: true }) }))
assert.deepEqual(await call('?fresh=1').then((r) => r.json), { ok: false, reason: 'no-balance-field' })

// ---- 超时 / 中断：AbortError 归成 timeout（这里直接抛，不等真的 8 秒）---------
stubFetch(async () => {
  const error = new Error('aborted')
  error.name = 'AbortError'
  throw error
})
assert.deepEqual(await call('?fresh=1').then((r) => r.json), { ok: false, reason: 'timeout' })

// ---- 凭据服务自己抛错也不炸 ---------------------------------------------------
resolveImpl = async () => { throw new Error('keyring locked') }
assert.deepEqual(
  await call('?fresh=1').then((r) => r.json),
  { ok: false, reason: 'credential-error: keyring locked' },
)

// ---- 卸载：effect 的 disposer 要把路由摘掉 ------------------------------------
fakeApply()
assert.notEqual(seen.route, null, '重新挂载后路由应在')
seen.disposer()
assert.equal(seen.route, null, 'disposer 要把路由摘掉')
console.log('dsh-billing host: all checks passed')
