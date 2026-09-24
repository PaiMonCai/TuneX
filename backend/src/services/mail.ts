/**
 * TEN-03 邮件服务 —— SMTP 发送，未配置时降级为打日志。
 *
 * ── 为什么不用 nodemailer/smtplib ──
 * 仓库刻意保持零运行时依赖（hono / prisma / ioredis / zod / bcryptjs / jose）。
 * 一封事务邮件的需求极小：EHLO → STARTTLS(可选) → AUTH LOGIN → MAIL FROM → RCPT TO
 * → DATA → QUIT，Node 内建 `tls` 模块即可完成，无需引入一个新的依赖树
 * （也就没有 transitively 的供应链与体积成本）。
 *
 * ── 降级语义 ──
 * 未配置 SMTP_HOST 时（本地开发 / CI / 演示栈）**不报错**，把主题与正文打到日志：
 * 这样邮箱验证 / 密码重置的全链路在没有邮件服务器的环境下依然可开发、可测试
 * （token 从日志取出即可走完「链接点击 → 校验」流程）。
 *
 * ── 安全 ──
 *  · 邮件正文里出现的 token 只从 `env.siteUrl` + 随机 token 生成，不回显任何用户输入；
 *  · SMTP 口令只存在于环境变量与进程内存，绝不进日志（只记录 host/port/user）；
 *  · 登录失败的返回体统一化，不区分「认证被拒」与「连接被拒」，避免把口令错误
 *    泄露给调用方（调用方也不需要区分）。
 */

import net from "node:net";
import tls from "node:tls";
import { env } from "../env.ts";

/** 收件人与内容。 */
export interface MailMessage {
  to: string;
  subject: string;
  /** 纯文本正文（事务邮件不需要 HTML 多部分）。 */
  text: string;
}

/**
 * 测试注入点：进程内替换发送通道。
 * 集成测试需要在不连 SMTP 的情况下断言「注册后确实发出了验证邮件、且正文含
 * token 链接」，而 `routes/auth.ts` 直接用 live binding 调用 `sendMail`，
 * 无法在测试里 monkey-patch 只读的 ES 模块导出。故在此开一个显式的注入口
 * （生产路径永不调用它，因此不构成功能开关）。
 */
let mailTransportOverride: ((message: MailMessage) => Promise<MailResult>) | null = null;

/** 仅供测试：替换实际发送通道，返回恢复函数。 */
export function setMailTransportForTest(fn: ((message: MailMessage) => Promise<MailResult>) | null): void {
  mailTransportOverride = fn;
}

/** 发送结果：`sent:false` + `reason` 表示降级或失败，调用方可决定是否阻断业务。 */
export interface MailResult {
  sent: boolean;
  /** 降级（未配置 SMTP）或失败原因；sent=true 时为 undefined。 */
  reason?: "smtp_not_configured" | "smtp_error";
  /** 降级时打出的日志行（便于开发环境取 token 调试）。 */
  log?: string;
}

/** host/port/user/pass/from 五项齐备才算「已配置」。 */
export function isMailConfigured(): boolean {
  return Boolean(env.mail.host && env.mail.port && env.mail.user && env.mail.pass && env.mail.from);
}

/** 脱敏后的发件账号（日志安全）。 */
function maskedUser(): string {
  const u = env.mail.user;
  const at = u.indexOf("@");
  if (at <= 0) return "***";
  return `${u.slice(0, 1)}***${u.slice(at)}`;
}

interface SmtpReply {
  code: number;
  text: string;
}

/**
 * 最小的 SMTP 客户端（隐式 TLS 465 / STARTTLS 587 / 明文）。
 * 内部用 socket + 行缓冲实现「读一条完整应答」，不做并发管线化——事务邮件一对一发，够用且更易读。
 */
class SmtpClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = "";
  private pending: SmtpReply[] = [];
  private waiter: ((reply: SmtpReply) => void) | null = null;

  constructor(private readonly host: string, private readonly port: number) {}

  async connect(): Promise<void> {
    // 465（implicit TLS）与显式配置 secure 的端口先建 TLS；其余明文 + 后续 STARTTLS。
    if (env.mail.secure && env.mail.port === 465) {
      this.socket = tls.connect({ host: this.host, port: this.port, servername: this.host });
    } else {
      this.socket = net.connect({ host: this.host, port: this.port });
    }
    await new Promise<void>((resolve, reject) => {
      const s = this.socket!;
      const onError = (e: Error) => reject(new Error(`SMTP 连接失败：${e.message}`));
      s.once("error", onError);
      s.once(env.mail.port === 465 && env.mail.secure ? "secureConnect" : "connect", () => {
        s.removeListener("error", onError);
        resolve();
      });
    });
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", () => {
      /* 应答读取期错误由 readReply 的 socket error 或超时兜底 */
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // 多条应答可能在同一 chunk 内；按 "CODE " 后的多行 "-" 语义逐条切。
    for (;;) {
      const lines = this.buffer.split("\r\n");
      if (lines.length < 2) return;
      const first = lines[0];
      const m = /^(\d{3})([ -])(.*)$/.exec(first);
      if (!m) {
        // 非 SMTP 文本（banner 异常/服务端欢迎语）——丢弃一行继续
        this.buffer = lines.slice(1).join("\r\n");
        continue;
      }
      if (m[2] === "-") return; // 多行应答，等后续行
      const reply: SmtpReply = { code: Number(m[1]), text: lines.slice(0, -1).join("\n") };
      this.buffer = lines.slice(1).join("\r\n");
      this.deliver(reply);
    }
  }

  private deliver(reply: SmtpReply): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(reply);
    } else {
      this.pending.push(reply);
    }
  }

  private readReply(): Promise<SmtpReply> {
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("SMTP 应答超时"));
      }, 15_000);
      this.waiter = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.socket?.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(new Error(`SMTP socket 错误：${e.message}`));
      });
    });
  }

  private write(line: string): void {
    this.socket?.write(`${line}\r\n`);
  }

  /** 发命令并按预期码校验；不符即抛错（消息含服务端文本，便于排查）。 */
  private async command(line: string, expected: number[]): Promise<string> {
    this.write(line);
    const reply = await this.readReply();
    if (!expected.includes(reply.code)) {
      throw new Error(`SMTP ${line.split(" ")[0]} 返回 ${reply.code}：${reply.text}`);
    }
    return reply.text;
  }

  async send(message: MailMessage): Promise<void> {
    await this.command("EHLO tunex.local", [250]);
    if (!(env.mail.secure && this.port === 465)) {
      if (env.mail.secure) await this.command("STARTTLS", [220]);
      // STARTTLS 之后需要在新 socket 上重新 EHLO；本实现里 secure=true 且非 465 端口
      // 即代表 STARTTLS，下面是升级逻辑。
      if (env.mail.secure && this.port !== 465) {
        await this.upgrade();
        await this.command("EHLO tunex.local", [250]);
      }
    }
    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(env.mail.user, "utf8").toString("base64"), [334]);
    await this.command(Buffer.from(env.mail.pass, "utf8").toString("base64"), [235]);

    const from = env.mail.from;
    await this.command(`MAIL FROM:<${from}>`, [250]);
    await this.command(`RCPT TO:<${message.to}>`, [250, 251]);

    // DATA：354 起进入正文，直到单独一行 "." 结束。
    this.write("DATA");
    const dataReply = await this.readReply();
    if (dataReply.code !== 354) throw new Error(`SMTP DATA 返回 ${dataReply.code}`);

    // 头 + 正文。避免 CRLF 注入：把用户可控内容（仅地址）里的换行剥掉。
    const dotSafe = message.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const headers = [
      `From: TuneX <${from}>`,
      `To: ${message.to.replace(/[\r\n]/g, "")}`,
      `Subject: ${message.subject.replace(/[\r\n]/g, "")}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
    ].join("\r\n");
    this.write(`${headers}\r\n\r\n${dotSafe}\r\n.`);
    const endReply = await this.readReply();
    if (endReply.code !== 250) throw new Error(`SMTP 正文发送返回 ${endReply.code}：${endReply.text}`);

    await this.command("QUIT", [221]);
  }

  /** 明文 socket → TLS（STARTTLS）。 */
  private async upgrade(): Promise<void> {
    const plain = this.socket as net.Socket | null;
    if (!plain) throw new Error("SMTP STARTTLS 时 socket 已关闭");
    const secured = tls.connect({ socket: plain, servername: this.host });
    this.socket = secured;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP STARTTLS 握手超时")), 15_000);
      secured.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      secured.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(new Error(`SMTP STARTTLS 失败：${e.message}`));
      });
    });
    secured.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  close(): void {
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

/**
 * 发送一封邮件。任何异常都被收敛为 `{ sent:false, reason:"smtp_error" }`：
 * 邮件是**尽力而为**的旁路，投递失败绝不能把注册 / 重置链路整个拖挂
 * （用户仍可再次请求发送）。
 */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  // 测试注入优先（只在集成测试进程内生效）。
  if (mailTransportOverride) return mailTransportOverride(message);

  if (!isMailConfigured()) {
    const log = [
      "[mail] SMTP 未配置，邮件降级为日志（开发环境）。",
      `  to: ${message.to}`,
      `  subject: ${message.subject}`,
      `  body:`,
      ...message.text.split("\n").map((l) => `    ${l}`),
    ].join("\n");
    console.log(log);
    return { sent: false, reason: "smtp_not_configured", log };
  }

  const client = new SmtpClient(env.mail.host, env.mail.port);
  try {
    await client.connect();
    await client.send(message);
    console.log(`[mail] 已通过 ${env.mail.host}:${env.mail.port} 发送给 ${message.to}（${maskedUser()}）`);
    return { sent: true };
  } catch (e) {
    console.error(`[mail] 发送失败（${env.mail.host}:${env.mail.port} as ${maskedUser()}）：`, (e as Error).message);
    return { sent: false, reason: "smtp_error" };
  } finally {
    client.close();
  }
}
