import { Component, type ReactNode } from 'react'

/**
 * 正文区的错误边界。全 App 只有这一处捕获渲染异常。
 *
 * 它包住路由而不是整个壳，所以出错时标题栏还在，用户能换一页走掉；否则一处
 * 越界就是整窗白屏，连导航都点不到。
 *
 * 这里不吞错：屏幕上写清是哪一页出的错，控制台留完整堆栈。改路由时重置状态，
 * 让离开这一页就能恢复——不是重试，是换了一页。
 */
export class PageBoundary extends Component<
  { pathname: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { pathname: string }) {
    if (prev.pathname !== this.props.pathname && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error) {
    console.error('页面渲染失败', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="state-error">
          <div>这一页显示不出来。</div>
          <pre>{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}
