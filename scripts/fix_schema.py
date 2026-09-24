#!/usr/bin/env python3
"""修正 schema.prisma：
1. 移除之前追加的 UserCredential 块（无 back-relation，Prisma 校验会失败）
2. 在 User 模型加虚关系字段（不新增任何 DB 列）
3. 追加带正确 relation 的 UserCredential 模型
"""
import re
import sys

P = "/opt/TuneX/backend/prisma/schema.prisma"
s = open(P).read()

# 1. 砍掉之前追加的块
marker = "\n/// 密码凭证表。"
if marker in s:
    s = s[: s.index(marker)].rstrip() + "\n"
    print("[1] removed previously appended block")

# 2. User 模型加虚关系字段（无列，仅 Prisma 关系声明）
anchor = "  admin_roles              AdminRole[]\n"
assert anchor in s, "User.admin_roles anchor not found"
s = s.replace(
    anchor,
    anchor + "  credential               UserCredential?\n",
    1,
)
print("[2] added User.credential virtual relation")

# 3. 追加 UserCredential
s += '''
/// 密码凭证表。
/// 原版 `user` 表无密码列（Stack Auth 托管），本实现自签本地 JWT 需本地凭证，
/// 故拆表存放，`user` 表列结构保持与原版 100% 一致（零列改动）。
model UserCredential {
  id         Int      @id @default(autoincrement())
  user_id    Int      @unique
  user       User     @relation(fields: [user_id], references: [id], onDelete: Cascade)
  password   String   @db.VarChar(255)
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt

  @@map("user_credential")
}
'''
open(P, "w").write(s)
print("[3] appended UserCredential model")
print("models:", len(re.findall(r"^model ", s, re.M)), "enums:", len(re.findall(r"^enum ", s, re.M)))
