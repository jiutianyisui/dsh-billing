// ---------------------------------------------------------------------------
// dsh-billing —— Node 半（宿主侧）
//
// 只干一件事：把「DeepSeek 账户真实余额」查出来，交给浏览器半。
// 浏览器半拿不到（也不该拿）API key，所以由这一半用 credentials 服务解析
// $DEEPSEEK_API_KEY，去问官方余额接口，再挂一个**只返回数字**的只读路由：
//
//   GET /dsh-billing/balance          复用进程内 10 秒缓存（多个页面共享一次查询）
//   GET /dsh-billing/balance?fresh=1  强制重新查一次
//
// 返回（**永不包含 key 本身**）：
//   { ok: true,  available, currency, total, granted, toppedUp }
//   { ok: false, reason }        // no-credential / http-402 / timeout / …
//
// 前端拿不到余额时就只显示会话花费（不显示余额那一格）。
// ---------------------------------------------------------------------------

/** 官方余额接口（provider 用默认 base URL 就是它）。换自建/代理端点改这里。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 解析 API key 的凭据引用名（= provider 的 apiKeyEnv，默认就是它）。 */
const API_KEY_REF = 'DEEPSEEK_API_KEY'

/** 路由路径；页面用相对路径 fetch，走同源、带 cookie。 */
export const ROUTE = '/dsh-billing/balance'

/** 上游查询超时，别把页面请求吊死。 */
const TIMEOUT_MS = 8_000

/** 进程内缓存时长：20 秒轮询的多个页面都打不到上游。 */
const CACHE_MS = 10_000

export const name = 'billing'

/** 最近一次查询结果（进程内共享）。 */
let cache = { at: 0, body: { ok: false, reason: 'cold' } }

/**
 * 查一次余额。
 * @param ctx - 插件上下文（要 credentials 服务）。
 * @returns 上述返回体之一，绝不抛。
 */
async function queryBalance(ctx) {
  let key
  try {
    const credential = await ctx.credentials.resolve(API_KEY_REF)
    key = credential === undefined || credential === null ? undefined : credential.value
  }
  catch (error) {
    return { ok: false, reason: 'credential-error: ' + messageOf(error) }
  }
  if (typeof key !== 'string' || key === '') return { ok: false, reason: 'no-credential' }

  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, TIMEOUT_MS)
  try {
    const response = await fetch(BALANCE_URL, {
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      signal: abort.signal,
    })
    if (!response.ok) return { ok: false, reason: 'http-' + String(response.status) }
    const payload = await response.json()
    const infos = Array.isArray(payload === null || payload === undefined ? undefined : payload.balance_infos)
      ? payload.balance_infos
      : []
    const info = infos.find((row) => row !== null && row !== undefined && row.currency === 'CNY')
      ?? infos[0]
    const total = Number(info === null || info === undefined ? Number.NaN : info.total_balance)
    if (!Number.isFinite(total)) return { ok: false, reason: 'no-balance-field' }
    return {
      ok: true,
      available: payload.is_available === true,
      currency: typeof info.currency === 'string' && info.currency !== '' ? info.currency : 'CNY',
      total,
      granted: numeric(info.granted_balance),
      toppedUp: numeric(info.topped_up_balance),
    }
  }
  catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === 'AbortError'
      ? 'timeout'
      : messageOf(error) }
  }
  finally {
    clearTimeout(timer)
  }
}

/** 可选的数字字段：拿不到就省略。 */
function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 稳定的错误文案（不带上游响应体，避免把 key 或内部信息带出去）。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 取余额（带缓存）。
 * @param ctx - 插件上下文。
 * @param force - true 跳过缓存。
 * @returns 返回体。
 */
async function readBalance(ctx, force) {
  const now = Date.now()
  if (!force && cache.at !== 0 && now - cache.at < CACHE_MS) return cache.body
  const body = await queryBalance(ctx)
  cache = { at: Date.now(), body }
  return body
}

/**
 * 插件体：挂上余额路由（两个服务齐了才挂）。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'credentials'], (scope) => {
    const route = {
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const fresh = (req.url ?? '').includes('fresh=1')
        const body = await readBalance(scope, fresh)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(body))
      },
    }
    scope.effect(() => scope.webServer.register(route), 'dsh-billing: /balance route')
  })
}
