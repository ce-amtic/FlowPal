import './orbs.css'

/**
 * 等待态的那颗球。
 *
 * 三点绕一圈慢慢挪，各自错开呼吸。转圈是在催，这个不是——这里本来就报不出进度，
 * 它只需要说明「还在做」。
 *
 * 不带文字：它总是站在一句话前面，说了什么由那句话负责，读屏读一遍就够了。
 * 单独放在 shell 里是因为桌宠等同一件事时用的也是它。
 */
export function Orbs() {
  return (
    <span className="orbs" aria-hidden>
      <span className="orbs-arm" />
      <span className="orbs-arm" />
      <span className="orbs-arm" />
    </span>
  )
}
