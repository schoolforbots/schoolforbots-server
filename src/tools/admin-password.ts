import { randomBytes } from 'node:crypto'
import { base32Encode, hashPassword } from '../admin/auth.js'
import { isEntryPoint } from './entry-point.js'

const ISSUER = '机器人网校'

/** The lines to put into `.env`, and the link an authenticator app takes. The path of the admin pages is not part of it. */
export function adminCredentials(password: string): { hash: string; secret: string; uri: string } {
  const secret = base32Encode(randomBytes(20))
  const label = encodeURIComponent(`${ISSUER}:后台`)
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`
  return { hash: hashPassword(password), secret, uri }
}

/** Reads a line from the terminal without showing it. */
function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process
  return new Promise((resolve, reject) => {
    let text = ''
    stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish()
          resolve(text)
          return
        }
        if (ch === '\u0003') {
          finish()
          reject(new Error('已取消'))
          return
        }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1)
        else text += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('请在终端里直接运行，密码要在终端里输入（不会显示出来）')
  }
  const password = await readHidden('后台密码：')
  if (password.length < 12) throw new Error('密码至少 12 个字符')
  if ((await readHidden('再输一遍：')) !== password) throw new Error('两次输入不一样')
  const { hash, secret, uri } = adminCredentials(password)
  console.log('\n把下面两行填进 .env（ADMIN_PATH 自己另外定）：\n')
  // Single quotes: the hash holds `$`, which docker compose would otherwise read as a variable.
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`)
  console.log(`ADMIN_TOTP_SECRET=${secret}`)
  console.log('\n用验证器 App 添加下面的链接（或把密钥手动输进去）：\n')
  console.log(uri)
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
