import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type MailAccount } from '../../api.ts'
import { bridge } from '../../bridge.ts'
import { ErrorState } from '../../shell/State.tsx'

/**
 * 邮箱。可以有好几个，学校的和私人的各算一个，各自一份进度。
 *
 * **授权码在离开这个组件之前就被系统钥匙串加密了。** 送出去的是密文（落库的那份）
 * 加明文（server 这一进程内存里用的那份）。同一条 localhost 请求里两样都有看着
 * 多余，其实不是：加密防的是盘上被读走，不是这一跳。
 *
 * 只读收件箱里未读、且比上次新的几封，**不替用户标已读**——标记已读是他自己的
 * 动作，替他标掉，他的收件箱就少了一条本来会看见的未读。
 */
export function MailGroup({ accounts }: { accounts: MailAccount[] }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <>
      <p className="settings-note">
        只读收件箱里还没处理过的几封，不会把邮件标成已读。
      </p>

      {accounts.length === 0 && !adding && (
        <p className="settings-status">还没有添加邮箱。</p>
      )}

      <ul className="settings-accounts">
        {accounts.map((account) => (
          <li key={account.id}>
            {editing === account.id
              ? <AccountForm account={account} onDone={() => setEditing(null)} />
              : <AccountRow account={account} onEdit={() => setEditing(account.id)} />}
          </li>
        ))}
      </ul>

      {adding
        ? <AccountForm account={null} onDone={() => setAdding(false)} />
        : (
          <div className="choices">
            <button className="choice" onClick={() => setAdding(true)}>添加邮箱</button>
          </div>
        )}
    </>
  )
}

function AccountRow({ account, onEdit }: { account: MailAccount; onEdit: () => void }) {
  const queryClient = useQueryClient()
  const [tested, setTested] = useState<string | null>(null)

  const test = useMutation({
    mutationFn: () => api.testMailAccount(account.id),
    onSuccess: (r) => setTested(r.ok ? `连上了，收件箱里 ${r.unseen} 封未读。` : r.message ?? '连不上。'),
  })

  const remove = useMutation({
    mutationFn: () => api.removeMailAccount(account.id),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const toggle = useMutation({
    mutationFn: () => api.patchMailAccount(account.id, { enabled: !account.enabled }),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const busy = test.isPending || remove.isPending || toggle.isPending

  return (
    <>
      <div className="settings-account">
        <span className="settings-account-who">{account.username}</span>
        <span className="settings-account-where">{account.host}:{account.port}</span>
      </div>

      {/*
        「未解锁」与「授权码不对」是两回事，说法必须分开：前者点一下重启应用就好，
        后者要去邮箱设置里重新生成一串。混成一句「不可用」，用户会去改对的那一半。
      */}
      <p className="settings-account-state">
        {!account.enabled ? '已停用'
          : !account.unlocked ? '需要在桌面应用里解锁'
            : `每轮至多读 ${account.perRun} 封`}
        {tested !== null && ` · ${tested}`}
      </p>

      <div className="choices">
        <button className="choice" disabled={busy} onClick={() => test.mutate()}>
          {test.isPending ? '正在连' : '测试连接'}
        </button>
        <button className="choice" disabled={busy} onClick={onEdit}>修改</button>
        <button className="choice" disabled={busy} onClick={() => toggle.mutate()}>
          {account.enabled ? '停用' : '启用'}
        </button>
        <button className="choice" disabled={busy} onClick={() => remove.mutate()}>删除</button>
      </div>

      {test.error && <ErrorState error={test.error} />}
      {remove.error && <ErrorState error={remove.error} />}
      {toggle.error && <ErrorState error={toggle.error} />}
    </>
  )
}

/** 新加的默认值指向人大邮箱——多数时候用户只要填用户名和授权码。 */
const BLANK = { host: 'imap.ruc.edu.cn', port: '993', username: '', perRun: '3' }

function AccountForm(
  { account, onDone }: { account: MailAccount | null; onDone: () => void },
) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(account === null ? BLANK : {
    host: account.host,
    port: String(account.port),
    username: account.username,
    perRun: String(account.perRun),
  })
  // 改一个已有账号时留空 = 不动授权码。新加时必填。
  const [password, setPassword] = useState('')

  const save = useMutation({
    mutationFn: async () => {
      const base = {
        host: form.host.trim(),
        port: Number(form.port),
        username: form.username.trim(),
        perRun: Number(form.perRun),
      }
      if (!Number.isInteger(base.port) || base.port <= 0) throw new Error('端口要是一个正整数。')
      if (!Number.isInteger(base.perRun) || base.perRun < 0) throw new Error('每轮封数要是一个非负整数。')

      // 授权码在离开界面之前先加密。拿不到钥匙串就明说，不退回明文——
      // 用户看见的「已加密」是我们说的，悄悄降级等于说了谎。
      let secret: { passwordCipher: string; password: string } | null = null
      if (password !== '') {
        const encrypted = await bridge.encryptSecret(password)
        if (!encrypted.ok) throw new Error(encrypted.message)
        secret = { passwordCipher: encrypted.cipher, password }
      }

      if (account === null) {
        if (secret === null) throw new Error('新加邮箱要填授权码。')
        return api.addMailAccount({ ...base, ...secret })
      }
      return api.patchMailAccount(account.id, { ...base, ...(secret ?? {}) })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries()
      onDone()
    },
  })

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: e.target.value }),
  })

  return (
    <div className="settings-form">
      <label className="settings-row">
        <span>邮箱地址</span>
        <input type="text" autoComplete="off" placeholder="2021xxxxxx@ruc.edu.cn" {...field('username')} />
      </label>
      <label className="settings-row">
        <span>授权码</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={account === null ? '' : '留空则不改'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="settings-row">
        <span>服务器</span>
        <input type="text" autoComplete="off" {...field('host')} />
      </label>
      <label className="settings-row">
        <span>端口</span>
        <input type="text" inputMode="numeric" autoComplete="off" {...field('port')} />
      </label>
      <label className="settings-row">
        <span>每轮至多读</span>
        <input type="text" inputMode="numeric" autoComplete="off" {...field('perRun')} />
      </label>

      {/*
        这两句是这张表单上最容易填错的地方，所以写在字段边上而不是帮助文档里：
        网易那套默认不许拿登录密码走 IMAP，填错了只回一句认证失败。
      */}
      <p className="settings-note">
        授权码在邮箱网页版的设置里生成，不是登录密码。它加密后存在这台机器上。
      </p>

      <div className="choices">
        <button className="choice" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '正在保存' : '保存'}
        </button>
        <button className="choice" disabled={save.isPending} onClick={onDone}>取消</button>
      </div>

      {save.error && <ErrorState error={save.error} />}
    </div>
  )
}
