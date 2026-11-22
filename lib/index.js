/**
 * dsh-keep-top — host 半区
 *
 * 全部行为都在浏览器侧（lib/client.js）：只接管滚动落点，不改官方展示档。
 * host 侧只需要条目存在于 roster 里，客户端模块系统按 `dsh.client` 声明
 * 把 lib/client.js 交给浏览器。
 */
export const name = 'dsh-keep-top'
export const inject = []

export function apply() {}
