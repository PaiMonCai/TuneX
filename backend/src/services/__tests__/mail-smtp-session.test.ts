/**
 * SMTP 会话的**真实**行为测试：起一个真 TCP 假服务器，跑真实 `SmtpClient`／`sendMail()`。
 *
 * ── 为什么以前没发现这个缺陷 ──
 * 仓里从来没有跑过真实的 SMTP 会话（既有测试都走 `setMailTransportForTest()` 注入替身），
 * 于是"客户端从不读服务器问候语"这件事一直没人踩到：**凡按 RFC 5321 发 `220` 问候语的
 * 服务器，第一次 `EHLO` 都会读到那条 220**，判定失败 ⇒ 任何配置了 `SMTP_*` 的部署
 * 邮件全发不出去（验证、重置、公告、通知 email 渠道）。
 *
 * 本文件因此钉住四件事：
 *  ① 有 `220` 问候语 ⇒ 投递成功，且命令顺序是 EHLO → AUTH → MAIL → RCPT → DATA → QUIT；
 *  ② 多行问候语（`220-…` / `220 …`）同样成功（真实服务器常这么发）；
 *  ③ 问候语不是 220（`554 go away`）⇒ 失败，**一条命令都不发**（fail-closed）；
 *  ④ 服务器完全不说话 ⇒ 读取超时 = 失败（用可注入的短超时验，不真等 15 秒）。
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
// `env.ts` 在 import 期快照 SMTP_* ⇒ 必须在 import `mail.ts` **之前**设好。
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = String(fake.port);
process.env.SMTP_USER = "sender@example.com";
process.env.SMTP_PASS = "s3cret";
process.env.SMTP_FROM = "sender@example.com";
process.env.SMTP_SECURE = "false";

const { sendMail, SmtpClient } = await import("../mail.ts");

const MESSAGE = { to: "ops@example.com", subject: "[TuneX] test", text: "line one\nline two" };

function resetRecordings(): void {
  fake.commands.length = 0;
  fake.messages.length = 0;
}

describe("SMTP 真实会话：问候语必须先被读掉", () => {
  test("有 220 问候语 ⇒ sendMail 成功，且命令顺序正确（修复前这里必然失败）", async () => {
    fake.setMode("greeting");
    resetRecordings();
    const result = await sendMail(MESSAGE);
    expect(result).toEqual({ sent: true });
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
    const result = await sendMail(MESSAGE);
    expect(result).toEqual({ sent: true });
    expect(fake.messages).toHaveLength(1);
    expect(fake.commands[0]).toBe("EHLO tunex.local");
  });

  test("问候语不是 220（554）⇒ 失败，且**一条命令都不发**（fail-closed）", async () => {
    fake.setMode("bad");
    resetRecordings();
    const result = await sendMail(MESSAGE);
    expect(result).toEqual({ sent: false, reason: "smtp_error" });
    expect(fake.commands).toEqual([]);
    expect(fake.messages).toEqual([]);
  });

  test("服务器完全不说话 ⇒ 读取超时 = 失败（不假装成功、也不发命令）", async () => {
    fake.setMode("silent");
    resetRecordings();
    const client = new SmtpClient("127.0.0.1", fake.port, { replyTimeoutMs: 150 });
    let message = "";
    try {
      await client.connect();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      client.close();
    }
    expect(message).toContain("SMTP 应答超时");
    expect(fake.commands).toEqual([]);
  });
});
