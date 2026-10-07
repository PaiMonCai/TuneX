/**
 * SMTP 会话的**真实**行为测试：起一个真 TCP 假服务器，跑真实 `SmtpClient`。
 *
 * ── 为什么这里**只**驱动 `SmtpClient`（不调 `sendMail()`、不设 `SMTP_*`）──
 * `mock.module()` 是**进程级**注册表（先加载者生效）：别的测试文件如果注册了一个不含 `mail`
 * 键的 `env.ts` 部分替身，任何"类内读 `env`"的代码在全量跑里就会炸，而单独跑却是绿的
 * （本仓已为这类"替身泄漏"付过学费）。所以：
 *   · 生产配置由 `sendMail()` 从 `env.mail` 取出后**作为构造入参**交给客户端；
 *   · 本文件只验"给一份配置就能跑完一次真实会话"，与 env 完全解耦；
 *   · `sendMail()` 这一层的真实证据由 task-14 的**真机 A/B 探针**给出
 *     （同一个会发问候语的假 SMTP：修复前 `smtp_error`，修复后 `sent:true`，正文到达）。
 *
 * ── 为什么以前没发现这个缺陷 ──
 * 仓里从来没有跑过真实的 SMTP 会话（既有测试都走 `setMailTransportForTest()` 注入替身），
 * 于是"客户端从不读服务器问候语"这件事一直没人踩到：**凡按 RFC 5321 发 `220` 问候语的
 * 服务器，第一次 `EHLO` 都会读到那条 220**，判定失败 ⇒ 任何配置了 `SMTP_*` 的部署
 * 邮件全发不出去（验证、重置、公告、通知 email 渠道）。
 *
 * 本文件因此钉住五件事：
 *  ① 有 `220` 问候语 ⇒ 投递成功，且命令顺序是 EHLO → AUTH → MAIL → RCPT → DATA → QUIT；
 *  ② EHLO 的真实多行应答（`250-…` / `250 …`）能完整消费，不会卡在 continuation；
 *  ③ 多行问候语（`220-…` / `220 …`）同样成功（真实服务器常这么发）；
 *  ④ 问候语不是 220（`554 go away`）⇒ 失败，**一条命令都不发**（fail-closed）；
 *  ⑤ 服务器完全不说话 ⇒ 读取超时 = 失败；未 connect 就 send 则立即 fail-fast。
 */
import { describe, expect, test } from "bun:test";

type Mode = "greeting" | "multiline" | "bad" | "silent";

interface FakeSmtp {
  readonly port: number;
  readonly commands: string[];
  readonly messages: string[];
  setMode(mode: Mode): void;
  stop(): void;
}

/**
 * 最小的假 SMTP 服务器（只够跑完一次事务）。模式可**按连接**切换：
 * 这样同一个端口可以先后验证"有问候语"和"问候语异常"两条路径，而 `env.mail.port`
 * 只需在 import `mail.ts` 之前设一次（`env` 是 import 期快照）。
 */
function startFakeSmtp(initial: Mode): FakeSmtp {
  const commands: string[] = [];
  const messages: string[] = [];
  let mode: Mode = initial;
  let buffer = "";
  let inData = false;
  let authStep = 0;
  let body: string[] = [];

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        // 每条连接的状态各自归零（重试会开新连接）。
        buffer = "";
        inData = false;
        authStep = 0;
        body = [];
        if (mode === "greeting") socket.write("220 fake-smtp ready\r\n");
        if (mode === "multiline") socket.write("220-fake-smtp ready\r\n220 and welcome\r\n");
        if (mode === "bad") socket.write("554 go away\r\n");
        // mode === "silent"：什么都不发。
      },
      data(socket, chunk) {
        buffer += chunk.toString();
        for (;;) {
          const idx = buffer.indexOf("\r\n");
          if (idx < 0) return;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              messages.push(body.join("\n"));
              inData = false;
              socket.write("250 OK queued\r\n");
            } else {
              body.push(line);
            }
            continue;
          }
          if (authStep === 1) {
            authStep = 2;
            socket.write("334 UGFzc3dvcmQ6\r\n");
            continue;
          }
          if (authStep === 2) {
            authStep = 0;
            socket.write("235 Authentication successful\r\n");
            continue;
          }
          commands.push(line);
          const verb = line.split(" ")[0]!.toUpperCase();
          switch (verb) {
            case "EHLO":
            case "HELO":
              // 刻意返回真实 MTA 常见的 continuation 形态，防止回归成“只支持单行 250”。
              socket.write("250-fake-smtp\r\n250 AUTH LOGIN\r\n");
              break;
            case "AUTH":
              authStep = 1;
              socket.write("334 VXNlcm5hbWU6\r\n");
              break;
            case "MAIL":
            case "RCPT":
              socket.write("250 OK\r\n");
              break;
            case "DATA":
              inData = true;
              body = [];
              socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
              break;
            case "QUIT":
              socket.write("221 Bye\r\n");
              break;
            default:
              socket.write("250 OK\r\n");
          }
        }
      },
      close() {},
      error() {},
    },
  });

  return {
    get port() {
      return server.port;
    },
    commands,
    messages,
    setMode(next: Mode) {
      mode = next;
    },
    stop() {
      server.stop(true);
    },
  };
}

const fake = startFakeSmtp("greeting");

const { SmtpClient } = await import("../mail.ts");

const MESSAGE = { to: "ops@example.com", subject: "[TuneX] test", text: "line one\nline two" };
const CONFIG = { user: "sender@example.com", pass: "s3cret", from: "sender@example.com", secure: false };

/** 用**显式配置**跑一次真实会话（零 env 依赖）。 */
async function sendOnce(options: { replyTimeoutMs?: number } = {}): Promise<void> {
  const client = new SmtpClient("127.0.0.1", fake.port, { ...CONFIG, ...options });
  try {
    await client.connect();
    await client.send(MESSAGE);
  } finally {
    client.close();
  }
}

function resetRecordings(): void {
  fake.commands.length = 0;
  fake.messages.length = 0;
}

describe("SMTP 客户端连接状态", () => {
  test("未 connect 就 send ⇒ 立即失败，不伪装成 15 秒应答超时", async () => {
    const client = new SmtpClient("127.0.0.1", fake.port, CONFIG);
    const started = Date.now();
    let message = "";
    try {
      await client.send(MESSAGE);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      client.close();
    }
    expect(message).toContain("尚未连接");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("SMTP 真实会话：问候语必须先被读掉", () => {
  test("有 220 问候语 + 多行 EHLO ⇒ 会话走完，且命令顺序正确", async () => {
    fake.setMode("greeting");
    resetRecordings();
    await sendOnce();
    // AUTH 之后的两行（base64 用户名/口令）由状态机消费，不作为命令记录 ——
    // 它们出现过与否由"这一封真的发出去了"证明。
    expect(fake.commands.map((line) => line.split(" ")[0])).toEqual([
      "EHLO",
      "AUTH",
      "MAIL",
      "RCPT",
      "DATA",
      "QUIT",
    ]);
    expect(fake.commands[0]).toBe("EHLO tunex.local");
    expect(fake.commands[2]).toBe("MAIL FROM:<sender@example.com>");
    expect(fake.commands[3]).toBe("RCPT TO:<ops@example.com>");
    // 正文里要有主题与内容（证明这一封真的发出去了，而不是"连上了"）
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]).toContain("Subject: [TuneX] test");
    expect(fake.messages[0]).toContain("line one");
    expect(fake.messages[0]).toContain("line two");
  });

  test("多行问候语（220-… 后接 220 …）同样被正确读掉", async () => {
    fake.setMode("multiline");
    resetRecordings();
    await sendOnce();
    expect(fake.messages).toHaveLength(1);
    expect(fake.commands[0]).toBe("EHLO tunex.local");
  });

  test("问候语不是 220（554）⇒ 抛错，且**一条命令都不发**（fail-closed）", async () => {
    fake.setMode("bad");
    resetRecordings();
    let message = "";
    try {
      await sendOnce();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("SMTP 问候语异常");
    expect(message).toContain("554");
    expect(fake.commands).toEqual([]);
    expect(fake.messages).toEqual([]);
  });

  test("服务器完全不说话 ⇒ 读取超时 = 失败（不假装成功、也不发命令）", async () => {
    fake.setMode("silent");
    resetRecordings();
    let message = "";
    try {
      await sendOnce({ replyTimeoutMs: 150 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("SMTP 应答超时");
    expect(fake.commands).toEqual([]);
  });
});
